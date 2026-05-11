/**
 * Bank reconciliation tools.
 *
 * Phase 10 #46 (write side) and Phase 11 #56 + #56a (read side).
 *
 * SDK surface: the QBXML schema's only first-class reconciliation primitive
 * is `ClearedStatusModRq` — there is no `ReconcileQueryRq`, no
 * `ReconcileDetail` GeneralDetailReportType, no `LastReconciledDate` on
 * AccountRet (verified against qbxmlops130/140 schemas). `ClearedStatus`
 * is also NOT a filter on any *QueryRq nor a returned field on any *Ret
 * element — it appears ONLY as input on `ClearedStatusModRq` and as an
 * output column on `CustomDetailReportQueryRq` via
 * `IncludeColumn=ClearedStatus`. So both sides of the reconciliation
 * surface route through narrow, distinct wire types.
 *
 * Tools shipped here:
 *   • qb_cleared_status_update     — write primitive (#46)
 *   • qb_uncleared_transactions    — read: list NotCleared / Pending bank
 *                                    txns scoped to one bank/CC account (#56a)
 *   • qb_reconciliation_discrepancy — read: surface signs a prior recon
 *                                    was broken (modified-after-cleared +
 *                                    Reconciliation Discrepancies postings) (#56)
 *
 * The two read tools both ride on `runCustomDetailReport` (and through it
 * on `buildCustomDetailReportRequest` + `extractCustomDetailReportData` +
 * the simulation's `handleCustomDetailReportQuery`). That shared
 * infrastructure also unblocks Phase 11 #53 (general ledger), #58 (sales by
 * customer detail variants), and any other report tool that needs row-
 * level transaction detail with operator-selected columns.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";
import { ISO_DATE_RE } from "../util/validators.js";

// IncludeColumn list for the bank-rec read tools — kept consistent across
// qb_uncleared_transactions and qb_reconciliation_discrepancy so the row
// shape is uniform. ClearedStatus is the field that motivates using
// CustomDetailReport at all (no other QBXML path returns it).
const BANK_REC_INCLUDE_COLUMNS = [
  "TxnType",
  "Date",
  "Num",
  "Name",
  "Memo",
  "Amount",
  "ClearedStatus",
] as const;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const today = (): string => new Date().toISOString().slice(0, 10);
// Compute (today - daysBack) as YYYY-MM-DD via UTC arithmetic to avoid
// timezone drift around midnight.
const daysAgo = (days: number): string => {
  const ms = Date.UTC(
    Number(today().slice(0, 4)),
    Number(today().slice(5, 7)) - 1,
    Number(today().slice(8, 10)),
  ) - days * 86400000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

export function registerReconciliationTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_cleared_status_update",
    "Mark a bank/credit-card transaction as Cleared / NotCleared / Pending — the canonical bank-reconciliation primitive in the QBXML SDK (wraps ClearedStatusModRq). Targets one of the seven bank-affecting transaction types (Check, BillPaymentCheck, BillPaymentCreditCard, Deposit, Transfer, CreditCardCharge, CreditCardCredit); calling against any other transaction type (Invoice/Bill/JE/etc.) returns statusCode 3120 because their headers don't carry cleared status. Pass `txnId` for a whole-transaction update (the typical reconcile flow for a check or deposit); pass `txnId` + `txnLineId` to flip cleared status on a single split line of a multi-line transaction (e.g. one line of a multi-account Deposit). The mutation is naturally idempotent — flipping Cleared on an already-Cleared txn is a server-side no-op, so this tool does NOT accept an idempotencyKey arg (the cache wouldn't add value). A read-only session (qb_session_connect({readOnly: true})) rejects this call with statusCode 9001 before any envelope is built. Unknown txnId returns 500; invalid clearedStatus value returns 3120. WORKFLOW: while QB Desktop's reconciliation screen is open and showing the bank statement, use this tool to mark each matching txn Cleared in bulk through an agent — replaces clicking through every line by hand. Read side (which txns are uncleared) is a Phase 11 follow-up that requires CustomDetailReportQueryRq infrastructure; for now use the QB Desktop UI to discover uncleared txns and pass their TxnIDs here.",
    {
      txnId: z.string().min(1).describe("TxnID of the bank/CC transaction to update. From a prior qb_check_list / qb_bill_payment_list / etc., or from QB Desktop's reconciliation screen."),
      clearedStatus: z.enum(["Cleared", "NotCleared", "Pending"]).describe("New cleared status. Cleared = reconciled (matched against a statement line); NotCleared = open / not yet reconciled; Pending = downloaded but not finalized (typical for bank-feed flows)."),
      txnLineId: z.string().optional().describe("Optional TxnLineID — flip cleared status on a single split line within the transaction. Use for multi-line Deposits or Checks where only one split line cleared. Omit (default) to update the whole transaction's cleared status."),
    },
    async (args) => {
      const session = getSession();
      try {
        const result = await session.updateClearedStatus({
          txnId: args.txnId,
          clearedStatus: args.clearedStatus,
          txnLineId: args.txnLineId,
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              clearedStatus: args.clearedStatus,
              txnId: args.txnId,
              ...(args.txnLineId ? { txnLineId: args.txnLineId } : {}),
              result,
            }, null, 2),
          }],
        };
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? "ClearedStatusModRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // qb_uncleared_transactions (Phase 11 #56a) — read-side companion to
  // qb_cleared_status_update. Surfaces bank/CC transactions that have NOT
  // been marked Cleared, so the operator can pair this with a sequence of
  // qb_cleared_status_update calls during month-end close — replaces
  // walking QB Desktop's reconciliation screen by hand.
  //
  // Wraps CustomDetailReportQueryRq with ReportClearedStatusFilter set
  // server-side; same row shape as qb_reconciliation_discrepancy below.
  // -----------------------------------------------------------------------

  server.tool(
    "qb_uncleared_transactions",
    "List bank/CC transactions that have NOT been marked Cleared, scoped to a single bank or credit-card account. Wraps `CustomDetailReportQueryRq` (CustomTxnDetail) with `ReportClearedStatusFilter` set server-side, then formats the rows as an operator-friendly transaction list. Targets the seven bank-affecting transaction types (Check, BillPaymentCheck, BillPaymentCreditCard, Deposit, Transfer, CreditCardCharge, CreditCardCredit) — postings to non-bank accounts (Income/Expense/AR/AP) don't carry ClearedStatus and are not surfaced. Pass `accountName` (FullName, e.g. 'Checking') OR `accountListId`; one is required. Optional `asOfDate` (YYYY-MM-DD, defaults to today) caps the date window — txns dated after asOfDate are excluded so this can be used to reconstruct 'what was uncleared as of last month-end'. Optional `clearedStatusFilter`: `'UnclearedOnly'` (default — NotCleared + Pending), `'ClearedOnly'` (the inverse — useful for verification), `'All'` (everything for the account). The sign convention on `amount` matches QB's CustomTxnDetail: positive = increases the account's natural balance (Deposit, CreditCardCharge), negative = decreases it (Check, BillPaymentCheck, CreditCardCredit). Workflow: pair with `qb_cleared_status_update` — call this to discover what needs clearing, then call the update tool once per row that matches a statement line. Read-side; does NOT require a writable session.",
    {
      accountName: z.string().min(1).optional().describe("Bank or credit-card account FullName (e.g. 'Checking', 'Visa Card'). Resolved against the chart of accounts; case-sensitive. Either accountName or accountListId must be supplied."),
      accountListId: z.string().min(1).optional().describe("Bank or credit-card account ListID (alternative to accountName)."),
      asOfDate: z.string().regex(ISO_DATE_RE).optional().describe("Upper-bound transaction date (YYYY-MM-DD, inclusive). Defaults to today. Used as ToReportDate on the underlying report — transactions dated after this are excluded so historical 'what was uncleared as of date X' queries work."),
      clearedStatusFilter: z.enum(["UnclearedOnly", "ClearedOnly", "All"]).optional().describe("Defaults to 'UnclearedOnly' (NotCleared + Pending — the typical 'what needs clearing' query). 'ClearedOnly' returns the inverse (useful for verification); 'All' returns every bank-affecting txn for the account regardless of cleared state."),
      basis: z.enum(["Accrual", "Cash"]).optional().describe("Accounting basis. Defaults to Accrual. (Bank/CC postings are timing-driven, so the basis rarely matters for this report — it's wired through for parity with other report tools.)"),
    },
    async ({ accountName, accountListId, asOfDate, clearedStatusFilter, basis }) => {
      if (!accountName && !accountListId) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 3120,
              statusMessage: "Either accountName or accountListId is required",
              humanReadable: qbStatusCodeMessage(3120),
            }),
          }],
          isError: true,
        };
      }

      const session = getSession();
      const effectiveAsOf = asOfDate ?? today();
      const effectiveFilter = clearedStatusFilter ?? "UnclearedOnly";
      try {
        const reportRet = await session.runCustomDetailReport({
          reportType: "CustomTxnDetail",
          toDate: effectiveAsOf,
          account: {
            ...(accountListId ? { ListID: accountListId } : {}),
            ...(accountName ? { FullName: accountName } : {}),
          },
          clearedStatusFilter: effectiveFilter,
          basis: basis ?? "Accrual",
          includeColumns: [...BANK_REC_INCLUDE_COLUMNS],
        });

        const rows = (reportRet.Rows as Record<string, unknown>[] | undefined) ?? [];
        const transactions = rows.map((r) => formatRow(r));
        const totalAmount = round2(
          transactions.reduce((s, t) => s + (Number.isFinite(t.amount) ? t.amount : 0), 0),
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              account: accountName ?? accountListId,
              asOfDate: effectiveAsOf,
              clearedStatusFilter: effectiveFilter,
              count: transactions.length,
              totalAmount,
              transactions,
            }, null, 2),
          }],
        };
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? "qb_uncleared_transactions failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    },
  );

  // -----------------------------------------------------------------------
  // qb_reconciliation_discrepancy (Phase 11 #56) — surface signs that a
  // previously-completed reconciliation may have been broken. Single signal:
  // currently-Cleared bank/CC txns whose TimeModified falls in the
  // reconciliation-window — i.e. txns that WERE reconciled but have since
  // been changed (the classic signal for a "broken reconciliation" that
  // requires re-reconciling).
  //
  // Same CustomDetailReportQueryRq infrastructure as qb_uncleared_transactions
  // but with ReportClearedStatusFilter='ClearedOnly' + ReportModifiedDateRange
  // Filter set. The TimeModified field surfaces in the row when the report's
  // ColDesc includes a Modified column — the simulation always emits it,
  // live mode includes it when the IncludeColumn list pulls it (best-effort).
  //
  // NOT shipped here: postings to the QB-internal "Reconciliation
  // Discrepancies" expense account (the dump-account QB writes off
  // forced-reconcile deltas to). That signal is reachable today via
  // `qb_transaction_list_by_account` with `accountName: 'Reconciliation
  // Discrepancies'` — no new infrastructure needed. Calling out the
  // workflow in the tool description rather than baking it in here keeps
  // each tool single-purpose.
  // -----------------------------------------------------------------------

  server.tool(
    "qb_reconciliation_discrepancy",
    "Surface bank/CC transactions that were previously marked Cleared but have since been MODIFIED — the signal that a prior reconciliation may have been silently broken (someone changed a txn after it was matched against a bank statement). Wraps `CustomDetailReportQueryRq` with `ReportClearedStatusFilter='ClearedOnly'` + `ReportModifiedDateRangeFilter` set server-side. Pass `accountName` (FullName) OR `accountListId`; one is required. Optional `sinceDate` (YYYY-MM-DD) is the lower bound on the modification window — defaults to 30 days back. Optional `asOfDate` caps the transaction-date window the same way `qb_uncleared_transactions` does — defaults to today. The classic month-end-close use: at the start of close, set `sinceDate = <date of last completed reconciliation>` and review every row returned (each is a candidate for re-reconciling or backing out the change). Returns rows in the same shape as `qb_uncleared_transactions` plus a `timeModified` field where available. SEPARATE SIGNAL not surfaced here: postings to the QB-internal 'Reconciliation Discrepancies' expense account (the dump-account QB writes off forced-reconcile deltas to) — query that via `qb_transaction_list_by_account({ accountName: 'Reconciliation Discrepancies' })` directly, no special-case needed. Read-side; does NOT require a writable session.",
    {
      accountName: z.string().min(1).optional().describe("Bank or credit-card account FullName whose reconciliation history is being audited. Either accountName or accountListId must be supplied."),
      accountListId: z.string().min(1).optional().describe("Bank or credit-card account ListID (alternative to accountName)."),
      sinceDate: z.string().regex(ISO_DATE_RE).optional().describe("Lower bound on TimeModified (YYYY-MM-DD, inclusive). Defaults to 30 days ago. Set this to the date of the last completed reconciliation to scope the audit to changes made since then."),
      asOfDate: z.string().regex(ISO_DATE_RE).optional().describe("Upper bound on transaction date (YYYY-MM-DD, inclusive). Defaults to today. Mirrors qb_uncleared_transactions's parameter so historical-period audits are possible."),
      basis: z.enum(["Accrual", "Cash"]).optional().describe("Accounting basis. Defaults to Accrual."),
    },
    async ({ accountName, accountListId, sinceDate, asOfDate, basis }) => {
      if (!accountName && !accountListId) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 3120,
              statusMessage: "Either accountName or accountListId is required",
              humanReadable: qbStatusCodeMessage(3120),
            }),
          }],
          isError: true,
        };
      }

      const session = getSession();
      const effectiveSince = sinceDate ?? daysAgo(30);
      const effectiveAsOf = asOfDate ?? today();
      try {
        const reportRet = await session.runCustomDetailReport({
          reportType: "CustomTxnDetail",
          toDate: effectiveAsOf,
          account: {
            ...(accountListId ? { ListID: accountListId } : {}),
            ...(accountName ? { FullName: accountName } : {}),
          },
          clearedStatusFilter: "ClearedOnly",
          fromModifiedDate: effectiveSince,
          basis: basis ?? "Accrual",
          includeColumns: [...BANK_REC_INCLUDE_COLUMNS],
        });

        const rows = (reportRet.Rows as Record<string, unknown>[] | undefined) ?? [];
        const candidates = rows.map((r) => formatRow(r));

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              account: accountName ?? accountListId,
              sinceDate: effectiveSince,
              asOfDate: effectiveAsOf,
              count: candidates.length,
              note: candidates.length > 0
                ? "Each row is a currently-Cleared transaction that was modified after sinceDate. Review whether the change broke a prior reconciliation."
                : "No modified-after-cleared transactions found in this window.",
              candidates,
            }, null, 2),
          }],
        };
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? "qb_reconciliation_discrepancy failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    },
  );
}

// Operator-friendly camelCase shape for a single row from the report. Sim
// emits all 9 columns; live mode emits whatever the IncludeColumn list
// requested plus whatever ColDesc surfaces — TxnID / TimeModified surface
// when present, are simply absent from the response object when not.
function formatRow(row: Record<string, unknown>): {
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
    // Live's _rowType (set by adaptLiveCustomDetailReportRet from the
    // <DataRow @_rowType="..."> attribute) is the most authoritative TxnType
    // when the IncludeColumn list omits TxnType — fall back to it.
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
