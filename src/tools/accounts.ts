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
    "List the chart of accounts from QuickBooks Desktop. Returns all accounts or filtered by type. Set paginate:true to use iterator-based pagination — first call returns iteratorID + iteratorRemainingCount; pass iteratorID back on subsequent calls until iteratorRemainingCount === 0. Set autoExhaust:true (Phase 16 #73) to fully exhaust the iterator server-side and return the merged result in one call — caps at maxBatches (default 20 = ~10k rows). When paginate or autoExhaust is enabled, maxReturned defaults to 500 (QB's per-batch cap) if unset. Set includeCustomFields:true to surface DataExtRet (custom-field) values per account. Caching: unfiltered calls (no accountType, nameFilter, listId, includeCustomFields, paginate, or iteratorID) hit a 5-minute lookup cache by default — response carries fromCache:true on hit. Pass useCache:false to force fresh; call qb_cache_invalidate({entity:'Account'}) to clear after an out-of-band edit in QB Desktop UI.",
    {
      accountType: z.string().optional().describe(
        `Filter by account type: ${ACCOUNT_TYPES.join(", ")}`
      ),
      activeOnly: z.boolean().optional().describe("Only return active accounts"),
      nameFilter: z.string().optional().describe("Filter by account name"),
      maxReturned: z.number().optional().describe("Maximum number of results per wire batch. Defaults to 500 when paginate or autoExhaust is enabled (QB's per-batch cap); otherwise QB-driven."),
      listId: z.string().optional().describe("Fetch a specific account by ListID"),
      paginate: z.boolean().optional().describe("Enable iterator-based pagination (real QB caps each *QueryRq response at ~500 rows). Response surfaces iteratorRemainingCount + iteratorID. Auto-defaults maxReturned to 500 if unset. Mutually exclusive with autoExhaust."),
      iteratorID: z.string().optional().describe("Continue an existing iterator by passing the iteratorID from a prior paginated response. Implies paginate. Mutually exclusive with autoExhaust (autoExhaust always starts a fresh iterator)."),
      autoExhaust: z.boolean().optional().describe("Phase 16 #73: server-side iterator exhaustion. Loops queryEntityPaginated until iteratorRemainingCount === 0 (or maxBatches cap) and returns the merged result as ONE response — collapses N tool round trips for a large dump into 1. Hard-capped by maxBatches (default 20 = ~10k rows). Cap-hit returns the partial result + final iteratorID for caller-driven resumption. Mutually exclusive with paginate / iteratorID."),
      maxBatches: z.number().int().positive().optional().describe("Safety cap on autoExhaust batch count (default 20). Each batch is one wire round trip to QuickBooks Desktop (~500 rows per batch). Only meaningful when autoExhaust:true."),
      includeCustomFields: z.boolean().optional().describe("Include DataExtRet (custom-field values) on every returned account. Pass customFieldOwnerId for non-default namespaces."),
      customFieldOwnerId: z.string().optional().describe("OwnerID namespace to scope DataExtRet to. Default '0' (standard company-defined fields). Only meaningful when includeCustomFields:true."),
      useCache: z.boolean().optional().describe("Phase 16 #74: read/write through the 5-minute MCP-side lookup cache for unfiltered calls. Default true. Any filter arg (accountType, nameFilter, listId, includeCustomFields, paginate, iteratorID) bypasses cache. Pass false to force a fresh wire fetch even on an unfiltered call. Cache is per company file and clears on qb_company_open."),
    },
    async ({ accountType, activeOnly, nameFilter, maxReturned, listId, paginate, iteratorID, autoExhaust, maxBatches, includeCustomFields, customFieldOwnerId, useCache }) => {
      const session = getSession();

      // Phase 16 #73 — autoExhaust mutex (see customers.ts pilot).
      if (autoExhaust && (paginate || iteratorID)) {
        return formatToolError(
          new Error("autoExhaust is mutually exclusive with paginate / iteratorID — autoExhaust starts a fresh iterator server-side and runs it to completion"),
          { fallbackMessage: "Invalid arguments" }
        );
      }

      // Phase 16 #74 — lookup cache eligibility. An "unfiltered call" is one
      // with NO scoping or shape-changing args. activeOnly defaults to true
      // (matches QB's natural list view); an explicit `false` is a scope
      // change and bypasses cache. paginate / iteratorID / autoExhaust are
      // pagination state — read-side bypasses (autoExhaust is an explicit
      // "go pull everything fresh from QB" intent), but autoExhaust DOES
      // populate the cache on completion.
      const isUnfilteredCall =
        !accountType &&
        !nameFilter &&
        !listId &&
        !includeCustomFields &&
        activeOnly !== false;
      const isRegularCall = !paginate && !iteratorID && !autoExhaust;
      const cacheRead = useCache !== false && isUnfilteredCall && isRegularCall;
      const cacheWrite = useCache !== false && isUnfilteredCall;
      if (cacheRead) {
        const cached = session.getLookupCache().get("Account");
        if (cached) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ count: cached.length, accounts: cached, fromCache: true }, null, 2),
            }],
          };
        }
      }

      const filters: Record<string, unknown> = {};

      const effectiveMaxReturned =
        maxReturned ?? (paginate || iteratorID || autoExhaust ? 500 : undefined);

      // AccountQueryRq schema-required child order (see customers.ts):
      //   ListID → MaxReturned → ActiveStatus → NameFilter → AccountType
      if (listId) filters.ListID = listId;
      if (effectiveMaxReturned) filters.MaxReturned = effectiveMaxReturned;
      if (activeOnly !== false) filters.ActiveStatus = "ActiveOnly";
      if (nameFilter) filters.NameFilter = { MatchCriterion: "Contains", Name: nameFilter };
      if (accountType) filters.AccountType = accountType;
      // Phase 13 #61 — OwnerID slots at the END of the AccountQueryRq filter sequence.
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
            const batch = await session.queryEntityPaginated("Account", filters, {
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
          // Phase 16 #74 — write-back on full exhaustion. A successful
          // exhaustion with no cap hit IS the canonical "give me everything"
          // result for the unfiltered call; cache it so the next call
          // collapses to an in-process Map read.
          if (cacheWrite && !capHit) {
            session.getLookupCache().set("Account", accumulated);
          }
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                count: accumulated.length,
                accounts: accumulated,
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
          const result = await session.queryEntityPaginated("Account", filters, {
            iterator: iteratorID ? "Continue" : "Start",
            iteratorID,
          });
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                count: result.entities.length,
                accounts: result.entities,
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

        const accounts = await session.queryEntity("Account", filters);
        if (cacheWrite) {
          session.getLookupCache().set("Account", accounts);
        }
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
    "Create a new account in the QuickBooks chart of accounts. Pass `dryRun: true` to preview without committing.",
    {
      name: z.string().describe("Account name"),
      accountType: z.enum(ACCOUNT_TYPES).describe(
        `Account type: ${ACCOUNT_TYPES.join(", ")}`
      ),
      accountNumber: z.string().optional().describe("Account number"),
      description: z.string().optional().describe("Account description"),
      parentListId: z.string().optional().describe("ListID of parent account (for sub-accounts)"),
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original result without creating a duplicate QB record (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open."),
      dryRun: z.boolean().optional().describe("If true, preview what this call WOULD do without committing. See qb_customer_add's dryRun docs for the full composition matrix."),
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

      if (args.dryRun) {
        try {
          const preview = await session.addEntityDryRun("Account", data, args.idempotencyKey);
          const { entity, ...rest } = preview;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                dryRun: true,
                ...rest,
                ...(entity ? { account: entity } : {}),
              }, null, 2),
            }],
          };
        } catch (err) {
          return formatToolError(err, { fallbackMessage: "AccountAddRq dry-run failed" });
        }
      }

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
    "Update an existing account in the QuickBooks chart of accounts. Pass `dryRun: true` to preview without committing.",
    {
      listId: z.string().describe("ListID of the account to update"),
      editSequence: z.string().describe("EditSequence for optimistic locking"),
      name: z.string().optional().describe("New account name"),
      accountNumber: z.string().optional().describe("New account number"),
      description: z.string().optional().describe("New description"),
      isActive: z.boolean().optional().describe("Set active/inactive status"),
      dryRun: z.boolean().optional().describe("If true, preview what this call WOULD do without committing. See qb_customer_add's dryRun docs for the full composition matrix."),
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

      if (args.dryRun) {
        try {
          const preview = await session.modifyEntityDryRun("Account", data);
          const { entity, ...rest } = preview;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                dryRun: true,
                ...rest,
                ...(entity ? { account: entity } : {}),
              }, null, 2),
            }],
          };
        } catch (err) {
          return formatToolError(err, { fallbackMessage: "AccountModRq dry-run failed" });
        }
      }

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
    "Deactivate an account in the QuickBooks chart of accounts (sets IsActive: false). Preferred over qb_account_delete because real QB rejects hard deletion of accounts with transaction history. Inactive accounts no longer appear in the default qb_account_list view but are preserved (so historical reports still resolve their references). Reversible via qb_account_update { isActive: true }. Requires listId + editSequence (from a prior qb_account_list). Pass `dryRun: true` to preview without committing.",
    {
      listId: z.string().describe("ListID of the account to deactivate"),
      editSequence: z.string().describe("EditSequence for optimistic locking (from a prior qb_account_list)"),
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
          const preview = await session.modifyEntityDryRun("Account", data);
          const { entity, ...rest } = preview;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                dryRun: true,
                ...rest,
                ...(entity ? { account: entity } : {}),
              }, null, 2),
            }],
          };
        } catch (err) {
          return formatToolError(err, { fallbackMessage: "AccountModRq (make_inactive) dry-run failed" });
        }
      }

      try {
        const result = await session.modifyEntity("Account", data);
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
    "Hard-delete an account from the QuickBooks chart of accounts. WARNING: real QB rejects deletion of accounts that have any transaction history (returns statusCode 3260) or are referenced by other records (3170). Prefer qb_account_make_inactive for accounts with history — it hides the account from the default list view but preserves the record so historical reports still resolve. Use this tool only for empty accounts created in error. Pass `dryRun: true` to preview without committing.",
    {
      listId: z.string().describe("ListID of the account to delete"),
      dryRun: z.boolean().optional().describe("If true, preview what this call WOULD do without committing. See qb_invoice_delete's dryRun docs for the full composition matrix."),
    },
    async ({ listId, dryRun }) => {
      const session = getSession();
      if (dryRun) {
        try {
          const preview = await session.deleteEntityDryRun("Account", listId);
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
          return formatToolError(err, { fallbackMessage: "ListDelRq (Account) dry-run failed" });
        }
      }

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
