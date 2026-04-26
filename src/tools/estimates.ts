/**
 * Estimate / Quote management tools for QuickBooks Desktop MCP.
 *
 * Real QB has no "convert estimate to invoice" RPC. The flow is two QBXML
 * calls glued together at the tool layer: read the source estimate's lines,
 * submit an InvoiceAddRq with the line set carried over, then optionally
 * mark the estimate IsAccepted=true. qb_estimate_convert_to_invoice
 * implements that flow as a single tool call so the operator doesn't have
 * to script it from invoice + estimate primitives.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";

const estimateLineSchema = z.object({
  itemName: z.string().optional().describe("Item name or full name"),
  itemListId: z.string().optional().describe("Item ListID"),
  description: z.string().optional().describe("Line description"),
  quantity: z.number().optional().describe("Quantity"),
  rate: z.number().optional().describe("Rate per unit"),
  amount: z.number().optional().describe("Line amount (overrides qty * rate)"),
});

// Mod variant — every field optional so a partial mod (e.g. just description
// on an existing line) doesn't force the operator to reconstruct the line.
// Mirrors invoiceLineModSchema in tools/invoices.ts.
const estimateLineModSchema = z
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
    { message: "New estimate lines (no txnLineID) require itemName/itemListId and either amount or (quantity + rate)" }
  );

export function registerEstimateTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_estimate_list",
    "List or search estimates/quotes in QuickBooks Desktop.",
    {
      customerName: z.string().optional().describe("Filter by customer name"),
      customerListId: z.string().optional().describe("Filter by customer ListID"),
      txnId: z.string().optional().describe("Fetch a specific estimate by TxnID"),
      refNumber: z.string().optional().describe("Filter by reference/estimate number"),
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

      const estimates = await session.queryEntity("Estimate", filters);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ count: estimates.length, estimates }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "qb_estimate_create",
    "Create a new estimate/quote in QuickBooks Desktop. Pass `lines` to populate line items (each line: itemName/itemListId + quantity/rate or explicit amount). Subtotal is derived from the line set server-side.",
    {
      customerName: z.string().optional().describe("Customer full name"),
      customerListId: z.string().optional().describe("Customer ListID"),
      txnDate: z.string().optional().describe("Estimate date (YYYY-MM-DD, default today)"),
      refNumber: z.string().optional().describe("Reference/estimate number"),
      memo: z.string().optional().describe("Memo"),
      lines: z.array(estimateLineSchema).optional()
        .describe("Estimate line items"),
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
        data.EstimateLineAdd = args.lines.map((line) => {
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

      const result = await session.addEntity("Estimate", data);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, estimate: result }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "qb_estimate_update",
    "Update an existing estimate/quote in QuickBooks Desktop. Pass txnId + editSequence (from a prior qb_estimate_list) plus any header fields and/or a replacement `lines` array. When `lines` is provided it REPLACES the estimate's existing line set wholesale — list every line you want the estimate to keep. A line with a txnLineID matching an existing line preserves that TxnLineID and merges any fields you pass over the existing values; a line without txnLineID (or with '-1') is added as new. Subtotal recomputes automatically. Estimates don't post to AR — there's no customer-balance side effect (unlike qb_invoice_update). A stale editSequence rejects with statusCode 3170.",
    {
      txnId: z.string().describe("TxnID of the estimate to update"),
      editSequence: z.string().describe("EditSequence from a prior query — must match the stored value or the mod is rejected with statusCode 3170"),
      customerName: z.string().optional().describe("New customer full name (re-points the estimate at a different customer)"),
      customerListId: z.string().optional().describe("New customer ListID"),
      txnDate: z.string().optional().describe("New estimate date"),
      refNumber: z.string().optional().describe("New reference number"),
      memo: z.string().optional().describe("New memo"),
      isAccepted: z.boolean().optional().describe("Mark the estimate accepted/rejected. Set true when an estimate has been converted to an invoice manually; qb_estimate_convert_to_invoice flips this automatically."),
      lines: z.array(estimateLineModSchema).optional()
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
      if (args.isAccepted !== undefined) data.IsAccepted = args.isAccepted;

      if (args.lines) {
        data.EstimateLineMod = args.lines.map((line) => {
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
        const result = await session.modifyEntity("Estimate", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, estimate: result }, null, 2),
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
    "qb_estimate_delete",
    "Delete an estimate/quote from QuickBooks Desktop. Estimates aren't posted to AR so there's no balance to reverse — this is purely a record removal. WARNING: Irreversible.",
    {
      txnId: z.string().describe("TxnID of the estimate to delete"),
    },
    async ({ txnId }) => {
      const session = getSession();
      try {
        const result = await session.deleteEntity("Estimate", txnId);
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

  server.tool(
    "qb_estimate_convert_to_invoice",
    "Convert an estimate/quote to an invoice in QuickBooks Desktop. Real QB has no single 'convert' RPC — this tool reads the source estimate, submits an InvoiceAddRq with CustomerRef + EstimateLineRet carried over (each line mapped to InvoiceLineAdd), and (by default) marks the source estimate IsAccepted=true. Carries CustomerRef plus optional ClassRef / TermsRef / SalesRepRef / PORefNumber from the estimate header onto the invoice when present. Operator-supplied invoiceTxnDate / invoiceDueDate / invoiceRefNumber / invoiceMemo override the carried values. The mark-accepted step runs AFTER the invoice is successfully created; if the markAccepted flip fails (e.g. concurrent estimate edit), the invoice still exists and the response surfaces the partial state. Pass markAccepted: false to leave the estimate unmarked (e.g. for partial conversions).",
    {
      estimateTxnId: z.string().describe("TxnID of the source estimate"),
      markAccepted: z.boolean().optional()
        .describe("Mark the source estimate IsAccepted=true after the invoice is created. Default true."),
      invoiceTxnDate: z.string().optional()
        .describe("Date for the new invoice (YYYY-MM-DD). Default: today."),
      invoiceDueDate: z.string().optional()
        .describe("Due date for the new invoice (YYYY-MM-DD)."),
      invoiceRefNumber: z.string().optional()
        .describe("Reference number for the new invoice. Default: estimate's RefNumber if present."),
      invoiceMemo: z.string().optional()
        .describe("Memo for the new invoice. Default: 'Converted from estimate <ref>'."),
    },
    async (args) => {
      const session = getSession();

      const matches = await session.queryEntity("Estimate", { TxnID: args.estimateTxnId });
      const estimate = matches[0];
      if (!estimate) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: `Estimate "${args.estimateTxnId}" not found`,
            }),
          }],
          isError: true,
        };
      }

      const customerRef = estimate.CustomerRef as Record<string, unknown> | undefined;
      if (!customerRef) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: `Estimate "${args.estimateTxnId}" has no CustomerRef and cannot be converted`,
            }),
          }],
          isError: true,
        };
      }

      const estimateLines = Array.isArray(estimate.EstimateLineRet)
        ? (estimate.EstimateLineRet as Record<string, unknown>[])
        : estimate.EstimateLineRet
          ? [estimate.EstimateLineRet as Record<string, unknown>]
          : [];

      const invoiceData: Record<string, unknown> = {
        CustomerRef: customerRef,
      };

      // Carry-over header fields when present on the estimate. Operator
      // overrides win (handled below). Real QB estimates can carry
      // ClassRef / TermsRef / SalesRepRef / PORefNumber on the header — we
      // don't accept these on qb_estimate_create yet, but they could be
      // present on estimates loaded from a live QB file.
      const carryFields = ["ClassRef", "TermsRef", "SalesRepRef", "PORefNumber"] as const;
      for (const field of carryFields) {
        if (estimate[field] !== undefined) {
          invoiceData[field] = estimate[field];
        }
      }

      const refNumber = args.invoiceRefNumber
        ?? (estimate.RefNumber !== undefined ? String(estimate.RefNumber) : undefined);
      if (refNumber) invoiceData.RefNumber = refNumber;

      if (args.invoiceTxnDate) {
        invoiceData.TxnDate = args.invoiceTxnDate;
      }
      if (args.invoiceDueDate) invoiceData.DueDate = args.invoiceDueDate;

      const sourceLabel = estimate.RefNumber
        ? String(estimate.RefNumber)
        : String(estimate.TxnID ?? args.estimateTxnId);
      invoiceData.Memo = args.invoiceMemo ?? `Converted from estimate ${sourceLabel}`;

      // Map EstimateLineRet → InvoiceLineAdd. TxnLineID is a return-side
      // identifier and is intentionally NOT carried — the new invoice
      // generates its own line IDs. ClassRef on the line carries when present.
      if (estimateLines.length > 0) {
        invoiceData.InvoiceLineAdd = estimateLines.map((line) => {
          const lineData: Record<string, unknown> = {};
          if (line.ItemRef) lineData.ItemRef = line.ItemRef;
          if (line.Desc !== undefined) lineData.Desc = line.Desc;
          if (line.Quantity !== undefined) lineData.Quantity = line.Quantity;
          if (line.Rate !== undefined) lineData.Rate = line.Rate;
          if (line.Amount !== undefined) lineData.Amount = line.Amount;
          if (line.ClassRef) lineData.ClassRef = line.ClassRef;
          return lineData;
        });
      }

      let invoice: Record<string, unknown>;
      try {
        invoice = await session.addEntity("Invoice", invoiceData);
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

      // Mark accepted AFTER successful invoice creation (default behavior).
      // If markAccepted=false, leave the estimate untouched (operator may be
      // doing a partial conversion and wants to convert again later).
      const shouldMarkAccepted = args.markAccepted !== false;
      let estimateMarked = false;
      let markError: { message: string; statusCode?: number } | null = null;

      if (shouldMarkAccepted) {
        try {
          await session.modifyEntity("Estimate", {
            TxnID: args.estimateTxnId,
            EditSequence: estimate.EditSequence,
            IsAccepted: true,
          });
          estimateMarked = true;
        } catch (err) {
          // The invoice was created successfully — surface the partial state
          // rather than losing it. The operator can re-mark via qb_estimate_update.
          const message = err instanceof Error ? err.message : String(err);
          const statusCode = (err as { statusCode?: number })?.statusCode;
          markError = { message, statusCode };
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            invoice,
            estimateMarkedAccepted: estimateMarked,
            ...(markError ? { markAcceptedError: markError } : {}),
          }, null, 2),
        }],
      };
    }
  );
}
