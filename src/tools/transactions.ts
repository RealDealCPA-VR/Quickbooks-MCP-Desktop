/**
 * Cross-type transaction tools (Phase 10 #40+).
 *
 * `qb_transaction_list_by_account` is the QBXML SDK's TransactionQueryRq —
 * unlike per-type list tools (qb_invoice_list, qb_bill_list, …), one call
 * returns postings from any transaction shape (Invoice, Bill, Check,
 * JournalEntry, ReceivePayment, …) filtered primarily by AccountFilter.
 * That's the foundation for "what hit this account" workflows the operator
 * cannot reconstruct from per-type lists without N round trips.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";
import { ISO_DATE_RE } from "../util/validators.js";

export function registerTransactionTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_transaction_list_by_account",
    "List every posting (line-level) that hit a specific GL account, optionally bounded by date. Returns rows sorted by TxnDate ascending with a running balance computed in the tool layer (TransactionQueryRq does NOT compute running balance server-side). Sign convention: positive Amount = increases the target account's natural balance (e.g. a $500 bill posts +500 to Rent Expense; a customer refund posts -500 to Sales Revenue). Pass either accountName (FullName) or accountListId — at least one is required.",
    {
      accountName: z.string().optional()
        .describe("Account FullName (e.g. 'Rent Expense'). Either this or accountListId is required."),
      accountListId: z.string().optional()
        .describe("Account ListID. Either this or accountName is required."),
      fromDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("Start of the date window (YYYY-MM-DD, inclusive). Omit for all-time."),
      toDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("End of the date window (YYYY-MM-DD, inclusive). Omit for through-current."),
      maxReturned: z.number().optional()
        .describe("Maximum rows. Defaults to QB's per-batch cap (~500) if unset."),
      includeRunningBalance: z.boolean().optional()
        .describe("Compute per-row RunningBalance from currentBalance backwards (default true). Set false to skip the AccountQueryRq round trip when only the row list is needed."),
    },
    async (args) => {
      const session = getSession();

      if (!args.accountName && !args.accountListId) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "Either accountName or accountListId is required",
            }),
          }],
          isError: true,
        };
      }

      // TransactionQueryRq schema-required child order (QBXML 16.0 SDK):
      //   TxnID? → MaxReturned? → ModifiedDateRangeFilter? → TxnDateRangeFilter?
      //   → EntityFilter? → AccountFilter → RefNumberFilter? →
      //   TransactionTypeFilter? → PostedFilter? → DetailLevel?
      // Out-of-order children fall through the same statusCode -1 "found an
      // error when parsing" trap that bit qb_pnl_report on 2026-05-09. Pinned
      // for this query in tests/builder-emit-order.test.ts.
      const filters: Record<string, unknown> = {};
      if (args.maxReturned) filters.MaxReturned = args.maxReturned;
      if (args.fromDate || args.toDate) {
        filters.TxnDateRangeFilter = {
          FromTxnDate: args.fromDate,
          ToTxnDate: args.toDate,
        };
      }
      if (args.accountListId) {
        filters.AccountFilter = { ListID: args.accountListId };
      } else {
        filters.AccountFilter = { FullName: args.accountName };
      }

      try {
        const rows = await session.queryTransactions(filters);

        // Stable chronological sort (sim does this; live's response order is
        // QB-driven and not guaranteed). TimeCreated tiebreaker keeps same-
        // date rows in insertion order so running balance walks deterministically.
        const sorted = [...rows].sort((a, b) => {
          const ad = String(a.TxnDate ?? "");
          const bd = String(b.TxnDate ?? "");
          if (ad !== bd) return ad < bd ? -1 : 1;
          const at = String(a.TimeCreated ?? "");
          const bt = String(b.TimeCreated ?? "");
          return at < bt ? -1 : at > bt ? 1 : 0;
        });

        // Running balance — computed in this handler because TransactionQueryRq
        // does NOT return a running balance (real QB only computes running
        // balance for ReportQueryRq's TransactionDetail report). Algorithm
        // (per Phase 10 #40 HANDOFF math):
        //   1. Pull the account's CURRENT balance (Account.Balance) via a
        //      separate AccountQueryRq.
        //   2. Sum the period-window posting amounts from the rows we just
        //      received.
        //   3. openingBalance = currentBalance − periodSum.
        //   4. Walk forward per row; runningBalance += row.Amount.
        // This is exact when toDate ≥ now (the typical case). When toDate is
        // historical AND postings exist after toDate, openingBalance is
        // overstated by those after-period postings — documented limitation
        // (the alternative, fetching the full history, costs a wider round
        // trip). To avoid the approximation, omit toDate.
        let openingBalance: number | null = null;
        let currentBalance: number | null = null;
        let runningBalanceErr: string | null = null;

        if (args.includeRunningBalance !== false) {
          try {
            const targetName = args.accountName;
            const targetListId = args.accountListId;
            const accountFilter: Record<string, unknown> = targetListId
              ? { ListID: targetListId }
              : { FullName: targetName };
            const accountResults = await session.queryEntity("Account", accountFilter);
            if (accountResults.length === 0) {
              runningBalanceErr =
                "Account not found — cannot compute running balance";
            } else {
              const acct = accountResults[0];
              currentBalance = Number(acct.Balance ?? 0);
              if (!Number.isFinite(currentBalance)) currentBalance = 0;
              const periodSum = sorted.reduce(
                (s, r) => s + Number(r.Amount ?? 0),
                0
              );
              openingBalance =
                Math.round((currentBalance - periodSum) * 100) / 100;
              let running = openingBalance;
              for (const row of sorted) {
                running += Number(row.Amount ?? 0);
                row.RunningBalance = Math.round(running * 100) / 100;
              }
            }
          } catch (err) {
            runningBalanceErr = `Running-balance computation failed: ${(err as Error).message}`;
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              count: sorted.length,
              account: args.accountName ?? args.accountListId,
              fromDate: args.fromDate ?? null,
              toDate: args.toDate ?? null,
              ...(currentBalance !== null ? { currentBalance } : {}),
              ...(openingBalance !== null ? { openingBalance } : {}),
              ...(runningBalanceErr ? { runningBalanceError: runningBalanceErr } : {}),
              transactions: sorted,
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
              statusMessage: e.message ?? "TransactionQueryRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
