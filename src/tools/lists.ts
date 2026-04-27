/**
 * Reference list tools for QuickBooks Desktop MCP.
 *
 * Thin wrappers over `session.queryEntity` for the supporting types referenced
 * by transactions: Class, Terms, PaymentMethod, SalesRep, CustomerType,
 * VendorType. Operators need these to discover valid `FullName` values to pass
 * to invoice/bill/payment creation. Read-only — no add/update/delete tools
 * here (the operator works in QB itself to define new classes/terms/etc).
 *
 * Terms is the one outlier: real QB splits the underlying type into
 * StandardTerms (fixed-day) and DateDrivenTerms (calendar-day). The default
 * `qb_terms_list` call fans across both stores and merges, mirroring the
 * `qb_bill_payment_list` pattern. Pass `termsType` to scope.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";

export function registerListTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_class_list",
    "List Classes (department / location / cost-center labels) defined in QuickBooks Desktop. Used to discover valid Class names for invoice / bill / journal-entry line classification.",
    {
      nameFilter: z.string().optional().describe("Filter classes by name (Contains match)"),
      activeOnly: z.boolean().optional().describe("Only return active classes (default: true)"),
      maxReturned: z.number().optional().describe("Maximum results"),
      listId: z.string().optional().describe("Fetch a specific class by ListID"),
    },
    async ({ nameFilter, activeOnly, maxReturned, listId }) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      if (listId) filters.ListID = listId;
      if (nameFilter) filters.NameFilter = { MatchCriterion: "Contains", Name: nameFilter };
      if (activeOnly !== false) filters.ActiveStatus = "ActiveOnly";
      if (maxReturned) filters.MaxReturned = maxReturned;

      try {
        const classes = await session.queryEntity("Class", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: classes.length, classes }, null, 2),
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
              statusMessage: e.message ?? "ClassQueryRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_terms_list",
    "List payment Terms (Net 15, Net 30, 2% 10 Net 30, etc.) defined in QuickBooks Desktop. Used to discover valid Terms names for invoice / bill creation. QB splits Terms into two underlying types — StandardTerms (e.g. \"Net 30\" — fixed days from invoice date) and DateDrivenTerms (e.g. \"Due on 15th\" — fixed calendar day). Default fans across both stores and merges; pass `termsType` to scope.",
    {
      nameFilter: z.string().optional().describe("Filter terms by name (Contains match)"),
      activeOnly: z.boolean().optional().describe("Only return active terms (default: true)"),
      termsType: z.enum(["Standard", "DateDriven"]).optional()
        .describe("Filter by terms type. Omit to query both StandardTerms + DateDrivenTerms and merge."),
      maxReturned: z.number().optional().describe("Maximum results (applied per-store when fanning out)"),
      listId: z.string().optional().describe("Fetch specific terms by ListID"),
    },
    async ({ nameFilter, activeOnly, termsType, maxReturned, listId }) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      if (listId) filters.ListID = listId;
      if (nameFilter) filters.NameFilter = { MatchCriterion: "Contains", Name: nameFilter };
      if (activeOnly !== false) filters.ActiveStatus = "ActiveOnly";
      if (maxReturned) filters.MaxReturned = maxReturned;

      const types: ("StandardTerms" | "DateDrivenTerms")[] =
        termsType === "Standard"
          ? ["StandardTerms"]
          : termsType === "DateDriven"
            ? ["DateDrivenTerms"]
            : ["StandardTerms", "DateDrivenTerms"];

      try {
        const results = await Promise.all(
          types.map(async (t) => {
            const entries = await session.queryEntity(t, filters);
            return entries.map((e) => ({ ...e, TermsType: t }));
          })
        );
        const terms = results.flat();

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: terms.length, terms }, null, 2),
          }],
        };
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        const op = types.length === 1 ? `${types[0]}QueryRq` : "Terms*QueryRq";
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? `${op} failed`,
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_payment_method_list",
    "List Payment Methods (Check, Cash, Visa, MasterCard, etc.) defined in QuickBooks Desktop. Used to discover valid PaymentMethod names for ReceivePayment / SalesReceipt / BillPaymentCreditCard creation.",
    {
      nameFilter: z.string().optional().describe("Filter payment methods by name (Contains match)"),
      activeOnly: z.boolean().optional().describe("Only return active payment methods (default: true)"),
      maxReturned: z.number().optional().describe("Maximum results"),
      listId: z.string().optional().describe("Fetch a specific payment method by ListID"),
    },
    async ({ nameFilter, activeOnly, maxReturned, listId }) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      if (listId) filters.ListID = listId;
      if (nameFilter) filters.NameFilter = { MatchCriterion: "Contains", Name: nameFilter };
      if (activeOnly !== false) filters.ActiveStatus = "ActiveOnly";
      if (maxReturned) filters.MaxReturned = maxReturned;

      try {
        const paymentMethods = await session.queryEntity("PaymentMethod", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: paymentMethods.length, paymentMethods }, null, 2),
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
              statusMessage: e.message ?? "PaymentMethodQueryRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_sales_rep_list",
    "List Sales Reps defined in QuickBooks Desktop. Used to discover valid SalesRep initials/names for invoice / sales-receipt creation. SalesRep records are keyed by Initial (e.g. \"JS\") which is what gets stored on the transaction.",
    {
      activeOnly: z.boolean().optional().describe("Only return active sales reps (default: true)"),
      maxReturned: z.number().optional().describe("Maximum results"),
      listId: z.string().optional().describe("Fetch a specific sales rep by ListID"),
    },
    async ({ activeOnly, maxReturned, listId }) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      if (listId) filters.ListID = listId;
      if (activeOnly !== false) filters.ActiveStatus = "ActiveOnly";
      if (maxReturned) filters.MaxReturned = maxReturned;

      try {
        const salesReps = await session.queryEntity("SalesRep", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: salesReps.length, salesReps }, null, 2),
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
              statusMessage: e.message ?? "SalesRepQueryRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_customer_type_list",
    "List Customer Types (Commercial, Residential, Government, etc.) defined in QuickBooks Desktop. Used to discover valid CustomerType names for customer segmentation on add / update.",
    {
      nameFilter: z.string().optional().describe("Filter customer types by name (Contains match)"),
      activeOnly: z.boolean().optional().describe("Only return active customer types (default: true)"),
      maxReturned: z.number().optional().describe("Maximum results"),
      listId: z.string().optional().describe("Fetch a specific customer type by ListID"),
    },
    async ({ nameFilter, activeOnly, maxReturned, listId }) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      if (listId) filters.ListID = listId;
      if (nameFilter) filters.NameFilter = { MatchCriterion: "Contains", Name: nameFilter };
      if (activeOnly !== false) filters.ActiveStatus = "ActiveOnly";
      if (maxReturned) filters.MaxReturned = maxReturned;

      try {
        const customerTypes = await session.queryEntity("CustomerType", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: customerTypes.length, customerTypes }, null, 2),
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
              statusMessage: e.message ?? "CustomerTypeQueryRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_vendor_type_list",
    "List Vendor Types (Supplier, Subcontractor, Service Provider, etc.) defined in QuickBooks Desktop. Used to discover valid VendorType names for vendor segmentation on add / update.",
    {
      nameFilter: z.string().optional().describe("Filter vendor types by name (Contains match)"),
      activeOnly: z.boolean().optional().describe("Only return active vendor types (default: true)"),
      maxReturned: z.number().optional().describe("Maximum results"),
      listId: z.string().optional().describe("Fetch a specific vendor type by ListID"),
    },
    async ({ nameFilter, activeOnly, maxReturned, listId }) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      if (listId) filters.ListID = listId;
      if (nameFilter) filters.NameFilter = { MatchCriterion: "Contains", Name: nameFilter };
      if (activeOnly !== false) filters.ActiveStatus = "ActiveOnly";
      if (maxReturned) filters.MaxReturned = maxReturned;

      try {
        const vendorTypes = await session.queryEntity("VendorType", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: vendorTypes.length, vendorTypes }, null, 2),
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
              statusMessage: e.message ?? "VendorTypeQueryRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
