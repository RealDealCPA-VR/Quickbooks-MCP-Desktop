// Phase 14 #67 — qb_session_status (diagnostic snapshot).
//
// Coverage layers:
//   1. Manager surface — getTransientRetryStats / getAppName / getAppId /
//      getQbxmlVersion. Pure reads + rolling-window prune semantics.
//   2. Tool defaults — sim-mode snapshot with no opts: shape, no wire I/O,
//      hostInfo null when cache empty, retryStats zeroed.
//   3. Tool with `probe: true` — sim happy path populates the cache and
//      reports ok:true; failure path surfaces `probe.ok:false` without
//      making the outer response isError.
//   4. Tool with `includeClosingDate: true` — sim happy path returns the
//      closing-date block; failure path surfaces `closingDate.error` without
//      making the outer response isError.
//   5. State after activity — host cache populated by a prior getHostInfo
//      call surfaces in the snapshot; readOnly toggle reflected.
//   6. Retry observability — direct push of timestamps (the live-retry test
//      file already pins the push path in sendLiveRequestWithRetry; here we
//      verify the GETTER's prune + count contract end-to-end).
//   7. switchCompanyFile clears retry stats and hostInfo cache so a fresh
//      book starts with a clean observability window.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerReportTools } from "../src/tools/reports.js";

// ---------------------------------------------------------------------------
// Test harness — wire the tool into a fake McpServer that captures handlers
// ---------------------------------------------------------------------------

type Handler = (args: unknown) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function makeHarness() {
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
  const session = new QBSessionManager({
    companyFile: "C:\\fixtures\\StatusTest.qbw",
    appName: "vitest-session-status",
    appId: "test-app-id-123",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  registerReportTools(fakeServer as never, () => session);
  return { handlers, session };
}

async function call(handlers: Map<string, Handler>, name: string, args: unknown = {}) {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`Handler not registered: ${name}`);
  const result = await handler(args);
  const text = result.content[0].text;
  return { result, body: JSON.parse(text) };
}

// ---------------------------------------------------------------------------
// Layer 1 — Manager surface
// ---------------------------------------------------------------------------

describe("QBSessionManager — config getters", () => {
  it("getAppName / getAppId / getQbxmlVersion return the configured values", () => {
    const sm = new QBSessionManager({
      companyFile: "C:\\X.qbw",
      appName: "test-app",
      appId: "id-abc",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
    expect(sm.getAppName()).toBe("test-app");
    expect(sm.getAppId()).toBe("id-abc");
    expect(sm.getQbxmlVersion()).toBe("16.0");
  });

  it("getAppId returns undefined when not configured", () => {
    const sm = new QBSessionManager({
      companyFile: "C:\\X.qbw",
      appName: "test-app",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
    expect(sm.getAppId()).toBeUndefined();
  });
});

describe("QBSessionManager.getTransientRetryStats — rolling-window prune", () => {
  let sm: QBSessionManager;
  beforeEach(() => {
    sm = new QBSessionManager({
      companyFile: "C:\\X.qbw",
      appName: "test-app",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
  });

  it("returns zeros on a fresh manager", () => {
    const stats = sm.getTransientRetryStats();
    expect(stats).toEqual({
      lastTransientRetryAt: null,
      transientRetryCountLastHour: 0,
      totalTransientRetries: 0,
    });
  });

  it("counts in-window timestamps and reports the latest as lastTransientRetryAt", () => {
    const now = Date.now();
    const tenMinAgo = now - 10 * 60_000;
    const fiveMinAgo = now - 5 * 60_000;
    const oneMinAgo = now - 60_000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internal = sm as any;
    internal.transientRetryTimestamps = [tenMinAgo, fiveMinAgo, oneMinAgo];
    internal.totalTransientRetries = 3;
    const stats = sm.getTransientRetryStats();
    expect(stats.transientRetryCountLastHour).toBe(3);
    expect(stats.totalTransientRetries).toBe(3);
    expect(stats.lastTransientRetryAt).toBe(new Date(oneMinAgo).toISOString());
  });

  it("prunes timestamps older than 1 hour but preserves totalTransientRetries", () => {
    const now = Date.now();
    const twoHoursAgo = now - 2 * 3600_000;
    const ninetyMinAgo = now - 90 * 60_000;
    const thirtyMinAgo = now - 30 * 60_000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internal = sm as any;
    internal.transientRetryTimestamps = [twoHoursAgo, ninetyMinAgo, thirtyMinAgo];
    internal.totalTransientRetries = 3;
    const stats = sm.getTransientRetryStats();
    // Only the 30-min-ago entry survives the prune.
    expect(stats.transientRetryCountLastHour).toBe(1);
    expect(stats.totalTransientRetries).toBe(3);
    expect(stats.lastTransientRetryAt).toBe(new Date(thirtyMinAgo).toISOString());
    // The internal array was pruned in-place (no stale entries left).
    expect(internal.transientRetryTimestamps).toEqual([thirtyMinAgo]);
  });

  it("prunes ALL entries when every timestamp is stale", () => {
    const now = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internal = sm as any;
    internal.transientRetryTimestamps = [now - 3 * 3600_000, now - 2 * 3600_000];
    internal.totalTransientRetries = 2;
    const stats = sm.getTransientRetryStats();
    expect(stats.transientRetryCountLastHour).toBe(0);
    expect(stats.lastTransientRetryAt).toBeNull();
    expect(stats.totalTransientRetries).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — Tool defaults (no opts)
// ---------------------------------------------------------------------------

describe("qb_session_status — default snapshot (no opts)", () => {
  it("returns the full default shape in simulation mode with zero wire I/O", async () => {
    const { handlers, session } = makeHarness();
    await session.openSession();
    // Spy on queryEntity to assert NO wire I/O fires for the default snapshot.
    const queryEntitySpy = vi.spyOn(session, "queryEntity");

    const { result, body } = await call(handlers, "qb_session_status");

    expect(result.isError).toBeFalsy();
    expect(body.connected).toBe(true);
    expect(body.mode).toBe("simulation");
    expect(body.companyFile).toBe("C:\\fixtures\\StatusTest.qbw");
    expect(body.appName).toBe("vitest-session-status");
    expect(body.appId).toBe("test-app-id-123");
    expect(body.qbxmlVersion).toBe("16.0");
    expect(body.readOnly).toBe(false);
    expect(typeof body.ticket).toBe("string");
    expect(body.ticket).toMatch(/^SIM-/);
    expect(typeof body.openedAt).toBe("string");
    expect(body.serverVersion).toBe("1.0.0");
    // No prior wire calls → host info cache is empty → field is null.
    expect(body.hostInfo).toBeNull();
    expect(body.retryStats).toEqual({
      lastTransientRetryAt: null,
      transientRetryCountLastHour: 0,
      totalTransientRetries: 0,
    });
    // Opt-in fields are absent on the default path.
    expect(body.probe).toBeUndefined();
    expect(body.closingDate).toBeUndefined();
    // Verified zero wire I/O.
    expect(queryEntitySpy).not.toHaveBeenCalled();
  });

  it("reports connected:false before openSession is called", async () => {
    const { handlers, session } = makeHarness();
    // Do NOT call openSession — manager is constructed, store seeded, but
    // session.getSession() returns null.
    expect(session.isConnected()).toBe(false);

    const { body } = await call(handlers, "qb_session_status");
    expect(body.connected).toBe(false);
    expect(body.ticket).toBeNull();
    expect(body.openedAt).toBeNull();
    // companyFile still surfaces from the config even when no session is open.
    expect(body.companyFile).toBe("C:\\fixtures\\StatusTest.qbw");
  });

  it("reflects readOnly toggle via setReadOnly", async () => {
    const { handlers, session } = makeHarness();
    await session.openSession();

    let snap = await call(handlers, "qb_session_status");
    expect(snap.body.readOnly).toBe(false);

    session.setReadOnly(true);
    snap = await call(handlers, "qb_session_status");
    expect(snap.body.readOnly).toBe(true);

    session.setReadOnly(false);
    snap = await call(handlers, "qb_session_status");
    expect(snap.body.readOnly).toBe(false);
  });

  it("surfaces a populated hostInfo cache when a prior getHostInfo() ran", async () => {
    const { handlers, session } = makeHarness();
    await session.openSession();
    // Populate the cache via a real call.
    await session.getHostInfo();
    expect(session.peekHostInfoCache()).not.toBeNull();

    const { body } = await call(handlers, "qb_session_status");
    expect(body.hostInfo).not.toBeNull();
    expect(typeof body.hostInfo.productName).toBe("string");
    expect(body.hostInfo.edition).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — probe: true
// ---------------------------------------------------------------------------

describe("qb_session_status — probe: true", () => {
  it("runs a fresh HostQueryRq and reports probe.ok:true on success (sim mode)", async () => {
    const { handlers, session } = makeHarness();
    await session.openSession();

    const { result, body } = await call(handlers, "qb_session_status", { probe: true });
    expect(result.isError).toBeFalsy();
    expect(body.probe).toEqual({ ok: true });
    // After a successful probe the cache is populated; the snapshot reflects it.
    expect(body.hostInfo).not.toBeNull();
  });

  it("probe with refresh:true forces a wire call even when the cache is populated", async () => {
    const { handlers, session } = makeHarness();
    await session.openSession();
    // Populate cache without a refresh.
    await session.getHostInfo();
    const getHostSpy = vi.spyOn(session, "getHostInfo");

    await call(handlers, "qb_session_status", { probe: true });
    expect(getHostSpy).toHaveBeenCalledWith({ refresh: true });
  });

  it("surfaces probe.ok:false on a HostQueryRq failure WITHOUT making the response isError", async () => {
    const { handlers, session } = makeHarness();
    await session.openSession();
    // Force HostQueryRq to throw a structured QBXMLResponseError-shaped error.
    vi.spyOn(session, "getHostInfo").mockRejectedValue(
      Object.assign(new Error("Host query failed"), { statusCode: 500 }),
    );

    const { result, body } = await call(handlers, "qb_session_status", { probe: true });
    expect(result.isError).toBeFalsy(); // fail-soft contract
    expect(body.probe.ok).toBe(false);
    expect(body.probe.statusCode).toBe(500);
    expect(body.probe.statusMessage).toBe("Host query failed");
    expect(body.probe.humanReadable).toBeDefined(); // 500 is in the status-code table
    // The rest of the snapshot still surfaces normally.
    expect(body.connected).toBe(true);
    expect(body.mode).toBe("simulation");
  });

  it("does NOT add a probe field when probe is omitted or false", async () => {
    const { handlers, session } = makeHarness();
    await session.openSession();

    let snap = await call(handlers, "qb_session_status", {});
    expect(snap.body.probe).toBeUndefined();

    snap = await call(handlers, "qb_session_status", { probe: false });
    expect(snap.body.probe).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — includeClosingDate: true
// ---------------------------------------------------------------------------

describe("qb_session_status — includeClosingDate: true", () => {
  it("folds the closing date + accounting flags into the snapshot on success", async () => {
    const { handlers, session } = makeHarness();
    await session.openSession();

    const { result, body } = await call(handlers, "qb_session_status", {
      includeClosingDate: true,
    });
    expect(result.isError).toBeFalsy();
    expect(body.closingDate).toBeDefined();
    expect(body.closingDate.error).toBeUndefined();
    // Sim seed exposes the four flags as booleans (true|false), closingDate
    // as either null or an ISO date string.
    expect(typeof body.closingDate.isUsingAuditTrail).toBe("boolean");
    expect(typeof body.closingDate.isUsingClassTracking).toBe("boolean");
    expect(typeof body.closingDate.isUsingAccountNumbers).toBe("boolean");
    expect(typeof body.closingDate.isRequiringAccounts).toBe("boolean");
    expect(
      body.closingDate.closingDate === null ||
        /^\d{4}-\d{2}-\d{2}$/.test(body.closingDate.closingDate),
    ).toBe(true);
  });

  it("surfaces closingDate.error on a PreferencesQueryRq failure WITHOUT making the response isError", async () => {
    const { handlers, session } = makeHarness();
    await session.openSession();
    vi.spyOn(session, "queryEntity").mockImplementation(async (entityType) => {
      if (entityType === "Preferences") {
        throw Object.assign(new Error("Preferences query failed"), {
          statusCode: 3120,
        });
      }
      return [];
    });

    const { result, body } = await call(handlers, "qb_session_status", {
      includeClosingDate: true,
    });
    expect(result.isError).toBeFalsy();
    expect(body.closingDate.error).toBeDefined();
    expect(body.closingDate.error.statusCode).toBe(3120);
    expect(body.closingDate.error.statusMessage).toBe("Preferences query failed");
    expect(body.closingDate.error.humanReadable).toBeDefined();
    // Rest of the snapshot is intact.
    expect(body.connected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 5 — Retry observability surfaces via the tool
// ---------------------------------------------------------------------------

describe("qb_session_status — retry observability via the tool", () => {
  it("surfaces transient-retry stats via the snapshot", async () => {
    const { handlers, session } = makeHarness();
    await session.openSession();
    const now = Date.now();
    const twoMinAgo = now - 2 * 60_000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internal = session as any;
    internal.transientRetryTimestamps = [twoMinAgo, now - 30_000];
    internal.totalTransientRetries = 5;

    const { body } = await call(handlers, "qb_session_status");
    expect(body.retryStats.transientRetryCountLastHour).toBe(2);
    expect(body.retryStats.totalTransientRetries).toBe(5);
    expect(body.retryStats.lastTransientRetryAt).toBeDefined();
    expect(new Date(body.retryStats.lastTransientRetryAt).getTime()).toBe(now - 30_000);
  });

  it("reports zero retries when none have fired", async () => {
    const { handlers, session } = makeHarness();
    await session.openSession();

    const { body } = await call(handlers, "qb_session_status");
    expect(body.retryStats).toEqual({
      lastTransientRetryAt: null,
      transientRetryCountLastHour: 0,
      totalTransientRetries: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Layer 6 — switchCompanyFile clears retry stats + host info cache
// ---------------------------------------------------------------------------

describe("QBSessionManager.switchCompanyFile — clears observability state", () => {
  it("resets transientRetryTimestamps, totalTransientRetries, AND hostInfoCache so a fresh book starts clean", async () => {
    const sm = new QBSessionManager({
      companyFile: "C:\\BookA.qbw",
      appName: "test-app",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
    await sm.openSession();
    // Populate state.
    await sm.getHostInfo();
    expect(sm.peekHostInfoCache()).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internal = sm as any;
    internal.transientRetryTimestamps = [Date.now() - 30_000];
    internal.totalTransientRetries = 7;

    // Switch books.
    await sm.switchCompanyFile("C:\\BookB.qbw");

    expect(sm.getCompanyFile()).toBe("C:\\BookB.qbw");
    expect(sm.peekHostInfoCache()).toBeNull();
    const stats = sm.getTransientRetryStats();
    expect(stats).toEqual({
      lastTransientRetryAt: null,
      transientRetryCountLastHour: 0,
      totalTransientRetries: 0,
    });
  });
});
