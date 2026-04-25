/**
 * Item (Products & Services) management tools for QuickBooks Desktop MCP.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";

export function registerItemTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_item_list",
    "List or search items (products and services) in QuickBooks Desktop.",
    {
      nameFilter: z.string().optional().describe("Filter items by name"),
      activeOnly: z.boolean().optional().describe("Only return active items"),
      maxReturned: z.number().optional().describe("Maximum results"),
      listId: z.string().optional().describe("Fetch a specific item by ListID"),
    },
    async ({ nameFilter, activeOnly, maxReturned, listId }) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      if (listId) filters.ListID = listId;
      if (nameFilter) filters.NameFilter = { MatchCriterion: "Contains", Name: nameFilter };
      if (activeOnly !== false) filters.ActiveStatus = "ActiveOnly";
      if (maxReturned) filters.MaxReturned = maxReturned;

      const items = await session.queryEntity("Item", filters);
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
      itemType: z.enum(["Service", "Inventory", "NonInventory", "OtherCharge", "Group"])
        .describe("Type of item"),
      description: z.string().optional().describe("Item description"),
      price: z.number().optional().describe("Sales price"),
      cost: z.number().optional().describe("Purchase cost (for inventory items)"),
      incomeAccountName: z.string().optional().describe("Income account name"),
      cogsAccountName: z.string().optional().describe("COGS account name (inventory)"),
      assetAccountName: z.string().optional().describe("Asset account name (inventory)"),
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

      const result = await session.addEntity("Item", data);
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

      const result = await session.modifyEntity("Item", data);
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
      listId: z.string().describe("ListID of the item to delete"),
    },
    async ({ listId }) => {
      const session = getSession();
      const result = await session.deleteEntity("Item", listId);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, deleted: result }, null, 2),
        }],
      };
    }
  );
}
