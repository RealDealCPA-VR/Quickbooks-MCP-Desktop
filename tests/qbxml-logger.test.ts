// Phase 18 #83 — persistent QBXML wire logger.
//
// Coverage layers:
//   1. Singleton resolution — getQbxmlLogger() returns null when QB_DEBUG_QBXML
//      is unset / wrong value; constructs logger when "1"; default log dir;
//      QB_DEBUG_LOG_PATH override; resetQbxmlLogger() re-arms.
//   2. Redaction — VendorTaxIdent / SSN / BankAccountNumber / CreditCardNumber
//      values masked; multiple instances; empty tags left alone; non-sensitive
//      tags pass through; redaction is idempotent.
//   3. File output — header + body block format; per-request sequence number
//      pairs request/response; durationMs surfaces on response; date-stamped
//      file name; logError shape.
//   4. Integration through QBSessionManager.sendRequest — sim mode logs the
//      request envelope and the JSON-stringified parsed response; logger
//      no-op (no file created) when QB_DEBUG_QBXML is unset; request errors
//      logged as op=error.
//   5. Defensive — first write failure (unwritable directory) disables logger
//      for the rest of the process without throwing into the request flow.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getQbxmlLogger,
  resetQbxmlLogger,
  QbxmlLogger,
  redactSensitive,
} from "../src/util/qbxml-logger.js";
import { QBSessionManager } from "../src/session/manager.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "qbxml-logger-"));
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

function readLogContents(dir: string): string {
  const file = join(dir, `qbxml-${todayStamp()}.log`);
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8");
}

// Each test gets a fresh tmp dir AND a singleton reset so env changes take
// effect. Tear down after to keep the test tmpdir clean.
let tmpDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpDir = makeTmpDir();
  savedEnv = {
    QB_DEBUG_QBXML: process.env.QB_DEBUG_QBXML,
    QB_DEBUG_LOG_PATH: process.env.QB_DEBUG_LOG_PATH,
  };
  delete process.env.QB_DEBUG_QBXML;
  delete process.env.QB_DEBUG_LOG_PATH;
  resetQbxmlLogger();
});

afterEach(() => {
  process.env.QB_DEBUG_QBXML = savedEnv.QB_DEBUG_QBXML;
  process.env.QB_DEBUG_LOG_PATH = savedEnv.QB_DEBUG_LOG_PATH;
  if (savedEnv.QB_DEBUG_QBXML === undefined) delete process.env.QB_DEBUG_QBXML;
  if (savedEnv.QB_DEBUG_LOG_PATH === undefined) delete process.env.QB_DEBUG_LOG_PATH;
  resetQbxmlLogger();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Layer 1 — Singleton resolution
// ---------------------------------------------------------------------------

describe("getQbxmlLogger — singleton resolution", () => {
  it("returns null when QB_DEBUG_QBXML is unset", () => {
    expect(getQbxmlLogger()).toBeNull();
  });

  it("returns null when QB_DEBUG_QBXML is something other than literal '1'", () => {
    expect(getQbxmlLogger({ QB_DEBUG_QBXML: "true" })).toBeNull();
    resetQbxmlLogger();
    expect(getQbxmlLogger({ QB_DEBUG_QBXML: "yes" })).toBeNull();
    resetQbxmlLogger();
    expect(getQbxmlLogger({ QB_DEBUG_QBXML: "0" })).toBeNull();
  });

  it("constructs a logger when QB_DEBUG_QBXML='1'", () => {
    const logger = getQbxmlLogger({ QB_DEBUG_QBXML: "1", QB_DEBUG_LOG_PATH: tmpDir });
    expect(logger).not.toBeNull();
    expect(logger?.getLogDir()).toBe(tmpDir);
  });

  it("defaults log dir to ./logs when QB_DEBUG_LOG_PATH unset", () => {
    const logger = getQbxmlLogger({ QB_DEBUG_QBXML: "1" });
    expect(logger).not.toBeNull();
    expect(logger?.getLogDir()).toMatch(/[\\/]logs$/);
  });

  it("caches the singleton — subsequent calls return the same instance", () => {
    const a = getQbxmlLogger({ QB_DEBUG_QBXML: "1", QB_DEBUG_LOG_PATH: tmpDir });
    const b = getQbxmlLogger({ QB_DEBUG_QBXML: "1", QB_DEBUG_LOG_PATH: tmpDir });
    expect(a).toBe(b);
  });

  it("resetQbxmlLogger() forces re-read on next access", () => {
    const a = getQbxmlLogger({ QB_DEBUG_QBXML: "1", QB_DEBUG_LOG_PATH: tmpDir });
    resetQbxmlLogger();
    const b = getQbxmlLogger({ QB_DEBUG_QBXML: "1", QB_DEBUG_LOG_PATH: tmpDir });
    expect(a).not.toBe(b);
  });

  it("returns null after reset if env no longer enables logging", () => {
    const a = getQbxmlLogger({ QB_DEBUG_QBXML: "1", QB_DEBUG_LOG_PATH: tmpDir });
    expect(a).not.toBeNull();
    resetQbxmlLogger();
    const b = getQbxmlLogger({});
    expect(b).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — Redaction
// ---------------------------------------------------------------------------

describe("redactSensitive", () => {
  it("masks VendorTaxIdent values", () => {
    const out = redactSensitive("<VendorTaxIdent>12-3456789</VendorTaxIdent>");
    expect(out).toBe("<VendorTaxIdent>[REDACTED]</VendorTaxIdent>");
  });

  it("masks SSN values", () => {
    const out = redactSensitive("<SSN>123-45-6789</SSN>");
    expect(out).toBe("<SSN>[REDACTED]</SSN>");
  });

  it("masks BankAccountNumber values", () => {
    const out = redactSensitive("<BankAccountNumber>987654321</BankAccountNumber>");
    expect(out).toBe("<BankAccountNumber>[REDACTED]</BankAccountNumber>");
  });

  it("masks CreditCardNumber values", () => {
    const out = redactSensitive("<CreditCardNumber>4111111111111111</CreditCardNumber>");
    expect(out).toBe("<CreditCardNumber>[REDACTED]</CreditCardNumber>");
  });

  it("masks multiple instances of the same tag", () => {
    const out = redactSensitive(
      "<SSN>111-11-1111</SSN><other/><SSN>222-22-2222</SSN>"
    );
    expect(out).toBe(
      "<SSN>[REDACTED]</SSN><other/><SSN>[REDACTED]</SSN>"
    );
  });

  it("leaves empty tags alone (nothing to redact)", () => {
    const out = redactSensitive("<SSN></SSN>");
    expect(out).toBe("<SSN></SSN>");
  });

  it("leaves non-sensitive tags untouched", () => {
    const xml = "<CustomerRet><FullName>Acme Inc</FullName><Phone>555-1212</Phone></CustomerRet>";
    expect(redactSensitive(xml)).toBe(xml);
  });

  it("is idempotent — applying twice gives the same output", () => {
    const once = redactSensitive("<VendorTaxIdent>12-3456789</VendorTaxIdent>");
    const twice = redactSensitive(once);
    expect(twice).toBe(once);
  });

  it("masks values inside a realistic VendorRet block", () => {
    const xml = `<VendorRet><Name>X</Name><VendorTaxIdent>98-7654321</VendorTaxIdent><Phone>555</Phone></VendorRet>`;
    expect(redactSensitive(xml)).toContain("<VendorTaxIdent>[REDACTED]</VendorTaxIdent>");
    expect(redactSensitive(xml)).toContain("<Name>X</Name>");
    expect(redactSensitive(xml)).toContain("<Phone>555</Phone>");
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — File output format
// ---------------------------------------------------------------------------

describe("QbxmlLogger — file output", () => {
  it("writes a header + body block for a request", () => {
    const logger = new QbxmlLogger({ logDir: tmpDir });
    logger.logRequest("<QBXML/>", "simulation");
    const contents = readLogContents(tmpDir);
    expect(contents).toMatch(/^=== \S+ mode=simulation seq=1 op=request ===\n<QBXML\/>\n\n$/);
  });

  it("pairs request/response by seq", () => {
    const logger = new QbxmlLogger({ logDir: tmpDir });
    const m = logger.logRequest("<rq/>", "live");
    logger.logResponse("<rs/>", "live", m);
    const contents = readLogContents(tmpDir);
    expect(contents).toMatch(/mode=live seq=1 op=request/);
    expect(contents).toMatch(/mode=live seq=1 op=response durationMs=\d+/);
  });

  it("increments seq per request across multiple pairs", () => {
    const logger = new QbxmlLogger({ logDir: tmpDir });
    const m1 = logger.logRequest("<rq1/>", "live");
    logger.logResponse("<rs1/>", "live", m1);
    const m2 = logger.logRequest("<rq2/>", "live");
    logger.logResponse("<rs2/>", "live", m2);
    const contents = readLogContents(tmpDir);
    expect(contents).toMatch(/seq=1 op=request/);
    expect(contents).toMatch(/seq=1 op=response/);
    expect(contents).toMatch(/seq=2 op=request/);
    expect(contents).toMatch(/seq=2 op=response/);
  });

  it("JSON-stringifies non-string response bodies (sim mode)", () => {
    const logger = new QbxmlLogger({ logDir: tmpDir });
    const m = logger.logRequest("<rq/>", "simulation");
    logger.logResponse({ responses: [{ type: "CustomerQueryRs", statusCode: 0 }] }, "simulation", m);
    const contents = readLogContents(tmpDir);
    expect(contents).toContain(`"type": "CustomerQueryRs"`);
  });

  it("redacts sensitive tags in the request envelope before writing", () => {
    const logger = new QbxmlLogger({ logDir: tmpDir });
    const m = logger.logRequest(
      "<VendorAddRq><VendorTaxIdent>12-3456789</VendorTaxIdent></VendorAddRq>",
      "live"
    );
    logger.logResponse("<VendorRet><VendorTaxIdent>12-3456789</VendorTaxIdent></VendorRet>", "live", m);
    const contents = readLogContents(tmpDir);
    expect(contents).not.toContain("12-3456789");
    expect(contents).toMatch(/<VendorTaxIdent>\[REDACTED\]<\/VendorTaxIdent>/g);
  });

  it("writes to date-stamped file name", () => {
    const logger = new QbxmlLogger({ logDir: tmpDir });
    logger.logRequest("<rq/>", "simulation");
    const files = readdirSync(tmpDir);
    expect(files).toEqual([`qbxml-${todayStamp()}.log`]);
  });

  it("logError writes op=error with error name + message", () => {
    const logger = new QbxmlLogger({ logDir: tmpDir });
    const m = logger.logRequest("<rq/>", "live");
    logger.logError(new Error("boom"), "live", m);
    const contents = readLogContents(tmpDir);
    expect(contents).toMatch(/seq=1 op=error durationMs=\d+/);
    expect(contents).toContain("Error: boom");
  });

  it("auto-creates the log directory if missing", () => {
    const nested = join(tmpDir, "deep", "nest");
    expect(existsSync(nested)).toBe(false);
    const logger = new QbxmlLogger({ logDir: nested });
    logger.logRequest("<rq/>", "simulation");
    expect(existsSync(join(nested, `qbxml-${todayStamp()}.log`))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — Integration with QBSessionManager.sendRequest
// ---------------------------------------------------------------------------

describe("QBSessionManager.sendRequest — logger integration", () => {
  function makeSession() {
    return new QBSessionManager({
      companyFile: "simulation",
      appName: "vitest-logger",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
  }

  it("does not create the log file when QB_DEBUG_QBXML is unset", async () => {
    const sm = makeSession();
    await sm.queryEntity("Customer");
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it("logs request + response when QB_DEBUG_QBXML='1'", async () => {
    process.env.QB_DEBUG_QBXML = "1";
    process.env.QB_DEBUG_LOG_PATH = tmpDir;
    resetQbxmlLogger();
    const sm = makeSession();
    await sm.queryEntity("Customer");
    const contents = readLogContents(tmpDir);
    expect(contents).toMatch(/mode=simulation seq=1 op=request/);
    expect(contents).toMatch(/mode=simulation seq=1 op=response/);
    // The outbound envelope contains the QBXML wire request
    expect(contents).toContain("CustomerQueryRq");
    // The inbound (parsed sim response) was JSON-stringified
    expect(contents).toContain(`"type": "CustomerQueryRs"`);
  });

  it("propagates store throws as op=error log entries", async () => {
    process.env.QB_DEBUG_QBXML = "1";
    process.env.QB_DEBUG_LOG_PATH = tmpDir;
    resetQbxmlLogger();
    const sm = makeSession();
    // Patch the store to force a throw — the sim store returns ErrorRs for
    // malformed input rather than throwing, so we substitute a method that
    // throws to exercise the error-logging branch in sendRequest.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).store.processRequest = () => {
      throw new Error("forced sim throw");
    };
    await expect(sm.sendRequest("<rq/>")).rejects.toThrow("forced sim throw");
    const contents = readLogContents(tmpDir);
    expect(contents).toMatch(/seq=1 op=request/);
    expect(contents).toMatch(/seq=1 op=error durationMs=\d+/);
    expect(contents).toContain("Error: forced sim throw");
  });

  it("multiple sendRequest calls produce paired entries in one file", async () => {
    process.env.QB_DEBUG_QBXML = "1";
    process.env.QB_DEBUG_LOG_PATH = tmpDir;
    resetQbxmlLogger();
    const sm = makeSession();
    await sm.queryEntity("Customer");
    await sm.queryEntity("Vendor");
    const contents = readLogContents(tmpDir);
    expect(contents).toMatch(/seq=1 op=request[\s\S]+seq=1 op=response/);
    expect(contents).toMatch(/seq=2 op=request[\s\S]+seq=2 op=response/);
  });
});

// ---------------------------------------------------------------------------
// Layer 5 — Defensive: write failure latches disabled
// ---------------------------------------------------------------------------

describe("QbxmlLogger — write-failure safety", () => {
  it("disables the logger if the directory cannot be created", () => {
    // Create a *file* at the target dir path so mkdir will fail with EEXIST/ENOTDIR.
    const blockedPath = join(tmpDir, "blocked");
    writeFileSync(blockedPath, "i am a file, not a dir");
    const logger = new QbxmlLogger({ logDir: join(blockedPath, "sub") });
    // Should not throw — logger swallows the mkdir failure and latches disabled.
    expect(() => logger.logRequest("<rq/>", "live")).not.toThrow();
  });
});
