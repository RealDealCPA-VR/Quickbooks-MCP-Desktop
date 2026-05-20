/**
 * Item (Products & Services) management tools for QuickBooks Desktop MCP.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";
import { formatToolError } from "../util/format-tool-error.js";
// Real QB has no generic Item entity — each item belongs to one of these five
// subtypes, each with its own *QueryRq / *AddRq / *ModRq / ListDelType.
const ITEM_SUBTYPES = [
  "Service",
  "Inventory",
  "NonInventory",
  "OtherCharge",
  "Group",
] as const;

const itemTypeSchema = z.enum(ITEM_SUBTYPES);

export function registerItemTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_item_list",
    "List or search items (products and services) in QuickBooks Desktop. Omit itemType to query all subtypes. Set paginate:true (with itemType) to use iterator-based pagination — pagination cannot fan out across subtypes, so itemType is required when paginating. Set autoExhaust:true (Phase 16 #73, with itemType) to fully exhaust the iterator server-side and return the merged result in one call — same subtype-required constraint as paginate; caps at maxBatches (default 20 = ~10k rows). When paginate or autoExhaust is enabled, maxReturned defaults to 500 (QB's per-batch cap) if unset. Set includeCustomFields:true to surface DataExtRet (custom-field) values per item. Caching (Phase 16 #74): unfiltered calls (no nameFilter, listId, includeCustomFields, paginate, or iteratorID) hit a 5-minute lookup cache by default — keyed per subtype (Item* fan-out caches each of the 5 subtypes separately). Pass useCache:false to force fresh; call qb_cache_invalidate({entity:'Item'}) to clear all 5 subtypes after an out-of-band edit.",
    {
      itemType: itemTypeSchema.optional()
        .describe("Restrict to a single subtype. Omit to query all five subtypes and merge. Required when paginate:true or autoExhaust:true."),
      nameFilter: z.string().optional().describe("Filter items by name (Contains match)"),
      activeOnly: z.boolean().optional().describe("Only return active items (default true)"),
      maxReturned: z.number().optional().describe("Maximum results per wire batch. Defaults to 500 when paginate or autoExhaust is enabled (QB's per-batch cap); otherwise QB-driven."),
      listId: z.string().optional().describe("Fetch a specific item by ListID"),
      paginate: z.boolean().optional().describe("Enable iterator-based pagination (real QB caps each *QueryRq response at ~500 rows). Requires itemType — iterators are scoped to a single request type, so the multi-subtype fan-out path is incompatible. Auto-defaults maxReturned to 500 if unset. Mutually exclusive with autoExhaust."),
      iteratorID: z.string().optional().describe("Continue an existing iterator by passing the iteratorID from a prior paginated response. Implies paginate, and itemType must match the original request type. Mutually exclusive with autoExhaust (autoExhaust always starts a fresh iterator)."),
      autoExhaust: z.boolean().optional().describe("Phase 16 #73: server-side iterator exhaustion. Loops queryEntityPaginated until iteratorRemainingCount === 0 (or maxBatches cap) and returns the merged result as ONE response — collapses N tool round trips for a large dump into 1. Hard-capped by maxBatches (default 20 = ~10k rows). Cap-hit returns the partial result + final iteratorID for caller-driven resumption. Mutually exclusive with paginate / iteratorID. Requires itemType — same constraint as paginate; QBXML iterators are scoped to a single Item*QueryRq."),
      maxBatches: z.number().int().positive().optional().describe("Safety cap on autoExhaust batch count (default 20). Each batch is one wire round trip to QuickBooks Desktop (~500 rows per batch). Only meaningful when autoExhaust:true."),
      includeCustomFields: z.boolean().optional().describe("Include DataExtRet (custom-field values) on every returned item. Pass customFieldOwnerId for non-default namespaces."),
      customFieldOwnerId: z.string().optional().describe("OwnerID namespace to scope DataExtRet to. Default '0' (standard company-defined fields). Only meaningful when includeCustomFields:true."),
      useCache: z.boolean().optional().describe("Phase 16 #74: read/write through the 5-minute MCP-side lookup cache for unfiltered calls. Default true. Cache is keyed per subtype (Item* fan-out caches each separately). Any filter arg (nameFilter, listId, includeCustomFields, paginate, iteratorID) bypasses cache. itemType is part of the cache key (not a bypass)."),
    },
    async ({ itemType, nameFilter, activeOnly, maxReturned, listId, paginate, iteratorID, autoExhaust, maxBatches, includeCustomFields, customFieldOwnerId, useCache }) => {
      const session = getSession();

      // Phase 16 #73 — autoExhaust mutex (see customers.ts pilot).
      if (autoExhaust && (paginate || iteratorID)) {
        return formatToolError(
          new Error("autoExhaust is mutually exclusive with paginate / iteratorID — autoExhaust starts a fresh iterator server-side and runs it to completion"),
          { fallbackMessage: "Invalid arguments" }
        );
      }

      // Phase 16 #74 — lookup cache eligibility (see accounts.ts).
      // itemType is part of the cache KEY, not a bypass — itemType:"Service"
      // caches under "ItemService", a no-itemType call caches all 5 subtypes
      // independently and only returns merged-from-cache when ALL 5 are
      // present + fresh. autoExhaust + paginate + iteratorID bypass the
      // READ but autoExhaust still WRITES on completion.
      const isUnfilteredCall =
        !nameFilter &&
        !listId &&
        !includeCustomFields &&
        activeOnly !== false;
      const isRegularCall = !paginate && !iteratorID && !autoExhaust;
      const cacheRead = useCache !== false && isUnfilteredCall && isRegularCall;
      const cacheWrite = useCache !== false && isUnfilteredCall;
      if (cacheRead) {
        const cache = session.getLookupCache();
        if (itemType) {
          const cached = cache.get(`Item${itemType}`);
          if (cached) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({ count: cached.length, items: cached, fromCache: true }, null, 2),
              }],
            };
          }
        } else {
          // Multi-subtype fan-out: only serve from cache when all 5 slots
          // are populated and fresh. Partial hits would silently undercount
          // (e.g. Service+Inventory cached but Group missing → return 4
          // subtypes' worth as if it were the full set) — that's the wrong
          // failure mode, so we either hit fully or fall through to wire.
          const subtypeCaches = ITEM_SUBTYPES.map((sub) => cache.get(`Item${sub}`));
          if (subtypeCaches.every((c) => c !== null)) {
            const merged = subtypeCaches.flat() as Record<string, unknown>[];
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({ count: merged.length, items: merged, fromCache: true }, null, 2),
              }],
            };
          }
        }
      }

      const filters: Record<string, unknown> = {};

      // Pagination requires MaxReturned — QB rejects iterator requests without it
      // ("There is a missing element: MaxReturned"). Default to 500 (QB's
      // effective per-batch cap) when paginate or autoExhaust is on but no
      // value was supplied.
      const effectiveMaxReturned =
        maxReturned ?? (paginate || iteratorID || autoExhaust ? 500 : undefined);

      // Item*QueryRq schema-required child order (see customers.ts).
      if (listId) filters.ListID = listId;
      if (effectiveMaxReturned) filters.MaxReturned = effectiveMaxReturned;
      if (activeOnly !== false) filters.ActiveStatus = "ActiveOnly";
      if (nameFilter) filters.NameFilter = { MatchCriterion: "Contains", Name: nameFilter };
      // Phase 13 #61 — OwnerID slots at the END of the Item*QueryRq filter sequence.
      if (includeCustomFields) filters.OwnerID = customFieldOwnerId ?? "0";

      const wantsPagination = Boolean(paginate || iteratorID);
      if (wantsPagination && !itemType) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "paginate requires itemType — QBXML iterators are scoped to a single Item*QueryRq, so the multi-subtype fan-out path cannot paginate. Pass itemType (Service / Inventory / NonInventory / OtherCharge / Group) to paginate one subtype at a time.",
            }),
          }],
          isError: true,
        };
      }
      if (autoExhaust && !itemType) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "autoExhaust requires itemType — QBXML iterators are scoped to a single Item*QueryRq, so the multi-subtype fan-out path cannot be auto-exhausted. Pass itemType (Service / Inventory / NonInventory / OtherCharge / Group) to exhaust one subtype at a time.",
            }),
          }],
          isError: true,
        };
      }

      try {
        if (autoExhaust) {
          // Phase 16 #73 — loop queryEntityPaginated until exhausted OR
          // maxBatches cap. Each iteration is one wire round trip to QB.
          // itemType-required gate (above) means we know `itemType` is set
          // here — no fan-out across subtypes under autoExhaust.
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
            const batch = await session.queryEntityPaginated(`Item${itemType}`, filters, {
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
          // Phase 16 #74 — write-back on full exhaustion. itemType is
          // guaranteed set here (autoExhaust-without-itemType refusal above).
          if (cacheWrite && !capHit && itemType) {
            session.getLookupCache().set(`Item${itemType}`, accumulated);
          }
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                count: accumulated.length,
                items: accumulated,
                batchesExhausted: batches,
                ...(capHit && nextIteratorID
                  ? { iteratorID: nextIteratorID, iteratorRemainingCount: remaining }
                  : {}),
                ...(warnings.length ? { warnings } : {}),
              }, null, 2),
            }],
          };
        }

        if (wantsPagination) {
          const result = await session.queryEntityPaginated(`Item${itemType}`, filters, {
            iterator: iteratorID ? "Continue" : "Start",
            iteratorID,
          });
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                count: result.entities.length,
                items: result.entities,
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

        let items: Record<string, unknown>[];
        if (itemType) {
          items = await session.queryEntity(`Item${itemType}`, filters);
          if (cacheWrite) {
            session.getLookupCache().set(`Item${itemType}`, items);
          }
        } else {
          const perSubtype = await Promise.all(
            ITEM_SUBTYPES.map((sub) => session.queryEntity(`Item${sub}`, filters))
          );
          if (cacheWrite) {
            // Phase 16 #74 — cache each subtype slot independently so a
            // later qb_item_list({itemType:'Service'}) hits its own slot.
            ITEM_SUBTYPES.forEach((sub, idx) => {
              session.getLookupCache().set(`Item${sub}`, perSubtype[idx]);
            });
          }
          items = perSubtype.flat();
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: items.length, items }, null, 2),
          }],
        };
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        const op = itemType ? `Item${itemType}QueryRq` : "Item*QueryRq";
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? `${op} failed`,
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_item_add",
    "Create a new item (product or service) in QuickBooks Desktop.",
    {
      name: z.string().describe("Item name"),
      itemType: itemTypeSchema.describe("Subtype of item — determines the QBXML request type"),
      description: z.string().optional().describe("Item description"),
      price: z.number().optional().describe("Sales price"),
      cost: z.number().optional().describe("Purchase cost (Inventory / NonInventory)"),
      incomeAccountName: z.string().optional().describe("Income account name"),
      cogsAccountName: z.string().optional().describe("COGS account name (Inventory)"),
      assetAccountName: z.string().optional().describe("Asset account name (Inventory)"),
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original result without creating a duplicate QB record (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open."),
      dryRun: z.boolean().optional().describe("If true, preview what this call WOULD do without committing. See qb_customer_add's dryRun docs for the full composition matrix."),
    },
    async (args) => {
      const session = getSession();
      const data: Record<string, unknown> = {
        Name: args.name,
        ItemType: args.itemType,
      };

      if (args.description) data.Description = args.description;
      if (args.price !== undefined) data.Price = args.price;
      if (args.cost !== undefined) data.Cost = args.cost;
      if (args.incomeAccountName) {
        data.IncomeAccountRef = { FullName: args.incomeAccountName };
      }
      if (args.cogsAccountName) {
        data.COGSAccountRef = { FullName: args.cogsAccountName };
      }
      if (args.assetAccountName) {
        data.AssetAccountRef = { FullName: args.assetAccountName };
      }

      const entityType = `Item${args.itemType}`;

      if (args.dryRun) {
        try {
          const preview = await session.addEntityDryRun(entityType, data, args.idempotencyKey);
          const { entity, ...rest } = preview;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                dryRun: true,
                ...rest,
                ...(entity ? { item: entity } : {}),
              }, null, 2),
            }],
          };
        } catch (err) {
          return formatToolError(err, { fallbackMessage: `Item${args.itemType}AddRq dry-run failed` });
        }
      }

      try {
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent(entityType, data, args.idempotencyKey)
          : { entity: await session.addEntity(entityType, data), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              item: result,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: `Item${args.itemType}AddRq failed` });
      }
    }
  );

  server.tool(
    "qb_item_update",
    "Update an existing item in QuickBooks Desktop.",
    {
      itemType: itemTypeSchema.describe("Subtype of the item being updated — must match the item's stored ItemType"),
      listId: z.string().describe("ListID of the item to update"),
      editSequence: z.string().describe("EditSequence for optimistic locking"),
      name: z.string().optional().describe("New item name"),
      description: z.string().optional().describe("New description"),
      price: z.number().optional().describe("New sales price"),
      cost: z.number().optional().describe("New purchase cost"),
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
      if (args.description) data.Description = args.description;
      if (args.price !== undefined) data.Price = args.price;
      if (args.cost !== undefined) data.Cost = args.cost;
      if (args.isActive !== undefined) data.IsActive = args.isActive;

      const entityType = `Item${args.itemType}`;

      if (args.dryRun) {
        try {
          const preview = await session.modifyEntityDryRun(entityType, data);
          const { entity, ...rest } = preview;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                dryRun: true,
                ...rest,
                ...(entity ? { item: entity } : {}),
              }, null, 2),
            }],
          };
        } catch (err) {
          return formatToolError(err, { fallbackMessage: `Item${args.itemType}ModRq dry-run failed` });
        }
      }

      try {
        const result = await session.modifyEntity(entityType, data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, item: result }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: `Item${args.itemType}ModRq failed` });
      }
    }
  );

  server.tool(
    "qb_item_delete",
    "Delete an item from QuickBooks Desktop. WARNING: Irreversible. Pass `dryRun: true` to preview without committing.",
    {
      itemType: itemTypeSchema.describe("Subtype of the item being deleted — sets ListDelType to Item<Subtype>"),
      listId: z.string().describe("ListID of the item to delete"),
      dryRun: z.boolean().optional().describe("If true, preview what this call WOULD do without committing. See qb_invoice_delete's dryRun docs for the full composition matrix."),
    },
    async ({ itemType, listId, dryRun }) => {
      const session = getSession();
      if (dryRun) {
        try {
          const preview = await session.deleteEntityDryRun(`Item${itemType}`, listId);
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
          return formatToolError(err, { fallbackMessage: `ListDelRq (Item${itemType}) dry-run failed` });
        }
      }

      try {
        const result = await session.deleteEntity(`Item${itemType}`, listId);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, deleted: result }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: `ListDelRq (Item${itemType}) failed` });
      }
    }
  );
}
