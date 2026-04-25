/**
 * Payment & Estimate management tools for QuickBooks Desktop MCP.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";

export function registerPaymentTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  // -----------------------------------------------------------------------
  // Receive Payment
  // -----------------------------------------------------------------------
  server.tool(
    "qb_payment_receive",
    "Record a received payment from a customer in QuickBooks Desktop.",
    {
      customerName: z.string().optional().describe("Customer full name"),
      customerListId: z.string().optional().describe("Customer ListID"),
      txnDate: z.string().optional().describe("Payment date (YYYY-MM-DD)"),
      refNumber: z.string().optional().describe("Reference/check number"),
      totalAmount: z.number().describe("Total payment amount"),
      paymentMethodName: z.string().optional().describe("Payment method (e.g., Check, Cash, Credit Card)"),
      memo: z.string().optional().describe("Memo"),
      depositToAccountName: z.string().optional().describe("Account to deposit payment into"),
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

      const data: Record<string, unknown> = {
        TotalAmount: args.totalAmount,
      };

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
      if (args.depositToAccountName) {
        data.DepositToAccountRef = { FullName: args.depositToAccountName };
      }

      const result = await session.addEntity("ReceivePayment", data);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, payment: result }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "qb_payment_list",
    "List received payments in QuickBooks Desktop.",
    {
      customerName: z.string().optional().describe("Filter by customer name"),
      fromDate: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      toDate: z.string().optional().describe("End date (YYYY-MM-DD)"),
      maxReturned: z.number().optional().describe("Maximum results"),
    },
    async (args) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      if (args.customerName) {
        filters.EntityFilter = { FullName: args.customerName };
      }
      if (args.fromDate || args.toDate) {
        filters.TxnDateRangeFilter = { FromTxnDate: args.fromDate, ToTxnDate: args.toDate };
      }
      if (args.maxReturned) filters.MaxReturned = args.maxReturned;

      const payments = await session.queryEntity("ReceivePayment", filters);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ count: payments.length, payments }, null, 2),
        }],
      };
    }
  );

  // -----------------------------------------------------------------------
  // Estimates
  // -----------------------------------------------------------------------
  server.tool(
    "qb_estimate_list",
    "List estimates/quotes in QuickBooks Desktop.",
    {
      customerName: z.string().optional().describe("Filter by customer name"),
      fromDate: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      toDate: z.string().optional().describe("End date (YYYY-MM-DD)"),
      maxReturned: z.number().optional().describe("Maximum results"),
    },
    async (args) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      if (args.customerName) {
        filters.EntityFilter = { FullName: args.customerName };
      }
      if (args.fromDate || args.toDate) {
        filters.TxnDateRangeFilter = { FromTxnDate: args.fromDate, ToTxnDate: args.toDate };
      }
      if (args.maxReturned) filters.MaxReturned = args.maxReturned;

      const estimates = await session.queryEntity("Estimate", filters);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ count: estimates.length, estimates }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "qb_estimate_create",
    "Create a new estimate/quote in QuickBooks Desktop.",
    {
      customerName: z.string().optional().describe("Customer full name"),
      customerListId: z.string().optional().describe("Customer ListID"),
      txnDate: z.string().optional().describe("Estimate date (YYYY-MM-DD)"),
      refNumber: z.string().optional().describe("Reference number"),
      memo: z.string().optional().describe("Memo"),
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

      const result = await session.addEntity("Estimate", data);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, estimate: result }, null, 2),
        }],
      };
    }
  );
}
