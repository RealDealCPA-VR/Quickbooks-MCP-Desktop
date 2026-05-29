/**
 * QuickBooks Desktop process launch helpers (Phase 19 #90).
 *
 * Owns two responsibilities the `qb_company_open` tool's `launchIfClosed`
 * flag needs:
 *   1. Locate the QB Desktop executable (`qbw.exe` / `qbw32.exe`) via a
 *      fallback chain: explicit `QB_DESKTOP_EXE` env var → Windows registry
 *      (HKLM\SOFTWARE\Intuit\QuickBooks*\InstallPath) → a small list of
 *      known Program Files paths.
 *   2. Classify a `BeginSession` failure into one of three buckets the
 *      switchCompanyFile orchestrator needs to branch on:
 *        - "file-not-loaded"   → launch attempt should proceed
 *        - "file-conflict"     → fail fast with statusCode 9007 (a different
 *                                .qbw is open in QB Desktop and we cannot
 *                                swap without UI automation; design Q (b)
 *                                resolved by the operator on 2026-05-28
 *                                — see DECISIONS.md 2026-05-28)
 *        - "multi-user-lock"   → fail fast with statusCode 9008 (multi-user
 *                                lock on a network share; design Q (c))
 *        - "unknown"           → bubble up unchanged
 *
 * Pure module — no I/O at import time. The exe detector takes its
 * environment + filesystem + registry probe as injected dependencies so
 * tests can drive every branch without a real Windows install. Default
 * implementations of those probes live at the bottom of the file and are
 * the ones wired up in the session manager.
 *
 * Design notes:
 *   - Why a fallback chain and not just the env var? The env-var-only path
 *     puts setup friction on the buyer; the registry-only path has no
 *     escape hatch when QB is installed under a non-default ProgramData
 *     path. The chain is one extra ~10ms of cold-path work; cheap insurance.
 *   - The known-paths list is intentionally short (modern QB versions
 *     2022-2025). Older versions get the env-var override; older lists are
 *     not maintained because the operator base is recent. Don't add a path
 *     here without verifying the actual exe name on that install — older
 *     QB shipped `QBW32.exe` (capitalized) which Windows resolves case-
 *     insensitively, so the lowercase form below covers both.
 *   - File-conflict and multi-user-lock patterns are checked BEFORE
 *     file-not-loaded (specificity-first) so a multi-user error that
 *     incidentally contains the substring "not open" doesn't misclassify.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Exe detection
// ---------------------------------------------------------------------------

/**
 * Known QB Desktop install paths under the standard Program Files trees.
 * Last-resort fallback when the env var override is unset AND the registry
 * lookup fails (or returns a path whose exe doesn't exist on disk).
 *
 * Frozen so the order is stable for tests. The order itself encodes a
 * preference: 32-bit QB (still the dominant build) under `Program Files
 * (x86)`, then 64-bit QB under `Program Files`. The `quickbooks-desktop-mcp-doctor`
 * (#91) will surface which path matched so the operator can confirm.
 */
export const KNOWN_QB_DESKTOP_PATHS: readonly string[] = Object.freeze([
  "C:\\Program Files (x86)\\Intuit\\QuickBooks\\qbw32.exe",
  "C:\\Program Files (x86)\\Intuit\\QuickBooks 2024\\qbw32.exe",
  "C:\\Program Files (x86)\\Intuit\\QuickBooks 2023\\qbw32.exe",
  "C:\\Program Files (x86)\\Intuit\\QuickBooks 2022\\qbw32.exe",
  "C:\\Program Files (x86)\\Intuit\\QuickBooks Enterprise Solutions 24.0\\qbw32.exe",
  "C:\\Program Files (x86)\\Intuit\\QuickBooks Enterprise Solutions 23.0\\qbw32.exe",
  "C:\\Program Files\\Intuit\\QuickBooks\\qbw.exe",
  "C:\\Program Files\\Intuit\\QuickBooks 2024\\qbw.exe",
  "C:\\Program Files\\Intuit\\QuickBooks 2023\\qbw.exe",
]);

/**
 * Source attribution for a successful exe lookup. Surfaced in the
 * `qb_company_open` response so the operator can see which branch of the
 * fallback chain actually resolved.
 */
export type QBExeSource = "env" | "registry" | "fallback";

export interface QBExeResolution {
  exe: string;
  source: QBExeSource;
}

/**
 * Injectable dependencies for `resolveQBDesktopExe`. The real implementation
 * uses `process.env.QB_DESKTOP_EXE` / `existsSync` / `defaultRegistryQuery`;
 * tests substitute deterministic fakes to drive every branch without
 * touching the real Windows registry or filesystem.
 */
export interface QBExeResolver {
  envExe?: string;
  fileExists: (p: string) => boolean;
  registryQuery: () => string | null;
}

/**
 * Walk the fallback chain and return the first exe that actually exists on
 * disk. `null` means none of the three branches resolved — callers should
 * surface a 9007 "no executable found" error with the QB_DESKTOP_EXE hint.
 *
 * The env path is validated via `fileExists` so a stale override (the
 * operator uninstalled QB but forgot to unset the var) doesn't silently
 * blow up `spawn` later — we fall through to the next branch instead.
 */
export function resolveQBDesktopExe(resolver: QBExeResolver): QBExeResolution | null {
  if (resolver.envExe && resolver.envExe.trim().length > 0) {
    if (resolver.fileExists(resolver.envExe)) {
      return { exe: resolver.envExe, source: "env" };
    }
  }
  const fromRegistry = resolver.registryQuery();
  if (fromRegistry && resolver.fileExists(fromRegistry)) {
    return { exe: fromRegistry, source: "registry" };
  }
  for (const candidate of KNOWN_QB_DESKTOP_PATHS) {
    if (resolver.fileExists(candidate)) {
      return { exe: candidate, source: "fallback" };
    }
  }
  return null;
}

/**
 * Default `registryQuery` impl. Spawns `reg query` (always present on Windows
 * since at least XP) and parses the `InstallPath` value out of every matching
 * subkey under `HKLM\SOFTWARE\Intuit\QuickBooks`. Returns a candidate exe path
 * built by joining `InstallPath` + the conventional exe name, or null on any
 * failure (non-Windows, reg.exe not available, no matching key, malformed
 * output).
 *
 * `reg query ... /s` recurses under the QuickBooks subkey to surface the
 * versioned subkeys (`QB23`, `QB24`, etc.) where Intuit actually writes
 * InstallPath. The last match wins so we prefer the newest install on a
 * machine with multiple QB versions side-by-side.
 *
 * Returns `null` (not throws) on any failure — the caller's fallback chain
 * is the recovery path.
 */
export function defaultRegistryQuery(): string | null {
  if (process.platform !== "win32") return null;
  let out: string;
  try {
    out = execFileSync(
      "reg",
      ["query", "HKLM\\SOFTWARE\\Intuit\\QuickBooks", "/v", "InstallPath", "/s"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
        windowsHide: true,
      }
    );
  } catch {
    return null;
  }
  return parseRegistryQuery(out);
}

/**
 * Pull the last `InstallPath` REG_SZ value out of a `reg query /s` dump.
 * Exported for testing — covers every parser branch without spawning reg.exe.
 *
 * Sample input shape:
 *   HKEY_LOCAL_MACHINE\SOFTWARE\Intuit\QuickBooks\QB24
 *       InstallPath    REG_SZ    C:\Program Files (x86)\Intuit\QuickBooks 2024\
 *
 * The trailing backslash on InstallPath is normalized before joining the
 * conventional exe name. We try qbw32.exe first (32-bit QB, the common
 * build); the caller's `fileExists` check eliminates a stale guess.
 */
export function parseRegistryQuery(regOutput: string): string | null {
  const matches = Array.from(
    regOutput.matchAll(/InstallPath\s+REG_SZ\s+(.+?)\s*(?:\r?\n|$)/gi)
  );
  if (matches.length === 0) return null;
  const installPath = matches[matches.length - 1][1].trim();
  if (installPath.length === 0) return null;
  return path.join(installPath, "qbw32.exe");
}

// ---------------------------------------------------------------------------
// BeginSession error classification
// ---------------------------------------------------------------------------

/**
 * Discriminant returned by `classifyBeginSessionError`. The order of the
 * union mirrors the precedence used by the classifier: more-specific
 * patterns are checked first so a multi-user-lock error that happens to
 * contain the substring "not open" doesn't misclassify as file-not-loaded.
 */
export type BeginSessionErrorClass =
  | "file-conflict"
  | "multi-user-lock"
  | "file-not-loaded"
  | "unknown";

/**
 * Substrings that signal QB Desktop has a DIFFERENT company file open
 * (auto-resolution impossible — caller must surface 9007).
 *
 * Patterns sourced from observed BeginSession failure messages across
 * QBXMLRP2 versions; all matched case-insensitively. Add new patterns only
 * after seeing them in the wild on a real QB box — speculative patterns
 * risk misclassifying a generic "not loaded" error as a hard conflict.
 */
const FILE_CONFLICT_PATTERNS: readonly RegExp[] = Object.freeze([
  /different\s+(?:company\s+)?file/i,
  /already\s+(?:open|loaded)\s+with\s+a\s+different/i,
  /not\s+the\s+same\s+as\s+the\s+(?:file|company)\s+currently/i,
  /different\s+\.qbw/i,
]);

/**
 * Substrings that signal the .qbw is held by another user in multi-user
 * mode (caller must surface 9008; retry is not useful here).
 */
const MULTI_USER_LOCK_PATTERNS: readonly RegExp[] = Object.freeze([
  /in\s+use\s+by\s+another\s+user/i,
  /multi[\s-]?user\s+mode/i,
  /file\s+is\s+(?:already\s+)?locked/i,
  /currently\s+(?:in\s+use|being\s+used)/i,
  /another\s+user\s+is\s+logged\s+in/i,
]);

/**
 * Substrings that signal QB Desktop has no file loaded (or isn't running
 * at all). Caller can attempt to launch QB Desktop with the target file
 * as a process argument and poll for attach.
 */
const FILE_NOT_LOADED_PATTERNS: readonly RegExp[] = Object.freeze([
  /file\s+is\s+not\s+(?:loaded|open|running)/i,
  /no\s+(?:company\s+)?file\s+is\s+(?:open|loaded)/i,
  /quickbooks\s+is\s+not\s+running/i,
  /company\s+file\s+not\s+(?:open|loaded|found)/i,
  /no\s+such\s+(?:interface|object)/i,
  /0x80040420/i,
  /0x80040402/i,
]);

/**
 * Classify a BeginSession / OpenConnection2 error message into one of the
 * four buckets `switchCompanyFile` branches on. Conservative by design —
 * an unrecognized message returns "unknown" rather than guessing, which
 * keeps the existing error-passthrough behavior unchanged for any pattern
 * we haven't observed yet.
 *
 * Precedence: file-conflict → multi-user-lock → file-not-loaded → unknown.
 * The first two are checked first because they're more specific; a
 * mis-classification in either direction is materially worse than
 * returning "unknown" (which falls through to the existing error path).
 */
export function classifyBeginSessionError(message: string): BeginSessionErrorClass {
  if (!message) return "unknown";
  if (FILE_CONFLICT_PATTERNS.some((p) => p.test(message))) return "file-conflict";
  if (MULTI_USER_LOCK_PATTERNS.some((p) => p.test(message))) return "multi-user-lock";
  if (FILE_NOT_LOADED_PATTERNS.some((p) => p.test(message))) return "file-not-loaded";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Spawn primitive
// ---------------------------------------------------------------------------

/**
 * Polling schedule between launch + retry openSession attempts. Five tiers
 * summing to 30000ms (1s + 2s + 4s + 8s + 15s) — exponential at the head
 * (fast catch when QB starts quickly on a warm machine) with a long final
 * tier so a slow cold start on a heavily-loaded machine still has a chance.
 * Frozen so tests can assert against the canonical schedule.
 *
 * Total wall budget: 30s. The handoff spec gave "up to ~30s" as the target
 * (a typical QB Desktop cold start is 8-15s; warm restart 2-5s).
 *
 * Tuning rationale: a single short-budget retry (e.g. 5s) misses cold-start
 * machines. A flat 30s sleep wastes time on warm restarts that finish in
 * 2s. The exponential head + long tail gets the best of both.
 */
export const QB_LAUNCH_POLL_MS: readonly number[] = Object.freeze([1000, 2000, 4000, 8000, 15000]);

/**
 * Default implementation of the spawn primitive. Uses `spawn` with
 * `detached: true` + `unref` so QB Desktop survives the Node process
 * exit — the operator's MCP host should be able to terminate without
 * killing QB Desktop along with it. `stdio: "ignore"` keeps QB Desktop's
 * dialog output from leaking into the MCP host's stdout stream (which
 * would corrupt the JSON-RPC wire).
 *
 * Throws synchronously if `spawn` itself fails (exe not found, permission
 * denied, etc.); the caller wraps that into a `QBLaunchError`.
 */
export function defaultLaunchQBDesktop(exe: string, companyFile: string): void {
  const child = spawn(exe, [companyFile], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
}

/**
 * Default `fileExists` impl — uses `node:fs.existsSync`. Pure synchronous
 * check, no caching. Tests inject a deterministic fake.
 */
export function defaultFileExists(p: string): boolean {
  return existsSync(p);
}
