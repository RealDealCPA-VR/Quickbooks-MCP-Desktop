/**
 * qb_client_packet — Tax-prep workpaper bundle (Phase 15 #71).
 *
 * Single composite tool that rolls up the standard tax-season packet for one
 * .qbw file into one call. Replaces the 5-7 separate tool invocations a CPA
 * runs at the start of every client's return:
 *
 *   • Trial Balance               (qb_trial_balance_export shape)
 *   • General Ledger              (qb_general_ledger shape, P&L-only by default)
 *   • Bank reconciliation drift   (qb_reconciliation_discrepancy fanned across
 *                                  every Bank + CreditCard account)
 *   • Payroll summary (W-2)       (qb_w2_summary shape, fail-soft when the
 *                                  edition can't surface payroll or no
 *                                  subscription is active)
 *   • Fixed asset detail          (FixedAsset accounts + every posting in the
 *                                  tax-year window — primary Form 4562 input)
 *
 * This is a pure composite — every section reuses the same session primitives
 * the underlying single-purpose tools call. No new wire types, no parser
 * changes, no new manager methods. The shared building blocks
 * (`buildTrialBalance`, `buildGeneralLedgerSection`) are imported from
 * `./reports.ts`; bank-rec row formatting + W-2 box mapping are inlined
 * (small enough, and decoupling the composite from the surface shape of two
 * other tools is worth the duplication).
 *
 * Fail-soft per section: a single section's failure does NOT fail the whole
 * packet. Each `sections.<name>` block is either the success payload OR a
 * `{ error: { statusCode, statusMessage, humanReadable? } }` block; the
 * `sectionStatus` map at the top of the response carries "ok" | "skipped"
 * | "error" for every section so an orchestrator can branch without parsing
 * the nested shape. Payroll has a third state — `"skipped"` — for the two
 * gates that aren't errors (edition unsupported and empty-result-most-likely-
 * means-no-subscription). The same fail-soft contract `qb_session_status`
 * already established.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";
import { ISO_DATE_RE } from "../util/validators.js";
import {
  buildTrialBalance,
  buildGeneralLedgerSection,
  type TrialBalanceAccount,
  type TrialBalanceReportInput,
  type GeneralLedgerAccountInput,
  type GeneralLedgerSection,
} from "./reports.js";

// AccountType buckets reused locally so this file does not depend on
// reports.ts exporting an internal constant. Mirrors the same canonical
// ordering used by qb_trial_balance_export.
const PNL_TYPES = new Set<string>([
  "Income",
  "OtherIncome",
  "CostOfGoodsSold",
  "Expense",
  "OtherExpense",
]);

const ALL_GL_TYPES = new Set<string>([
  "Bank",
  "AccountsReceivable",
  "OtherCurrentAsset",
  "Inventory",
  "FixedAsset",
  "OtherAsset",
  "AccountsPayable",
  "CreditCard",
  "OtherCurrentLiability",
  "LongTermLiability",
  "Equity",
  "Income",
  "OtherIncome",
  "CostOfGoodsSold",
  "Expense",
  "OtherExpense",
]);

const BANK_REC_INCLUDE_COLUMNS = [
  "TxnType",
  "Date",
  "Num",
  "Name",
  "Memo",
  "Amount",
  "ClearedStatus",
] as const;

// Per-account caps to keep responses bounded against pathological data sets
// (e.g. a high-volume retailer with 10k+ postings per cash account). The
// underlying QBXML *QueryRq caps at MaxReturned=500 per call anyway.
const MAX_ROWS_PER_ACCOUNT = 500;

// Mirrors the same row shape qb_uncleared_transactions / qb_reconciliation_
// discrepancy emit (kept private to this module — exporting from reconciliation
// would couple the composite to that file's internals just to dedupe one
// 12-line formatter).
function formatBankRecRow(row: Record<string, unknown>): {
  txnType: string;
  txnDate: string;
  refNumber: string;
  name: string;
  memo: string;
  amount: number;
  clearedStatus: string;
  txnId?: string;
  timeModified?: string;
} {
  const txnId = row.TxnID !== undefined ? String(row.TxnID) : undefined;
  const timeModified = row.TimeModified !== undefined
    ? String(row.TimeModified)
    : (row.Modified !== undefined ? String(row.Modified) : undefined);
  return {
    txnType: String(row.TxnType ?? row._rowType ?? ""),
    txnDate: String(row.Date ?? ""),
    refNumber: String(row.Num ?? ""),
    name: String(row.Name ?? ""),
    memo: String(row.Memo ?? ""),
    amount: Number(row.Amount ?? 0),
    clearedStatus: String(row.ClearedStatus ?? ""),
    ...(txnId ? { txnId } : {}),
    ...(timeModified ? { timeModified } : {}),
  };
}

// W-2 box mapping shared with qb_w2_summary. Duplicated rather than refactored
// out of reports.ts because the composite hard-couples the box names to its
// output shape (a future change to qb_w2_summary's box surface should also
// touch the composite intentionally rather than silently).
function mapPayrollRowToW2Boxes(r: Record<string, unknown>): Record<string, unknown> {
  const ref = (r.EmployeeRef as Record<string, unknown> | undefined) ?? {};
  const out: Record<string, unknown> = {
    employeeListId: String(ref.ListID ?? ""),
    employeeFullName: String(ref.FullName ?? ""),
    ssn: String(r.SSN ?? ""),
    box1_wagesTipsOtherComp: Number(r.GrossWages ?? 0),
    box2_federalIncomeTaxWithheld: Number(r.FederalIncomeTaxWithheld ?? 0),
    box3_socialSecurityWages: Number(r.SocialSecurityWages ?? 0),
    box4_socialSecurityTaxWithheld: Number(r.SocialSecurityTaxWithheld ?? 0),
    box5_medicareWages: Number(r.MedicareWages ?? 0),
    box6_medicareTaxWithheld: Number(r.MedicareTaxWithheld ?? 0),
  };
  if (r.StateAbbreviation !== undefined) out.stateAbbreviation = String(r.StateAbbreviation);
  if (r.StateWages !== undefined) out.box16_stateWages = Number(r.StateWages);
  if (r.StateIncomeTaxWithheld !== undefined) out.box17_stateIncomeTax = Number(r.StateIncomeTaxWithheld);
  return out;
}

type SectionStatus = "ok" | "skipped" | "error";

type ErrorBlock = {
  error: {
    statusCode: number;
    statusMessage: string;
    humanReadable?: string;
  };
};

function asErrorBlock(err: unknown, fallback: string): ErrorBlock {
  const e = err as { message?: string; statusCode?: number };
  const sc = e.statusCode ?? -1;
  const humanReadable = qbStatusCodeMessage(sc);
  return {
    error: {
      statusCode: sc,
      statusMessage: e.message ?? fallback,
      ...(humanReadable ? { humanReadable } : {}),
    },
  };
}

export function registerClientPacketTools(
  server: McpServer,
  getSession: () => QBSessionManager,
): void {
  server.tool(
    "qb_client_packet",
    "Tax-prep workpaper bundle for one client file (Phase 15 #71) — the composite a CPA fires at the start of every return. One call rolls up Trial Balance + General Ledger + bank reconciliation drift + Payroll Summary (W-2 boxes) + Fixed Asset detail across the full tax year (Jan 1 → Dec 31 of `taxYear`). Pure composite over existing session primitives (queryEntity / queryTransactions / runReport / runCustomDetailReport / runPayrollSummaryReport / getHostInfo) — no new wire types, no parser changes. Each section is FAIL-SOFT: a section error (e.g. payroll subscription not active → 9004; edition can't surface payroll → 9003; a bank account's runCustomDetailReport rejects) lands in `sections.<name>.error` and the top-level `sectionStatus.<name>` flips to 'error' or 'skipped', but the rest of the packet still returns. The whole tool only fails when the initial AccountQueryRq fails (no chart of accounts → no sections can build). Optional customer context: pass `customerListId` or `customerName` to surface that customer's FullName + Balance at the top of the packet as a label (useful when the operator's own books track each tax client as a customer record). The customer scope does NOT filter the underlying reports — the .qbw file IS the client. GL fanout defaults to P&L scope (Income / Expense / COGS / OtherIncome / OtherExpense) — the typical tax-prep ask, ~5-15 accounts per file. Pass `glScope: 'AllAccounts'` to expand to every GL-eligible account (~50-100 accounts in a typical small business) when you need the full set. Bank rec discrepancy fans out across every Bank + CreditCard account on the file — per-account errors land in that account's section without poisoning the others. Payroll summary returns `{ skipped: { statusCode: 9003, ... } }` on Pro edition (no payroll surface) or `{ skipped: { statusCode: 9004, ... } }` when the wire returns no data (subscription inactive or no employees with YTD activity in the tax year) — distinguishes 'edition gap' from 'subscription gap' from 'no employees'. Section toggles (`includeTrialBalance` / `includeGeneralLedger` / `includeBankReconDiscrepancy` / `includePayrollSummary` / `includeFixedAssetDetail`) all default true; flip individually to `false` to scope the packet to just the sections you want. `bankReconDiscrepancySinceDate` defaults to the start of `taxYear` — anything cleared-and-modified inside the tax year surfaces. Output: { success: true, taxYear, fromDate, toDate, basis, generatedAt, customer | null, sections: {...}, sectionStatus: { trialBalance, generalLedger, bankReconciliationDiscrepancy, payrollSummary, fixedAssetDetail }, warnings? }. Read-side; does NOT require a writable session.",
    {
      taxYear: z.number().int().min(2000).max(2100)
        .describe("Tax year for the packet (e.g. 2024). The date window is always Jan 1 → Dec 31 of this year — partial-year client packets are not supported (the workpaper model is annual)."),
      customerListId: z.string().optional()
        .describe("Optional context: customer ListID. When supplied, the customer is looked up via CustomerQueryRq and surfaced as `customer: { listId, fullName, balance }` at the top of the packet — does NOT filter the underlying reports (the .qbw file IS the client). Takes precedence over customerName when both are supplied."),
      customerName: z.string().optional()
        .describe("Optional context: customer FullName. Same behavior as customerListId — lookup + surface as label, not a report filter."),
      basis: z.enum(["Accrual", "Cash"]).optional()
        .describe("Accounting basis. Defaults to Accrual. Threaded through TB / GL / bank rec sections for parity with the underlying tools."),
      includeTrialBalance: z.boolean().optional()
        .describe("When false, skip the Trial Balance section. Default true."),
      includeGeneralLedger: z.boolean().optional()
        .describe("When false, skip the General Ledger section. Default true."),
      includeBankReconDiscrepancy: z.boolean().optional()
        .describe("When false, skip the bank reconciliation discrepancy section. Default true."),
      includePayrollSummary: z.boolean().optional()
        .describe("When false, skip the payroll summary section entirely (does not even probe edition). Default true. The section is also implicitly skipped at runtime when the edition is Pro (9003) or when the wire returns no payroll data (9004) — those land as `{ skipped: {...} }` rather than errors."),
      includeFixedAssetDetail: z.boolean().optional()
        .describe("When false, skip the Fixed Asset detail section. Default true. The section returns an empty `accounts` array when no FixedAsset accounts exist on the chart of accounts (typical for service businesses) — that's NOT an error condition."),
      glScope: z.enum(["PnLOnly", "AllAccounts"]).optional()
        .describe("General-Ledger fanout scope. 'PnLOnly' (default) limits the fanout to Income / Expense / COGS / OtherIncome / OtherExpense accounts — the typical tax-prep ask. 'AllAccounts' expands to every GL-eligible AccountType (50-100 accounts in a typical small business; costs N round trips in live mode, with N capped to maxAccounts)."),
      bankReconDiscrepancySinceDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("Lower bound on TimeModified for the bank-rec discrepancy section (YYYY-MM-DD, inclusive). Defaults to the start of the tax year (`${taxYear}-01-01`) — anything cleared then modified inside the tax year surfaces."),
    },
    async (args) => {
      const session = getSession();

      const taxYear = args.taxYear;
      const fromDate = `${taxYear}-01-01`;
      const toDate = `${taxYear}-12-31`;
      const basis = args.basis ?? "Accrual";
      const reconSince = args.bankReconDiscrepancySinceDate ?? fromDate;
      const glScope = args.glScope ?? "PnLOnly";

      const includeTB = args.includeTrialBalance !== false;
      const includeGL = args.includeGeneralLedger !== false;
      const includeRecon = args.includeBankReconDiscrepancy !== false;
      const includePayroll = args.includePayrollSummary !== false;
      const includeFA = args.includeFixedAssetDetail !== false;

      const warnings: string[] = [];
      const sections: Record<string, unknown> = {};
      const sectionStatus: Record<string, SectionStatus> = {
        trialBalance: "skipped",
        generalLedger: "skipped",
        bankReconciliationDiscrepancy: "skipped",
        payrollSummary: "skipped",
        fixedAssetDetail: "skipped",
      };

      // ---------------------------------------------------------------------
      // Customer context (optional). A failure here is non-fatal — the packet
      // still emits with `customer: null` and a warning. The customer header
      // is just a label, not a hard input.
      // ---------------------------------------------------------------------
      let customer: { listId: string; fullName: string; balance?: number } | null = null;
      if (args.customerListId || args.customerName) {
        try {
          const customerFilters: Record<string, unknown> = {};
          if (args.customerListId) customerFilters.ListID = args.customerListId;
          if (args.customerName) customerFilters.FullName = args.customerName;
          const matched = await session.queryEntity("Customer", customerFilters);
          if (matched.length > 0) {
            const c = matched[0] as Record<string, unknown>;
            customer = {
              listId: String(c.ListID ?? ""),
              fullName: String(c.FullName ?? c.Name ?? ""),
              ...(c.Balance !== undefined ? { balance: Number(c.Balance) } : {}),
            };
          } else {
            warnings.push(
              `Customer ${args.customerListId ?? args.customerName} not found on this company file — packet proceeds without customer header.`,
            );
          }
        } catch (err) {
          warnings.push(`Customer lookup failed: ${(err as Error).message}`);
        }
      }

      // ---------------------------------------------------------------------
      // Shared chart-of-accounts fetch. TB / GL / bank-rec / fixed-asset
      // sections all reuse this. If this fails, NO section can build — the
      // whole tool fails (the one non-fail-soft path).
      // ---------------------------------------------------------------------
      let allAccounts: Array<Record<string, unknown>>;
      try {
        allAccounts = await session.queryEntity("Account", {});
      } catch (err) {
        const block = asErrorBlock(err, "AccountQueryRq failed");
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              ...block.error,
              statusMessage: `qb_client_packet pre-flight failed: ${block.error.statusMessage}`,
            }),
          }],
          isError: true,
        };
      }

      // ---------------------------------------------------------------------
      // Section: Trial Balance — same 5-call composite as qb_trial_balance_export.
      // ---------------------------------------------------------------------
      if (includeTB) {
        try {
          const bsRet = await session.runReport("BalanceSheetStandard", { toDate, basis });
          const pnlRet = await session.runReport("ProfitAndLossStandard", { toDate, basis });

          const invoices = await session.queryEntity("Invoice", {});
          let arAgingTotal = 0;
          for (const inv of invoices) {
            if (inv.IsPaid === true) continue;
            const bal = Number(inv.BalanceRemaining ?? 0);
            if (bal > 0) arAgingTotal += bal;
          }

          const bills = await session.queryEntity("Bill", {});
          let apAgingTotal = 0;
          for (const bill of bills) {
            if (bill.IsPaid === true) continue;
            const amt = Number(bill.AmountDue ?? 0);
            if (amt > 0) apAgingTotal += amt;
          }

          const tb = buildTrialBalance(
            allAccounts as TrialBalanceAccount[],
            bsRet as TrialBalanceReportInput,
            pnlRet as TrialBalanceReportInput,
            arAgingTotal,
            apAgingTotal,
            {},
          );

          sections.trialBalance = {
            asOfDate: toDate,
            basis,
            rowCount: tb.rowCount,
            rows: tb.rows,
            totals: tb.totals,
            crossChecks: tb.crossChecks,
          };
          sectionStatus.trialBalance = "ok";
        } catch (err) {
          sections.trialBalance = asErrorBlock(err, "Trial Balance section failed");
          sectionStatus.trialBalance = "error";
        }
      }

      // ---------------------------------------------------------------------
      // Section: General Ledger — fans out across in-scope GL-eligible accounts.
      // PnLOnly (default) keeps the call cheap; AllAccounts expands the
      // workpaper. Per-account fetch errors do NOT poison the section — they
      // land as warnings and that account's section is omitted.
      // ---------------------------------------------------------------------
      if (includeGL) {
        try {
          const targetTypes = glScope === "AllAccounts" ? ALL_GL_TYPES : PNL_TYPES;
          const targets = (allAccounts as GeneralLedgerAccountInput[]).filter((a) => {
            const t = String(a.AccountType ?? "");
            return t !== "NonPosting" && targetTypes.has(t);
          });

          const glSections: GeneralLedgerSection[] = [];
          let totalRowCount = 0;
          for (const acct of targets) {
            const listId = acct.ListID ? String(acct.ListID) : undefined;
            const fullName = String(acct.FullName ?? acct.Name ?? "");
            const filters: Record<string, unknown> = {
              MaxReturned: MAX_ROWS_PER_ACCOUNT,
              TxnDateRangeFilter: { FromTxnDate: fromDate, ToTxnDate: toDate },
              AccountFilter: listId ? { ListID: listId } : { FullName: fullName },
            };
            try {
              const rows = await session.queryTransactions(filters);
              // Defensive re-sort — sim sorts already, live order is QB-driven.
              const sorted = [...rows].sort((a, b) => {
                const ad = String(a.TxnDate ?? "");
                const bd = String(b.TxnDate ?? "");
                if (ad !== bd) return ad < bd ? -1 : 1;
                const at = String(a.TimeCreated ?? "");
                const bt = String(b.TimeCreated ?? "");
                return at < bt ? -1 : at > bt ? 1 : 0;
              });
              const section = buildGeneralLedgerSection(acct, sorted);
              totalRowCount += section.count;
              if (section.count > 0) glSections.push(section);
            } catch (sectionErr) {
              warnings.push(
                `GL fetch failed for ${fullName}: ${(sectionErr as Error).message}`,
              );
            }
          }

          sections.generalLedger = {
            scope: glScope,
            fromDate,
            toDate,
            basis,
            accountCount: glSections.length,
            totalRowCount,
            sections: glSections,
          };
          sectionStatus.generalLedger = "ok";
        } catch (err) {
          sections.generalLedger = asErrorBlock(err, "General Ledger section failed");
          sectionStatus.generalLedger = "error";
        }
      }

      // ---------------------------------------------------------------------
      // Section: Bank reconciliation discrepancy — runCustomDetailReport with
      // ClearedOnly + fromModifiedDate fanned across every Bank + CreditCard
      // account. Per-account errors are captured INSIDE that account's entry
      // (not as warnings) so the operator can see exactly which accounts
      // failed without losing the successful ones.
      // ---------------------------------------------------------------------
      if (includeRecon) {
        try {
          const bankAndCC = (allAccounts as Array<Record<string, unknown>>).filter((a) => {
            const t = String(a.AccountType ?? "");
            return t === "Bank" || t === "CreditCard";
          });

          type PerAccountEntry = {
            accountName: string;
            accountListId?: string;
            accountType: string;
            count?: number;
            candidates?: ReturnType<typeof formatBankRecRow>[];
            error?: { statusCode: number; statusMessage: string; humanReadable?: string };
          };
          const perAccount: PerAccountEntry[] = [];
          let totalCandidateCount = 0;

          for (const acct of bankAndCC) {
            const fullName = String(acct.FullName ?? acct.Name ?? "");
            const listId = acct.ListID ? String(acct.ListID) : undefined;
            const accountType = String(acct.AccountType ?? "");
            try {
              const reportRet = await session.runCustomDetailReport({
                reportType: "CustomTxnDetail",
                toDate,
                account: listId ? { ListID: listId } : { FullName: fullName },
                clearedStatusFilter: "ClearedOnly",
                fromModifiedDate: reconSince,
                basis,
                includeColumns: [...BANK_REC_INCLUDE_COLUMNS],
              });
              const rows = (reportRet.Rows as Record<string, unknown>[] | undefined) ?? [];
              const candidates = rows.map(formatBankRecRow);
              totalCandidateCount += candidates.length;
              perAccount.push({
                accountName: fullName,
                ...(listId ? { accountListId: listId } : {}),
                accountType,
                count: candidates.length,
                candidates,
              });
            } catch (sectionErr) {
              const block = asErrorBlock(sectionErr, "runCustomDetailReport failed");
              perAccount.push({
                accountName: fullName,
                ...(listId ? { accountListId: listId } : {}),
                accountType,
                error: block.error,
              });
            }
          }

          sections.bankReconciliationDiscrepancy = {
            sinceDate: reconSince,
            asOfDate: toDate,
            accountCount: perAccount.length,
            totalCandidateCount,
            perAccount,
          };
          sectionStatus.bankReconciliationDiscrepancy = "ok";
        } catch (err) {
          sections.bankReconciliationDiscrepancy = asErrorBlock(
            err,
            "Bank reconciliation discrepancy section failed",
          );
          sectionStatus.bankReconciliationDiscrepancy = "error";
        }
      }

      // ---------------------------------------------------------------------
      // Section: Payroll Summary (W-2 prep). Three skip states:
      //   1. Edition probe → Pro → skipped(9003)
      //   2. Wire returns no rows → skipped(9004)
      //   3. Probe itself fails → error block
      // ---------------------------------------------------------------------
      if (includePayroll) {
        try {
          const hostInfo = await session.getHostInfo();
          if (hostInfo.edition === "Pro") {
            sections.payrollSummary = {
              skipped: {
                statusCode: 9003,
                statusMessage: `Edition ${hostInfo.edition} (productName: '${hostInfo.productName}') does not support payroll via the QBXML SDK`,
                humanReadable: qbStatusCodeMessage(9003),
                edition: hostInfo.edition,
                productName: hostInfo.productName,
              },
            };
            sectionStatus.payrollSummary = "skipped";
          } else {
            try {
              const ret = await session.runPayrollSummaryReport({
                reportType: "EmployeeWagesTaxesAdjustments",
                fromDate,
                toDate,
              });
              const rows = (ret.EmployeeWagesTaxesRet as Array<Record<string, unknown>> | undefined) ?? [];
              if (rows.length === 0) {
                sections.payrollSummary = {
                  skipped: {
                    statusCode: 9004,
                    statusMessage: `PayrollSummaryReportQueryRq returned no data for ${taxYear} — typical cause is no active payroll subscription, but can also mean no employees had YTD activity in the year.`,
                    humanReadable: qbStatusCodeMessage(9004),
                    taxYear,
                  },
                };
                sectionStatus.payrollSummary = "skipped";
              } else {
                const employees = rows.map(mapPayrollRowToW2Boxes);
                sections.payrollSummary = {
                  taxYear,
                  fromDate,
                  toDate,
                  count: employees.length,
                  employees,
                  totals: ret.Totals ?? null,
                };
                sectionStatus.payrollSummary = "ok";
              }
            } catch (wireErr) {
              sections.payrollSummary = asErrorBlock(wireErr, "Payroll Summary wire call failed");
              sectionStatus.payrollSummary = "error";
            }
          }
        } catch (probeErr) {
          // HostQueryRq itself failed — surface as an error block.
          sections.payrollSummary = asErrorBlock(probeErr, "Payroll edition probe failed");
          sectionStatus.payrollSummary = "error";
        }
      }

      // ---------------------------------------------------------------------
      // Section: Fixed Asset detail. New surface — no existing tool exposes
      // it. Pulls every FixedAsset account (active by default) and fans out
      // queryTransactions for the tax-year window. Output is per-account
      // current Balance + opening/closing balances (= GL section shape minus
      // the chart-of-accounts header noise) + every posting in the window.
      // ---------------------------------------------------------------------
      if (includeFA) {
        try {
          const faAccounts = (allAccounts as Array<Record<string, unknown>>).filter((a) => {
            const t = String(a.AccountType ?? "");
            if (t !== "FixedAsset") return false;
            return a.IsActive !== false;
          });

          type FixedAssetSection = {
            accountName: string;
            accountListId?: string;
            accountNumber: string | null;
            balance: number;
            openingBalance: number;
            closingBalance: number;
            periodChange: number;
            count: number;
            transactions: Record<string, unknown>[];
            error?: { statusCode: number; statusMessage: string; humanReadable?: string };
          };
          const faSections: FixedAssetSection[] = [];
          let totalRowCount = 0;

          for (const acct of faAccounts) {
            const fullName = String(acct.FullName ?? acct.Name ?? "");
            const listId = acct.ListID ? String(acct.ListID) : undefined;
            const balance = Number(acct.Balance ?? 0);
            const accountNumber = acct.AccountNumber !== undefined ? String(acct.AccountNumber) : null;
            const filters: Record<string, unknown> = {
              MaxReturned: MAX_ROWS_PER_ACCOUNT,
              TxnDateRangeFilter: { FromTxnDate: fromDate, ToTxnDate: toDate },
              AccountFilter: listId ? { ListID: listId } : { FullName: fullName },
            };
            try {
              const rows = await session.queryTransactions(filters);
              const sorted = [...rows].sort((a, b) => {
                const ad = String(a.TxnDate ?? "");
                const bd = String(b.TxnDate ?? "");
                if (ad !== bd) return ad < bd ? -1 : 1;
                const at = String(a.TimeCreated ?? "");
                const bt = String(b.TimeCreated ?? "");
                return at < bt ? -1 : at > bt ? 1 : 0;
              });
              const section = buildGeneralLedgerSection(acct as GeneralLedgerAccountInput, sorted);
              totalRowCount += section.count;
              faSections.push({
                accountName: section.accountName,
                ...(section.accountListId ? { accountListId: section.accountListId } : {}),
                accountNumber,
                balance,
                openingBalance: section.openingBalance,
                closingBalance: section.closingBalance,
                periodChange: section.periodChange,
                count: section.count,
                transactions: section.transactions,
              });
            } catch (sectionErr) {
              const block = asErrorBlock(sectionErr, "Fixed asset transaction fetch failed");
              faSections.push({
                accountName: fullName,
                ...(listId ? { accountListId: listId } : {}),
                accountNumber,
                balance,
                openingBalance: 0,
                closingBalance: 0,
                periodChange: 0,
                count: 0,
                transactions: [],
                error: block.error,
              });
            }
          }

          sections.fixedAssetDetail = {
            fromDate,
            toDate,
            accountCount: faSections.length,
            totalRowCount,
            accounts: faSections,
          };
          sectionStatus.fixedAssetDetail = "ok";
        } catch (err) {
          sections.fixedAssetDetail = asErrorBlock(err, "Fixed Asset Detail section failed");
          sectionStatus.fixedAssetDetail = "error";
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            taxYear,
            fromDate,
            toDate,
            basis,
            generatedAt: new Date().toISOString(),
            customer,
            sections,
            sectionStatus,
            ...(warnings.length > 0 ? { warnings } : {}),
          }, null, 2),
        }],
      };
    },
  );
}
