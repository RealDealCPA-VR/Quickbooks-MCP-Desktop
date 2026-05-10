/**
 * Item (Products & Services) management tools for QuickBooks Desktop MCP.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";

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
    "List or search items (products and services) in QuickBooks Desktop. Omit itemType to query all subtypes. Set paginate:true (with itemType) to use iterator-based pagination — pagination cannot fan out across subtypes, so itemType is required when paginating. When paginate is enabled, maxReturned defaults to 500 (QB's per-batch cap) if unset.",
    {
      itemType: itemTypeSchema.optional()
        .describe("Restrict to a single subtype. Omit to query all five subtypes and merge. Required when paginate:true."),
      nameFilter: z.string().optional().describe("Filter items by name (Contains match)"),
      activeOnly: z.boolean().optional().describe("Only return active items (default true)"),
      maxReturned: z.number().optional().describe("Maximum results per subtype query. Defaults to 500 when paginate is enabled (QB's per-batch cap); otherwise QB-driven."),
      listId: z.string().optional().describe("Fetch a specific item by ListID"),
      paginate: z.boolean().optional().describe("Enable iterator-based pagination (real QB caps each *QueryRq response at ~500 rows). Requires itemType — iterators are scoped to a single request type, so the multi-subtype fan-out path is incompatible. Auto-defaults maxReturned to 500 if unset."),
      iteratorID: z.string().optional().describe("Continue an existing iterator by passing the iteratorID from a prior paginated response. Implies paginate, and itemType must match the original request type."),
    },
    async ({ itemType, nameFilter, activeOnly, maxReturned, listId, paginate, iteratorID }) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      // Pagination requires MaxReturned — QB rejects iterator requests without it
      // ("There is a missing element: MaxReturned"). Default to 500 (QB's
      // effective per-batch cap) when paginate is on but no value was supplied.
      const effectiveMaxReturned =
        maxReturned ?? (paginate || iteratorID ? 500 : undefined);

      // Item*QueryRq schema-required child order (see customers.ts).
      if (listId) filters.ListID = listId;
      if (effectiveMaxReturned) filters.MaxReturned = effectiveMaxReturned;
      if (activeOnly !== false) filters.ActiveStatus = "ActiveOnly";
      if (nameFilter) filters.NameFilter = { MatchCriterion: "Contains", Name: nameFilter };

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

      try {
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
        } else {
          const perSubtype = await Promise.all(
            ITEM_SUBTYPES.map((sub) => session.queryEntity(`Item${sub}`, filters))
          );
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

      try {
        const entityType = `Item${args.itemType}`;
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
        const e = err as { message?: string; statusCode?: number };
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? `Item${args.itemType}AddRq failed`,
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
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

      try {
        const result = await session.modifyEntity(`Item${args.itemType}`, data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, item: result }, null, 2),
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
              statusMessage: e.message ?? `Item${args.itemType}ModRq failed`,
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_item_delete",
    "Delete an item from QuickBooks Desktop. WARNING: Irreversible.",
    {
      itemType: itemTypeSchema.describe("Subtype of the item being deleted — sets ListDelType to Item<Subtype>"),
      listId: z.string().describe("ListID of the item to delete"),
    },
    async ({ itemType, listId }) => {
      const session = getSession();
      try {
        const result = await session.deleteEntity(`Item${itemType}`, listId);
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
              statusMessage: e.message ?? `ListDelRq (Item${itemType}) failed`,
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
