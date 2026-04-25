/**
 * Vendor management tools for QuickBooks Desktop MCP.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";

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

      if (listId) filters.ListID = listId;
      if (nameFilter) filters.NameFilter = { MatchCriterion: "Contains", Name: nameFilter };
      if (activeOnly !== false) filters.ActiveStatus = "ActiveOnly";
      if (maxReturned) filters.MaxReturned = maxReturned;

      const vendors = await session.queryEntity("Vendor", filters);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ count: vendors.length, vendors }, null, 2),
        }],
      };
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
      phone: z.string().optional().describe("Phone number"),
      email: z.string().optional().describe("Email address"),
      accountNumber: z.string().optional().describe("Account number"),
      addr1: z.string().optional().describe("Address line 1"),
      city: z.string().optional().describe("City"),
      state: z.string().optional().describe("State"),
      postalCode: z.string().optional().describe("Postal code"),
      notes: z.string().optional().describe("Notes about the vendor"),
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

      const result = await session.addEntity("Vendor", data);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, vendor: result }, null, 2),
        }],
      };
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
      phone: z.string().optional().describe("New phone number"),
      email: z.string().optional().describe("New email address"),
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

      const result = await session.modifyEntity("Vendor", data);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, vendor: result }, null, 2),
        }],
      };
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
      const result = await session.deleteEntity("Vendor", listId);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, deleted: result }, null, 2),
        }],
      };
    }
  );
}
