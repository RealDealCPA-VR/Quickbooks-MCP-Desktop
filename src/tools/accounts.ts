/**
 * Chart of Accounts management tools for QuickBooks Desktop MCP.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { formatToolError } from "../util/format-tool-error.js";
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
    "List the chart of accounts from QuickBooks Desktop. Returns all accounts or filtered by type. Set includeCustomFields:true to surface DataExtRet (custom-field) values per account.",
    {
      accountType: z.string().optional().describe(
        `Filter by account type: ${ACCOUNT_TYPES.join(", ")}`
      ),
      activeOnly: z.boolean().optional().describe("Only return active accounts"),
      nameFilter: z.string().optional().describe("Filter by account name"),
      listId: z.string().optional().describe("Fetch a specific account by ListID"),
      includeCustomFields: z.boolean().optional().describe("Include DataExtRet (custom-field values) on every returned account. Pass customFieldOwnerId for non-default namespaces."),
      customFieldOwnerId: z.string().optional().describe("OwnerID namespace to scope DataExtRet to. Default '0' (standard company-defined fields). Only meaningful when includeCustomFields:true."),
    },
    async ({ accountType, activeOnly, nameFilter, listId, includeCustomFields, customFieldOwnerId }) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      // AccountQueryRq schema-required child order (see customers.ts):
      //   ListID → ActiveStatus → NameFilter → AccountType
      if (listId) filters.ListID = listId;
      if (activeOnly !== false) filters.ActiveStatus = "ActiveOnly";
      if (nameFilter) filters.NameFilter = { MatchCriterion: "Contains", Name: nameFilter };
      if (accountType) filters.AccountType = accountType;
      // Phase 13 #61 — OwnerID slots at the END of the AccountQueryRq filter sequence.
      if (includeCustomFields) filters.OwnerID = customFieldOwnerId ?? "0";

      try {
        const accounts = await session.queryEntity("Account", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: accounts.length, accounts }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "AccountQueryRq failed" });
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
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original result without creating a duplicate QB record (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open."),
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
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent("Account", data, args.idempotencyKey)
          : { entity: await session.addEntity("Account", data), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              account: result,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "AccountAddRq failed" });
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
        return formatToolError(err, { fallbackMessage: "AccountModRq failed" });
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
        return formatToolError(err, { fallbackMessage: "AccountModRq (make_inactive) failed" });
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
        return formatToolError(err, { fallbackMessage: "ListDelRq (Account) failed" });
      }
    }
  );
}
