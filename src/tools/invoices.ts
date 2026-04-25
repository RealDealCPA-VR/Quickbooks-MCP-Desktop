/**
 * Invoice management tools for QuickBooks Desktop MCP.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";

const invoiceLineSchema = z.object({
  itemName: z.string().optional().describe("Item name or full name"),
  itemListId: z.string().optional().describe("Item ListID"),
  description: z.string().optional().describe("Line description"),
  quantity: z.number().optional().describe("Quantity"),
  rate: z.number().optional().describe("Rate per unit"),
  amount: z.number().optional().describe("Line amount (overrides qty * rate)"),
});

export function registerInvoiceTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_invoice_list",
    "List or search invoices in QuickBooks Desktop.",
    {
      customerName: z.string().optional().describe("Filter by customer name"),
      customerListId: z.string().optional().describe("Filter by customer ListID"),
      txnId: z.string().optional().describe("Fetch a specific invoice by TxnID"),
      refNumber: z.string().optional().describe("Filter by reference/invoice number"),
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
      if (args.paidStatus) filters.PaidStatus = args.paidStatus;
      if (args.maxReturned) filters.MaxReturned = args.maxReturned;

      const invoices = await session.queryEntity("Invoice", filters);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ count: invoices.length, invoices }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "qb_invoice_create",
    "Create a new invoice in QuickBooks Desktop.",
    {
      customerName: z.string().optional().describe("Customer full name"),
      customerListId: z.string().optional().describe("Customer ListID"),
      txnDate: z.string().optional().describe("Invoice date (YYYY-MM-DD, default today)"),
      dueDate: z.string().optional().describe("Due date (YYYY-MM-DD)"),
      refNumber: z.string().optional().describe("Reference/invoice number"),
      memo: z.string().optional().describe("Memo for the invoice"),
      lines: z.array(invoiceLineSchema).optional()
        .describe("Invoice line items"),
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

      const result = await session.addEntity("Invoice", data);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, invoice: result }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "qb_invoice_update",
    "Update an existing invoice in QuickBooks Desktop.",
    {
      txnId: z.string().describe("TxnID of the invoice to update"),
      editSequence: z.string().describe("EditSequence for optimistic locking"),
      customerName: z.string().optional().describe("New customer full name"),
      customerListId: z.string().optional().describe("New customer ListID"),
      txnDate: z.string().optional().describe("New invoice date"),
      dueDate: z.string().optional().describe("New due date"),
      refNumber: z.string().optional().describe("New reference number"),
      memo: z.string().optional().describe("New memo"),
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

      const result = await session.modifyEntity("Invoice", data);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, invoice: result }, null, 2),
        }],
      };
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
      const result = await session.deleteEntity("Invoice", txnId);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, deleted: result }, null, 2),
        }],
      };
    }
  );
}
