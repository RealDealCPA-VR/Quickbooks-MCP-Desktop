/**
 * Phase 16 #74 — MCP-side cache of stable lookups (chart of accounts,
 * customer list, item list per subtype, terms list per subtype, class list).
 *
 * These five entity domains share a profile: they barely change within an
 * agent session, but every list tool call costs a wire round trip to QB
 * Desktop (~150-500ms typical, more for large books). Caching the unfiltered
 * "give me everything" call collapses N round trips for repeated lookups into
 * one + (N-1) in-process Map reads.
 *
 * Cached:
 *   - Account                (chart of accounts)
 *   - Customer               (customer + jobs)
 *   - ItemService / ItemInventory / ItemNonInventory / ItemOtherCharge /
 *     ItemGroup              (per-subtype, since the wire query is per-subtype)
 *   - StandardTerms / DateDrivenTerms (per-subtype, same reason)
 *   - Class
 *
 * NOT cached:
 *   - Any list tool call with a filter arg (nameFilter, listId, accountType,
 *     parentListID, etc.) — non-stable by construction
 *   - Paginated calls (paginate:true / iteratorID set) — the caller is
 *     explicitly managing batch-level state
 *   - Transactions — wrong shape (large, dated, query-driven)
 *
 * Lifecycle:
 *   - Per-session: instantiated once in QBSessionManager's constructor
 *   - Per-companyFile: cleared on `companyFileChanged(newFile)` (a fresh
 *     book is a fresh set of stable lookups; never serve A's customers
 *     against B's session)
 *   - TTL: 5 minutes default — captures "operator added one customer in QB
 *     UI mid-session" without forcing manual invalidation. Operator can also
 *     force-flush via `qb_cache_invalidate`.
 */

export interface LookupCacheEntry {
  entities: Record<string, unknown>[];
  fetchedAt: number;
}

/**
 * Default time-to-live in milliseconds. 5 minutes balances two failure modes:
 *   - Too short: cache misses on natural workflow rhythms (operator opens
 *     book → runs 6 reports → cache expires between each one)
 *   - Too long: operator adds a customer in QB UI, then runs a tool that
 *     misses the new customer for the rest of the agent session
 *
 * 5 minutes is QB Desktop's own typical autosave interval — operators are
 * already accustomed to a "wait a few minutes for it to settle" cadence.
 */
export const DEFAULT_LOOKUP_TTL_MS = 5 * 60 * 1000;

/**
 * In-memory cache of unfiltered list results, keyed by entity type. Entries
 * carry their fetch timestamp so `get()` can apply TTL on read (lazy
 * eviction — cheaper than a background timer, and TTL is only checked when
 * an entry is actually requested).
 *
 * Holds the entity arrays verbatim — no deep clone on set/get. Callers
 * MUST treat cached entities as immutable. The list tools that consume this
 * cache emit the entities into a JSON response and never mutate them, so
 * this is safe by construction; if a future tool layer needs to enrich
 * cached entities, it must clone first.
 */
export class QBLookupCache {
  private cache: Map<string, LookupCacheEntry> = new Map();
  private readonly ttlMs: number;
  private companyFile: string | undefined;

  constructor(initialCompanyFile?: string, ttlMs: number = DEFAULT_LOOKUP_TTL_MS) {
    this.companyFile = initialCompanyFile;
    this.ttlMs = ttlMs;
  }

  /**
   * Retrieve cached entities for `entityType`. Returns `null` on miss OR
   * when the cached entry has aged past `ttlMs`. Aged entries are evicted
   * on read (lazy eviction).
   */
  get(entityType: string): Record<string, unknown>[] | null {
    const entry = this.cache.get(entityType);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > this.ttlMs) {
      this.cache.delete(entityType);
      return null;
    }
    return entry.entities;
  }

  /**
   * Store `entities` under `entityType`. Overwrites any existing entry —
   * later calls always supersede earlier ones (a fresh wire fetch is the
   * source of truth).
   */
  set(entityType: string, entities: Record<string, unknown>[]): void {
    this.cache.set(entityType, { entities, fetchedAt: Date.now() });
  }

  /**
   * Clear a single entity type's cache entry. Omit `entityType` to clear
   * the entire cache (used by `qb_cache_invalidate` with no arg, by the
   * companyFileChanged hook, and by tests that need a known-empty state).
   */
  invalidate(entityType?: string): void {
    if (entityType === undefined) {
      this.cache.clear();
    } else {
      this.cache.delete(entityType);
    }
  }

  /**
   * Hook called by `QBSessionManager.switchCompanyFile`. Clears the whole
   * cache (every entity domain is scoped to the current company file —
   * Acme's chart of accounts is meaningless against Globex's book) and
   * records the new companyFile for inspection. Idempotent.
   */
  companyFileChanged(newFile: string | undefined): void {
    this.cache.clear();
    this.companyFile = newFile;
  }

  /**
   * Return the entity types currently held in the cache. Used by
   * `qb_session_status` and `qb_cache_invalidate` to surface what's
   * cached without exposing the entity payloads themselves.
   */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Return the current companyFile scope this cache is bound to. Used by
   * debug surfaces; the cache enforces scope via `companyFileChanged`
   * resetting, not via runtime checks against this value.
   */
  getCompanyFile(): string | undefined {
    return this.companyFile;
  }

  /**
   * Return the configured TTL. Exposed for `qb_session_status` and tests.
   */
  getTtlMs(): number {
    return this.ttlMs;
  }

  /**
   * Return the timestamp at which `entityType` was last cached, or `null`
   * if not present. Exposed for `qb_cache_invalidate`'s response (so the
   * caller sees what age the cleared entries had) and for tests.
   */
  fetchedAt(entityType: string): number | null {
    const entry = this.cache.get(entityType);
    return entry ? entry.fetchedAt : null;
  }
}

/**
 * Map a user-facing entity name (the surface of `qb_cache_invalidate({ entity })`)
 * to the underlying QBXML entity types the cache keys on. Item and Terms fan
 * across subtypes — invalidating "Item" clears all 5 subtype slots; "Terms"
 * clears both StandardTerms + DateDrivenTerms.
 *
 * The user-facing surface intentionally hides the subtype keying: an operator
 * who just added a Service item in QB UI shouldn't need to remember that
 * `qb_item_list` queries `ItemServiceQueryRq` under the hood — they pass
 * "Item" and the right thing happens.
 */
export const CACHEABLE_ENTITY_GROUPS = {
  Account: ["Account"],
  Customer: ["Customer"],
  Item: ["ItemService", "ItemInventory", "ItemNonInventory", "ItemOtherCharge", "ItemGroup"],
  Terms: ["StandardTerms", "DateDrivenTerms"],
  Class: ["Class"],
} as const;

export type CacheableEntity = keyof typeof CACHEABLE_ENTITY_GROUPS;

export const CACHEABLE_ENTITIES: readonly CacheableEntity[] =
  Object.keys(CACHEABLE_ENTITY_GROUPS) as CacheableEntity[];
