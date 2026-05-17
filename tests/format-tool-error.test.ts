// Phase 14 #65 — tool-side error wrapper tests.
//
// Two layers:
//   1. parseQbErrorHint — pure pattern matcher; one assertion per QB
//      error variant we've documented in todo.md #65.
//   2. formatToolError — the full payload-builder. Exercises the
//      humanReadable promotion path, the schemaOrder lookup, the extras
//      merge contract, and the degrade-gracefully behavior when the
//      thrown value is malformed.

import { describe, it, expect } from "vitest";
import {
  formatToolError,
  parseQbErrorHint,
} from "../src/util/format-tool-error.js";

function payloadOf(resp: ReturnType<typeof formatToolError>): Record<string, unknown> {
  return JSON.parse(resp.content[0].text) as Record<string, unknown>;
}

describe("parseQbErrorHint — pattern matcher", () => {
  it("missing-element: 'There is a missing element: NameFilter'", () => {
    const hint = parseQbErrorHint("There is a missing element: NameFilter");
    expect(hint).toEqual({ kind: "missing-element", field: "NameFilter" });
  });

  it("missing-element: 'The element <MaxReturned> is required'", () => {
    const hint = parseQbErrorHint("The element <MaxReturned> is required");
    expect(hint).toEqual({ kind: "missing-element", field: "MaxReturned" });
  });

  it("missing-element: 'A required field is missing: ReportPeriod'", () => {
    const hint = parseQbErrorHint("A required field is missing: ReportPeriod");
    expect(hint).toEqual({ kind: "missing-element", field: "ReportPeriod" });
  });

  it("invalid-argument: 'There is an invalid argument <ReportBasis>'", () => {
    const hint = parseQbErrorHint("There is an invalid argument <ReportBasis>");
    expect(hint).toEqual({ kind: "invalid-argument", field: "ReportBasis" });
  });

  it("invalid-argument: 'Invalid value for AccountType'", () => {
    const hint = parseQbErrorHint("Invalid value for AccountType");
    expect(hint).toEqual({ kind: "invalid-argument", field: "AccountType" });
  });

  it("invalid-argument: 'The value of PaidStatus is invalid'", () => {
    const hint = parseQbErrorHint("The value of PaidStatus is invalid");
    expect(hint).toEqual({ kind: "invalid-argument", field: "PaidStatus" });
  });

  it("out-of-order: 'Element <ReportBasis> is out of order'", () => {
    const hint = parseQbErrorHint("Element <ReportBasis> is out of order");
    expect(hint).toEqual({ kind: "out-of-order", field: "ReportBasis" });
  });

  it("out-of-order: 'out of order: SummarizeColumnsBy'", () => {
    const hint = parseQbErrorHint("element is out of order: SummarizeColumnsBy");
    expect(hint).toEqual({ kind: "out-of-order", field: "SummarizeColumnsBy" });
  });

  it("out-of-order specificity: 'invalid and out of order' kind = out-of-order, not invalid-argument", () => {
    // Defensive — the more specific kind must win. RULES order matters.
    const hint = parseQbErrorHint("Element <IncludeSubcolumns> is invalid and out of order");
    expect(hint?.kind).toBe("out-of-order");
    expect(hint?.field).toBe("IncludeSubcolumns");
  });

  it("invalid-ref: 'There is an invalid reference to QuickBooks Customer'", () => {
    const hint = parseQbErrorHint("There is an invalid reference to QuickBooks Customer");
    expect(hint).toEqual({ kind: "invalid-ref", field: "Customer" });
  });

  it("invalid-ref: 'CustomerListID does not exist'", () => {
    const hint = parseQbErrorHint("CustomerListID does not exist in QuickBooks");
    expect(hint).toEqual({ kind: "invalid-ref", field: "CustomerListID" });
  });

  it("empty-element: 'The element <NameFilter> is empty'", () => {
    const hint = parseQbErrorHint("The element <NameFilter> is empty");
    expect(hint).toEqual({ kind: "empty-element", field: "NameFilter" });
  });

  it("returns null for the bare parse-error message (no extractable field)", () => {
    const hint = parseQbErrorHint(
      "QuickBooks found an error when parsing the provided XML text stream"
    );
    expect(hint).toBeNull();
  });

  it("returns null for empty / undefined input", () => {
    expect(parseQbErrorHint("")).toBeNull();
    expect(parseQbErrorHint(undefined as unknown as string)).toBeNull();
  });

  it("returns null for messages with no recognized pattern", () => {
    expect(parseQbErrorHint("Some other QB error we have not seen")).toBeNull();
  });

  // Patterns added 2026-05-17 after Phase 14 #65 live verification against
  // VR Tax & Consulting Inc..qbw — QB's canonical wire form for invalid
  // enums and invalid object IDs surfaces the field name inside double
  // quotes via "the field "X"" syntax.
  it("invalid-argument: enumerated-value form (QB canonical live pattern)", () => {
    const hint = parseQbErrorHint(
      'The enumerated value "NotARealEnum" in the field "PaidStatus" is unknown or invalid for the qbXML version in use.',
    );
    expect(hint).toEqual({ kind: "invalid-argument", field: "PaidStatus" });
  });

  it("invalid-argument: provided-value form (QB canonical live pattern)", () => {
    const hint = parseQbErrorHint(
      'The provided value "xyz" in the field "ActiveStatus" is invalid.',
    );
    expect(hint).toEqual({ kind: "invalid-argument", field: "ActiveStatus" });
  });

  it("invalid-ref: object-ID form (QB canonical live pattern, captures the human field label)", () => {
    const hint = parseQbErrorHint(
      'The given object ID "BOGUS-TXN-ID" in the field "Transaction id" is invalid.',
    );
    expect(hint).toEqual({ kind: "invalid-ref", field: "Transaction id" });
  });
});

describe('formatToolError — display label → XML element normalization', () => {
  it("Transaction id label normalizes to TxnID for schemaOrder lookup, but hint.field keeps the original label", () => {
    const resp = formatToolError({
      message: 'The given object ID "X" in the field "Transaction id" is invalid.',
      statusCode: 3000,
    });
    const p = payloadOf(resp);
    const hint = p.hint as { kind: string; field: string; schemaOrder: { request: string }[] };
    expect(hint.kind).toBe("invalid-ref");
    // Surface the message-as-written so the agent sees the same label QB
    // used (matches the UI / docs).
    expect(hint.field).toBe("Transaction id");
    // But the lookup normalized to "TxnID" and surfaced the canonical
    // sequences for transaction-typed *QueryRq / *ModRq requests that
    // declare TxnID.
    expect(hint.schemaOrder.length).toBeGreaterThan(0);
    const requests = hint.schemaOrder.map((s) => s.request);
    expect(requests).toContain("InvoiceQueryRq");
  });
});

describe("formatToolError — response payload", () => {
  it("statusCode 3170 (known) → humanReadable from the code table, no hint", () => {
    const resp = formatToolError({
      message: "modify rejected",
      statusCode: 3170,
    });
    expect(resp.isError).toBe(true);
    const p = payloadOf(resp);
    expect(p.success).toBe(false);
    expect(p.statusCode).toBe(3170);
    expect(p.statusMessage).toBe("modify rejected");
    expect(p.humanReadable).toBe(
      "Modify rejected — record was changed since last read (stale EditSequence)"
    );
    expect(p.hint).toBeUndefined();
  });

  it("statusCode -1 + parseable message → hint with schema-order, humanReadable promoted from guidance", () => {
    const resp = formatToolError({
      message: "Element <ReportBasis> is out of order",
      statusCode: -1,
    });
    const p = payloadOf(resp);
    expect(p.statusCode).toBe(-1);
    expect(p.statusMessage).toBe("Element <ReportBasis> is out of order");
    expect(typeof p.humanReadable).toBe("string");
    expect(String(p.humanReadable)).toContain("ReportBasis");
    const hint = p.hint as { kind: string; field: string; schemaOrder: { request: string }[] };
    expect(hint.kind).toBe("out-of-order");
    expect(hint.field).toBe("ReportBasis");
    expect(hint.schemaOrder.length).toBeGreaterThan(0);
    // ReportBasis lives in the report request types.
    const reqs = hint.schemaOrder.map((s) => s.request);
    expect(reqs).toContain("GeneralSummaryReportQueryRq");
  });

  it("statusCode -1 + bare parse-error message → no hint, no humanReadable (degrades silently)", () => {
    const resp = formatToolError({
      message: "QuickBooks found an error when parsing the provided XML text stream",
      statusCode: -1,
    });
    const p = payloadOf(resp);
    expect(p.statusCode).toBe(-1);
    expect(p.statusMessage).toContain("parsing the provided XML");
    expect(p.humanReadable).toBeUndefined();
    expect(p.hint).toBeUndefined();
  });

  it("statusCode 3120 + parseable message → both humanReadable (from table) AND hint surface", () => {
    // 3120 is documented in the code table AND the message is heuristic-
    // matchable — both signals are useful, both should surface.
    const resp = formatToolError({
      message: "There is a missing element: NameFilter",
      statusCode: 3120,
    });
    const p = payloadOf(resp);
    expect(p.statusCode).toBe(3120);
    // humanReadable comes from the code table (not promoted from guidance).
    expect(p.humanReadable).toBe("Required field missing or invalid value");
    const hint = p.hint as { kind: string; field: string };
    expect(hint.kind).toBe("missing-element");
    expect(hint.field).toBe("NameFilter");
  });

  it("missing field surfaces canonical order for the request", () => {
    const resp = formatToolError({
      message: "There is a missing element: ReportPeriod",
      statusCode: -1,
    });
    const p = payloadOf(resp);
    const hint = p.hint as { schemaOrder: { request: string; sequence: string[] }[] };
    const summary = hint.schemaOrder.find((s) => s.request === "GeneralSummaryReportQueryRq");
    expect(summary).toBeDefined();
    expect(summary?.sequence).toContain("GeneralSummaryReportType");
    expect(summary?.sequence).toContain("ReportPeriod");
    expect(summary?.sequence).toContain("ReportBasis");
    // ReportPeriod sits BEFORE ReportBasis in the canonical sequence.
    const periodIdx = summary!.sequence.indexOf("ReportPeriod");
    const basisIdx = summary!.sequence.indexOf("ReportBasis");
    expect(periodIdx).toBeLessThan(basisIdx);
  });

  it("invalid-ref surfaces no schema-order when the field is not in any pinned sequence", () => {
    const resp = formatToolError({
      message: "There is an invalid reference to QuickBooks SomeUnknownField",
      statusCode: 500,
    });
    const p = payloadOf(resp);
    const hint = p.hint as { kind: string; field: string; schemaOrder: unknown[] };
    expect(hint.kind).toBe("invalid-ref");
    expect(hint.field).toBe("SomeUnknownField");
    expect(hint.schemaOrder).toEqual([]);
  });

  it("falls back to fallbackMessage when err.message is absent", () => {
    const resp = formatToolError(
      { statusCode: -1 },
      { fallbackMessage: "CustomerQueryRq failed" }
    );
    const p = payloadOf(resp);
    expect(p.statusMessage).toBe("CustomerQueryRq failed");
  });

  it("degrades gracefully on non-Error throws (null, undefined, string)", () => {
    for (const bad of [null, undefined, "raw string thrown"] as unknown[]) {
      const resp = formatToolError(bad, { fallbackMessage: "Op failed" });
      const p = payloadOf(resp);
      expect(p.success).toBe(false);
      expect(p.statusCode).toBe(-1);
      expect(typeof p.statusMessage).toBe("string");
    }
  });

  it("extras: non-reserved keys are merged into the payload", () => {
    const resp = formatToolError(
      { message: "boom", statusCode: -1 },
      { extra: { entries: [{ idx: 0, status: "rolled-back" }], atomic: true } }
    );
    const p = payloadOf(resp);
    expect(p.entries).toEqual([{ idx: 0, status: "rolled-back" }]);
    expect(p.atomic).toBe(true);
  });

  it("extras: reserved keys cannot be overridden", () => {
    const resp = formatToolError(
      { message: "boom", statusCode: 500 },
      {
        extra: {
          success: true, // attempt to flip
          statusCode: 0, // attempt to overwrite
          statusMessage: "spoofed",
          humanReadable: "fake",
          hint: { kind: "missing-element", field: "fake", schemaOrder: [], guidance: "fake" },
          // legitimate extra
          orphanedEntries: ["abc-123"],
        },
      }
    );
    const p = payloadOf(resp);
    expect(p.success).toBe(false); // not flipped
    expect(p.statusCode).toBe(500);
    expect(p.statusMessage).toBe("boom");
    expect(p.humanReadable).toBe("Object not found in QuickBooks");
    expect(p.hint).toBeUndefined(); // 500 with non-matching message has no hint
    expect(p.orphanedEntries).toEqual(["abc-123"]); // non-reserved extra preserved
  });

  it("ToolErrorResponse shape: content[0].type === 'text', isError true", () => {
    const resp = formatToolError({ message: "x", statusCode: -1 });
    expect(resp.isError).toBe(true);
    expect(resp.content).toHaveLength(1);
    expect(resp.content[0].type).toBe("text");
    expect(() => JSON.parse(resp.content[0].text)).not.toThrow();
  });

  it("read-only (9001) and idempotency-conflict (9002) synthetic codes still get humanReadable from table", () => {
    const ro = payloadOf(formatToolError({ message: "blocked", statusCode: 9001 }));
    expect(ro.humanReadable).toMatch(/Read-only session/);
    const idc = payloadOf(formatToolError({ message: "key clash", statusCode: 9002 }));
    expect(idc.humanReadable).toMatch(/Idempotency key conflict/);
  });
});
