/**
 * Bill (Accounts Payable) management tools for QuickBooks Desktop MCP.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";

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

export function registerBillTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_bill_list",
    "List or search bills (accounts payable) in QuickBooks Desktop.",
    {
      vendorName: z.string().optional().describe("Filter by vendor name"),
      vendorListId: z.string().optional().describe("Filter by vendor ListID"),
      txnId: z.string().optional().describe("Fetch a specific bill by TxnID"),
      fromDate: z.string().optional().describe("Start date filter (YYYY-MM-DD)"),
      toDate: z.string().optional().describe("End date filter (YYYY-MM-DD)"),
      paidStatus: z.enum(["All", "PaidOnly", "NotPaidOnly"]).optional()
        .describe("Filter by payment status"),
      maxReturned: z.number().optional().describe("Maximum results"),
    },
    async (args) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      if (args.txnId) filters.TxnID = args.txnId;
      if (args.vendorListId) {
        filters.EntityFilter = { ListID: args.vendorListId };
      } else if (args.vendorName) {
        filters.EntityFilter = { FullName: args.vendorName };
      }
      if (args.fromDate || args.toDate) {
        filters.TxnDateRangeFilter = { FromTxnDate: args.fromDate, ToTxnDate: args.toDate };
      }
      if (args.paidStatus) filters.PaidStatus = args.paidStatus;
      if (args.maxReturned) filters.MaxReturned = args.maxReturned;

      const bills = await session.queryEntity("Bill", filters);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ count: bills.length, bills }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "qb_bill_create",
    "Create a new bill (accounts payable) in QuickBooks Desktop. At least one expense line or item line is required — header-only bills are rejected.",
    {
      vendorName: z.string().optional().describe("Vendor full name"),
      vendorListId: z.string().optional().describe("Vendor ListID"),
      txnDate: z.string().optional().describe("Bill date (YYYY-MM-DD)"),
      dueDate: z.string().optional().describe("Due date (YYYY-MM-DD)"),
      refNumber: z.string().optional().describe("Reference number"),
      memo: z.string().optional().describe("Memo"),
      expenseLines: z.array(expenseLineSchema).optional()
        .describe("Expense-account lines — each posts Amount to AccountRef"),
      itemLines: z.array(itemLineSchema).optional()
        .describe("Item lines — each posts (quantity * cost) to ItemRef's expense account"),
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

      const result = await session.addEntity("Bill", data);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, bill: result }, null, 2),
        }],
      };
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
      const result = await session.deleteEntity("Bill", txnId);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, deleted: result }, null, 2),
        }],
      };
    }
  );
}
