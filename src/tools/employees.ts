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
    "List or search employees in QuickBooks Desktop. Set includeCustomFields:true to surface DataExtRet (custom-field) values per employee.",
    {
      nameFilter: z.string().optional().describe("Filter employees by name"),
      activeOnly: z.boolean().optional().describe("Only return active employees"),
      maxReturned: z.number().optional().describe("Maximum results"),
      listId: z.string().optional().describe("Fetch a specific employee by ListID"),
      includeCustomFields: z.boolean().optional().describe("Include DataExtRet (custom-field values) on every returned employee. Pass customFieldOwnerId for non-default namespaces."),
      customFieldOwnerId: z.string().optional().describe("OwnerID namespace to scope DataExtRet to. Default '0' (standard company-defined fields). Only meaningful when includeCustomFields:true."),
    },
    async ({ nameFilter, activeOnly, maxReturned, listId, includeCustomFields, customFieldOwnerId }) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      // EmployeeQueryRq schema-required child order (see customers.ts).
      if (listId) filters.ListID = listId;
      if (maxReturned) filters.MaxReturned = maxReturned;
      if (activeOnly !== false) filters.ActiveStatus = "ActiveOnly";
      if (nameFilter) filters.NameFilter = { MatchCriterion: "Contains", Name: nameFilter };
      // Phase 13 #61 — OwnerID slots at the END of the EmployeeQueryRq filter sequence.
      if (includeCustomFields) filters.OwnerID = customFieldOwnerId ?? "0";

      try {
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
    "Deactivate an employee in QuickBooks Desktop (sets IsActive: false). Preferred over qb_employee_delete because real QB rejects hard deletion of employees with paycheck or timesheet history. Inactive employees no longer appear in the default qb_employee_list view but are preserved (so historical payroll reports still resolve their references). Reversible via qb_employee_update { isActive: true }. Requires listId + editSequence (from a prior qb_employee_list).",
    {
      listId: z.string().describe("ListID of the employee to deactivate"),
      editSequence: z.string().describe("EditSequence for optimistic locking (from a prior qb_employee_list)"),
    },
    async ({ listId, editSequence }) => {
      const session = getSession();
      try {
        const result = await session.modifyEntity("Employee", {
          ListID: listId,
          EditSequence: editSequence,
          IsActive: false,
        });
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
    "Hard-delete an employee from QuickBooks Desktop. WARNING: real QB rejects deletion of employees with any paycheck, timesheet, or other transaction history (returns statusCode 3260) or with references from other records (3170). Prefer qb_employee_make_inactive for employees with history — it hides the employee from the default list view but preserves the record so historical payroll reports still resolve. Use this tool only for empty employee records created in error.",
    {
      listId: z.string().describe("ListID of the employee to delete"),
    },
    async ({ listId }) => {
      const session = getSession();
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
