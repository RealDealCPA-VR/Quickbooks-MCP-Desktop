/**
 * Statement charge management tools for QuickBooks Desktop MCP.
 *
 * Phase 17 #81. Statement charges are AR-posting transactions used by service
 * businesses to bill time-and-materials charges that accumulate on a customer
 * statement WITHOUT producing a formal invoice (a single statement print at
 * month-end totals them up). Each StatementCharge is structurally single-line
 * in QBXML — one ItemRef + Quantity + Rate at the txn header (no *LineAdd
 * array, unlike Invoice / Bill / Estimate). Posts to Customer.Balance on
 * create (Amount = Quantity * Rate when not explicit), reverses on delete,
 * and rebalances on mod.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";
import { formatToolError } from "../util/format-tool-error.js";
import { ISO_DATE_RE } from "../util/validators.js";

export function registerStatementChargeTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_statement_charge_list",
    "List or search statement charges in QuickBooks Desktop. StatementCharge is a single-line AR-posting transaction used for time-and-materials billing that accumulates on a customer's statement without a formal invoice. Each row carries ItemRef / Quantity / Rate / Amount at the txn header (no line array — unlike Invoice). Set paginate:true to use iterator-based pagination — first call returns iteratorID + iteratorRemainingCount; pass iteratorID back on subsequent calls. When paginate is enabled, maxReturned defaults to 500 (QB's per-batch cap) if unset.",
    {
      customerName: z.string().optional().describe("Filter by customer name"),
      customerListId: z.string().optional().describe("Filter by customer ListID"),
      txnId: z.string().optional().describe("Fetch a specific statement charge by TxnID"),
      refNumber: z.string().optional().describe("Filter by reference number"),
      fromDate: z.string().regex(ISO_DATE_RE).optional().describe("Start date filter (YYYY-MM-DD)"),
      toDate: z.string().regex(ISO_DATE_RE).optional().describe("End date filter (YYYY-MM-DD)"),
      maxReturned: z.number().optional().describe("Maximum results. Defaults to 500 when paginate is enabled (QB's per-batch cap); otherwise QB-driven."),
      paginate: z.boolean().optional().describe("Enable iterator-based pagination (real QB caps each *QueryRq response at ~500 rows). Response surfaces iteratorRemainingCount + iteratorID. Auto-defaults maxReturned to 500 if unset."),
      iteratorID: z.string().optional().describe("Continue an existing iterator by passing the iteratorID from a prior paginated response. Implies paginate."),
    },
    async (args) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      const effectiveMaxReturned =
        args.maxReturned ?? (args.paginate || args.iteratorID ? 500 : undefined);

      // StatementChargeQueryRq schema-required child order (mirrors the
      // canonical *QueryRq pattern pinned in tests/builder-emit-order.test.ts
      // for InvoiceQueryRq / BillQueryRq): TxnID / RefNumber selectors →
      // MaxReturned → ModifiedDateRangeFilter → TxnDateRangeFilter →
      // EntityFilter → AccountFilter → RefNumberFilter. JS object insertion
      // order pins this.
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

      try {
        if (args.paginate || args.iteratorID) {
          const result = await session.queryEntityPaginated("StatementCharge", filters, {
            iterator: args.iteratorID ? "Continue" : "Start",
            iteratorID: args.iteratorID,
          });
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                count: result.entities.length,
                statementCharges: result.entities,
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

        const charges = await session.queryEntity("StatementCharge", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: charges.length, statementCharges: charges }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "StatementChargeQueryRq failed" });
      }
    }
  );

  server.tool(
    "qb_statement_charge_create",
    "Create a statement charge in QuickBooks Desktop. Each StatementCharge bills ONE item × quantity × rate (single-line — there's no `lines` array; ItemRef / Quantity / Rate / Amount live at the txn header). Amount = quantity × rate is derived in the simulation when not explicit; an explicit `amount` override wins. Posts +Amount to the customer's Balance. Use for time-and-materials billing that accumulates on a customer statement without a formal invoice. For multi-line billing, create one statement charge per line (each gets its own TxnID + RefNumber and appears as a separate row on the customer's statement).",
    {
      customerName: z.string().optional().describe("Customer full name"),
      customerListId: z.string().optional().describe("Customer ListID"),
      itemName: z.string().optional().describe("Item full name (Service / OtherCharge / Inventory etc. — any item type that bills)"),
      itemListId: z.string().optional().describe("Item ListID"),
      quantity: z.number().optional().describe("Quantity charged (paired with rate to derive Amount)"),
      rate: z.number().optional().describe("Rate per unit (paired with quantity to derive Amount)"),
      amount: z.number().optional().describe("Explicit total amount (overrides qty × rate)"),
      description: z.string().optional().describe("Charge description (Desc) — shown on customer statements"),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("Charge date (YYYY-MM-DD, default today)"),
      dueDate: z.string().regex(ISO_DATE_RE).optional().describe("Due date (YYYY-MM-DD)"),
      refNumber: z.string().optional().describe("Reference number"),
      className: z.string().optional().describe("Class full name (for class-tracking)"),
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original result without creating a duplicate charge (response carries idempotentReplay:true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open."),
    },
    async (args) => {
      const session = getSession();

      if (!args.customerName && !args.customerListId) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 3120,
              statusMessage: "Either customerName or customerListId is required",
              humanReadable: qbStatusCodeMessage(3120),
            }),
          }],
          isError: true,
        };
      }

      if (!args.itemName && !args.itemListId) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 3120,
              statusMessage: "Either itemName or itemListId is required (StatementCharge requires ItemRef at the txn header)",
              humanReadable: qbStatusCodeMessage(3120),
            }),
          }],
          isError: true,
        };
      }

      // Amount source: must have explicit amount OR quantity+rate. Without
      // either, sim's computeTotals would derive Amount=0 silently. Real QB
      // rejects with statusCode 3120 ("There is a missing element"). Match
      // that here at the tool layer so the operator sees the error pre-wire.
      const hasAmountSource =
        args.amount !== undefined ||
        (args.quantity !== undefined && args.rate !== undefined);
      if (!hasAmountSource) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 3120,
              statusMessage: "Provide either `amount` or both `quantity` and `rate`",
              humanReadable: qbStatusCodeMessage(3120),
            }),
          }],
          isError: true,
        };
      }

      const data: Record<string, unknown> = {};

      // JS object insertion order pins the QBXML envelope's child order. The
      // StatementChargeAdd schema (qbxmlops130.xml) requires: CustomerRef →
      // ARAccountRef? → TxnDate? → RefNumber? → DueDate? → ItemRef →
      // Desc? → Quantity? → UnitOfMeasure? → Rate? → ClassRef? → Amount? →
      // Taxable? → SalesTaxCodeRef? → BillingDate? → OverrideItemAccountRef?
      // → Other1? → Other2?. Live verification pending; if a schema-order
      // class of bug surfaces on first live exercise, pin in
      // tests/builder-emit-order.test.ts.
      if (args.customerListId) {
        data.CustomerRef = { ListID: args.customerListId };
      } else {
        data.CustomerRef = { FullName: args.customerName };
      }
      if (args.txnDate) data.TxnDate = args.txnDate;
      if (args.refNumber) data.RefNumber = args.refNumber;
      if (args.dueDate) data.DueDate = args.dueDate;
      if (args.itemListId) {
        data.ItemRef = { ListID: args.itemListId };
      } else {
        data.ItemRef = { FullName: args.itemName };
      }
      if (args.description) data.Desc = args.description;
      if (args.quantity !== undefined) data.Quantity = args.quantity;
      if (args.rate !== undefined) data.Rate = args.rate;
      if (args.className) data.ClassRef = { FullName: args.className };
      if (args.amount !== undefined) data.Amount = args.amount;

      try {
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent("StatementCharge", data, args.idempotencyKey)
          : { entity: await session.addEntity("StatementCharge", data), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              statementCharge: result,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "StatementChargeAddRq failed" });
      }
    }
  );

  server.tool(
    "qb_statement_charge_update",
    "Update an existing statement charge in QuickBooks Desktop. Pass txnId + editSequence (from a prior qb_statement_charge_list) plus any header fields. StatementCharge has no line array — Quantity / Rate / Amount live at the txn header, so changing quantity OR rate without explicit amount triggers Amount re-derive (= newQuantity × newRate). Customer.Balance moves by (newAmount − oldAmount); re-targeting the customer via customerName/customerListId reverses the old amount against the old customer and applies the new amount to the new customer. A stale editSequence rejects with statusCode 3170.",
    {
      txnId: z.string().describe("TxnID of the statement charge to update"),
      editSequence: z.string().describe("EditSequence from a prior query — must match the stored value or the mod is rejected with statusCode 3170"),
      customerName: z.string().optional().describe("New customer full name (re-points the charge at a different customer)"),
      customerListId: z.string().optional().describe("New customer ListID"),
      itemName: z.string().optional().describe("New item full name"),
      itemListId: z.string().optional().describe("New item ListID"),
      quantity: z.number().optional().describe("New quantity (Amount re-derives unless explicit amount is also passed)"),
      rate: z.number().optional().describe("New rate (Amount re-derives unless explicit amount is also passed)"),
      amount: z.number().optional().describe("New explicit amount (overrides qty × rate re-derive)"),
      description: z.string().optional().describe("New description"),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("New charge date (YYYY-MM-DD)"),
      dueDate: z.string().regex(ISO_DATE_RE).optional().describe("New due date (YYYY-MM-DD)"),
      refNumber: z.string().optional().describe("New reference number"),
      className: z.string().optional().describe("New class full name"),
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
      if (args.itemListId) {
        data.ItemRef = { ListID: args.itemListId };
      } else if (args.itemName) {
        data.ItemRef = { FullName: args.itemName };
      }
      if (args.description) data.Desc = args.description;
      if (args.quantity !== undefined) data.Quantity = args.quantity;
      if (args.rate !== undefined) data.Rate = args.rate;
      if (args.className) data.ClassRef = { FullName: args.className };
      if (args.amount !== undefined) data.Amount = args.amount;

      try {
        const result = await session.modifyEntity("StatementCharge", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, statementCharge: result }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "StatementChargeModRq failed" });
      }
    }
  );

  server.tool(
    "qb_statement_charge_delete",
    "Delete a statement charge from QuickBooks Desktop. Customer.Balance reverses by -Amount. WARNING: Irreversible.",
    {
      txnId: z.string().describe("TxnID of the statement charge to delete"),
    },
    async ({ txnId }) => {
      const session = getSession();
      try {
        const result = await session.deleteEntity("StatementCharge", txnId);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, deleted: result }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "TxnDelRq (StatementCharge) failed" });
      }
    }
  );
}
