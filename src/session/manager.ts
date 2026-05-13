/**
 * QuickBooks Desktop Session Manager.
 *
 * Manages the connection lifecycle with QuickBooks Desktop, including:
 * - Opening/closing sessions via the QBXML session manager
 * - Sending QBXML request messages and receiving responses
 * - Connection state tracking and error recovery
 *
 * In a production Windows environment, this would use the QBXMLRP2 COM
 * component (or the QBFC library) to communicate with QuickBooks Desktop.
 * This implementation provides the full interface and can operate in two modes:
 *   1. Live mode — communicates with a real QuickBooks Desktop instance via
 *      the QBXMLRP2 request processor (requires Windows + QB Desktop installed)
 *   2. Simulation mode — returns realistic mock responses for development,
 *      testing, and non-Windows environments
 */

import { createHash } from "node:crypto";
import {
  buildQBXMLRequest,
  buildQueryRequest,
  buildAddRequest,
  buildModRequest,
  buildDeleteRequest,
  buildReportRequest,
  buildCustomDetailReportRequest,
  buildGeneralDetailReportRequest,
  buildPayrollSummaryReportRequest,
  buildClearedStatusModRequest,
} from "../qbxml/builder.js";
import {
  parseQBXMLResponse,
  extractResponseData,
  extractReportData,
  extractCustomDetailReportData,
  extractGeneralDetailReportData,
  flattenEntityArray,
} from "../qbxml/parser.js";
import type {
  QBConnectionConfig,
  QBSession,
  QBXMLRequest,
  QBXMLResponse,
} from "../types/qbxml.js";
import type { ComDispatchObject } from "winax";
import { SimulationStore } from "./simulation-store.js";
import { getQbxmlLogger } from "../util/qbxml-logger.js";

// ---------------------------------------------------------------------------
// QBXMLRP2 SDK constants (Intuit QuickBooks SDK 16.0)
// ---------------------------------------------------------------------------

/**
 * `OpenConnection2` connectionType. localQBD (1) requires QuickBooks Desktop
 * to be running on this machine and have a company file open. The setup
 * script's COM probe uses the same value, so the cert that the operator
 * approved on first run is bound to (appName, localQBD) tuples.
 */
const RP2_CONNECTION_TYPE_LOCAL_QBD = 1;

/**
 * `BeginSession` qbFileMode. omDontCare (2) inherits whatever
 * single/multi-user mode the operator already has the file in. Real QB
 * rejects single-user-only requests when the file is opened multi-user; we
 * sidestep that by deferring to the operator's existing choice.
 */
const RP2_FILE_MODE_DONT_CARE = 2;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by the session manager when a mutation is attempted against a session
 * that was opened with `readOnly: true`. Carries `statusCode 9001` (synthetic
 * sentinel — outside the QB SDK's 0/1/3xxx/5xx range) so the existing tool-side
 * error wrapper (the Item 25 catch) surfaces it as a structured `isError: true`
 * response with a humanReadable message via qb-status-codes.ts. Caught and
 * re-thrown unchanged by the typed mutation helpers (addEntity, modifyEntity,
 * deleteEntity, executeBatchAdd) — they don't unwrap it.
 *
 * Statuscode is deliberately distinct from QB-server-side `3260` ("insufficient
 * permission"); the latter is a real wire response, this is a CLIENT-SIDE gate
 * that never reaches QB. Distinguishing them in the surface lets agents tell
 * "I'm in read-only mode" apart from "QB rejected my user role".
 */
export class QBReadOnlyError extends Error {
  statusCode: number;
  constructor(operation: string) {
    super(
      `Read-only session: ${operation} rejected. The session was opened with ` +
      `readOnly: true. Reconnect with qb_session_connect({ readOnly: false }) ` +
      `to re-enable mutations.`
    );
    this.name = "QBReadOnlyError";
    this.statusCode = 9001;
  }
}

/**
 * Thrown by `addEntityIdempotent` / `executeBatchAddIdempotent` when an
 * idempotency key has been seen before AGAINST A DIFFERENT REQUEST PAYLOAD.
 * Carries `statusCode 9002` (synthetic sentinel — distinct from the 9001
 * read-only sentinel and outside QB's 0/1/3xxx/5xx range) so the existing
 * tool-side error wrapper surfaces it as a structured `isError: true` with
 * humanReadable from qb-status-codes.ts.
 *
 * Why we reject instead of silently overwriting: a key collision against a
 * different payload almost always indicates a bug in the caller (recycling a
 * key, racing two concurrent agents on the same key, etc.). Returning the
 * stale cached result for a different payload is dangerous; rejecting and
 * forcing the operator to use a fresh key is safe. Stripe's idempotency
 * model is the same.
 */
export class QBIdempotencyKeyConflictError extends Error {
  statusCode: number;
  idempotencyKey: string;
  entityType: string;
  constructor(idempotencyKey: string, entityType: string) {
    super(
      `Idempotency key conflict: '${idempotencyKey}' was previously used for a ` +
      `${entityType} create with a different request payload. Use a fresh key ` +
      `for new requests, or replay with the exact original payload to retrieve ` +
      `the cached result.`
    );
    this.name = "QBIdempotencyKeyConflictError";
    this.statusCode = 9002;
    this.idempotencyKey = idempotencyKey;
    this.entityType = entityType;
  }
}

// ---------------------------------------------------------------------------
// Host info — QB edition / version detection (Phase 18 #82)
// ---------------------------------------------------------------------------

/**
 * Normalized shape returned by `QBSessionManager.getHostInfo()`. Derived from
 * the raw `HostRet` wire shape (camelCased fields + flattened version list +
 * derived `edition` discriminant). Surfaced verbatim by `qb_host_query`.
 *
 * `edition` is the gating signal used by tools that require a specific QB
 * edition (item 66 audit log → Enterprise, item 55 W-2 → Payroll subscription
 * which is a separate query). Tools should NOT parse `productName` themselves —
 * use `edition` / `isEnterprise` / `isAccountant`.
 */
export type HostEdition =
  | "Pro"
  | "Premier"
  | "PremierAccountant"
  | "Enterprise"
  | "EnterpriseAccountant"
  | "Unknown";

export interface HostInfo {
  productName: string;
  majorVersion: string;
  minorVersion: string;
  country: string;
  supportedQbxmlVersions: string[];
  maxQbxmlVersion: string | null;
  isAutomaticLogin: boolean;
  qbFileMode: string;
  edition: HostEdition;
  isEnterprise: boolean;
  isAccountant: boolean;
}

/**
 * Derive the edition discriminant from QB's free-form ProductName string.
 *
 * Product-name samples seen in the wild:
 *   "QuickBooks Pro 2024"
 *   "QuickBooks Premier Edition 2024"
 *   "QuickBooks Premier Accountant Edition 2024"
 *   "QuickBooks Accountant Desktop 2024"   ← standalone Accountant brand = Premier Accountant
 *   "QuickBooks Enterprise Solutions 24.0"
 *   "QuickBooks Enterprise Solutions: Accountant 24.0"
 *
 * Match order matters — Enterprise must precede Premier (an Enterprise build
 * with "Premier" anywhere in the marketing copy would otherwise misclassify),
 * and the +Accountant variants check both the family marker and "accountant"
 * in one pass. Standalone "Accountant" (no Premier / Enterprise) is a
 * rebranded Premier Accountant — classified as PremierAccountant.
 */
export function deriveHostEdition(productName: string): HostEdition {
  const p = productName.toLowerCase();
  const hasAccountant = p.includes("accountant");
  if (p.includes("enterprise")) {
    return hasAccountant ? "EnterpriseAccountant" : "Enterprise";
  }
  if (p.includes("premier")) {
    return hasAccountant ? "PremierAccountant" : "Premier";
  }
  if (hasAccountant) return "PremierAccountant";
  if (p.includes("pro")) return "Pro";
  return "Unknown";
}

/**
 * Normalize a raw HostRet wire shape into the camelCased HostInfo shape.
 * Tolerant of two SupportedQBXMLVersionList encodings: fast-xml-parser
 * produces `{Version: ["1.0", "1.1", ...]}` for multi-version lists and
 * `{Version: "16.0"}` for a single-version list (Version isn't in the
 * parser's arrayElements set — we coerce here rather than pollute the
 * global set with a name as generic as "Version").
 *
 * Defensive about every input — a malformed HostRet (missing fields, wrong
 * types) produces a HostInfo with empty-string / false / "Unknown" defaults
 * rather than throwing. The caller (qb_host_query) shouldn't fail open on a
 * shape it didn't expect.
 */
export function normalizeHostInfo(raw: Record<string, unknown>): HostInfo {
  const productName = String(raw.ProductName ?? "");
  const majorVersion = String(raw.MajorVersion ?? "");
  const minorVersion = String(raw.MinorVersion ?? "");
  const country = String(raw.Country ?? "");
  const qbFileMode = String(raw.QBFileMode ?? "");

  const isAutomaticLogin = (() => {
    const v = raw.IsAutomaticLogin;
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v.toLowerCase() === "true";
    return false;
  })();

  const supportedQbxmlVersions = (() => {
    const v = raw.SupportedQBXMLVersionList;
    if (!v || typeof v !== "object") return [];
    const inner = (v as Record<string, unknown>).Version;
    if (inner === undefined || inner === null) return [];
    if (Array.isArray(inner)) return inner.map((x) => String(x));
    return [String(inner)];
  })();

  const maxQbxmlVersion = supportedQbxmlVersions.length > 0
    ? supportedQbxmlVersions.reduce((acc, v) => {
        // Compare as numeric tuples so "16.0" > "9.0" (string compare fails here).
        const av = acc.split(".").map(Number);
        const bv = v.split(".").map(Number);
        for (let i = 0; i < Math.max(av.length, bv.length); i++) {
          const a = av[i] ?? 0;
          const b = bv[i] ?? 0;
          if (a !== b) return a > b ? acc : v;
        }
        return acc;
      })
    : null;

  const edition = deriveHostEdition(productName);

  return {
    productName,
    majorVersion,
    minorVersion,
    country,
    supportedQbxmlVersions,
    maxQbxmlVersion,
    isAutomaticLogin,
    qbFileMode,
    edition,
    isEnterprise: edition === "Enterprise" || edition === "EnterpriseAccountant",
    isAccountant: edition === "PremierAccountant" || edition === "EnterpriseAccountant",
  };
}

// ---------------------------------------------------------------------------
// Idempotency cache helpers
// ---------------------------------------------------------------------------

export interface IdempotencyCacheEntry {
  entityType: string;
  payloadFingerprint: string;
  result: unknown;
  createdAt: number;
}

/**
 * Stable-order JSON stringification — recursively sorts object keys so that
 * `{a:1, b:2}` and `{b:2, a:1}` produce the same string. Used as the input
 * to the SHA-256 fingerprint that protects against same-key/different-payload
 * collisions.
 *
 * Arrays preserve order (line ordering is semantically meaningful in QB —
 * line[0] vs line[1] map to different TxnLineIDs after persist). `undefined`
 * is dropped during serialization (matches JSON.stringify behavior).
 */
function canonicalizeJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalizeJson).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalizeJson(obj[k]))
      .join(",") +
    "}"
  );
}

function fingerprintPayload(entityType: string, payload: unknown): string {
  return createHash("sha256")
    .update(entityType + ":" + canonicalizeJson(payload))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Live-mode transient-error retry (Phase 18 #84)
// ---------------------------------------------------------------------------

/**
 * Backoff schedule between auto-reconnect retries on transient QBXMLRP2
 * failures. Three retries after the initial attempt = four total wire calls
 * worst case. Total sleep budget 1.75s — enough for QB Desktop to recover
 * from a brief stall without blocking the agent for an unreasonably long
 * time. Frozen so tests can assert against the canonical schedule.
 *
 * Tuning rationale: QB Desktop's request processor occasionally rejects a
 * call with `0x80040408 "QBSession not open"` when QB is mid-operation
 * (autosave, background indexing). Typical recovery is sub-second; the 250
 * → 500 → 1000 ladder hits the 99th percentile of those without inflating
 * latency for the common case. If we ever see a recoverable error pattern
 * that needs >1.75s, add a fourth tier rather than stretching the existing
 * ones — the existing values are pinned by the test schedule.
 */
export const RECONNECT_BACKOFF_MS: readonly number[] = Object.freeze([250, 500, 1000]);

/**
 * Classify whether a QBXMLRP2 error is recoverable by tearing down the
 * session and re-opening. Conservative whitelist — only retry on signals we
 * have direct evidence are transient. Anything else propagates to the
 * caller immediately so the operator can see the real failure.
 *
 * Matched signals:
 *   - `0x80040408` — the canonical "QBSession not open" HRESULT QBXMLRP2
 *     returns when QB Desktop drops the ticket mid-session (autosave,
 *     background indexing, brief stall). Also surfaces as the decimal form
 *     `-2147220472` from some winax error paths. Match on both hex string
 *     and the descriptive text "QBSession not open" since winax sometimes
 *     formats only one or the other.
 *
 * Not retried:
 *   - `0x80040409` / general "connection lost" — observed only in scenarios
 *     where QB Desktop crashed and won't accept a fresh OpenConnection2
 *     either. Retrying just wastes the budget; bubble the error so the
 *     operator can act.
 *   - `RPC_E_*` codes — too ambiguous; some are transient, others are
 *     terminal. Wait until we see one in the wild before adding it.
 *   - QB-status-code-shaped errors (3120 / 3170 / 500) — these are
 *     application-level, not transport-level. Retrying would not change
 *     the outcome.
 */
export function isTransientLiveError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const raw = err instanceof Error ? err.message : String(err);
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return (
    lower.includes("0x80040408") ||
    lower.includes("-2147220472") ||
    lower.includes("qbsession not open")
  );
}

/**
 * Real-clock sleep. Overridable per-instance via `QBSessionManager.sleepImpl`
 * so the retry loop is testable without `vi.useFakeTimers()` pollution.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Session manager
// ---------------------------------------------------------------------------

/**
 * Resolve simulation mode from the environment. Pure function so the matrix is
 * testable without spinning up sessions.
 *
 * Rule:
 *  - QB_SIMULATION="true"  → always simulate (forced-on override).
 *  - QB_SIMULATION="false" → never simulate; openSession will throw if the
 *    platform can't actually do live (non-Windows, or live not implemented).
 *  - QB_SIMULATION unset   → simulate by default unless on win32 with QB_LIVE=1.
 *
 * Any QB_SIMULATION value other than "true"/"false" (e.g. "1", "yes") is
 * treated as unset to keep the contract narrow — the env var is documented as
 * accepting only those two literal strings.
 */
export function resolveSimulationMode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (env.QB_SIMULATION === "true") return true;
  if (env.QB_SIMULATION === "false") return false;
  return platform !== "win32" || env.QB_LIVE !== "1";
}

export class QBSessionManager {
  private config: QBConnectionConfig;
  private session: QBSession | null = null;
  private simulationMode: boolean;
  private store: SimulationStore;
  /**
   * Live-mode `QBXMLRP2.RequestProcessor` dispatch object. Held between
   * `openSession` and `closeSession` so the same connection processes every
   * request in a session. Null in simulation mode and after `closeSession`.
   */
  private rp: ComDispatchObject | null = null;
  /**
   * Read-only flag (Phase 10 #42). Set via `setReadOnly(true)` (typically on
   * `qb_session_connect({ readOnly: true })`); when true, every mutation
   * helper (`addEntity`, `modifyEntity`, `deleteEntity`, `executeBatchAdd`)
   * throws `QBReadOnlyError` BEFORE building XML or hitting the wire.
   * Persists across `openSession`/`closeSession` so the flag survives an
   * auto-reconnect; only `setReadOnly(false)` (or restarting the process)
   * clears it.
   */
  private readOnly: boolean = false;

  /**
   * Idempotency cache (Phase 10 #47). Maps idempotencyKey → cached result.
   * Scoped per-companyFile — `switchCompanyFile` clears it. FIFO-bounded by
   * `MAX_IDEMPOTENCY_CACHE_SIZE`; the oldest entry is evicted when capacity
   * is exceeded. Map's insertion-order iteration gives FIFO for free.
   *
   * Only successful creates are cached — a thrown error from `addEntity` /
   * `executeBatchAdd` leaves the key unset so the next retry can fix the
   * underlying problem without being shadowed by a stale failure.
   */
  private idempotencyCache: Map<string, IdempotencyCacheEntry> = new Map();

  /**
   * Cached host info (Phase 18 #82). Lazily populated on the first
   * `getHostInfo()` call and held until `switchCompanyFile` clears it.
   *
   * HostQueryRq returns properties of the QB Desktop INSTALLATION
   * (ProductName, MajorVersion, SupportedQBXMLVersionList, IsAutomaticLogin,
   * QBFileMode) — not the company file. In practice these don't change within
   * a single process's lifetime, so caching one round trip per session is the
   * right tradeoff. The cache is cleared on `switchCompanyFile` defensively
   * (the operator might be switching to a file backed by a different QB
   * process in some future remote-mode setup — current localQBD doesn't allow
   * this, but the cost of an extra round trip on switch is negligible).
   */
  private hostInfoCache: HostInfo | null = null;

  /**
   * Cap on the per-companyFile idempotency cache. Sized for a long-running
   * agent session (typical agent runs post < 100 mutations); 1000 leaves
   * generous headroom without unbounded memory growth. FIFO eviction is
   * fine — we only need recent retries to hit; very old keys aging out is
   * the correct behavior, not a bug.
   */
  private static readonly MAX_IDEMPOTENCY_CACHE_SIZE = 1000;

  /**
   * Backoff sleep implementation (Phase 18 #84). Defaults to a real-clock
   * `setTimeout`-based sleep; tests override via
   * `(sm as any).sleepImpl = stub` so the retry loop can run without burning
   * real wall-clock time. Public-ish (private field, but reachable via
   * `as any`) matches the existing test-seam pattern used for
   * `store.processRequest` / `getHostInfo` overrides.
   */
  private sleepImpl: (ms: number) => Promise<void> = defaultSleep;

  /**
   * Epoch-millisecond timestamps of every transient-retry firing in
   * `sendLiveRequestWithRetry` (Phase 14 #67). Each entry corresponds to one
   * successful classify-as-transient → sleep → reconnect → retry leg — the
   * push happens AFTER the classification check and BEFORE the sleep, so the
   * count reflects retries actually fired (not transient errors that were
   * the LAST attempt and therefore propagated without a retry firing).
   *
   * Pruned to the last hour on `getTransientRetryStats()` read so the array
   * stays bounded under long-running agent sessions with intermittent
   * transient failures. Bare push on each retry — no batching — because the
   * frequency is naturally low (transient failures are rare; even a busy
   * session sees < 1/minute).
   *
   * Survives auto-reconnect (the timestamp is added BEFORE the reconnect
   * runs, and `reconnectAfterTransientError` does NOT clear this field — same
   * discipline as `readOnly` / `idempotencyCache` / `hostInfoCache`). Cleared
   * only on `switchCompanyFile` (a deliberate fresh start when the operator
   * moves between books) and process restart.
   */
  private transientRetryTimestamps: number[] = [];

  /**
   * Monotonic counter of every transient-retry firing since process start
   * (Phase 14 #67). Distinct from `transientRetryTimestamps.length` because
   * the array is pruned to the last hour for the rolling-window stat;
   * this counter is never reset (except via switchCompanyFile, same as the
   * timestamp array — moving to a fresh book is a fresh observability
   * window). Surfaced as `totalTransientRetries` by getTransientRetryStats.
   */
  private totalTransientRetries: number = 0;

  constructor(config: QBConnectionConfig) {
    this.config = config;
    this.simulationMode = resolveSimulationMode(process.env, process.platform);
    this.store = new SimulationStore();

    if (this.simulationMode) {
      console.error(
        "[QB Session] Running in simulation mode — " +
        "set QB_LIVE=1 on a Windows machine with QuickBooks Desktop to use live mode"
      );
    }
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  async openSession(): Promise<QBSession> {
    if (this.session) return this.session;

    if (this.simulationMode) {
      this.session = {
        ticket: `SIM-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        companyFile: this.config.companyFile,
        openedAt: new Date(),
      };
      console.error(`[QB Session] Simulation session opened: ${this.session.ticket}`);
      return this.session;
    }

    // LIVE MODE — QBXMLRP2 COM automation via winax.
    let winax: typeof import("winax");
    try {
      winax = await import("winax");
    } catch (err) {
      throw new Error(
        "winax module not available. Run scripts/setup-qb-pc.ps1 from an elevated PowerShell " +
        "to install Visual Studio Build Tools + Python and rebuild it, or set QB_SIMULATION=true. " +
        `Underlying error: ${(err as Error).message}`
      );
    }
    const ActiveXObject =
      (winax as { Object?: typeof winax.Object }).Object ??
      (winax as { default?: { Object?: typeof winax.Object } }).default?.Object;
    if (!ActiveXObject) {
      throw new Error(
        "winax loaded but does not expose an `Object` constructor — incompatible winax version installed."
      );
    }

    const rp = new ActiveXObject("QBXMLRP2.RequestProcessor");

    try {
      rp.OpenConnection2(
        this.config.appId ?? "",
        this.config.appName,
        RP2_CONNECTION_TYPE_LOCAL_QBD
      );
    } catch (err) {
      this.rp = null;
      throw new Error(
        `QBXMLRP2.OpenConnection2 failed: ${(err as Error).message}. ` +
        "Verify QuickBooks Desktop is installed and the QuickBooks SDK is registered " +
        "(scripts/setup-qb-pc.ps1 step 4 probes this)."
      );
    }

    let ticket: string;
    try {
      // companyFile === "" tells QBXMLRP2 to use whatever file is currently
      // open in QuickBooks Desktop. That's the better UX for an interactive
      // tool — operators usually have the file open already.
      ticket = rp.BeginSession(this.config.companyFile ?? "", RP2_FILE_MODE_DONT_CARE);
    } catch (err) {
      try { rp.CloseConnection(); } catch { /* swallow — we're already in error path */ }
      throw new Error(
        `QBXMLRP2.BeginSession failed: ${(err as Error).message}. ` +
        "First connection? QuickBooks should have shown an Application Certificate dialog — " +
        "approve 'Yes, always' for app name '" + this.config.appName + "'. Otherwise verify " +
        "the company file path matches what QB has open and the logged-in user has Admin rights."
      );
    }
    if (!ticket) {
      try { rp.CloseConnection(); } catch { /* swallow */ }
      throw new Error("QBXMLRP2.BeginSession returned an empty ticket — connection refused without an error.");
    }

    this.rp = rp;
    this.session = {
      ticket,
      companyFile: this.config.companyFile,
      openedAt: new Date(),
    };
    console.error(`[QB Session] Live session opened: ticket=${ticket}`);
    return this.session;
  }

  async closeSession(): Promise<void> {
    if (!this.session) return;

    if (this.simulationMode) {
      console.error(`[QB Session] Simulation session closed: ${this.session.ticket}`);
      this.session = null;
      return;
    }

    // LIVE MODE — pair EndSession + CloseConnection, swallow shutdown errors.
    // We never want to crash the process during cleanup; better to log and
    // proceed than to leave the operator with a half-closed session that
    // blocks the next process from connecting.
    const ticket = this.session.ticket;
    if (this.rp) {
      try {
        this.rp.EndSession(ticket);
      } catch (err) {
        console.error(
          `[QB Session] EndSession failed (continuing anyway): ${(err as Error).message}`
        );
      }
      try {
        this.rp.CloseConnection();
      } catch (err) {
        console.error(
          `[QB Session] CloseConnection failed (continuing anyway): ${(err as Error).message}`
        );
      }
    }
    this.rp = null;
    this.session = null;
    console.error(`[QB Session] Live session closed: ticket=${ticket}`);
  }

  isConnected(): boolean {
    return this.session !== null;
  }

  getSession(): QBSession | null {
    return this.session;
  }

  isSimulation(): boolean {
    return this.simulationMode;
  }

  /**
   * Whether the session is currently gated against mutations. Surfaced by
   * `qb_session_connect` / `qb_company_info` so agents can probe before
   * attempting a write.
   */
  isReadOnly(): boolean {
    return this.readOnly;
  }

  /**
   * Toggle the read-only gate. Takes effect immediately for the next mutation
   * call — does NOT require a re-connect. Idempotent. The gate runs in BOTH
   * live and simulation mode (the value is intercepted at the typed-mutation
   * helpers, before any envelope is built or wire I/O happens).
   */
  setReadOnly(value: boolean): void {
    this.readOnly = value;
  }

  /**
   * Internal: throw QBReadOnlyError if the session is read-only. Called at
   * the entry of every mutation helper — keeps the gate in one place rather
   * than at each tool's `session.{add,modify,delete}Entity` call site (47
   * callers, see grep). The thrown error carries `statusCode 9001` which
   * the existing `qb-status-codes.ts` table maps to a human-readable
   * message; the existing tool error wrappers (Item 25 catch) surface it as
   * `isError: true` without modification.
   */
  private assertWritable(operation: string): void {
    if (this.readOnly) throw new QBReadOnlyError(operation);
  }

  /**
   * Path of the company file currently registered on the session config (the
   * one that openSession will pass to BeginSession). Empty string means
   * "use whatever file QB Desktop has open right now". Reads the live config
   * value, not a stale cached copy from a prior open session — switchCompanyFile
   * mutates this.
   */
  getCompanyFile(): string {
    return this.config.companyFile;
  }

  /**
   * Swap the active company file. Closes any in-flight session, mutates the
   * config path, resets the simulation store (sim mode only — real QB persists
   * per-file, sim doesn't), and opens a fresh session against the new file.
   *
   * Live mode: the close path runs EndSession + CloseConnection on the old
   * file; the open path runs OpenConnection2 + BeginSession on the new one.
   * QBXMLRP2 only supports one file open per process at a time, so this is
   * sequential by construction.
   *
   * Sim mode: the new SimulationStore reseeds; entities created against the
   * prior path are gone. This is the deliberate sim-fidelity tradeoff
   * documented in DECISIONS.md (2026-05-09).
   */
  async switchCompanyFile(companyFile: string): Promise<QBSession> {
    await this.closeSession();
    this.config.companyFile = companyFile;
    if (this.simulationMode) {
      this.store = new SimulationStore();
    }
    // Idempotency cache is per-companyFile — a TxnID issued under company A
    // would be meaningless under company B even if the same key were retried.
    // Reset it on every switch so we never serve a cached result that was
    // produced against a different file. Cleared in BOTH live and sim modes
    // (live QB does persist across switches, but the in-memory cache here
    // only holds keys observed in this process).
    this.idempotencyCache.clear();
    // Host info is installation-scoped (ProductName / MajorVersion / etc.),
    // not company-file-scoped — under localQBD it's the same QB process either
    // way. But the operator might be reconnecting to a freshly-installed /
    // upgraded QB, and the cost of re-querying is one round trip. Cheaper to
    // be defensive here than to ship stale edition info.
    this.hostInfoCache = null;
    // Transient-retry observability is a per-book signal — a fresh book is a
    // fresh observability window. Clearing here keeps `qb_session_status`
    // honest after a switch (otherwise "lastTransientRetryAt" from book A
    // would leak into the status snapshot for book B and falsely imply
    // recent instability on a freshly-opened file).
    this.transientRetryTimestamps = [];
    this.totalTransientRetries = 0;
    return this.openSession();
  }

  /**
   * Snapshot the transient-retry observability state (Phase 14 #67).
   * Prunes timestamps older than 1 hour on read so the array stays bounded
   * under long-running agent sessions. Returns:
   *   - `lastTransientRetryAt` — ISO timestamp of the most recent firing,
   *     null if none have fired this session (or post switchCompanyFile).
   *   - `transientRetryCountLastHour` — count of firings within the last
   *     hour. Designed for orchestration probes: a non-zero value means QB
   *     Desktop has been stalling recently; sustained non-zero means the
   *     local environment may need intervention.
   *   - `totalTransientRetries` — cumulative count since process start (or
   *     last switchCompanyFile). Not pruned. Useful for long-haul telemetry.
   *
   * No wire I/O, cheap. Safe to call from any tool handler; in particular
   * `qb_session_status` calls this on every invocation.
   */
  getTransientRetryStats(): {
    lastTransientRetryAt: string | null;
    transientRetryCountLastHour: number;
    totalTransientRetries: number;
  } {
    const now = Date.now();
    const oneHourAgo = now - 3600_000;
    // Prune in-place — the array is bounded and the prune is cheap. Filter
    // would allocate a new array on every call, which is wasteful for the
    // common case of "no transient retries fired".
    while (
      this.transientRetryTimestamps.length > 0 &&
      this.transientRetryTimestamps[0] < oneHourAgo
    ) {
      this.transientRetryTimestamps.shift();
    }
    const last = this.transientRetryTimestamps.length > 0
      ? this.transientRetryTimestamps[this.transientRetryTimestamps.length - 1]
      : null;
    return {
      lastTransientRetryAt: last !== null ? new Date(last).toISOString() : null,
      transientRetryCountLastHour: this.transientRetryTimestamps.length,
      totalTransientRetries: this.totalTransientRetries,
    };
  }

  /**
   * Application name registered with QBXMLRP2 — the string QB Desktop's
   * Application Certificate dialog quotes back to the operator on first
   * connect. Surfaced by `qb_session_status` so the operator can verify which
   * app identity this process is using (useful when multiple MCP processes
   * share a QB instance under different appNames).
   */
  getAppName(): string {
    return this.config.appName;
  }

  /**
   * Optional application ID. Most operators don't set this; surfaced for
   * completeness in `qb_session_status` so the snapshot has the full identity
   * tuple QBXMLRP2 was opened with.
   */
  getAppId(): string | undefined {
    return this.config.appId;
  }

  /**
   * qbXML schema version this session targets (defaults to "16.0"). Drives
   * the `<?qbxml version="..."?>` PI on every outgoing envelope; mismatched
   * versions against an older QB Desktop install surface as wire-side parse
   * errors (statusCode -1).
   */
  getQbxmlVersion(): string | undefined {
    return this.config.qbxmlVersion;
  }

  // -------------------------------------------------------------------------
  // QBXML request execution
  // -------------------------------------------------------------------------

  /**
   * Send a raw QBXML request string and return the parsed response.
   *
   * Hosts the QBXML debug logger (Phase 18 #83) hook point — every envelope
   * in/out flows through here, so wiring at this method covers both live and
   * sim paths uniformly. Logger is the singleton from
   * src/util/qbxml-logger.ts; null when QB_DEBUG_QBXML is unset, in which
   * case the log overhead is one null-check per request.
   */
  async sendRequest(qbxmlRequest: string): Promise<QBXMLResponse> {
    if (!this.session) {
      await this.openSession();
    }

    const logger = getQbxmlLogger();

    if (this.simulationMode) {
      const marker = logger?.logRequest(qbxmlRequest, "simulation");
      try {
        const response = this.store.processRequest(qbxmlRequest);
        if (logger && marker) logger.logResponse(response, "simulation", marker);
        return response;
      } catch (err) {
        if (logger && marker) logger.logError(err, "simulation", marker);
        throw err;
      }
    }

    // LIVE MODE — round-trip the QBXML string through QBXMLRP2 with auto-
    // reconnect retry on transient errors (Phase 18 #84). Each attempt is
    // logged as a separate request/response pair so debug logs surface the
    // full retry sequence; the response parser runs on the FINAL successful
    // attempt only. Non-transient errors bubble out on the first failure for
    // the existing tool-side error machinery (Item 25 path) to translate.
    return this.sendLiveRequestWithRetry(qbxmlRequest, logger);
  }

  /**
   * Live-mode wire call with automatic reconnect on transient QBXMLRP2
   * failures (Phase 18 #84). Caller has already gone through the sim-vs-live
   * branch and the session has been opened at least once.
   *
   * Retry schedule: initial attempt + up to `RECONNECT_BACKOFF_MS.length`
   * (3) retries, with sleeps drawn from `RECONNECT_BACKOFF_MS` between
   * attempts. After each transient failure the session is torn down (best-
   * effort EndSession + CloseConnection on the stale ticket, then null state)
   * and re-opened via `openSession()` before retrying.
   *
   * Failure modes:
   *   - Transient `ProcessRequest` error → sleep + reconnect + retry.
   *   - Non-transient `ProcessRequest` error → throw immediately.
   *   - Reconnect itself fails (e.g. QB Desktop fully closed) → throw a
   *     wrapped error naming both the reconnect failure and the original
   *     transient error. The retry budget is forfeit at that point — if QB
   *     won't accept a fresh OpenConnection2 right now, looping won't help.
   *   - All retries exhausted with transient errors only → throw the last
   *     transient error.
   *
   * State invariants preserved across reconnect:
   *   - `readOnly` flag (intentionally documented as surviving close/open).
   *   - `idempotencyCache` (per-companyFile; only cleared by switchCompanyFile).
   *   - `hostInfoCache` (installation-scoped; same process, same edition).
   *   - Live `companyFile` config (the new openSession uses the same path).
   */
  private async sendLiveRequestWithRetry(
    qbxmlRequest: string,
    logger: ReturnType<typeof getQbxmlLogger>,
  ): Promise<QBXMLResponse> {
    const maxRetries = RECONNECT_BACKOFF_MS.length;
    let lastErr: unknown = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (!this.rp || !this.session) {
        // Either initial state was empty (shouldn't reach here — sendRequest
        // calls openSession first), or a prior reconnect attempt left state
        // null. Treat as a hard error rather than auto-recovering further.
        throw new Error(
          "Live mode is active but no session is open — openSession was expected to be called first."
        );
      }

      const marker = logger?.logRequest(qbxmlRequest, "live");
      try {
        const responseXml: string = this.rp.ProcessRequest(this.session.ticket, qbxmlRequest);
        // Log the raw response XML BEFORE parsing — a parser throw is one of
        // the main reasons to enable this logger in the first place (the wire
        // bytes are the only useful artifact at that point).
        if (logger && marker) logger.logResponse(responseXml, "live", marker);
        return parseQBXMLResponse(responseXml);
      } catch (err) {
        if (logger && marker) logger.logError(err, "live", marker);
        lastErr = err;

        const haveRetriesLeft = attempt < maxRetries;
        if (!haveRetriesLeft || !isTransientLiveError(err)) {
          throw err;
        }

        const backoffMs = RECONNECT_BACKOFF_MS[attempt];
        // Record the firing BEFORE sleeping — observability should reflect
        // "we entered the retry path" rather than "we finished sleeping",
        // which matters when an `await sleepImpl` is intercepted by a test
        // that never resolves and a stat read happens mid-flight. Always
        // pushed (no allocation cost vs throwaway-on-no-debugger flag) — the
        // pruning on read keeps the array bounded.
        this.transientRetryTimestamps.push(Date.now());
        this.totalTransientRetries += 1;
        console.error(
          `[QB Session] Transient QBXMLRP2 error on attempt ${attempt + 1}/${maxRetries + 1} ` +
          `(${(err as Error).message}). Reconnecting and retrying after ${backoffMs}ms.`
        );
        await this.sleepImpl(backoffMs);
        try {
          await this.reconnectAfterTransientError();
        } catch (reconnectErr) {
          throw new Error(
            `Reconnect after transient QBXMLRP2 error failed: ${(reconnectErr as Error).message}. ` +
            `Original transient error: ${(err as Error).message}`
          );
        }
      }
    }

    // Unreachable in practice — the loop either returns on success or throws
    // on the final attempt. Defensive throw to satisfy the return-type check
    // and surface a clearly-labelled bug if the loop bounds ever drift.
    throw lastErr ?? new Error("sendLiveRequestWithRetry: exited loop without resolving");
  }

  /**
   * Tear down the current live-mode session in preparation for an
   * auto-reconnect (Phase 18 #84). Best-effort EndSession + CloseConnection
   * on the stale ticket — both can throw if QB Desktop already considers the
   * session dead, and we swallow those throws because we're already in the
   * recovery path. Then null out `rp` + `session` so `openSession()` will
   * actually re-run OpenConnection2 + BeginSession (it short-circuits when
   * `this.session` is non-null).
   *
   * Intentionally does NOT clear `readOnly`, `idempotencyCache`, or
   * `hostInfoCache` — those carry per-process state that survives a
   * connection reset by design.
   */
  private async reconnectAfterTransientError(): Promise<void> {
    if (this.rp) {
      if (this.session) {
        try { this.rp.EndSession(this.session.ticket); } catch { /* swallow — ticket likely already dead */ }
      }
      try { this.rp.CloseConnection(); } catch { /* swallow — connection likely already dropped */ }
    }
    this.rp = null;
    this.session = null;
    await this.openSession();
  }

  /**
   * Execute a structured QBXML request and return the parsed response.
   */
  async executeRequest(request: QBXMLRequest): Promise<QBXMLResponse> {
    const xml = buildQBXMLRequest(request);
    return this.sendRequest(xml);
  }

  // -------------------------------------------------------------------------
  // High-level query/CRUD operations
  // -------------------------------------------------------------------------

  async queryEntity(
    entityType: string,
    filters: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>[]> {
    const xml = buildQueryRequest(entityType, filters, {
      version: this.config.qbxmlVersion,
    });
    const response = await this.sendRequest(xml);
    const data = extractResponseData(response, `${entityType}QueryRs`);
    if (Array.isArray(data)) return data;
    return flattenEntityArray(
      data as Record<string, unknown>,
      `${entityType}Ret`
    );
  }

  /**
   * Paginated variant of queryEntity (Item 27). Real QB caps each *QueryRq
   * response at ~500 rows; subsequent pages are driven by passing the
   * iteratorID returned on the prior response back as the `iteratorID` arg
   * with iterator="Continue". When iteratorRemainingCount === 0 the iterator
   * is exhausted.
   *
   * Simulation behavior:
   *   - iterator="Start" (or omitted iteratorID with paginate intent) →
   *     returns the full result set in one shot, with iteratorRemainingCount=0
   *     and a synthesized iteratorID. The simulation does not actually page —
   *     real-world dev seed data fits well under 500 rows.
   *   - iterator="Continue"/"Stop" → returns empty (statusCode 1) with no
   *     iterator metadata, mirroring how real QB behaves once the iterator is
   *     drained.
   */
  async queryEntityPaginated(
    entityType: string,
    filters: Record<string, unknown> = {},
    options: {
      iterator?: "Start" | "Continue" | "Stop";
      iteratorID?: string;
    } = {}
  ): Promise<{
    entities: Record<string, unknown>[];
    iteratorRemainingCount?: number;
    iteratorID?: string;
  }> {
    const xml = buildQueryRequest(entityType, filters, {
      version: this.config.qbxmlVersion,
      iterator: options.iterator,
      iteratorID: options.iteratorID,
    });
    const response = await this.sendRequest(xml);
    const rsType = `${entityType}QueryRs`;

    let entities: Record<string, unknown>[] = [];
    try {
      const data = extractResponseData(response, rsType);
      entities = Array.isArray(data)
        ? data
        : flattenEntityArray(
            data as Record<string, unknown>,
            `${entityType}Ret`
          );
    } catch (err) {
      // extractResponseData throws QBXMLResponseError on hard failure; that
      // bubbles out so tool wrappers translate it (Item 25 path).
      throw err;
    }

    const rs = response.responses.find((r) => r.type === rsType);
    return {
      entities,
      ...(rs?.iteratorRemainingCount !== undefined
        ? { iteratorRemainingCount: rs.iteratorRemainingCount }
        : {}),
      ...(rs?.iteratorID !== undefined ? { iteratorID: rs.iteratorID } : {}),
    };
  }

  /**
   * Cross-type transaction query (TransactionQueryRq). Distinct from queryEntity
   * because TransactionQueryRq is NOT a per-type query — one envelope returns
   * postings from any transaction type (Invoice, Bill, Check, JournalEntry, …)
   * filtered primarily by AccountFilter. Real QB returns one TransactionRet per
   * posting line, with TxnType discriminating which underlying transaction
   * shape produced it.
   *
   * Schema-required filter sequence per QBXML 16.0 SDK:
   *   TxnID? → MaxReturned? → ModifiedDateRangeFilter? → TxnDateRangeFilter? →
   *   EntityFilter? → AccountFilter → RefNumberFilter? → TransactionTypeFilter? →
   *   PostedFilter? → DetailLevel? → IncludeRetElement? → OwnerID?
   * Callers MUST populate the filter dict in this order — buildQueryRequest
   * preserves insertion order (pinned by tests/builder-emit-order.test.ts), so
   * out-of-order keys would surface as the live "found an error when parsing"
   * statusCode -1 class of bug.
   */
  async queryTransactions(
    filters: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>[]> {
    return this.queryEntity("Transaction", filters);
  }

  async addEntity(
    entityType: string,
    data: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    this.assertWritable(`addEntity(${entityType})`);
    const xml = buildAddRequest(entityType, data, this.config.qbxmlVersion);
    const response = await this.sendRequest(xml);
    const respData = extractResponseData(response, `${entityType}AddRs`);
    if (Array.isArray(respData)) return respData[0] ?? {};
    const entities = flattenEntityArray(
      respData as Record<string, unknown>,
      `${entityType}Ret`
    );
    return entities[0] ?? respData;
  }

  /**
   * Idempotent variant of `addEntity` (Phase 10 #47). Wrapping a single create
   * with `idempotencyKey` makes a retry of the same call return the original
   * result instead of duplicating the QB record.
   *
   * Semantics (Stripe-style):
   *   - Miss → execute `addEntity`; on success, cache `{entityType, fingerprint, result}`.
   *   - Hit + same fingerprint → return cached result with `replayed: true`.
   *     No wire I/O, no second QB record, no balance side-effect.
   *   - Hit + different fingerprint → throw `QBIdempotencyKeyConflictError`.
   *     Caller is expected to use a fresh key for new requests.
   *
   * The fingerprint hashes `(entityType, canonicalized(data))` — key order
   * within `data` is normalized so `{Name:"X", Phone:"Y"}` and `{Phone:"Y",
   * Name:"X"}` collide intentionally (they ARE the same request). Array
   * order IS preserved (line[0] vs line[1] are different requests in QB).
   *
   * Failed creates do NOT poison the cache — the key remains unset so the
   * next retry can succeed. This matches the operator's mental model:
   * idempotency protects against accidental duplicates of *successful*
   * writes; failures should be retryable until they succeed (and only then
   * become idempotent).
   *
   * Called BEFORE assertWritable, so a read-only session also rejects with
   * QBReadOnlyError (the gate is in `addEntity`).
   */
  async addEntityIdempotent(
    entityType: string,
    data: Record<string, unknown>,
    idempotencyKey: string
  ): Promise<{ entity: Record<string, unknown>; replayed: boolean }> {
    const fingerprint = fingerprintPayload(entityType, data);
    const cached = this.idempotencyCache.get(idempotencyKey);
    if (cached) {
      if (
        cached.entityType === entityType &&
        cached.payloadFingerprint === fingerprint
      ) {
        return {
          entity: cached.result as Record<string, unknown>,
          replayed: true,
        };
      }
      throw new QBIdempotencyKeyConflictError(idempotencyKey, entityType);
    }
    const entity = await this.addEntity(entityType, data);
    this.cacheIdempotencyResult(idempotencyKey, {
      entityType,
      payloadFingerprint: fingerprint,
      result: entity,
      createdAt: Date.now(),
    });
    return { entity, replayed: false };
  }

  /**
   * Insert a new idempotency cache entry, FIFO-evicting the oldest when over
   * capacity. JS Map iteration order is insertion order, so `keys().next()`
   * reliably returns the oldest key.
   *
   * Mirrors the `addEntityIdempotent` / `executeBatchAddIdempotent` happy
   * path; only those methods should call this. Centralizing the eviction
   * logic here keeps the size invariant in one place.
   */
  private cacheIdempotencyResult(key: string, entry: IdempotencyCacheEntry): void {
    if (
      this.idempotencyCache.size >= QBSessionManager.MAX_IDEMPOTENCY_CACHE_SIZE
    ) {
      const oldest = this.idempotencyCache.keys().next().value;
      if (oldest !== undefined) this.idempotencyCache.delete(oldest);
    }
    this.idempotencyCache.set(key, entry);
  }

  /**
   * Test/diagnostic accessor — current size of the idempotency cache.
   * Production code shouldn't depend on this; eviction-bound tests do.
   */
  idempotencyCacheSize(): number {
    return this.idempotencyCache.size;
  }

  /**
   * Read-only peek at the idempotency cache. Used by composite tools that
   * mutate the source they read (e.g. qb_invoice_write_off closes the source
   * invoice — on a replay the read-then-validate path would reject the
   * second call before addEntityIdempotent gets a chance to fingerprint).
   * Returning the cached entry lets the tool decide what to do (replay, or
   * relax stale-state checks so addEntityIdempotent can be the authority).
   */
  peekIdempotencyEntry(idempotencyKey: string): IdempotencyCacheEntry | undefined {
    return this.idempotencyCache.get(idempotencyKey);
  }

  async modifyEntity(
    entityType: string,
    data: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    this.assertWritable(`modifyEntity(${entityType})`);
    const xml = buildModRequest(entityType, data, this.config.qbxmlVersion);
    const response = await this.sendRequest(xml);
    const respData = extractResponseData(response, `${entityType}ModRs`);
    if (Array.isArray(respData)) return respData[0] ?? {};
    const entities = flattenEntityArray(
      respData as Record<string, unknown>,
      `${entityType}Ret`
    );
    return entities[0] ?? respData;
  }

  /**
   * Batch-add N entities of the same type in a single QBXML envelope under
   * <QBXMLMsgsRq onError="stopOnError">. The envelope carries N <{Type}AddRq>
   * blocks each with a sequential requestID="1".."N"; the response carries
   * one <{Type}AddRs> per request that actually ran (stopOnError halts after
   * the first error, so failures past the first never produce response blocks).
   *
   * Returns positionally-aligned results by mapping the requestID attribute
   * each response carries back to the input index. Indices with no
   * corresponding response are reported as "skipped" (post-stopOnError).
   *
   * Caller is responsible for upfront input validation (per-entry shape) and
   * compensating-rollback semantics. This method just runs the wire I/O and
   * partitions the output by status. Used by Phase 10 #43 (batch JE create);
   * the same pattern reused by #58 (batch invoice/SR) when wired.
   */
  async executeBatchAdd(
    entityType: string,
    entries: Record<string, unknown>[]
  ): Promise<
    Array<
      | {
          requestID: string;
          status: "posted";
          entity: Record<string, unknown>;
        }
      | {
          requestID: string;
          status: "failed";
          statusCode: number;
          statusMessage: string;
        }
      | { requestID: string; status: "skipped" }
    >
  > {
    if (entries.length === 0) return [];
    this.assertWritable(`executeBatchAdd(${entityType}, n=${entries.length})`);

    const rqType = `${entityType}AddRq`;
    const rsType = `${entityType}AddRs`;
    const retName = `${entityType}Ret`;
    const addKey = `${entityType}Add`;

    // Build N request bodies, each with an explicit sequential requestID.
    // Builder would auto-assign these if omitted, but we set them explicitly
    // so the contract between input index and response requestID is unambiguous.
    const requests = entries.map((data, i) => ({
      type: rqType,
      requestID: String(i + 1),
      body: { [addKey]: data },
    }));

    const xml = buildQBXMLRequest({
      version: this.config.qbxmlVersion ?? "16.0",
      requests,
    });
    const response = await this.sendRequest(xml);

    // Initialize positionally-aligned result slots as "skipped". Every input
    // entry gets a slot; responses fill in posted/failed by requestID match.
    type Result =
      | {
          requestID: string;
          status: "posted";
          entity: Record<string, unknown>;
        }
      | {
          requestID: string;
          status: "failed";
          statusCode: number;
          statusMessage: string;
        }
      | { requestID: string; status: "skipped" };
    const results: Result[] = entries.map((_, i) => ({
      requestID: String(i + 1),
      status: "skipped" as const,
    }));

    for (const rs of response.responses) {
      if (rs.type !== rsType) continue;
      const rid = rs.requestID;
      if (rid === undefined) continue;
      const idx = Number(rid) - 1;
      if (idx < 0 || idx >= results.length) continue;

      if (rs.statusCode === 0) {
        // Pull the entity out of the response data block. AddRs returns
        // { {entityType}Ret: <entity> } (single object, not array).
        const data = rs.data as Record<string, unknown>;
        const ret = data[retName];
        const entity = (Array.isArray(ret) ? ret[0] : ret) as
          | Record<string, unknown>
          | undefined;
        results[idx] = {
          requestID: rid,
          status: "posted",
          entity: entity ?? {},
        };
      } else {
        results[idx] = {
          requestID: rid,
          status: "failed",
          statusCode: rs.statusCode,
          statusMessage: rs.statusMessage,
        };
      }
    }

    return results;
  }

  /**
   * Idempotent variant of `executeBatchAdd` (Phase 10 #47). Same semantics as
   * `addEntityIdempotent` but the cached result is the entire batch outcome
   * array (mix of posted/failed/skipped slots). Replay returns the same array
   * verbatim WITHOUT re-running compensating-delete logic — the batch
   * tool's caller is expected to inspect the cached outcome the same way it
   * inspected the original.
   *
   * Cache key fingerprint hashes the FULL entries list — adding/removing/
   * reordering entries makes the request a different request (collides with
   * the conflict-error path). This is safer than fingerprinting per-entry:
   * a partially-overlapping batch with the same key should NOT replay; it's
   * a different operation.
   *
   * IMPORTANT — only fully-successful batches are cached. A partial-failure
   * outcome is NOT cached, by design:
   *   - The batch tool's compensating-delete logic runs AFTER this method
   *     returns. Caching the pre-rollback wire outcome and replaying it
   *     would cause the rollback path to re-attempt deleting TxnIDs that
   *     were already removed by the original call — observable thrash and
   *     a different response shape than the first call.
   *   - On a partial failure, the original rollback either fully succeeded
   *     (system is clean — fresh retry is safe) or orphaned some entries
   *     (already surfaced to the operator with TxnIDs to clean up — the
   *     operator should reconcile before retrying). Caching the pre-rollback
   *     outcome adds no value to either branch.
   *
   * If `executeBatchAdd` itself throws (envelope build error, network mid-
   * flight, QB rejected the entire envelope upfront), the key also remains
   * unset so the next retry can fix the underlying problem.
   */
  async executeBatchAddIdempotent(
    entityType: string,
    entries: Record<string, unknown>[],
    idempotencyKey: string
  ): Promise<{
    results: Array<
      | { requestID: string; status: "posted"; entity: Record<string, unknown> }
      | { requestID: string; status: "failed"; statusCode: number; statusMessage: string }
      | { requestID: string; status: "skipped" }
    >;
    replayed: boolean;
  }> {
    const cacheEntityType = `Batch:${entityType}`;
    const fingerprint = fingerprintPayload(cacheEntityType, entries);
    const cached = this.idempotencyCache.get(idempotencyKey);
    if (cached) {
      if (
        cached.entityType === cacheEntityType &&
        cached.payloadFingerprint === fingerprint
      ) {
        return {
          results: cached.result as Awaited<
            ReturnType<QBSessionManager["executeBatchAdd"]>
          >,
          replayed: true,
        };
      }
      throw new QBIdempotencyKeyConflictError(idempotencyKey, cacheEntityType);
    }
    const results = await this.executeBatchAdd(entityType, entries);
    const allPosted = results.every((r) => r.status === "posted");
    if (allPosted) {
      this.cacheIdempotencyResult(idempotencyKey, {
        entityType: cacheEntityType,
        payloadFingerprint: fingerprint,
        result: results,
        createdAt: Date.now(),
      });
    }
    return { results, replayed: false };
  }

  /**
   * Mark a transaction (or specific line within a split transaction) as
   * Cleared / NotCleared / Pending in QuickBooks. Wraps `ClearedStatusModRq`,
   * the canonical bank-reconciliation primitive — set against bank/credit-card
   * affecting transactions (Check, BillPaymentCheck, BillPaymentCreditCard,
   * Deposit, Transfer, CreditCardCharge, CreditCardCredit), this is how the
   * QB Desktop UI's reconciliation screen actually flips cleared status under
   * the hood.
   *
   * Routed through the typed-mutation pipeline (assertWritable gate applies),
   * so a session opened with `readOnly: true` rejects with `QBReadOnlyError`
   * (statusCode 9001) before any envelope is built. The idempotency cache is
   * intentionally NOT applied here — the operation is naturally idempotent
   * (setting Cleared on a Cleared transaction is a no-op in real QB) and
   * fingerprinting cleared-status mutations would add no value.
   *
   * Live behavior: a stale-state TxnID (deleted since last seen) returns
   * statusCode 500 from QB; a TxnID against a non-bank-affecting transaction
   * returns 3120 (real QB enforces this — JE/Invoice/Bill bodies have no
   * cleared status, only bank-account-touching txns do). Both surface through
   * the existing tool-side error wrapper as structured `isError: true`.
   */
  async updateClearedStatus(
    params: {
      txnId: string;
      clearedStatus: "Cleared" | "NotCleared" | "Pending";
      txnLineId?: string;
    }
  ): Promise<Record<string, unknown>> {
    this.assertWritable(
      `updateClearedStatus(${params.txnId}${params.txnLineId ? `:${params.txnLineId}` : ""})`
    );
    const xml = buildClearedStatusModRequest(params, this.config.qbxmlVersion);
    const response = await this.sendRequest(xml);
    const data = extractResponseData(response, "ClearedStatusModRs");
    const block = (Array.isArray(data) ? data[0] ?? {} : data) as Record<string, unknown>;
    // ClearedStatusModRs wraps a single ClearedStatusRet payload (TxnID,
    // optional TxnLineID, ClearedStatus, TimeModified). Unwrap to match the
    // shape every other typed-mutation helper returns (the inner *Ret block,
    // not the response data envelope).
    const ret = block.ClearedStatusRet;
    if (ret) {
      return (Array.isArray(ret) ? ret[0] : ret) as Record<string, unknown>;
    }
    return block;
  }

  async deleteEntity(
    entityType: string,
    listIdOrTxnId: string
  ): Promise<Record<string, unknown>> {
    this.assertWritable(`deleteEntity(${entityType})`);
    const xml = buildDeleteRequest(entityType, listIdOrTxnId, this.config.qbxmlVersion);
    const response = await this.sendRequest(xml);
    // Kept in sync with buildDeleteRequest's isTransaction list in
    // src/qbxml/builder.ts and isTransactionType in simulation-store.ts —
    // any divergence here mis-routes the response extraction (TxnDelRs vs
    // ListDelRs) and surfaces as "Unknown QBXML error" from the parser.
    const isTransaction = [
      "Invoice", "Bill", "Estimate", "SalesReceipt", "CreditMemo",
      "PurchaseOrder", "JournalEntry", "Deposit", "Transfer", "Check",
      "BillPaymentCheck", "BillPaymentCreditCard", "ReceivePayment",
      "SalesOrder", "CreditCardCharge", "CreditCardCredit",
    ].includes(entityType);
    const rsType = isTransaction ? "TxnDelRs" : "ListDelRs";
    const data = extractResponseData(response, rsType);
    return Array.isArray(data) ? data[0] ?? {} : data;
  }

  // -------------------------------------------------------------------------
  // Host info (Phase 18 #82)
  // -------------------------------------------------------------------------

  /**
   * Return the QB Desktop host info (edition / version / supported QBXML
   * versions / file mode / etc.). First call hits the wire via HostQueryRq;
   * subsequent calls return the cached value until `switchCompanyFile`
   * invalidates it.
   *
   * Pass `{ refresh: true }` to force a fresh round trip — useful after the
   * operator upgrades QB Desktop mid-process (rare, but cheap to support).
   *
   * Ungated by the read-only flag — HostQueryRq is a pure read. Errors from
   * the wire (e.g. QB Desktop crashed since last call) propagate as
   * QBXMLResponseError; the tool wrapper translates to structured isError.
   *
   * Reuses queryEntity("Host", {}) for the envelope — HostQueryRq has no
   * request body, so the generic builder emits exactly the right shape
   * (`<HostQueryRq requestID="1"></HostQueryRq>`). The sim handler is the
   * generic handleQuery path; a Host singleton in the seed satisfies the
   * Map-based store lookup.
   */
  async getHostInfo(options: { refresh?: boolean } = {}): Promise<HostInfo> {
    if (this.hostInfoCache && !options.refresh) return this.hostInfoCache;
    const records = await this.queryEntity("Host", {});
    const raw = (records[0] ?? {}) as Record<string, unknown>;
    this.hostInfoCache = normalizeHostInfo(raw);
    return this.hostInfoCache;
  }

  /**
   * Test/diagnostic accessor — returns the currently-cached HostInfo without
   * triggering a wire call. `null` if `getHostInfo` hasn't been called yet
   * (or was cleared by `switchCompanyFile`). Production code should use
   * `getHostInfo()` instead.
   */
  peekHostInfoCache(): HostInfo | null {
    return this.hostInfoCache;
  }

  // -------------------------------------------------------------------------
  // Report queries
  // -------------------------------------------------------------------------

  /**
   * Run a GeneralSummaryReportQueryRq (P&L / Balance Sheet /
   * SalesByCustomerSummary) and return the extracted ReportRet block. In
   * simulation the store emits the simplified shape (Sections / Totals);
   * live mode dispatches through extractReportData → adaptLiveReportRet's
   * row-tree translator (PnL / BS / flat — see jsdoc).
   *
   * `entityFilter` (Phase 11 #49) narrows the report to a single customer for
   * SalesByCustomerSummary — silently ignored by P&L / BS where the wire-side
   * envelope doesn't carry it.
   */
  async runReport(
    reportType: string,
    params: {
      fromDate?: string;
      toDate?: string;
      basis?: "Accrual" | "Cash";
      entityFilter?: { FullName?: string; ListID?: string };
      itemFilter?: { FullName?: string; ListID?: string };
    } = {}
  ): Promise<Record<string, unknown>> {
    const xml = buildReportRequest(
      { reportType, ...params },
      this.config.qbxmlVersion
    );
    const response = await this.sendRequest(xml);
    return extractReportData(response, "GeneralSummaryReportQueryRs");
  }

  /**
   * Run a CustomDetailReportQueryRq (Phase 11 #56 + #56a) and return the
   * extracted ReportRet block in {Columns, Rows} shape — uniform between
   * live and simulation via extractCustomDetailReportData. Used by the
   * bank-rec read tools (qb_uncleared_transactions,
   * qb_reconciliation_discrepancy) to reach the only QBXML reporting surface
   * that returns ClearedStatus per transaction.
   */
  async runCustomDetailReport(
    params: {
      reportType?: string;
      fromDate?: string;
      toDate?: string;
      account?: { FullName?: string; ListID?: string };
      clearedStatusFilter?: "ClearedOnly" | "UnclearedOnly" | "All";
      fromModifiedDate?: string;
      toModifiedDate?: string;
      basis?: "Accrual" | "Cash";
      includeColumns?: string[];
    } = {}
  ): Promise<Record<string, unknown>> {
    const xml = buildCustomDetailReportRequest(
      params,
      this.config.qbxmlVersion
    );
    const response = await this.sendRequest(xml);
    return extractCustomDetailReportData(response, "CustomDetailReportQueryRs");
  }

  /**
   * Run a GeneralDetailReportQueryRq (Phase 11 #49 SalesByCustomerDetail, plus
   * the planned #50/#52 sales / expense detail variants once their sim
   * handlers land) and return the extracted ReportRet block in {Columns, Rows}
   * shape — uniform between live and simulation via
   * extractGeneralDetailReportData.
   *
   * Distinct from runCustomDetailReport because GeneralDetailReportType is a
   * separate SDK enum from CustomDetailReportType — verified the hard way
   * with #53 where the HANDOFF's "compose on CustomDetailReport" suggestion
   * would have failed live with statusCode 3120. See DECISIONS.md
   * 2026-05-10.
   */
  /**
   * Run a PayrollSummaryReportQueryRq (Phase 11 #55 — qb_w2_summary). Wraps
   * the wire surface end-to-end: builds the envelope via
   * buildPayrollSummaryReportRequest, sends it, returns the extracted ReportRet
   * via the same extractReportData path P&L / BS / SCF go through (which
   * routes live ReportData row trees through adaptLiveReportRet — for the
   * payroll report variant the live shape has not been pinned yet, so live
   * mode is verified-by-construction; sim mode emits the simplified shape
   * directly via handlePayrollSummaryReportQuery).
   *
   * Distinct from runReport: payroll reports are inherently cash-basis (no
   * `basis` arg) and use a different report-type discriminator. Tool layer
   * (qb_w2_summary) is responsible for edition gating + W-2 box mapping.
   */
  async runPayrollSummaryReport(
    params: {
      reportType: string;
      fromDate?: string;
      toDate?: string;
      entityFilter?: { FullName?: string; ListID?: string };
    }
  ): Promise<Record<string, unknown>> {
    const xml = buildPayrollSummaryReportRequest(
      params,
      this.config.qbxmlVersion
    );
    const response = await this.sendRequest(xml);
    return extractReportData(response, "PayrollSummaryReportQueryRs");
  }

  async runGeneralDetailReport(
    params: {
      reportType: string;
      fromDate?: string;
      toDate?: string;
      account?: { FullName?: string; ListID?: string };
      entityFilter?: { FullName?: string; ListID?: string };
      itemFilter?: { FullName?: string; ListID?: string };
      fromModifiedDate?: string;
      toModifiedDate?: string;
      basis?: "Accrual" | "Cash";
      includeColumns?: string[];
    }
  ): Promise<Record<string, unknown>> {
    const xml = buildGeneralDetailReportRequest(
      params,
      this.config.qbxmlVersion
    );
    const response = await this.sendRequest(xml);
    return extractGeneralDetailReportData(response, "GeneralDetailReportQueryRs");
  }
}
