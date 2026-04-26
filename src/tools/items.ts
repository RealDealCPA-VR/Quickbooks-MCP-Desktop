/**
 * Item (Products & Services) management tools for QuickBooks Desktop MCP.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";

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
    "List or search items (products and services) in QuickBooks Desktop. Omit itemType to query all subtypes.",
    {
      itemType: itemTypeSchema.optional()
        .describe("Restrict to a single subtype. Omit to query all five subtypes and merge."),
      nameFilter: z.string().optional().describe("Filter items by name (Contains match)"),
      activeOnly: z.boolean().optional().describe("Only return active items (default true)"),
      maxReturned: z.number().optional().describe("Maximum results per subtype query"),
      listId: z.string().optional().describe("Fetch a specific item by ListID"),
    },
    async ({ itemType, nameFilter, activeOnly, maxReturned, listId }) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      if (listId) filters.ListID = listId;
      if (nameFilter) filters.NameFilter = { MatchCriterion: "Contains", Name: nameFilter };
      if (activeOnly !== false) filters.ActiveStatus = "ActiveOnly";
      if (maxReturned) filters.MaxReturned = maxReturned;

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

      const result = await session.addEntity(`Item${args.itemType}`, data);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, item: result }, null, 2),
        }],
      };
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

      const result = await session.modifyEntity(`Item${args.itemType}`, data);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, item: result }, null, 2),
        }],
      };
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
      const result = await session.deleteEntity(`Item${itemType}`, listId);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, deleted: result }, null, 2),
        }],
      };
    }
  );
}
