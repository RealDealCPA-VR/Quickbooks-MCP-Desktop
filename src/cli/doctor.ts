#!/usr/bin/env node

/**
 * `quickbooks-desktop-mcp-doctor` — setup diagnostic CLI (Phase 19 #91).
 *
 * Probes the seven things that account for ~80% of live-mode setup failures
 * and prints a `✓ / ✗ / ⚠` line per probe with a one-line remediation hint on
 * every failure. Exit-code contract (same shape a linter / test runner uses,
 * so CI can gate on it):
 *
 *   0 — all probes green
 *   1 — at least one probe failed (a real, operator-fixable problem)
 *   2 — at least one probe could not run (and none failed) — typically a
 *       non-Windows box where the Windows-only probes are inconclusive
 *
 * Precedence: a `fail` outranks a `skip`, so a box with both a hard failure
 * and an inconclusive probe exits 1 (the actionable signal wins).
 *
 * Design — testability:
 *   The whole probe surface is a pure function (`runDoctor`) over an injected
 *   `DoctorDeps` bag. Every environmental fact (Node version, platform, env
 *   vars, filesystem, registry, COM registration, winax load status) is a
 *   field or a thunk on that bag, so tests drive every branch deterministically
 *   without a real Windows + QB install. `main()` is the only impure part: it
 *   wires the real probes, prints, and sets the exit code. Same test-seam
 *   pattern as `makeFakeLiveManager` (#90) and the launch helpers it reuses.
 *
 * Design — reuse:
 *   The "QuickBooks Desktop installed" probe composes #90's exe-detection
 *   chain (`resolveQBDesktopExe` + `defaultRegistryQuery` + `defaultFileExists`)
 *   rather than reimplementing it, and surfaces BOTH the resolved exe path and
 *   the source branch (`env` / `registry` / `fallback`) so the operator can
 *   confirm which path the runtime will actually fire at launch time.
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import {
  defaultFileExists,
  defaultRegistryQuery,
  resolveQBDesktopExe,
} from "../util/qb-desktop-launch.js";

// ---------------------------------------------------------------------------
// Probe result model
// ---------------------------------------------------------------------------

/**
 * `ok` → ✓ (green). `fail` → ✗ (operator-fixable problem; carries a
 * remediation). `skip` → ⚠ (probe was inconclusive / not applicable on this
 * platform — contributes to exit 2 but is not itself a failure).
 */
export type ProbeStatus = "ok" | "fail" | "skip";

export interface ProbeResult {
  /** Short label shown in the report column. */
  name: string;
  status: ProbeStatus;
  /** One-line description of what was found (shown after the symbol). */
  detail: string;
  /** One-line fix, shown indented under a `✗`. Only set when status is `fail`. */
  remediation?: string;
}

export interface DoctorReport {
  probes: ProbeResult[];
  exitCode: 0 | 1 | 2;
}

/**
 * Injected probe inputs. Raw environmental facts plus the side-effecting
 * primitives (filesystem / registry / COM / winax) the Windows-only probes
 * need. `main()` supplies the real implementations via `buildDefaultDeps()`.
 */
export interface DoctorDeps {
  /** `process.versions.node`, e.g. "20.20.2". */
  nodeVersion: string;
  /** `process.platform`, e.g. "win32" / "darwin" / "linux". */
  platform: string;
  /** `process.arch`, e.g. "x64" / "ia32". */
  arch: string;
  /** Environment variables (read-only snapshot). */
  env: Record<string, string | undefined>;
  /** Synchronous file existence check (defaults to `node:fs.existsSync`). */
  fileExists: (p: string) => boolean;
  /** QB registry probe — returns a candidate exe path or null (see #90). */
  registryQuery: () => string | null;
  /**
   * Whether the QBXMLRP2 COM component is registered. `null` means the probe
   * could not run (non-Windows, or `reg.exe` unavailable) → reported as skip.
   */
  comRegistered: () => boolean | null;
  /**
   * winax (live-mode COM bridge) load status. `null` means not applicable
   * (non-Windows) → reported as skip.
   */
  winaxStatus: () => "ok" | "missing" | "abi-mismatch" | null;
}

// ---------------------------------------------------------------------------
// Individual probes — each pure over its slice of DoctorDeps
// ---------------------------------------------------------------------------

/**
 * winax 3.4.2 ships prebuilt binaries for Node 20.x; the system PATH Node 22+
 * breaks the native load (documented gotcha). We treat exactly major 20 as
 * the supported line — anything else is flagged so the operator switches Node
 * before chasing phantom COM errors.
 */
export function probeNodeVersion(deps: Pick<DoctorDeps, "nodeVersion">): ProbeResult {
  const name = "Node version";
  const major = Number.parseInt(deps.nodeVersion.split(".")[0] ?? "", 10);
  if (Number.isNaN(major)) {
    return {
      name,
      status: "skip",
      detail: `could not parse Node version "${deps.nodeVersion}"`,
    };
  }
  if (major === 20) {
    return { name, status: "ok", detail: `Node v${deps.nodeVersion} (winax-compatible)` };
  }
  return {
    name,
    status: "fail",
    detail: `Node v${deps.nodeVersion} — winax (live-mode COM bridge) needs Node 20.x`,
    remediation:
      "Install Node 20.x (e.g. nvm-windows: `nvm install 20.20.2 && nvm use 20.20.2`). Node 22+ breaks the winax native load.",
  };
}

/**
 * Live mode is Windows-only (QBXMLRP2 is a Windows COM server). On any other
 * platform the server still runs in simulation mode, so this is a `skip`
 * (inconclusive for live readiness), not a `fail`.
 */
export function probePlatform(deps: Pick<DoctorDeps, "platform" | "arch">): ProbeResult {
  const name = "Platform";
  if (deps.platform === "win32") {
    return { name, status: "ok", detail: `Windows (win32, ${deps.arch})` };
  }
  return {
    name,
    status: "skip",
    detail: `${deps.platform} — live mode requires Windows; this platform runs simulation mode only`,
  };
}

/**
 * Reuses #90's exe-detection chain and surfaces the resolved path + source so
 * the operator sees exactly which branch (env / registry / fallback) the
 * runtime will fire at launch time.
 */
export function probeQBInstall(
  deps: Pick<DoctorDeps, "platform" | "env" | "fileExists" | "registryQuery">,
): ProbeResult {
  const name = "QuickBooks Desktop";
  if (deps.platform !== "win32") {
    return { name, status: "skip", detail: "non-Windows — cannot probe QB Desktop install" };
  }
  const resolved = resolveQBDesktopExe({
    envExe: deps.env.QB_DESKTOP_EXE,
    fileExists: deps.fileExists,
    registryQuery: deps.registryQuery,
  });
  if (resolved) {
    return {
      name,
      status: "ok",
      detail: `${resolved.exe} (source: ${resolved.source})`,
    };
  }
  return {
    name,
    status: "fail",
    detail: "no QuickBooks Desktop executable found (env → registry → known paths)",
    remediation:
      "Install QuickBooks Desktop, or set QB_DESKTOP_EXE to the full path of qbw32.exe / qbw.exe if installed in a non-standard location.",
  };
}

/**
 * QBXMLRP2.RequestProcessor is the COM ProgID the live-mode manager attaches
 * to. If it isn't registered, every live call fails before it starts.
 */
export function probeComRegistration(
  deps: Pick<DoctorDeps, "platform" | "comRegistered">,
): ProbeResult {
  const name = "QBXMLRP2 COM";
  if (deps.platform !== "win32") {
    return { name, status: "skip", detail: "non-Windows — COM registration not applicable" };
  }
  const registered = deps.comRegistered();
  if (registered === null) {
    return { name, status: "skip", detail: "could not query the registry (reg.exe unavailable?)" };
  }
  if (registered) {
    return { name, status: "ok", detail: "QBXMLRP2.RequestProcessor is registered" };
  }
  return {
    name,
    status: "fail",
    detail: "QBXMLRP2.RequestProcessor is not registered",
    remediation:
      "Repair/reinstall QuickBooks Desktop (it registers the QBXMLRP2 SDK), then launch QB at least once. Re-register manually with `regsvr32 QBXMLRP2.dll` if needed.",
  };
}

/**
 * QB_COMPANY_FILE is the headline live-mode setting — the wrong/missing path
 * is the single most common setup failure, so unset is a hard `fail` even
 * though simulation mode can run without it (the remediation says so).
 */
export function probeCompanyFile(
  deps: Pick<DoctorDeps, "env" | "fileExists">,
): ProbeResult {
  const name = "QB_COMPANY_FILE";
  const value = deps.env.QB_COMPANY_FILE;
  if (!value || value.trim().length === 0) {
    return {
      name,
      status: "fail",
      detail: "not set",
      remediation:
        "Set QB_COMPANY_FILE to the absolute path of your .qbw company file. (Required for live mode; simulation mode runs without it.)",
    };
  }
  if (!deps.fileExists(value)) {
    return {
      name,
      status: "fail",
      detail: `set, but the file does not exist: ${value}`,
      remediation:
        "Fix QB_COMPANY_FILE — the path does not exist. Use the full path to the .qbw, with the correct drive and folder.",
    };
  }
  return { name, status: "ok", detail: value };
}

/**
 * QB_COMPANY_ROOT is optional — it defaults to the directory of
 * QB_COMPANY_FILE — so unset is a valid `ok` state, not a failure. Only a set-
 * but-missing directory is a problem.
 */
export function probeCompanyRoot(
  deps: Pick<DoctorDeps, "env" | "fileExists">,
): ProbeResult {
  const name = "QB_COMPANY_ROOT";
  const value = deps.env.QB_COMPANY_ROOT;
  if (!value || value.trim().length === 0) {
    return {
      name,
      status: "ok",
      detail: "unset — defaults to the directory of QB_COMPANY_FILE",
    };
  }
  if (!deps.fileExists(value)) {
    return {
      name,
      status: "fail",
      detail: `set, but the directory does not exist: ${value}`,
      remediation:
        "Fix QB_COMPANY_ROOT — it must point to an existing folder that contains your .qbw files (used by qb_company_list).",
    };
  }
  return { name, status: "ok", detail: value };
}

/**
 * winax is the optional native dependency that bridges to COM in live mode.
 * Non-Windows installs skip it cleanly (it's in optionalDependencies), so this
 * is `skip` off-Windows. On Windows: missing or ABI-mismatched is a `fail`.
 */
export function probeWinax(deps: Pick<DoctorDeps, "platform" | "winaxStatus">): ProbeResult {
  const name = "winax";
  if (deps.platform !== "win32") {
    return { name, status: "skip", detail: "non-Windows — winax not needed (simulation mode)" };
  }
  const status = deps.winaxStatus();
  if (status === null) {
    return { name, status: "skip", detail: "could not determine winax status" };
  }
  if (status === "ok") {
    return { name, status: "ok", detail: "installed and loadable against the current Node" };
  }
  if (status === "missing") {
    return {
      name,
      status: "fail",
      detail: "not installed",
      remediation:
        "Install it (Windows only): `npm install winax`. It's an optional dependency, so a non-Windows install skips it on purpose.",
    };
  }
  return {
    name,
    status: "fail",
    detail: "installed but fails to load (built against a different Node version)",
    remediation:
      "Rebuild against your current Node: `npm rebuild winax` (use Node 20.x — see the Node version probe).",
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run all seven probes and compute the exit code. Pure over `deps` — no I/O,
 * no `process.exit`. `main()` handles printing + exiting.
 */
export function runDoctor(deps: DoctorDeps): DoctorReport {
  const probes: ProbeResult[] = [
    probeNodeVersion(deps),
    probePlatform(deps),
    probeQBInstall(deps),
    probeComRegistration(deps),
    probeCompanyFile(deps),
    probeCompanyRoot(deps),
    probeWinax(deps),
  ];
  const anyFail = probes.some((p) => p.status === "fail");
  const anySkip = probes.some((p) => p.status === "skip");
  const exitCode: 0 | 1 | 2 = anyFail ? 1 : anySkip ? 2 : 0;
  return { probes, exitCode };
}

const SYMBOL: Record<ProbeStatus, string> = { ok: "✓", fail: "✗", skip: "⚠" };

/** Render a report to an array of lines (testable without touching stdout). */
export function formatReport(report: DoctorReport): string[] {
  const lines: string[] = [];
  lines.push("QuickBooks Desktop MCP — doctor");
  lines.push("");
  const labelWidth = Math.max(...report.probes.map((p) => p.name.length));
  for (const probe of report.probes) {
    const label = probe.name.padEnd(labelWidth);
    lines.push(`  ${SYMBOL[probe.status]} ${label}  ${probe.detail}`);
    if (probe.status === "fail" && probe.remediation) {
      lines.push(`      → ${probe.remediation}`);
    }
  }
  lines.push("");
  const passed = report.probes.filter((p) => p.status === "ok").length;
  const failed = report.probes.filter((p) => p.status === "fail").length;
  const skipped = report.probes.filter((p) => p.status === "skip").length;
  lines.push(
    `Summary: ${passed} passed, ${failed} failed, ${skipped} skipped  → exit ${report.exitCode}`,
  );
  return lines;
}

// ---------------------------------------------------------------------------
// Default (real) probe implementations
// ---------------------------------------------------------------------------

/**
 * Whether QBXMLRP2.RequestProcessor is registered, via `reg query` against the
 * COM ProgID key under HKEY_CLASSES_ROOT. Returns:
 *   - true  — key present (registered)
 *   - false — key absent (`reg query` exits non-zero with a status code)
 *   - null  — could not run the probe at all (non-Windows, or reg.exe missing)
 *
 * `reg.exe` exits 1 when the key is not found (→ false); a spawn failure
 * (reg.exe not on PATH) throws ENOENT with no `status` (→ null). Distinguishing
 * the two keeps "not registered" (a real, fixable fault) apart from "couldn't
 * check" (inconclusive → skip).
 */
export function defaultComRegistered(): boolean | null {
  if (process.platform !== "win32") return null;
  try {
    execFileSync("reg", ["query", "HKEY_CLASSES_ROOT\\QBXMLRP2.RequestProcessor"], {
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true,
    });
    return true;
  } catch (e: unknown) {
    const err = e as { code?: string; status?: number | null };
    if (err.code === "ENOENT") return null; // reg.exe itself could not be run
    if (typeof err.status === "number") return false; // reg ran, key not found
    return null; // unexpected — treat as inconclusive
  }
}

/**
 * winax load status. Attempts a real `require("winax")` (the native addon
 * actually loads — that's the point: an ABI mismatch surfaces here exactly as
 * it would at runtime). Classifies the failure message into missing vs
 * ABI-mismatch so the remediation can be specific.
 */
export function defaultWinaxStatus(): "ok" | "missing" | "abi-mismatch" | null {
  if (process.platform !== "win32") return null;
  try {
    const require = createRequire(import.meta.url);
    require("winax");
    return "ok";
  } catch (e: unknown) {
    const msg = String((e as { message?: string })?.message ?? "");
    if (/cannot find module|module not found/i.test(msg)) return "missing";
    return "abi-mismatch"; // any other load error on Windows = a build/ABI problem
  }
}

/** Wire the real probe implementations to the live process environment. */
export function buildDefaultDeps(): DoctorDeps {
  return {
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    fileExists: defaultFileExists,
    registryQuery: defaultRegistryQuery,
    comRegistered: defaultComRegistered,
    winaxStatus: defaultWinaxStatus,
  };
}

function main(): void {
  const report = runDoctor(buildDefaultDeps());
  for (const line of formatReport(report)) {
    console.log(line);
  }
  process.exit(report.exitCode);
}

// Run only when invoked as the CLI entry point — importing this module (tests)
// must not print or exit.
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main();
}
