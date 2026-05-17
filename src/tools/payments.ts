/**
 * Payment management tools for QuickBooks Desktop MCP.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { formatToolError } from "../util/format-tool-error.js";
import { ISO_DATE_RE } from "../util/validators.js";

const appliedToSchema = z.object({
  txnId: z.string().describe("TxnID of the invoice this payment applies to"),
  amount: z.number().describe("Amount of this payment to apply against the invoice"),
  discountAmount: z.number().optional()
    .describe("Optional discount applied to the invoice (closes BalanceRemaining alongside the payment, posts to DiscountAccountRef)"),
  discountAccountName: z.string().optional()
    .describe("P&L account full name for the discount (required when discountAmount > 0)"),
});

export function registerPaymentTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  // -----------------------------------------------------------------------
  // Receive Payment
  // -----------------------------------------------------------------------
  server.tool(
    "qb_payment_receive",
    "Record a received payment from a customer in QuickBooks Desktop. Pass appliedTo: [{txnId, amount, discountAmount?, discountAccountName?}] to close out specific invoices; omit it to record the payment as a customer credit/prepayment.",
    {
      customerName: z.string().optional().describe("Customer full name"),
      customerListId: z.string().optional().describe("Customer ListID"),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("Payment date (YYYY-MM-DD)"),
      refNumber: z.string().optional().describe("Reference/check number"),
      totalAmount: z.number().describe("Total payment amount"),
      paymentMethodName: z.string().optional().describe("Payment method (e.g., Check, Cash, Credit Card)"),
      memo: z.string().optional().describe("Memo"),
      depositToAccountName: z.string().optional().describe("Account to deposit payment into"),
      appliedTo: z.array(appliedToSchema).optional()
        .describe("Optional invoice applications. Each entry closes out part or all of an invoice's BalanceRemaining. sum(appliedTo.amount) must be <= totalAmount; the difference becomes UnusedPayment (a customer credit)."),
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original result without creating a duplicate payment (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open."),
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

      if (args.appliedTo && args.appliedTo.length > 0) {
        const sumApplied = args.appliedTo.reduce((acc, line) => acc + line.amount, 0);
        if (sumApplied > args.totalAmount + 1e-9) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: `sum(appliedTo.amount) = ${sumApplied} exceeds totalAmount = ${args.totalAmount}`,
              }),
            }],
            isError: true,
          };
        }
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

      if (args.appliedTo && args.appliedTo.length > 0) {
        data.AppliedToTxnAdd = args.appliedTo.map((line) => {
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
              payment: result,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "ReceivePaymentAddRq failed" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // Apply payment to invoices (re-target an existing ReceivePayment)
  // -----------------------------------------------------------------------
  server.tool(
    "qb_payment_apply",
    "Re-apply an existing ReceivePayment to a different set of invoices via ReceivePaymentMod + AppliedToTxnMod. Pass txnId + editSequence (from a prior qb_payment_list — EditSequence is strict, stale rejects with 3170) plus an applyTo array. The new applyTo set REPLACES the payment's existing application wholesale: invoices the payment was previously applied to are reversed (their BalanceRemaining / AppliedAmount / IsPaid restored), the new invoices receive the new application. Customer balance moves by the change in applied sum (new applied − old applied). Optional header fields (memo, refNumber, txnDate, paymentMethodName) propagate. TotalAmount is immutable on this path — to change the payment amount, delete and recreate. sum(applyTo.amount) > totalAmount rejects with statusCode 500.",
    {
      txnId: z.string().describe("TxnID of the ReceivePayment to re-apply"),
      editSequence: z.string().describe("EditSequence from a prior qb_payment_list — must match or the mod is rejected with statusCode 3170"),
      applyTo: z.array(appliedToSchema)
        .describe("Replacement application set. Pass an empty array to fully unapply the payment (it becomes pure customer credit)."),
      memo: z.string().optional().describe("New memo"),
      refNumber: z.string().optional().describe("New reference/check number"),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("New payment date (YYYY-MM-DD)"),
      paymentMethodName: z.string().optional().describe("New payment method"),
    },
    async (args) => {
      const session = getSession();

      const data: Record<string, unknown> = {
        TxnID: args.txnId,
        EditSequence: args.editSequence,
      };

      if (args.memo) data.Memo = args.memo;
      if (args.refNumber) data.RefNumber = args.refNumber;
      if (args.txnDate) data.TxnDate = args.txnDate;
      if (args.paymentMethodName) {
        data.PaymentMethodRef = { FullName: args.paymentMethodName };
      }

      data.AppliedToTxnMod = args.applyTo.map((line) => {
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

      try {
        const result = await session.modifyEntity("ReceivePayment", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, payment: result }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "ReceivePaymentModRq failed" });
      }
    }
  );

  server.tool(
    "qb_payment_list",
    "List received payments in QuickBooks Desktop.",
    {
      customerName: z.string().optional().describe("Filter by customer name"),
      fromDate: z.string().regex(ISO_DATE_RE).optional().describe("Start date (YYYY-MM-DD)"),
      toDate: z.string().regex(ISO_DATE_RE).optional().describe("End date (YYYY-MM-DD)"),
      maxReturned: z.number().optional().describe("Maximum results"),
    },
    async (args) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      // ReceivePaymentQueryRq schema-required child order (see invoices.ts).
      if (args.maxReturned) filters.MaxReturned = args.maxReturned;
      if (args.fromDate || args.toDate) {
        filters.TxnDateRangeFilter = { FromTxnDate: args.fromDate, ToTxnDate: args.toDate };
      }
      if (args.customerName) {
        filters.EntityFilter = { FullName: args.customerName };
      }

      try {
        const payments = await session.queryEntity("ReceivePayment", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: payments.length, payments }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "ReceivePaymentQueryRq failed" });
      }
    }
  );

}
