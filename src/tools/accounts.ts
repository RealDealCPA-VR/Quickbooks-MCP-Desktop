/**
 * Chart of Accounts management tools for QuickBooks Desktop MCP.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";

const ACCOUNT_TYPES = [
  "Bank", "AccountsReceivable", "OtherCurrentAsset", "FixedAsset",
  "OtherAsset", "AccountsPayable", "CreditCard", "OtherCurrentLiability",
  "LongTermLiability", "Equity", "Income", "CostOfGoodsSold",
  "Expense", "OtherIncome", "OtherExpense", "NonPosting",
] as const;

export function registerAccountTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_account_list",
    "List the chart of accounts from QuickBooks Desktop. Returns all accounts or filtered by type.",
    {
      accountType: z.string().optional().describe(
        `Filter by account type: ${ACCOUNT_TYPES.join(", ")}`
      ),
      activeOnly: z.boolean().optional().describe("Only return active accounts"),
      nameFilter: z.string().optional().describe("Filter by account name"),
      listId: z.string().optional().describe("Fetch a specific account by ListID"),
    },
    async ({ accountType, activeOnly, nameFilter, listId }) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      if (listId) filters.ListID = listId;
      if (accountType) filters.AccountType = accountType;
      if (nameFilter) filters.NameFilter = { MatchCriterion: "Contains", Name: nameFilter };
      if (activeOnly !== false) filters.ActiveStatus = "ActiveOnly";

      try {
        const accounts = await session.queryEntity("Account", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: accounts.length, accounts }, null, 2),
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
              statusMessage: e.message ?? "AccountQueryRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_account_add",
    "Create a new account in the QuickBooks chart of accounts.",
    {
      name: z.string().describe("Account name"),
      accountType: z.enum(ACCOUNT_TYPES).describe(
        `Account type: ${ACCOUNT_TYPES.join(", ")}`
      ),
      accountNumber: z.string().optional().describe("Account number"),
      description: z.string().optional().describe("Account description"),
      parentListId: z.string().optional().describe("ListID of parent account (for sub-accounts)"),
    },
    async (args) => {
      const session = getSession();
      const data: Record<string, unknown> = {
        Name: args.name,
        AccountType: args.accountType,
      };

      if (args.accountNumber) data.AccountNumber = args.accountNumber;
      if (args.description) data.Description = args.description;
      if (args.parentListId) data.ParentRef = { ListID: args.parentListId };

      try {
        const result = await session.addEntity("Account", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, account: result }, null, 2),
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
              statusMessage: e.message ?? "AccountAddRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_account_update",
    "Update an existing account in the QuickBooks chart of accounts.",
    {
      listId: z.string().describe("ListID of the account to update"),
      editSequence: z.string().describe("EditSequence for optimistic locking"),
      name: z.string().optional().describe("New account name"),
      accountNumber: z.string().optional().describe("New account number"),
      description: z.string().optional().describe("New description"),
      isActive: z.boolean().optional().describe("Set active/inactive status"),
    },
    async (args) => {
      const session = getSession();
      const data: Record<string, unknown> = {
        ListID: args.listId,
        EditSequence: args.editSequence,
      };

      if (args.name) data.Name = args.name;
      if (args.accountNumber) data.AccountNumber = args.accountNumber;
      if (args.description) data.Description = args.description;
      if (args.isActive !== undefined) data.IsActive = args.isActive;

      try {
        const result = await session.modifyEntity("Account", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, account: result }, null, 2),
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
              statusMessage: e.message ?? "AccountModRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_account_make_inactive",
    "Deactivate an account in the QuickBooks chart of accounts (sets IsActive: false). Preferred over qb_account_delete because real QB rejects hard deletion of accounts with transaction history. Inactive accounts no longer appear in the default qb_account_list view but are preserved (so historical reports still resolve their references). Reversible via qb_account_update { isActive: true }. Requires listId + editSequence (from a prior qb_account_list).",
    {
      listId: z.string().describe("ListID of the account to deactivate"),
      editSequence: z.string().describe("EditSequence for optimistic locking (from a prior qb_account_list)"),
    },
    async ({ listId, editSequence }) => {
      const session = getSession();
      try {
        const result = await session.modifyEntity("Account", {
          ListID: listId,
          EditSequence: editSequence,
          IsActive: false,
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, account: result }, null, 2),
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
              statusMessage: e.message ?? "AccountModRq (make_inactive) failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_account_delete",
    "Hard-delete an account from the QuickBooks chart of accounts. WARNING: real QB rejects deletion of accounts that have any transaction history (returns statusCode 3260) or are referenced by other records (3170). Prefer qb_account_make_inactive for accounts with history — it hides the account from the default list view but preserves the record so historical reports still resolve. Use this tool only for empty accounts created in error.",
    {
      listId: z.string().describe("ListID of the account to delete"),
    },
    async ({ listId }) => {
      const session = getSession();
      try {
        const result = await session.deleteEntity("Account", listId);
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
              statusMessage: e.message ?? "ListDelRq (Account) failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
