/**
 * PurchaseOrder management tools for QuickBooks Desktop MCP.
 *
 * A PurchaseOrder is the vendor-side analog of an Estimate: a non-posting
 * commitment to buy from a vendor. It does NOT touch Vendor.Balance / AP —
 * the vendor balance only moves when items are received against the PO via
 * a Bill (or via ItemReceipt, which this server doesn't expose yet). On the
 * line shape, POs use Cost (not Rate — that's the AR side); each line's
 * Amount = Quantity * Cost is computed at the tool layer, mirroring how
 * qb_bill_create handles ItemLineAdd.
 *
 * IsManuallyClosed is a write-once-style flag on the PO header: set true to
 * mark the PO closed regardless of receipt activity. Real QB exposes it on
 * both Add and Mod; this tool surfaces it on create + update. The simulation
 * stores it on the entity but doesn't drive automation off it (no auto-close
 * when fully received against — that's a future Bill ↔ PO linkage we don't
 * model yet).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";
import { ISO_DATE_RE } from "../util/validators.js";

const purchaseOrderLineSchema = z
  .object({
    itemName: z.string().optional().describe("Item name or full name"),
    itemListId: z.string().optional().describe("Item ListID"),
    description: z.string().optional().describe("Line description"),
    quantity: z.number().describe("Quantity to order"),
    cost: z.number().describe("Per-unit cost — line Amount is computed as quantity * cost"),
    memo: z.string().optional().describe("Per-line memo"),
  })
  .refine((line) => Boolean(line.itemName || line.itemListId), {
    message: "Each PO line requires itemName or itemListId",
  });

// Mod variant — every field optional so a partial mod (e.g. just memo on an
// existing line) doesn't force the operator to reconstruct the line. New
// lines (no txnLineID, or txnLineID === '-1') still require itemName/itemListId
// + quantity + cost — enforced by per-line refinement. Mirrors itemLineModSchema
// in tools/bills.ts.
const purchaseOrderLineModSchema = z
  .object({
    txnLineID: z.string().optional()
      .describe("TxnLineID of the existing line to modify; omit (or pass '-1') to add a new line"),
    itemName: z.string().optional().describe("Item full name"),
    itemListId: z.string().optional().describe("Item ListID"),
    description: z.string().optional().describe("Line description"),
    quantity: z.number().optional().describe("Quantity to order"),
    cost: z.number().optional().describe("Per-unit cost — line Amount is computed as quantity * cost"),
    memo: z.string().optional().describe("Per-line memo"),
  })
  .refine(
    (line) => {
      const isNew = !line.txnLineID || line.txnLineID === "-1";
      if (!isNew) return true;
      return Boolean(
        (line.itemName || line.itemListId) &&
        line.quantity !== undefined &&
        line.cost !== undefined
      );
    },
    { message: "New PO lines (no txnLineID) require itemName/itemListId, quantity, and cost" }
  );

export function registerPurchaseOrderTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_purchase_order_list",
    "List or search purchase orders in QuickBooks Desktop. POs are non-posting — TotalAmount on each row reflects the committed cost of the line set, not an AP balance (vendor balance only moves when bills are entered against received items).",
    {
      vendorName: z.string().optional().describe("Filter by vendor name"),
      vendorListId: z.string().optional().describe("Filter by vendor ListID"),
      txnId: z.string().optional().describe("Fetch a specific PO by TxnID"),
      refNumber: z.string().optional().describe("Filter by reference/PO number"),
      fromDate: z.string().regex(ISO_DATE_RE).optional().describe("Start date (YYYY-MM-DD)"),
      toDate: z.string().regex(ISO_DATE_RE).optional().describe("End date (YYYY-MM-DD)"),
      maxReturned: z.number().optional().describe("Maximum results"),
    },
    async (args) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      // PurchaseOrderQueryRq schema-required child order (see invoices.ts).
      if (args.txnId) filters.TxnID = args.txnId;
      if (args.refNumber) filters.RefNumber = args.refNumber;
      if (args.maxReturned) filters.MaxReturned = args.maxReturned;
      if (args.fromDate || args.toDate) {
        filters.TxnDateRangeFilter = {
          FromTxnDate: args.fromDate,
          ToTxnDate: args.toDate,
        };
      }
      if (args.vendorListId) {
        filters.EntityFilter = { ListID: args.vendorListId };
      } else if (args.vendorName) {
        filters.EntityFilter = { FullName: args.vendorName };
      }

      try {
        const purchaseOrders = await session.queryEntity("PurchaseOrder", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: purchaseOrders.length, purchaseOrders }, null, 2),
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
              statusMessage: e.message ?? "PurchaseOrderQueryRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_purchase_order_create",
    "Create a purchase order in QuickBooks Desktop. POs are non-posting — they don't move the vendor balance. The simulation derives TotalAmount from the line set (TotalAmount = sum(line.quantity * line.cost)). Pass isManuallyClosed: true to mark the PO closed at create time (uncommon — usually only set later via qb_purchase_order_update). At least one line is required — header-only POs are rejected.",
    {
      vendorName: z.string().optional().describe("Vendor full name"),
      vendorListId: z.string().optional().describe("Vendor ListID"),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("PO date (YYYY-MM-DD, default today)"),
      dueDate: z.string().regex(ISO_DATE_RE).optional().describe("Expected delivery / due date (YYYY-MM-DD)"),
      refNumber: z.string().optional().describe("Reference/PO number"),
      memo: z.string().optional().describe("Memo"),
      shipToEntity: z.string().optional()
        .describe("Ship-to address entity (customer/employee full name) — real QB lets POs ship direct to a customer"),
      isManuallyClosed: z.boolean().optional()
        .describe("Mark the PO closed regardless of receipt activity. Default false."),
      lines: z.array(purchaseOrderLineSchema).min(1)
        .describe("PO line items. At least one required."),
    },
    async (args) => {
      const session = getSession();

      if (!args.vendorName && !args.vendorListId) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "Either vendorName or vendorListId is required",
            }),
          }],
          isError: true,
        };
      }

      const data: Record<string, unknown> = {};
      if (args.vendorListId) {
        data.VendorRef = { ListID: args.vendorListId };
      } else {
        data.VendorRef = { FullName: args.vendorName };
      }
      if (args.txnDate) data.TxnDate = args.txnDate;
      if (args.dueDate) data.DueDate = args.dueDate;
      if (args.refNumber) data.RefNumber = args.refNumber;
      if (args.memo) data.Memo = args.memo;
      if (args.shipToEntity) data.ShipToEntityRef = { FullName: args.shipToEntity };
      if (args.isManuallyClosed !== undefined) data.IsManuallyClosed = args.isManuallyClosed;

      data.PurchaseOrderLineAdd = args.lines.map((line) => {
        const lineData: Record<string, unknown> = {};
        if (line.itemListId) {
          lineData.ItemRef = { ListID: line.itemListId };
        } else {
          lineData.ItemRef = { FullName: line.itemName };
        }
        if (line.description) lineData.Desc = line.description;
        lineData.Quantity = line.quantity;
        lineData.Cost = line.cost;
        lineData.Amount = line.quantity * line.cost;
        if (line.memo) lineData.Memo = line.memo;
        return lineData;
      });

      try {
        const result = await session.addEntity("PurchaseOrder", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, purchaseOrder: result }, null, 2),
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
              statusMessage: e.message ?? "PurchaseOrderAddRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_purchase_order_update",
    "Modify an existing purchase order. Pass txnId + editSequence (from a prior qb_purchase_order_list) plus any header fields and/or a replacement `lines` array. When `lines` is provided it REPLACES the PO's existing line set wholesale — list every line you want kept. A line with a txnLineID matching an existing line preserves that TxnLineID and merges any fields you pass over the existing values; a line without txnLineID (or with '-1') is added as new. TotalAmount recomputes automatically. POs are non-posting so there's no vendor-balance side effect on either header or line changes. Set isManuallyClosed: true to mark the PO closed (typical workflow: cancel a PO that won't be received). A stale editSequence rejects with statusCode 3170.",
    {
      txnId: z.string().describe("TxnID of the PO to update"),
      editSequence: z.string().describe("EditSequence from a prior query — must match the stored value or the mod is rejected with statusCode 3170"),
      vendorName: z.string().optional().describe("New vendor full name (re-points the PO at a different vendor)"),
      vendorListId: z.string().optional().describe("New vendor ListID"),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("New PO date (YYYY-MM-DD)"),
      dueDate: z.string().regex(ISO_DATE_RE).optional().describe("New expected delivery date (YYYY-MM-DD)"),
      refNumber: z.string().optional().describe("New reference number"),
      memo: z.string().optional().describe("New memo"),
      shipToEntity: z.string().optional().describe("New ship-to address entity"),
      isManuallyClosed: z.boolean().optional().describe("Mark/unmark the PO as manually closed"),
      lines: z.array(purchaseOrderLineModSchema).optional()
        .describe("Replacement line set. Existing lines whose TxnLineID is not listed will be dropped."),
    },
    async (args) => {
      const session = getSession();
      const data: Record<string, unknown> = {
        TxnID: args.txnId,
        EditSequence: args.editSequence,
      };

      if (args.vendorListId) {
        data.VendorRef = { ListID: args.vendorListId };
      } else if (args.vendorName) {
        data.VendorRef = { FullName: args.vendorName };
      }
      if (args.txnDate) data.TxnDate = args.txnDate;
      if (args.dueDate) data.DueDate = args.dueDate;
      if (args.refNumber) data.RefNumber = args.refNumber;
      if (args.memo) data.Memo = args.memo;
      if (args.shipToEntity) data.ShipToEntityRef = { FullName: args.shipToEntity };
      if (args.isManuallyClosed !== undefined) data.IsManuallyClosed = args.isManuallyClosed;

      if (args.lines) {
        data.PurchaseOrderLineMod = args.lines.map((line) => {
          const lineData: Record<string, unknown> = {};
          if (line.txnLineID) lineData.TxnLineID = line.txnLineID;
          if (line.itemListId) {
            lineData.ItemRef = { ListID: line.itemListId };
          } else if (line.itemName) {
            lineData.ItemRef = { FullName: line.itemName };
          }
          if (line.description) lineData.Desc = line.description;
          if (line.quantity !== undefined) lineData.Quantity = line.quantity;
          if (line.cost !== undefined) lineData.Cost = line.cost;
          if (line.memo) lineData.Memo = line.memo;
          return lineData;
        });
      }

      try {
        const result = await session.modifyEntity("PurchaseOrder", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, purchaseOrder: result }, null, 2),
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
              statusMessage: e.message ?? "PurchaseOrderModRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_purchase_order_delete",
    "Delete a purchase order from QuickBooks Desktop. POs aren't posted to AP, so there's no vendor-balance reversal — this is purely a record removal. WARNING: Irreversible.",
    {
      txnId: z.string().describe("TxnID of the PO to delete"),
    },
    async ({ txnId }) => {
      const session = getSession();
      try {
        const result = await session.deleteEntity("PurchaseOrder", txnId);
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
              statusMessage: e.message ?? "TxnDelRq (PurchaseOrder) failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
