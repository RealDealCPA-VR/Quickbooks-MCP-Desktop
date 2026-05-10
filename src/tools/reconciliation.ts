/**
 * Bank reconciliation tools (Phase 10 #46).
 *
 * The QBXML SDK's actual reconciliation surface is much narrower than the
 * QB Desktop UI suggests: there is NO `ReconcileQueryRq`, NO
 * `ReconcileDetail` GeneralDetailReportType, NO `LastReconciledDate` on
 * AccountRet (verified against qbxmlops130/140 schemas — the only mention
 * of `memorizedTxn` or `reconcil*` in the entire 2.7 MB schema is a deleted-
 * list rowType enum value). What IS exposed is `ClearedStatusModRq` — a
 * single-field mutation against a single transaction (or a split line)
 * that flips Cleared / NotCleared / Pending. That is the actual atomic
 * primitive bank reconciliation is built on; the UI just orchestrates a
 * sequence of these against open bank/CC transactions.
 *
 * This file ships ONE tool — the write primitive. The read side
 * (qb_uncleared_transactions) requires `CustomDetailReportQueryRq` with
 * `IncludeColumn=ClearedStatus` (the only QBXML path that returns cleared-
 * status data — it isn't a field on any *Ret element and isn't a filter on
 * any *QueryRq). That infrastructure lands in Phase 11 alongside #56
 * reconciliation-discrepancy reports, since they share the same custom-
 * report plumbing.
 *
 * Until then, the operator pairs the QB Desktop reconciliation screen
 * (visual: which items need clearing) with this MCP's
 * `qb_cleared_status_update` calls (bulk: mark them all in one agent
 * turn) — a clean division of labor that turns the slowest part of month-
 * end close (clicking through every transaction in the QB UI) into an
 * agent-friendly flow.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";

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
}
