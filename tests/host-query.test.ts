// Phase 18 #82 — qb_host_query (QB edition / version detection).
//
// Coverage layers:
//   1. Pure helpers — deriveHostEdition across every product-name family,
//      normalizeHostInfo across raw shapes (multi-version vs single-version
//      lists, boolean coercion, missing fields).
//   2. Sim handler — queryEntity("Host", {}) flows through generic handleQuery
//      against the Host singleton; response shape matches the HostRet contract.
//   3. Manager — getHostInfo() caches, refresh:true bypasses cache,
//      switchCompanyFile invalidates the cache.
//   4. Tool surface — qb_host_query returns normalized HostInfo with derived
//      edition + cached flag; error wrapping when the underlying query throws.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { z } from "zod";
import {
  QBSessionManager,
  deriveHostEdition,
  normalizeHostInfo,
  type HostInfo,
} from "../src/session/manager.js";
import { registerReportTools } from "../src/tools/reports.js";

type Handler = (args: unknown) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;
const handlers = new Map<string, Handler>();
const fakeServer = {
  tool: (
    name: string,
    _description: string,
    _schema: Record<string, z.ZodTypeAny>,
    handler: Handler,
  ) => {
    handlers.set(name, handler);
  },
};

let session: QBSessionManager;

beforeAll(async () => {
  session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-host-query",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  registerReportTools(fakeServer as never, () => session);
  await session.openSession();
});

// ---------------------------------------------------------------------------
// Layer 1 — Pure helpers
// ---------------------------------------------------------------------------

describe("deriveHostEdition", () => {
  it("returns Pro for QuickBooks Pro", () => {
    expect(deriveHostEdition("QuickBooks Pro 2024")).toBe("Pro");
  });

  it("returns Premier for QuickBooks Premier (no Accountant)", () => {
    expect(deriveHostEdition("QuickBooks Premier Edition 2024")).toBe("Premier");
  });

  it("returns PremierAccountant for QuickBooks Premier Accountant", () => {
    expect(deriveHostEdition("QuickBooks Premier Accountant Edition 2024")).toBe("PremierAccountant");
  });

  it("returns PremierAccountant for standalone QuickBooks Accountant brand", () => {
    // The "QuickBooks Accountant Desktop" SKU is a rebranded Premier Accountant
    // — no Enterprise / no Premier in the name, but Accountant features.
    expect(deriveHostEdition("QuickBooks Accountant Desktop 2024")).toBe("PremierAccountant");
  });

  it("returns Enterprise for QuickBooks Enterprise Solutions (no Accountant)", () => {
    expect(deriveHostEdition("QuickBooks Enterprise Solutions 24.0")).toBe("Enterprise");
  });

  it("returns EnterpriseAccountant for Enterprise + Accountant", () => {
    expect(deriveHostEdition("QuickBooks Enterprise Solutions: Accountant 24.0")).toBe("EnterpriseAccountant");
  });

  it("prefers Enterprise classification over Premier when both appear", () => {
    // Defensive — marketing copy edge case. Family marker order: Enterprise > Premier.
    expect(deriveHostEdition("QuickBooks Enterprise Premier Hybrid 99")).toBe("Enterprise");
  });

  it("returns Unknown for unrecognized product names", () => {
    expect(deriveHostEdition("")).toBe("Unknown");
    expect(deriveHostEdition("Intuit Books Online")).toBe("Unknown");
  });

  it("is case-insensitive", () => {
    expect(deriveHostEdition("QUICKBOOKS PRO 2024")).toBe("Pro");
    expect(deriveHostEdition("quickbooks premier accountant edition")).toBe("PremierAccountant");
  });
});

describe("normalizeHostInfo", () => {
  it("normalizes a multi-version SupportedQBXMLVersionList into a flat array", () => {
    const info = normalizeHostInfo({
      ProductName: "QuickBooks Pro 2024",
      MajorVersion: "34",
      MinorVersion: "0",
      Country: "US",
      SupportedQBXMLVersionList: {
        Version: ["1.0", "8.0", "16.0"],
      },
      IsAutomaticLogin: false,
      QBFileMode: "SingleUser",
    });
    expect(info.supportedQbxmlVersions).toEqual(["1.0", "8.0", "16.0"]);
    expect(info.maxQbxmlVersion).toBe("16.0");
  });

  it("coerces a single-version list (parser surfaces it as a string, not array)", () => {
    // fast-xml-parser emits {Version: "16.0"} when only one Version element is
    // present (Version isn't in arrayElements). Normalizer wraps it.
    const info = normalizeHostInfo({
      ProductName: "QuickBooks Pro 2024",
      SupportedQBXMLVersionList: { Version: "16.0" },
    });
    expect(info.supportedQbxmlVersions).toEqual(["16.0"]);
    expect(info.maxQbxmlVersion).toBe("16.0");
  });

  it("computes maxQbxmlVersion numerically, not lexicographically", () => {
    // Lex compare would put "9.0" > "16.0" because "9" > "1".
    const info = normalizeHostInfo({
      ProductName: "QuickBooks Pro 2024",
      SupportedQBXMLVersionList: {
        Version: ["9.0", "10.0", "16.0", "2.1"],
      },
    });
    expect(info.maxQbxmlVersion).toBe("16.0");
  });

  it("returns empty version list + null max when SupportedQBXMLVersionList missing", () => {
    const info = normalizeHostInfo({ ProductName: "QuickBooks Pro 2024" });
    expect(info.supportedQbxmlVersions).toEqual([]);
    expect(info.maxQbxmlVersion).toBeNull();
  });

  it("coerces IsAutomaticLogin from string 'true'/'false' to boolean", () => {
    expect(normalizeHostInfo({ IsAutomaticLogin: "true" }).isAutomaticLogin).toBe(true);
    expect(normalizeHostInfo({ IsAutomaticLogin: "false" }).isAutomaticLogin).toBe(false);
    expect(normalizeHostInfo({ IsAutomaticLogin: "TRUE" }).isAutomaticLogin).toBe(true);
  });

  it("preserves IsAutomaticLogin as boolean when already boolean", () => {
    expect(normalizeHostInfo({ IsAutomaticLogin: true }).isAutomaticLogin).toBe(true);
    expect(normalizeHostInfo({ IsAutomaticLogin: false }).isAutomaticLogin).toBe(false);
  });

  it("defaults IsAutomaticLogin to false when missing or malformed", () => {
    expect(normalizeHostInfo({}).isAutomaticLogin).toBe(false);
    expect(normalizeHostInfo({ IsAutomaticLogin: null }).isAutomaticLogin).toBe(false);
  });

  it("populates derived edition + isEnterprise + isAccountant flags", () => {
    const ent = normalizeHostInfo({ ProductName: "QuickBooks Enterprise 24.0" });
    expect(ent.edition).toBe("Enterprise");
    expect(ent.isEnterprise).toBe(true);
    expect(ent.isAccountant).toBe(false);

    const entAcct = normalizeHostInfo({ ProductName: "QuickBooks Enterprise Solutions: Accountant 24.0" });
    expect(entAcct.edition).toBe("EnterpriseAccountant");
    expect(entAcct.isEnterprise).toBe(true);
    expect(entAcct.isAccountant).toBe(true);

    const prem = normalizeHostInfo({ ProductName: "QuickBooks Premier Accountant 2024" });
    expect(prem.edition).toBe("PremierAccountant");
    expect(prem.isEnterprise).toBe(false);
    expect(prem.isAccountant).toBe(true);

    const pro = normalizeHostInfo({ ProductName: "QuickBooks Pro 2024" });
    expect(pro.edition).toBe("Pro");
    expect(pro.isEnterprise).toBe(false);
    expect(pro.isAccountant).toBe(false);
  });

  it("defaults string fields to empty string when missing", () => {
    const info = normalizeHostInfo({});
    expect(info.productName).toBe("");
    expect(info.majorVersion).toBe("");
    expect(info.minorVersion).toBe("");
    expect(info.country).toBe("");
    expect(info.qbFileMode).toBe("");
    expect(info.edition).toBe("Unknown");
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — Sim handler via generic handleQuery
// ---------------------------------------------------------------------------

describe("simulation: HostQueryRq via queryEntity", () => {
  it("returns the seeded Host singleton through the generic handleQuery path", async () => {
    const records = await session.queryEntity("Host", {});
    expect(records).toHaveLength(1);
    const h = records[0];
    expect(h.ProductName).toBe("QuickBooks Premier Accountant Edition 2024");
    expect(h.MajorVersion).toBe("34");
    expect(h.MinorVersion).toBe("0");
    expect(h.Country).toBe("US");
    expect(h.IsAutomaticLogin).toBe(false);
    expect(h.QBFileMode).toBe("SingleUser");
  });

  it("seed includes a multi-version SupportedQBXMLVersionList that flattens to 19 versions", async () => {
    const records = await session.queryEntity("Host", {});
    const list = records[0].SupportedQBXMLVersionList as { Version: string[] };
    expect(Array.isArray(list.Version)).toBe(true);
    expect(list.Version).toContain("16.0");
    expect(list.Version).toContain("1.0");
    expect(list.Version.length).toBeGreaterThanOrEqual(19);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — Manager caching + invalidation
// ---------------------------------------------------------------------------

describe("QBSessionManager.getHostInfo — caching", () => {
  let mgr: QBSessionManager;

  beforeEach(async () => {
    mgr = new QBSessionManager({
      companyFile: "simulation",
      appName: "vitest-host-query-cache",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
    await mgr.openSession();
  });

  it("returns the normalized HostInfo on first call", async () => {
    const info = await mgr.getHostInfo();
    expect(info.productName).toBe("QuickBooks Premier Accountant Edition 2024");
    expect(info.edition).toBe("PremierAccountant");
    expect(info.isAccountant).toBe(true);
    expect(info.isEnterprise).toBe(false);
    expect(info.maxQbxmlVersion).toBe("16.0");
    expect(info.supportedQbxmlVersions).toContain("16.0");
  });

  it("returns the cached value on subsequent calls (object identity)", async () => {
    const first = await mgr.getHostInfo();
    const second = await mgr.getHostInfo();
    // Same object reference — cached, not re-normalized.
    expect(second).toBe(first);
  });

  it("peekHostInfoCache returns null before first call, then the cached value", async () => {
    expect(mgr.peekHostInfoCache()).toBeNull();
    const info = await mgr.getHostInfo();
    expect(mgr.peekHostInfoCache()).toBe(info);
  });

  it("refresh:true bypasses the cache and re-queries (new object identity)", async () => {
    const first = await mgr.getHostInfo();
    const second = await mgr.getHostInfo({ refresh: true });
    // Different object reference — the refresh path normalized a fresh response.
    expect(second).not.toBe(first);
    // But the data is identical because the sim seed is deterministic.
    expect(second).toEqual(first);
  });

  it("switchCompanyFile clears the cache", async () => {
    await mgr.getHostInfo();
    expect(mgr.peekHostInfoCache()).not.toBeNull();
    await mgr.switchCompanyFile("simulation-2");
    expect(mgr.peekHostInfoCache()).toBeNull();
    // Next call repopulates.
    const fresh = await mgr.getHostInfo();
    expect(fresh.productName).toBe("QuickBooks Premier Accountant Edition 2024");
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — Tool surface
// ---------------------------------------------------------------------------

describe("qb_host_query tool", () => {
  it("is registered", () => {
    expect(handlers.has("qb_host_query")).toBe(true);
  });

  it("returns the normalized HostInfo with derived fields and simulationMode flag", async () => {
    // Fresh session manager so the cached flag has a known starting state.
    const mgr = new QBSessionManager({
      companyFile: "simulation",
      appName: "vitest-host-query-tool",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
    await mgr.openSession();
    const localHandlers = new Map<string, Handler>();
    const localServer = {
      tool: (name: string, _d: string, _s: unknown, h: Handler) => {
        localHandlers.set(name, h);
      },
    };
    registerReportTools(localServer as never, () => mgr);

    const handler = localHandlers.get("qb_host_query");
    expect(handler).toBeDefined();
    const res = await handler!({});
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text) as HostInfo & {
      cached: boolean;
      simulationMode: boolean;
    };
    expect(body.productName).toBe("QuickBooks Premier Accountant Edition 2024");
    expect(body.edition).toBe("PremierAccountant");
    expect(body.isEnterprise).toBe(false);
    expect(body.isAccountant).toBe(true);
    expect(body.maxQbxmlVersion).toBe("16.0");
    expect(body.qbFileMode).toBe("SingleUser");
    expect(body.isAutomaticLogin).toBe(false);
    expect(body.simulationMode).toBe(true);
    expect(Array.isArray(body.supportedQbxmlVersions)).toBe(true);
    expect(body.supportedQbxmlVersions).toContain("16.0");
  });

  it("first call surfaces cached:false; second call surfaces cached:true", async () => {
    const mgr = new QBSessionManager({
      companyFile: "simulation",
      appName: "vitest-host-query-cache-flag",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
    await mgr.openSession();
    const localHandlers = new Map<string, Handler>();
    const localServer = {
      tool: (name: string, _d: string, _s: unknown, h: Handler) => {
        localHandlers.set(name, h);
      },
    };
    registerReportTools(localServer as never, () => mgr);

    const handler = localHandlers.get("qb_host_query")!;
    const first = JSON.parse((await handler({})).content[0].text) as { cached: boolean };
    expect(first.cached).toBe(false);
    const second = JSON.parse((await handler({})).content[0].text) as { cached: boolean };
    expect(second.cached).toBe(true);
  });

  it("refresh:true response surfaces cached:false (cache was bypassed)", async () => {
    const mgr = new QBSessionManager({
      companyFile: "simulation",
      appName: "vitest-host-query-refresh",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
    await mgr.openSession();
    const localHandlers = new Map<string, Handler>();
    const localServer = {
      tool: (name: string, _d: string, _s: unknown, h: Handler) => {
        localHandlers.set(name, h);
      },
    };
    registerReportTools(localServer as never, () => mgr);

    const handler = localHandlers.get("qb_host_query")!;
    await handler({}); // populate cache
    const res = JSON.parse((await handler({ refresh: true })).content[0].text) as { cached: boolean };
    expect(res.cached).toBe(false);
  });

  it("surfaces a structured error when getHostInfo throws", async () => {
    const mgr = new QBSessionManager({
      companyFile: "simulation",
      appName: "vitest-host-query-error",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
    await mgr.openSession();
    // Patch getHostInfo to throw a QB-shaped error (statusCode is the field the
    // tool wrapper reads to look up humanReadable).
    mgr.getHostInfo = async () => {
      const err = new Error("HostQueryRq blew up") as Error & { statusCode: number };
      err.statusCode = 500;
      throw err;
    };
    const localHandlers = new Map<string, Handler>();
    const localServer = {
      tool: (name: string, _d: string, _s: unknown, h: Handler) => {
        localHandlers.set(name, h);
      },
    };
    registerReportTools(localServer as never, () => mgr);

    const handler = localHandlers.get("qb_host_query")!;
    const res = await handler({});
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text) as {
      success: boolean;
      statusCode: number;
      statusMessage: string;
      humanReadable?: string;
    };
    expect(body.success).toBe(false);
    expect(body.statusCode).toBe(500);
    expect(body.statusMessage).toBe("HostQueryRq blew up");
  });
});
