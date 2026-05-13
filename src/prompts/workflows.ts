/**
 * MCP prompts — Phase 18 #86.
 *
 * Workflow-bundle prompts surfaced via the MCP `prompts/list` and `prompts/get`
 * API alongside `tools`. The MCP host (e.g. Claude Desktop) surfaces each
 * registered prompt as a "/" slash-command in the chat input — the user
 * picks one, fills in the optional arguments, and the resulting message set
 * seeds the conversation. The agent then drives the workflow by calling the
 * `qb_*` tools the prompt lays out.
 *
 * Design choices:
 *   - **One user-role message per prompt.** Multi-message prompts (user +
 *     assistant pre-fill) are technically supported by GetPromptResult but
 *     would tie us to a specific assistant style; a single user-role
 *     "instructions" message keeps the prompt portable across host LLMs.
 *   - **Args are all optional.** A bare "/month_end_close" should still produce
 *     a useful message (defaults to the prior-month window). Required args
 *     would create dead-ends when the operator forgets one.
 *   - **Prompts reference qb_* tools by exact name** so the agent's tool-use
 *     loop maps the instructions to actual calls without resolution gymnastics.
 *   - **Prompt bodies stay in this file.** Externalizing to .md templates
 *     would add a build step (markdown → embedded string) without buying us
 *     anything — the operator owns the codebase and edits TS happily.
 *
 * Bridges to the operator's existing skill workflows:
 *   - credit_card_qb_batch  ← `credit-card-qb-batch` skill (bulk CC entry)
 *   - trial_balance_workup  ← `trial-balance-workup` skill (TB pull + cross-checks)
 *   - cc_statement_validator← `cc-statement-validator` skill (CC reconciliation)
 *
 * Plus two new workflow bundles that compose against the post-Phase-11/12 tool
 * surface:
 *   - month_end_close       — full month-end-close checklist (bank rec, P&L
 *     review, AR/AP aging, discrepancy scan)
 *   - w2_prep               — January W-2 prep that pivots qb_w2_summary +
 *     qb_employee_list into a per-employee filing checklist
 */

import { z } from "zod";
import type {
  McpServer,
  PromptCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";

// -----------------------------------------------------------------------
// Date helpers — keep prompt bodies dynamic so "/month_end_close" with no
// args defaults to the prior calendar month, not a hardcoded value that
// drifts.
// -----------------------------------------------------------------------

/** Today's date in ISO YYYY-MM-DD form (UTC). Stub-overridable for testing. */
export function todayISO(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Return the year of the most recently completed calendar year as a string. */
export function lastCompletedYear(now: Date = new Date()): string {
  return String(now.getUTCFullYear() - 1);
}

/**
 * Return [firstDay, lastDay] in ISO YYYY-MM-DD for the calendar month
 * preceding `now`. Default month for the month-end-close prompt: if it's
 * 2026-05-12, the prior month is 2026-04-01 → 2026-04-30.
 */
export function priorCalendarMonth(now: Date = new Date()): { fromDate: string; toDate: string } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed; March = 2
  // Prior month — JS handles January (month=0) by rolling back to December
  // of the previous year via Date(year, -1, 1) === year-1-Dec-1.
  const priorStart = new Date(Date.UTC(year, month - 1, 1));
  const priorEnd = new Date(Date.UTC(year, month, 0)); // day 0 = last day of priorStart's month
  return {
    fromDate: priorStart.toISOString().slice(0, 10),
    toDate: priorEnd.toISOString().slice(0, 10),
  };
}

// -----------------------------------------------------------------------
// Single-message helper — every prompt emits exactly one user-role text
// message. Centralizing the shape lets us update transport details in one
// place if the MCP message format evolves.
// -----------------------------------------------------------------------

function userTextResult(description: string, text: string): GetPromptResult {
  return {
    description,
    messages: [
      {
        role: "user",
        content: { type: "text", text },
      },
    ],
  };
}

// -----------------------------------------------------------------------
// Prompt: month_end_close
// -----------------------------------------------------------------------

const monthEndCloseArgs = {
  fromDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Start of the month being closed in ISO YYYY-MM-DD. Default: first day of the prior calendar month."),
  toDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("End of the month being closed in ISO YYYY-MM-DD. Default: last day of the prior calendar month."),
  bankAccountName: z
    .string()
    .optional()
    .describe("Operating bank account FullName to reconcile (e.g. 'Operating Account', 'Chase Checking'). When unset, the prompt lists candidates and the agent picks. Used to scope qb_uncleared_transactions + qb_reconciliation_discrepancy."),
};

export const monthEndClosePrompt: PromptCallback<typeof monthEndCloseArgs> = (args) => {
  const def = priorCalendarMonth();
  const fromDate = args.fromDate ?? def.fromDate;
  const toDate = args.toDate ?? def.toDate;
  const bankClause = args.bankAccountName
    ? `for the bank account "${args.bankAccountName}"`
    : "for the operating bank account (pick from qb_account_list filtered by accountType='Bank')";
  const text = [
    `# Month-End Close Workflow — ${fromDate} through ${toDate}`,
    "",
    "Drive this close-out end-to-end against the QuickBooks Desktop MCP.",
    "Each step calls one or more `qb_*` tools; surface findings to the operator",
    "before moving to the next step.",
    "",
    "## 1. Confirm period and edition",
    "- `qb_company_info` — confirm the company file path and that you're in writable mode.",
    "- `qb_host_query` — note the QB edition (Enterprise / Premier / Pro).",
    "- `qb_closing_date_get` — confirm prior closing date hasn't been moved.",
    "",
    `## 2. Bank reconciliation ${bankClause}`,
    `- \`qb_uncleared_transactions({ accountName, asOfDate: "${toDate}" })\` — full uncleared list (NotCleared + Pending).`,
    `- \`qb_reconciliation_discrepancy({ accountName, sinceDate: "${fromDate}", asOfDate: "${toDate}" })\` — flag any prior-cleared txn modified during the period (broke-prior-rec signal).`,
    "- Walk the operator's bank statement line-by-line; for each statement line that has a matching MCP entry, call `qb_cleared_status_update({ txnId, clearedStatus: \"Cleared\" })`.",
    "- After clearing, re-run `qb_uncleared_transactions` and confirm the remaining total matches statement outstanding items.",
    "",
    "## 3. Credit card reconciliation (mirror of step 2)",
    "- `qb_account_list({ accountType: \"CreditCard\" })` — enumerate CC accounts.",
    "- For each: `qb_uncleared_transactions` → reconcile → `qb_cleared_status_update`.",
    "",
    "## 4. P&L review",
    `- \`qb_pnl_report({ fromDate: "${fromDate}", toDate: "${toDate}" })\` — full month P&L.`,
    `- For any account whose monthly change looks anomalous: \`qb_transaction_list_by_account({ accountName, fromDate: "${fromDate}", toDate: "${toDate}" })\` — every posting line. Flag duplicates, miscategorizations, or one-time items.`,
    `- \`qb_general_ledger({ fromDate: "${fromDate}", toDate: "${toDate}", accountType: "Expense" })\` — full GL detail when the operator wants to skim every expense posting.`,
    "",
    "## 5. AR / AP aging",
    `- \`qb_ar_aging({ asOfDate: "${toDate}" })\` and \`qb_ap_aging({ asOfDate: "${toDate}" })\` — bucketed open balances.`,
    "- Anything > 90 days: drill via `qb_customer_balance_detail({ customerName, fromDate, toDate })` or `qb_vendor_balance_detail({ vendorName, fromDate, toDate })`.",
    "- For genuinely uncollectible AR, propose `qb_invoice_write_off({ txnId, writeOffAccount: \"Bad Debt\" })` and confirm with the operator before running.",
    "",
    "## 6. Balance sheet & cash flow",
    `- \`qb_balance_sheet_report({ asOfDate: "${toDate}" })\` — confirm Assets = Liabilities + Equity reconciles.`,
    `- \`qb_balance_summary({ asOfDate: "${toDate}" })\` — flattened view, 16-way bucketing.`,
    `- \`qb_statement_of_cash_flows({ fromDate: "${fromDate}", toDate: "${toDate}" })\` — indirect-method SCF.`,
    "",
    "## 7. Final summary",
    "Write a 5-bullet summary for the operator covering:",
    "- Reconciliation outcomes (how many txns cleared per account, any discrepancies).",
    "- P&L highlights (vs prior month if available — re-run step 4 with the prior month's dates).",
    "- Aging concerns (> 60 days items).",
    "- Recommended write-offs / adjustments (with the operator's approval gate).",
    "- Anything anomalous that needs operator decision before booking.",
    "",
    "Do NOT call `qb_closing_date_set` — the SDK has no write path. If the operator wants the period locked, surface `qb_closing_date_set`'s UI navigation steps (Edit → Preferences → Accounting → Company Preferences).",
  ].join("\n");
  return userTextResult(
    `Month-end close workflow for ${fromDate} through ${toDate}`,
    text,
  );
};

// -----------------------------------------------------------------------
// Prompt: credit_card_qb_batch
// -----------------------------------------------------------------------

const creditCardBatchArgs = {
  creditCardAccountName: z
    .string()
    .optional()
    .describe("CreditCard account's FullName to post against (e.g. 'Chase Business Visa'). When unset, the prompt lists candidates via qb_account_list and the agent picks."),
  statementMonth: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional()
    .describe("Statement month in ISO YYYY-MM form (e.g. '2026-04'). Used to default txnDate windows and reference numbers."),
  source: z
    .string()
    .optional()
    .describe("Where the statement data is coming from (e.g. 'attached CSV', 'Chase PDF', 'paste from spreadsheet'). Shapes the parsing step."),
};

export const creditCardBatchPrompt: PromptCallback<typeof creditCardBatchArgs> = (args) => {
  const acctClause = args.creditCardAccountName
    ? `the credit-card account "${args.creditCardAccountName}"`
    : "a credit-card account (use qb_account_list({ accountType: \"CreditCard\" }) to enumerate, then ask the operator which one)";
  const sourceClause = args.source ?? "the operator's pasted statement / attached file";
  const monthLabel = args.statementMonth ?? "the statement month";
  const text = [
    `# Credit-Card Batch Entry — ${monthLabel}`,
    "",
    `Goal: post a credit-card statement worth of charges to ${acctClause} atomically (all-or-nothing) using \`qb_journal_entry_batch_create\` — the same workflow as the operator's \`credit-card-qb-batch\` skill, now driven through the MCP instead of an Excel intermediate.`,
    "",
    "## 1. Parse the source",
    `Source: ${sourceClause}.`,
    "Extract one row per charge with: txnDate (ISO YYYY-MM-DD), payee/description, amount, GL expense account, optional class/customer for job-cost allocation.",
    "",
    "## 2. Confirm the destination account + map categories",
    "- `qb_account_list({ accountType: \"CreditCard\" })` to confirm the CC account exists.",
    "- For each line's expense category, confirm a matching GL account via `qb_account_list({ accountType: \"Expense\" })` (or `CostOfGoodsSold` / `OtherExpense` as appropriate). Surface unmatched categories to the operator BEFORE building the batch — do not silently bucket to 'Uncategorized Expense'.",
    "- If the operator uses class tracking, confirm class names via `qb_class_list`.",
    "",
    "## 3. Stage the JE batch",
    "Each charge becomes one Journal Entry with two lines:",
    "- Debit the expense GL account by the amount.",
    "- Credit the credit-card liability account by the same amount.",
    "Refunds reverse: debit CC liability, credit the expense account.",
    "",
    "## 4. Validate before submission",
    "- Confirm each JE balances to the cent (sum(debits) === sum(credits)).",
    "- Confirm the batch total matches the statement total the operator gave you (catch a missed line BEFORE posting).",
    "- Show the operator a preview: total charge count, total dollar amount, top 5 expense accounts hit, any unusual amounts.",
    "",
    "## 5. Post atomically",
    "Call `qb_journal_entry_batch_create({ entries: [...], idempotencyKey: \"cc-batch-<account>-<month>\" })`. Atomic — all-or-nothing. If any entry fails mid-wire, the prior-posted entries auto-rollback via compensating delete.",
    "",
    "## 6. Verify",
    "- Re-run `qb_balance_summary` and confirm the CC liability total rose by the expected amount.",
    "- For one or two posted JEs, call `qb_transaction_list_by_account({ accountName: <cc account> })` and visually confirm they're present.",
    "",
    "## Idempotency",
    "Use a stable `idempotencyKey` (e.g. `\"cc-batch-chase-2026-04\"`). If the network dies mid-call, retrying with the same key replays the cached result instead of double-posting. Different payload + same key → statusCode 9002.",
    "",
    "## Edge cases",
    "- A merchant credit (refund) posted to CC: debit the CC account, credit the original expense account. The line direction flips.",
    "- Payments TO the credit card (statement payoff) are NOT in this batch — those are bank-side `qb_bill_pay` or `qb_journal_entry_create` calls.",
    "- A charge that should split across accounts (e.g. an Amazon order with 3 different categories): expand to a single JE with N debit lines and one credit line.",
  ].join("\n");
  return userTextResult(
    `Credit-card statement batch entry workflow${args.statementMonth ? ` for ${args.statementMonth}` : ""}`,
    text,
  );
};

// -----------------------------------------------------------------------
// Prompt: trial_balance_workup
// -----------------------------------------------------------------------

const trialBalanceArgs = {
  asOfDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("As-of date for the trial balance in ISO YYYY-MM-DD. Default: today."),
  basis: z
    .enum(["Accrual", "Cash"])
    .optional()
    .describe("Accounting basis. Default Accrual."),
};

export const trialBalanceWorkupPrompt: PromptCallback<typeof trialBalanceArgs> = (args) => {
  const asOfDate = args.asOfDate ?? todayISO();
  const basis = args.basis ?? "Accrual";
  const text = [
    `# Trial Balance Workup — ${asOfDate} (${basis} basis)`,
    "",
    "Pull a TB + adjacent cross-checks for the operator's trial-balance workpaper (same shape as the existing `trial-balance-workup` skill).",
    "",
    "## 1. Trial balance core",
    `- \`qb_balance_summary({ asOfDate: "${asOfDate}", basis: "${basis}" })\` — 16-way bucketing of every GL account with non-zero balance plus subtotal block (assets / liabilities / equity / income / expenses / netIncome).`,
    "- `qb_account_list({ includeInactive: false })` — confirm chart of accounts hasn't drifted since the last workpaper.",
    "- `qb_tax_line_mapping()` — surface QB's tax-line assignments (Sch C / 1120-S / 1065 / etc.) for any account that has one. *(If qb_tax_line_mapping isn't yet implemented, fall back to `qb_account_list` — every Account.TaxLineInfoRet has the tax-line code.)*",
    "",
    "## 2. Cross-checks",
    `- \`qb_balance_sheet_report({ asOfDate: "${asOfDate}", basis: "${basis}" })\` — confirm Assets = Liabilities + Equity reconciles to the cent.`,
    `- \`qb_pnl_report({ toDate: "${asOfDate}", basis: "${basis}" })\` — confirm period NetIncome matches the equity-side NetIncome plug.`,
    `- \`qb_ar_aging({ asOfDate: "${asOfDate}" })\` and \`qb_ap_aging({ asOfDate: "${asOfDate}" })\` — confirm the AR/AP totals match the trial-balance AR/AP account balances.`,
    "",
    "## 3. Account drill-downs (operator-driven)",
    "For any account where the operator wants posting-level detail:",
    `- \`qb_transaction_list_by_account({ accountName, toDate: "${asOfDate}" })\` — every line with running balance.`,
    `- \`qb_general_ledger({ toDate: "${asOfDate}", accountType: <type> })\` — full GL detail by AccountType.`,
    "",
    "## 4. Output shape",
    "Surface to the operator as a single workpaper-shaped table:",
    "| AccountName | AccountType | TaxLine | DebitBalance | CreditBalance | LastActivityDate |",
    "Sorted by AccountType in the canonical QB order (Bank → AR → OCA → … → Equity → Income → COGS → Expense → OtherIncome → OtherExpense), then alphabetical within type. Debits are positive balances on natural-debit accounts (assets, expenses) and the inverse on natural-credit accounts (liabilities, equity, income).",
    "",
    "Surface the cross-check results in a separate block:",
    "- BS Assets total vs. Liab+Equity total — must equal to the cent.",
    "- BS Equity NetIncome vs. P&L NetIncome — must equal.",
    "- BS Accounts Receivable vs. AR aging total — must equal.",
    "- BS Accounts Payable vs. AP aging total — must equal.",
    "Any mismatch is an audit signal — surface loudly, do not paper over.",
  ].join("\n");
  return userTextResult(
    `Trial balance workup as of ${asOfDate}`,
    text,
  );
};

// -----------------------------------------------------------------------
// Prompt: cc_statement_validator
// -----------------------------------------------------------------------

const ccStatementValidatorArgs = {
  creditCardAccountName: z
    .string()
    .optional()
    .describe("CreditCard account's FullName to validate (e.g. 'Chase Business Visa'). When unset, the prompt lists candidates."),
  statementEndingBalance: z
    .string()
    .regex(/^-?\d+(\.\d{1,2})?$/)
    .optional()
    .describe("Ending balance from the operator's downloaded CC statement (e.g. '1342.07'). When supplied, the prompt cross-checks against QB's ending balance and flags the delta."),
  statementEndingDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Statement ending date in ISO YYYY-MM-DD. Default: today."),
};

export const ccStatementValidatorPrompt: PromptCallback<typeof ccStatementValidatorArgs> = (args) => {
  const asOfDate = args.statementEndingDate ?? todayISO();
  const acctClause = args.creditCardAccountName
    ? `the credit-card account "${args.creditCardAccountName}"`
    : "a credit-card account (use qb_account_list({ accountType: \"CreditCard\" }) to enumerate, then ask the operator which one)";
  const balanceClause = args.statementEndingBalance
    ? `Operator's statement ending balance: $${args.statementEndingBalance}.`
    : "Ask the operator for the statement's ending balance before starting.";
  const text = [
    `# Credit-Card Statement Validator — as of ${asOfDate}`,
    "",
    `Validate ${acctClause} against the operator's downloaded statement (same shape as the existing \`cc-statement-validator\` skill — now driven through the MCP).`,
    "",
    balanceClause,
    "",
    "## 1. QB-side state",
    `- \`qb_account_list({ accountType: "CreditCard" })\` to confirm the account and capture its current Balance.`,
    `- \`qb_transaction_list_by_account({ accountName: <cc account>, toDate: "${asOfDate}" })\` — every CC posting through the statement date with running balance. The closing balance must match the operator's statement ending balance.`,
    `- \`qb_uncleared_transactions({ accountName: <cc account>, asOfDate: "${asOfDate}" })\` — every CC posting not yet marked Cleared.`,
    "",
    "## 2. Three-way reconciliation",
    "Compare:",
    "- QB ending balance (from `qb_transaction_list_by_account`) → must equal the statement ending balance.",
    "- Statement-side charge count vs. QB-side charge count over the period → must equal.",
    "- For each statement line, find the matching QB posting (by date + amount + payee). Surface unmatched lines from BOTH sides loudly:",
    "  - Statement line with no QB match → either a missing entry (call `qb_journal_entry_create` or `qb_bill_create` to record) or operator-side miscategorization.",
    "  - QB posting with no statement match → either a duplicate (`qb_journal_entry_delete` after operator confirmation) or a pending charge that hasn't hit the statement yet.",
    "",
    "## 3. Discrepancy scan",
    `- \`qb_reconciliation_discrepancy({ accountName: <cc account>, sinceDate: <last close>, asOfDate: "${asOfDate}" })\` — flag any prior-cleared txn modified during the period.`,
    "",
    "## 4. Mark cleared",
    "For each statement line with a confirmed QB match, call `qb_cleared_status_update({ txnId, clearedStatus: \"Cleared\" })`. Do this in a loop with a small operator-pause every ~10 txns so the operator can audit.",
    "",
    "## 5. Final report",
    "- Reconciliation status: balanced / off-by-$X.YZ.",
    "- Cleared count: <n> of <total>.",
    "- Remaining uncleared (pending) count + total: <n> totaling $X.YZ.",
    "- Discrepancies found: list of (txnId, prior cleared date, modified date, modification description) if any.",
    "- Surface any matches/unmatched-lines block from step 2 if non-empty.",
  ].join("\n");
  return userTextResult(
    `Credit-card statement validation as of ${asOfDate}`,
    text,
  );
};

// -----------------------------------------------------------------------
// Prompt: w2_prep
// -----------------------------------------------------------------------

const w2PrepArgs = {
  taxYear: z
    .string()
    .regex(/^\d{4}$/)
    .optional()
    .describe("Tax year to prep W-2s for (YYYY). Default: last completed year."),
  employeeFullName: z
    .string()
    .optional()
    .describe("Single employee to scope to. When unset, prep for every active employee."),
};

export const w2PrepPrompt: PromptCallback<typeof w2PrepArgs> = (args) => {
  const taxYear = args.taxYear ?? lastCompletedYear();
  const scope = args.employeeFullName
    ? `for "${args.employeeFullName}"`
    : "for every active employee";
  const text = [
    `# W-2 Prep — Tax Year ${taxYear} ${scope}`,
    "",
    "Pull every employee's W-2-shaped totals from QB Payroll and surface a per-employee filing checklist.",
    "",
    "## 1. Edition + subscription probe",
    "- `qb_host_query` — confirm the edition supports payroll (`edition` ∈ {Premier, PremierAccountant, Enterprise, EnterpriseAccountant} or Pro Plus).",
    "- Pro builds without Plus reject pre-flight with statusCode 9003 — surface to the operator and stop.",
    "",
    "## 2. Pull the W-2 summary",
    `- \`qb_w2_summary({ taxYear: "${taxYear}"${args.employeeFullName ? `, employeeFullName: "${args.employeeFullName}"` : ""} })\` — returns per-employee box totals (box 1 wages, box 2 federal withholding, box 3-6 SS/Medicare, box 16-17 state). SSN masked to last 4.`,
    "- If the call returns statusCode 9004, the operator's QB Payroll subscription is not active — flag and stop. Direct them to Employees → My Payroll Service → Account/Billing Info in QB Desktop.",
    "",
    "## 3. Employee-side cross-checks",
    "- `qb_employee_list({ includeInactive: false })` — confirm every employee with W-2 data is still active. Inactive employees with payroll activity in the year still need a W-2.",
    "- For each employee:",
    "  - Confirm FullName, address (Address1, City, State, PostalCode), and SSN-last-4 from `qb_employee_list` match what the operator has on file. Surface any missing fields.",
    "  - State withholding (box 17) ≠ 0 → confirm the state abbreviation (box 16) is correct.",
    "",
    "## 4. Reconciliation",
    "- Sum of all box-1 wages must equal the year's GrossWages on a `qb_pnl_report({ fromDate: \"${taxYear}-01-01\", toDate: \"${taxYear}-12-31\" })` Salaries+Wages line (within rounding). Surface if delta > $1.",
    "- Sum of all box-2 federal withholding must equal the year's Federal Withholding Liability balance on `qb_balance_summary`.",
    "",
    "## 5. Output",
    "Per-employee table:",
    "| FullName | SSN | Box1 | Box2 | Box3 | Box4 | Box5 | Box6 | Box16(State) | Box17(StateWH) | ReadyToFile |",
    "Plus a summary block:",
    "- Total employees: <n>",
    "- Total box-1 wages: $X",
    "- Total box-2 withholding: $X",
    "- Issues found: <list of employees with missing fields or reconciliation drift>",
    "",
    "## Privacy",
    "QB Payroll masks SSN to last 4 (XXX-XX-####) at the qb_w2_summary tool surface — full SSN is never returned through this MCP. The operator pulls full SSNs from QB Desktop directly (Employees → Employee Center → Personal tab) when actually filing.",
  ].join("\n");
  return userTextResult(
    `W-2 prep for tax year ${taxYear}`,
    text,
  );
};

// -----------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------

/**
 * Per-prompt metadata + callback. Stored as a const array of
 * heterogeneously-typed entries so each entry preserves its own
 * argsSchema → callback contract; `registerWorkflowPrompts` iterates and
 * dispatches per entry. Exposed (instead of being an internal const) so the
 * test layer can introspect registrations without instantiating an MCP
 * server.
 *
 * The narrow per-entry generic preserves the link between argsSchema's shape
 * and the callback's args type; a single `Array<{...}>` would widen
 * argsSchema to `Record<string, ZodTypeAny>` and force the callback
 * signature to a too-loose contract that `server.registerPrompt` rejects.
 */
export interface PromptRegistration<Args extends Record<string, z.ZodTypeAny>> {
  name: string;
  title: string;
  description: string;
  argsSchema: Args;
  callback: PromptCallback<Args>;
}

function reg<Args extends Record<string, z.ZodTypeAny>>(
  entry: PromptRegistration<Args>,
): PromptRegistration<Args> {
  return entry;
}

export const PROMPT_REGISTRATIONS = [
  reg({
    name: "month_end_close",
    title: "Month-End Close",
    description:
      "Full month-end close workflow — bank rec, CC rec, P&L review, AR/AP aging, BS reconcile, SCF. Composes against the post-Phase-11/12 tool surface. Defaults to the prior calendar month when fromDate/toDate are unset.",
    argsSchema: monthEndCloseArgs,
    callback: monthEndClosePrompt,
  }),
  reg({
    name: "credit_card_qb_batch",
    title: "Credit Card Batch Entry",
    description:
      "Post a credit-card statement worth of charges via qb_journal_entry_batch_create. Bridges the operator's existing `credit-card-qb-batch` skill from Excel-intermediate to direct MCP entry.",
    argsSchema: creditCardBatchArgs,
    callback: creditCardBatchPrompt,
  }),
  reg({
    name: "trial_balance_workup",
    title: "Trial Balance Workup",
    description:
      "Pull TB + cross-checks (BS reconcile, AR/AP totals, P&L netIncome plug) for the operator's trial-balance workpaper. Bridges the existing `trial-balance-workup` skill from manual CSV export to direct MCP query.",
    argsSchema: trialBalanceArgs,
    callback: trialBalanceWorkupPrompt,
  }),
  reg({
    name: "cc_statement_validator",
    title: "Credit Card Statement Validator",
    description:
      "Three-way reconciliation of a credit-card statement against QB's CC account state — balance match, line-by-line match, discrepancy scan, clear-on-match. Bridges the operator's existing `cc-statement-validator` skill.",
    argsSchema: ccStatementValidatorArgs,
    callback: ccStatementValidatorPrompt,
  }),
  reg({
    name: "w2_prep",
    title: "W-2 Prep",
    description:
      "January W-2 prep — pulls per-employee W-2-shaped totals via qb_w2_summary, cross-checks against employee list + P&L wage totals + balance-sheet withholding liability, surfaces a per-employee filing checklist. Subject to QB Payroll subscription availability.",
    argsSchema: w2PrepArgs,
    callback: w2PrepPrompt,
  }),
] as const;

/**
 * Register every workflow-bundle prompt against the MCP server. Single
 * entry point; `src/index.ts` calls this once during server bring-up.
 *
 * Requires the server to have been constructed with `capabilities.prompts: {}`
 * — without that, the SDK does not advertise the prompts/list and prompts/get
 * handlers on the wire even if registrations succeed.
 */
export function registerWorkflowPrompts(server: McpServer): void {
  // Each entry keeps its own generic Args type through the const-tuple, so
  // server.registerPrompt receives a tight (argsSchema, callback) pair per
  // call. Looping over the heterogeneous tuple in TS requires the entry to
  // be passed through registerPrompt's generic — handled by a per-entry
  // helper rather than a runtime cast, so the callback's args parameter
  // stays type-checked.
  PROMPT_REGISTRATIONS.forEach((entry) => {
    server.registerPrompt(
      entry.name,
      {
        title: entry.title,
        description: entry.description,
        argsSchema: entry.argsSchema,
      },
      entry.callback as PromptCallback<typeof entry.argsSchema>,
    );
  });
}
