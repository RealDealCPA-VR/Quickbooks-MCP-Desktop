/**
 * Invoice management tools for QuickBooks Desktop MCP.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";
import { ISO_DATE_RE } from "../util/validators.js";

const invoiceLineSchema = z.object({
  itemName: z.string().optional().describe("Item name or full name"),
  itemListId: z.string().optional().describe("Item ListID"),
  description: z.string().optional().describe("Line description"),
  quantity: z.number().optional().describe("Quantity"),
  rate: z.number().optional().describe("Rate per unit"),
  amount: z.number().optional().describe("Line amount (overrides qty * rate)"),
});

// Mod variant — every field optional so a partial mod (e.g. just description
// on an existing line) doesn't force the operator to reconstruct the line.
// The simulation merges the mod fields onto the matching existing line by
// TxnLineID. New lines (no txnLineID, or txnLineID === '-1') still require
// itemName/itemListId AND a way to derive Amount (explicit amount, or
// quantity + rate) — enforced by per-line refinement below.
const invoiceLineModSchema = z
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
    { message: "New invoice lines (no txnLineID) require itemName/itemListId and either amount or (quantity + rate)" }
  );

export function registerInvoiceTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_invoice_list",
    "List or search invoices in QuickBooks Desktop. Set paginate:true to use iterator-based pagination — first call returns iteratorID + iteratorRemainingCount; pass iteratorID back on subsequent calls until iteratorRemainingCount === 0. When paginate is enabled, maxReturned defaults to 500 (QB's per-batch cap) if unset. By default each row carries header totals only; pass includeLineItems:true to also surface InvoiceLineRet (the per-line breakdown — item, qty, rate, amount, TxnLineID).",
    {
      customerName: z.string().optional().describe("Filter by customer name"),
      customerListId: z.string().optional().describe("Filter by customer ListID"),
      txnId: z.string().optional().describe("Fetch a specific invoice by TxnID"),
      refNumber: z.string().optional().describe("Filter by reference/invoice number"),
      fromDate: z.string().regex(ISO_DATE_RE).optional().describe("Start date filter (YYYY-MM-DD)"),
      toDate: z.string().regex(ISO_DATE_RE).optional().describe("End date filter (YYYY-MM-DD)"),
      paidStatus: z.enum(["All", "PaidOnly", "NotPaidOnly"]).optional()
        .describe("Filter by payment status"),
      includeLineItems: z.boolean().optional().describe("When true, each invoice row carries its InvoiceLineRet array (item, qty, rate, amount, TxnLineID per line). Default false — header totals only, matching real QB's *QueryRq default behavior."),
      maxReturned: z.number().optional().describe("Maximum results. Defaults to 500 when paginate is enabled (QB's per-batch cap); otherwise QB-driven."),
      paginate: z.boolean().optional().describe("Enable iterator-based pagination (real QB caps each *QueryRq response at ~500 rows). Response surfaces iteratorRemainingCount + iteratorID. Auto-defaults maxReturned to 500 if unset."),
      iteratorID: z.string().optional().describe("Continue an existing iterator by passing the iteratorID from a prior paginated response. Implies paginate."),
    },
    async (args) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      // Pagination requires MaxReturned — QB rejects iterator requests without it
      // ("There is a missing element: MaxReturned"). Default to 500 (QB's
      // effective per-batch cap) when paginate is on but no value was supplied.
      const effectiveMaxReturned =
        args.maxReturned ?? (args.paginate || args.iteratorID ? 500 : undefined);

      // InvoiceQueryRq schema-required child order (see DECISIONS.md
      // 2026-05-09): TxnID/RefNumber selectors → MaxReturned →
      // ModifiedDateRangeFilter → TxnDateRangeFilter → EntityFilter →
      // AccountFilter → RefNumberFilter → CurrencyFilter → PaidStatus →
      // IncludeLineItems → IncludeLinkedTxns. Out-of-order children get
      // rejected with the cryptic "QuickBooks found an error when parsing
      // the provided XML text stream".
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
      if (args.paidStatus) filters.PaidStatus = args.paidStatus;
      if (args.includeLineItems) filters.IncludeLineItems = true;

      try {
        if (args.paginate || args.iteratorID) {
          const result = await session.queryEntityPaginated("Invoice", filters, {
            iterator: args.iteratorID ? "Continue" : "Start",
            iteratorID: args.iteratorID,
          });
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                count: result.entities.length,
                invoices: result.entities,
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

        const invoices = await session.queryEntity("Invoice", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: invoices.length, invoices }, null, 2),
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
              statusMessage: e.message ?? "InvoiceQueryRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_invoice_create",
    "Create a new invoice in QuickBooks Desktop.",
    {
      customerName: z.string().optional().describe("Customer full name"),
      customerListId: z.string().optional().describe("Customer ListID"),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("Invoice date (YYYY-MM-DD, default today)"),
      dueDate: z.string().regex(ISO_DATE_RE).optional().describe("Due date (YYYY-MM-DD)"),
      refNumber: z.string().optional().describe("Reference/invoice number"),
      memo: z.string().optional().describe("Memo for the invoice"),
      lines: z.array(invoiceLineSchema).optional()
        .describe("Invoice line items"),
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original result without creating a duplicate invoice (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open."),
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
      if (args.dueDate) data.DueDate = args.dueDate;
      if (args.refNumber) data.RefNumber = args.refNumber;
      if (args.memo) data.Memo = args.memo;

      if (args.lines && args.lines.length > 0) {
        data.InvoiceLineAdd = args.lines.map((line) => {
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

      try {
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent("Invoice", data, args.idempotencyKey)
          : { entity: await session.addEntity("Invoice", data), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              invoice: result,
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
              statusMessage: e.message ?? "InvoiceAddRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_invoice_update",
    "Update an existing invoice in QuickBooks Desktop. Pass txnId + editSequence (from a prior qb_invoice_list) plus any header fields and/or a replacement `lines` array. When `lines` is provided it REPLACES the invoice's existing line set wholesale — list every line you want the invoice to keep. A line with a txnLineID matching an existing line preserves that TxnLineID and merges any fields you pass over the existing values; a line without txnLineID (or with '-1') is added as new. Subtotal / BalanceRemaining / IsPaid recompute automatically; AppliedAmount is preserved (paid portions don't disappear when lines change). If a line mod drops Subtotal below AppliedAmount, BalanceRemaining goes negative — that's the over-applied state and matches real QB. Customer balance moves by the change in BalanceRemaining (not Subtotal).",
    {
      txnId: z.string().describe("TxnID of the invoice to update"),
      editSequence: z.string().describe("EditSequence from a prior query — must match the stored value or the mod is rejected with statusCode 3170"),
      customerName: z.string().optional().describe("New customer full name (re-points the invoice at a different customer)"),
      customerListId: z.string().optional().describe("New customer ListID"),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("New invoice date (YYYY-MM-DD)"),
      dueDate: z.string().regex(ISO_DATE_RE).optional().describe("New due date (YYYY-MM-DD)"),
      refNumber: z.string().optional().describe("New reference number"),
      memo: z.string().optional().describe("New memo"),
      lines: z.array(invoiceLineModSchema).optional()
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
      if (args.dueDate) data.DueDate = args.dueDate;
      if (args.refNumber) data.RefNumber = args.refNumber;
      if (args.memo) data.Memo = args.memo;

      if (args.lines) {
        data.InvoiceLineMod = args.lines.map((line) => {
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
        const result = await session.modifyEntity("Invoice", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, invoice: result }, null, 2),
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
              statusMessage: e.message ?? "InvoiceModRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_invoice_delete",
    "Delete an invoice from QuickBooks Desktop. WARNING: Irreversible.",
    {
      txnId: z.string().describe("TxnID of the invoice to delete"),
    },
    async ({ txnId }) => {
      const session = getSession();
      try {
        const result = await session.deleteEntity("Invoice", txnId);
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
              statusMessage: e.message ?? "TxnDelRq (Invoice) failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // Phase 12 #57a — workflow stand-in for #45 (memorized transactions, which
  // QBXML doesn't expose at any version). Same outcome as right-click "Use"
  // on a QB-Desktop memorized template: read source invoice's lines, submit
  // a fresh InvoiceAddRq with the carried CustomerRef + lines and operator-
  // supplied overrides. Composite tool — no new wire types. Real QB has no
  // single "duplicate" RPC; this is two QBXML calls (Query + Add) glued
  // together at the tool layer. Mirrors qb_estimate_convert_to_invoice's
  // shape; differs in carry policy — TxnDate / DueDate / RefNumber are NOT
  // carried by default (a duplicate is a NEW invoice on a NEW date; carrying
  // them creates ref-number collisions and misleading due dates).
  server.tool(
    "qb_invoice_duplicate",
    "Duplicate an existing invoice in QuickBooks Desktop. Reads the source invoice's CustomerRef + lines (and optional ClassRef / TermsRef / SalesRepRef / PORefNumber on the header) and submits a fresh InvoiceAddRq with that payload plus operator-supplied overrides. Carries by default: CustomerRef, ClassRef, TermsRef, SalesRepRef, PORefNumber, lines. Does NOT carry: TxnDate (default = today), DueDate, RefNumber (a duplicate needs a fresh number — supply it via refNumber or let QB autonumber), Memo (defaults to 'Duplicate of <source ref or TxnID>'). Use this for the monthly-retainer billing pattern (last month's invoice → this month's), or to retarget a one-off invoice at a different customer via customerName/customerListId. Composite tool — uses existing Invoice query + add primitives, no new wire request types. Read-only sessions reject with statusCode 9001 (the InvoiceAddRq half is gated). Source invoice not found returns statusCode 500.",
    {
      sourceTxnId: z.string().describe("TxnID of the invoice to duplicate"),
      txnDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("Date for the new invoice (YYYY-MM-DD). Default: today. The source invoice's TxnDate is NOT carried — duplicating to the same date is rarely what you want."),
      dueDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("Due date for the new invoice (YYYY-MM-DD). The source invoice's DueDate is NOT carried (it's relative to TxnDate; carrying makes no sense for a different date)."),
      refNumber: z.string().optional()
        .describe("Reference/invoice number for the new invoice. The source invoice's RefNumber is NOT carried — duplicates need fresh numbers to avoid collisions. Leave blank to let QB autonumber (when enabled in QB preferences)."),
      memo: z.string().optional()
        .describe("Memo for the new invoice. Default: 'Duplicate of <source ref or TxnID>'."),
      customerName: z.string().optional()
        .describe("Retarget the duplicate at a different customer by full name. Default: source invoice's CustomerRef."),
      customerListId: z.string().optional()
        .describe("Retarget the duplicate at a different customer by ListID. Default: source invoice's CustomerRef."),
      idempotencyKey: z.string().min(1).optional()
        .describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original duplicate without creating a second one (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open."),
    },
    async (args) => {
      const session = getSession();

      let matches: Record<string, unknown>[];
      try {
        // Phase 10 #41 made *QueryRq strip *LineRet by default; this tool
        // reads InvoiceLineRet to map onto InvoiceLineAdd, so it must opt
        // back in explicitly.
        matches = await session.queryEntity("Invoice", {
          TxnID: args.sourceTxnId,
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
              statusMessage: e.message ?? "InvoiceQueryRq (duplicate source read) failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }

      const source = matches[0];
      if (!source) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 500,
              statusMessage: `Source invoice "${args.sourceTxnId}" not found`,
              humanReadable: qbStatusCodeMessage(500),
            }),
          }],
          isError: true,
        };
      }

      // CustomerRef from operator override; fall back to source. The source's
      // CustomerRef should always be populated (real QB requires it on every
      // invoice), but guard anyway in case a malformed live response surfaces.
      let customerRef: Record<string, unknown> | undefined;
      if (args.customerListId) {
        customerRef = { ListID: args.customerListId };
      } else if (args.customerName) {
        customerRef = { FullName: args.customerName };
      } else {
        customerRef = source.CustomerRef as Record<string, unknown> | undefined;
      }
      if (!customerRef) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: `Source invoice "${args.sourceTxnId}" has no CustomerRef and no override supplied`,
            }),
          }],
          isError: true,
        };
      }

      const invoiceData: Record<string, unknown> = {
        CustomerRef: customerRef,
      };

      // Header carry-overs. Real QB invoices can carry ClassRef / TermsRef /
      // SalesRepRef / PORefNumber on the header — we surface them on
      // duplicate even though qb_invoice_create doesn't accept them yet
      // (they could be present on invoices loaded from a live QB file).
      // Mirrors the convert-estimate-to-invoice carry list.
      const carryFields = ["ClassRef", "TermsRef", "SalesRepRef", "PORefNumber"] as const;
      for (const field of carryFields) {
        if (source[field] !== undefined) {
          invoiceData[field] = source[field];
        }
      }

      if (args.txnDate) invoiceData.TxnDate = args.txnDate;
      if (args.dueDate) invoiceData.DueDate = args.dueDate;
      if (args.refNumber) invoiceData.RefNumber = args.refNumber;

      const sourceLabel = source.RefNumber
        ? String(source.RefNumber)
        : String(source.TxnID ?? args.sourceTxnId);
      invoiceData.Memo = args.memo ?? `Duplicate of ${sourceLabel}`;

      // Map InvoiceLineRet → InvoiceLineAdd. TxnLineID is a return-side
      // identifier and is intentionally NOT carried — the new invoice
      // generates its own line IDs. ClassRef on the line carries when present.
      // Header-only source (no lines) is allowed — produces a header-only
      // duplicate.
      const sourceLines = Array.isArray(source.InvoiceLineRet)
        ? (source.InvoiceLineRet as Record<string, unknown>[])
        : source.InvoiceLineRet
          ? [source.InvoiceLineRet as Record<string, unknown>]
          : [];

      if (sourceLines.length > 0) {
        invoiceData.InvoiceLineAdd = sourceLines.map((line) => {
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

      try {
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent("Invoice", invoiceData, args.idempotencyKey)
          : { entity: await session.addEntity("Invoice", invoiceData), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              sourceTxnId: args.sourceTxnId,
              invoice: result,
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
              statusMessage: e.message ?? "InvoiceAddRq (duplicate) failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // qb_invoice_write_off — close an open invoice in one atomic call without
  // collecting payment. Wires as a $0 ReceivePayment whose AppliedToTxnAdd
  // carries PaymentAmount=0 + DiscountAmount=writeOffAmount +
  // DiscountAccountRef={FullName: writeOffAccount}. The discount closes
  // the invoice's BalanceRemaining alongside any payment portion (zero here)
  // and posts to the named expense account (typically "Bad Debt" or a
  // similar write-off P&L line). Single QBXML envelope — no compensating
  // delete needed. This is the same mechanism QB Desktop's "Discounts and
  // Credits" dialog uses when an accountant writes off an invoice via the
  // Receive Payments form.
  server.tool(
    "qb_invoice_write_off",
    "Write off an open invoice in QuickBooks Desktop in one atomic call. Reads the source invoice, then submits a $0 ReceivePayment with the invoice's BalanceRemaining (or a partial `amount`) as DiscountAmount posting to `writeOffAccount` (e.g. 'Bad Debt'). The invoice's BalanceRemaining drops to 0 (full write-off) or by `amount` (partial), IsPaid flips true on full write-off, the customer's open AR drops by the written-off amount, and the write-off posts to the named P&L account. Equivalent to QB Desktop's 'Discounts and Credits → Discount Tab → Discount Account' workflow on the Receive Payments form, but a single tool call instead of the multi-step UI dance. Source invoice not found returns statusCode 500; already-closed invoice (BalanceRemaining ≤ 0) returns a structured error. Read-only sessions reject with statusCode 9001 (the ReceivePaymentAdd half is gated).",
    {
      txnId: z.string().describe("TxnID of the invoice to write off"),
      writeOffAccount: z.string()
        .describe("Full name of the P&L account the write-off posts to (e.g. 'Bad Debt', 'Bad Debts Expense'). Discover via qb_account_list({accountType:'Expense'}) or {accountType:'OtherExpense'}."),
      amount: z.number().optional()
        .describe("Write-off amount. Default: the invoice's full BalanceRemaining (closes the invoice). Pass a smaller value for a partial write-off (the remainder stays open). Must be > 0 and ≤ BalanceRemaining."),
      txnDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("Date for the write-off entry (YYYY-MM-DD). Default: today."),
      refNumber: z.string().optional()
        .describe("Reference number for the underlying ReceivePayment record. Leave blank to let QB autonumber (when enabled in QB preferences)."),
      memo: z.string().optional()
        .describe("Memo for the write-off entry. Default: 'Write off invoice <source ref or TxnID>'."),
      depositToAccountName: z.string().optional()
        .describe("Optional 'Deposit To' account on the underlying ReceivePayment. The write-off itself posts to writeOffAccount; this field exists because real QB requires every ReceivePayment to name a deposit account even when TotalAmount is 0. Defaults to your QB file's configured Undeposited Funds / default deposit account."),
      idempotencyKey: z.string().min(1).optional()
        .describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original write-off without creating a duplicate (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open."),
    },
    async (args) => {
      const session = getSession();

      // Idempotent-replay detection: a write-off MUTATES its source invoice
      // (closes BalanceRemaining), so a second call with the same key would
      // fail the "invoice still open" check before reaching addEntityIdempotent.
      // Peek the cache up front so we can relax stale-state validation on
      // replay and let addEntityIdempotent be the authority on fingerprint
      // match vs. 9002 conflict.
      const cachedEntry = args.idempotencyKey
        ? session.peekIdempotencyEntry(args.idempotencyKey)
        : undefined;
      const isReplayCandidate = cachedEntry?.entityType === "ReceivePayment";

      let matches: Record<string, unknown>[];
      try {
        matches = await session.queryEntity("Invoice", { TxnID: args.txnId });
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? "InvoiceQueryRq (write-off source read) failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }

      const source = matches[0];
      if (!source) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 500,
              statusMessage: `Source invoice "${args.txnId}" not found`,
              humanReadable: qbStatusCodeMessage(500),
            }),
          }],
          isError: true,
        };
      }

      const customerRef = source.CustomerRef as Record<string, unknown> | undefined;
      if (!customerRef) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: `Source invoice "${args.txnId}" has no CustomerRef — cannot wire write-off ReceivePayment`,
            }),
          }],
          isError: true,
        };
      }

      const balanceRemaining = Number(source.BalanceRemaining ?? 0);
      if (!isReplayCandidate && balanceRemaining <= 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: `Invoice "${args.txnId}" has BalanceRemaining ${balanceRemaining} — already paid or closed; nothing to write off`,
            }),
          }],
          isError: true,
        };
      }

      // On replay, the prior call's writeOffAmount is the only payload that
      // will fingerprint-match. If the operator didn't pass an explicit
      // `amount`, pull the cached DiscountAmount; otherwise let their explicit
      // value flow through and let addEntityIdempotent fingerprint-decide.
      let writeOffAmount: number;
      if (isReplayCandidate && args.amount === undefined) {
        const cachedPayment = cachedEntry!.result as Record<string, unknown>;
        const applied = cachedPayment.AppliedToTxnRet;
        const firstApplied = (Array.isArray(applied) ? applied[0] : applied) as
          | Record<string, unknown>
          | undefined;
        writeOffAmount = Number(firstApplied?.DiscountAmount ?? 0);
      } else {
        writeOffAmount = args.amount ?? balanceRemaining;
      }

      if (writeOffAmount <= 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: `Write-off amount must be > 0 (got ${writeOffAmount})`,
            }),
          }],
          isError: true,
        };
      }
      if (!isReplayCandidate && writeOffAmount > balanceRemaining + 1e-9) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: `Write-off amount ${writeOffAmount} exceeds invoice BalanceRemaining ${balanceRemaining}`,
            }),
          }],
          isError: true,
        };
      }

      const sourceLabel = source.RefNumber
        ? String(source.RefNumber)
        : String(source.TxnID ?? args.txnId);
      const memo = args.memo ?? `Write off invoice ${sourceLabel}`;

      const data: Record<string, unknown> = {
        CustomerRef: customerRef,
        TotalAmount: 0,
        Memo: memo,
        AppliedToTxnAdd: [
          {
            TxnID: args.txnId,
            PaymentAmount: 0,
            DiscountAmount: writeOffAmount,
            DiscountAccountRef: { FullName: args.writeOffAccount },
          },
        ],
      };
      if (args.txnDate) data.TxnDate = args.txnDate;
      if (args.refNumber) data.RefNumber = args.refNumber;
      if (args.depositToAccountName) {
        data.DepositToAccountRef = { FullName: args.depositToAccountName };
      }

      try {
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent("ReceivePayment", data, args.idempotencyKey)
          : { entity: await session.addEntity("ReceivePayment", data), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              sourceTxnId: args.txnId,
              writeOff: {
                amount: writeOffAmount,
                account: args.writeOffAccount,
                memo,
              },
              payment: result,
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
              statusMessage: e.message ?? "ReceivePaymentAdd (write-off) failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
