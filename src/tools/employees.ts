/**
 * Employee management tools for QuickBooks Desktop MCP.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { formatToolError } from "../util/format-tool-error.js";
import { EMAIL_RE, ISO_DATE_RE, PHONE_RE } from "../util/validators.js";

export function registerEmployeeTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_employee_list",
    "List or search employees in QuickBooks Desktop. Set paginate:true to use iterator-based pagination — first call returns iteratorID + iteratorRemainingCount; pass iteratorID back on subsequent calls until iteratorRemainingCount === 0. Set autoExhaust:true (Phase 16 #73) to fully exhaust the iterator server-side and return the merged result in one call — caps at maxBatches (default 20 = ~10k rows). When paginate or autoExhaust is enabled, maxReturned defaults to 500 (QB's per-batch cap) if unset. Set includeCustomFields:true to surface DataExtRet (custom-field) values per employee.",
    {
      nameFilter: z.string().optional().describe("Filter employees by name"),
      activeOnly: z.boolean().optional().describe("Only return active employees"),
      maxReturned: z.number().optional().describe("Maximum results per wire batch. Defaults to 500 when paginate or autoExhaust is enabled (QB's per-batch cap); otherwise QB-driven."),
      listId: z.string().optional().describe("Fetch a specific employee by ListID"),
      paginate: z.boolean().optional().describe("Enable iterator-based pagination (real QB caps each *QueryRq response at ~500 rows). Response surfaces iteratorRemainingCount + iteratorID. Auto-defaults maxReturned to 500 if unset. Mutually exclusive with autoExhaust."),
      iteratorID: z.string().optional().describe("Continue an existing iterator by passing the iteratorID from a prior paginated response. Implies paginate. Mutually exclusive with autoExhaust (autoExhaust always starts a fresh iterator)."),
      autoExhaust: z.boolean().optional().describe("Phase 16 #73: server-side iterator exhaustion. Loops queryEntityPaginated until iteratorRemainingCount === 0 (or maxBatches cap) and returns the merged result as ONE response — collapses N tool round trips for a large dump into 1. Hard-capped by maxBatches (default 20 = ~10k rows). Cap-hit returns the partial result + final iteratorID for caller-driven resumption. Mutually exclusive with paginate / iteratorID."),
      maxBatches: z.number().int().positive().optional().describe("Safety cap on autoExhaust batch count (default 20). Each batch is one wire round trip to QuickBooks Desktop (~500 rows per batch). Only meaningful when autoExhaust:true."),
      includeCustomFields: z.boolean().optional().describe("Include DataExtRet (custom-field values) on every returned employee. Pass customFieldOwnerId for non-default namespaces."),
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

      // EmployeeQueryRq schema-required child order (see customers.ts).
      if (listId) filters.ListID = listId;
      if (effectiveMaxReturned) filters.MaxReturned = effectiveMaxReturned;
      if (activeOnly !== false) filters.ActiveStatus = "ActiveOnly";
      if (nameFilter) filters.NameFilter = { MatchCriterion: "Contains", Name: nameFilter };
      // Phase 13 #61 — OwnerID slots at the END of the EmployeeQueryRq filter sequence.
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
            const batch = await session.queryEntityPaginated("Employee", filters, {
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
                employees: accumulated,
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
          const result = await session.queryEntityPaginated("Employee", filters, {
            iterator: iteratorID ? "Continue" : "Start",
            iteratorID,
          });
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                count: result.entities.length,
                employees: result.entities,
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

        const employees = await session.queryEntity("Employee", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: employees.length, employees }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "EmployeeQueryRq failed" });
      }
    }
  );

  server.tool(
    "qb_employee_add",
    "Create a new employee record in QuickBooks Desktop.",
    {
      firstName: z.string().describe("Employee first name"),
      lastName: z.string().describe("Employee last name"),
      phone: z.string().regex(PHONE_RE).optional().describe("Phone number"),
      email: z.string().regex(EMAIL_RE).optional().describe("Email address"),
      hiredDate: z.string().regex(ISO_DATE_RE).optional().describe("Hire date (YYYY-MM-DD)"),
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original result without creating a duplicate QB record (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open."),
      dryRun: z.boolean().optional().describe("If true, preview what this call WOULD do without committing. See qb_customer_add's dryRun docs for the full composition matrix."),
    },
    async (args) => {
      const session = getSession();
      const data: Record<string, unknown> = {
        Name: `${args.lastName}, ${args.firstName}`,
        FirstName: args.firstName,
        LastName: args.lastName,
      };

      if (args.phone) data.Phone = args.phone;
      if (args.email) data.Email = args.email;
      if (args.hiredDate) data.HiredDate = args.hiredDate;

      if (args.dryRun) {
        try {
          const preview = await session.addEntityDryRun("Employee", data, args.idempotencyKey);
          const { entity, ...rest } = preview;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                dryRun: true,
                ...rest,
                ...(entity ? { employee: entity } : {}),
              }, null, 2),
            }],
          };
        } catch (err) {
          return formatToolError(err, { fallbackMessage: "EmployeeAddRq dry-run failed" });
        }
      }

      try {
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent("Employee", data, args.idempotencyKey)
          : { entity: await session.addEntity("Employee", data), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              employee: result,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "EmployeeAddRq failed" });
      }
    }
  );

  server.tool(
    "qb_employee_update",
    "Update an existing employee in QuickBooks Desktop.",
    {
      listId: z.string().describe("ListID of the employee to update"),
      editSequence: z.string().describe("EditSequence for optimistic locking"),
      firstName: z.string().optional().describe("New first name"),
      lastName: z.string().optional().describe("New last name"),
      phone: z.string().regex(PHONE_RE).optional().describe("New phone number"),
      email: z.string().regex(EMAIL_RE).optional().describe("New email address"),
      isActive: z.boolean().optional().describe("Set active/inactive status"),
      dryRun: z.boolean().optional().describe("If true, preview what this call WOULD do without committing. See qb_customer_add's dryRun docs for the full composition matrix."),
    },
    async (args) => {
      const session = getSession();
      const data: Record<string, unknown> = {
        ListID: args.listId,
        EditSequence: args.editSequence,
      };

      if (args.firstName) data.FirstName = args.firstName;
      if (args.lastName) data.LastName = args.lastName;
      if (args.firstName && args.lastName) {
        data.Name = `${args.lastName}, ${args.firstName}`;
      }
      if (args.phone) data.Phone = args.phone;
      if (args.email) data.Email = args.email;
      if (args.isActive !== undefined) data.IsActive = args.isActive;

      if (args.dryRun) {
        try {
          const preview = await session.modifyEntityDryRun("Employee", data);
          const { entity, ...rest } = preview;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                dryRun: true,
                ...rest,
                ...(entity ? { employee: entity } : {}),
              }, null, 2),
            }],
          };
        } catch (err) {
          return formatToolError(err, { fallbackMessage: "EmployeeModRq dry-run failed" });
        }
      }

      try {
        const result = await session.modifyEntity("Employee", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, employee: result }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "EmployeeModRq failed" });
      }
    }
  );

  server.tool(
    "qb_employee_make_inactive",
    "Deactivate an employee in QuickBooks Desktop (sets IsActive: false). Preferred over qb_employee_delete because real QB rejects hard deletion of employees with paycheck or timesheet history. Inactive employees no longer appear in the default qb_employee_list view but are preserved (so historical payroll reports still resolve their references). Reversible via qb_employee_update { isActive: true }. Requires listId + editSequence (from a prior qb_employee_list). Pass `dryRun: true` to preview without committing.",
    {
      listId: z.string().describe("ListID of the employee to deactivate"),
      editSequence: z.string().describe("EditSequence for optimistic locking (from a prior qb_employee_list)"),
      dryRun: z.boolean().optional().describe("If true, preview what this call WOULD do without committing. See qb_customer_add's dryRun docs for the full composition matrix."),
    },
    async ({ listId, editSequence, dryRun }) => {
      const session = getSession();
      const data = {
        ListID: listId,
        EditSequence: editSequence,
        IsActive: false,
      };

      if (dryRun) {
        try {
          const preview = await session.modifyEntityDryRun("Employee", data);
          const { entity, ...rest } = preview;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                dryRun: true,
                ...rest,
                ...(entity ? { employee: entity } : {}),
              }, null, 2),
            }],
          };
        } catch (err) {
          return formatToolError(err, { fallbackMessage: "EmployeeModRq (make_inactive) dry-run failed" });
        }
      }

      try {
        const result = await session.modifyEntity("Employee", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, employee: result }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "EmployeeModRq (make_inactive) failed" });
      }
    }
  );

  server.tool(
    "qb_employee_delete",
    "Hard-delete an employee from QuickBooks Desktop. WARNING: real QB rejects deletion of employees with any paycheck, timesheet, or other transaction history (returns statusCode 3260) or with references from other records (3170). Prefer qb_employee_make_inactive for employees with history — it hides the employee from the default list view but preserves the record so historical payroll reports still resolve. Use this tool only for empty employee records created in error. Pass `dryRun: true` to preview without committing.",
    {
      listId: z.string().describe("ListID of the employee to delete"),
      dryRun: z.boolean().optional().describe("If true, preview what this call WOULD do without committing. See qb_invoice_delete's dryRun docs for the full composition matrix."),
    },
    async ({ listId, dryRun }) => {
      const session = getSession();
      if (dryRun) {
        try {
          const preview = await session.deleteEntityDryRun("Employee", listId);
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
          return formatToolError(err, { fallbackMessage: "ListDelRq (Employee) dry-run failed" });
        }
      }

      try {
        const result = await session.deleteEntity("Employee", listId);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, deleted: result }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "ListDelRq (Employee) failed" });
      }
    }
  );
}
