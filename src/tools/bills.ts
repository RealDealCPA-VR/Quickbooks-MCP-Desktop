/**
 * Bill (Accounts Payable) management tools for QuickBooks Desktop MCP.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";
import { formatToolError } from "../util/format-tool-error.js";
import { ISO_DATE_RE } from "../util/validators.js";

const expenseLineSchema = z
  .object({
    accountName: z.string().optional().describe("Expense account full name (or use accountListId)"),
    accountListId: z.string().optional().describe("Expense account ListID (or use accountName)"),
    amount: z.number().describe("Line amount posted to the account"),
    memo: z.string().optional().describe("Per-line memo"),
    className: z.string().optional().describe("Class full name (optional, for class tracking)"),
  })
  .refine((line) => Boolean(line.accountName || line.accountListId), {
    message: "Each expense line requires accountName or accountListId",
  });

const itemLineSchema = z
  .object({
    itemName: z.string().optional().describe("Item full name (or use itemListId)"),
    itemListId: z.string().optional().describe("Item ListID (or use itemName)"),
    quantity: z.number().describe("Quantity received / billed"),
    cost: z.number().describe("Per-unit cost — line Amount is computed as quantity * cost"),
    memo: z.string().optional().describe("Per-line memo"),
  })
  .refine((line) => Boolean(line.itemName || line.itemListId), {
    message: "Each item line requires itemName or itemListId",
  });

// Mod variants — every field is optional so a partial mod (e.g. just a memo
// change on an existing line) doesn't force the operator to reconstruct the
// whole line. The simulation merges the mod fields onto the matching existing
// line by TxnLineID. New lines (no txnLineID, or txnLineID === '-1') still
// require the create-shape fields, enforced by per-line refinement below.
const expenseLineModSchema = z
  .object({
    txnLineID: z.string().optional()
      .describe("TxnLineID of the existing line to modify; omit (or pass '-1') to add a new line"),
    accountName: z.string().optional().describe("Expense account full name"),
    accountListId: z.string().optional().describe("Expense account ListID"),
    amount: z.number().optional().describe("Line amount posted to the account"),
    memo: z.string().optional().describe("Per-line memo"),
    className: z.string().optional().describe("Class full name"),
  })
  .refine(
    (line) => {
      const isNew = !line.txnLineID || line.txnLineID === "-1";
      if (!isNew) return true;
      return Boolean(line.accountName || line.accountListId);
    },
    { message: "New expense lines (no txnLineID) require accountName or accountListId" }
  );

const itemLineModSchema = z
  .object({
    txnLineID: z.string().optional()
      .describe("TxnLineID of the existing line to modify; omit (or pass '-1') to add a new line"),
    itemName: z.string().optional().describe("Item full name"),
    itemListId: z.string().optional().describe("Item ListID"),
    quantity: z.number().optional().describe("Quantity received / billed"),
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
    { message: "New item lines (no txnLineID) require itemName/itemListId, quantity, and cost" }
  );

// AP-side analog of payments.ts appliedToSchema — same field shape, but the
// named entity is a Bill (not an Invoice) and PaymentAmount reduces
// Bill.AmountDue + Vendor.Balance. Duplicated rather than hoisted because
// there's only one other call site and CLAUDE.md prefers a few similar
// lines over a premature shared module.
const appliedToBillSchema = z.object({
  txnId: z.string().describe("TxnID of the bill this payment applies to"),
  amount: z.number().describe("Amount of this payment to apply against the bill"),
  discountAmount: z.number().optional()
    .describe("Optional discount applied to the bill (closes AmountDue alongside the payment, posts to DiscountAccountRef)"),
  discountAccountName: z.string().optional()
    .describe("Income/expense account full name for the discount (required when discountAmount > 0)"),
});

export function registerBillTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_bill_list",
    "List or search bills (accounts payable) in QuickBooks Desktop. Set paginate:true to use iterator-based pagination — first call returns iteratorID + iteratorRemainingCount; pass iteratorID back on subsequent calls until iteratorRemainingCount === 0. When paginate is enabled, maxReturned defaults to 500 (QB's per-batch cap) if unset. By default each row carries header totals only; pass includeLineItems:true to also surface ExpenseLineRet + ItemLineRet (account/amount on the expense lines, item/qty/cost on item lines). Set includeCustomFields:true to surface DataExtRet (custom-field) values per bill.",
    {
      vendorName: z.string().optional().describe("Filter by vendor name"),
      vendorListId: z.string().optional().describe("Filter by vendor ListID"),
      txnId: z.string().optional().describe("Fetch a specific bill by TxnID"),
      fromDate: z.string().regex(ISO_DATE_RE).optional().describe("Start date filter (YYYY-MM-DD)"),
      toDate: z.string().regex(ISO_DATE_RE).optional().describe("End date filter (YYYY-MM-DD)"),
      paidStatus: z.enum(["All", "PaidOnly", "NotPaidOnly"]).optional()
        .describe("Filter by payment status"),
      includeLineItems: z.boolean().optional().describe("When true, each bill row carries its ExpenseLineRet + ItemLineRet arrays. Default false — header totals only, matching real QB's *QueryRq default behavior."),
      includeCustomFields: z.boolean().optional().describe("Include DataExtRet (custom-field values) on every returned bill. Pass customFieldOwnerId for non-default namespaces."),
      customFieldOwnerId: z.string().optional().describe("OwnerID namespace to scope DataExtRet to. Default '0' (standard company-defined fields). Only meaningful when includeCustomFields:true."),
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

      // BillQueryRq schema-required child order (see invoices.ts).
      // IncludeLineItems sits at the tail of the sequence (after PaidStatus,
      // before IncludeLinkedTxns).
      if (args.txnId) filters.TxnID = args.txnId;
      if (effectiveMaxReturned) filters.MaxReturned = effectiveMaxReturned;
      if (args.fromDate || args.toDate) {
        filters.TxnDateRangeFilter = { FromTxnDate: args.fromDate, ToTxnDate: args.toDate };
      }
      if (args.vendorListId) {
        filters.EntityFilter = { ListID: args.vendorListId };
      } else if (args.vendorName) {
        filters.EntityFilter = { FullName: args.vendorName };
      }
      if (args.paidStatus) filters.PaidStatus = args.paidStatus;
      if (args.includeLineItems) filters.IncludeLineItems = true;
      // Phase 13 #61 — OwnerID slots after IncludeLineItems in the BillQueryRq
      // schema sequence.
      if (args.includeCustomFields) {
        filters.OwnerID = args.customFieldOwnerId ?? "0";
      }

      try {
        if (args.paginate || args.iteratorID) {
          const result = await session.queryEntityPaginated("Bill", filters, {
            iterator: args.iteratorID ? "Continue" : "Start",
            iteratorID: args.iteratorID,
          });
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                count: result.entities.length,
                bills: result.entities,
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

        const bills = await session.queryEntity("Bill", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: bills.length, bills }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "BillQueryRq failed" });
      }
    }
  );

  server.tool(
    "qb_bill_create",
    "Create a new bill (accounts payable) in QuickBooks Desktop. At least one expense line or item line is required — header-only bills are rejected.",
    {
      vendorName: z.string().optional().describe("Vendor full name"),
      vendorListId: z.string().optional().describe("Vendor ListID"),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("Bill date (YYYY-MM-DD)"),
      dueDate: z.string().regex(ISO_DATE_RE).optional().describe("Due date (YYYY-MM-DD)"),
      refNumber: z.string().optional().describe("Reference number"),
      memo: z.string().optional().describe("Memo"),
      expenseLines: z.array(expenseLineSchema).optional()
        .describe("Expense-account lines — each posts Amount to AccountRef"),
      itemLines: z.array(itemLineSchema).optional()
        .describe("Item lines — each posts (quantity * cost) to ItemRef's expense account"),
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original result without creating a duplicate bill (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open."),
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

      const hasExpenseLines = Boolean(args.expenseLines && args.expenseLines.length > 0);
      const hasItemLines = Boolean(args.itemLines && args.itemLines.length > 0);
      if (!hasExpenseLines && !hasItemLines) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "At least one of expenseLines or itemLines is required — bills must post to a GL account",
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

      if (hasExpenseLines) {
        data.ExpenseLineAdd = args.expenseLines!.map((line) => {
          const lineData: Record<string, unknown> = {};
          if (line.accountListId) {
            lineData.AccountRef = { ListID: line.accountListId };
          } else {
            lineData.AccountRef = { FullName: line.accountName };
          }
          lineData.Amount = line.amount;
          if (line.memo) lineData.Memo = line.memo;
          if (line.className) lineData.ClassRef = { FullName: line.className };
          return lineData;
        });
      }

      if (hasItemLines) {
        data.ItemLineAdd = args.itemLines!.map((line) => {
          const lineData: Record<string, unknown> = {};
          if (line.itemListId) {
            lineData.ItemRef = { ListID: line.itemListId };
          } else {
            lineData.ItemRef = { FullName: line.itemName };
          }
          lineData.Quantity = line.quantity;
          lineData.Cost = line.cost;
          lineData.Amount = line.quantity * line.cost;
          if (line.memo) lineData.Memo = line.memo;
          return lineData;
        });
      }

      try {
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent("Bill", data, args.idempotencyKey)
          : { entity: await session.addEntity("Bill", data), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              bill: result,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "BillAddRq failed" });
      }
    }
  );

  server.tool(
    "qb_bill_update",
    "Modify an existing bill in QuickBooks Desktop. Pass txnId + editSequence (from a prior qb_bill_list) plus any header fields and/or expenseLines / itemLines to change. When line arrays are provided they REPLACE the bill's existing line set wholesale — list every line you want the bill to keep. A line with a txnLineID matching an existing line preserves that TxnLineID and merges any fields you pass over the existing values; a line without txnLineID (or with '-1') is added as new.",
    {
      txnId: z.string().describe("TxnID of the bill to update"),
      editSequence: z.string().describe("EditSequence from a prior query — must match the stored value or the mod is rejected with statusCode 3170"),
      vendorName: z.string().optional().describe("New vendor full name (re-points the bill at a different vendor)"),
      vendorListId: z.string().optional().describe("New vendor ListID"),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("New bill date (YYYY-MM-DD)"),
      dueDate: z.string().regex(ISO_DATE_RE).optional().describe("New due date (YYYY-MM-DD)"),
      refNumber: z.string().optional().describe("New reference number"),
      memo: z.string().optional().describe("New memo"),
      expenseLines: z.array(expenseLineModSchema).optional()
        .describe("Replacement expense-line set. Existing lines whose TxnLineID is not listed will be dropped."),
      itemLines: z.array(itemLineModSchema).optional()
        .describe("Replacement item-line set. Existing lines whose TxnLineID is not listed will be dropped."),
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

      if (args.expenseLines) {
        data.ExpenseLineMod = args.expenseLines.map((line) => {
          const lineData: Record<string, unknown> = {};
          if (line.txnLineID) lineData.TxnLineID = line.txnLineID;
          if (line.accountListId) {
            lineData.AccountRef = { ListID: line.accountListId };
          } else if (line.accountName) {
            lineData.AccountRef = { FullName: line.accountName };
          }
          if (line.amount !== undefined) lineData.Amount = line.amount;
          if (line.memo) lineData.Memo = line.memo;
          if (line.className) lineData.ClassRef = { FullName: line.className };
          return lineData;
        });
      }

      if (args.itemLines) {
        data.ItemLineMod = args.itemLines.map((line) => {
          const lineData: Record<string, unknown> = {};
          if (line.txnLineID) lineData.TxnLineID = line.txnLineID;
          if (line.itemListId) {
            lineData.ItemRef = { ListID: line.itemListId };
          } else if (line.itemName) {
            lineData.ItemRef = { FullName: line.itemName };
          }
          if (line.quantity !== undefined) lineData.Quantity = line.quantity;
          if (line.cost !== undefined) lineData.Cost = line.cost;
          if (line.memo) lineData.Memo = line.memo;
          return lineData;
        });
      }

      try {
        const result = await session.modifyEntity("Bill", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, bill: result }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "BillModRq failed" });
      }
    }
  );

  server.tool(
    "qb_bill_delete",
    "Delete a bill from QuickBooks Desktop. WARNING: Irreversible.",
    {
      txnId: z.string().describe("TxnID of the bill to delete"),
    },
    async ({ txnId }) => {
      const session = getSession();
      try {
        const result = await session.deleteEntity("Bill", txnId);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, deleted: result }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "TxnDelRq (Bill) failed" });
      }
    }
  );

  // Phase 12 #57a mirror — bill-side equivalent of qb_invoice_duplicate. Same
  // shape: read a source bill (with IncludeLineItems opt-in because Phase 10
  // #41 strips lines by default), submit a fresh BillAddRq with VendorRef +
  // line arrays carried + operator overrides applied. No new wire types.
  server.tool(
    "qb_bill_duplicate",
    "Duplicate an existing bill in QuickBooks Desktop. Reads the source bill's VendorRef + ExpenseLineRet + ItemLineRet and submits a fresh BillAddRq with that payload plus operator-supplied overrides. Carries by default: VendorRef, expense lines, item lines. Does NOT carry: TxnDate (default = today), DueDate, RefNumber (a duplicate needs a fresh number — supply it via refNumber or let QB autonumber), Memo (defaults to 'Duplicate of <source ref or TxnID>'). Use this to mirror a recurring vendor bill (last month's rent → this month's), or retarget a one-off bill at a different vendor via vendorName/vendorListId. Composite tool — uses existing Bill query + add primitives, no new wire request types. Read-only sessions reject with statusCode 9001 (the BillAddRq half is gated). Source bill not found returns statusCode 500.",
    {
      sourceTxnId: z.string().describe("TxnID of the bill to duplicate"),
      txnDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("Date for the new bill (YYYY-MM-DD). Default: today. The source bill's TxnDate is NOT carried — duplicating to the same date is rarely what you want."),
      dueDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("Due date for the new bill (YYYY-MM-DD). The source bill's DueDate is NOT carried (it's relative to TxnDate; carrying makes no sense for a different date)."),
      refNumber: z.string().optional()
        .describe("Reference/bill number for the new bill. The source bill's RefNumber is NOT carried — duplicates need fresh numbers to avoid collisions. Leave blank to let QB autonumber (when enabled in QB preferences)."),
      memo: z.string().optional()
        .describe("Memo for the new bill. Default: 'Duplicate of <source ref or TxnID>'."),
      vendorName: z.string().optional()
        .describe("Retarget the duplicate at a different vendor by full name. Default: source bill's VendorRef."),
      vendorListId: z.string().optional()
        .describe("Retarget the duplicate at a different vendor by ListID. Default: source bill's VendorRef."),
      idempotencyKey: z.string().min(1).optional()
        .describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original duplicate without creating a second one (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open."),
    },
    async (args) => {
      const session = getSession();

      let matches: Record<string, unknown>[];
      try {
        matches = await session.queryEntity("Bill", {
          TxnID: args.sourceTxnId,
          IncludeLineItems: true,
        });
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "BillQueryRq (duplicate source read) failed" });
      }

      const source = matches[0];
      if (!source) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 500,
              statusMessage: `Source bill "${args.sourceTxnId}" not found`,
              humanReadable: qbStatusCodeMessage(500),
            }),
          }],
          isError: true,
        };
      }

      let vendorRef: Record<string, unknown> | undefined;
      if (args.vendorListId) {
        vendorRef = { ListID: args.vendorListId };
      } else if (args.vendorName) {
        vendorRef = { FullName: args.vendorName };
      } else {
        vendorRef = source.VendorRef as Record<string, unknown> | undefined;
      }
      if (!vendorRef) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: `Source bill "${args.sourceTxnId}" has no VendorRef and no override supplied`,
            }),
          }],
          isError: true,
        };
      }

      const billData: Record<string, unknown> = {
        VendorRef: vendorRef,
      };

      if (args.txnDate) billData.TxnDate = args.txnDate;
      if (args.dueDate) billData.DueDate = args.dueDate;
      if (args.refNumber) billData.RefNumber = args.refNumber;

      const sourceLabel = source.RefNumber
        ? String(source.RefNumber)
        : String(source.TxnID ?? args.sourceTxnId);
      billData.Memo = args.memo ?? `Duplicate of ${sourceLabel}`;

      // Map ExpenseLineRet → ExpenseLineAdd. TxnLineID is not carried —
      // the new bill generates its own line IDs.
      const sourceExpenseLines = Array.isArray(source.ExpenseLineRet)
        ? (source.ExpenseLineRet as Record<string, unknown>[])
        : source.ExpenseLineRet
          ? [source.ExpenseLineRet as Record<string, unknown>]
          : [];
      if (sourceExpenseLines.length > 0) {
        billData.ExpenseLineAdd = sourceExpenseLines.map((line) => {
          const lineData: Record<string, unknown> = {};
          if (line.AccountRef) lineData.AccountRef = line.AccountRef;
          if (line.Amount !== undefined) lineData.Amount = line.Amount;
          if (line.Memo !== undefined) lineData.Memo = line.Memo;
          if (line.ClassRef) lineData.ClassRef = line.ClassRef;
          return lineData;
        });
      }

      // Map ItemLineRet → ItemLineAdd. Item lines carry Quantity + Cost +
      // Amount; the sim recomputes Amount = Quantity * Cost on add, so
      // explicit Amount carry keeps round-trip equality.
      const sourceItemLines = Array.isArray(source.ItemLineRet)
        ? (source.ItemLineRet as Record<string, unknown>[])
        : source.ItemLineRet
          ? [source.ItemLineRet as Record<string, unknown>]
          : [];
      if (sourceItemLines.length > 0) {
        billData.ItemLineAdd = sourceItemLines.map((line) => {
          const lineData: Record<string, unknown> = {};
          if (line.ItemRef) lineData.ItemRef = line.ItemRef;
          if (line.Quantity !== undefined) lineData.Quantity = line.Quantity;
          if (line.Cost !== undefined) lineData.Cost = line.Cost;
          if (line.Amount !== undefined) lineData.Amount = line.Amount;
          if (line.Memo !== undefined) lineData.Memo = line.Memo;
          return lineData;
        });
      }

      try {
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent("Bill", billData, args.idempotencyKey)
          : { entity: await session.addEntity("Bill", billData), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              sourceTxnId: args.sourceTxnId,
              bill: result,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "BillAddRq (duplicate) failed" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // Bill payment (BillPaymentCheck / BillPaymentCreditCard)
  // -----------------------------------------------------------------------
  server.tool(
    "qb_bill_pay",
    "Pay one or more bills via a check or credit card in QuickBooks Desktop. paymentMethod: 'check' routes to BillPaymentCheck (with optional bankAccountName); 'creditcard' routes to BillPaymentCreditCard (with optional creditCardAccountName). applyTo: [{txnId, amount, discountAmount?, discountAccountName?}] is required and non-empty — each entry reduces the named bill's AmountDue and decrements the vendor's Balance by the applied amount. Pass discountAmount > 0 to close part of the bill via a vendor discount (does NOT count toward vendor balance reduction). Bill IsPaid flips to true when AmountDue hits 0; over-payment leaves AmountDue negative and IsPaid false (vendor credit). TotalAmount on the response = sum(applyTo.amount). Unknown bill TxnID rejects atomically — no partial mutations.",
    {
      vendorName: z.string().optional().describe("Vendor full name (or use vendorListId)"),
      vendorListId: z.string().optional().describe("Vendor ListID (or use vendorName)"),
      paymentMethod: z.enum(["check", "creditcard"])
        .describe("'check' creates a BillPaymentCheck, 'creditcard' creates a BillPaymentCreditCard"),
      applyTo: z.array(appliedToBillSchema).min(1)
        .describe("Bill applications. At least one entry required — pure unapplied bill payments are not supported (use qb_payment_receive for the AR side if you meant a customer credit)."),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("Payment date (YYYY-MM-DD)"),
      refNumber: z.string().optional().describe("Reference/check number"),
      memo: z.string().optional().describe("Memo"),
      bankAccountName: z.string().optional()
        .describe("Bank account full name (BillPaymentCheck only — ignored for credit card)"),
      creditCardAccountName: z.string().optional()
        .describe("Credit card account full name (BillPaymentCreditCard only — ignored for check)"),
      apAccountName: z.string().optional()
        .describe("Accounts Payable account full name (defaults to the operator's standard AP account)"),
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original result without creating a duplicate bill payment (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open."),
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
      if (args.refNumber) data.RefNumber = args.refNumber;
      if (args.memo) data.Memo = args.memo;
      if (args.apAccountName) {
        data.APAccountRef = { FullName: args.apAccountName };
      }

      if (args.paymentMethod === "check" && args.bankAccountName) {
        data.BankAccountRef = { FullName: args.bankAccountName };
      } else if (args.paymentMethod === "creditcard" && args.creditCardAccountName) {
        data.CreditCardAccountRef = { FullName: args.creditCardAccountName };
      }

      data.AppliedToTxnAdd = args.applyTo.map((line) => {
        const lineData: Record<string, unknown> = {
          TxnID: line.txnId,
          PaymentAmount: line.amount,
        };
        if (line.discountAmount !== undefined && line.discountAmount > 0) {
          lineData.DiscountAmount = line.discountAmount;
          if (line.discountAccountName) {
            lineData.DiscountAccountRef = { FullName: line.discountAccountName };
          }
        }
        return lineData;
      });

      const entityType =
        args.paymentMethod === "check"
          ? "BillPaymentCheck"
          : "BillPaymentCreditCard";

      try {
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent(entityType, data, args.idempotencyKey)
          : { entity: await session.addEntity(entityType, data), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              billPayment: result,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: `${entityType}AddRq failed` });
      }
    }
  );

  server.tool(
    "qb_bill_payment_list",
    "List bill payments (BillPaymentCheck and/or BillPaymentCreditCard). Pass paymentType to scope to one type; omit it to fan out across both stores.",
    {
      vendorName: z.string().optional().describe("Filter by vendor name"),
      paymentType: z.enum(["check", "creditcard"]).optional()
        .describe("Filter by payment method. Omit to query both BillPaymentCheck + BillPaymentCreditCard and merge."),
      fromDate: z.string().regex(ISO_DATE_RE).optional().describe("Start date (YYYY-MM-DD)"),
      toDate: z.string().regex(ISO_DATE_RE).optional().describe("End date (YYYY-MM-DD)"),
      maxReturned: z.number().optional().describe("Maximum results (applied per-store when fanning out)"),
    },
    async (args) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      // BillPaymentCheck/CreditCardQueryRq schema-required child order
      // (see invoices.ts).
      if (args.maxReturned) filters.MaxReturned = args.maxReturned;
      if (args.fromDate || args.toDate) {
        filters.TxnDateRangeFilter = { FromTxnDate: args.fromDate, ToTxnDate: args.toDate };
      }
      if (args.vendorName) {
        filters.EntityFilter = { FullName: args.vendorName };
      }

      const types: ("BillPaymentCheck" | "BillPaymentCreditCard")[] =
        args.paymentType === "check"
          ? ["BillPaymentCheck"]
          : args.paymentType === "creditcard"
            ? ["BillPaymentCreditCard"]
            : ["BillPaymentCheck", "BillPaymentCreditCard"];

      try {
        const results = await Promise.all(
          types.map((t) => session.queryEntity(t, filters))
        );
        const billPayments = results.flat();

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: billPayments.length, billPayments }, null, 2),
          }],
        };
      } catch (err) {
        const op = types.length === 1 ? `${types[0]}QueryRq` : "BillPayment*QueryRq";
        return formatToolError(err, { fallbackMessage: `${op} failed` });
      }
    }
  );
}
