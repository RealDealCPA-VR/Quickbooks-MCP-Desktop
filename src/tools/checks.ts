/**
 * Check (banking) management tools for QuickBooks Desktop MCP.
 *
 * Phase 17 #75 — banking primitives. A Check records funds leaving a bank
 * account (AccountRef — the bank account drawn against), optionally to a
 * named payee (PayeeEntityRef — a Vendor / Customer / Employee / OtherName).
 * Each Check carries N expense lines (ExpenseLineAdd, posting to GL expense
 * accounts) and/or N item lines (ItemLineAdd, posting to the items' linked
 * expense accounts). At least one line is required — a check must post
 * SOMEWHERE on the GL side.
 *
 * CheckAddRq covers BOTH vendor disbursements (e.g. paying a contractor
 * directly outside the AP/bill workflow) AND non-A/P bank disbursements (e.g.
 * a check to the operator's landlord that hits Rent Expense directly). For
 * paying an EXISTING bill, use qb_bill_pay (BillPaymentCheckRq) — that's a
 * different transaction type that reduces the bill's AmountDue and the
 * vendor's Balance. This tool does not move vendor balance.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { formatToolError } from "../util/format-tool-error.js";
import { ISO_DATE_RE } from "../util/validators.js";

const expenseLineSchema = z
  .object({
    accountName: z.string().optional().describe("Expense account full name (or use accountListId)"),
    accountListId: z.string().optional().describe("Expense account ListID"),
    amount: z.number().describe("Line amount in dollars (positive — money flowing OUT of the bank account)"),
    memo: z.string().optional().describe("Per-line memo"),
    customerName: z.string().optional().describe("Customer / job FullName the expense is associated with (for job-costing) — optional"),
    customerListId: z.string().optional().describe("Customer ListID (alternative to customerName)"),
    className: z.string().optional().describe("Class full name (optional, for class tracking)"),
    billableStatus: z.enum(["Billable", "NotBillable", "HasBeenBilled"]).optional()
      .describe("Whether this expense line is billable back to the named customer/job. Default: NotBillable. Use Billable to mark it for inclusion in a future invoice."),
  })
  .refine((line) => Boolean(line.accountName || line.accountListId), {
    message: "Each expense line requires accountName or accountListId",
  });

const itemLineSchema = z
  .object({
    itemName: z.string().optional().describe("Item full name (or use itemListId)"),
    itemListId: z.string().optional().describe("Item ListID"),
    quantity: z.number().describe("Quantity"),
    cost: z.number().describe("Per-unit cost — line Amount is computed as quantity * cost"),
    memo: z.string().optional().describe("Per-line memo"),
    customerName: z.string().optional().describe("Customer / job FullName"),
    customerListId: z.string().optional().describe("Customer ListID"),
    className: z.string().optional().describe("Class full name"),
    billableStatus: z.enum(["Billable", "NotBillable", "HasBeenBilled"]).optional(),
  })
  .refine((line) => Boolean(line.itemName || line.itemListId), {
    message: "Each item line requires itemName or itemListId",
  });

const expenseLineModSchema = z
  .object({
    txnLineID: z.string().optional()
      .describe("TxnLineID of the existing line to modify; omit (or pass '-1') to add a new line"),
    accountName: z.string().optional(),
    accountListId: z.string().optional(),
    amount: z.number().optional(),
    memo: z.string().optional(),
    customerName: z.string().optional(),
    customerListId: z.string().optional(),
    className: z.string().optional(),
    billableStatus: z.enum(["Billable", "NotBillable", "HasBeenBilled"]).optional(),
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
    txnLineID: z.string().optional(),
    itemName: z.string().optional(),
    itemListId: z.string().optional(),
    quantity: z.number().optional(),
    cost: z.number().optional(),
    memo: z.string().optional(),
    customerName: z.string().optional(),
    customerListId: z.string().optional(),
    className: z.string().optional(),
    billableStatus: z.enum(["Billable", "NotBillable", "HasBeenBilled"]).optional(),
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

function buildExpenseLineAdd(line: z.infer<typeof expenseLineSchema>): Record<string, unknown> {
  const lineData: Record<string, unknown> = {};
  if (line.accountListId) {
    lineData.AccountRef = { ListID: line.accountListId };
  } else {
    lineData.AccountRef = { FullName: line.accountName };
  }
  lineData.Amount = line.amount;
  if (line.memo) lineData.Memo = line.memo;
  if (line.customerListId) {
    lineData.CustomerRef = { ListID: line.customerListId };
  } else if (line.customerName) {
    lineData.CustomerRef = { FullName: line.customerName };
  }
  if (line.className) lineData.ClassRef = { FullName: line.className };
  if (line.billableStatus) lineData.BillableStatus = line.billableStatus;
  return lineData;
}

function buildItemLineAdd(line: z.infer<typeof itemLineSchema>): Record<string, unknown> {
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
  if (line.customerListId) {
    lineData.CustomerRef = { ListID: line.customerListId };
  } else if (line.customerName) {
    lineData.CustomerRef = { FullName: line.customerName };
  }
  if (line.className) lineData.ClassRef = { FullName: line.className };
  if (line.billableStatus) lineData.BillableStatus = line.billableStatus;
  return lineData;
}

export function registerCheckTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_check_list",
    "List or search checks (Check transactions) in QuickBooks Desktop. Each Check is a direct disbursement from a bank account (AccountRef) to an optional payee (PayeeEntityRef), posting against one or more GL accounts via expense/item lines. Distinct from BillPaymentCheck — those pay existing bills. Set paginate:true for iterator-based pagination — maxReturned defaults to 500 when paginate is enabled. By default each row carries header totals only; pass includeLineItems:true to also surface ExpenseLineRet + ItemLineRet.",
    {
      payeeName: z.string().optional().describe("Filter by payee (Vendor/Customer/Employee/OtherName) FullName"),
      payeeListId: z.string().optional().describe("Filter by payee ListID"),
      txnId: z.string().optional().describe("Fetch a specific check by TxnID"),
      fromDate: z.string().regex(ISO_DATE_RE).optional().describe("Start date filter (YYYY-MM-DD)"),
      toDate: z.string().regex(ISO_DATE_RE).optional().describe("End date filter (YYYY-MM-DD)"),
      refNumber: z.string().optional().describe("Filter by exact RefNumber (the check number)"),
      includeLineItems: z.boolean().optional().describe("When true, each check row carries its ExpenseLineRet + ItemLineRet arrays. Default false — header totals only, matching real QB's *QueryRq default behavior."),
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
      if (args.payeeListId) {
        filters.EntityFilter = { ListID: args.payeeListId };
      } else if (args.payeeName) {
        filters.EntityFilter = { FullName: args.payeeName };
      }
      if (args.refNumber) filters.RefNumber = args.refNumber;
      if (args.includeLineItems) filters.IncludeLineItems = true;

      try {
        if (args.paginate || args.iteratorID) {
          const result = await session.queryEntityPaginated("Check", filters, {
            iterator: args.iteratorID ? "Continue" : "Start",
            iteratorID: args.iteratorID,
          });
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                count: result.entities.length,
                checks: result.entities,
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

        const checks = await session.queryEntity("Check", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: checks.length, checks }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "CheckQueryRq failed" });
      }
    }
  );

  server.tool(
    "qb_check_create",
    "Create a new check (direct bank disbursement) in QuickBooks Desktop. Draws funds from accountName (a Bank account by FullName or ListID) and posts them against one or more GL accounts via expenseLines / itemLines. Optional payeeName (Vendor / Customer / Employee / OtherName). At least one of expenseLines or itemLines is required — a check must post somewhere on the GL side. To PAY an existing bill, use qb_bill_pay instead (different transaction type — BillPaymentCheck — that closes AP). The check posts NotCleared by default (ClearedStatus flips to Cleared via the qb_cleared_status_update reconciliation flow). Read-only sessions reject with statusCode 9001.",
    {
      accountName: z.string().optional().describe("Bank account full name the check is drawn against (e.g. 'Checking')"),
      accountListId: z.string().optional().describe("Bank account ListID (alternative to accountName)"),
      payeeName: z.string().optional().describe("Payee full name (Vendor / Customer / Employee / OtherName). Optional — checks can be issued to non-system payees by leaving this off and writing the name in memo."),
      payeeListId: z.string().optional().describe("Payee ListID (alternative to payeeName)"),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("Check date (YYYY-MM-DD). Default: today."),
      refNumber: z.string().optional().describe("Check number"),
      memo: z.string().optional().describe("Memo (printed on the check)"),
      isToBePrinted: z.boolean().optional().describe("Mark the check for batch printing via QB Desktop's 'Print Checks' dialog. Default: false."),
      expenseLines: z.array(expenseLineSchema).optional()
        .describe("Expense-account lines — each posts Amount to AccountRef. At least one expense or item line is required."),
      itemLines: z.array(itemLineSchema).optional()
        .describe("Item lines — each posts (quantity * cost) to the item's linked expense account."),
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original result without creating a duplicate check (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002."),
    },
    async (args) => {
      const session = getSession();

      if (!args.accountName && !args.accountListId) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "Either accountName or accountListId is required (the bank account drawn against)",
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
              error: "At least one of expenseLines or itemLines is required — a check must post to a GL account",
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
      if (args.payeeListId) {
        data.PayeeEntityRef = { ListID: args.payeeListId };
      } else if (args.payeeName) {
        data.PayeeEntityRef = { FullName: args.payeeName };
      }
      if (args.txnDate) data.TxnDate = args.txnDate;
      if (args.refNumber) data.RefNumber = args.refNumber;
      if (args.memo) data.Memo = args.memo;
      if (args.isToBePrinted !== undefined) data.IsToBePrinted = args.isToBePrinted;

      if (hasExpenseLines) {
        data.ExpenseLineAdd = args.expenseLines!.map(buildExpenseLineAdd);
      }
      if (hasItemLines) {
        data.ItemLineAdd = args.itemLines!.map(buildItemLineAdd);
      }

      try {
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent("Check", data, args.idempotencyKey)
          : { entity: await session.addEntity("Check", data), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              check: result,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "CheckAddRq failed" });
      }
    }
  );

  server.tool(
    "qb_check_update",
    "Modify an existing check in QuickBooks Desktop. Pass txnId + editSequence (from a prior qb_check_list) plus any header fields and/or expenseLines / itemLines to change. When line arrays are provided they REPLACE the check's existing line set wholesale — list every line you want the check to keep. A line with a txnLineID matching an existing line preserves that TxnLineID and merges any fields you pass; a line without txnLineID (or with '-1') is added as new. The header Amount recomputes from the post-mod line sum. A stale editSequence rejects with statusCode 3170.",
    {
      txnId: z.string().describe("TxnID of the check to update"),
      editSequence: z.string().describe("EditSequence from a prior query — must match the stored value or the mod is rejected with statusCode 3170"),
      accountName: z.string().optional().describe("New bank account full name (re-points the check at a different bank account)"),
      accountListId: z.string().optional().describe("New bank account ListID"),
      payeeName: z.string().optional().describe("New payee full name"),
      payeeListId: z.string().optional().describe("New payee ListID"),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("New check date (YYYY-MM-DD)"),
      refNumber: z.string().optional().describe("New check number"),
      memo: z.string().optional().describe("New memo"),
      isToBePrinted: z.boolean().optional().describe("Set/clear the to-be-printed flag"),
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

      if (args.accountListId) {
        data.AccountRef = { ListID: args.accountListId };
      } else if (args.accountName) {
        data.AccountRef = { FullName: args.accountName };
      }
      if (args.payeeListId) {
        data.PayeeEntityRef = { ListID: args.payeeListId };
      } else if (args.payeeName) {
        data.PayeeEntityRef = { FullName: args.payeeName };
      }
      if (args.txnDate) data.TxnDate = args.txnDate;
      if (args.refNumber) data.RefNumber = args.refNumber;
      if (args.memo) data.Memo = args.memo;
      if (args.isToBePrinted !== undefined) data.IsToBePrinted = args.isToBePrinted;

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
          if (line.customerListId) {
            lineData.CustomerRef = { ListID: line.customerListId };
          } else if (line.customerName) {
            lineData.CustomerRef = { FullName: line.customerName };
          }
          if (line.className) lineData.ClassRef = { FullName: line.className };
          if (line.billableStatus) lineData.BillableStatus = line.billableStatus;
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
          if (line.customerListId) {
            lineData.CustomerRef = { ListID: line.customerListId };
          } else if (line.customerName) {
            lineData.CustomerRef = { FullName: line.customerName };
          }
          if (line.className) lineData.ClassRef = { FullName: line.className };
          if (line.billableStatus) lineData.BillableStatus = line.billableStatus;
          return lineData;
        });
      }

      try {
        const result = await session.modifyEntity("Check", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, check: result }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "CheckModRq failed" });
      }
    }
  );

  server.tool(
    "qb_check_delete",
    "Delete a check from QuickBooks Desktop. WARNING: Irreversible. To void instead, use qb_check_update with amount=0 and a 'VOID' memo (matches QB Desktop's Edit → Void Check behavior).",
    {
      txnId: z.string().describe("TxnID of the check to delete"),
    },
    async ({ txnId }) => {
      const session = getSession();
      try {
        const result = await session.deleteEntity("Check", txnId);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, deleted: result }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "TxnDelRq (Check) failed" });
      }
    }
  );
}
