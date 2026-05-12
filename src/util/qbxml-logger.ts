/**
 * Persistent QBXML wire logger (Phase 18 #83).
 *
 * When `QB_DEBUG_QBXML=1` is set in the environment, the session manager's
 * `sendRequest` chokepoint emits every outbound QBXML envelope and the raw
 * inbound response to a rotating per-day file. Built to diagnose the
 * schema-order class of bug that surfaces live as
 * `statusCode -1 — "QuickBooks found an error when parsing the provided XML
 * text stream"` — the wire envelope is the only useful artifact and was
 * previously only reachable by adding `console.error` and rebuilding.
 *
 * Behavior:
 *   - `QB_DEBUG_QBXML=1`             → enabled; default log dir is `./logs`.
 *   - `QB_DEBUG_LOG_PATH=<dir>`      → write `qbxml-YYYYMMDD.log` into `<dir>`.
 *   - Any other value of QB_DEBUG_QBXML (unset, "0", "true", "yes", …) → disabled.
 *   - Writes are synchronous (appendFileSync) so a request that crashes after
 *     send still leaves its envelope on disk.
 *   - Sensitive fields (vendor TIN, SSN, bank account number, credit card
 *     number) are redacted by tag-regex before write.
 *   - First write failure (disk full, permission, …) is reported to stderr
 *     and disables the logger for the rest of the process; subsequent calls
 *     are no-ops. Never poisons the request flow.
 *
 * Both modes log:
 *   - Live: response is raw XML string returned by QBXMLRP2.ProcessRequest.
 *   - Simulation: response is the parsed QBXMLResponse JSON-stringified.
 *     Sim doesn't produce raw XML, but the parsed shape is what every caller
 *     actually consumes and is sufficient for debugging sim-side behavior
 *     and test-fixture schema-order issues.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface QbxmlLoggerOptions {
  /** Directory where date-stamped log files are written. */
  logDir: string;
}

/**
 * QBXML field names whose values are personally-identifying credentials and
 * MUST be redacted before being written to the on-disk debug log. The regex
 * matches only non-empty values (empty tags are left alone — nothing to
 * redact). Listed conservatively: this is the set the operator's books
 * actually contain today (VendorTaxIdent for 1099 vendors, SSN for
 * employees) plus the two payment-credential fields the QBXML SDK exposes
 * even though they're uncommon in this codebase.
 *
 * Adding a new tag: append it here, then add an assertion in the redaction
 * test in tests/qbxml-logger.test.ts to pin the new coverage.
 */
const SENSITIVE_TAGS = [
  "VendorTaxIdent",
  "SSN",
  "BankAccountNumber",
  "CreditCardNumber",
];

const REDACTION_REGEXES = SENSITIVE_TAGS.map(
  (tag) => new RegExp(`(<${tag}>)([^<]+)(</${tag}>)`, "g")
);

/**
 * Apply tag-based redaction to a QBXML string. Returns the input unchanged if
 * no sensitive tags are present. Exported for unit testing without going
 * through the file-system path.
 */
export function redactSensitive(text: string): string {
  let out = text;
  for (const re of REDACTION_REGEXES) {
    out = out.replace(re, "$1[REDACTED]$3");
  }
  return out;
}

export class QbxmlLogger {
  private options: QbxmlLoggerOptions;
  /**
   * Per-process monotonic sequence number paired across a request/response
   * cycle. `mode=live seq=42 op=request` and `mode=live seq=42 op=response`
   * are the same in-flight call, so a concurrent reader can pair them
   * unambiguously even if envelopes interleave (rare, but possible if a
   * future tool wires async parallel sub-requests).
   */
  private seq: number = 0;
  /**
   * Cached current log file path. Re-computed when the YYYYMMDD date string
   * changes (midnight rollover) so a long-running process correctly rotates
   * without a restart.
   */
  private currentDate: string = "";
  private currentPath: string = "";
  /**
   * Latched on first write failure (disk full, permission, etc.). All
   * subsequent log calls no-op. Prevents a logging fault from cascading
   * into a request-processing fault.
   */
  private disabled: boolean = false;

  constructor(options: QbxmlLoggerOptions) {
    this.options = options;
  }

  /**
   * Resolved directory the logger writes into. Surfaced for the startup
   * banner in src/index.ts so the operator knows where the log went.
   */
  getLogDir(): string {
    return this.options.logDir;
  }

  /**
   * Allocate a sequence number for a new request and write its envelope to
   * the log. Returns the seq + start timestamp so the matching response can
   * be paired and timed.
   */
  logRequest(qbxml: string, mode: "live" | "simulation"): { seq: number; startedAt: number } {
    const startedAt = Date.now();
    const seq = ++this.seq;
    if (this.disabled) return { seq, startedAt };
    this.write(this.formatHeader(startedAt, mode, seq, "request"), qbxml);
    return { seq, startedAt };
  }

  /**
   * Log a response paired to a prior `logRequest` call. `body` is the raw
   * response XML in live mode or any JSON-serializable value (typically the
   * parsed QBXMLResponse) in sim mode.
   */
  logResponse(
    body: string | unknown,
    mode: "live" | "simulation",
    marker: { seq: number; startedAt: number }
  ): void {
    if (this.disabled) return;
    const ts = Date.now();
    const durationMs = ts - marker.startedAt;
    const text =
      typeof body === "string" ? body : JSON.stringify(body, null, 2);
    this.write(
      this.formatHeader(ts, mode, marker.seq, "response", { durationMs }),
      text
    );
  }

  /**
   * Log an error thrown during request execution (live network failure, parse
   * throw, etc.). Pairs to the prior logRequest by seq + startedAt so the
   * failure appears in-line with its envelope.
   */
  logError(
    err: unknown,
    mode: "live" | "simulation",
    marker: { seq: number; startedAt: number }
  ): void {
    if (this.disabled) return;
    const ts = Date.now();
    const durationMs = ts - marker.startedAt;
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    this.write(
      this.formatHeader(ts, mode, marker.seq, "error", { durationMs }),
      msg
    );
  }

  private formatHeader(
    ts: number,
    mode: string,
    seq: number,
    op: string,
    extras: Record<string, string | number> = {}
  ): string {
    const iso = new Date(ts).toISOString();
    const tail = Object.entries(extras)
      .map(([k, v]) => ` ${k}=${v}`)
      .join("");
    return `=== ${iso} mode=${mode} seq=${seq} op=${op}${tail} ===`;
  }

  private write(header: string, body: string): void {
    const path = this.resolveCurrentPath();
    if (path === null) return;
    const redacted = redactSensitive(body);
    const block = `${header}\n${redacted}\n\n`;
    try {
      appendFileSync(path, block, "utf8");
    } catch (err) {
      console.error(
        `[QbxmlLogger] Write to ${path} failed (${(err as Error).message}); ` +
        "disabling logger for the rest of the process."
      );
      this.disabled = true;
    }
  }

  /**
   * Compute (and cache) the current log file path. Resolves the date-stamped
   * filename and lazily mkdirs the parent directory. On mkdir failure latches
   * `disabled=true` and returns null so the write call no-ops.
   */
  private resolveCurrentPath(): string | null {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    if (date === this.currentDate && this.currentPath) {
      return this.currentPath;
    }
    const path = join(this.options.logDir, `qbxml-${date}.log`);
    const dir = dirname(path);
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (err) {
        console.error(
          `[QbxmlLogger] mkdir ${dir} failed (${(err as Error).message}); ` +
          "disabling logger for the rest of the process."
        );
        this.disabled = true;
        return null;
      }
    }
    this.currentDate = date;
    this.currentPath = path;
    return path;
  }
}

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------

let cachedLogger: QbxmlLogger | null = null;
let cacheInitialized = false;

/**
 * Resolve the process-wide debug logger from environment variables. Returns
 * null when `QB_DEBUG_QBXML !== "1"`. Cached after the first call so the env
 * var is read exactly once per process — `resetQbxmlLogger()` re-arms it for
 * tests.
 *
 * Production callers pass no argument; tests pass an explicit env object.
 */
export function getQbxmlLogger(env: NodeJS.ProcessEnv = process.env): QbxmlLogger | null {
  if (cacheInitialized) return cachedLogger;
  cacheInitialized = true;
  if (env.QB_DEBUG_QBXML !== "1") {
    cachedLogger = null;
    return null;
  }
  const logDir = env.QB_DEBUG_LOG_PATH ?? resolve(process.cwd(), "logs");
  cachedLogger = new QbxmlLogger({ logDir });
  return cachedLogger;
}

/**
 * Test-only reset. After calling this, the next `getQbxmlLogger()` re-reads
 * env vars and constructs a fresh logger (or returns null). Production code
 * should never call this — there's no use case for switching the logger
 * mid-process.
 */
export function resetQbxmlLogger(): void {
  cachedLogger = null;
  cacheInitialized = false;
}
