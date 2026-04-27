/**
 * Customer management tools for QuickBooks Desktop MCP.
 *
 * Provides CRUD operations for customer records in QuickBooks.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";
import { EMAIL_RE, PHONE_RE, POSTAL_RE } from "../util/validators.js";

export function registerCustomerTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  // -----------------------------------------------------------------------
  // List / query customers
  // -----------------------------------------------------------------------
  server.tool(
    "qb_customer_list",
    "List or search customers in QuickBooks. Returns customer records matching filters. Set paginate:true to use iterator-based pagination — first call returns iteratorID + iteratorRemainingCount; pass iteratorID back on subsequent calls until iteratorRemainingCount === 0.",
    {
      nameFilter: z.string().optional().describe("Filter customers by name (partial match)"),
      activeOnly: z.boolean().optional().describe("Only return active customers (default true)"),
      maxReturned: z.number().optional().describe("Maximum number of results (default 100)"),
      listId: z.string().optional().describe("Fetch a specific customer by ListID"),
      paginate: z.boolean().optional().describe("Enable iterator-based pagination (real QB caps each *QueryRq response at ~500 rows). Response surfaces iteratorRemainingCount + iteratorID."),
      iteratorID: z.string().optional().describe("Continue an existing iterator by passing the iteratorID from a prior paginated response. Implies paginate."),
    },
    async ({ nameFilter, activeOnly, maxReturned, listId, paginate, iteratorID }) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      if (listId) {
        filters.ListID = listId;
      }
      if (nameFilter) {
        filters.NameFilter = { MatchCriterion: "Contains", Name: nameFilter };
      }
      if (activeOnly !== false) {
        filters.ActiveStatus = "ActiveOnly";
      }
      if (maxReturned) {
        filters.MaxReturned = maxReturned;
      }

      try {
        if (paginate || iteratorID) {
          const result = await session.queryEntityPaginated("Customer", filters, {
            iterator: iteratorID ? "Continue" : "Start",
            iteratorID,
          });
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                count: result.entities.length,
                customers: result.entities,
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

        const customers = await session.queryEntity("Customer", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              count: customers.length,
              customers,
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
              statusMessage: e.message ?? "CustomerQueryRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Add customer
  // -----------------------------------------------------------------------
  server.tool(
    "qb_customer_add",
    "Create a new customer in QuickBooks Desktop.",
    {
      name: z.string().describe("Customer name (must be unique in QuickBooks)"),
      companyName: z.string().optional().describe("Company name"),
      firstName: z.string().optional().describe("Contact first name"),
      lastName: z.string().optional().describe("Contact last name"),
      phone: z.string().regex(PHONE_RE).optional().describe("Phone number"),
      email: z.string().regex(EMAIL_RE).optional().describe("Email address"),
      billAddr1: z.string().optional().describe("Billing address line 1"),
      billCity: z.string().optional().describe("Billing city"),
      billState: z.string().optional().describe("Billing state"),
      billPostalCode: z.string().regex(POSTAL_RE).optional().describe("Billing postal code"),
      billCountry: z.string().optional().describe("Billing country"),
      accountNumber: z.string().optional().describe("Account number for the customer"),
      notes: z.string().optional().describe("Notes about the customer"),
    },
    async (args) => {
      const session = getSession();
      const data: Record<string, unknown> = { Name: args.name };

      if (args.companyName) data.CompanyName = args.companyName;
      if (args.firstName) data.FirstName = args.firstName;
      if (args.lastName) data.LastName = args.lastName;
      if (args.phone) data.Phone = args.phone;
      if (args.email) data.Email = args.email;
      if (args.accountNumber) data.AccountNumber = args.accountNumber;
      if (args.notes) data.Notes = args.notes;

      if (args.billAddr1 || args.billCity || args.billState || args.billPostalCode) {
        data.BillAddress = {
          Addr1: args.billAddr1,
          City: args.billCity,
          State: args.billState,
          PostalCode: args.billPostalCode,
          Country: args.billCountry,
        };
      }

      try {
        const result = await session.addEntity("Customer", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, customer: result }, null, 2),
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
              statusMessage: e.message ?? "CustomerAddRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Modify customer
  // -----------------------------------------------------------------------
  server.tool(
    "qb_customer_update",
    "Update an existing customer in QuickBooks Desktop.",
    {
      listId: z.string().describe("ListID of the customer to update"),
      editSequence: z.string().describe("EditSequence for optimistic locking"),
      name: z.string().optional().describe("New customer name"),
      companyName: z.string().optional().describe("New company name"),
      firstName: z.string().optional().describe("New first name"),
      lastName: z.string().optional().describe("New last name"),
      phone: z.string().regex(PHONE_RE).optional().describe("New phone number"),
      email: z.string().regex(EMAIL_RE).optional().describe("New email address"),
      isActive: z.boolean().optional().describe("Set active/inactive status"),
      accountNumber: z.string().optional().describe("New account number"),
      notes: z.string().optional().describe("New notes"),
    },
    async (args) => {
      const session = getSession();
      const data: Record<string, unknown> = {
        ListID: args.listId,
        EditSequence: args.editSequence,
      };

      if (args.name) data.Name = args.name;
      if (args.companyName) data.CompanyName = args.companyName;
      if (args.firstName) data.FirstName = args.firstName;
      if (args.lastName) data.LastName = args.lastName;
      if (args.phone) data.Phone = args.phone;
      if (args.email) data.Email = args.email;
      if (args.isActive !== undefined) data.IsActive = args.isActive;
      if (args.accountNumber) data.AccountNumber = args.accountNumber;
      if (args.notes) data.Notes = args.notes;

      try {
        const result = await session.modifyEntity("Customer", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, customer: result }, null, 2),
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
              statusMessage: e.message ?? "CustomerModRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Delete customer
  // -----------------------------------------------------------------------
  server.tool(
    "qb_customer_delete",
    "Delete a customer from QuickBooks Desktop. WARNING: This is irreversible.",
    {
      listId: z.string().describe("ListID of the customer to delete"),
    },
    async ({ listId }) => {
      const session = getSession();
      try {
        const result = await session.deleteEntity("Customer", listId);
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
              statusMessage: e.message ?? "ListDelRq (Customer) failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
