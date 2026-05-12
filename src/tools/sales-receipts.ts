/**
 * SalesReceipt management tools for QuickBooks Desktop MCP.
 *
 * SalesReceipt is the cash-sale equivalent of Invoice — same line shape, but
 * the sale settles instantly (no AR posting, no BalanceRemaining, no payment
 * application). Funds land in the account named by DepositToAccountRef
 * (typically "Undeposited Funds" or a bank account). TotalAmount is the only
 * derived header total: Subtotal + SalesTaxTotal.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";
import { ISO_DATE_RE } from "../util/validators.js";

const salesReceiptLineSchema = z.object({
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
// — enforced by per-line refinement below. Mirrors invoiceLineModSchema.
const salesReceiptLineModSchema = z
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
    { message: "New sales receipt lines (no txnLineID) require itemName/itemListId and either amount or (quantity + rate)" }
  );

export function registerSalesReceiptTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_sales_receipt_list",
    "List or search sales receipts (cash sales) in QuickBooks Desktop. By default each row carries header totals only; pass includeLineItems:true to also surface SalesReceiptLineRet (the per-line breakdown — item, qty, rate, amount, TxnLineID per line).",
    {
      customerName: z.string().optional().describe("Filter by customer name"),
      customerListId: z.string().optional().describe("Filter by customer ListID"),
      txnId: z.string().optional().describe("Fetch a specific sales receipt by TxnID"),
      refNumber: z.string().optional().describe("Filter by reference/sales receipt number"),
      fromDate: z.string().regex(ISO_DATE_RE).optional().describe("Start date (YYYY-MM-DD)"),
      toDate: z.string().regex(ISO_DATE_RE).optional().describe("End date (YYYY-MM-DD)"),
      includeLineItems: z.boolean().optional().describe("When true, each sales receipt row carries its SalesReceiptLineRet array. Default false — header totals only, matching real QB's *QueryRq default behavior."),
      maxReturned: z.number().optional().describe("Maximum results"),
    },
    async (args) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      // SalesReceiptQueryRq schema-required child order (see invoices.ts).
      // IncludeLineItems sits at the tail (after EntityFilter, before
      // IncludeLinkedTxns) — SR has no PaidStatus filter.
      if (args.txnId) filters.TxnID = args.txnId;
      if (args.refNumber) filters.RefNumber = args.refNumber;
      if (args.maxReturned) filters.MaxReturned = args.maxReturned;
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
        const salesReceipts = await session.queryEntity("SalesReceipt", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: salesReceipts.length, salesReceipts }, null, 2),
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
              statusMessage: e.message ?? "SalesReceiptQueryRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_sales_receipt_create",
    "Create a sales receipt (cash sale) in QuickBooks Desktop. The sale settles instantly — funds post to depositToAccountName (typically 'Undeposited Funds' or a bank account) rather than AR. Subtotal derives from the line set; TotalAmount = Subtotal + SalesTaxTotal. There is no BalanceRemaining or IsPaid because the receipt is closed on creation. paymentMethodName documents how the customer paid (Check, Cash, Visa, etc.) — discoverable via qb_payment_method_list.",
    {
      customerName: z.string().optional().describe("Customer full name"),
      customerListId: z.string().optional().describe("Customer ListID"),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("Sale date (YYYY-MM-DD, default today)"),
      refNumber: z.string().optional().describe("Reference/sales receipt number"),
      memo: z.string().optional().describe("Memo"),
      paymentMethodName: z.string().optional().describe("Payment method (e.g., Check, Cash, Credit Card) — discoverable via qb_payment_method_list"),
      depositToAccountName: z.string().optional().describe("Account funds deposit into (e.g., 'Undeposited Funds' or a bank account)"),
      depositToAccountListId: z.string().optional().describe("Deposit account ListID (alternative to depositToAccountName)"),
      lines: z.array(salesReceiptLineSchema).optional()
        .describe("Sales receipt line items"),
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original result without creating a duplicate sales receipt (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open."),
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
      if (args.paymentMethodName) {
        data.PaymentMethodRef = { FullName: args.paymentMethodName };
      }
      if (args.depositToAccountListId) {
        data.DepositToAccountRef = { ListID: args.depositToAccountListId };
      } else if (args.depositToAccountName) {
        data.DepositToAccountRef = { FullName: args.depositToAccountName };
      }

      if (args.lines && args.lines.length > 0) {
        data.SalesReceiptLineAdd = args.lines.map((line) => {
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
          ? await session.addEntityIdempotent("SalesReceipt", data, args.idempotencyKey)
          : { entity: await session.addEntity("SalesReceipt", data), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              salesReceipt: result,
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
              statusMessage: e.message ?? "SalesReceiptAddRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // Phase 12 #58 — SR batch mirror of qb_invoice_batch_create. Differs in two
  // small ways: SR-specific header refs (PaymentMethodRef / DepositToAccountRef)
  // are accepted per-entry, and the rollback path has no Customer.Balance
  // reversal to worry about (cash sales don't post to AR — handleTxnDel on a
  // SalesReceipt is a pure record removal). The compensating-delete envelope
  // shape is otherwise identical.
  server.tool(
    "qb_sales_receipt_batch_create",
    "Create multiple sales receipts (cash sales) atomically in a single QBXML envelope (onError=stopOnError). Each entry follows the same shape as qb_sales_receipt_create — customerName or customerListId, optional header fields (paymentMethodName / depositToAccountName), optional `lines` array. Validation runs upfront (each entry needs a customer ref, ≤100 entries per batch); a single missing customer ref rejects the whole batch BEFORE any wire I/O so no posting happens. ATOMICITY: the QBXML wire itself does NOT roll back — stopOnError halts the envelope on the first wire-side failure but leaves prior-posted receipts in place. This tool covers that gap by automatically deleting any already-posted receipts when a later one fails (TxnDelRq per posted TxnID). The response carries per-entry status: 'posted' (committed), 'rolled-back' (was posted then auto-deleted), 'orphaned' (was posted but rollback delete itself failed — operator must clean up manually using qb_sales_receipt_delete with the surfaced TxnID), 'failed' (rejected on wire), 'skipped' (never ran post-stopOnError). On full success the response carries success=true plus the array of posted TxnIDs. Use this for high-volume same-day cash-sale entry (point-of-sale day-end reconciliation, batch import of online-sale receipts, fundraiser bulk entry) — anywhere you need ALL OR NONE semantics across multiple receipts. Sales receipts settle instantly to the named deposit account; there is no AR-balance reversal on rollback (cash sales don't post to AR — rollback is a pure record removal). The idempotencyKey fingerprints the whole entries list — reorder, add, or remove and you get statusCode 9002 (use a fresh key).",
    {
      receipts: z
        .array(
          z.object({
            customerName: z.string().optional().describe("Customer full name"),
            customerListId: z.string().optional().describe("Customer ListID (alternative to customerName)"),
            txnDate: z.string().regex(ISO_DATE_RE).optional()
              .describe("Sale date (YYYY-MM-DD, default today)"),
            refNumber: z.string().optional().describe("Reference/sales receipt number"),
            memo: z.string().optional().describe("Memo"),
            paymentMethodName: z.string().optional()
              .describe("Payment method (e.g., Check, Cash, Credit Card)"),
            depositToAccountName: z.string().optional()
              .describe("Deposit account full name (e.g., 'Undeposited Funds' or a bank account)"),
            depositToAccountListId: z.string().optional()
              .describe("Deposit account ListID (alternative to depositToAccountName)"),
            lines: z.array(salesReceiptLineSchema).optional()
              .describe("Sales receipt line items"),
          })
        )
        .min(1)
        .max(100)
        .describe("Array of sales receipts to post atomically (1–100). Each entry needs customerName or customerListId."),
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key for the WHOLE BATCH. Retrying with the same key + identical receipts list returns the original batch outcome without re-running the wire envelope (response carries idempotentReplay: true). Reordering, adding, or removing entries makes the request a different request — that returns statusCode 9002 (use a fresh key). Cache is per company file and clears on qb_company_open. CAVEAT: only fully-successful batches are cached. The upfront customer-ref validation gate runs before the idempotency check (entries missing a customer ref are rejected and not cached regardless of key); partial-failure batches are also not cached — fresh retry is the correct recovery (rollback already cleaned up the originally-posted receipts; orphans, if any, are surfaced to the operator on the failing call)."),
    },
    async (args) => {
      // Upfront customer-ref validation — same pattern as qb_invoice_batch_create.
      const validationErrors: Array<{ index: number; error: string }> = [];
      for (let i = 0; i < args.receipts.length; i++) {
        const sr = args.receipts[i];
        if (!sr.customerName && !sr.customerListId) {
          validationErrors.push({
            index: i,
            error: `Entry ${i + 1}: customerName or customerListId is required`,
          });
        }
      }
      if (validationErrors.length > 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 3120,
              statusMessage: "One or more entries are missing a required customer reference",
              humanReadable: qbStatusCodeMessage(3120),
              validationErrors,
            }, null, 2),
          }],
          isError: true,
        };
      }

      const session = getSession();

      const dataList = args.receipts.map((sr) => {
        const data: Record<string, unknown> = {};
        if (sr.customerListId) {
          data.CustomerRef = { ListID: sr.customerListId };
        } else {
          data.CustomerRef = { FullName: sr.customerName };
        }
        if (sr.txnDate) data.TxnDate = sr.txnDate;
        if (sr.refNumber) data.RefNumber = sr.refNumber;
        if (sr.memo) data.Memo = sr.memo;
        if (sr.paymentMethodName) {
          data.PaymentMethodRef = { FullName: sr.paymentMethodName };
        }
        if (sr.depositToAccountListId) {
          data.DepositToAccountRef = { ListID: sr.depositToAccountListId };
        } else if (sr.depositToAccountName) {
          data.DepositToAccountRef = { FullName: sr.depositToAccountName };
        }
        if (sr.lines && sr.lines.length > 0) {
          data.SalesReceiptLineAdd = sr.lines.map((line) => {
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
        return data;
      });

      let results;
      let batchReplayed = false;
      try {
        if (args.idempotencyKey) {
          const out = await session.executeBatchAddIdempotent(
            "SalesReceipt",
            dataList,
            args.idempotencyKey,
          );
          results = out.results;
          batchReplayed = out.replayed;
        } else {
          results = await session.executeBatchAdd("SalesReceipt", dataList);
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
              statusMessage: e.message ?? "Batch SalesReceiptAddRq envelope failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }

      const allPosted = results.every((r) => r.status === "posted");
      if (allPosted) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(batchReplayed ? { idempotentReplay: true } : {}),
              count: results.length,
              salesReceipts: results.map((r, i) => {
                const ret = (r as { entity: Record<string, unknown> }).entity;
                return {
                  index: i,
                  requestID: r.requestID,
                  status: "posted",
                  txnId: String(ret.TxnID ?? ""),
                  refNumber: args.receipts[i].refNumber,
                };
              }),
            }, null, 2),
          }],
        };
      }

      // Partial-failure rollback. Identical shape to qb_invoice_batch_create —
      // SR's handleTxnDel doesn't have a Customer.Balance reversal (cash sales
      // never moved it in the first place), so the rollback is structurally
      // simpler in the sim, but the tool-side dance is the same.
      const failedIdx = results.findIndex((r) => r.status === "failed");
      const failedResult = failedIdx >= 0
        ? results[failedIdx] as { statusCode: number; statusMessage: string }
        : undefined;

      const postedTxnIds: { index: number; txnId: string }[] = [];
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === "posted") {
          const entity = (results[i] as { entity: Record<string, unknown> }).entity;
          const txnId = String(entity.TxnID ?? "");
          if (txnId) postedTxnIds.push({ index: i, txnId });
        }
      }

      const rollbackOutcomes = new Map<
        string,
        { ok: true } | { ok: false; error: string }
      >();
      for (const { txnId } of [...postedTxnIds].reverse()) {
        try {
          await session.deleteEntity("SalesReceipt", txnId);
          rollbackOutcomes.set(txnId, { ok: true });
        } catch (err) {
          const e = err as { message?: string };
          rollbackOutcomes.set(txnId, {
            ok: false,
            error: e.message ?? "Compensating TxnDelRq failed",
          });
        }
      }

      const rolledBackTxnIds: string[] = [];
      const orphanedEntries: Array<{ txnId: string; reason: string }> = [];
      for (const { txnId } of postedTxnIds) {
        const outcome = rollbackOutcomes.get(txnId);
        if (outcome?.ok) rolledBackTxnIds.push(txnId);
        else orphanedEntries.push({
          txnId,
          reason: outcome?.ok === false ? outcome.error : "Unknown rollback failure",
        });
      }

      const entriesPayload = results.map((r, i) => {
        const refNumber = args.receipts[i].refNumber;
        if (r.status === "posted") {
          const entity = (r as { entity: Record<string, unknown> }).entity;
          const txnId = String(entity.TxnID ?? "");
          const outcome = rollbackOutcomes.get(txnId);
          if (outcome?.ok) {
            return {
              index: i,
              requestID: r.requestID,
              status: "rolled-back" as const,
              originalTxnId: txnId,
              refNumber,
            };
          }
          return {
            index: i,
            requestID: r.requestID,
            status: "orphaned" as const,
            txnId,
            refNumber,
            rollbackError: outcome?.ok === false ? outcome.error : "Unknown rollback failure",
          };
        }
        if (r.status === "failed") {
          return {
            index: i,
            requestID: r.requestID,
            status: "failed" as const,
            refNumber,
            statusCode: r.statusCode,
            statusMessage: r.statusMessage,
            ...(qbStatusCodeMessage(r.statusCode)
              ? { humanReadable: qbStatusCodeMessage(r.statusCode) }
              : {}),
          };
        }
        return {
          index: i,
          requestID: r.requestID,
          status: "skipped" as const,
          refNumber,
        };
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            atomic: true,
            rolledBack: orphanedEntries.length === 0,
            failedAt: failedIdx >= 0 ? failedIdx : undefined,
            failedReason: failedResult ? {
              statusCode: failedResult.statusCode,
              statusMessage: failedResult.statusMessage,
              humanReadable: qbStatusCodeMessage(failedResult.statusCode) || undefined,
            } : undefined,
            summary: {
              posted: 0,
              failed: results.filter((r) => r.status === "failed").length,
              skipped: results.filter((r) => r.status === "skipped").length,
              rolledBack: rolledBackTxnIds.length,
              rolledBackTxnIds,
              ...(orphanedEntries.length > 0 ? { orphaned: orphanedEntries } : {}),
            },
            salesReceipts: entriesPayload,
          }, null, 2),
        }],
        isError: true,
      };
    }
  );

  server.tool(
    "qb_sales_receipt_update",
    "Update an existing sales receipt in QuickBooks Desktop. Pass txnId + editSequence (from a prior qb_sales_receipt_list) plus any header fields and/or a replacement `lines` array. When `lines` is provided it REPLACES the receipt's existing line set wholesale — list every line you want kept. A line with a txnLineID matching an existing line preserves that TxnLineID and merges any fields you pass over the existing values; a line without txnLineID (or with '-1') is added as new. Subtotal + TotalAmount recompute automatically. Sales receipts are cash sales — there is no AR balance to track and no customer-balance side effect. A stale editSequence rejects with statusCode 3170.",
    {
      txnId: z.string().describe("TxnID of the sales receipt to update"),
      editSequence: z.string().describe("EditSequence from a prior query — must match the stored value or the mod is rejected with statusCode 3170"),
      customerName: z.string().optional().describe("New customer full name (re-points the receipt at a different customer)"),
      customerListId: z.string().optional().describe("New customer ListID"),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("New sale date (YYYY-MM-DD)"),
      refNumber: z.string().optional().describe("New reference number"),
      memo: z.string().optional().describe("New memo"),
      paymentMethodName: z.string().optional().describe("New payment method"),
      depositToAccountName: z.string().optional().describe("New deposit account full name"),
      depositToAccountListId: z.string().optional().describe("New deposit account ListID"),
      lines: z.array(salesReceiptLineModSchema).optional()
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
      if (args.paymentMethodName) {
        data.PaymentMethodRef = { FullName: args.paymentMethodName };
      }
      if (args.depositToAccountListId) {
        data.DepositToAccountRef = { ListID: args.depositToAccountListId };
      } else if (args.depositToAccountName) {
        data.DepositToAccountRef = { FullName: args.depositToAccountName };
      }

      if (args.lines) {
        data.SalesReceiptLineMod = args.lines.map((line) => {
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
        const result = await session.modifyEntity("SalesReceipt", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, salesReceipt: result }, null, 2),
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
              statusMessage: e.message ?? "SalesReceiptModRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // Phase 12 #57a mirror — sales-receipt analog of qb_invoice_duplicate. Same
  // shape: read source SR with IncludeLineItems opt-in (Phase 10 #41 strip),
  // submit a fresh SalesReceiptAddRq carrying CustomerRef + PaymentMethodRef +
  // DepositToAccountRef + lines plus operator overrides. No new wire types.
  server.tool(
    "qb_sales_receipt_duplicate",
    "Duplicate an existing sales receipt in QuickBooks Desktop. Reads the source receipt's CustomerRef + PaymentMethodRef + DepositToAccountRef + SalesReceiptLineRet and submits a fresh SalesReceiptAddRq with that payload plus operator-supplied overrides. Carries by default: CustomerRef, PaymentMethodRef, DepositToAccountRef, lines. Does NOT carry: TxnDate (default = today), RefNumber (a duplicate needs a fresh number — supply it via refNumber or let QB autonumber), Memo (defaults to 'Duplicate of <source ref or TxnID>'). Use this to mirror a recurring cash-sale entry (last month's standing customer → this month's), or retarget at a different customer via customerName/customerListId. Composite tool — uses existing SalesReceipt query + add primitives, no new wire request types. Read-only sessions reject with statusCode 9001 (the SalesReceiptAddRq half is gated). Source receipt not found returns statusCode 500.",
    {
      sourceTxnId: z.string().describe("TxnID of the sales receipt to duplicate"),
      txnDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("Date for the new sales receipt (YYYY-MM-DD). Default: today. The source receipt's TxnDate is NOT carried — duplicating to the same date is rarely what you want."),
      refNumber: z.string().optional()
        .describe("Reference/sales receipt number for the new entry. The source receipt's RefNumber is NOT carried — duplicates need fresh numbers to avoid collisions. Leave blank to let QB autonumber (when enabled in QB preferences)."),
      memo: z.string().optional()
        .describe("Memo for the new sales receipt. Default: 'Duplicate of <source ref or TxnID>'."),
      customerName: z.string().optional()
        .describe("Retarget the duplicate at a different customer by full name. Default: source receipt's CustomerRef."),
      customerListId: z.string().optional()
        .describe("Retarget the duplicate at a different customer by ListID. Default: source receipt's CustomerRef."),
      paymentMethodName: z.string().optional()
        .describe("Override the payment method (e.g. 'Check', 'Visa'). Default: source receipt's PaymentMethodRef (carried when present)."),
      depositToAccountName: z.string().optional()
        .describe("Override the deposit account (e.g. 'Undeposited Funds', 'Operating Checking'). Default: source receipt's DepositToAccountRef (carried when present)."),
      idempotencyKey: z.string().min(1).optional()
        .describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original duplicate without creating a second one (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open."),
    },
    async (args) => {
      const session = getSession();

      let matches: Record<string, unknown>[];
      try {
        matches = await session.queryEntity("SalesReceipt", {
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
              statusMessage: e.message ?? "SalesReceiptQueryRq (duplicate source read) failed",
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
              statusMessage: `Source sales receipt "${args.sourceTxnId}" not found`,
              humanReadable: qbStatusCodeMessage(500),
            }),
          }],
          isError: true,
        };
      }

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
              error: `Source sales receipt "${args.sourceTxnId}" has no CustomerRef and no override supplied`,
            }),
          }],
          isError: true,
        };
      }

      const receiptData: Record<string, unknown> = {
        CustomerRef: customerRef,
      };

      // PaymentMethodRef + DepositToAccountRef carry-overs with operator
      // override priority. Source refs are only used as fallback when no
      // override is supplied.
      if (args.paymentMethodName) {
        receiptData.PaymentMethodRef = { FullName: args.paymentMethodName };
      } else if (source.PaymentMethodRef) {
        receiptData.PaymentMethodRef = source.PaymentMethodRef;
      }

      if (args.depositToAccountName) {
        receiptData.DepositToAccountRef = { FullName: args.depositToAccountName };
      } else if (source.DepositToAccountRef) {
        receiptData.DepositToAccountRef = source.DepositToAccountRef;
      }

      if (args.txnDate) receiptData.TxnDate = args.txnDate;
      if (args.refNumber) receiptData.RefNumber = args.refNumber;

      const sourceLabel = source.RefNumber
        ? String(source.RefNumber)
        : String(source.TxnID ?? args.sourceTxnId);
      receiptData.Memo = args.memo ?? `Duplicate of ${sourceLabel}`;

      const sourceLines = Array.isArray(source.SalesReceiptLineRet)
        ? (source.SalesReceiptLineRet as Record<string, unknown>[])
        : source.SalesReceiptLineRet
          ? [source.SalesReceiptLineRet as Record<string, unknown>]
          : [];
      if (sourceLines.length > 0) {
        receiptData.SalesReceiptLineAdd = sourceLines.map((line) => {
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
          ? await session.addEntityIdempotent("SalesReceipt", receiptData, args.idempotencyKey)
          : { entity: await session.addEntity("SalesReceipt", receiptData), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              sourceTxnId: args.sourceTxnId,
              salesReceipt: result,
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
              statusMessage: e.message ?? "SalesReceiptAddRq (duplicate) failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_sales_receipt_delete",
    "Delete a sales receipt from QuickBooks Desktop. Sales receipts are cash sales — there's no AR balance to reverse, but the original deposit posting against depositToAccountRef is rolled back implicitly by the delete. WARNING: Irreversible.",
    {
      txnId: z.string().describe("TxnID of the sales receipt to delete"),
    },
    async ({ txnId }) => {
      const session = getSession();
      try {
        const result = await session.deleteEntity("SalesReceipt", txnId);
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
              statusMessage: e.message ?? "TxnDelRq (SalesReceipt) failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
