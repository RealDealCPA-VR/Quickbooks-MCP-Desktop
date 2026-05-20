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
    "List or search customers in QuickBooks. Returns customer records matching filters. Set paginate:true to use iterator-based pagination — first call returns iteratorID + iteratorRemainingCount; pass iteratorID back on subsequent calls until iteratorRemainingCount === 0. When paginate is enabled, maxReturned defaults to 500 (QB's per-batch cap) if unset. Set includeCustomFields:true to surface DataExtRet (custom-field) values on every returned customer — discover defined CFs via qb_custom_field_list. Hierarchy filters (parentListID / jobOnly) are POST-FILTERED — QBXML's CustomerQueryRq has no ParentRef filter at any version through 16.0; the wire query returns the full set (or paginated batch) and the tool filters in-process. Combine with includeInactive carefully under paginate — see qb_customer_jobs for an entity-scoped alternative that pre-validates the parent.",
    {
      nameFilter: z.string().optional().describe("Filter customers by name (partial match)"),
      activeOnly: z.boolean().optional().describe("Only return active customers (default true)"),
      maxReturned: z.number().optional().describe("Maximum number of results. Defaults to 500 when paginate is enabled (QB's per-batch cap); otherwise QB-driven."),
      listId: z.string().optional().describe("Fetch a specific customer by ListID"),
      paginate: z.boolean().optional().describe("Enable iterator-based pagination (real QB caps each *QueryRq response at ~500 rows). Response surfaces iteratorRemainingCount + iteratorID. Auto-defaults maxReturned to 500 if unset."),
      iteratorID: z.string().optional().describe("Continue an existing iterator by passing the iteratorID from a prior paginated response. Implies paginate."),
      includeCustomFields: z.boolean().optional().describe("Include DataExtRet (custom-field values) on every returned customer. Pass the OwnerID namespace via customFieldOwnerId (default '0' — the standard company-defined namespace). Stripped by default to keep payloads lean; discover defined CFs via qb_custom_field_list."),
      customFieldOwnerId: z.string().optional().describe("OwnerID namespace to scope DataExtRet to. Default '0' (standard company-defined fields). Only meaningful when includeCustomFields:true."),
      parentListID: z.string().optional().describe("POST-FILTER: return only direct children (jobs) of the customer with this ListID. QBXML has no ParentRef filter at the wire level so this is applied in-process after the wire query — combine with paginate carefully (matches past the first batch may be missed). For an entity-scoped equivalent that pre-validates the parent and supports recursive descendants, use qb_customer_jobs."),
      jobOnly: z.boolean().optional().describe("POST-FILTER: return only sub-customers (jobs) — customers carrying a ParentRef. Excludes top-level customers (Sublevel 0). Same post-filter caveat under paginate."),
    },
    async ({ nameFilter, activeOnly, maxReturned, listId, paginate, iteratorID, includeCustomFields, customFieldOwnerId, parentListID, jobOnly }) => {
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

      // Phase 13 #62 — Hierarchy filters are POST-applied. CustomerQueryRq's
      // <xs:sequence> has NO ParentRef child at any version through 16.0, so
      // these can't be pushed to the wire. The wire returns the full set
      // (or paginated batch) and we filter in-process.
      const applyHierarchyFilters = (rows: Record<string, unknown>[]) => {
        let out = rows;
        if (parentListID) {
          out = out.filter((c) => {
            const ref = c.ParentRef as Record<string, unknown> | undefined;
            return ref?.ListID === parentListID;
          });
        }
        if (jobOnly) {
          out = out.filter((c) => c.ParentRef !== undefined);
        }
        return out;
      };

      try {
        if (paginate || iteratorID) {
          const result = await session.queryEntityPaginated("Customer", filters, {
            iterator: iteratorID ? "Continue" : "Start",
            iteratorID,
          });
          const filtered = applyHierarchyFilters(result.entities);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                count: filtered.length,
                customers: filtered,
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
        const filtered = applyHierarchyFilters(customers);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              count: filtered.length,
              customers: filtered,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "CustomerQueryRq failed" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // List sub-customers (jobs) of a given parent (Phase 13 #62)
  // -----------------------------------------------------------------------
  //
  // Walks the customer list with ParentRef post-filtering scoped to one
  // parent. Distinct from qb_customer_list's parentListID/jobOnly post-
  // filters in three ways:
  //   1. Pre-flight resolves the parent (parentListId | parentName), so an
  //      unknown parent rejects with 3120 instead of silently returning an
  //      empty array.
  //   2. recursive:true walks descendants by FullName-prefix match — picks
  //      up sub-jobs (Sublevel 2+) under the named parent. The list-tool
  //      filter is direct-children-only.
  //   3. Response shape includes the resolved parent context (listId,
  //      fullName, balance) so the caller has the hierarchy header without
  //      a second round trip.
  //
  // QBXML has no ParentRef filter at the wire level (CustomerQueryRq's
  // <xs:sequence> doesn't include one at any version through 16.0), so this
  // is a wire-query + post-filter composite — same pattern qb_transaction_list
  // uses for customer-side scoping.
  server.tool(
    "qb_customer_jobs",
    "List the sub-customers (jobs) of a given parent customer. Pass parentListId OR parentName (mutually exclusive — both rejects 3120). Returns the parent context (listId, fullName, balance) plus the jobs array sorted by Sublevel ascending then FullName. Default returns direct children only (one Sublevel below the parent); pass recursive:true to walk all descendants by FullName-prefix match. Use this instead of qb_customer_list({parentListID}) when you want pre-flight parent validation (unknown parent rejects 3120 vs. silent empty array) or recursive descendant traversal. Composite tool — wraps CustomerQueryRq with post-filter; no new wire types.",
    {
      parentListId: z.string().optional().describe("ListID of the parent customer. Mutually exclusive with parentName."),
      parentName: z.string().optional().describe("FullName of the parent customer (e.g. 'Acme Corporation' or 'Acme Corporation:2024 Audit' for a sub-parent). Mutually exclusive with parentListId."),
      recursive: z.boolean().optional().describe("If true, walks ALL descendants under the parent (sub-jobs, sub-sub-jobs) by FullName-prefix match. Default false = direct children only (one Sublevel below parent)."),
      includeInactive: z.boolean().optional().describe("Include inactive sub-customers (jobs marked IsActive:false in QB). Default false."),
      includeCustomFields: z.boolean().optional().describe("Include DataExtRet (custom-field values) on every returned job. Pass the OwnerID namespace via customFieldOwnerId (default '0')."),
      customFieldOwnerId: z.string().optional().describe("OwnerID namespace to scope DataExtRet to. Default '0'. Only meaningful when includeCustomFields:true."),
    },
    async (args) => {
      const session = getSession();
      const { parentListId, parentName, recursive, includeInactive, includeCustomFields, customFieldOwnerId } = args;

      if (parentListId && parentName) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 3120,
              statusMessage: "Pass exactly one of parentListId or parentName, not both",
            }),
          }],
          isError: true,
        };
      }
      if (!parentListId && !parentName) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 3120,
              statusMessage: "One of parentListId or parentName is required",
            }),
          }],
          isError: true,
        };
      }

      try {
        // Pre-flight: resolve the parent. Unknown parent rejects with 3120
        // BEFORE the bulk customer query — saves a wire call AND surfaces a
        // clearer error than "empty jobs array".
        const parentLookup = parentListId
          ? { ListID: parentListId }
          : { FullName: parentName };
        const parentMatches = await session.queryEntity("Customer", parentLookup);
        if (parentMatches.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                statusCode: 3120,
                statusMessage: parentListId
                  ? `Parent customer not found: ListID "${parentListId}"`
                  : `Parent customer not found: FullName "${parentName}"`,
              }),
            }],
            isError: true,
          };
        }
        const parent = parentMatches[0] as Record<string, unknown>;
        const parentListIDResolved = String(parent.ListID ?? "");
        const parentFullName = String(parent.FullName ?? parent.Name ?? "");

        // Bulk pull. Real QB CustomerQueryRq has no ParentRef filter; we
        // pull the full active set and post-filter. Inactive opt-in via
        // ActiveStatus.
        const childFilters: Record<string, unknown> = {};
        if (!includeInactive) childFilters.ActiveStatus = "ActiveOnly";
        if (includeCustomFields) childFilters.OwnerID = customFieldOwnerId ?? "0";
        const allCustomers = await session.queryEntity("Customer", childFilters);

        const fullNamePrefix = `${parentFullName}:`;
        const matches = allCustomers.filter((c) => {
          const row = c as Record<string, unknown>;
          if (recursive) {
            // Descendant walk: every customer whose FullName starts with
            // `Parent:` (and isn't the parent itself). Robust to
            // intermediate-level sub-customers without depending on
            // Sublevel being populated.
            const fn = String(row.FullName ?? "");
            return fn.startsWith(fullNamePrefix) && fn !== parentFullName;
          }
          // Direct children only: ParentRef.ListID === parent's ListID.
          const ref = row.ParentRef as Record<string, unknown> | undefined;
          return ref?.ListID === parentListIDResolved;
        });

        // Sort: Sublevel ascending (parents-first when recursive), then
        // FullName alpha. Stable across runs — same input → same output.
        const sorted = matches.slice().sort((a, b) => {
          const sa = Number((a as Record<string, unknown>).Sublevel ?? 0);
          const sb = Number((b as Record<string, unknown>).Sublevel ?? 0);
          if (sa !== sb) return sa - sb;
          const fa = String((a as Record<string, unknown>).FullName ?? "");
          const fb = String((b as Record<string, unknown>).FullName ?? "");
          return fa.localeCompare(fb);
        });

        const parentBalance = parent.Balance !== undefined ? Number(parent.Balance) : undefined;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              parent: {
                listId: parentListIDResolved,
                fullName: parentFullName,
                ...(parentBalance !== undefined ? { balance: parentBalance } : {}),
              },
              recursive: Boolean(recursive),
              count: sorted.length,
              jobs: sorted,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "qb_customer_jobs failed" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // Add customer
  // -----------------------------------------------------------------------
  server.tool(
    "qb_customer_add",
    "Create a new customer in QuickBooks Desktop. Pass parentListId to create a sub-customer (job) under an existing customer — FullName is derived as `Parent:Child` and Sublevel = parent.Sublevel + 1 (matches real QB). Pass `dryRun: true` to preview what would happen without committing (sim mode returns the entity-after-mutation; live mode returns the built QBXML envelope only).",
    {
      name: z.string().describe("Customer name (must be unique within the parent scope — sub-customers under different parents can share a leaf name)"),
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
      parentListId: z.string().optional().describe("ListID of the parent customer — creates this customer as a SUB-CUSTOMER (job) under that parent. Resulting FullName is `Parent:Child` and Sublevel chains from the parent. Discover candidate parents via qb_customer_list; walk a parent's existing jobs via qb_customer_jobs."),
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original result without creating a duplicate QB record (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open."),
      dryRun: z.boolean().optional().describe("If true, preview what this call WOULD do without committing. Sim mode: returns the entity-after-mutation plus the built QBXML envelope; the sim store is rolled back so no observable side effect remains. Live mode: returns the built QBXML envelope + a `note` explaining that entity-after preview isn't available against real QB data (previewSupported: false). Composes with idempotencyKey — a same-key/same-payload hit reports `wouldReplay: true` (no preview run); a same-key/different-payload conflict reports statusCode 9002. Composes with readOnly mode (dry-run is observationally a read; read-only sessions ALLOW dry-run). Dry-run never writes to the idempotency cache."),
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
      if (args.parentListId) data.ParentRef = { ListID: args.parentListId };

      if (args.billAddr1 || args.billCity || args.billState || args.billPostalCode) {
        data.BillAddress = {
          Addr1: args.billAddr1,
          City: args.billCity,
          State: args.billState,
          PostalCode: args.billPostalCode,
          Country: args.billCountry,
        };
      }

      if (args.dryRun) {
        try {
          const preview = await session.addEntityDryRun("Customer", data, args.idempotencyKey);
          const { entity, ...rest } = preview;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                dryRun: true,
                ...rest,
                ...(entity ? { customer: entity } : {}),
              }, null, 2),
            }],
          };
        } catch (err) {
          return formatToolError(err, { fallbackMessage: "CustomerAddRq dry-run failed" });
        }
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
