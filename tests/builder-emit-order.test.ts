// Builder emit-order regression test.
//
// QBXML schemas declare each *QueryRq's children as <xs:sequence>, meaning
// children must appear in a specific order on the wire. Out-of-order children
// are rejected by the live QBXMLRP2 parser with a cryptic "QuickBooks found an
// error when parsing the provided XML text stream" — the bug pattern hit
// twice on 2026-05-09 (CustomerQueryRq, then InvoiceQueryRq).
//
// SimulationStore.handleQuery does not re-serialize the request — it inspects
// the parsed filter object — so the simulation never surfaces this class of
// bug. The only place to pin it pre-live is at the builder layer: assert that
// buildQueryRequest emits children in the exact insertion order it received,
// and that tools therefore producing an ordered filter dict will round-trip
// to schema-compliant XML.

import { describe, it, expect } from "vitest";
import { buildQueryRequest } from "../src/qbxml/builder.js";

// Returns the names of `candidates` that appear inside the given request
// element, sorted by their position in the emitted XML.
function emittedChildOrder(
  xml: string,
  requestType: string,
  candidates: string[],
): string[] {
  const openMatch = xml.match(new RegExp(`<${requestType}\\b[^>]*>`));
  if (!openMatch || openMatch.index === undefined) {
    throw new Error(`opening <${requestType}> not found in emitted XML`);
  }
  const start = openMatch.index + openMatch[0].length;
  const end = xml.indexOf(`</${requestType}>`, start);
  if (end === -1) {
    throw new Error(`closing </${requestType}> not found in emitted XML`);
  }
  const inner = xml.slice(start, end);

  const positions: { name: string; pos: number }[] = [];
  for (const name of candidates) {
    const m = inner.match(new RegExp(`<${name}\\b`));
    if (m && m.index !== undefined) {
      positions.push({ name, pos: m.index });
    }
  }
  positions.sort((a, b) => a.pos - b.pos);
  return positions.map((p) => p.name);
}

describe("buildQueryRequest — emits children in insertion order (schema-order contract)", () => {
  it("CustomerQueryRq: ListID → MaxReturned → ActiveStatus → NameFilter", () => {
    // Canonical CustomerQueryRq filter sequence per qbxmlops.xml:
    //   ListID/FullName (selector) → MaxReturned → ActiveStatus →
    //   FromModifiedDate/ToModifiedDate → NameFilter/NameRangeFilter → tail.
    // The tool at src/tools/customers.ts populates the filter dict in this
    // exact order — this test pins that the builder will emit it that way.
    const xml = buildQueryRequest("Customer", {
      ListID: "80000001-1234567890",
      MaxReturned: 100,
      ActiveStatus: "ActiveOnly",
      NameFilter: { MatchCriterion: "Contains", Name: "Acme" },
    });

    const order = emittedChildOrder(xml, "CustomerQueryRq", [
      "ListID",
      "MaxReturned",
      "ActiveStatus",
      "NameFilter",
    ]);

    expect(order).toEqual([
      "ListID",
      "MaxReturned",
      "ActiveStatus",
      "NameFilter",
    ]);
  });

  it("InvoiceQueryRq: full transaction filter sequence in schema order", () => {
    // Canonical InvoiceQueryRq filter sequence per qbxmlops.xml:
    //   TxnID/RefNumber (selectors) → MaxReturned →
    //   ModifiedDateRangeFilter → TxnDateRangeFilter → EntityFilter →
    //   AccountFilter → RefNumberFilter → CurrencyFilter → PaidStatus →
    //   IncludeLineItems → IncludeLinkedTxns.
    // src/tools/invoices.ts populates a subset of these in this exact order;
    // this test pins it for the full sequence so future edits to the tool
    // (or to neighbouring transaction tools that share this sequence) cannot
    // re-introduce the 2026-05-09 schema-order bug undetected.
    const xml = buildQueryRequest("Invoice", {
      TxnID: "ABC-123",
      MaxReturned: 100,
      ModifiedDateRangeFilter: {
        FromModifiedDate: "2026-01-01",
        ToModifiedDate: "2026-12-31",
      },
      TxnDateRangeFilter: {
        FromTxnDate: "2026-01-01",
        ToTxnDate: "2026-12-31",
      },
      EntityFilter: { FullName: "Acme" },
      AccountFilter: { FullName: "Accounts Receivable" },
      RefNumberFilter: { MatchCriterion: "Contains", RefNumber: "INV" },
      CurrencyFilter: { ListID: "80000010-USD" },
      PaidStatus: "NotPaidOnly",
    });

    const order = emittedChildOrder(xml, "InvoiceQueryRq", [
      "TxnID",
      "MaxReturned",
      "ModifiedDateRangeFilter",
      "TxnDateRangeFilter",
      "EntityFilter",
      "AccountFilter",
      "RefNumberFilter",
      "CurrencyFilter",
      "PaidStatus",
    ]);

    expect(order).toEqual([
      "TxnID",
      "MaxReturned",
      "ModifiedDateRangeFilter",
      "TxnDateRangeFilter",
      "EntityFilter",
      "AccountFilter",
      "RefNumberFilter",
      "CurrencyFilter",
      "PaidStatus",
    ]);
  });

  it("preserves arbitrary insertion order — does not silently sort", () => {
    // Defensive: confirm the builder does not normalize key order via Map,
    // sort, or JSON-shape transform. Pass keys in non-canonical order and
    // assert they emit in that same non-canonical order. If a future refactor
    // routes filters through a structure that loses insertion order, this
    // test fails before the regression reaches live QB.
    const xml = buildQueryRequest("Customer", {
      NameFilter: { MatchCriterion: "Contains", Name: "Acme" },
      MaxReturned: 50,
      ListID: "ID-1",
      ActiveStatus: "ActiveOnly",
    });

    const order = emittedChildOrder(xml, "CustomerQueryRq", [
      "ListID",
      "MaxReturned",
      "ActiveStatus",
      "NameFilter",
    ]);

    expect(order).toEqual([
      "NameFilter",
      "MaxReturned",
      "ListID",
      "ActiveStatus",
    ]);
  });
});
