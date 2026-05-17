/**
 * Transfer (banking) management tools for QuickBooks Desktop MCP.
 *
 * Phase 17 #75 — banking primitives. A Transfer moves funds from one balance-
 * sheet account (TransferFromAccountRef) to another (TransferToAccountRef) in
 * one atomic posting. Used for moving cash between bank accounts, moving cash
 * from a bank to a credit-card account (to pay down the card directly without
 * the bill-payment flow), or owner draws/contributions between equity and a
 * bank account.
 *
 * Transfer has NO line set — both the debit and credit posting are implied by
 * the From/To refs + a single Amount. The two refs MUST be different accounts
 * (real QB rejects a self-transfer with statusCode 3120).
 *
 * Scope clarification (#75): TransferInventoryAddRq (Enterprise-only inventory-
 * site transfer) is intentionally NOT exposed by this tool. Inventory site
 * transfers belong under the inventory-adjustments surface (Phase 17 #80).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";
import { formatToolError } from "../util/format-tool-error.js";
import { ISO_DATE_RE } from "../util/validators.js";

export function registerTransferTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_transfer_list",
    "List or search Transfer transactions in QuickBooks Desktop. Each Transfer moves funds from one balance-sheet account to another (Bank-to-Bank, Bank-to-CreditCard, Equity-to-Bank, etc.) — no line set, just From/To/Amount. Set paginate:true for iterator-based pagination — maxReturned defaults to 500 when paginate is enabled.",
    {
      txnId: z.string().optional().describe("Fetch a specific transfer by TxnID"),
      fromDate: z.string().regex(ISO_DATE_RE).optional().describe("Start date filter (YYYY-MM-DD)"),
      toDate: z.string().regex(ISO_DATE_RE).optional().describe("End date filter (YYYY-MM-DD)"),
      maxReturned: z.number().optional().describe("Maximum results. Defaults to 500 when paginate is enabled."),
      paginate: z.boolean().optional().describe("Enable iterator-based pagination. Response surfaces iteratorRemainingCount + iteratorID. Auto-defaults maxReturned to 500 if unset."),
      iteratorID: z.string().optional().describe("Continue an existing iterator by passing the iteratorID from a prior paginated response. Implies paginate."),
    },
    async (args) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      const effectiveMaxReturned =
        args.maxReturned ?? (args.paginate || args.iteratorID ? 500 : undefined);

      if (args.txnId) filters.TxnID = args.txnId;
      if (effectiveMaxReturned) filters.MaxReturned = effectiveMaxReturned;
      if (args.fromDate || args.toDate) {
        filters.TxnDateRangeFilter = { FromTxnDate: args.fromDate, ToTxnDate: args.toDate };
      }

      try {
        if (args.paginate || args.iteratorID) {
          const result = await session.queryEntityPaginated("Transfer", filters, {
            iterator: args.iteratorID ? "Continue" : "Start",
            iteratorID: args.iteratorID,
          });
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                count: result.entities.length,
                transfers: result.entities,
                ...(result.iteratorRemainingCount !== undefined
                  ? { iteratorRemainingCount: result.iteratorRemainingCount }
                  : {}),
                ...(result.iteratorID !== undefined
                  ? { iteratorID: result.iteratorID }
                  : {}),
              }, null, 2),
            }],
          };
        }

        const transfers = await session.queryEntity("Transfer", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: transfers.length, transfers }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "TransferQueryRq failed" });
      }
    }
  );

  server.tool(
    "qb_transfer_create",
    "Create a new Transfer in QuickBooks Desktop. Moves `amount` from fromAccount to toAccount in one atomic posting. Both accounts must be balance-sheet accounts (Bank / CreditCard / OtherCurrentAsset / OtherCurrentLiability / LongTermLiability / FixedAsset / Equity) and must be different — a self-transfer rejects with statusCode 3120. The transfer posts NotCleared on the bank/CC side; flip via qb_cleared_status_update. Read-only sessions reject with statusCode 9001.",
    {
      fromAccountName: z.string().optional().describe("Source account full name (where the funds leave)"),
      fromAccountListId: z.string().optional().describe("Source account ListID (alternative to fromAccountName)"),
      toAccountName: z.string().optional().describe("Destination account full name (where the funds arrive)"),
      toAccountListId: z.string().optional().describe("Destination account ListID (alternative to toAccountName)"),
      amount: z.number().positive().describe("Transfer amount in dollars (must be positive — direction is encoded by the From/To refs, not by amount sign)"),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("Transfer date (YYYY-MM-DD). Default: today."),
      memo: z.string().optional().describe("Memo on the transfer"),
      className: z.string().optional().describe("Class full name (optional, for class tracking)"),
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original result without creating a duplicate transfer (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002."),
    },
    async (args) => {
      const session = getSession();

      if (!args.fromAccountName && !args.fromAccountListId) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "Either fromAccountName or fromAccountListId is required",
            }),
          }],
          isError: true,
        };
      }
      if (!args.toAccountName && !args.toAccountListId) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "Either toAccountName or toAccountListId is required",
            }),
          }],
          isError: true,
        };
      }

      // Same-account guard — real QB returns statusCode 3120 for a self-transfer;
      // catching it at the tool layer surfaces a clearer message before any
      // wire I/O. Compares both the ListID and FullName forms because the
      // operator might supply one form for From and the other for To.
      const sameById =
        args.fromAccountListId !== undefined &&
        args.toAccountListId !== undefined &&
        args.fromAccountListId === args.toAccountListId;
      const sameByName =
        args.fromAccountName !== undefined &&
        args.toAccountName !== undefined &&
        args.fromAccountName === args.toAccountName;
      if (sameById || sameByName) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 3120,
              statusMessage: "Transfer source and destination accounts must be different",
              humanReadable: qbStatusCodeMessage(3120),
            }),
          }],
          isError: true,
        };
      }

      const data: Record<string, unknown> = {};
      if (args.txnDate) data.TxnDate = args.txnDate;
      if (args.fromAccountListId) {
        data.TransferFromAccountRef = { ListID: args.fromAccountListId };
      } else {
        data.TransferFromAccountRef = { FullName: args.fromAccountName };
      }
      if (args.toAccountListId) {
        data.TransferToAccountRef = { ListID: args.toAccountListId };
      } else {
        data.TransferToAccountRef = { FullName: args.toAccountName };
      }
      if (args.className) data.ClassRef = { FullName: args.className };
      data.Amount = args.amount;
      if (args.memo) data.Memo = args.memo;

      try {
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent("Transfer", data, args.idempotencyKey)
          : { entity: await session.addEntity("Transfer", data), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              transfer: result,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "TransferAddRq failed" });
      }
    }
  );

  server.tool(
    "qb_transfer_update",
    "Modify an existing Transfer in QuickBooks Desktop. Pass txnId + editSequence (from a prior qb_transfer_list) plus any header fields to change. No line set — header-only updates. A stale editSequence rejects with statusCode 3170.",
    {
      txnId: z.string().describe("TxnID of the transfer to update"),
      editSequence: z.string().describe("EditSequence from a prior query — must match the stored value or the mod is rejected with statusCode 3170"),
      fromAccountName: z.string().optional().describe("New source account full name"),
      fromAccountListId: z.string().optional().describe("New source account ListID"),
      toAccountName: z.string().optional().describe("New destination account full name"),
      toAccountListId: z.string().optional().describe("New destination account ListID"),
      amount: z.number().positive().optional().describe("New transfer amount (must be positive)"),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("New transfer date (YYYY-MM-DD)"),
      memo: z.string().optional().describe("New memo"),
      className: z.string().optional().describe("New class full name"),
    },
    async (args) => {
      const session = getSession();

      const data: Record<string, unknown> = {
        TxnID: args.txnId,
        EditSequence: args.editSequence,
      };

      if (args.txnDate) data.TxnDate = args.txnDate;
      if (args.fromAccountListId) {
        data.TransferFromAccountRef = { ListID: args.fromAccountListId };
      } else if (args.fromAccountName) {
        data.TransferFromAccountRef = { FullName: args.fromAccountName };
      }
      if (args.toAccountListId) {
        data.TransferToAccountRef = { ListID: args.toAccountListId };
      } else if (args.toAccountName) {
        data.TransferToAccountRef = { FullName: args.toAccountName };
      }
      if (args.className) data.ClassRef = { FullName: args.className };
      if (args.amount !== undefined) data.Amount = args.amount;
      if (args.memo) data.Memo = args.memo;

      try {
        const result = await session.modifyEntity("Transfer", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, transfer: result }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "TransferModRq failed" });
      }
    }
  );

  server.tool(
    "qb_transfer_delete",
    "Delete a Transfer from QuickBooks Desktop. WARNING: Irreversible. Both sides of the posting are reversed atomically.",
    {
      txnId: z.string().describe("TxnID of the transfer to delete"),
    },
    async ({ txnId }) => {
      const session = getSession();
      try {
        const result = await session.deleteEntity("Transfer", txnId);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, deleted: result }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "TxnDelRq (Transfer) failed" });
      }
    }
  );
}
