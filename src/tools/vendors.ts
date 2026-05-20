/**
 * Vendor management tools for QuickBooks Desktop MCP.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { formatToolError } from "../util/format-tool-error.js";
import { EMAIL_RE, PHONE_RE, POSTAL_RE } from "../util/validators.js";

export function registerVendorTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_vendor_list",
    "List or search vendors in QuickBooks Desktop. Set paginate:true to use iterator-based pagination — first call returns iteratorID + iteratorRemainingCount; pass iteratorID back on subsequent calls until iteratorRemainingCount === 0. Set autoExhaust:true (Phase 16 #73) to fully exhaust the iterator server-side and return the merged result in one call — caps at maxBatches (default 20 = ~10k rows). When paginate or autoExhaust is enabled, maxReturned defaults to 500 (QB's per-batch cap) if unset. Set includeCustomFields:true to surface DataExtRet (custom-field) values on every returned vendor — discover defined CFs via qb_custom_field_list.",
    {
      nameFilter: z.string().optional().describe("Filter vendors by name (partial match)"),
      activeOnly: z.boolean().optional().describe("Only return active vendors (default true)"),
      maxReturned: z.number().optional().describe("Maximum number of results per wire batch. Defaults to 500 when paginate or autoExhaust is enabled (QB's per-batch cap); otherwise QB-driven."),
      listId: z.string().optional().describe("Fetch a specific vendor by ListID"),
      paginate: z.boolean().optional().describe("Enable iterator-based pagination (real QB caps each *QueryRq response at ~500 rows). Response surfaces iteratorRemainingCount + iteratorID. Auto-defaults maxReturned to 500 if unset. Mutually exclusive with autoExhaust."),
      iteratorID: z.string().optional().describe("Continue an existing iterator by passing the iteratorID from a prior paginated response. Implies paginate. Mutually exclusive with autoExhaust (autoExhaust always starts a fresh iterator)."),
      autoExhaust: z.boolean().optional().describe("Phase 16 #73: server-side iterator exhaustion. Loops queryEntityPaginated until iteratorRemainingCount === 0 (or maxBatches cap) and returns the merged result as ONE response — collapses N tool round trips for a large dump into 1. Hard-capped by maxBatches (default 20 = ~10k rows). Cap-hit returns the partial result + final iteratorID for caller-driven resumption. Mutually exclusive with paginate / iteratorID."),
      maxBatches: z.number().int().positive().optional().describe("Safety cap on autoExhaust batch count (default 20). Each batch is one wire round trip to QuickBooks Desktop (~500 rows per batch). Only meaningful when autoExhaust:true."),
      includeCustomFields: z.boolean().optional().describe("Include DataExtRet (custom-field values) on every returned vendor. Pass the OwnerID namespace via customFieldOwnerId (default '0')."),
      customFieldOwnerId: z.string().optional().describe("OwnerID namespace to scope DataExtRet to. Default '0' (standard company-defined fields). Only meaningful when includeCustomFields:true."),
    },
    async ({ nameFilter, activeOnly, maxReturned, listId, paginate, iteratorID, autoExhaust, maxBatches, includeCustomFields, customFieldOwnerId }) => {
      const session = getSession();

      // Phase 16 #73 — autoExhaust mutex (see customers.ts pilot).
      if (autoExhaust && (paginate || iteratorID)) {
        return formatToolError(
          new Error("autoExhaust is mutually exclusive with paginate / iteratorID — autoExhaust starts a fresh iterator server-side and runs it to completion"),
          { fallbackMessage: "Invalid arguments" }
        );
      }

      const filters: Record<string, unknown> = {};

      const effectiveMaxReturned =
        maxReturned ?? (paginate || iteratorID || autoExhaust ? 500 : undefined);

      // VendorQueryRq schema-required child order (see customers.ts).
      if (listId) filters.ListID = listId;
      if (effectiveMaxReturned) filters.MaxReturned = effectiveMaxReturned;
      if (activeOnly !== false) filters.ActiveStatus = "ActiveOnly";
      if (nameFilter) filters.NameFilter = { MatchCriterion: "Contains", Name: nameFilter };
      // Phase 13 #61 — OwnerID slots at the END of the *QueryRq filter sequence.
      if (includeCustomFields) filters.OwnerID = customFieldOwnerId ?? "0";

      try {
        if (autoExhaust) {
          // Phase 16 #73 — loop queryEntityPaginated until exhausted OR
          // maxBatches cap. Each iteration is one wire round trip to QB.
          const cap = maxBatches ?? 20;
          const accumulated: Record<string, unknown>[] = [];
          let nextIteratorID: string | undefined;
          let batches = 0;
          let remaining = Infinity;
          let capHit = false;
          while (remaining > 0) {
            if (batches >= cap) {
              capHit = true;
              break;
            }
            const batch = await session.queryEntityPaginated("Vendor", filters, {
              iterator: batches === 0 ? "Start" : "Continue",
              iteratorID: nextIteratorID,
            });
            accumulated.push(...batch.entities);
            batches += 1;
            remaining = batch.iteratorRemainingCount ?? 0;
            nextIteratorID = batch.iteratorID;
          }
          const warnings: string[] = [];
          if (capHit) {
            warnings.push(
              `autoExhaust cap hit after ${batches} batches (~${accumulated.length} rows accumulated). Increase maxBatches or resume via iteratorID. NOTE: iteratorID resumption only works against live QB — simulation does not maintain cross-call iterator state.`
            );
          }
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                count: accumulated.length,
                vendors: accumulated,
                batchesExhausted: batches,
                ...(capHit && nextIteratorID
                  ? { iteratorID: nextIteratorID, iteratorRemainingCount: remaining }
                  : {}),
                ...(warnings.length ? { warnings } : {}),
              }, null, 2),
            }],
          };
        }

        if (paginate || iteratorID) {
          const result = await session.queryEntityPaginated("Vendor", filters, {
            iterator: iteratorID ? "Continue" : "Start",
            iteratorID,
          });
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                count: result.entities.length,
                vendors: result.entities,
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

        const vendors = await session.queryEntity("Vendor", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: vendors.length, vendors }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "VendorQueryRq failed" });
      }
    }
  );

  server.tool(
    "qb_vendor_add",
    "Create a new vendor in QuickBooks Desktop. Pass `dryRun: true` to preview without committing.",
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
      dryRun: z.boolean().optional().describe("If true, preview what this call WOULD do without committing. See qb_customer_add's dryRun docs for the full composition matrix."),
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

      if (args.dryRun) {
        try {
          const preview = await session.addEntityDryRun("Vendor", data, args.idempotencyKey);
          const { entity, ...rest } = preview;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                dryRun: true,
                ...rest,
                ...(entity ? { vendor: entity } : {}),
              }, null, 2),
            }],
          };
        } catch (err) {
          return formatToolError(err, { fallbackMessage: "VendorAddRq dry-run failed" });
        }
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
        return formatToolError(err, { fallbackMessage: "VendorAddRq failed" });
      }
    }
  );

  server.tool(
    "qb_vendor_update",
    "Update an existing vendor in QuickBooks Desktop. Pass `dryRun: true` to preview without committing.",
    {
      listId: z.string().describe("ListID of the vendor to update"),
      editSequence: z.string().describe("EditSequence for optimistic locking"),
      name: z.string().optional().describe("New vendor name"),
      companyName: z.string().optional().describe("New company name"),
      phone: z.string().regex(PHONE_RE).optional().describe("New phone number"),
      email: z.string().regex(EMAIL_RE).optional().describe("New email address"),
      isActive: z.boolean().optional().describe("Set active/inactive status"),
      notes: z.string().optional().describe("New notes"),
      dryRun: z.boolean().optional().describe("If true, preview what this call WOULD do without committing. See qb_customer_add's dryRun docs for the full composition matrix."),
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

      if (args.dryRun) {
        try {
          const preview = await session.modifyEntityDryRun("Vendor", data);
          const { entity, ...rest } = preview;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                dryRun: true,
                ...rest,
                ...(entity ? { vendor: entity } : {}),
              }, null, 2),
            }],
          };
        } catch (err) {
          return formatToolError(err, { fallbackMessage: "VendorModRq dry-run failed" });
        }
      }

      try {
        const result = await session.modifyEntity("Vendor", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, vendor: result }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "VendorModRq failed" });
      }
    }
  );

  server.tool(
    "qb_vendor_delete",
    "Delete a vendor from QuickBooks Desktop. WARNING: Irreversible. Pass `dryRun: true` to preview without committing.",
    {
      listId: z.string().describe("ListID of the vendor to delete"),
      dryRun: z.boolean().optional().describe("If true, preview what this call WOULD do without committing. See qb_invoice_delete's dryRun docs for the full composition matrix."),
    },
    async ({ listId, dryRun }) => {
      const session = getSession();
      if (dryRun) {
        try {
          const preview = await session.deleteEntityDryRun("Vendor", listId);
          const { entity, ...rest } = preview;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                dryRun: true,
                ...rest,
                ...(entity ? { deleted: entity } : {}),
              }, null, 2),
            }],
          };
        } catch (err) {
          return formatToolError(err, { fallbackMessage: "ListDelRq (Vendor) dry-run failed" });
        }
      }

      try {
        const result = await session.deleteEntity("Vendor", listId);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, deleted: result }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "ListDelRq (Vendor) failed" });
      }
    }
  );
}
