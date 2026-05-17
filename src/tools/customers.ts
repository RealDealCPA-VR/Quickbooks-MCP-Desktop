/**
 * Customer management tools for QuickBooks Desktop MCP.
 *
 * Provides CRUD operations for customer records in QuickBooks.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { formatToolError } from "../util/format-tool-error.js";
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
    "List or search customers in QuickBooks. Returns customer records matching filters. Set paginate:true to use iterator-based pagination — first call returns iteratorID + iteratorRemainingCount; pass iteratorID back on subsequent calls until iteratorRemainingCount === 0. When paginate is enabled, maxReturned defaults to 500 (QB's per-batch cap) if unset. Set includeCustomFields:true to surface DataExtRet (custom-field) values on every returned customer — discover defined CFs via qb_custom_field_list.",
    {
      nameFilter: z.string().optional().describe("Filter customers by name (partial match)"),
      activeOnly: z.boolean().optional().describe("Only return active customers (default true)"),
      maxReturned: z.number().optional().describe("Maximum number of results. Defaults to 500 when paginate is enabled (QB's per-batch cap); otherwise QB-driven."),
      listId: z.string().optional().describe("Fetch a specific customer by ListID"),
      paginate: z.boolean().optional().describe("Enable iterator-based pagination (real QB caps each *QueryRq response at ~500 rows). Response surfaces iteratorRemainingCount + iteratorID. Auto-defaults maxReturned to 500 if unset."),
      iteratorID: z.string().optional().describe("Continue an existing iterator by passing the iteratorID from a prior paginated response. Implies paginate."),
      includeCustomFields: z.boolean().optional().describe("Include DataExtRet (custom-field values) on every returned customer. Pass the OwnerID namespace via customFieldOwnerId (default '0' — the standard company-defined namespace). Stripped by default to keep payloads lean; discover defined CFs via qb_custom_field_list."),
      customFieldOwnerId: z.string().optional().describe("OwnerID namespace to scope DataExtRet to. Default '0' (standard company-defined fields). Only meaningful when includeCustomFields:true."),
    },
    async ({ nameFilter, activeOnly, maxReturned, listId, paginate, iteratorID, includeCustomFields, customFieldOwnerId }) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      // Pagination requires MaxReturned — QB rejects iterator requests without it
      // ("There is a missing element: MaxReturned"). Default to 500 (QB's
      // effective per-batch cap) when the caller flips paginate on but doesn't
      // specify a value, so `paginate: true` alone is a usable contract.
      const effectiveMaxReturned =
        maxReturned ?? (paginate || iteratorID ? 500 : undefined);

      // QBXML schema for CustomerQueryRq (and every other *QueryRq with the
      // standard filter sequence) requires children in this order, per the
      // <xs:sequence> in qbxmlops*.xml:
      //   ListID/FullName (selector group, exclusive with filter group) →
      //   MaxReturned → ActiveStatus → FromModifiedDate/ToModifiedDate →
      //   NameFilter/NameRangeFilter → (type-specific tail)
      // Out-of-order children get rejected with "QuickBooks found an error
      // when parsing the provided XML text stream" — observed live, not
      // surfaced by simulation since SimulationStore.handleQuery ignores
      // child ordering.
      if (listId) {
        filters.ListID = listId;
      }
      if (effectiveMaxReturned) {
        filters.MaxReturned = effectiveMaxReturned;
      }
      if (activeOnly !== false) {
        filters.ActiveStatus = "ActiveOnly";
      }
      if (nameFilter) {
        filters.NameFilter = { MatchCriterion: "Contains", Name: nameFilter };
      }
      // Phase 13 #61 — OwnerID slots at the END of the *QueryRq filter
      // sequence (after the type-specific tail). buildQueryRequest preserves
      // insertion order so populating it last produces schema-compliant XML.
      if (includeCustomFields) {
        filters.OwnerID = customFieldOwnerId ?? "0";
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
        return formatToolError(err, { fallbackMessage: "CustomerQueryRq failed" });
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
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent("Customer", data, args.idempotencyKey)
          : { entity: await session.addEntity("Customer", data), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              customer: result,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "CustomerAddRq failed" });
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
        return formatToolError(err, { fallbackMessage: "CustomerModRq failed" });
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
        return formatToolError(err, { fallbackMessage: "ListDelRq (Customer) failed" });
      }
    }
  );
}
