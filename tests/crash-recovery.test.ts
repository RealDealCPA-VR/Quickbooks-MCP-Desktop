// Crash recovery + QuickBooks health (2026-10-05). QuickBooks Desktop on
// the operator's machine sometimes crashes, freezes, stops on a dialog or
// hands off to File Doctor. Reads must reconnect and retry by themselves.
// Writes must never be repeated blindly, recovery must not reopen a file
// mid-repair, and QB is force-closed only when hung AND explicitly allowed.

import { beforeEach, describe, expect, it } from "vitest";

import {
  isQuickBooksBlockedError,
  isQuickBooksGoneError,
  isWriteRequest,
  QBSessionManager,
} from "../src/session/manager.js";
import { clearActivity, getActivity } from "../src/util/activity-log.js";
import { interpretHealth, type QBHealth, type RawHealth } from "../src/util/qb-health.js";

const OK_XML =
  '<?xml version="1.0"?><QBXML><QBXMLMsgsRs><CustomerQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="Status OK">' +
  "<CustomerRet><ListID>80000001-1</ListID><Name>Acme</Name></CustomerRet></CustomerQueryRs></QBXMLMsgsRs></QBXML>";
const ADD_OK_XML =
  '<?xml version="1.0"?><QBXML><QBXMLMsgsRs><CustomerAddRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="Status OK">' +
  "<CustomerRet><ListID>80000002-1</ListID><Name>New</Name></CustomerRet></CustomerAddRs></QBXMLMsgsRs></QBXML>";
const CRASH = () => new Error("OLE error 0x800706ba: The RPC server is unavailable.");
const MODAL = () => new Error("A modal dialog box is showing in the QuickBooks user interface.");

const raw = (over: Partial<RawHealth> = {}): RawHealth => ({ ok: true, quickbooks: [], fileDoctor: [], crashReporter: [], ...over });
const qbProc = (over: Partial<RawHealth["quickbooks"][0]> = {}) => ({
  pid: 100, responding: true, startedAt: null, mainTitle: "Acme LLC  - Intuit QuickBooks Enterprise Solutions: Accountant 24.0",
  windows: [{ title: "Acme LLC  - Intuit QuickBooks Enterprise Solutions: Accountant 24.0", className: "MauiFrame", isMain: true }],
  ...over,
});

/**
 * Live-mode manager with a scripted QBXMLRP2. `wire` is consumed one entry
 * per ProcessRequest call: a string is the response XML, an Error is thrown.
 * `healths` is consumed one per health check (last one repeats).
 */
function makeManager(opts: { wire: Array<string | Error>; healths?: QBHealth[]; qbRunning?: boolean; savedLogin?: boolean; forceCloseOk?: boolean }) {
  const mgr = new QBSessionManager({ companyFile: "C:\\Books\\Acme.qbw", appName: "vitest-recovery", qbxmlVersion: "16.0" });
  const m = mgr as unknown as Record<string, unknown>;
  m.simulationMode = false;
  m.sleepImpl = async () => {};
  const calls = { process: 0, open: 0, health: 0, forceClose: 0, spawn: 0, endSession: 0 };
  const rp = {
    ProcessRequest: () => {
      const next = opts.wire[calls.process++];
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error("test wire exhausted");
      return next;
    },
    EndSession: () => { calls.endSession++; },
    CloseConnection: () => {},
  };
  m.openSession = async () => {
    calls.open++;
    m.rp = rp;
    m.session = { ticket: `T${calls.open}`, companyFile: (m.config as { companyFile: string }).companyFile, openedAt: new Date() };
    return m.session;
  };
  const healths = opts.healths ?? [interpretHealth(raw({ quickbooks: [qbProc()] }))];
  m.healthImpl = async () => healths[Math.min(calls.health++, healths.length - 1)];
  m.forceCloseImpl = async () => { calls.forceClose++; return opts.forceCloseOk ?? true; };
  m.isQBRunningImpl = () => opts.qbRunning ?? true;
  m.hasSavedLoginImpl = () => !!opts.savedLogin;
  m.fileExistsImpl = () => true;
  m.spawnImpl = () => { calls.spawn++; };
  m.exeResolverImpl = () => ({ exe: "C:\\fake\\qbw.exe", source: "registry" });
  m.loginAutofillImpl = () => null;
  m.closeQBImpl = async () => ({ closed: true, outcome: "closed" });
  return { mgr, calls };
}

beforeEach(() => clearActivity());

describe("error classification", () => {
  it("QB-gone errors (crash / COM server lost) vs the brief transient stall vs QBXML errors", () => {
    expect(isQuickBooksGoneError(CRASH())).toBe(true);
    expect(isQuickBooksGoneError(new Error("The remote procedure call failed. 0x800706BE"))).toBe(true);
    expect(isQuickBooksGoneError(new Error("The object invoked has disconnected from its clients."))).toBe(true);
    expect(isQuickBooksGoneError(new Error("Could not start QuickBooks."))).toBe(true);
    expect(isQuickBooksGoneError(new Error("QBXML 3120: object not found"))).toBe(false);
    expect(isQuickBooksBlockedError(MODAL())).toBe(true);
  });
  it("write detection: Add/Mod/Del/Void and the generic delete requests", () => {
    expect(isWriteRequest("<CustomerQueryRq requestID=\"1\">")).toBe(false);
    expect(isWriteRequest("<GeneralSummaryReportQueryRq>")).toBe(false);
    expect(isWriteRequest("<InvoiceAddRq requestID=\"1\">")).toBe(true);
    expect(isWriteRequest("<BillModRq>")).toBe(true);
    expect(isWriteRequest("<TxnDelRq>")).toBe(true);
    expect(isWriteRequest("<ClearedStatusModRq>")).toBe(true);
  });
});

describe("interpretHealth", () => {
  it("maps raw facts to one state with a plain summary and next step", () => {
    expect(interpretHealth(raw()).state).toBe("not-running");
    const ready = interpretHealth(raw({ quickbooks: [qbProc()] }));
    expect(ready).toMatchObject({ state: "ready", openCompanyTitle: "Acme LLC", dialogs: [] });
    const login = interpretHealth(raw({ quickbooks: [qbProc({ windows: [{ title: "QuickBooks Desktop Login", className: "MauiForm", isMain: false }] })] }));
    expect(login.state).toBe("login");
    const dialog = interpretHealth(raw({ quickbooks: [qbProc({ windows: [...qbProc().windows, { title: "QuickBooks Error", className: "#32770", isMain: false }, { title: "", className: "Afx:00007FF", isMain: false }] })] }));
    expect(dialog).toMatchObject({ state: "dialog", dialogs: ["QuickBooks Error"] });
    expect(interpretHealth(raw({ quickbooks: [qbProc({ responding: false })] })).state).toBe("not-responding");
    expect(interpretHealth(raw({ quickbooks: [qbProc()], fileDoctor: [{ pid: 9, name: "qbfd", title: "QuickBooks File Doctor" }] })).state).toBe("file-doctor");
    expect(interpretHealth(raw({ crashReporter: [{ pid: 7, title: "QuickBooks has stopped working" }] })).state).toBe("crashed");
    expect(interpretHealth(raw({ quickbooks: [qbProc({ windows: [] })] })).state).toBe("starting");
    expect(interpretHealth({ ok: false, error: "x", quickbooks: [], fileDoctor: [], crashReporter: [] }).state).toBe("unsupported");
  });
});

describe("automatic recovery on the request path", () => {
  it("a READ that hits a crash reconnects to the same file and is retried once (succeeds)", async () => {
    const { mgr, calls } = makeManager({ wire: [CRASH(), OK_XML] });
    const rows = await mgr.queryEntity("Customer", {});
    expect(rows).toHaveLength(1);
    expect(calls.process).toBe(2);
    expect(calls.open).toBe(2); // initial + after recovery
    expect(mgr.getCompanyFile()).toBe("C:\\Books\\Acme.qbw");
    expect(mgr.getDiagnostics()).toMatchObject({ connected: true, recoveryCount: 1, lastRecovery: { ok: true } });
    expect(getActivity().map((e) => e.message).join(" | ")).toMatch(/stopped answering during a read.*\|.*Reconnecting to Acme\.qbw|Reconnected to Acme\.qbw/);
  });

  it("a WRITE that hits a crash reconnects but is NOT retried → 9011", async () => {
    const { mgr, calls } = makeManager({ wire: [CRASH(), ADD_OK_XML] });
    await expect(mgr.addEntity("Customer", { Name: "New" })).rejects.toMatchObject({ name: "QBRecoveredAfterWriteError", statusCode: 9011 });
    expect(calls.process).toBe(1);
    expect(mgr.getDiagnostics().connected).toBe(true);
  });

  it("a modal QuickBooks dialog → 9010 'dialog' naming what's on screen (no recovery attempt)", async () => {
    const dlg = interpretHealth(raw({ quickbooks: [qbProc({ windows: [...qbProc().windows, { title: "Problem: unexpected error", className: "#32770", isMain: false }] })] }));
    const { mgr, calls } = makeManager({ wire: [MODAL()], healths: [dlg] });
    await expect(mgr.queryEntity("Customer", {})).rejects.toMatchObject({ statusCode: 9010, reason: "dialog", message: expect.stringContaining("Problem: unexpected error") });
    expect(calls.open).toBe(1);
  });

  it("the real post-crash error ('The ticket parameter is invalid.', observed live) triggers recovery", async () => {
    const { mgr, calls } = makeManager({ wire: [new Error("The ticket parameter is invalid."), OK_XML] });
    expect(await mgr.queryEntity("Customer", {})).toHaveLength(1);
    expect(calls.open).toBe(2);
    expect(mgr.getDiagnostics().recoveryCount).toBe(1);
  });

  it("unknown error wording + health says QuickBooks is gone → recovers anyway (safety net)", async () => {
    const gone = interpretHealth(raw());
    const ok = interpretHealth(raw({ quickbooks: [qbProc()] }));
    const { mgr, calls } = makeManager({ wire: [new Error("Some new COM wording nobody has seen"), OK_XML], healths: [gone, ok], qbRunning: false });
    expect(await mgr.queryEntity("Customer", {})).toHaveLength(1);
    expect(calls.open).toBe(2);
  });

  it("QBXML-level errors are untouched (no recovery)", async () => {
    const { mgr, calls } = makeManager({ wire: [new Error("QBXML 3120: object not found")] });
    await expect(mgr.queryEntity("Customer", {})).rejects.toThrow(/3120/);
    expect(calls.open).toBe(1);
    expect(mgr.getDiagnostics().recoveryCount).toBe(0);
  });

  it("QB_AUTO_RECOVER=0 behavior: crash error propagates unchanged", async () => {
    const { mgr } = makeManager({ wire: [CRASH()] });
    (mgr as unknown as { autoRecover: boolean }).autoRecover = false;
    await expect(mgr.queryEntity("Customer", {})).rejects.toThrow(/RPC server is unavailable/);
  });

  it("no session + QB not running + saved login → starts QB on the file (no unattended SDK open)", async () => {
    const { mgr, calls } = makeManager({ wire: [OK_XML], qbRunning: false, savedLogin: true });
    await mgr.queryEntity("Customer", {});
    expect(calls.spawn).toBe(1);
  });
});

describe("recover()", () => {
  it("refuses while File Doctor is running (never reopen a file mid-repair) → 9010 file-doctor", async () => {
    const fd = interpretHealth(raw({ fileDoctor: [{ pid: 5, name: "qbfd", title: "QuickBooks File Doctor" }] }));
    const { mgr, calls } = makeManager({ wire: [], healths: [fd] });
    await expect(mgr.recover()).rejects.toMatchObject({ statusCode: 9010, reason: "file-doctor" });
    expect(calls.open).toBe(0);
    expect(calls.spawn).toBe(0);
  });

  it("QB frozen and still frozen 10s later, no permission → 9010 not-responding; never force-closes", async () => {
    const hung = interpretHealth(raw({ quickbooks: [qbProc({ responding: false })] }));
    const { mgr, calls } = makeManager({ wire: [], healths: [hung, hung] });
    await expect(mgr.recover()).rejects.toMatchObject({ statusCode: 9010, reason: "not-responding" });
    expect(calls.forceClose).toBe(0);
  });

  it("QB frozen, then recovers on the 10s recheck → just reconnects", async () => {
    const hung = interpretHealth(raw({ quickbooks: [qbProc({ responding: false })] }));
    const ok = interpretHealth(raw({ quickbooks: [qbProc()] }));
    const { mgr, calls } = makeManager({ wire: [], healths: [hung, ok] });
    await mgr.recover();
    expect(calls.forceClose).toBe(0);
    expect(mgr.getDiagnostics().connected).toBe(true);
  });

  it("QB frozen + forceCloseHungQuickBooks → force-closes, then starts QB on the same file", async () => {
    const hung = interpretHealth(raw({ quickbooks: [qbProc({ responding: false })] }));
    const { mgr, calls } = makeManager({ wire: [], healths: [hung, hung], qbRunning: false, savedLogin: true });
    await mgr.recover({ forceCloseHungQuickBooks: true });
    expect(calls.forceClose).toBe(1);
    expect(calls.spawn).toBe(1);
    expect(mgr.getCompanyFile()).toBe("C:\\Books\\Acme.qbw");
  });

  it("keeps the idempotency cache (a write in flight during the crash must replay, not duplicate)", async () => {
    const { mgr } = makeManager({ wire: [ADD_OK_XML] });
    await mgr.addEntityIdempotent("Customer", { Name: "New" }, "key-1");
    await mgr.recover();
    // Same key + same payload replays from cache: no wire call needed (wire is exhausted).
    const again = await mgr.addEntityIdempotent("Customer", { Name: "New" }, "key-1");
    expect(again.replayed).toBe(true);
  });

  it("a switch and a recovery never overlap; a request waits for a running recovery", async () => {
    const { mgr, calls } = makeManager({ wire: [OK_XML] });
    const order: string[] = [];
    const rec = mgr.recover().then(() => order.push("recovered"));
    const read = mgr.queryEntity("Customer", {}).then(() => order.push("read"));
    await Promise.all([rec, read]);
    expect(order).toEqual(["recovered", "read"]);
    expect(calls.open).toBe(1);
  });
});
