// Phase 16 #74 — MCP-side lookup cache (chart of accounts, customers,
// items, terms, classes).
//
// Test surface organized in 5 layers, mirroring the conventions in
// iterator.test.ts / data-ext-custom-fields.test.ts:
//   Layer 1 — QBLookupCache primitive (get/set/invalidate/TTL/companyFileChanged)
//   Layer 2 — QBSessionManager integration (instantiated, exposed, switchCompanyFile clears)
//   Layer 3 — Tool-level cache hit/miss/bypass per list tool
//   Layer 4 — qb_cache_invalidate tool (scoped + all-clear)
//   Layer 5 — Spy assertions that cached reads SKIP the wire (no queryEntity call)
//
// The cache is "in-process state" — there's no observable side effect
// other than skipping the wire call. Layer 5's spy assertions are
// load-bearing; layers 1–4 verify shape but a passing 5 means the
// optimization actually fires.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import {
  QBLookupCache,
  DEFAULT_LOOKUP_TTL_MS,
  CACHEABLE_ENTITY_GROUPS,
  CACHEABLE_ENTITIES,
} from "../src/session/lookup-cache.js";
import { registerCustomerTools } from "../src/tools/customers.js";
import { registerAccountTools } from "../src/tools/accounts.js";
import { registerItemTools } from "../src/tools/items.js";
import { registerListTools } from "../src/tools/lists.js";
import { registerCacheTools } from "../src/tools/cache.js";

type Handler = (args: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
const handlers = new Map<string, Handler>();
const schemas = new Map<string, Record<string, z.ZodTypeAny>>();
const fakeServer = {
  tool: (name: string, _description: string, schema: Record<string, z.ZodTypeAny>, handler: Handler) => {
    handlers.set(name, handler);
    schemas.set(name, schema);
  },
};

let session: QBSessionManager;

beforeAll(async () => {
  session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-lookup-cache",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  const getSession = () => session;
  registerCustomerTools(fakeServer as never, getSession);
  registerAccountTools(fakeServer as never, getSession);
  registerItemTools(fakeServer as never, getSession);
  registerListTools(fakeServer as never, getSession);
  registerCacheTools(fakeServer as never, getSession);
  await session.openSession();
});

beforeEach(() => {
  // Lookup cache is process-scoped state — clear before every test so
  // ordering between tests doesn't matter.
  session.getLookupCache().invalidate();
});

const callTool = async (toolName: string, args: Record<string, unknown>) => {
  const schema = schemas.get(toolName);
  const handler = handlers.get(toolName);
  if (!schema || !handler) throw new Error(`Tool not registered: ${toolName}`);
  const parsed = z.object(schema).safeParse(args);
  if (!parsed.success) return { schemaError: parsed.error };
  const result = await handler(parsed.data);
  const payload = JSON.parse(result.content[0].text);
  return { result, payload };
};

// ---------------------------------------------------------------------------
// Layer 1 — QBLookupCache primitive
// ---------------------------------------------------------------------------

describe("Layer 1 — QBLookupCache primitive", () => {
  it("get returns null on miss", () => {
    const cache = new QBLookupCache();
    expect(cache.get("Account")).toBeNull();
  });

  it("set then get returns the stored entities", () => {
    const cache = new QBLookupCache();
    const rows = [{ ListID: "1", Name: "Bank A" }];
    cache.set("Account", rows);
    expect(cache.get("Account")).toBe(rows);
  });

  it("set overwrites the prior entry", () => {
    const cache = new QBLookupCache();
    cache.set("Account", [{ Name: "old" }]);
    const fresh = [{ Name: "new" }];
    cache.set("Account", fresh);
    expect(cache.get("Account")).toBe(fresh);
  });

  it("get returns null and evicts when an entry ages past TTL", () => {
    const cache = new QBLookupCache(undefined, 100); // 100ms TTL
    cache.set("Account", [{ Name: "x" }]);
    expect(cache.get("Account")).not.toBeNull();
    // Mock Date.now to advance past TTL.
    const real = Date.now;
    try {
      const t0 = real();
      Date.now = () => t0 + 200;
      expect(cache.get("Account")).toBeNull();
      // Entry was lazily evicted on the aged read — keys() should no longer include it.
      expect(cache.keys()).not.toContain("Account");
    } finally {
      Date.now = real;
    }
  });

  it("invalidate(entityType) clears only that key", () => {
    const cache = new QBLookupCache();
    cache.set("Account", [{ a: 1 }]);
    cache.set("Customer", [{ c: 1 }]);
    cache.invalidate("Account");
    expect(cache.get("Account")).toBeNull();
    expect(cache.get("Customer")).not.toBeNull();
  });

  it("invalidate() with no arg clears all entries", () => {
    const cache = new QBLookupCache();
    cache.set("Account", [{}]);
    cache.set("Customer", [{}]);
    cache.set("ItemService", [{}]);
    cache.invalidate();
    expect(cache.keys()).toEqual([]);
  });

  it("companyFileChanged clears the cache + records the new file", () => {
    const cache = new QBLookupCache("file-A");
    cache.set("Customer", [{ Name: "x" }]);
    expect(cache.getCompanyFile()).toBe("file-A");
    cache.companyFileChanged("file-B");
    expect(cache.getCompanyFile()).toBe("file-B");
    expect(cache.get("Customer")).toBeNull();
  });

  it("keys() returns currently-held entity types", () => {
    const cache = new QBLookupCache();
    cache.set("Account", []);
    cache.set("Customer", []);
    expect(new Set(cache.keys())).toEqual(new Set(["Account", "Customer"]));
  });

  it("DEFAULT_LOOKUP_TTL_MS is 5 minutes", () => {
    expect(DEFAULT_LOOKUP_TTL_MS).toBe(5 * 60 * 1000);
  });

  it("CACHEABLE_ENTITY_GROUPS maps Item to 5 subtypes and Terms to 2", () => {
    expect(CACHEABLE_ENTITY_GROUPS.Item).toEqual([
      "ItemService", "ItemInventory", "ItemNonInventory", "ItemOtherCharge", "ItemGroup",
    ]);
    expect(CACHEABLE_ENTITY_GROUPS.Terms).toEqual(["StandardTerms", "DateDrivenTerms"]);
    expect(CACHEABLE_ENTITY_GROUPS.Account).toEqual(["Account"]);
    expect(CACHEABLE_ENTITY_GROUPS.Customer).toEqual(["Customer"]);
    expect(CACHEABLE_ENTITY_GROUPS.Class).toEqual(["Class"]);
  });

  it("CACHEABLE_ENTITIES enumerates exactly 5 user-facing domains", () => {
    expect(CACHEABLE_ENTITIES).toEqual(["Account", "Customer", "Item", "Terms", "Class"]);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — QBSessionManager integration
// ---------------------------------------------------------------------------

describe("Layer 2 — QBSessionManager integration", () => {
  it("session.getLookupCache returns a QBLookupCache instance", () => {
    const sm = new QBSessionManager({
      companyFile: "test-A",
      appName: "vitest",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
    const cache = sm.getLookupCache();
    expect(cache).toBeInstanceOf(QBLookupCache);
    expect(cache.getCompanyFile()).toBe("test-A");
  });

  it("switchCompanyFile clears the lookup cache", async () => {
    const sm = new QBSessionManager({
      companyFile: "test-A",
      appName: "vitest",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
    await sm.openSession();
    sm.getLookupCache().set("Customer", [{ Name: "Acme" }]);
    expect(sm.getLookupCache().get("Customer")).not.toBeNull();

    await sm.switchCompanyFile("test-B");
    expect(sm.getLookupCache().get("Customer")).toBeNull();
    expect(sm.getLookupCache().getCompanyFile()).toBe("test-B");
  });

  it("multiple session managers have independent caches", () => {
    const sm1 = new QBSessionManager({
      companyFile: "A",
      appName: "v1",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
    const sm2 = new QBSessionManager({
      companyFile: "B",
      appName: "v2",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
    sm1.getLookupCache().set("Customer", [{ a: 1 }]);
    expect(sm2.getLookupCache().get("Customer")).toBeNull();
    expect(sm1.getLookupCache().get("Customer")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — Tool-level cache hit / miss / bypass
// ---------------------------------------------------------------------------

describe("Layer 3 — qb_account_list cache behavior", () => {
  it("first unfiltered call hits the wire; second hits the cache", async () => {
    const spy = vi.spyOn(session, "queryEntity");
    try {
      const { payload: first } = await callTool("qb_account_list", {}) as { payload: { count: number; accounts: unknown[]; fromCache?: boolean } };
      expect(first.fromCache).toBeUndefined();
      expect(first.count).toBeGreaterThan(0);
      expect(spy).toHaveBeenCalledTimes(1);

      const { payload: second } = await callTool("qb_account_list", {}) as { payload: { count: number; accounts: unknown[]; fromCache?: boolean } };
      expect(second.fromCache).toBe(true);
      expect(second.count).toBe(first.count);
      // No second wire call.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("accountType filter bypasses the cache (always wire)", async () => {
    // Warm the cache with an unfiltered call.
    await callTool("qb_account_list", {});
    expect(session.getLookupCache().get("Account")).not.toBeNull();

    const spy = vi.spyOn(session, "queryEntity");
    try {
      const { payload } = await callTool("qb_account_list", { accountType: "Bank" }) as { payload: { fromCache?: boolean } };
      expect(payload.fromCache).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("nameFilter bypasses the cache", async () => {
    await callTool("qb_account_list", {});
    const spy = vi.spyOn(session, "queryEntity");
    try {
      const { payload } = await callTool("qb_account_list", { nameFilter: "Bank" }) as { payload: { fromCache?: boolean } };
      expect(payload.fromCache).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("useCache:false forces a fresh wire call even when cache is populated", async () => {
    await callTool("qb_account_list", {});
    expect(session.getLookupCache().get("Account")).not.toBeNull();

    const spy = vi.spyOn(session, "queryEntity");
    try {
      const { payload } = await callTool("qb_account_list", { useCache: false }) as { payload: { fromCache?: boolean } };
      expect(payload.fromCache).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("activeOnly:false bypasses cache (scope change)", async () => {
    await callTool("qb_account_list", {});
    const spy = vi.spyOn(session, "queryEntity");
    try {
      const { payload } = await callTool("qb_account_list", { activeOnly: false }) as { payload: { fromCache?: boolean } };
      expect(payload.fromCache).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("paginate:true bypasses cache (caller-driven pagination)", async () => {
    await callTool("qb_account_list", {});
    const spy = vi.spyOn(session, "queryEntityPaginated");
    try {
      const { payload } = await callTool("qb_account_list", { paginate: true }) as { payload: { fromCache?: boolean } };
      expect(payload.fromCache).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Layer 3 — qb_customer_list cache behavior", () => {
  it("unfiltered call caches + replays", async () => {
    const spy = vi.spyOn(session, "queryEntity");
    try {
      await callTool("qb_customer_list", {});
      const { payload } = await callTool("qb_customer_list", {}) as { payload: { fromCache?: boolean; customers: unknown[] } };
      expect(payload.fromCache).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("parentListID bypasses cache (hierarchy filter)", async () => {
    await callTool("qb_customer_list", {});
    const spy = vi.spyOn(session, "queryEntity");
    try {
      const { payload } = await callTool("qb_customer_list", { parentListID: "XYZ" }) as { payload: { fromCache?: boolean } };
      expect(payload.fromCache).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("jobOnly bypasses cache", async () => {
    await callTool("qb_customer_list", {});
    const spy = vi.spyOn(session, "queryEntity");
    try {
      const { payload } = await callTool("qb_customer_list", { jobOnly: true }) as { payload: { fromCache?: boolean } };
      expect(payload.fromCache).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("includeCustomFields bypasses cache (scope/shape change)", async () => {
    await callTool("qb_customer_list", {});
    const spy = vi.spyOn(session, "queryEntity");
    try {
      const { payload } = await callTool("qb_customer_list", { includeCustomFields: true }) as { payload: { fromCache?: boolean } };
      expect(payload.fromCache).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Layer 3 — qb_item_list per-subtype caching", () => {
  it("itemType:Service caches under 'ItemService' slot only", async () => {
    await callTool("qb_item_list", { itemType: "Service" });
    const cache = session.getLookupCache();
    expect(cache.get("ItemService")).not.toBeNull();
    expect(cache.get("ItemInventory")).toBeNull();

    // Repeat call hits cache.
    const spy = vi.spyOn(session, "queryEntity");
    try {
      const { payload } = await callTool("qb_item_list", { itemType: "Service" }) as { payload: { fromCache?: boolean } };
      expect(payload.fromCache).toBe(true);
      expect(spy).toHaveBeenCalledTimes(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("no-itemType fan-out caches each of the 5 subtypes independently", async () => {
    await callTool("qb_item_list", {});
    const cache = session.getLookupCache();
    expect(cache.get("ItemService")).not.toBeNull();
    expect(cache.get("ItemInventory")).not.toBeNull();
    expect(cache.get("ItemNonInventory")).not.toBeNull();
    expect(cache.get("ItemOtherCharge")).not.toBeNull();
    expect(cache.get("ItemGroup")).not.toBeNull();
  });

  it("no-itemType call returns fromCache only when ALL 5 subtype slots are populated", async () => {
    // Pre-populate 4 of the 5 slots manually.
    const cache = session.getLookupCache();
    cache.set("ItemService", []);
    cache.set("ItemInventory", []);
    cache.set("ItemNonInventory", []);
    cache.set("ItemOtherCharge", []);
    // ItemGroup missing.

    const spy = vi.spyOn(session, "queryEntity");
    try {
      const { payload } = await callTool("qb_item_list", {}) as { payload: { fromCache?: boolean } };
      // Partial hit must NOT serve from cache — falls through to wire.
      expect(payload.fromCache).toBeUndefined();
      // The wire call fans across all 5 subtypes (5 round trips).
      expect(spy).toHaveBeenCalledTimes(5);
    } finally {
      spy.mockRestore();
    }
  });

  it("itemType:Service does NOT bypass cache — itemType is part of the cache key", async () => {
    await callTool("qb_item_list", { itemType: "Service" });
    const spy = vi.spyOn(session, "queryEntity");
    try {
      const { payload } = await callTool("qb_item_list", { itemType: "Service" }) as { payload: { fromCache?: boolean } };
      expect(payload.fromCache).toBe(true);
      expect(spy).toHaveBeenCalledTimes(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("nameFilter bypasses item cache", async () => {
    await callTool("qb_item_list", { itemType: "Service" });
    const spy = vi.spyOn(session, "queryEntity");
    try {
      const { payload } = await callTool("qb_item_list", { itemType: "Service", nameFilter: "Consulting" }) as { payload: { fromCache?: boolean } };
      expect(payload.fromCache).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Layer 3 — qb_terms_list per-subtype caching", () => {
  it("default fan-out caches both StandardTerms + DateDrivenTerms", async () => {
    await callTool("qb_terms_list", {});
    const cache = session.getLookupCache();
    expect(cache.get("StandardTerms")).not.toBeNull();
    expect(cache.get("DateDrivenTerms")).not.toBeNull();
  });

  it("repeat default call serves from cache and re-emits TermsType tags", async () => {
    await callTool("qb_terms_list", {});
    const spy = vi.spyOn(session, "queryEntity");
    try {
      const { payload } = await callTool("qb_terms_list", {}) as { payload: { fromCache?: boolean; terms: { TermsType?: string }[] } };
      expect(payload.fromCache).toBe(true);
      expect(spy).toHaveBeenCalledTimes(0);
      // TermsType tag is a tool-layer enrichment — must still appear when
      // serving from cache (the wire result we cached doesn't carry it).
      expect(payload.terms.every((t) => t.TermsType === "StandardTerms" || t.TermsType === "DateDrivenTerms")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("termsType:Standard caches under the StandardTerms slot only", async () => {
    await callTool("qb_terms_list", { termsType: "Standard" });
    const cache = session.getLookupCache();
    expect(cache.get("StandardTerms")).not.toBeNull();
    expect(cache.get("DateDrivenTerms")).toBeNull();
  });
});

describe("Layer 3 — qb_class_list cache behavior", () => {
  it("unfiltered call caches + replays", async () => {
    const spy = vi.spyOn(session, "queryEntity");
    try {
      await callTool("qb_class_list", {});
      const { payload } = await callTool("qb_class_list", {}) as { payload: { fromCache?: boolean } };
      expect(payload.fromCache).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("nameFilter bypasses class cache", async () => {
    await callTool("qb_class_list", {});
    const spy = vi.spyOn(session, "queryEntity");
    try {
      const { payload } = await callTool("qb_class_list", { nameFilter: "X" }) as { payload: { fromCache?: boolean } };
      expect(payload.fromCache).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — qb_cache_invalidate tool surface
// ---------------------------------------------------------------------------

describe("Layer 4 — qb_cache_invalidate tool", () => {
  it("invalidate({entity:'Customer'}) clears only the Customer slot", async () => {
    await callTool("qb_account_list", {});
    await callTool("qb_customer_list", {});
    expect(session.getLookupCache().get("Customer")).not.toBeNull();
    expect(session.getLookupCache().get("Account")).not.toBeNull();

    const { payload } = await callTool("qb_cache_invalidate", { entity: "Customer" }) as { payload: { success: boolean; scope: string; cleared: string[]; count: number } };
    expect(payload.success).toBe(true);
    expect(payload.scope).toBe("Customer");
    expect(payload.cleared).toEqual(["Customer"]);
    expect(payload.count).toBe(1);
    expect(session.getLookupCache().get("Customer")).toBeNull();
    expect(session.getLookupCache().get("Account")).not.toBeNull();
  });

  it("invalidate({entity:'Item'}) clears all 5 Item subtype slots", async () => {
    await callTool("qb_item_list", {});
    const cache = session.getLookupCache();
    expect(cache.get("ItemService")).not.toBeNull();
    expect(cache.get("ItemInventory")).not.toBeNull();

    const { payload } = await callTool("qb_cache_invalidate", { entity: "Item" }) as { payload: { cleared: string[]; count: number } };
    expect(new Set(payload.cleared)).toEqual(new Set([
      "ItemService", "ItemInventory", "ItemNonInventory", "ItemOtherCharge", "ItemGroup",
    ]));
    expect(payload.count).toBe(5);
    expect(cache.get("ItemService")).toBeNull();
    expect(cache.get("ItemInventory")).toBeNull();
    expect(cache.get("ItemNonInventory")).toBeNull();
    expect(cache.get("ItemOtherCharge")).toBeNull();
    expect(cache.get("ItemGroup")).toBeNull();
  });

  it("invalidate({entity:'Terms'}) clears both Terms subtypes", async () => {
    await callTool("qb_terms_list", {});
    const cache = session.getLookupCache();
    expect(cache.get("StandardTerms")).not.toBeNull();
    expect(cache.get("DateDrivenTerms")).not.toBeNull();

    const { payload } = await callTool("qb_cache_invalidate", { entity: "Terms" }) as { payload: { cleared: string[] } };
    expect(new Set(payload.cleared)).toEqual(new Set(["StandardTerms", "DateDrivenTerms"]));
    expect(cache.get("StandardTerms")).toBeNull();
    expect(cache.get("DateDrivenTerms")).toBeNull();
  });

  it("invalidate() with no entity clears every cached slot", async () => {
    await callTool("qb_account_list", {});
    await callTool("qb_customer_list", {});
    await callTool("qb_class_list", {});
    expect(session.getLookupCache().keys().length).toBeGreaterThanOrEqual(3);

    const { payload } = await callTool("qb_cache_invalidate", {}) as { payload: { scope: string; cleared: string[]; count: number } };
    expect(payload.scope).toBe("all");
    expect(payload.count).toBeGreaterThanOrEqual(3);
    expect(new Set(payload.cleared)).toEqual(new Set(["Account", "Customer", "Class"]));
    expect(session.getLookupCache().keys()).toEqual([]);
  });

  it("invalidate on an empty cache returns cleared:[] success", async () => {
    const { payload } = await callTool("qb_cache_invalidate", { entity: "Customer" }) as { payload: { success: boolean; cleared: string[]; count: number } };
    expect(payload.success).toBe(true);
    expect(payload.cleared).toEqual([]);
    expect(payload.count).toBe(0);
  });

  it("invalidate on an empty cache with no entity returns scope:'all' + cleared:[]", async () => {
    const { payload } = await callTool("qb_cache_invalidate", {}) as { payload: { scope: string; cleared: string[]; count: number } };
    expect(payload.scope).toBe("all");
    expect(payload.cleared).toEqual([]);
    expect(payload.count).toBe(0);
  });

  it("invalidate with an invalid entity name rejects at the schema layer", async () => {
    const r = await callTool("qb_cache_invalidate", { entity: "BogusEntity" });
    expect("schemaError" in r).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 5 — End-to-end cross-tool composition
// ---------------------------------------------------------------------------

describe("Layer 5 — cross-tool cache lifecycle", () => {
  it("populate via list → invalidate via tool → next list hits wire again", async () => {
    const spy = vi.spyOn(session, "queryEntity");
    try {
      await callTool("qb_account_list", {});                       // wire hit
      expect(spy).toHaveBeenCalledTimes(1);

      await callTool("qb_account_list", {});                       // cache hit
      expect(spy).toHaveBeenCalledTimes(1);

      await callTool("qb_cache_invalidate", { entity: "Account" }); // clear
      await callTool("qb_account_list", {});                       // wire hit again
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("switchCompanyFile mid-session clears cache for the new book", async () => {
    await callTool("qb_customer_list", {});
    expect(session.getLookupCache().get("Customer")).not.toBeNull();

    await session.switchCompanyFile("simulation-other");
    expect(session.getLookupCache().get("Customer")).toBeNull();
    expect(session.getLookupCache().getCompanyFile()).toBe("simulation-other");

    // Switch back to clean state for subsequent tests.
    await session.switchCompanyFile("simulation");
  });

  it("Item-scoped invalidate followed by no-itemType list refreshes only that subtype", async () => {
    // Prime all 5 item subtype slots.
    await callTool("qb_item_list", {});
    const cache = session.getLookupCache();
    const beforeService = cache.get("ItemService");
    const beforeInventory = cache.get("ItemInventory");
    expect(beforeService).not.toBeNull();
    expect(beforeInventory).not.toBeNull();

    // Invalidate one subtype directly via the underlying cache (no
    // user-facing surface to clear ONE subtype — the user-facing
    // surface clears all 5 for "Item"). This pins that the partial
    // miss in the no-itemType path falls through to wire.
    cache.invalidate("ItemService");

    const spy = vi.spyOn(session, "queryEntity");
    try {
      const { payload } = await callTool("qb_item_list", {}) as { payload: { fromCache?: boolean } };
      // 4 of 5 subtypes cached + ItemService missing → wire fan-out.
      expect(payload.fromCache).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(5);
    } finally {
      spy.mockRestore();
    }
  });
});
