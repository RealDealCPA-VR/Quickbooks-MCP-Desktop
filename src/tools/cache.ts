/**
 * Phase 16 #74 — MCP-side cache management tool.
 *
 * Exposes manual invalidation of the per-session `QBLookupCache` so an
 * operator who edited a customer / item / account in QB Desktop's UI can
 * force the next list tool call to fetch fresh from the wire (rather than
 * waiting for the 5-minute TTL).
 *
 * Single tool, single responsibility — no list/inspect surface. Operators
 * inspect cache status via `qb_session_status` (which surfaces the cached
 * entity-type keys). Adding more surface here would invite drift between
 * the cache state inspector and the cache invalidator.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { formatToolError } from "../util/format-tool-error.js";
import { CACHEABLE_ENTITY_GROUPS, CACHEABLE_ENTITIES, type CacheableEntity } from "../session/lookup-cache.js";

export function registerCacheTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_cache_invalidate",
    "Manually clear the MCP-side lookup cache (Phase 16 #74). Pass entity:'Account' | 'Customer' | 'Item' | 'Terms' | 'Class' to clear one domain; omit entity to clear all five. Use after editing a customer / item / account / class / terms entry in QB Desktop's UI when you want the next qb_*_list call to fetch fresh from the wire instead of waiting for the 5-minute TTL to expire. Item invalidation clears all 5 subtypes (Service / Inventory / NonInventory / OtherCharge / Group); Terms invalidation clears both StandardTerms + DateDrivenTerms. Returns the entity-type slots that were actually cleared (the entries that existed before the call) — slots that weren't cached are omitted. Cleared:[] is success, just nothing was cached.",
    {
      entity: z.enum(CACHEABLE_ENTITIES as [CacheableEntity, ...CacheableEntity[]]).optional()
        .describe("Entity domain to invalidate. Omit to clear ALL cached domains. Item clears all 5 subtypes; Terms clears both subtypes."),
    },
    async ({ entity }) => {
      const session = getSession();
      try {
        const cache = session.getLookupCache();
        const beforeKeys = new Set(cache.keys());

        if (entity === undefined) {
          // Clear all
          cache.invalidate();
          const cleared = Array.from(beforeKeys).sort();
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                scope: "all",
                cleared,
                count: cleared.length,
              }, null, 2),
            }],
          };
        }

        // Targeted clear — map user-facing entity to underlying subtype keys.
        const subtypes = CACHEABLE_ENTITY_GROUPS[entity];
        const cleared: string[] = [];
        for (const subtype of subtypes) {
          if (beforeKeys.has(subtype)) cleared.push(subtype);
          cache.invalidate(subtype);
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              scope: entity,
              cleared,
              count: cleared.length,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "qb_cache_invalidate failed" });
      }
    }
  );
}
