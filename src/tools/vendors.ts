/**
 * Vendor management tools for QuickBooks Desktop MCP.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";
import { EMAIL_RE, PHONE_RE, POSTAL_RE } from "../util/validators.js";

export function registerVendorTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_vendor_list",
    "List or search vendors in QuickBooks Desktop.",
    {
      nameFilter: z.string().optional().describe("Filter vendors by name (partial match)"),
      activeOnly: z.boolean().optional().describe("Only return active vendors (default true)"),
      maxReturned: z.number().optional().describe("Maximum number of results"),
      listId: z.string().optional().describe("Fetch a specific vendor by ListID"),
    },
    async ({ nameFilter, activeOnly, maxReturned, listId }) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      // VendorQueryRq schema-required child order (see customers.ts).
      if (listId) filters.ListID = listId;
      if (maxReturned) filters.MaxReturned = maxReturned;
      if (activeOnly !== false) filters.ActiveStatus = "ActiveOnly";
      if (nameFilter) filters.NameFilter = { MatchCriterion: "Contains", Name: nameFilter };

      try {
        const vendors = await session.queryEntity("Vendor", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: vendors.length, vendors }, null, 2),
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
              statusMessage: e.message ?? "VendorQueryRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_vendor_add",
    "Create a new vendor in QuickBooks Desktop.",
    {
      name: z.string().describe("Vendor name (must be unique)"),
      companyName: z.string().optional().describe("Company name"),
      firstName: z.string().optional().describe("Contact first name"),
      lastName: z.string().optional().describe("Contact last name"),
      phone: z.string().regex(PHONE_RE).optional().describe("Phone number"),
      email: z.string().regex(EMAIL_RE).optional().describe("Email address"),
      accountNumber: z.string().optional().describe("Account number"),
      addr1: z.string().optional().describe("Address line 1"),
      city: z.string().optional().describe("City"),
      state: z.string().optional().describe("State"),
      postalCode: z.string().regex(POSTAL_RE).optional().describe("Postal code"),
      notes: z.string().optional().describe("Notes about the vendor"),
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original result without creating a duplicate QB record (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open."),
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

      if (args.addr1 || args.city || args.state || args.postalCode) {
        data.VendorAddress = {
          Addr1: args.addr1,
          City: args.city,
          State: args.state,
          PostalCode: args.postalCode,
        };
      }

      try {
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent("Vendor", data, args.idempotencyKey)
          : { entity: await session.addEntity("Vendor", data), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              vendor: result,
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
              statusMessage: e.message ?? "VendorAddRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_vendor_update",
    "Update an existing vendor in QuickBooks Desktop.",
    {
      listId: z.string().describe("ListID of the vendor to update"),
      editSequence: z.string().describe("EditSequence for optimistic locking"),
      name: z.string().optional().describe("New vendor name"),
      companyName: z.string().optional().describe("New company name"),
      phone: z.string().regex(PHONE_RE).optional().describe("New phone number"),
      email: z.string().regex(EMAIL_RE).optional().describe("New email address"),
      isActive: z.boolean().optional().describe("Set active/inactive status"),
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
      if (args.phone) data.Phone = args.phone;
      if (args.email) data.Email = args.email;
      if (args.isActive !== undefined) data.IsActive = args.isActive;
      if (args.notes) data.Notes = args.notes;

      try {
        const result = await session.modifyEntity("Vendor", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, vendor: result }, null, 2),
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
              statusMessage: e.message ?? "VendorModRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_vendor_delete",
    "Delete a vendor from QuickBooks Desktop. WARNING: Irreversible.",
    {
      listId: z.string().describe("ListID of the vendor to delete"),
    },
    async ({ listId }) => {
      const session = getSession();
      try {
        const result = await session.deleteEntity("Vendor", listId);
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
              statusMessage: e.message ?? "ListDelRq (Vendor) failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
