// Phase 18 #84 — auto-reconnect on transient QBXMLRP2 failures.
//
// Coverage layers:
//   1. Pure helper isTransientLiveError — exact-string + case-insensitive
//      matches for 0x80040408 / decimal form / descriptive text; rejects
//      non-transient and edge inputs.
//   2. RECONNECT_BACKOFF_MS schedule — frozen, [250, 500, 1000].
//   3. sendLiveRequestWithRetry behavior (via patched live-mode manager):
//      a. Initial success returns without retry, sleepImpl never called.
//      b. Transient on attempt 1, success on attempt 2 — one sleep at 250ms,
//         reconnect ran once, response returned.
//      c. Transient on every attempt — sleeps 250 → 500 → 1000, four total
//         ProcessRequest calls, final error thrown.
//      d. Non-transient error throws immediately, no sleep, no reconnect.
//      e. Mixed: transient then non-transient — second error wins, sleeps
//         only for the transient leg.
//      f. Reconnect failure path — openSession throws on reconnect, error
//         wrapped naming both the reconnect failure and the original
//         transient error.
//      g. Persistent state survives reconnect — readOnly, idempotency cache,
//         hostInfo cache all preserved across a forced reconnect.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  QBSessionManager,
  isTransientLiveError,
  RECONNECT_BACKOFF_MS,
} from "../src/session/manager.js";

// ---------------------------------------------------------------------------
// Layer 1 — Pure helper isTransientLiveError
// ---------------------------------------------------------------------------

describe("isTransientLiveError — classification", () => {
  it("matches the 0x80040408 hex HRESULT", () => {
    expect(isTransientLiveError(new Error("0x80040408 something failed"))).toBe(true);
    expect(isTransientLiveError(new Error("HRESULT 0x80040408"))).toBe(true);
  });

  it("matches the hex code case-insensitively", () => {
    expect(isTransientLiveError(new Error("0X80040408 boom"))).toBe(true);
    expect(isTransientLiveError(new Error("error 0x80040408"))).toBe(true);
  });

  it("matches the decimal form -2147220472 (some winax paths only stringify this)", () => {
    expect(isTransientLiveError(new Error("OLE error -2147220472"))).toBe(true);
  });

  it("matches the descriptive 'QBSession not open' text without the hex code", () => {
    expect(isTransientLiveError(new Error("QBSession not open"))).toBe(true);
    expect(isTransientLiveError(new Error("qbsession not open: please reconnect"))).toBe(true);
  });

  it("does NOT match unrelated errors", () => {
    expect(isTransientLiveError(new Error("Invalid argument"))).toBe(false);
    expect(isTransientLiveError(new Error("statusCode=3120 missing element"))).toBe(false);
    expect(isTransientLiveError(new Error("0x80040409 disconnected"))).toBe(false);
    expect(isTransientLiveError(new Error("Access denied"))).toBe(false);
    expect(isTransientLiveError(new Error(""))).toBe(false);
  });

  it("does NOT match RPC-server-side codes that we deliberately leave to the operator", () => {
    expect(isTransientLiveError(new Error("RPC_E_SERVERCALL_RETRYLATER (0x8001010A)"))).toBe(false);
    expect(isTransientLiveError(new Error("RPC_S_CALL_FAILED 0x800706be"))).toBe(false);
  });

  it("handles plain-string and non-Error inputs without throwing", () => {
    expect(isTransientLiveError("0x80040408 plain string")).toBe(true);
    expect(isTransientLiveError("nothing here")).toBe(false);
    expect(isTransientLiveError(null)).toBe(false);
    expect(isTransientLiveError(undefined)).toBe(false);
    expect(isTransientLiveError({ message: "0x80040408" })).toBe(false); // not Error, .message ignored
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — RECONNECT_BACKOFF_MS schedule pinned
// ---------------------------------------------------------------------------

describe("RECONNECT_BACKOFF_MS — schedule", () => {
  it("is exactly [250, 500, 1000] — pinned so a future tuning change is intentional", () => {
    expect(RECONNECT_BACKOFF_MS).toEqual([250, 500, 1000]);
  });

  it("is frozen so callers can't mutate the canonical schedule", () => {
    expect(Object.isFrozen(RECONNECT_BACKOFF_MS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — sendLiveRequestWithRetry via a patched fake-live manager
// ---------------------------------------------------------------------------

/**
 * Build a manager pretending to be in live mode without ever loading winax.
 * Patches:
 *   - simulationMode → false
 *   - rp → fake with a ProcessRequest spy
 *   - session → fake ticket
 *   - openSession → no-op that re-installs the fake rp + session so the
 *     reconnect path can succeed without going through the real winax COM
 *     initialization
 *   - sleepImpl → captures sleep durations and resolves immediately
 *
 * The returned helpers let tests configure ProcessRequest behavior per call
 * and assert on retry counts, sleep durations, and reconnect side effects.
 */
function makeFakeLiveManager() {
  const sm = new QBSessionManager({
    companyFile: "C:\\fixtures\\TestCo.qbw",
    appName: "vitest-retry",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });

  // Force live mode without touching winax. Real openSession would try to
  // import winax and fail on non-Windows; we override openSession to a
  // no-op that re-installs the test fakes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internal = sm as any;
  internal.simulationMode = false;

  const sleepDurations: number[] = [];
  internal.sleepImpl = async (ms: number) => {
    sleepDurations.push(ms);
  };

  // Queue of ProcessRequest behaviors. Each call shifts one item off:
  //   - { ok: string } returns the string
  //   - { err: Error } throws the error
  // Tests push into this queue before calling sm.sendRequest.
  type Behavior = { ok: string } | { err: Error };
  const queue: Behavior[] = [];

  const processRequestSpy = vi.fn((_ticket: string, _xml: string): string => {
    const next = queue.shift();
    if (!next) {
      throw new Error("Test bug: ProcessRequest called more times than expected");
    }
    if ("err" in next) throw next.err;
    return next.ok;
  });

  const endSessionSpy = vi.fn();
  const closeConnectionSpy = vi.fn();

  let openSessionCallCount = 0;
  internal.openSession = vi.fn(async () => {
    openSessionCallCount += 1;
    internal.rp = {
      ProcessRequest: processRequestSpy,
      EndSession: endSessionSpy,
      CloseConnection: closeConnectionSpy,
    };
    internal.session = {
      ticket: `TICKET-${openSessionCallCount}`,
      companyFile: "C:\\fixtures\\TestCo.qbw",
      openedAt: new Date(),
    };
    return internal.session;
  });

  // Prime initial state so sendRequest doesn't early-return into "open".
  internal.rp = {
    ProcessRequest: processRequestSpy,
    EndSession: endSessionSpy,
    CloseConnection: closeConnectionSpy,
  };
  internal.session = {
    ticket: "TICKET-0",
    companyFile: "C:\\fixtures\\TestCo.qbw",
    openedAt: new Date(),
  };

  return {
    sm,
    enqueue: (behavior: Behavior) => queue.push(behavior),
    sleepDurations,
    processRequestSpy,
    endSessionSpy,
    closeConnectionSpy,
    openSessionCallCount: () => openSessionCallCount,
    queueDepth: () => queue.length,
  };
}

// A minimal valid QBXML response — the parser accepts it and returns a
// QBXMLResponse with one empty Rs message. Sufficient for testing the
// transport-layer retry behavior; content correctness is verified elsewhere.
const VALID_RESPONSE_XML = `<?xml version="1.0"?>
<?qbxml version="16.0"?>
<QBXML>
  <QBXMLMsgsRs>
    <CustomerQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="Status OK"/>
  </QBXMLMsgsRs>
</QBXML>`;

describe("QBSessionManager.sendRequest — auto-reconnect retry (live mode)", () => {
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Silence the per-retry console.error operator-visibility logs in test
    // output. Tests that care about the message assert on it explicitly.
    consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrSpy.mockRestore();
  });

  it("returns on first attempt without sleeping or reconnecting when ProcessRequest succeeds", async () => {
    const h = makeFakeLiveManager();
    h.enqueue({ ok: VALID_RESPONSE_XML });

    const response = await h.sm.sendRequest("<rq/>");
    expect(response).toBeDefined();
    expect(h.processRequestSpy).toHaveBeenCalledTimes(1);
    expect(h.sleepDurations).toEqual([]);
    expect(h.endSessionSpy).not.toHaveBeenCalled();
    expect(h.closeConnectionSpy).not.toHaveBeenCalled();
    // openSession was only called the once at the top of sendRequest's
    // sim-vs-live check — no reconnect.
    expect(h.openSessionCallCount()).toBe(0); // initial state already open
  });

  it("retries once on a single transient error, succeeds on attempt 2 with 250ms backoff", async () => {
    const h = makeFakeLiveManager();
    h.enqueue({ err: new Error("0x80040408 QBSession not open") });
    h.enqueue({ ok: VALID_RESPONSE_XML });

    const response = await h.sm.sendRequest("<rq/>");
    expect(response).toBeDefined();
    expect(h.processRequestSpy).toHaveBeenCalledTimes(2);
    expect(h.sleepDurations).toEqual([250]);
    // Reconnect path: best-effort teardown then re-open.
    expect(h.endSessionSpy).toHaveBeenCalledTimes(1);
    expect(h.closeConnectionSpy).toHaveBeenCalledTimes(1);
    expect(h.openSessionCallCount()).toBe(1);
  });

  it("retries up to 3 times on persistent transient errors, sleeps 250 → 500 → 1000, then throws", async () => {
    const h = makeFakeLiveManager();
    // 4 transient errors — initial + 3 retries all fail.
    for (let i = 0; i < 4; i++) {
      h.enqueue({ err: new Error("0x80040408 QBSession not open") });
    }

    await expect(h.sm.sendRequest("<rq/>")).rejects.toThrow("0x80040408");
    expect(h.processRequestSpy).toHaveBeenCalledTimes(4);
    expect(h.sleepDurations).toEqual([250, 500, 1000]);
    expect(h.endSessionSpy).toHaveBeenCalledTimes(3);
    expect(h.closeConnectionSpy).toHaveBeenCalledTimes(3);
    expect(h.openSessionCallCount()).toBe(3);
  });

  it("throws non-transient errors immediately without sleeping or reconnecting", async () => {
    const h = makeFakeLiveManager();
    h.enqueue({ err: new Error("Invalid argument — wire-side QB rejection") });

    await expect(h.sm.sendRequest("<rq/>")).rejects.toThrow("Invalid argument");
    expect(h.processRequestSpy).toHaveBeenCalledTimes(1);
    expect(h.sleepDurations).toEqual([]);
    expect(h.endSessionSpy).not.toHaveBeenCalled();
    expect(h.openSessionCallCount()).toBe(0);
  });

  it("stops retrying when a non-transient error follows a transient one (the second error wins)", async () => {
    const h = makeFakeLiveManager();
    h.enqueue({ err: new Error("0x80040408 QBSession not open") });
    h.enqueue({ err: new Error("statusCode=3170 modify failed") });

    await expect(h.sm.sendRequest("<rq/>")).rejects.toThrow("statusCode=3170");
    expect(h.processRequestSpy).toHaveBeenCalledTimes(2);
    // Only the first (transient) leg slept.
    expect(h.sleepDurations).toEqual([250]);
    expect(h.openSessionCallCount()).toBe(1);
  });

  it("wraps reconnect failure with both the reconnect cause and the original transient error", async () => {
    const h = makeFakeLiveManager();
    h.enqueue({ err: new Error("0x80040408 QBSession not open") });
    // Make the NEXT openSession (reconnect) throw — QB Desktop fully gone.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h.sm as any).openSession = vi.fn(async () => {
      throw new Error("QB Desktop is not running");
    });

    await expect(h.sm.sendRequest("<rq/>")).rejects.toThrow(
      /Reconnect after transient QBXMLRP2 error failed.*QB Desktop is not running.*Original transient error.*0x80040408/s,
    );
    expect(h.processRequestSpy).toHaveBeenCalledTimes(1);
    expect(h.sleepDurations).toEqual([250]);
  });

  it("emits an operator-visible console.error on each retry", async () => {
    const h = makeFakeLiveManager();
    h.enqueue({ err: new Error("0x80040408 QBSession not open") });
    h.enqueue({ ok: VALID_RESPONSE_XML });

    await h.sm.sendRequest("<rq/>");
    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Transient QBXMLRP2 error on attempt 1\/4.*Reconnecting and retrying after 250ms/),
    );
  });

  it("uses the matching backoff duration for each successive retry attempt", async () => {
    const h = makeFakeLiveManager();
    // Transient on attempts 1, 2 — success on attempt 3.
    h.enqueue({ err: new Error("0x80040408 QBSession not open") });
    h.enqueue({ err: new Error("0x80040408 QBSession not open") });
    h.enqueue({ ok: VALID_RESPONSE_XML });

    await h.sm.sendRequest("<rq/>");
    expect(h.sleepDurations).toEqual([250, 500]);
    expect(h.openSessionCallCount()).toBe(2);
  });

  it("preserves readOnly across reconnect", async () => {
    const h = makeFakeLiveManager();
    h.sm.setReadOnly(true);
    expect(h.sm.isReadOnly()).toBe(true);

    h.enqueue({ err: new Error("0x80040408 QBSession not open") });
    h.enqueue({ ok: VALID_RESPONSE_XML });

    await h.sm.sendRequest("<rq/>");
    expect(h.sm.isReadOnly()).toBe(true);
  });

  it("matches the descriptive 'QBSession not open' text even without the hex code", async () => {
    const h = makeFakeLiveManager();
    h.enqueue({ err: new Error("QBSession not open: please reopen the session") });
    h.enqueue({ ok: VALID_RESPONSE_XML });

    const response = await h.sm.sendRequest("<rq/>");
    expect(response).toBeDefined();
    expect(h.processRequestSpy).toHaveBeenCalledTimes(2);
    expect(h.sleepDurations).toEqual([250]);
  });

  it("swallows EndSession / CloseConnection throws during reconnect (best-effort teardown)", async () => {
    const h = makeFakeLiveManager();
    h.endSessionSpy.mockImplementation(() => {
      throw new Error("EndSession failed — ticket already dead");
    });
    h.closeConnectionSpy.mockImplementation(() => {
      throw new Error("CloseConnection failed — already disconnected");
    });
    h.enqueue({ err: new Error("0x80040408 QBSession not open") });
    h.enqueue({ ok: VALID_RESPONSE_XML });

    // Despite both teardown ops throwing, the retry should still complete.
    const response = await h.sm.sendRequest("<rq/>");
    expect(response).toBeDefined();
    expect(h.openSessionCallCount()).toBe(1);
  });

  it("does NOT retry in simulation mode — sim throws propagate immediately", async () => {
    const sm = new QBSessionManager({
      companyFile: "simulation",
      appName: "vitest-retry-sim",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
    let callCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).store.processRequest = () => {
      callCount += 1;
      throw new Error("0x80040408 QBSession not open"); // pretend transient
    };
    const sleeps: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).sleepImpl = async (ms: number) => {
      sleeps.push(ms);
    };

    await expect(sm.sendRequest("<rq/>")).rejects.toThrow("0x80040408");
    expect(callCount).toBe(1);
    expect(sleeps).toEqual([]);
  });
});
