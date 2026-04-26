/**
 * CreditMemo management tools for QuickBooks Desktop MCP.
 *
 * A CreditMemo is the AR negative — same line shape as Invoice, but the total
 * credits the customer instead of billing them. On creation it posts a NEGATIVE
 * delta to Customer.Balance (reduces what they owe). When applied to one or
 * more open invoices via AppliedToTxnAdd / AppliedToTxnMod, each application
 * closes part or all of the named invoice's BalanceRemaining and the customer
 * balance moves by the applied portion only — unapplied credit sits on the
 * memo as RemainingValue (= TotalAmount − AppliedAmount), available to apply
 * later via qb_credit_memo_apply (the ReceivePayment-style re-application
 * path).
 *
 * Cash-sale / non-AR transactions like SalesReceipt do NOT post here — that
 * lives in src/tools/sales-receipts.ts. CreditMemo's distinguishing feature
 * is the AR-negative posting + the application path.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";

const creditMemoLineSchema = z.object({
  itemName: z.string().optional().describe("Item name or full name"),
  itemListId: z.string().optional().describe("Item ListID"),
  description: z.string().optional().describe("Line description"),
  quantity: z.number().optional().describe("Quantity"),
  rate: z.number().optional().describe("Rate per unit"),
  amount: z.number().optional().describe("Line amount (overrides qty * rate)"),
});

// Mod variant — every field optional so a partial mod (e.g. just description
// on an existing line) doesn't force the operator to reconstruct the line.
// New lines (no txnLineID, or txnLineID === '-1') still require itemName/
// itemListId AND a way to derive Amount (explicit amount, or quantity + rate)
// — enforced by per-line refinement below. Mirrors invoiceLineModSchema /
// salesReceiptLineModSchema.
const creditMemoLineModSchema = z
  .object({
    txnLineID: z.string().optional()
      .describe("TxnLineID of the existing line to modify; omit (or pass '-1') to add a new line"),
    itemName: z.string().optional().describe("Item full name"),
    itemListId: z.string().optional().describe("Item ListID"),
    description: z.string().optional().describe("Line description"),
    quantity: z.number().optional().describe("Quantity — paired with rate to derive Amount"),
    rate: z.number().optional().describe("Rate per unit — paired with quantity to derive Amount"),
    amount: z.number().optional().describe("Line amount (overrides qty * rate)"),
  })
  .refine(
    (line) => {
      const isNew = !line.txnLineID || line.txnLineID === "-1";
      if (!isNew) return true;
      const hasItem = Boolean(line.itemName || line.itemListId);
      const hasAmountSource =
        line.amount !== undefined ||
        (line.quantity !== undefined && line.rate !== undefined);
      return hasItem && hasAmountSource;
    },
    { message: "New credit memo lines (no txnLineID) require itemName/itemListId and either amount or (quantity + rate)" }
  );

// AppliedTo schema — same shape used by qb_credit_memo_create (AppliedToTxnAdd
// for create-time auto-apply) and qb_credit_memo_apply (AppliedToTxnMod for
// re-targeting). PaymentAmount in QBXML is the term for the credit chunk
// going against this invoice; we expose it as `amount` on the tool API
// (matches qb_payment_receive's appliedTo shape exactly).
const appliedToSchema = z.object({
  txnId: z.string().describe("TxnID of the invoice to apply this credit chunk against"),
  amount: z.number().describe("Credit amount to apply against the invoice (closes part or all of its BalanceRemaining)"),
});

export function registerCreditMemoTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_credit_memo_list",
    "List or search credit memos in QuickBooks Desktop. Each row carries TotalAmount (the credit's face value), AppliedAmount (the portion already applied to invoices), and RemainingValue = TotalAmount − AppliedAmount (the unapplied credit available to apply via qb_credit_memo_apply).",
    {
      customerName: z.string().optional().describe("Filter by customer name"),
      customerListId: z.string().optional().describe("Filter by customer ListID"),
      txnId: z.string().optional().describe("Fetch a specific credit memo by TxnID"),
      refNumber: z.string().optional().describe("Filter by reference/credit memo number"),
      fromDate: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      toDate: z.string().optional().describe("End date (YYYY-MM-DD)"),
      maxReturned: z.number().optional().describe("Maximum results"),
    },
    async (args) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      if (args.txnId) filters.TxnID = args.txnId;
      if (args.refNumber) filters.RefNumber = args.refNumber;
      if (args.customerListId) {
        filters.EntityFilter = { ListID: args.customerListId };
      } else if (args.customerName) {
        filters.EntityFilter = { FullName: args.customerName };
      }
      if (args.fromDate || args.toDate) {
        filters.TxnDateRangeFilter = {
          FromTxnDate: args.fromDate,
          ToTxnDate: args.toDate,
        };
      }
      if (args.maxReturned) filters.MaxReturned = args.maxReturned;

      const creditMemos = await session.queryEntity("CreditMemo", filters);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ count: creditMemos.length, creditMemos }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "qb_credit_memo_create",
    "Create a credit memo (AR-negative) in QuickBooks Desktop. Same line shape as qb_invoice_create. The simulation derives Subtotal from the line set and TotalAmount = Subtotal + SalesTaxTotal. On creation the customer's Balance moves by −TotalAmount (the credit reduces what they owe); RemainingValue starts at TotalAmount. Optionally pass appliedTo: [{txnId, amount}] to immediately apply part or all of the credit against open invoices — each application closes the named invoice's BalanceRemaining by `amount` and the customer balance moves by the applied portion only. sum(appliedTo.amount) must be ≤ TotalAmount; an unknown invoice TxnID rejects the whole create atomically.",
    {
      customerName: z.string().optional().describe("Customer full name"),
      customerListId: z.string().optional().describe("Customer ListID"),
      txnDate: z.string().optional().describe("Credit memo date (YYYY-MM-DD, default today)"),
      refNumber: z.string().optional().describe("Reference/credit memo number"),
      memo: z.string().optional().describe("Memo"),
      lines: z.array(creditMemoLineSchema).optional()
        .describe("Credit memo line items"),
      appliedTo: z.array(appliedToSchema).optional()
        .describe("Optional invoice applications — each entry closes part or all of an invoice's BalanceRemaining at create time. sum(amount) must be ≤ TotalAmount; the difference becomes RemainingValue (unapplied credit)."),
    },
    async (args) => {
      const session = getSession();

      if (!args.customerName && !args.customerListId) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "Either customerName or customerListId is required",
            }),
          }],
          isError: true,
        };
      }

      // Pre-flight overapplication guard at the tool layer — same shape as
      // qb_payment_receive. The simulation re-validates inside applyCreditMemo
      // (the authoritative gate, since TotalAmount is line-derived and not
      // visible here at create time when only `lines` is passed). But we can
      // catch a class of bad calls early when sum(appliedTo) is implausibly
      // large — left to the simulation gate which has the derived TotalAmount.

      const data: Record<string, unknown> = {};
      if (args.customerListId) {
        data.CustomerRef = { ListID: args.customerListId };
      } else {
        data.CustomerRef = { FullName: args.customerName };
      }
      if (args.txnDate) data.TxnDate = args.txnDate;
      if (args.refNumber) data.RefNumber = args.refNumber;
      if (args.memo) data.Memo = args.memo;

      if (args.lines && args.lines.length > 0) {
        data.CreditMemoLineAdd = args.lines.map((line) => {
          const lineData: Record<string, unknown> = {};
          if (line.itemListId) {
            lineData.ItemRef = { ListID: line.itemListId };
          } else if (line.itemName) {
            lineData.ItemRef = { FullName: line.itemName };
          }
          if (line.description) lineData.Desc = line.description;
          if (line.quantity !== undefined) lineData.Quantity = line.quantity;
          if (line.rate !== undefined) lineData.Rate = line.rate;
          if (line.amount !== undefined) lineData.Amount = line.amount;
          return lineData;
        });
      }

      if (args.appliedTo && args.appliedTo.length > 0) {
        data.AppliedToTxnAdd = args.appliedTo.map((line) => ({
          TxnID: line.txnId,
          PaymentAmount: line.amount,
        }));
      }

      try {
        const result = await session.addEntity("CreditMemo", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, creditMemo: result }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const statusCode = (err as { statusCode?: number })?.statusCode;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: false, error: message, statusCode }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_credit_memo_update",
    "Update an existing credit memo. Pass txnId + editSequence (from a prior qb_credit_memo_list) plus any header fields and/or a replacement `lines` array. When `lines` is provided it REPLACES the memo's existing line set wholesale — list every line you want kept. A line with a txnLineID matching an existing line preserves that TxnLineID and merges any fields you pass over the existing values; a line without txnLineID (or with '-1') is added as new. Subtotal + TotalAmount recompute automatically and the customer balance adjusts by the change in TotalAmount (memo grew → customer balance drops further; memo shrank → customer balance recovers). To re-apply the credit to a different set of invoices, use qb_credit_memo_apply instead — this tool does NOT touch AppliedToTxn. A stale editSequence rejects with statusCode 3170.",
    {
      txnId: z.string().describe("TxnID of the credit memo to update"),
      editSequence: z.string().describe("EditSequence from a prior query — must match the stored value or the mod is rejected with statusCode 3170"),
      customerName: z.string().optional().describe("New customer full name (re-points the memo at a different customer)"),
      customerListId: z.string().optional().describe("New customer ListID"),
      txnDate: z.string().optional().describe("New credit memo date"),
      refNumber: z.string().optional().describe("New reference number"),
      memo: z.string().optional().describe("New memo"),
      lines: z.array(creditMemoLineModSchema).optional()
        .describe("Replacement line set. Existing lines whose TxnLineID is not listed will be dropped."),
    },
    async (args) => {
      const session = getSession();
      const data: Record<string, unknown> = {
        TxnID: args.txnId,
        EditSequence: args.editSequence,
      };

      if (args.customerListId) {
        data.CustomerRef = { ListID: args.customerListId };
      } else if (args.customerName) {
        data.CustomerRef = { FullName: args.customerName };
      }
      if (args.txnDate) data.TxnDate = args.txnDate;
      if (args.refNumber) data.RefNumber = args.refNumber;
      if (args.memo) data.Memo = args.memo;

      if (args.lines) {
        data.CreditMemoLineMod = args.lines.map((line) => {
          const lineData: Record<string, unknown> = {};
          if (line.txnLineID) lineData.TxnLineID = line.txnLineID;
          if (line.itemListId) {
            lineData.ItemRef = { ListID: line.itemListId };
          } else if (line.itemName) {
            lineData.ItemRef = { FullName: line.itemName };
          }
          if (line.description) lineData.Desc = line.description;
          if (line.quantity !== undefined) lineData.Quantity = line.quantity;
          if (line.rate !== undefined) lineData.Rate = line.rate;
          if (line.amount !== undefined) lineData.Amount = line.amount;
          return lineData;
        });
      }

      try {
        const result = await session.modifyEntity("CreditMemo", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, creditMemo: result }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const statusCode = (err as { statusCode?: number })?.statusCode;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: false, error: message, statusCode }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_credit_memo_apply",
    "Re-apply an existing credit memo to a different set of invoices via CreditMemoMod + AppliedToTxnMod. Pass txnId + editSequence (from a prior qb_credit_memo_list) plus a replacement applyTo array. The new array REPLACES the memo's prior application wholesale: previously-applied invoices are reversed (their BalanceRemaining is restored) and the new invoices receive the new application atomically (validate-first, then mutate). Customer balance moves by the change in applied sum (new applied − old applied). Pass applyTo: [] to fully unapply the credit (RemainingValue becomes TotalAmount). sum(applyTo.amount) > TotalAmount rejects with statusCode 500. TotalAmount is immutable on this path — to change the credit's face value, use qb_credit_memo_update with new lines (which adjusts both TotalAmount and the customer balance). A stale editSequence rejects with statusCode 3170.",
    {
      txnId: z.string().describe("TxnID of the credit memo to re-apply"),
      editSequence: z.string().describe("EditSequence from a prior qb_credit_memo_list — must match or the mod is rejected with statusCode 3170"),
      applyTo: z.array(appliedToSchema)
        .describe("Replacement application set. Pass an empty array to fully unapply the credit (it becomes pure customer credit again)."),
    },
    async (args) => {
      const session = getSession();

      const data: Record<string, unknown> = {
        TxnID: args.txnId,
        EditSequence: args.editSequence,
        AppliedToTxnMod: args.applyTo.map((line) => ({
          TxnID: line.txnId,
          PaymentAmount: line.amount,
        })),
      };

      try {
        const result = await session.modifyEntity("CreditMemo", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, creditMemo: result }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const statusCode = (err as { statusCode?: number })?.statusCode;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: false, error: message, statusCode }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_credit_memo_delete",
    "Delete a credit memo. Reverses the AR posting: customer Balance moves by +TotalAmount and any applied invoices have their BalanceRemaining restored by the previously-applied amount. WARNING: Irreversible.",
    {
      txnId: z.string().describe("TxnID of the credit memo to delete"),
    },
    async ({ txnId }) => {
      const session = getSession();
      try {
        const result = await session.deleteEntity("CreditMemo", txnId);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, deleted: result }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const statusCode = (err as { statusCode?: number })?.statusCode;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: false, error: message, statusCode }),
          }],
          isError: true,
        };
      }
    }
  );
}
