// Phase 19 #90 — QB Desktop launch helpers.
//
// Three layers:
//   1. Exe detection (resolveQBDesktopExe) — the env → registry → known-paths
//      fallback chain. Injectable dependencies so every branch is testable
//      without a real Windows install.
//   2. Registry output parser (parseRegistryQuery) — pulls InstallPath out of
//      `reg query /s` output without spawning reg.exe.
//   3. BeginSession error classifier (classifyBeginSessionError) — maps QB
//      Desktop error messages to one of file-conflict / multi-user-lock /
//      file-not-loaded / unknown. Patterns are the contract between the
//      manager's launch orchestrator and the real-world wire surface.

import { describe, expect, it } from "vitest";

import {
  classifyBeginSessionError,
  KNOWN_QB_DESKTOP_PATHS,
  parseRegistryQuery,
  QB_LAUNCH_POLL_MS,
  resolveQBDesktopExe,
} from "../src/util/qb-desktop-launch.js";

// ---------------------------------------------------------------------------
// Layer 1 — resolveQBDesktopExe (fallback chain)
// ---------------------------------------------------------------------------

describe("resolveQBDesktopExe — env / registry / fallback chain", () => {
  it("env var wins when QB_DESKTOP_EXE is set and the file exists", () => {
    const resolved = resolveQBDesktopExe({
      envExe: "D:\\custom-install\\qbw32.exe",
      fileExists: (p) => p === "D:\\custom-install\\qbw32.exe",
      registryQuery: () => "C:\\Program Files (x86)\\Intuit\\QuickBooks\\qbw32.exe",
    });
    expect(resolved).toEqual({ exe: "D:\\custom-install\\qbw32.exe", source: "env" });
  });

  it("falls through to registry when env path is set but the file does not exist (stale override)", () => {
    const resolved = resolveQBDesktopExe({
      envExe: "D:\\stale-path\\qbw32.exe",
      fileExists: (p) => p === "C:\\reg-hit\\qbw32.exe",
      registryQuery: () => "C:\\reg-hit\\qbw32.exe",
    });
    expect(resolved).toEqual({ exe: "C:\\reg-hit\\qbw32.exe", source: "registry" });
  });

  it("falls through to registry when env var is unset", () => {
    const resolved = resolveQBDesktopExe({
      envExe: undefined,
      fileExists: (p) => p === "C:\\reg-hit\\qbw32.exe",
      registryQuery: () => "C:\\reg-hit\\qbw32.exe",
    });
    expect(resolved).toEqual({ exe: "C:\\reg-hit\\qbw32.exe", source: "registry" });
  });

  it("falls through to known-paths when both env and registry miss", () => {
    const knownHit = KNOWN_QB_DESKTOP_PATHS[0];
    const resolved = resolveQBDesktopExe({
      envExe: undefined,
      fileExists: (p) => p === knownHit,
      registryQuery: () => null,
    });
    expect(resolved).toEqual({ exe: knownHit, source: "fallback" });
  });

  it("returns the FIRST matching known path (order matters)", () => {
    // Make the 2nd and 5th paths both 'exist' — resolver must pick the 2nd
    // because KNOWN_QB_DESKTOP_PATHS is iterated in order. Pins the order
    // contract: changing the array order is a behavior change, not a
    // cosmetic refactor.
    const second = KNOWN_QB_DESKTOP_PATHS[1];
    const fifth = KNOWN_QB_DESKTOP_PATHS[4];
    const resolved = resolveQBDesktopExe({
      envExe: undefined,
      fileExists: (p) => p === second || p === fifth,
      registryQuery: () => null,
    });
    expect(resolved?.exe).toBe(second);
    expect(resolved?.source).toBe("fallback");
  });

  it("returns null when no branch resolves", () => {
    const resolved = resolveQBDesktopExe({
      envExe: undefined,
      fileExists: () => false,
      registryQuery: () => null,
    });
    expect(resolved).toBeNull();
  });

  it("registry path that doesn't exist on disk falls through to known-paths", () => {
    const knownHit = KNOWN_QB_DESKTOP_PATHS[0];
    const resolved = resolveQBDesktopExe({
      envExe: undefined,
      fileExists: (p) => p === knownHit,
      registryQuery: () => "C:\\does-not-exist\\qbw32.exe",
    });
    expect(resolved?.source).toBe("fallback");
    expect(resolved?.exe).toBe(knownHit);
  });

  it("ignores empty-string env var (whitespace-only is also treated as unset)", () => {
    const knownHit = KNOWN_QB_DESKTOP_PATHS[0];
    const resolved = resolveQBDesktopExe({
      envExe: "   ",
      fileExists: (p) => p === knownHit,
      registryQuery: () => null,
    });
    expect(resolved?.source).toBe("fallback");
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — parseRegistryQuery
// ---------------------------------------------------------------------------

describe("parseRegistryQuery — extract InstallPath from `reg query /s` output", () => {
  it("parses a single matching subkey", () => {
    const out = [
      "",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Intuit\\QuickBooks\\QB24",
      "    InstallPath    REG_SZ    C:\\Program Files (x86)\\Intuit\\QuickBooks 2024\\",
      "",
    ].join("\r\n");
    expect(parseRegistryQuery(out)).toBe(
      "C:\\Program Files (x86)\\Intuit\\QuickBooks 2024\\qbw32.exe"
    );
  });

  it("returns the LAST match when multiple QB versions are installed (newest wins)", () => {
    const out = [
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Intuit\\QuickBooks\\QB22",
      "    InstallPath    REG_SZ    C:\\Program Files (x86)\\Intuit\\QuickBooks 2022\\",
      "",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Intuit\\QuickBooks\\QB24",
      "    InstallPath    REG_SZ    C:\\Program Files (x86)\\Intuit\\QuickBooks 2024\\",
    ].join("\r\n");
    expect(parseRegistryQuery(out)).toBe(
      "C:\\Program Files (x86)\\Intuit\\QuickBooks 2024\\qbw32.exe"
    );
  });

  it("returns null when no InstallPath line is present", () => {
    const out = "HKEY_LOCAL_MACHINE\\SOFTWARE\\Intuit\\QuickBooks";
    expect(parseRegistryQuery(out)).toBeNull();
  });

  it("returns null on empty / whitespace input", () => {
    expect(parseRegistryQuery("")).toBeNull();
    expect(parseRegistryQuery("    \n  \n")).toBeNull();
  });

  it("tolerates Unix newlines in addition to CRLF", () => {
    const out =
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Intuit\\QuickBooks\\QB24\n" +
      "    InstallPath    REG_SZ    C:\\Program Files\\Intuit\\QuickBooks\\\n";
    expect(parseRegistryQuery(out)).toBe(
      "C:\\Program Files\\Intuit\\QuickBooks\\qbw32.exe"
    );
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — classifyBeginSessionError
// ---------------------------------------------------------------------------

describe("classifyBeginSessionError — bucket QBXMLRP2 BeginSession errors", () => {
  it("classifies 'different company file' as file-conflict", () => {
    expect(classifyBeginSessionError(
      "QuickBooks is already open with a different company file"
    )).toBe("file-conflict");
  });

  it("classifies 'different file' shorthand as file-conflict", () => {
    expect(classifyBeginSessionError(
      "Requested file does not match the different file currently loaded"
    )).toBe("file-conflict");
  });

  it("classifies 'already open with a different' phrasing as file-conflict", () => {
    expect(classifyBeginSessionError(
      "QB session refused: already open with a different .qbw"
    )).toBe("file-conflict");
  });

  it("classifies 'in use by another user' as multi-user-lock", () => {
    expect(classifyBeginSessionError(
      "The company file is in use by another user"
    )).toBe("multi-user-lock");
  });

  it("classifies 'multi-user mode' phrasing as multi-user-lock", () => {
    expect(classifyBeginSessionError(
      "Cannot open: file currently in multi-user mode by another user"
    )).toBe("multi-user-lock");
  });

  it("classifies 'file is locked' as multi-user-lock", () => {
    expect(classifyBeginSessionError("File is locked by another user"))
      .toBe("multi-user-lock");
  });

  it("classifies 'no company file is open' as file-not-loaded", () => {
    expect(classifyBeginSessionError(
      "BeginSession failed: no company file is open"
    )).toBe("file-not-loaded");
  });

  it("classifies 'QuickBooks is not running' as file-not-loaded", () => {
    expect(classifyBeginSessionError(
      "OpenConnection2 failed: QuickBooks is not running"
    )).toBe("file-not-loaded");
  });

  it("classifies the 0x80040420 HRESULT as file-not-loaded", () => {
    expect(classifyBeginSessionError(
      "QBXMLRP2 returned HRESULT 0x80040420 ('no file open')"
    )).toBe("file-not-loaded");
  });

  it("precedence: file-conflict beats file-not-loaded when both substrings appear", () => {
    // A message that mentions both 'different file' AND 'no company file
    // is open' must classify as conflict, not not-loaded — the conflict
    // remediation is materially different (close, then retry vs. launch).
    expect(classifyBeginSessionError(
      "different company file: no company file is open at this path"
    )).toBe("file-conflict");
  });

  it("precedence: multi-user-lock beats file-not-loaded", () => {
    expect(classifyBeginSessionError(
      "file is locked: no company file open from this session"
    )).toBe("multi-user-lock");
  });

  it("returns 'unknown' for unrecognized messages", () => {
    expect(classifyBeginSessionError("something completely unrelated")).toBe("unknown");
    expect(classifyBeginSessionError("3120: missing required field")).toBe("unknown");
  });

  it("returns 'unknown' for empty input", () => {
    expect(classifyBeginSessionError("")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — schedule invariant
// ---------------------------------------------------------------------------

describe("QB_LAUNCH_POLL_MS — schedule contract", () => {
  it("sums to 30000ms across 5 tiers (1s + 2s + 4s + 8s + 15s)", () => {
    expect(QB_LAUNCH_POLL_MS).toEqual([1000, 2000, 4000, 8000, 15000]);
    expect(QB_LAUNCH_POLL_MS.reduce((a, b) => a + b, 0)).toBe(30000);
  });

  it("is frozen so tests can rely on the canonical schedule", () => {
    expect(Object.isFrozen(QB_LAUNCH_POLL_MS)).toBe(true);
  });
});
