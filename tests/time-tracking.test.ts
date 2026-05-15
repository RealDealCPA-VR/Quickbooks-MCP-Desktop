// Phase 17 #78 — time tracking. qb_time_track_add + qb_time_track_list.
//
// Coverage layers:
//   1. Pure helpers — parseDurationToHours / formatHoursAsDuration.
//   2. Sim handler basics — TimeTracking add round-trips Duration + assigns
//      TxnID/EditSequence; seed loads 5 entries; EntityRef-based EntityFilter
//      scoping works in handleQuery.
//   3. qb_time_track_list — default count, txnId / date range / entityName /
//      customer post-filter / billableOnly / hours derivation / paginate.
//   4. qb_time_track_add — happy paths (hours, duration override),
//      validation errors (missing worker, missing duration, malformed
//      duration), idempotency replay + 9002, read-only gate.

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import {
  registerTimeTrackingTools,
  parseDurationToHours,
  formatHoursAsDuration,
} from "../src/tools/time-tracking.js";

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

function freshSession(): QBSessionManager {
  return new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-time-tracking",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

beforeEach(() => {
  handlers.clear();
});

// ---------------------------------------------------------------------------
// Layer 1 — pure helpers
// ---------------------------------------------------------------------------

describe("parseDurationToHours", () => {
  it("PT8H → 8", () => {
    expect(parseDurationToHours("PT8H")).toBe(8);
  });
  it("PT8H30M → 8.5", () => {
    expect(parseDurationToHours("PT8H30M")).toBe(8.5);
  });
  it("PT45M → 0.75", () => {
    expect(parseDurationToHours("PT45M")).toBe(0.75);
  });
  it("PT0H → 0", () => {
    expect(parseDurationToHours("PT0H")).toBe(0);
  });
  it("PT8H30M15S → 8.504166...", () => {
    const v = parseDurationToHours("PT8H30M15S")!;
    expect(v).toBeCloseTo(8.504166666666666, 10);
  });
  it("malformed (no PT prefix) → null", () => {
    expect(parseDurationToHours("8H")).toBeNull();
  });
  it("malformed (day component) → null", () => {
    expect(parseDurationToHours("P1D")).toBeNull();
  });
  it("malformed (free-form text) → null", () => {
    expect(parseDurationToHours("8 hours")).toBeNull();
  });
  it("empty PT → null (no H/M/S components)", () => {
    expect(parseDurationToHours("PT")).toBeNull();
  });
  it("non-string input → null", () => {
    expect(parseDurationToHours(undefined as never)).toBeNull();
    expect(parseDurationToHours(8 as never)).toBeNull();
  });
});

describe("formatHoursAsDuration", () => {
  it("8 → PT8H", () => {
    expect(formatHoursAsDuration(8)).toBe("PT8H");
  });
  it("8.5 → PT8H30M", () => {
    expect(formatHoursAsDuration(8.5)).toBe("PT8H30M");
  });
  it("0.75 → PT45M", () => {
    expect(formatHoursAsDuration(0.75)).toBe("PT45M");
  });
  it("0 → PT0H (pathological — keeps round-trip valid)", () => {
    expect(formatHoursAsDuration(0)).toBe("PT0H");
  });
  it("rounds sub-second drift to zero (0.0001 → PT0H)", () => {
    expect(formatHoursAsDuration(0.0001)).toBe("PT0H");
  });
  it("seconds emit when granular (8.5041666... → PT8H30M15S)", () => {
    expect(formatHoursAsDuration(8.504166666666666)).toBe("PT8H30M15S");
  });
  it("rejects negative input", () => {
    expect(() => formatHoursAsDuration(-1)).toThrow(/Invalid hours/);
  });
  it("rejects non-finite input", () => {
    expect(() => formatHoursAsDuration(Number.NaN)).toThrow(/Invalid hours/);
    expect(() => formatHoursAsDuration(Number.POSITIVE_INFINITY)).toThrow(/Invalid hours/);
  });
  it("round-trip: parse(format(h)) === h within rounding tolerance", () => {
    for (const h of [0, 0.25, 1, 1.5, 8, 8.5, 8.504166666666666, 40]) {
      const iso = formatHoursAsDuration(h);
      const back = parseDurationToHours(iso)!;
      expect(back).toBeCloseTo(h, 3);
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — sim handler basics
// ---------------------------------------------------------------------------

describe("SimulationStore — TimeTracking basics", () => {
  it("seed loads 5 sample entries", async () => {
    const session = freshSession();
    const rows = await session.queryEntity("TimeTracking", {});
    expect(rows.length).toBe(5);
  });

  it("add round-trips Duration + assigns TxnID/EditSequence", async () => {
    const session = freshSession();
    const tt = await session.addEntity("TimeTracking", {
      TxnDate: "2026-03-15",
      EntityRef: { ListID: "80000020-1234567890", FullName: "Alice Johnson" },
      Duration: "PT6H0M0S",
      Notes: "Test entry",
    });
    expect(tt.TxnID).toMatch(/-/);
    expect(tt.EditSequence).toBeTruthy();
    expect(tt.Duration).toBe("PT6H0M0S");
    expect(tt.Notes).toBe("Test entry");
    expect((tt.EntityRef as Record<string, unknown>).FullName).toBe("Alice Johnson");
  });

  it("EntityFilter scopes by EntityRef (worker) — strict improvement on EntityFilter handling", async () => {
    const session = freshSession();
    const rows = await session.queryEntity("TimeTracking", {
      EntityFilter: { FullName: "Alice Johnson" },
    });
    // Seed has 3 entries for Alice; should land exactly 3.
    expect(rows.length).toBe(3);
    for (const r of rows) {
      const ref = r.EntityRef as Record<string, unknown>;
      expect(ref.FullName).toBe("Alice Johnson");
    }
  });

  it("EntityFilter by ListID also matches against EntityRef", async () => {
    const session = freshSession();
    const rows = await session.queryEntity("TimeTracking", {
      EntityFilter: { ListID: "80000022-1234567890" },
    });
    // Seed has 1 entry for Carla (80000022).
    expect(rows.length).toBe(1);
    expect((rows[0].EntityRef as Record<string, unknown>).FullName).toBe("Carla Nguyen");
  });

  it("TxnDateRangeFilter narrows to one day", async () => {
    const session = freshSession();
    const rows = await session.queryEntity("TimeTracking", {
      TxnDateRangeFilter: { FromTxnDate: "2024-11-05", ToTxnDate: "2024-11-05" },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].TxnDate).toBe("2024-11-05");
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — qb_time_track_list
// ---------------------------------------------------------------------------

describe("qb_time_track_list tool", () => {
  it("default: returns count + entries from seed", async () => {
    const session = freshSession();
    registerTimeTrackingTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_time_track_list")!;

    const result = await handler({});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(5);
    expect(Array.isArray(payload.entries)).toBe(true);
  });

  it("each row carries derived hours field parsed from Duration", async () => {
    const session = freshSession();
    registerTimeTrackingTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_time_track_list")!;

    const result = await handler({});
    const payload = JSON.parse(result.content[0].text);
    // Find the Acme/Alice Q4 audit entry (PT8H = 8 hours)
    const acmeAudit = payload.entries.find(
      (e: Record<string, unknown>) => e.TxnID === "T0000001-TT",
    );
    expect(acmeAudit.hours).toBe(8);
    // Find the PT6H30M entry → 6.5
    const fieldwork = payload.entries.find(
      (e: Record<string, unknown>) => e.TxnID === "T0000002-TT",
    );
    expect(fieldwork.hours).toBe(6.5);
    // Find the PT4H15M entry → 4.25
    const tax = payload.entries.find(
      (e: Record<string, unknown>) => e.TxnID === "T0000003-TT",
    );
    expect(tax.hours).toBe(4.25);
  });

  it("txnId filter narrows to one", async () => {
    const session = freshSession();
    registerTimeTrackingTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_time_track_list")!;

    const result = await handler({ txnId: "T0000001-TT" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.entries[0].TxnID).toBe("T0000001-TT");
  });

  it("entityName filter scopes server-side via EntityFilter (worker)", async () => {
    const session = freshSession();
    registerTimeTrackingTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_time_track_list")!;

    const result = await handler({ entityName: "Alice Johnson" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(3);
    for (const e of payload.entries) {
      expect(e.EntityRef.FullName).toBe("Alice Johnson");
    }
  });

  it("entityListId filter scopes by worker ListID", async () => {
    const session = freshSession();
    registerTimeTrackingTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_time_track_list")!;

    const result = await handler({ entityListId: "80000021-1234567890" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.entries[0].EntityRef.FullName).toBe("Bob Martinez");
  });

  it("customerName filter post-filters by CustomerRef", async () => {
    const session = freshSession();
    registerTimeTrackingTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_time_track_list")!;

    const result = await handler({ customerName: "Acme Corporation" });
    const payload = JSON.parse(result.content[0].text);
    // Seed has 2 entries against Acme.
    expect(payload.count).toBe(2);
    for (const e of payload.entries) {
      expect(e.CustomerRef.FullName).toBe("Acme Corporation");
    }
  });

  it("customerListId filter post-filters by CustomerRef ListID", async () => {
    const session = freshSession();
    registerTimeTrackingTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_time_track_list")!;

    const result = await handler({ customerListId: "80000002-1234567890" });
    const payload = JSON.parse(result.content[0].text);
    // Globex Inc / Global Industries — 1 entry.
    expect(payload.count).toBe(1);
    expect(payload.entries[0].CustomerRef.FullName).toBe("Global Industries");
  });

  it("customer filter drops entries without CustomerRef (Bob's internal admin)", async () => {
    const session = freshSession();
    registerTimeTrackingTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_time_track_list")!;

    const result = await handler({ customerName: "Acme Corporation" });
    const payload = JSON.parse(result.content[0].text);
    // The internal-admin entry (TxnID T0000004-TT, no CustomerRef) and the
    // Carla payroll-tracking entry (T0000005-TT, no CustomerRef) drop.
    const ids = payload.entries.map((e: Record<string, unknown>) => e.TxnID);
    expect(ids).not.toContain("T0000004-TT");
    expect(ids).not.toContain("T0000005-TT");
  });

  it("date range filter narrows to one day", async () => {
    const session = freshSession();
    registerTimeTrackingTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_time_track_list")!;

    const result = await handler({
      fromDate: "2024-11-06",
      toDate: "2024-11-06",
    });
    const payload = JSON.parse(result.content[0].text);
    // Seed has 2 entries on 2024-11-06 (Global Industries + Bob's admin).
    expect(payload.count).toBe(2);
    for (const e of payload.entries) {
      expect(e.TxnDate).toBe("2024-11-06");
    }
  });

  it("billableOnly:true drops non-billable entries (post-filter)", async () => {
    const session = freshSession();
    registerTimeTrackingTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_time_track_list")!;

    const result = await handler({ billableOnly: true });
    const payload = JSON.parse(result.content[0].text);
    // 3 billable entries (Alice x2 + Alice's Globex). Bob's admin + Carla's
    // unlabeled timesheet have IsBillable !== true.
    expect(payload.count).toBe(3);
    for (const e of payload.entries) {
      expect(e.IsBillable).toBe(true);
    }
  });

  it("paginate:true auto-defaults maxReturned + surfaces iteratorRemainingCount", async () => {
    const session = freshSession();
    registerTimeTrackingTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_time_track_list")!;

    const result = await handler({ paginate: true });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(5);
    expect(payload.iteratorRemainingCount).toBe(0);
    expect(payload.iteratorID).toMatch(/^SIM-ITER-/);
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — qb_time_track_add
// ---------------------------------------------------------------------------

describe("qb_time_track_add tool", () => {
  it("happy path with hours: converts decimal to PT-H-M-S, sets refs", async () => {
    const session = freshSession();
    registerTimeTrackingTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_time_track_add")!;

    const result = await handler({
      txnDate: "2026-03-15",
      entityName: "Alice Johnson",
      customerName: "Acme Corporation",
      itemServiceName: "Consulting Services",
      hours: 7.5,
      notes: "Q1 review meeting",
      billable: true,
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.timeTracking.Duration).toBe("PT7H30M");
    expect(payload.timeTracking.hours).toBe(7.5);
    expect(payload.timeTracking.EntityRef.FullName).toBe("Alice Johnson");
    expect(payload.timeTracking.CustomerRef.FullName).toBe("Acme Corporation");
    expect(payload.timeTracking.ItemServiceRef.FullName).toBe("Consulting Services");
    expect(payload.timeTracking.IsBillable).toBe(true);
    expect(payload.timeTracking.BillableStatus).toBe("Billable");
    expect(payload.timeTracking.Notes).toBe("Q1 review meeting");
    expect(payload.timeTracking.TxnID).toBeTruthy();
  });

  it("happy path with duration override (wins over hours)", async () => {
    const session = freshSession();
    registerTimeTrackingTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_time_track_add")!;

    const result = await handler({
      entityName: "Alice Johnson",
      hours: 1, // ignored
      duration: "PT4H45M",
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.timeTracking.Duration).toBe("PT4H45M");
    expect(payload.timeTracking.hours).toBe(4.75);
  });

  it("billable:false emits BillableStatus='NotBillable'", async () => {
    const session = freshSession();
    registerTimeTrackingTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_time_track_add")!;

    const result = await handler({
      entityName: "Bob Martinez",
      hours: 2,
      billable: false,
      notes: "Internal admin",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.timeTracking.IsBillable).toBe(false);
    expect(payload.timeTracking.BillableStatus).toBe("NotBillable");
  });

  it("billable unset leaves IsBillable/BillableStatus absent (default state)", async () => {
    const session = freshSession();
    registerTimeTrackingTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_time_track_add")!;

    const result = await handler({
      entityName: "Carla Nguyen",
      hours: 8,
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.timeTracking.IsBillable).toBeUndefined();
    expect(payload.timeTracking.BillableStatus).toBeUndefined();
  });

  it("rejects when entityName / entityListId missing", async () => {
    const session = freshSession();
    registerTimeTrackingTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_time_track_add")!;

    const result = await handler({
      hours: 1,
    } as unknown);
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/entityName|entityListId/);
  });

  it("rejects when both hours and duration missing", async () => {
    const session = freshSession();
    registerTimeTrackingTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_time_track_add")!;

    const result = await handler({
      entityName: "Alice Johnson",
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/hours|duration/);
  });

  it("entityListId form works (LISTID ref shape)", async () => {
    const session = freshSession();
    registerTimeTrackingTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_time_track_add")!;

    const result = await handler({
      entityListId: "80000020-1234567890",
      hours: 3,
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.timeTracking.EntityRef.ListID).toBe("80000020-1234567890");
    // ListID-form ref should NOT also carry FullName from the operator
    expect(payload.timeTracking.EntityRef.FullName).toBeUndefined();
  });

  it("payrollItemWageName and className refs round-trip", async () => {
    const session = freshSession();
    registerTimeTrackingTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_time_track_add")!;

    const result = await handler({
      entityName: "Alice Johnson",
      hours: 8,
      className: "Audit",
      payrollItemWageName: "Hourly Wages",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.timeTracking.ClassRef.FullName).toBe("Audit");
    expect(payload.timeTracking.PayrollItemWageRef.FullName).toBe("Hourly Wages");
  });

  it("idempotencyKey replay: same key + same payload returns idempotentReplay", async () => {
    const session = freshSession();
    registerTimeTrackingTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_time_track_add")!;

    const args = {
      entityName: "Alice Johnson",
      hours: 4,
      idempotencyKey: "tt-key-001",
    };
    const first = await handler(args);
    const firstPayload = JSON.parse(first.content[0].text);
    const second = await handler(args);
    const secondPayload = JSON.parse(second.content[0].text);
    expect(secondPayload.idempotentReplay).toBe(true);
    expect(secondPayload.timeTracking.TxnID).toBe(firstPayload.timeTracking.TxnID);
    // No duplicate created — seed has 5, plus the one replay = 6.
    const all = await session.queryEntity("TimeTracking", {});
    expect(all.length).toBe(6);
  });

  it("idempotencyKey conflict surfaces 9002", async () => {
    const session = freshSession();
    registerTimeTrackingTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_time_track_add")!;

    await handler({
      entityName: "Alice Johnson",
      hours: 4,
      idempotencyKey: "tt-conflict",
    });
    const second = await handler({
      entityName: "Alice Johnson",
      hours: 8, // different payload — different hours
      idempotencyKey: "tt-conflict",
    });
    expect(second.isError).toBe(true);
    const payload = JSON.parse(second.content[0].text);
    expect(payload.statusCode).toBe(9002);
  });

  it("read-only session rejects with 9001 (no wire I/O)", async () => {
    const session = freshSession();
    session.setReadOnly(true);
    registerTimeTrackingTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_time_track_add")!;

    const result = await handler({
      entityName: "Alice Johnson",
      hours: 4,
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(9001);
    // Seed stays untouched.
    const all = await session.queryEntity("TimeTracking", {});
    expect(all.length).toBe(5);
  });
});
