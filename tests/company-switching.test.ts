// Company switching (Phase 7 Items 34-36) — qb_company_open swaps the active
// company file mid-session and resets the simulation store; qb_company_list
// enumerates `.qbw` files under the configured root.
//
// The sim-reset behavior on switch is INTENTIONAL: real QB persists per-file,
// the sim doesn't, so without reseed the operator would see entities from the
// prior company on the "new" one. See DECISIONS.md 2026-05-09 (sim-fidelity
// tradeoff). These tests pin that contract — switch A → B → A returns A's
// fresh seed, NOT the mutations from the first A session.
//
// Tool surface is exercised via the same fakeServer pattern as
// error-shape.test.ts — captures the (name, schema, handler) tuple at
// register time, then drives the handler directly.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  QBLaunchError,
  QBMultiUserLockError,
  QBSessionManager,
} from "../src/session/manager.js";
import { registerReportTools } from "../src/tools/reports.js";
import { QB_LAUNCH_POLL_MS } from "../src/util/qb-desktop-launch.js";

type Handler = (
  args: unknown
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

const setupHarness = () => {
  const handlers = new Map<string, Handler>();
  const fakeServer = {
    tool: (name: string, _description: string, _schema: Record<string, z.ZodTypeAny>, handler: Handler) => {
      handlers.set(name, handler);
    },
  };
  const session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-company-switching",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  registerReportTools(fakeServer as never, () => session);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const h = handlers.get(name);
    if (!h) throw new Error(`tool not registered: ${name}`);
    const result = await h(args);
    return { isError: !!result.isError, body: JSON.parse(result.content[0].text) };
  };

  return { session, call };
};

describe("qb_company_open — switch active company file", () => {
  it("swaps companyFile path and surfaces previous + new path in the response", async () => {
    const { session, call } = setupHarness();
    await session.openSession();

    const r = await call("qb_company_open", { companyFile: "C:\\fixtures\\Acme.qbw" });
    expect(r.isError).toBe(false);
    expect(r.body.success).toBe(true);
    expect(r.body.previousCompanyFile).toBe("simulation");
    expect(r.body.companyFile).toBe("C:\\fixtures\\Acme.qbw");
    expect(r.body.simulationMode).toBe(true);
    expect(r.body.simulationStoreReset).toBe(true);
    expect(typeof r.body.ticket).toBe("string");
    expect(typeof r.body.openedAt).toBe("string");
  });

  it("resets the simulation store: entities created against company A are not visible after switching to B", async () => {
    const { session, call } = setupHarness();
    await session.openSession();

    // Add an entity to company A's store
    await session.addEntity("Customer", { Name: "Only In A" });
    const inA = await session.queryEntity("Customer", { FullName: "Only In A" });
    expect(inA).toHaveLength(1);

    // Switch to company B — store reseeds
    await call("qb_company_open", { companyFile: "C:\\fixtures\\B.qbw" });

    const inB = await session.queryEntity("Customer", { FullName: "Only In A" });
    expect(inB).toHaveLength(0);

    // B's seed is the standard fresh seed (Acme / Global / TechStart present)
    const allInB = await session.queryEntity("Customer");
    expect(allInB.some((c) => String(c.Name).toLowerCase().includes("acme"))).toBe(true);
  });

  it("switching back to A returns A's FRESH seed, not the prior session's mutations (DECISIONS.md 2026-05-09 — deliberate sim-fidelity tradeoff)", async () => {
    const { session, call } = setupHarness();
    await session.openSession();

    // Mutate company A
    await session.addEntity("Customer", { Name: "Was In A" });

    // A → B
    await call("qb_company_open", { companyFile: "C:\\fixtures\\B.qbw" });
    // B → A (same path string as the original)
    await call("qb_company_open", { companyFile: "simulation" });

    // The mutation from the first A session must NOT carry over.
    // This is the contract: switching ALWAYS reseeds in sim, even when the
    // path matches a prior session. Real QB persists per-file; sim doesn't.
    const reA = await session.queryEntity("Customer", { FullName: "Was In A" });
    expect(reA).toHaveLength(0);
  });

  it("rejects empty companyFile argument at the schema level", async () => {
    // The zod schema requires companyFile to be a non-empty string. The
    // fakeServer harness skips zod validation (handlers receive args
    // directly), so this test asserts the schema's intent by inspecting
    // it — the runtime MCP server applies the same schema before
    // dispatching to the handler.
    const handlers = new Map<string, { schema: Record<string, z.ZodTypeAny>; handler: Handler }>();
    const fakeServer = {
      tool: (name: string, _d: string, schema: Record<string, z.ZodTypeAny>, handler: Handler) => {
        handlers.set(name, { schema, handler });
      },
    };
    const session = new QBSessionManager({
      companyFile: "simulation",
      appName: "vitest-company-switching-schema",
      qbxmlVersion: "16.0",
    });
    registerReportTools(fakeServer as never, () => session);

    const cmd = handlers.get("qb_company_open");
    expect(cmd).toBeDefined();
    const validation = z.object(cmd!.schema).safeParse({ companyFile: "" });
    expect(validation.success).toBe(false);
  });
});

describe("qb_company_list — enumerate .qbw files under root", () => {
  let tmpDir: string;
  let priorRoot: string | undefined;
  let priorFile: string | undefined;

  beforeEach(async () => {
    priorRoot = process.env.QB_COMPANY_ROOT;
    priorFile = process.env.QB_COMPANY_FILE;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-company-list-"));
  });

  afterEach(async () => {
    // Restore env (delete vs. reassign — undefined-restore via assignment is wrong)
    if (priorRoot === undefined) delete process.env.QB_COMPANY_ROOT;
    else process.env.QB_COMPANY_ROOT = priorRoot;
    if (priorFile === undefined) delete process.env.QB_COMPANY_FILE;
    else process.env.QB_COMPANY_FILE = priorFile;

    // Windows occasionally returns ENOTEMPTY on the first rmdir if a child
    // file's handle hasn't fully released — retry briefly.
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("lists .qbw files in $QB_COMPANY_ROOT, sorted by modifiedAt desc", async () => {
    // Three .qbw fixtures + one non-.qbw decoy. mtime stamped in ascending
    // order so we can assert the desc sort.
    await fs.writeFile(path.join(tmpDir, "Alpha.qbw"), "fixture-a");
    await fs.writeFile(path.join(tmpDir, "Beta.qbw"), "fixture-b");
    await fs.writeFile(path.join(tmpDir, "Gamma.qbw"), "fixture-g");
    await fs.writeFile(path.join(tmpDir, "ignore.txt"), "decoy");
    // Force distinct mtimes (ms precision varies across platforms).
    const baseMs = Date.now() - 10_000;
    await fs.utimes(path.join(tmpDir, "Alpha.qbw"), new Date(baseMs), new Date(baseMs));
    await fs.utimes(path.join(tmpDir, "Beta.qbw"), new Date(baseMs + 5_000), new Date(baseMs + 5_000));
    await fs.utimes(path.join(tmpDir, "Gamma.qbw"), new Date(baseMs + 10_000), new Date(baseMs + 10_000));

    process.env.QB_COMPANY_ROOT = tmpDir;
    delete process.env.QB_COMPANY_FILE;

    const { call } = setupHarness();
    const r = await call("qb_company_list");
    expect(r.isError).toBe(false);
    expect(r.body.root).toBe(tmpDir);
    expect(r.body.count).toBe(3);

    const names = r.body.companies.map((c: { displayName: string }) => c.displayName);
    expect(names).toEqual(["Gamma", "Beta", "Alpha"]); // desc by mtime

    for (const c of r.body.companies as Array<Record<string, unknown>>) {
      expect(typeof c.companyFile).toBe("string");
      expect(typeof c.sizeBytes).toBe("number");
      expect(typeof c.modifiedAt).toBe("string");
      expect(String(c.companyFile)).toMatch(/\.qbw$/);
    }
  });

  it("falls back to dirname($QB_COMPANY_FILE) when QB_COMPANY_ROOT is unset", async () => {
    await fs.writeFile(path.join(tmpDir, "OnlyOne.qbw"), "x");
    delete process.env.QB_COMPANY_ROOT;
    process.env.QB_COMPANY_FILE = path.join(tmpDir, "OnlyOne.qbw");

    const { call } = setupHarness();
    const r = await call("qb_company_list");
    expect(r.isError).toBe(false);
    expect(r.body.root).toBe(tmpDir);
    expect(r.body.count).toBe(1);
    expect(r.body.companies[0].displayName).toBe("OnlyOne");
  });

  it("explicit `root` arg wins over both env vars", async () => {
    await fs.writeFile(path.join(tmpDir, "Override.qbw"), "x");

    // Set both env vars to bogus values to confirm the override is honored.
    process.env.QB_COMPANY_ROOT = "C:\\not-a-real-path";
    process.env.QB_COMPANY_FILE = "C:\\not-a-real-path\\nope.qbw";

    const { call } = setupHarness();
    const r = await call("qb_company_list", { root: tmpDir });
    expect(r.isError).toBe(false);
    expect(r.body.root).toBe(tmpDir);
    expect(r.body.count).toBe(1);
  });

  it("returns an error when neither env var nor `root` arg supplies a search root", async () => {
    delete process.env.QB_COMPANY_ROOT;
    delete process.env.QB_COMPANY_FILE;

    const { call } = setupHarness();
    const r = await call("qb_company_list");
    expect(r.isError).toBe(true);
    expect(r.body.success).toBe(false);
    expect(String(r.body.statusMessage)).toMatch(/QB_COMPANY_ROOT|QB_COMPANY_FILE|root/i);
  });

  it("returns a structured error when the resolved root does not exist", async () => {
    const { call } = setupHarness();
    const r = await call("qb_company_list", { root: path.join(tmpDir, "does-not-exist") });
    expect(r.isError).toBe(true);
    expect(r.body.success).toBe(false);
    expect(String(r.body.statusMessage)).toMatch(/Failed to enumerate/);
  });

  it("returns count: 0 when the root contains no .qbw files", async () => {
    await fs.writeFile(path.join(tmpDir, "readme.txt"), "no qbw here");
    const { call } = setupHarness();
    const r = await call("qb_company_list", { root: tmpDir });
    expect(r.isError).toBe(false);
    expect(r.body.count).toBe(0);
    expect(r.body.companies).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 19 #90 — launchIfClosed
// ---------------------------------------------------------------------------
//
// The auto-launch path can only be exercised end-to-end on a real Windows +
// QB Desktop box (the spawn + QBXMLRP2 attach is not mockable in CI). What
// IS testable in sim:
//   - Sim mode treats `launchIfClosed: true` as a no-op (the reseed path
//     already covers the "open a new book" UX).
//   - The tool surface accepts launchIfClosed in its zod schema.
//
// What's testable via dependency injection (forced-live-mode stubs):
//   - Error classification routing: file-conflict on initial openSession
//     throws QBLaunchError 9007 WITHOUT attempting launch; multi-user-lock
//     throws QBMultiUserLockError 9008.
//   - No-executable surfaces 9007 with reason 'no-executable'.
//   - Spawn-failure surfaces 9007 with reason 'launch-spawn-failed'.
//   - Successful launch + first-attempt-attach populates lastSwitchLaunchInfo
//     with the right source / exe / poll count.
//   - Launch-timeout: all retries exhaust → 9007 with reason 'launch-timeout'.
//   - File-conflict surfaced DURING polling exits the loop early.

/**
 * Build a forced-live-mode session manager with every external dependency
 * stubbed: openSession is queue-driven, sleepImpl is instant, spawnImpl is
 * a recording no-op, exeResolverImpl returns a fixed result. closeSession
 * is stubbed to no-op (the production version touches winax which we don't
 * want to import in tests).
 *
 * Returns the manager plus accessors for the stub state (spawnCalls,
 * openCalls) so tests can assert on what happened.
 */
const makeFakeLiveManager = (opts: {
  openErrors?: Array<Error | null>; // null at index N means "succeed on attempt N"
  exeResolution?: { exe: string; source: "env" | "registry" | "fallback" } | null;
  spawnThrows?: Error;
}) => {
  const mgr = new QBSessionManager({
    companyFile: "C:\\initial.qbw",
    appName: "vitest-launch",
    qbxmlVersion: "16.0",
  });
  // Force live mode regardless of the resolved platform/env.
  (mgr as unknown as { simulationMode: boolean }).simulationMode = false;
  // Instant sleep so the 30s poll budget collapses to a single tick.
  (mgr as unknown as { sleepImpl: (ms: number) => Promise<void> }).sleepImpl = async () => {};

  const spawnCalls: Array<{ exe: string; companyFile: string }> = [];
  (mgr as unknown as { spawnImpl: (exe: string, companyFile: string) => void }).spawnImpl =
    (exe, companyFile) => {
      spawnCalls.push({ exe, companyFile });
      if (opts.spawnThrows) throw opts.spawnThrows;
    };

  const exeResolution = opts.exeResolution === undefined
    ? { exe: "C:\\fake\\qbw32.exe", source: "registry" as const }
    : opts.exeResolution;
  (mgr as unknown as { exeResolverImpl: () => unknown }).exeResolverImpl = () => exeResolution;

  // closeSession bypasses winax — sim store reset is unnecessary here.
  let openCalls = 0;
  const openErrors = opts.openErrors ?? [];
  (mgr as unknown as { closeSession: () => Promise<void> }).closeSession = async () => {
    (mgr as unknown as { session: unknown }).session = null;
  };
  (mgr as unknown as { openSession: () => Promise<unknown> }).openSession = async () => {
    const idx = openCalls++;
    const err = openErrors[idx];
    if (err) throw err;
    const fakeSession = {
      ticket: `live-ticket-${idx}`,
      companyFile: (mgr as unknown as { config: { companyFile: string } }).config.companyFile,
      openedAt: new Date(),
    };
    (mgr as unknown as { session: unknown }).session = fakeSession;
    return fakeSession;
  };

  return {
    mgr,
    spawnCalls,
    getOpenCalls: () => openCalls,
  };
};

describe("switchCompanyFile launchIfClosed — sim mode is a no-op", () => {
  it("sim mode ignores launchIfClosed: true and still reseeds the store", async () => {
    const { session, call } = setupHarness();
    await session.openSession();

    await session.addEntity("Customer", { Name: "Should Be Gone" });
    const r = await call("qb_company_open", {
      companyFile: "C:\\fixtures\\B.qbw",
      launchIfClosed: true,
    });
    expect(r.isError).toBe(false);
    expect(r.body.success).toBe(true);
    expect(r.body.simulationMode).toBe(true);
    expect(r.body.simulationStoreReset).toBe(true);
    // No launch metadata in sim mode — the flag was a no-op.
    expect(r.body.launched).toBeUndefined();
    expect(r.body.launchSource).toBeUndefined();

    // Sim store actually reseeded.
    const stale = await session.queryEntity("Customer", { FullName: "Should Be Gone" });
    expect(stale).toHaveLength(0);
  });

  it("zod schema accepts launchIfClosed:true and launchIfClosed:false", async () => {
    const handlers = new Map<string, { schema: Record<string, z.ZodTypeAny>; handler: Handler }>();
    const fakeServer = {
      tool: (name: string, _d: string, schema: Record<string, z.ZodTypeAny>, handler: Handler) => {
        handlers.set(name, { schema, handler });
      },
    };
    const mgr = new QBSessionManager({
      companyFile: "simulation",
      appName: "vitest-schema",
      qbxmlVersion: "16.0",
    });
    registerReportTools(fakeServer as never, () => mgr);

    const cmd = handlers.get("qb_company_open");
    expect(cmd).toBeDefined();
    const schema = z.object(cmd!.schema);
    expect(schema.safeParse({ companyFile: "C:\\X.qbw", launchIfClosed: true }).success).toBe(true);
    expect(schema.safeParse({ companyFile: "C:\\X.qbw", launchIfClosed: false }).success).toBe(true);
    expect(schema.safeParse({ companyFile: "C:\\X.qbw" }).success).toBe(true);
  });
});

describe("switchCompanyFile launchIfClosed — live-mode error routing", () => {
  it("file-conflict error on initial openSession → QBLaunchError 9007 WITHOUT calling spawn", async () => {
    const { mgr, spawnCalls } = makeFakeLiveManager({
      openErrors: [new Error("QuickBooks is already open with a different company file")],
    });

    await expect(
      mgr.switchCompanyFile("C:\\new.qbw", { launchIfClosed: true }),
    ).rejects.toMatchObject({
      name: "QBLaunchError",
      statusCode: 9007,
      reason: "file-conflict",
    });
    // Critical: spawn must NOT have been attempted. Launching another QB
    // process when one is already running with a different file would
    // worsen the conflict, not resolve it.
    expect(spawnCalls).toHaveLength(0);
  });

  it("multi-user-lock error on initial openSession → QBMultiUserLockError 9008 WITHOUT calling spawn", async () => {
    const { mgr, spawnCalls } = makeFakeLiveManager({
      openErrors: [new Error("The company file is in use by another user")],
    });

    await expect(
      mgr.switchCompanyFile("\\\\server\\share\\Locked.qbw", { launchIfClosed: true }),
    ).rejects.toMatchObject({
      name: "QBMultiUserLockError",
      statusCode: 9008,
    });
    expect(spawnCalls).toHaveLength(0);
  });

  it("unrecognized error WITH launchIfClosed:false → bubbles unchanged (no launch attempted)", async () => {
    const { mgr, spawnCalls } = makeFakeLiveManager({
      openErrors: [new Error("3120: required field missing")],
    });

    await expect(
      mgr.switchCompanyFile("C:\\new.qbw", { launchIfClosed: false }),
    ).rejects.toThrow(/3120/);
    expect(spawnCalls).toHaveLength(0);
  });

  it("no executable found → QBLaunchError 9007 reason='no-executable'", async () => {
    const { mgr, spawnCalls } = makeFakeLiveManager({
      openErrors: [new Error("QuickBooks is not running")],
      exeResolution: null,
    });

    await expect(
      mgr.switchCompanyFile("C:\\new.qbw", { launchIfClosed: true }),
    ).rejects.toMatchObject({
      name: "QBLaunchError",
      statusCode: 9007,
      reason: "no-executable",
    });
    expect(spawnCalls).toHaveLength(0);
  });

  it("spawn itself throws → QBLaunchError 9007 reason='launch-spawn-failed'", async () => {
    const { mgr } = makeFakeLiveManager({
      openErrors: [new Error("QuickBooks is not running")],
      spawnThrows: new Error("EACCES: permission denied"),
    });

    await expect(
      mgr.switchCompanyFile("C:\\new.qbw", { launchIfClosed: true }),
    ).rejects.toMatchObject({
      name: "QBLaunchError",
      statusCode: 9007,
      reason: "launch-spawn-failed",
    });
  });

  it("launch succeeds + first poll attaches → returns session and populates launch metadata", async () => {
    const { mgr, spawnCalls } = makeFakeLiveManager({
      // index 0 = initial fail (no file open), index 1 = first poll succeeds
      openErrors: [new Error("no company file is open"), null],
    });

    const session = await mgr.switchCompanyFile("C:\\new.qbw", { launchIfClosed: true });
    expect(session.companyFile).toBe("C:\\new.qbw");
    expect(spawnCalls).toEqual([{ exe: "C:\\fake\\qbw32.exe", companyFile: "C:\\new.qbw" }]);

    const info = mgr.getLastSwitchLaunchInfo();
    expect(info).toEqual({
      launched: true,
      launchSource: "registry",
      launchExe: "C:\\fake\\qbw32.exe",
      launchPollAttempts: 1,
    });
  });

  it("launch + poll succeeds on the 3rd retry → launchPollAttempts is 3", async () => {
    const errMsg = "QuickBooks is not running";
    const { mgr } = makeFakeLiveManager({
      // Initial fail + 2 poll failures + success
      openErrors: [
        new Error(errMsg),
        new Error(errMsg),
        new Error(errMsg),
        null,
      ],
    });

    const session = await mgr.switchCompanyFile("C:\\new.qbw", { launchIfClosed: true });
    expect(session.companyFile).toBe("C:\\new.qbw");
    expect(mgr.getLastSwitchLaunchInfo().launchPollAttempts).toBe(3);
  });

  it("launch + all retries exhausted → QBLaunchError 9007 reason='launch-timeout'", async () => {
    const errMsg = "QuickBooks is not running";
    // Initial + 5 polls all fail (poll length is 5).
    const failures = Array(1 + QB_LAUNCH_POLL_MS.length).fill(new Error(errMsg));
    const { mgr } = makeFakeLiveManager({ openErrors: failures });

    await expect(
      mgr.switchCompanyFile("C:\\new.qbw", { launchIfClosed: true }),
    ).rejects.toMatchObject({
      name: "QBLaunchError",
      statusCode: 9007,
      reason: "launch-timeout",
    });
  });

  it("file-conflict surfacing DURING poll exits early (does not exhaust budget)", async () => {
    // Initial = no-file, but mid-poll QB Desktop finishes opening with a
    // different file (a corner case where the spawn arg didn't survive
    // QB's "restore last session" preference). Must exit on the first
    // file-conflict signal, not keep polling.
    const errs: Array<Error | null> = [
      new Error("no company file is open"),
      new Error("QuickBooks is open with a different company file"),
    ];
    const { mgr } = makeFakeLiveManager({ openErrors: errs });

    let getOpenCallsRef = 0;
    Object.defineProperty(mgr, "_test_open_marker", {
      get() { return getOpenCallsRef++; },
    });

    await expect(
      mgr.switchCompanyFile("C:\\new.qbw", { launchIfClosed: true }),
    ).rejects.toMatchObject({
      name: "QBLaunchError",
      reason: "file-conflict",
    });
  });

  it("default launchIfClosed:false on a file-not-loaded error → bubbles unchanged (no launch)", async () => {
    const { mgr, spawnCalls } = makeFakeLiveManager({
      openErrors: [new Error("no company file is open")],
    });

    await expect(
      mgr.switchCompanyFile("C:\\new.qbw"),
    ).rejects.toThrow(/no company file is open/);
    expect(spawnCalls).toHaveLength(0);
  });

  it("getLastSwitchLaunchInfo resets on every switchCompanyFile call", async () => {
    const { mgr } = makeFakeLiveManager({
      openErrors: [new Error("no company file is open"), null, null],
    });

    // First call: launch succeeds on first poll.
    await mgr.switchCompanyFile("C:\\A.qbw", { launchIfClosed: true });
    expect(mgr.getLastSwitchLaunchInfo().launched).toBe(true);

    // Second call (now that the file is "loaded"): initial open succeeds,
    // no launch. Metadata must reset.
    await mgr.switchCompanyFile("C:\\B.qbw", { launchIfClosed: true });
    expect(mgr.getLastSwitchLaunchInfo()).toEqual({ launched: false });
  });
});

// QBLaunchError + QBMultiUserLockError are real Error subclasses surfaced
// through the same statusCode contract the rest of the manager uses.
describe("QBLaunchError + QBMultiUserLockError — error class contract", () => {
  it("QBLaunchError is an Error with statusCode 9007 and reason field", () => {
    const e = new QBLaunchError("file-conflict", "msg", "underlying");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("QBLaunchError");
    expect(e.statusCode).toBe(9007);
    expect(e.reason).toBe("file-conflict");
    expect(e.underlyingMessage).toBe("underlying");
  });

  it("QBMultiUserLockError is an Error with statusCode 9008", () => {
    const e = new QBMultiUserLockError("locked", "underlying");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("QBMultiUserLockError");
    expect(e.statusCode).toBe(9008);
    expect(e.underlyingMessage).toBe("underlying");
  });
});

describe("qb_company_open + qb_company_list — round-trip discovery → switch", () => {
  let tmpDir: string;
  let priorRoot: string | undefined;
  let priorFile: string | undefined;

  beforeEach(async () => {
    priorRoot = process.env.QB_COMPANY_ROOT;
    priorFile = process.env.QB_COMPANY_FILE;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-roundtrip-"));
  });

  afterEach(async () => {
    if (priorRoot === undefined) delete process.env.QB_COMPANY_ROOT;
    else process.env.QB_COMPANY_ROOT = priorRoot;
    if (priorFile === undefined) delete process.env.QB_COMPANY_FILE;
    else process.env.QB_COMPANY_FILE = priorFile;
    // Windows occasionally returns ENOTEMPTY on the first rmdir if a child
    // file's handle hasn't fully released — retry briefly.
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("paths from qb_company_list are valid input to qb_company_open (sim mode)", async () => {
    await fs.writeFile(path.join(tmpDir, "ClientOne.qbw"), "x");
    process.env.QB_COMPANY_ROOT = tmpDir;
    delete process.env.QB_COMPANY_FILE;

    const { session, call } = setupHarness();
    await session.openSession();

    const list = await call("qb_company_list");
    expect(list.body.count).toBe(1);
    const target = list.body.companies[0].companyFile as string;

    const open = await call("qb_company_open", { companyFile: target });
    expect(open.isError).toBe(false);
    expect(open.body.companyFile).toBe(target);
    expect(open.body.simulationStoreReset).toBe(true);
  });
});
