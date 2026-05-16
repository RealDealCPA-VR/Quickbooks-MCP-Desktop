/**
 * InventoryAdjustment management tools for QuickBooks Desktop MCP.
 *
 * Phase 17 #80 — inventory adjustments. Used for shrinkage, count corrections,
 * write-offs of damaged stock, and any other manual change to ItemInventory's
 * QuantityOnHand or AverageCost. Required for any client carrying inventory.
 *
 * Real QB structure:
 *   - Header carries AccountRef (REQUIRED — the offsetting GL account, typically
 *     "Inventory Adjustment" expense or COGS) plus optional CustomerRef /
 *     ClassRef / Memo / RefNumber.
 *   - Each line carries ItemRef (must resolve to ItemInventory) plus exactly
 *     one of QuantityAdjustment OR ValueAdjustment.
 *     - QuantityAdjustment: NewQuantity (absolute) OR QuantityDifference (delta)
 *       — value moves at current AverageCost.
 *     - ValueAdjustment: NewValue (absolute) OR ValueDifference (delta), with
 *       an optional independent NewQuantity / QuantityDifference. Used to
 *       reprice inventory without changing count (write-down, write-up).
 *   - On query, real QB normalizes both forms — every line returns
 *     QuantityDifference + ValueDifference regardless of which input shape was
 *     used. The simulation mirrors this at the sim handler.
 *
 * Sim semantics:
 *   - applyInventoryAdjustment in simulation-store.ts walks each line, looks
 *     up the ItemInventory row, derives the post-adjustment QuantityOnHand /
 *     QuantityOnHandValue / AverageCost, mutates the item, and writes the
 *     normalized line shape back. TotalAmount = Σ ValueDifference.
 *   - Two-phase: validates EVERY line first (item lookup, adjustment-shape
 *     sanity, AccountRef present); a doomed line never leaves items partially
 *     mutated.
 *   - Delete reverses every line's qty/value delta against the still-present
 *     ItemInventory row (orphan items are silently skipped — a deleted item
 *     must not block adjustment deletion).
 *   - GL posting to AccountRef is NOT modeled in sim's first cut (matches the
 *     deferred JE-line customer-balance behavior — real QB posts the offset
 *     automatically). Reports / TB walks see the InventoryAdjustment in the
 *     transaction-list if scoped to AccountRef but won't see implicit
 *     balancing entries.
 *
 * No `_update` tool — InventoryAdjustment mods are complex (recompute net
 * delta from old vs new lines, rewind / re-apply on each item) and operators
 * typically delete + recreate in real QB. The QBXML SDK does support
 * InventoryAdjustmentModRq from version 12.0 onward but it's a rarely-used
 * surface; deferred until concretely needed.
 *
 * Enterprise-only fields (SerialNumber, LotNumber, InventorySiteRef,
 * InventorySiteLocationRef) are intentionally NOT exposed — they require
 * QuickBooks Enterprise with Advanced Inventory enabled.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";
import { ISO_DATE_RE } from "../util/validators.js";

// Per-line schema. Exactly one of quantity OR value adjustment is required;
// each adjustment branch then takes either an absolute (newQuantity / newValue)
// OR a delta (quantityDifference / valueDifference). The shape mirrors real
// QB's input — both branches are accepted on the same wire surface.
const inventoryAdjustmentLineSchema = z
  .object({
    itemName: z.string().optional().describe("Item full name (must be an ItemInventory)"),
    itemListId: z.string().optional().describe("Item ListID (must resolve to ItemInventory)"),
    // QuantityAdjustment branch — pure count change. Value moves at current
    // AverageCost server-side.
    newQuantity: z.number().optional().describe("QuantityAdjustment branch — set QuantityOnHand to this absolute value; ValueDifference = (newQuantity − currentQty) × currentAverageCost"),
    quantityDifference: z.number().optional().describe("QuantityAdjustment branch — add this signed delta to QuantityOnHand (negative = shrinkage); ValueDifference = quantityDifference × currentAverageCost"),
    // ValueAdjustment branch — repricing or combined qty + value change.
    newValue: z.number().optional().describe("ValueAdjustment branch — set QuantityOnHandValue to this absolute total"),
    valueDifference: z.number().optional().describe("ValueAdjustment branch — add this signed dollar delta to QuantityOnHandValue (negative = write-down)"),
  })
  .refine(
    (line) => Boolean(line.itemName || line.itemListId),
    { message: "Each inventory-adjustment line requires itemName or itemListId" }
  )
  .refine(
    (line) => {
      const isQty = line.newQuantity !== undefined || line.quantityDifference !== undefined;
      const isValOnly = (line.newValue !== undefined || line.valueDifference !== undefined) && !isQty;
      const isValWithQty = (line.newValue !== undefined || line.valueDifference !== undefined) && isQty;
      // Three permitted shapes:
      //   1. Pure quantity adjustment (newQuantity XOR quantityDifference)
      //   2. Pure value adjustment (newValue XOR valueDifference)
      //   3. Combined value + quantity adjustment (any of newValue/valueDifference
      //      paired with any of newQuantity/quantityDifference)
      // The XOR within each branch is enforced by the next refine.
      return isQty || isValOnly || isValWithQty;
    },
    { message: "Each line requires at least one of newQuantity / quantityDifference / newValue / valueDifference" }
  )
  .refine(
    (line) =>
      !(line.newQuantity !== undefined && line.quantityDifference !== undefined),
    { message: "Pass either newQuantity or quantityDifference, not both" }
  )
  .refine(
    (line) =>
      !(line.newValue !== undefined && line.valueDifference !== undefined),
    { message: "Pass either newValue or valueDifference, not both" }
  );

export function registerInventoryAdjustmentTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_inventory_adjustment_list",
    "List inventory adjustments in QuickBooks Desktop. Each row carries header fields (TxnID, TxnDate, RefNumber, AccountRef, CustomerRef, Memo, TotalAmount = Σ ValueDifference) plus (when includeLineItems:true) an InventoryAdjustmentLineRet array — every line carries ItemRef, QuantityDifference (signed unit delta), ValueDifference (signed dollar delta = the line's Amount). Real QB normalizes the input shape on return: QuantityAdjustment.NewQuantity inputs surface as QuantityDifference deltas; ValueAdjustment.NewValue inputs surface as ValueDifference deltas. AccountRef is the offsetting GL account (typically Inventory Adjustment expense or COGS).",
    {
      txnId: z.string().optional().describe("Fetch a specific adjustment by TxnID"),
      refNumber: z.string().optional().describe("Filter by reference number"),
      accountName: z.string().optional().describe("Filter by AccountRef full name (the offset GL account)"),
      accountListId: z.string().optional().describe("Filter by AccountRef ListID"),
      fromDate: z.string().regex(ISO_DATE_RE).optional().describe("Start date (YYYY-MM-DD)"),
      toDate: z.string().regex(ISO_DATE_RE).optional().describe("End date (YYYY-MM-DD)"),
      includeLineItems: z.boolean().optional().describe("When true, each adjustment row carries its InventoryAdjustmentLineRet array. Default false — header totals only, matching real QB's *QueryRq default behavior."),
      maxReturned: z.number().optional().describe("Maximum results"),
    },
    async (args) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      if (args.txnId) filters.TxnID = args.txnId;
      if (args.refNumber) filters.RefNumber = args.refNumber;
      if (args.maxReturned) filters.MaxReturned = args.maxReturned;
      if (args.fromDate || args.toDate) {
        filters.TxnDateRangeFilter = {
          FromTxnDate: args.fromDate,
          ToTxnDate: args.toDate,
        };
      }
      // AccountFilter targets the InventoryAdjustment header AccountRef (the
      // offset GL account). Real QB scopes server-side; sim handleQuery's
      // generic filter doesn't honor AccountFilter for this entity, so the
      // walk happens at the tool layer below.
      if (args.includeLineItems) filters.IncludeLineItems = true;

      try {
        let rows = await session.queryEntity("InventoryAdjustment", filters);
        const accountFilter = args.accountListId ?? args.accountName;
        if (accountFilter) {
          rows = rows.filter((r) => {
            const ref = r.AccountRef as Record<string, unknown> | undefined;
            if (!ref) return false;
            if (args.accountListId) return String(ref.ListID ?? "") === args.accountListId;
            return String(ref.FullName ?? "") === args.accountName;
          });
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: rows.length, inventoryAdjustments: rows }, null, 2),
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
              statusMessage: e.message ?? "InventoryAdjustmentQueryRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_inventory_adjustment_create",
    "Create an inventory adjustment in QuickBooks Desktop. Mutates ItemInventory.QuantityOnHand / QuantityOnHandValue / AverageCost on every referenced item. Lines accept three shapes (each line picks one): (a) pure quantity adjustment via newQuantity (absolute) OR quantityDifference (delta) — value moves at current AverageCost; (b) pure value adjustment via newValue OR valueDifference — used for write-downs and write-ups without changing count; (c) combined quantity + value adjustment. accountName is REQUIRED — it's the offsetting GL account (typically 'Inventory Adjustment', COGS, or a 'Shrinkage' expense). AverageCost recomputes from post-adjustment value/qty; when QuantityOnHand falls to zero the prior AverageCost is preserved (matches real QB — a future restock keeps its cost-basis history). At least one line is required. Two-phase commit at the sim layer — if any line is malformed (item not ItemInventory, missing adjustment shape, both QuantityAdjustment + ValueAdjustment specified) the whole adjustment rejects WITHOUT mutating any items.",
    {
      accountName: z.string().optional().describe("Full name of the offsetting GL account (typical: 'Inventory Adjustment' expense, 'Cost of Goods Sold', 'Shrinkage Expense')"),
      accountListId: z.string().optional().describe("ListID of the offsetting account"),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("Adjustment date (YYYY-MM-DD, default today)"),
      refNumber: z.string().optional().describe("Reference number"),
      memo: z.string().optional().describe("Memo"),
      customerName: z.string().optional().describe("Customer/job for cost allocation (optional)"),
      customerListId: z.string().optional().describe("Customer/job ListID for cost allocation"),
      className: z.string().optional().describe("Class for cost allocation (optional)"),
      lines: z.array(inventoryAdjustmentLineSchema).min(1)
        .describe("Per-item adjustment lines. At least one required."),
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original result without creating a duplicate adjustment (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open."),
    },
    async (args) => {
      const session = getSession();

      if (!args.accountName && !args.accountListId) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "Either accountName or accountListId is required (the offsetting GL account)",
            }),
          }],
          isError: true,
        };
      }

      const data: Record<string, unknown> = {};
      if (args.accountListId) {
        data.AccountRef = { ListID: args.accountListId };
      } else {
        data.AccountRef = { FullName: args.accountName };
      }
      if (args.txnDate) data.TxnDate = args.txnDate;
      if (args.refNumber) data.RefNumber = args.refNumber;
      if (args.memo) data.Memo = args.memo;
      if (args.customerListId) {
        data.CustomerRef = { ListID: args.customerListId };
      } else if (args.customerName) {
        data.CustomerRef = { FullName: args.customerName };
      }
      if (args.className) data.ClassRef = { FullName: args.className };

      data.InventoryAdjustmentLineAdd = args.lines.map((line) => {
        const lineData: Record<string, unknown> = {};
        if (line.itemListId) {
          lineData.ItemRef = { ListID: line.itemListId };
        } else {
          lineData.ItemRef = { FullName: line.itemName };
        }
        // Pick QuantityAdjustment vs ValueAdjustment based on which fields the
        // operator supplied. Combined value+qty inputs route through
        // ValueAdjustment because real QB requires the value side to be
        // explicit when both move (a quantity-only adjustment derives value at
        // current AverageCost server-side, so it's the wrong container when
        // the operator wants to override).
        const hasValue = line.newValue !== undefined || line.valueDifference !== undefined;
        const hasQty = line.newQuantity !== undefined || line.quantityDifference !== undefined;
        if (hasValue) {
          const valAdj: Record<string, unknown> = {};
          if (line.newValue !== undefined) valAdj.NewValue = line.newValue;
          if (line.valueDifference !== undefined) valAdj.ValueDifference = line.valueDifference;
          if (line.newQuantity !== undefined) valAdj.NewQuantity = line.newQuantity;
          if (line.quantityDifference !== undefined) valAdj.QuantityDifference = line.quantityDifference;
          lineData.ValueAdjustment = valAdj;
        } else if (hasQty) {
          const qtyAdj: Record<string, unknown> = {};
          if (line.newQuantity !== undefined) qtyAdj.NewQuantity = line.newQuantity;
          if (line.quantityDifference !== undefined) qtyAdj.QuantityDifference = line.quantityDifference;
          lineData.QuantityAdjustment = qtyAdj;
        }
        return lineData;
      });

      try {
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent("InventoryAdjustment", data, args.idempotencyKey)
          : { entity: await session.addEntity("InventoryAdjustment", data), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              inventoryAdjustment: result,
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
              statusMessage: e.message ?? "InventoryAdjustmentAddRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_inventory_adjustment_delete",
    "Delete an inventory adjustment from QuickBooks Desktop. The simulation REVERSES every line's qty/value delta against the still-present ItemInventory row (orphan items are silently skipped — a deleted item won't block adjustment deletion). After delete, each affected item's QuantityOnHand / QuantityOnHandValue / AverageCost return to their pre-adjustment state. WARNING: Irreversible.",
    {
      txnId: z.string().describe("TxnID of the inventory adjustment to delete"),
    },
    async ({ txnId }) => {
      const session = getSession();
      try {
        const result = await session.deleteEntity("InventoryAdjustment", txnId);
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
              statusMessage: e.message ?? "TxnDelRq (InventoryAdjustment) failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
