// QuickBooks COM isolation + idle release (2026-10-05).
//
// Live finding: after QuickBooks was ended in Task Manager, a COM call
// segfaulted the whole MCP server (exit 139). QBXMLRP2 now runs in a child
// process (src/session/com-worker.ts). These tests fork a fake helper
// (tests/fixtures/fake-com-worker.mjs) that crashes or hangs on cue, and
// check that the server survives, recovers, and times out frozen calls.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkerRequestProcessor } from "../src/session/com-worker-client.js";
import { isQuickBooksGoneError, QBSessionManager } from "../src/session/manager.js";
import { clearActivity, getActivity } from "../src/util/activity-log.js";
import { interpretHealth } from "../src/util/qb-health.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-com-worker.mjs");
const fake = (timeouts = {}) => new WorkerRequestProcessor({ scriptPath: FAKE, timeouts });

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), "fake-com-"));
  process.env.FAKE_COM_STATE_DIR = stateDir;
  clearActivity();
});
afterEach(() => {
  delete process.env.FAKE_COM_STATE_DIR;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("WorkerRequestProcessor (out-of-process COM)", () => {
  it("round-trips open / begin / process / end / close through the helper process", async () => {
    const rp = fake();
    await rp.OpenConnection2("", "app", 1);
    const ticket = String(await rp.BeginSession("C:\\A.qbw", 2));
    expect(ticket).toMatch(/^FAKE-TICKET-\d+$/);
    expect(String(await rp.ProcessRequest(ticket, "<CustomerQueryRq/>"))).toContain("CustomerRet");
    await rp.EndSession(ticket);
    await rp.CloseConnection();
    rp.dispose();
  }, 30_000);

  it("a helper crash (native access violation) rejects the call instead of killing this process", async () => {
    const rp = fake();
    await rp.OpenConnection2("", "app", 1);
    const t = String(await rp.BeginSession("C:\\A.qbw", 2));
    const err = await rp.ProcessRequest(t, "<CRASH/>").then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/COM helper exited \(code 3221225477/);
    expect(isQuickBooksGoneError(err)).toBe(true);
    // Later calls fail fast with the same explanation.
    await expect(rp.ProcessRequest(t, "<CustomerQueryRq/>")).rejects.toThrow(/COM helper exited/);
  }, 30_000);

  it("a frozen QuickBooks call times out, stops the helper, and reads as 'QuickBooks went away'", async () => {
    const rp = fake({ processMs: 400 });
    await rp.OpenConnection2("", "app", 1);
    const t = String(await rp.BeginSession("C:\\A.qbw", 2));
    const started = Date.now();
    const err = await rp.ProcessRequest(t, "<HANG/>").then(() => null, (e: Error) => e);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(err?.message).toMatch(/did not answer within 0s|did not answer within 1s/);
    expect(isQuickBooksGoneError(err)).toBe(true);
  }, 30_000);
});

function liveManager(opts: { qbRunning?: boolean } = {}) {
  const mgr = new QBSessionManager({ companyFile: "C:\\Books\\Acme.qbw", appName: "vitest-com", qbxmlVersion: "16.0" });
  const m = mgr as unknown as Record<string, unknown>;
  m.simulationMode = false;
  m.sleepImpl = async () => {};
  let factoryCalls = 0;
  m.rpFactory = () => { factoryCalls++; return fake(); };
  m.healthImpl = async () => interpretHealth({ ok: true, fileDoctor: [], crashReporter: [], quickbooks: [] });
  m.isQBRunningImpl = () => opts.qbRunning ?? true;
  m.hasSavedLoginImpl = () => false;
  m.fileExistsImpl = () => true;
  return { mgr, factoryCalls: () => factoryCalls };
}

describe("session manager over the COM helper", () => {
  it("QuickBooks dies mid-read: the helper crashes, the server survives, reconnects with a NEW helper, and the read succeeds", async () => {
    const { mgr, factoryCalls } = liveManager();
    await mgr.openSession();
    const res = await mgr.sendRequest("<CRASH_ONCE/>");
    expect(JSON.stringify(res)).toContain("Acme");
    expect(factoryCalls()).toBe(2);
    expect(mgr.getDiagnostics()).toMatchObject({ connected: true, recoveryCount: 1 });
    expect(getActivity().some((e) => /Reconnected to Acme\.qbw/.test(e.message))).toBe(true);
    await mgr.closeSession();
  }, 60_000);

  it("closeSession ends the session and stops the helper", async () => {
    const { mgr } = liveManager();
    await mgr.openSession();
    const rp = (mgr as unknown as { rp: WorkerRequestProcessor }).rp;
    const pid = rp.pid;
    expect(pid).toBeGreaterThan(0);
    await mgr.closeSession();
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid!, 0)).toThrow();
  }, 30_000);
});

describe("idle release", () => {
  it("after the idle period the server lets go of QuickBooks; the next request reconnects", async () => {
    const { mgr, factoryCalls } = liveManager();
    await mgr.sendRequest("<CustomerQueryRq/>");
    expect(mgr.getDiagnostics().connected).toBe(true);
    expect(await mgr.releaseIfIdle()).toBe(true);
    expect(mgr.getDiagnostics()).toMatchObject({ connected: false, lastIdleReleaseAt: expect.any(String) });
    expect(getActivity()[1].message).toMatch(/Let go of QuickBooks after 10 idle minutes/);
    await mgr.sendRequest("<CustomerQueryRq/>");
    expect(mgr.getDiagnostics().connected).toBe(true);
    expect(factoryCalls()).toBe(2);
    await mgr.closeSession();
  }, 60_000);

  it("never releases while a request is running", async () => {
    const { mgr } = liveManager();
    await mgr.openSession();
    (mgr as unknown as { inFlight: number }).inFlight = 1;
    expect(await mgr.releaseIfIdle()).toBe(false);
    expect(mgr.getDiagnostics().connected).toBe(true);
    (mgr as unknown as { inFlight: number }).inFlight = 0;
    await mgr.closeSession();
  }, 30_000);
});
