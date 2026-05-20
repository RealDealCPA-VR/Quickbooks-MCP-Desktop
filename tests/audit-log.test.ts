// Phase 14 #66 — qb_audit_log (Enterprise-only audit-trail read).
//
// Coverage layers:
//   1. Builder — buildCustomDetailReportRequest with reportType="AuditTrail"
//      emits the canonical IncludeColumn set + ReportPeriod, with NO
//      ReportAccountFilter / ReportClearedStatusFilter / ReportModifiedDateRangeFilter.
//   2. Sim handler — handleAuditTrailReport routes the AuditTrail branch
//      separately from CustomTxnDetail (no account-filter requirement),
//      filters by ReportPeriod against TimeModified date-only slice, sorts
//      desc by TimeModified, emits the canonical column set.
//   3. Manager — runAuditTrailReport returns the extracted ReportRet via
//      extractCustomDetailReportData in {Columns, Rows} shape.
//   4. Tool surface — qb_audit_log: XOR-validates txnId/dateRange (both
//      → 3120, neither → 3120), edition-gates non-Enterprise (Pro/Premier/
//      Accountant → 9003), happy path under Enterprise with dateRange,
//      happy path with txnId scope (post-filter), empty-result handling,
//      and the structured-entry shape (changedField/oldValue/newValue
//      absent on Added/Deleted, present on Modified).

import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerReportTools } from "../src/tools/reports.js";
import { buildCustomDetailReportRequest } from "../src/qbxml/builder.js";

type Handler = (args: unknown) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;
const handlers = new Map<string, Handler>();
const fakeServer = {
  tool: (
    name: string,
    _description: string,
    _schema: Record<string, z.ZodTypeAny>,
    handler: Handler,
  ) => {
    handlers.set(name, handler);
  },
};

let session: QBSessionManager;

beforeAll(async () => {
  session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-audit-log",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  registerReportTools(fakeServer as never, () => session);
  await session.openSession();
});

// Patches `session.getHostInfo` on a fresh session so the audit-log handler
// passes (or fails) the edition gate under test. Returns a registered handler
// map for that session. Mirrors the pattern in tests/w2-summary.test.ts:380.
async function sessionWithEdition(edition: "Pro" | "Premier" | "PremierAccountant" | "Enterprise" | "EnterpriseAccountant"): Promise<{
  session: QBSessionManager;
  handler: Handler;
}> {
  const s = new QBSessionManager({
    companyFile: "simulation",
    appName: `vitest-audit-${edition}`,
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  await s.openSession();
  const localHandlers = new Map<string, Handler>();
  const localServer = {
    tool: (
      name: string,
      _description: string,
      _schema: Record<string, z.ZodTypeAny>,
      handler: Handler,
    ) => {
      localHandlers.set(name, handler);
    },
  };
  registerReportTools(localServer as never, () => s);
  s.getHostInfo = async () => ({
    productName: `QuickBooks ${edition} 2024`,
    majorVersion: "34",
    minorVersion: "0",
    country: "US",
    supportedQbxmlVersions: ["16.0"],
    maxQbxmlVersion: "16.0",
    isAutomaticLogin: false,
    qbFileMode: "SingleUser",
    edition,
    isEnterprise: edition === "Enterprise" || edition === "EnterpriseAccountant",
    isAccountant: edition === "PremierAccountant" || edition === "EnterpriseAccountant",
  });
  return { session: s, handler: localHandlers.get("qb_audit_log")! };
}

// ---------------------------------------------------------------------------
// Layer 1 — Builder
// ---------------------------------------------------------------------------

describe("buildCustomDetailReportRequest (AuditTrail)", () => {
  it("emits the canonical IncludeColumn set for AuditTrail", () => {
    const xml = buildCustomDetailReportRequest({
      reportType: "AuditTrail",
      fromDate: "2025-01-01",
      toDate: "2025-12-31",
      includeColumns: [
        "User", "TimeModified", "ModifyType",
        "ChangedField", "OldValue", "NewValue", "TxnID", "TxnType",
      ],
    });

    expect(xml).toContain("<CustomDetailReportType>AuditTrail</CustomDetailReportType>");
    expect(xml).toContain("<FromReportDate>2025-01-01</FromReportDate>");
    expect(xml).toContain("<ToReportDate>2025-12-31</ToReportDate>");
    expect(xml).toContain("<IncludeColumn>User</IncludeColumn>");
    expect(xml).toContain("<IncludeColumn>TimeModified</IncludeColumn>");
    expect(xml).toContain("<IncludeColumn>ModifyType</IncludeColumn>");
    expect(xml).toContain("<IncludeColumn>ChangedField</IncludeColumn>");
    expect(xml).toContain("<IncludeColumn>OldValue</IncludeColumn>");
    expect(xml).toContain("<IncludeColumn>NewValue</IncludeColumn>");
    expect(xml).toContain("<IncludeColumn>TxnID</IncludeColumn>");
    expect(xml).toContain("<IncludeColumn>TxnType</IncludeColumn>");
  });

  it("omits ReportAccountFilter / ReportClearedStatusFilter / ReportModifiedDateRangeFilter for AuditTrail", () => {
    const xml = buildCustomDetailReportRequest({
      reportType: "AuditTrail",
      fromDate: "2025-01-01",
      toDate: "2025-12-31",
    });
    expect(xml).not.toContain("<ReportAccountFilter>");
    expect(xml).not.toContain("<ReportClearedStatusFilter>");
    expect(xml).not.toContain("<ReportModifiedDateRangeFilter>");
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — Sim handler
// ---------------------------------------------------------------------------

describe("handleAuditTrailReport (sim)", () => {
  it("returns all seeded entries when the date range covers them", async () => {
    const ret = await session.runAuditTrailReport({
      fromDate: "2025-01-01",
      toDate: "2025-12-31",
    });
    const rows = (ret.Rows as Array<Record<string, unknown>>);
    expect(rows.length).toBeGreaterThanOrEqual(8); // seed has 8 entries

    // Every row carries the canonical column set
    const r0 = rows[0];
    expect(r0).toHaveProperty("User");
    expect(r0).toHaveProperty("TimeModified");
    expect(r0).toHaveProperty("ModifyType");
    expect(r0).toHaveProperty("TxnID");
    expect(r0).toHaveProperty("TxnType");
  });

  it("sorts rows desc by TimeModified (most-recent-first)", async () => {
    const ret = await session.runAuditTrailReport({
      fromDate: "2025-01-01",
      toDate: "2025-12-31",
    });
    const rows = ret.Rows as Array<Record<string, unknown>>;
    for (let i = 1; i < rows.length; i++) {
      const prev = String(rows[i - 1].TimeModified ?? "");
      const cur = String(rows[i].TimeModified ?? "");
      expect(prev >= cur).toBe(true);
    }
  });

  it("filters by ReportPeriod date-only slice (TimeModified ISO is sliced for compare)", async () => {
    // Window covering only April 2025 — seed has 2 entries in April
    // (TXN-2001 Added 2025-04-15, TXN-2001 Deleted 2025-04-18, TXN-1001
    // Modified 2025-04-12 — three within April).
    const ret = await session.runAuditTrailReport({
      fromDate: "2025-04-01",
      toDate: "2025-04-30",
    });
    const rows = ret.Rows as Array<Record<string, unknown>>;
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(String(r.TimeModified).slice(0, 10) >= "2025-04-01").toBe(true);
      expect(String(r.TimeModified).slice(0, 10) <= "2025-04-30").toBe(true);
    }
  });

  it("returns empty rows when no audit entries in the window", async () => {
    const ret = await session.runAuditTrailReport({
      fromDate: "2030-01-01",
      toDate: "2030-12-31",
    });
    const rows = ret.Rows as Array<Record<string, unknown>>;
    expect(rows).toEqual([]);
  });

  it("does NOT require ReportAccountFilter (AuditTrail differs from CustomTxnDetail)", async () => {
    // The sim's CustomTxnDetail path 3120s on missing ReportAccountFilter.
    // AuditTrail must bypass that requirement — verified by the happy-path
    // tests above (no account arg → 200 OK), but pin explicitly so a future
    // refactor that hoists the account-filter check above the AuditTrail
    // dispatch breaks this test.
    const ret = await session.runAuditTrailReport({
      fromDate: "2025-01-01",
      toDate: "2025-12-31",
    });
    expect(ret.Rows).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — Manager
// ---------------------------------------------------------------------------

describe("QBSessionManager.runAuditTrailReport", () => {
  it("returns the extracted ReportRet in {Columns, Rows} shape", async () => {
    const ret = await session.runAuditTrailReport({
      fromDate: "2025-01-01",
      toDate: "2025-12-31",
    });
    expect(ret.Columns).toBeDefined();
    expect(ret.Rows).toBeDefined();

    const cols = ret.Columns as Array<Record<string, unknown>>;
    const titles = cols.map((c) => String(c.Title));
    expect(titles).toEqual([
      "User", "TimeModified", "ModifyType",
      "ChangedField", "OldValue", "NewValue", "TxnID", "TxnType",
    ]);
  });

  it("handles missing fromDate / toDate (omits ReportPeriod)", async () => {
    // No filter — returns all seed entries
    const ret = await session.runAuditTrailReport({});
    const rows = ret.Rows as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — Tool surface (qb_audit_log)
// ---------------------------------------------------------------------------

describe("qb_audit_log tool — argument validation", () => {
  it("rejects with 3120 when both txnId and dateRange supplied", async () => {
    const { handler } = await sessionWithEdition("Enterprise");
    const result = await handler({
      txnId: "AUDIT-TXN-1001",
      dateRange: { fromDate: "2025-01-01", toDate: "2025-12-31" },
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.statusCode).toBe(3120);
    expect(body.statusMessage).toContain("both supplied");
  });

  it("rejects with 3120 when neither txnId nor dateRange supplied", async () => {
    const { handler } = await sessionWithEdition("Enterprise");
    const result = await handler({});
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.statusCode).toBe(3120);
    expect(body.statusMessage).toContain("neither supplied");
  });
});

describe("qb_audit_log tool — edition gate", () => {
  it("rejects with 9003 on Pro edition", async () => {
    const { handler } = await sessionWithEdition("Pro");
    const result = await handler({
      dateRange: { fromDate: "2025-01-01", toDate: "2025-12-31" },
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.statusCode).toBe(9003);
    expect(body.edition).toBe("Pro");
    expect(body.statusMessage).toContain("Enterprise");
  });

  it("rejects with 9003 on Premier edition", async () => {
    const { handler } = await sessionWithEdition("Premier");
    const result = await handler({
      dateRange: { fromDate: "2025-01-01", toDate: "2025-12-31" },
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.statusCode).toBe(9003);
    expect(body.edition).toBe("Premier");
  });

  it("rejects with 9003 on PremierAccountant edition (sim default)", async () => {
    const { handler } = await sessionWithEdition("PremierAccountant");
    const result = await handler({
      dateRange: { fromDate: "2025-01-01", toDate: "2025-12-31" },
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.statusCode).toBe(9003);
    expect(body.edition).toBe("PremierAccountant");
  });

  it("passes the gate on Enterprise edition", async () => {
    const { handler } = await sessionWithEdition("Enterprise");
    const result = await handler({
      dateRange: { fromDate: "2025-01-01", toDate: "2025-12-31" },
    });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.entries).toBeDefined();
  });

  it("passes the gate on EnterpriseAccountant edition", async () => {
    const { handler } = await sessionWithEdition("EnterpriseAccountant");
    const result = await handler({
      dateRange: { fromDate: "2025-01-01", toDate: "2025-12-31" },
    });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
  });
});

describe("qb_audit_log tool — happy path", () => {
  it("dateRange scope returns the structured entry shape sorted desc by timeModified", async () => {
    const { handler } = await sessionWithEdition("Enterprise");
    const result = await handler({
      dateRange: { fromDate: "2025-01-01", toDate: "2025-12-31" },
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.success).toBe(true);
    expect(body.scope).toEqual({ dateRange: { fromDate: "2025-01-01", toDate: "2025-12-31" } });
    expect(body.fromDate).toBe("2025-01-01");
    expect(body.toDate).toBe("2025-12-31");
    expect(body.count).toBe(body.entries.length);
    expect(body.entries.length).toBeGreaterThanOrEqual(8);

    // Sort: most-recent-first
    for (let i = 1; i < body.entries.length; i++) {
      expect(body.entries[i - 1].timeModified >= body.entries[i].timeModified).toBe(true);
    }

    // Every entry has the required structured fields
    for (const e of body.entries) {
      expect(typeof e.user).toBe("string");
      expect(typeof e.timeModified).toBe("string");
      expect(typeof e.modifyType).toBe("string");
      expect(typeof e.txnId).toBe("string");
      expect(typeof e.txnType).toBe("string");
    }
  });

  it("Added entries omit changedField / oldValue / newValue", async () => {
    const { handler } = await sessionWithEdition("Enterprise");
    const result = await handler({
      dateRange: { fromDate: "2025-01-01", toDate: "2025-12-31" },
    });
    const body = JSON.parse(result.content[0].text);
    const addedEntries = (body.entries as Array<Record<string, unknown>>).filter(
      (e) => e.modifyType === "Added"
    );
    expect(addedEntries.length).toBeGreaterThan(0);
    for (const e of addedEntries) {
      expect(e.changedField).toBeUndefined();
      expect(e.oldValue).toBeUndefined();
      expect(e.newValue).toBeUndefined();
    }
  });

  it("Deleted entries omit changedField / oldValue / newValue", async () => {
    const { handler } = await sessionWithEdition("Enterprise");
    const result = await handler({
      dateRange: { fromDate: "2025-04-01", toDate: "2025-04-30" },
    });
    const body = JSON.parse(result.content[0].text);
    const deletedEntries = (body.entries as Array<Record<string, unknown>>).filter(
      (e) => e.modifyType === "Deleted"
    );
    expect(deletedEntries.length).toBeGreaterThan(0);
    for (const e of deletedEntries) {
      expect(e.changedField).toBeUndefined();
      expect(e.oldValue).toBeUndefined();
      expect(e.newValue).toBeUndefined();
    }
  });

  it("Modified entries surface changedField / oldValue / newValue", async () => {
    const { handler } = await sessionWithEdition("Enterprise");
    const result = await handler({
      dateRange: { fromDate: "2025-01-01", toDate: "2025-12-31" },
    });
    const body = JSON.parse(result.content[0].text);
    const modifiedEntries = (body.entries as Array<Record<string, unknown>>).filter(
      (e) => e.modifyType === "Modified"
    );
    expect(modifiedEntries.length).toBeGreaterThan(0);
    for (const e of modifiedEntries) {
      expect(typeof e.changedField).toBe("string");
      // Memo Added has empty old; we filter empty out, so some Modified entries
      // may omit oldValue when the seed's oldValue was "". Just verify newValue
      // is always populated on a Modified event.
      expect(typeof e.newValue).toBe("string");
    }
  });

  it("dateRange narrowing to April returns the 3 April events", async () => {
    const { handler } = await sessionWithEdition("Enterprise");
    const result = await handler({
      dateRange: { fromDate: "2025-04-01", toDate: "2025-04-30" },
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.count).toBe(3);
    for (const e of body.entries) {
      expect(String(e.timeModified).slice(0, 10) >= "2025-04-01").toBe(true);
      expect(String(e.timeModified).slice(0, 10) <= "2025-04-30").toBe(true);
    }
  });
});

describe("qb_audit_log tool — txnId scope", () => {
  it("txnId scope returns only entries matching that TxnID, post-filtered", async () => {
    const { handler } = await sessionWithEdition("Enterprise");
    // Seed has 3 entries for TXN-1001 (Added 03-01, Modified 03-05, Modified 04-12)
    const result = await handler({ txnId: "AUDIT-TXN-1001" });
    const body = JSON.parse(result.content[0].text);

    expect(body.success).toBe(true);
    expect(body.scope).toEqual({ txnId: "AUDIT-TXN-1001" });
    expect(body.count).toBe(3);
    for (const e of body.entries) {
      expect(e.txnId).toBe("AUDIT-TXN-1001");
    }
  });

  it("txnId scope returns empty when no entries match", async () => {
    const { handler } = await sessionWithEdition("Enterprise");
    const result = await handler({ txnId: "AUDIT-NONEXISTENT" });
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.count).toBe(0);
    expect(body.entries).toEqual([]);
  });

  it("txnId scope uses a 2-year default lookback window", async () => {
    const { handler } = await sessionWithEdition("Enterprise");
    const result = await handler({ txnId: "AUDIT-TXN-2001" });
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.fromDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.toDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Window spans ~2 years
    const from = new Date(body.fromDate + "T00:00:00Z").getTime();
    const to = new Date(body.toDate + "T00:00:00Z").getTime();
    const daySpan = (to - from) / (1000 * 60 * 60 * 24);
    expect(daySpan).toBeGreaterThan(700); // ≈ 2 years
    expect(daySpan).toBeLessThan(740);
  });
});
