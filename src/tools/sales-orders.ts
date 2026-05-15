/**
 * SalesOrder management tools for QuickBooks Desktop MCP.
 *
 * Phase 17 #76 — sales orders. A SalesOrder is the customer-side analog of
 * a PurchaseOrder: a committed-but-not-yet-invoiced order. Real QB tracks
 * fulfillment via line-level IsFullyInvoiced flags + header-level
 * IsManuallyClosed; this server's first cut surfaces IsManuallyClosed on
 * create + update (matches PurchaseOrder's surface) and leaves
 * IsFullyInvoiced as a return-only field (real QB derives it server-side).
 *
 * **Distinct from Estimate** — estimates are quotes (customer hasn't
 * committed), sales orders are committed but not yet invoiced (customer has
 * said yes; we're waiting on fulfillment / shipment / service delivery).
 * QB's backorder + fulfillment workflows live on SalesOrder, not Estimate.
 *
 * **Non-posting** — like PurchaseOrder, SalesOrder does NOT move
 * Customer.Balance or AR. The customer balance only moves when an invoice
 * is created against the order (via qb_sales_order_convert_to_invoice, or
 * a manual qb_invoice_create that mirrors the SO's lines).
 *
 * Convert flow: real QB has no single 'convert' RPC for SalesOrder either
 * (matches Estimate). qb_sales_order_convert_to_invoice reads the source
 * SO's lines, submits an InvoiceAddRq with CustomerRef + SalesOrderLineRet
 * carried over (each line mapped to InvoiceLineAdd), and (by default) marks
 * the source SO IsManuallyClosed=true. Pass markClosed:false for partial
 * conversions (the operator may want to invoice some lines now and the rest
 * after the next delivery — leave the SO open so it stays on the
 * outstanding-orders list).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";
import { ISO_DATE_RE } from "../util/validators.js";

// Sales-side line: Rate per unit (mirrors Estimate / Invoice). PurchaseOrder
// uses Cost — different field name because the AP / AR sides keep separate
// per-line price fields in QB's schema.
const salesOrderLineSchema = z
  .object({
    itemName: z.string().optional().describe("Item name or full name"),
    itemListId: z.string().optional().describe("Item ListID"),
    description: z.string().optional().describe("Line description"),
    quantity: z.number().optional().describe("Quantity"),
    rate: z.number().optional().describe("Rate per unit"),
    amount: z.number().optional().describe("Line amount (overrides qty * rate)"),
  })
  .refine((line) => Boolean(line.itemName || line.itemListId), {
    message: "Each sales-order line requires itemName or itemListId",
  });

// Mod variant — every field optional so a partial mod (e.g. just description
// on an existing line) doesn't force the operator to reconstruct the line.
const salesOrderLineModSchema = z
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
    { message: "New sales-order lines (no txnLineID) require itemName/itemListId and either amount or (quantity + rate)" }
  );

export function registerSalesOrderTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_sales_order_list",
    "List or search sales orders in QuickBooks Desktop. SalesOrders are non-posting — TotalAmount on each row reflects the committed value of the line set, not an AR balance (customer balance only moves when invoices are created against the order). Set paginate:true for iterator-based pagination (real QB caps each *QueryRq response at ~500 rows) — maxReturned defaults to 500 when paginate is enabled. By default each row carries header totals only; pass includeLineItems:true to also surface SalesOrderLineRet (item, qty, rate, amount, TxnLineID per line). Filter by customer, TxnID, refNumber, or date range.",
    {
      customerName: z.string().optional().describe("Filter by customer name"),
      customerListId: z.string().optional().describe("Filter by customer ListID"),
      txnId: z.string().optional().describe("Fetch a specific sales order by TxnID"),
      refNumber: z.string().optional().describe("Filter by reference/sales-order number"),
      fromDate: z.string().regex(ISO_DATE_RE).optional().describe("Start date (YYYY-MM-DD)"),
      toDate: z.string().regex(ISO_DATE_RE).optional().describe("End date (YYYY-MM-DD)"),
      includeLineItems: z.boolean().optional().describe("When true, each sales-order row carries its SalesOrderLineRet array. Default false — header totals only, matching real QB's *QueryRq default behavior."),
      maxReturned: z.number().optional().describe("Maximum results. Defaults to 500 when paginate is enabled (QB's per-batch cap); otherwise QB-driven."),
      paginate: z.boolean().optional().describe("Enable iterator-based pagination. Response surfaces iteratorRemainingCount + iteratorID. Auto-defaults maxReturned to 500 if unset."),
      iteratorID: z.string().optional().describe("Continue an existing iterator by passing the iteratorID from a prior paginated response. Implies paginate."),
    },
    async (args) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      const effectiveMaxReturned =
        args.maxReturned ?? (args.paginate || args.iteratorID ? 500 : undefined);

      if (args.txnId) filters.TxnID = args.txnId;
      if (args.refNumber) filters.RefNumber = args.refNumber;
      if (effectiveMaxReturned) filters.MaxReturned = effectiveMaxReturned;
      if (args.fromDate || args.toDate) {
        filters.TxnDateRangeFilter = {
          FromTxnDate: args.fromDate,
          ToTxnDate: args.toDate,
        };
      }
      if (args.customerListId) {
        filters.EntityFilter = { ListID: args.customerListId };
      } else if (args.customerName) {
        filters.EntityFilter = { FullName: args.customerName };
      }
      if (args.includeLineItems) filters.IncludeLineItems = true;

      try {
        if (args.paginate || args.iteratorID) {
          const result = await session.queryEntityPaginated("SalesOrder", filters, {
            iterator: args.iteratorID ? "Continue" : "Start",
            iteratorID: args.iteratorID,
          });
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                count: result.entities.length,
                salesOrders: result.entities,
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

        const salesOrders = await session.queryEntity("SalesOrder", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: salesOrders.length, salesOrders }, null, 2),
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
              statusMessage: e.message ?? "SalesOrderQueryRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_sales_order_create",
    "Create a new sales order in QuickBooks Desktop. Sales orders are non-posting — they don't move the customer balance. The simulation derives TotalAmount from the line set (TotalAmount = sum(line amounts), where each line.Amount = line.quantity * line.rate when not explicit). Pass isManuallyClosed: true to mark the order closed at create time (uncommon — usually only set later via qb_sales_order_update once fully invoiced). At least one line is required — header-only sales orders are rejected.",
    {
      customerName: z.string().optional().describe("Customer full name"),
      customerListId: z.string().optional().describe("Customer ListID"),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("Sales-order date (YYYY-MM-DD, default today)"),
      dueDate: z.string().regex(ISO_DATE_RE).optional().describe("Expected fulfillment / due date (YYYY-MM-DD)"),
      refNumber: z.string().optional().describe("Reference/sales-order number"),
      memo: z.string().optional().describe("Memo"),
      poNumber: z.string().optional().describe("Customer PO number (the customer's reference for the order)"),
      isManuallyClosed: z.boolean().optional()
        .describe("Mark the sales order closed regardless of invoicing activity. Default false."),
      lines: z.array(salesOrderLineSchema).min(1)
        .describe("Sales-order line items. At least one required."),
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original result without creating a duplicate sales order (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open."),
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
      if (args.dueDate) data.DueDate = args.dueDate;
      if (args.poNumber) data.PONumber = args.poNumber;
      if (args.isManuallyClosed !== undefined) data.IsManuallyClosed = args.isManuallyClosed;
      if (args.memo) data.Memo = args.memo;

      data.SalesOrderLineAdd = args.lines.map((line) => {
        const lineData: Record<string, unknown> = {};
        if (line.itemListId) {
          lineData.ItemRef = { ListID: line.itemListId };
        } else {
          lineData.ItemRef = { FullName: line.itemName };
        }
        if (line.description) lineData.Desc = line.description;
        if (line.quantity !== undefined) lineData.Quantity = line.quantity;
        if (line.rate !== undefined) lineData.Rate = line.rate;
        if (line.amount !== undefined) lineData.Amount = line.amount;
        return lineData;
      });

      try {
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent("SalesOrder", data, args.idempotencyKey)
          : { entity: await session.addEntity("SalesOrder", data), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              salesOrder: result,
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
              statusMessage: e.message ?? "SalesOrderAddRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_sales_order_update",
    "Update an existing sales order in QuickBooks Desktop. Pass txnId + editSequence (from a prior qb_sales_order_list) plus any header fields and/or a replacement `lines` array. When `lines` is provided it REPLACES the order's existing line set wholesale — list every line you want the order to keep. A line with a txnLineID matching an existing line preserves that TxnLineID and merges any fields you pass over the existing values; a line without txnLineID (or with '-1') is added as new. TotalAmount recomputes from the post-mod line sum. Sales orders don't post to AR — there's no customer-balance side effect on either header or line changes. isManuallyClosed:true marks the order closed (typical: cancel an order that won't ship); false reopens it. A stale editSequence rejects with statusCode 3170.",
    {
      txnId: z.string().describe("TxnID of the sales order to update"),
      editSequence: z.string().describe("EditSequence from a prior query — must match the stored value or the mod is rejected with statusCode 3170"),
      customerName: z.string().optional().describe("New customer full name (re-points the order at a different customer)"),
      customerListId: z.string().optional().describe("New customer ListID"),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("New sales-order date (YYYY-MM-DD)"),
      dueDate: z.string().regex(ISO_DATE_RE).optional().describe("New expected fulfillment / due date (YYYY-MM-DD)"),
      refNumber: z.string().optional().describe("New reference number"),
      memo: z.string().optional().describe("New memo"),
      poNumber: z.string().optional().describe("New customer PO number"),
      isManuallyClosed: z.boolean().optional()
        .describe("Mark/unmark the sales order as manually closed (true closes the order, false reopens it)."),
      lines: z.array(salesOrderLineModSchema).optional()
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
      if (args.dueDate) data.DueDate = args.dueDate;
      if (args.poNumber) data.PONumber = args.poNumber;
      if (args.isManuallyClosed !== undefined) data.IsManuallyClosed = args.isManuallyClosed;
      if (args.memo) data.Memo = args.memo;

      if (args.lines) {
        data.SalesOrderLineMod = args.lines.map((line) => {
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
        const result = await session.modifyEntity("SalesOrder", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, salesOrder: result }, null, 2),
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
              statusMessage: e.message ?? "SalesOrderModRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_sales_order_delete",
    "Delete a sales order from QuickBooks Desktop. Sales orders aren't posted to AR so there's no balance to reverse — this is purely a record removal. Deleting a SO that has already been (partially) invoiced does NOT touch the invoices it spawned; those remain. WARNING: Irreversible.",
    {
      txnId: z.string().describe("TxnID of the sales order to delete"),
    },
    async ({ txnId }) => {
      const session = getSession();
      try {
        const result = await session.deleteEntity("SalesOrder", txnId);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, deleted: result }, null, 2),
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
              statusMessage: e.message ?? "TxnDelRq (SalesOrder) failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_sales_order_convert_to_invoice",
    "Convert a sales order to an invoice in QuickBooks Desktop. Real QB has no single 'convert' RPC — this tool reads the source sales order, submits an InvoiceAddRq with CustomerRef + SalesOrderLineRet carried over (each line mapped to InvoiceLineAdd), and (by default) marks the source order IsManuallyClosed=true. Carries CustomerRef plus optional ClassRef / TermsRef / SalesRepRef / PONumber from the order header onto the invoice when present. Operator-supplied invoiceTxnDate / invoiceDueDate / invoiceRefNumber / invoiceMemo override the carried values. The mark-closed step runs AFTER the invoice is successfully created; if the flip fails (e.g. concurrent SO edit), the invoice still exists and the response surfaces the partial state. Pass markClosed: false to leave the SO open (partial conversions where another invoice is expected against the remainder).",
    {
      salesOrderTxnId: z.string().describe("TxnID of the source sales order"),
      markClosed: z.boolean().optional()
        .describe("Mark the source sales order IsManuallyClosed=true after the invoice is created. Default true. Set false for partial conversions where another invoice will be billed against the remaining lines later."),
      invoiceTxnDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("Date for the new invoice (YYYY-MM-DD). Default: today."),
      invoiceDueDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("Due date for the new invoice (YYYY-MM-DD)."),
      invoiceRefNumber: z.string().optional()
        .describe("Reference number for the new invoice. Default: sales order's RefNumber if present."),
      invoiceMemo: z.string().optional()
        .describe("Memo for the new invoice. Default: 'Converted from sales order <ref>'."),
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original invoice without creating a duplicate (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open. Note: only the InvoiceAdd half of this tool is keyed; the IsManuallyClosed flip on the source order is not (a replay returns the original invoice without re-attempting the flip)."),
    },
    async (args) => {
      const session = getSession();

      let matches: Record<string, unknown>[];
      try {
        // Phase 10 #41 changed *QueryRq to strip *LineRet by default; this
        // tool reads SalesOrderLineRet to map onto InvoiceLineAdd, so it must
        // opt back in explicitly via IncludeLineItems.
        matches = await session.queryEntity("SalesOrder", {
          TxnID: args.salesOrderTxnId,
          IncludeLineItems: true,
        });
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? "SalesOrderQueryRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
      const salesOrder = matches[0];
      if (!salesOrder) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: `SalesOrder "${args.salesOrderTxnId}" not found`,
            }),
          }],
          isError: true,
        };
      }

      const customerRef = salesOrder.CustomerRef as Record<string, unknown> | undefined;
      if (!customerRef) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: `SalesOrder "${args.salesOrderTxnId}" has no CustomerRef and cannot be converted`,
            }),
          }],
          isError: true,
        };
      }

      const salesOrderLines = Array.isArray(salesOrder.SalesOrderLineRet)
        ? (salesOrder.SalesOrderLineRet as Record<string, unknown>[])
        : salesOrder.SalesOrderLineRet
          ? [salesOrder.SalesOrderLineRet as Record<string, unknown>]
          : [];

      const invoiceData: Record<string, unknown> = {
        CustomerRef: customerRef,
      };

      // Carry-over header fields when present on the source. Operator
      // overrides win (handled below). Real QB sales orders can carry
      // ClassRef / TermsRef / SalesRepRef / PONumber on the header.
      const carryFields = ["ClassRef", "TermsRef", "SalesRepRef", "PONumber"] as const;
      for (const field of carryFields) {
        if (salesOrder[field] !== undefined) {
          invoiceData[field] = salesOrder[field];
        }
      }

      const refNumber = args.invoiceRefNumber
        ?? (salesOrder.RefNumber !== undefined ? String(salesOrder.RefNumber) : undefined);
      if (refNumber) invoiceData.RefNumber = refNumber;

      if (args.invoiceTxnDate) {
        invoiceData.TxnDate = args.invoiceTxnDate;
      }
      if (args.invoiceDueDate) invoiceData.DueDate = args.invoiceDueDate;

      const sourceLabel = salesOrder.RefNumber
        ? String(salesOrder.RefNumber)
        : String(salesOrder.TxnID ?? args.salesOrderTxnId);
      invoiceData.Memo = args.invoiceMemo ?? `Converted from sales order ${sourceLabel}`;

      // Map SalesOrderLineRet → InvoiceLineAdd. TxnLineID is a return-side
      // identifier and is intentionally NOT carried — the new invoice
      // generates its own line IDs. ClassRef on the line carries when present.
      if (salesOrderLines.length > 0) {
        invoiceData.InvoiceLineAdd = salesOrderLines.map((line) => {
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
      let invoiceReplayed = false;
      try {
        if (args.idempotencyKey) {
          const out = await session.addEntityIdempotent(
            "Invoice",
            invoiceData,
            args.idempotencyKey,
          );
          invoice = out.entity;
          invoiceReplayed = out.replayed;
        } else {
          invoice = await session.addEntity("Invoice", invoiceData);
        }
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? "InvoiceAddRq (sales-order convert) failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }

      // Mark closed AFTER successful invoice creation (default behavior).
      // markClosed=false leaves the SO open (partial conversion — another
      // invoice expected against the remaining lines).
      // On idempotent replay, skip the mark step — the original call already
      // ran it (or was told not to). Re-running would either be a no-op (if
      // the SO is already closed) or fail with statusCode 3170 because the
      // EditSequence we read above is now stale relative to the prior mark.
      const shouldMarkClosed = args.markClosed !== false && !invoiceReplayed;
      let salesOrderMarked = false;
      let markError: { statusCode: number; statusMessage: string; humanReadable?: string } | null = null;

      if (shouldMarkClosed) {
        try {
          await session.modifyEntity("SalesOrder", {
            TxnID: args.salesOrderTxnId,
            EditSequence: salesOrder.EditSequence,
            IsManuallyClosed: true,
          });
          salesOrderMarked = true;
        } catch (err) {
          // The invoice was created successfully — surface the partial state
          // rather than losing it. The operator can re-mark via
          // qb_sales_order_update.
          const e = err as { message?: string; statusCode?: number };
          const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
          markError = {
            statusCode: e.statusCode ?? -1,
            statusMessage: e.message ?? "SalesOrderModRq (mark IsManuallyClosed) failed",
            ...(humanReadable ? { humanReadable } : {}),
          };
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            ...(invoiceReplayed ? { idempotentReplay: true } : {}),
            invoice,
            salesOrderMarkedClosed: salesOrderMarked,
            ...(markError ? { markClosedError: markError } : {}),
          }, null, 2),
        }],
      };
    }
  );
}
