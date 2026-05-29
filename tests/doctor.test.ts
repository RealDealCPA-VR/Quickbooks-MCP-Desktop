// Phase 19 #91 — CLI doctor probes.
//
// The doctor is a pure function (runDoctor) over an injected DoctorDeps bag,
// so every branch of every probe is driven deterministically here without a
// real Windows + QB install. Three layers of coverage:
//   1. Each probe in isolation (ok / fail / skip branches + remediation text).
//   2. runDoctor exit-code arithmetic (0 all-green, 1 any-fail, 2 any-skip,
//      fail-outranks-skip precedence).
//   3. formatReport rendering (symbols, remediation lines, summary).

import { describe, expect, it } from "vitest";

import {
  type DoctorDeps,
  formatReport,
  probeComRegistration,
  probeCompanyFile,
  probeCompanyRoot,
  probeNodeVersion,
  probePlatform,
  probeQBInstall,
  probeWinax,
  runDoctor,
} from "../src/cli/doctor.js";

// A fully-green Windows deps bag. Individual tests override single fields.
function makeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    nodeVersion: "20.20.2",
    platform: "win32",
    arch: "x64",
    env: {
      QB_COMPANY_FILE: "C:\\books\\Acme.qbw",
      QB_COMPANY_ROOT: "C:\\books",
    },
    fileExists: () => true,
    registryQuery: () => "C:\\Program Files (x86)\\Intuit\\QuickBooks\\qbw32.exe",
    comRegistered: () => true,
    winaxStatus: () => "ok",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Probe: Node version
// ---------------------------------------------------------------------------

describe("probeNodeVersion", () => {
  it("passes on Node 20.x", () => {
    const r = probeNodeVersion({ nodeVersion: "20.20.2" });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("20.20.2");
  });

  it("fails on Node 22.x with a remediation", () => {
    const r = probeNodeVersion({ nodeVersion: "22.4.0" });
    expect(r.status).toBe("fail");
    expect(r.remediation).toBeTruthy();
    expect(r.remediation).toMatch(/20/);
  });

  it("fails on Node 18.x (only major 20 is supported)", () => {
    expect(probeNodeVersion({ nodeVersion: "18.19.0" }).status).toBe("fail");
  });

  it("skips when the version string cannot be parsed", () => {
    expect(probeNodeVersion({ nodeVersion: "garbage" }).status).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// Probe: platform
// ---------------------------------------------------------------------------

describe("probePlatform", () => {
  it("passes on win32 and surfaces the arch", () => {
    const r = probePlatform({ platform: "win32", arch: "x64" });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("x64");
  });

  it("skips (not fails) on darwin — sim mode is legitimate there", () => {
    const r = probePlatform({ platform: "darwin", arch: "arm64" });
    expect(r.status).toBe("skip");
    expect(r.detail).toMatch(/simulation/i);
  });

  it("skips on linux", () => {
    expect(probePlatform({ platform: "linux", arch: "x64" }).status).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// Probe: QB Desktop install (reuses #90's resolveQBDesktopExe)
// ---------------------------------------------------------------------------

describe("probeQBInstall", () => {
  it("passes and surfaces the resolved exe + source (env)", () => {
    const r = probeQBInstall({
      platform: "win32",
      env: { QB_DESKTOP_EXE: "D:\\qb\\qbw32.exe" },
      fileExists: (p) => p === "D:\\qb\\qbw32.exe",
      registryQuery: () => null,
    });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("D:\\qb\\qbw32.exe");
    expect(r.detail).toContain("source: env");
  });

  it("passes via the registry branch and labels the source", () => {
    const r = probeQBInstall({
      platform: "win32",
      env: {},
      fileExists: (p) => p === "C:\\reg\\qbw32.exe",
      registryQuery: () => "C:\\reg\\qbw32.exe",
    });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("source: registry");
  });

  it("fails with a remediation when nothing resolves", () => {
    const r = probeQBInstall({
      platform: "win32",
      env: {},
      fileExists: () => false,
      registryQuery: () => null,
    });
    expect(r.status).toBe("fail");
    expect(r.remediation).toMatch(/QB_DESKTOP_EXE/);
  });

  it("skips on non-Windows", () => {
    const r = probeQBInstall({
      platform: "darwin",
      env: {},
      fileExists: () => true,
      registryQuery: () => "x",
    });
    expect(r.status).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// Probe: QBXMLRP2 COM registration
// ---------------------------------------------------------------------------

describe("probeComRegistration", () => {
  it("passes when registered", () => {
    expect(probeComRegistration({ platform: "win32", comRegistered: () => true }).status).toBe("ok");
  });

  it("fails with a remediation when not registered", () => {
    const r = probeComRegistration({ platform: "win32", comRegistered: () => false });
    expect(r.status).toBe("fail");
    expect(r.remediation).toMatch(/regsvr32|reinstall/i);
  });

  it("skips when the probe could not run (null)", () => {
    expect(probeComRegistration({ platform: "win32", comRegistered: () => null }).status).toBe("skip");
  });

  it("skips on non-Windows", () => {
    expect(probeComRegistration({ platform: "linux", comRegistered: () => true }).status).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// Probe: QB_COMPANY_FILE
// ---------------------------------------------------------------------------

describe("probeCompanyFile", () => {
  it("passes when set and the file exists", () => {
    const r = probeCompanyFile({ env: { QB_COMPANY_FILE: "C:\\a.qbw" }, fileExists: () => true });
    expect(r.status).toBe("ok");
    expect(r.detail).toBe("C:\\a.qbw");
  });

  it("fails when unset", () => {
    const r = probeCompanyFile({ env: {}, fileExists: () => true });
    expect(r.status).toBe("fail");
    expect(r.detail).toBe("not set");
    expect(r.remediation).toBeTruthy();
  });

  it("fails when set to a blank string", () => {
    expect(probeCompanyFile({ env: { QB_COMPANY_FILE: "   " }, fileExists: () => true }).status).toBe("fail");
  });

  it("fails when set but the file is missing, echoing the bad path", () => {
    const r = probeCompanyFile({ env: { QB_COMPANY_FILE: "C:\\missing.qbw" }, fileExists: () => false });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("C:\\missing.qbw");
  });
});

// ---------------------------------------------------------------------------
// Probe: QB_COMPANY_ROOT
// ---------------------------------------------------------------------------

describe("probeCompanyRoot", () => {
  it("is OK when unset (defaults to dirname of QB_COMPANY_FILE)", () => {
    const r = probeCompanyRoot({ env: {}, fileExists: () => false });
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/default/i);
  });

  it("passes when set and the directory exists", () => {
    expect(probeCompanyRoot({ env: { QB_COMPANY_ROOT: "C:\\books" }, fileExists: () => true }).status).toBe("ok");
  });

  it("fails when set but the directory is missing", () => {
    const r = probeCompanyRoot({ env: { QB_COMPANY_ROOT: "C:\\nope" }, fileExists: () => false });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("C:\\nope");
  });
});

// ---------------------------------------------------------------------------
// Probe: winax
// ---------------------------------------------------------------------------

describe("probeWinax", () => {
  it("passes when winax loads", () => {
    expect(probeWinax({ platform: "win32", winaxStatus: () => "ok" }).status).toBe("ok");
  });

  it("fails (missing) with an npm install hint", () => {
    const r = probeWinax({ platform: "win32", winaxStatus: () => "missing" });
    expect(r.status).toBe("fail");
    expect(r.remediation).toMatch(/npm install winax/);
  });

  it("fails (abi-mismatch) with a rebuild hint", () => {
    const r = probeWinax({ platform: "win32", winaxStatus: () => "abi-mismatch" });
    expect(r.status).toBe("fail");
    expect(r.remediation).toMatch(/npm rebuild winax/);
  });

  it("skips on non-Windows", () => {
    expect(probeWinax({ platform: "darwin", winaxStatus: () => null }).status).toBe("skip");
  });

  it("skips when status is null on Windows (inconclusive)", () => {
    expect(probeWinax({ platform: "win32", winaxStatus: () => null }).status).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// runDoctor — exit-code arithmetic
// ---------------------------------------------------------------------------

describe("runDoctor exit codes", () => {
  it("exits 0 when every probe is green (fully-configured Windows box)", () => {
    const report = runDoctor(makeDeps());
    expect(report.probes.every((p) => p.status === "ok")).toBe(true);
    expect(report.exitCode).toBe(0);
  });

  it("runs exactly the seven documented probes", () => {
    const report = runDoctor(makeDeps());
    expect(report.probes.map((p) => p.name)).toEqual([
      "Node version",
      "Platform",
      "QuickBooks Desktop",
      "QBXMLRP2 COM",
      "QB_COMPANY_FILE",
      "QB_COMPANY_ROOT",
      "winax",
    ]);
  });

  it("exits 1 when any probe fails", () => {
    const report = runDoctor(makeDeps({ comRegistered: () => false }));
    expect(report.exitCode).toBe(1);
  });

  it("exits 2 when a probe is skipped but none fail (clean non-Windows box)", () => {
    const report = runDoctor(
      makeDeps({
        platform: "darwin",
        arch: "arm64",
        // company-file/root still set+exist, node 20 → only platform/QB/COM/winax skip
      }),
    );
    expect(report.exitCode).toBe(2);
    expect(report.probes.some((p) => p.status === "skip")).toBe(true);
    expect(report.probes.some((p) => p.status === "fail")).toBe(false);
  });

  it("fail outranks skip — exits 1 when both are present", () => {
    const report = runDoctor(
      makeDeps({
        platform: "darwin", // produces skips
        env: {}, // QB_COMPANY_FILE unset → fail
      }),
    );
    expect(report.probes.some((p) => p.status === "skip")).toBe(true);
    expect(report.probes.some((p) => p.status === "fail")).toBe(true);
    expect(report.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// formatReport — rendering
// ---------------------------------------------------------------------------

describe("formatReport", () => {
  it("renders a symbol per probe and the exit code in the summary", () => {
    const lines = formatReport(runDoctor(makeDeps()));
    const body = lines.join("\n");
    expect(body).toContain("✓");
    expect(body).toMatch(/Summary: 7 passed, 0 failed, 0 skipped  → exit 0/);
  });

  it("renders a remediation arrow line under a failing probe", () => {
    const lines = formatReport(runDoctor(makeDeps({ comRegistered: () => false })));
    const body = lines.join("\n");
    expect(body).toContain("✗");
    expect(body).toMatch(/→ .*regsvr32|→ .*reinstall/i);
    expect(body).toMatch(/exit 1/);
  });

  it("does not emit a remediation arrow for skipped probes", () => {
    const report = runDoctor(makeDeps({ platform: "darwin" }));
    const skipLines = formatReport(report).filter((l) => l.includes("⚠"));
    expect(skipLines.length).toBeGreaterThan(0);
    // No skip line is immediately followed by an arrow remediation.
    const all = formatReport(report);
    all.forEach((line, i) => {
      if (line.includes("⚠")) {
        expect(all[i + 1] ?? "").not.toMatch(/^\s+→/);
      }
    });
  });
});
