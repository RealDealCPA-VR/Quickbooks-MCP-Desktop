// Phase 18 #85 — qb_closing_date_get + qb_closing_date_set.
//
// The qbXML SDK exposes preferences as a read-only surface:
// PreferencesQueryRq exists from qbXML 1.1; PreferencesModRq /
// AccountingPreferencesModRq do NOT exist at any version (verified against
// the qbwc/qbxml master schema mirrors). qb_closing_date_get hits the wire;
// qb_closing_date_set is an informational stub.
//
// Coverage layers:
//   1. Pure normalizeClosingDate helper — accepts ISO date strings, rejects
//      everything else (null/undefined/empty/malformed/non-string).
//   2. Sim handler — queryEntity("Preferences", {}) returns the seeded
//      AccountingPreferences shape via generic handleQuery.
//   3. qb_closing_date_get tool surface — unset (default seed), set (test
//      seam override), error propagation.
//   4. qb_closing_date_set tool surface — always-fail shape, 9005 code,
//      humanReadable, requestedClosingDate echo, password handling,
//      Zod-level rejection of malformed ISO dates.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import {
  registerPreferenceTools,
  normalizeClosingDate,
} from "../src/tools/preferences.js";

type Handler = (args: unknown) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;
type Schema = Record<string, z.ZodTypeAny>;
const handlers = new Map<string, Handler>();
const schemas = new Map<string, Schema>();
const fakeServer = {
  tool: (
    name: string,
    _description: string,
    schema: Schema,
    handler: Handler,
  ) => {
    handlers.set(name, handler);
    schemas.set(name, schema);
  },
};

let session: QBSessionManager;

beforeAll(async () => {
  session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-closing-date",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  registerPreferenceTools(fakeServer as never, () => session);
  await session.openSession();
});

// Test seam — directly mutate the seeded Preferences entry. The
// SimulationStore's private getStore is bypassed via `as any`, matching the
// existing pattern other tests use (e.g. connection-robustness.test.ts
// patches `store.processRequest`). This is intentionally narrow — we only
// want to flip ClosingDate for one test, not refactor the simulation store.
function setSimClosingDate(closingDate: string | null): void {
  const store = (session as any).store; // SimulationStore
  const prefs = store.getStore("Preferences").get("PREFERENCES");
  prefs.AccountingPreferences.ClosingDate = closingDate;
}

beforeEach(() => {
  // Restore default — null (unset) — between tests so coverage of the
  // default-seeded state stays accurate.
  setSimClosingDate(null);
});

// ---------------------------------------------------------------------------
// Layer 1 — Pure helper
// ---------------------------------------------------------------------------

describe("normalizeClosingDate", () => {
  it("returns ISO YYYY-MM-DD string verbatim", () => {
    expect(normalizeClosingDate("2024-12-31")).toBe("2024-12-31");
    expect(normalizeClosingDate("2023-01-01")).toBe("2023-01-01");
  });

  it("returns null for null/undefined", () => {
    expect(normalizeClosingDate(null)).toBe(null);
    expect(normalizeClosingDate(undefined)).toBe(null);
  });

  it("returns null for empty string", () => {
    expect(normalizeClosingDate("")).toBe(null);
    expect(normalizeClosingDate("   ")).toBe(null);
  });

  it("returns null for empty object (qbXML self-closing <ClosingDate/>)", () => {
    expect(normalizeClosingDate({})).toBe(null);
  });

  it("returns null for malformed date strings", () => {
    expect(normalizeClosingDate("12/31/2024")).toBe(null);
    expect(normalizeClosingDate("2024-12-31T00:00:00")).toBe(null);
    expect(normalizeClosingDate("Dec 31, 2024")).toBe(null);
    expect(normalizeClosingDate("not a date")).toBe(null);
  });

  it("returns null for numbers and booleans", () => {
    expect(normalizeClosingDate(0)).toBe(null);
    expect(normalizeClosingDate(20241231)).toBe(null);
    expect(normalizeClosingDate(false)).toBe(null);
    expect(normalizeClosingDate(true)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — Sim handler
// ---------------------------------------------------------------------------

describe("PreferencesQueryRq sim handler", () => {
  it("returns the seeded AccountingPreferences shape via queryEntity", async () => {
    const records = await session.queryEntity("Preferences", {});
    expect(Array.isArray(records)).toBe(true);
    expect(records.length).toBe(1);
    const prefs = records[0];
    expect(prefs.AccountingPreferences).toBeDefined();
    const acct = prefs.AccountingPreferences as Record<string, unknown>;
    expect(acct.IsUsingAuditTrail).toBe(true);
    expect(acct.IsUsingClassTracking).toBe(true);
    expect(acct.IsUsingAccountNumbers).toBe(true);
    // ClosingDate defaults to null (no closing date set).
    expect(acct.ClosingDate).toBe(null);
  });

  it("reflects test-seam ClosingDate mutations", async () => {
    setSimClosingDate("2024-12-31");
    const records = await session.queryEntity("Preferences", {});
    const acct = records[0].AccountingPreferences as Record<string, unknown>;
    expect(acct.ClosingDate).toBe("2024-12-31");
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — qb_closing_date_get tool surface
// ---------------------------------------------------------------------------

describe("qb_closing_date_get tool", () => {
  it("is registered", () => {
    expect(handlers.has("qb_closing_date_get")).toBe(true);
  });

  it("returns closingDate: null when no date is set (default seed)", async () => {
    const handler = handlers.get("qb_closing_date_get")!;
    const result = await handler({});
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.closingDate).toBe(null);
    expect(body.note).toMatch(/no closing date/i);
    expect(body.isUsingAuditTrail).toBe(true);
    expect(body.isUsingClassTracking).toBe(true);
    expect(body.isUsingAccountNumbers).toBe(true);
    expect(body.simulationMode).toBe(true);
  });

  it("returns ISO closingDate + protective note when set", async () => {
    setSimClosingDate("2024-12-31");
    const handler = handlers.get("qb_closing_date_get")!;
    const result = await handler({});
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.closingDate).toBe("2024-12-31");
    expect(body.note).toContain("2024-12-31");
    expect(body.note).toMatch(/protected/i);
  });

  it("normalizes malformed ClosingDate to null without throwing", async () => {
    setSimClosingDate("12/31/2024" as unknown as string);
    const handler = handlers.get("qb_closing_date_get")!;
    const result = await handler({});
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.closingDate).toBe(null);
    expect(body.note).toMatch(/no closing date/i);
  });

  it("propagates booleans even when the wire form is the string 'true'", async () => {
    const store = (session as any).store;
    const prefs = store.getStore("Preferences").get("PREFERENCES");
    const originalAuditTrail = prefs.AccountingPreferences.IsUsingAuditTrail;
    prefs.AccountingPreferences.IsUsingAuditTrail = "true";
    try {
      const handler = handlers.get("qb_closing_date_get")!;
      const result = await handler({});
      const body = JSON.parse(result.content[0].text);
      expect(body.isUsingAuditTrail).toBe(true);
    } finally {
      prefs.AccountingPreferences.IsUsingAuditTrail = originalAuditTrail;
    }
  });

  it("surfaces queryEntity errors via structured error wrapper", async () => {
    // Patch queryEntity to throw a QB-shaped error and confirm the tool
    // wrapper translates it (statusCode + humanReadable).
    const handler = handlers.get("qb_closing_date_get")!;
    const original = session.queryEntity.bind(session);
    (session as any).queryEntity = async () => {
      const e: any = new Error("PreferencesQueryRq simulated failure");
      e.statusCode = 500;
      throw e;
    };
    try {
      const result = await handler({});
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.success).toBe(false);
      expect(body.statusCode).toBe(500);
      expect(body.statusMessage).toMatch(/PreferencesQueryRq simulated failure/);
      expect(body.humanReadable).toMatch(/not found/i);
    } finally {
      (session as any).queryEntity = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — qb_closing_date_set tool surface (informational stub)
// ---------------------------------------------------------------------------

describe("qb_closing_date_set tool", () => {
  it("is registered", () => {
    expect(handlers.has("qb_closing_date_set")).toBe(true);
  });

  it("always returns isError: true with statusCode 9005", async () => {
    const handler = handlers.get("qb_closing_date_set")!;
    const result = await handler({ closingDate: "2024-12-31" });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(false);
    expect(body.statusCode).toBe(9005);
    expect(body.statusMessage).toMatch(/cannot be set/i);
  });

  it("includes humanReadable from qb-status-codes.ts", async () => {
    const handler = handlers.get("qb_closing_date_set")!;
    const result = await handler({ closingDate: "2024-12-31" });
    const body = JSON.parse(result.content[0].text);
    expect(body.humanReadable).toMatch(/QuickBooks Desktop SDK/i);
    expect(body.humanReadable).toMatch(/Edit → Preferences → Accounting/);
  });

  it("echoes requestedClosingDate verbatim in the response", async () => {
    const handler = handlers.get("qb_closing_date_set")!;
    const result = await handler({ closingDate: "2023-06-30" });
    const body = JSON.parse(result.content[0].text);
    expect(body.requestedClosingDate).toBe("2023-06-30");
    // UI instructions should also quote the date so the user-facing prompt
    // is unambiguous.
    const allInstructions = (body.uiInstructions as string[]).join(" ");
    expect(allInstructions).toContain("2023-06-30");
  });

  it("returns full 9-step uiInstructions path", async () => {
    const handler = handlers.get("qb_closing_date_set")!;
    const result = await handler({ closingDate: "2024-12-31" });
    const body = JSON.parse(result.content[0].text);
    expect(Array.isArray(body.uiInstructions)).toBe(true);
    expect(body.uiInstructions.length).toBe(9);
    const joined = (body.uiInstructions as string[]).join(" ");
    expect(joined).toMatch(/Edit.*Preferences/);
    expect(joined).toMatch(/Accounting/);
    expect(joined).toMatch(/Company Preferences/);
    expect(joined).toMatch(/Set Date\/Password/);
  });

  it("surfaces password hint when password is supplied", async () => {
    const handler = handlers.get("qb_closing_date_set")!;
    const result = await handler({
      closingDate: "2024-12-31",
      password: "year-end-2024",
    });
    const body = JSON.parse(result.content[0].text);
    const joined = (body.uiInstructions as string[]).join(" ");
    expect(joined).toContain("year-end-2024");
    expect(joined).toMatch(/Set Password/i);
  });

  it("emits optional password guidance when password is omitted", async () => {
    const handler = handlers.get("qb_closing_date_set")!;
    const result = await handler({ closingDate: "2024-12-31" });
    const body = JSON.parse(result.content[0].text);
    const joined = (body.uiInstructions as string[]).join(" ");
    // The "Optionally" wording marks the no-password branch.
    expect(joined).toMatch(/Optionally/);
  });

  it("includes sdkLimitation and workaround fields", async () => {
    const handler = handlers.get("qb_closing_date_set")!;
    const result = await handler({ closingDate: "2024-12-31" });
    const body = JSON.parse(result.content[0].text);
    expect(body.sdkLimitation).toMatch(/PreferencesModRq/);
    expect(body.workaround).toMatch(/UI Automation|SendKeys/i);
  });

  it("Zod schema rejects malformed ISO dates before handler runs", () => {
    // The handler itself never sees a malformed date because the McpServer
    // applies the schema before dispatch. We verify the schema directly.
    const schema = schemas.get("qb_closing_date_set")!;
    const closingDate = schema.closingDate as z.ZodString;
    expect(() => closingDate.parse("12/31/2024")).toThrow();
    expect(() => closingDate.parse("not a date")).toThrow();
    expect(() => closingDate.parse("")).toThrow();
    expect(() => closingDate.parse("2024-12-31")).not.toThrow();
  });

  it("performs no wire I/O — sim store handler is never called", async () => {
    let processRequestCalled = false;
    const store = (session as any).store;
    const original = store.processRequest.bind(store);
    store.processRequest = (xml: string) => {
      processRequestCalled = true;
      return original(xml);
    };
    try {
      const handler = handlers.get("qb_closing_date_set")!;
      await handler({ closingDate: "2024-12-31" });
      expect(processRequestCalled).toBe(false);
    } finally {
      store.processRequest = original;
    }
  });
});
