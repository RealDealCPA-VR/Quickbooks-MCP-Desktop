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
import { buildQueryRequest, buildReportRequest } from "../src/qbxml/builder.js";

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
      IncludeLineItems: true,
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
      "IncludeLineItems",
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
      "IncludeLineItems",
    ]);
  });

  it("BillQueryRq: IncludeLineItems sits at the tail after PaidStatus", () => {
    // Canonical BillQueryRq <xs:sequence> tail (Phase 10 #41 — pinning the
    // IncludeLineItems position so a future filter-dict edit in
    // src/tools/bills.ts cannot silently slot IncludeLineItems before
    // PaidStatus / EntityFilter and re-introduce the schema-order bug class
    // for the bill list path.
    const xml = buildQueryRequest("Bill", {
      MaxReturned: 100,
      TxnDateRangeFilter: {
        FromTxnDate: "2026-01-01",
        ToTxnDate: "2026-12-31",
      },
      EntityFilter: { FullName: "Acme Vendor" },
      PaidStatus: "NotPaidOnly",
      IncludeLineItems: true,
    });

    const order = emittedChildOrder(xml, "BillQueryRq", [
      "MaxReturned",
      "TxnDateRangeFilter",
      "EntityFilter",
      "PaidStatus",
      "IncludeLineItems",
    ]);

    expect(order).toEqual([
      "MaxReturned",
      "TxnDateRangeFilter",
      "EntityFilter",
      "PaidStatus",
      "IncludeLineItems",
    ]);
  });

  it("EstimateQueryRq / SalesReceiptQueryRq / CreditMemoQueryRq / PurchaseOrderQueryRq: IncludeLineItems sits after EntityFilter (no PaidStatus in the sequence)", () => {
    // The four no-PaidStatus transaction queries share the same tail position
    // for IncludeLineItems: after EntityFilter, before IncludeLinkedTxns.
    // Looped because the body of each test is identical — the schema-order
    // contract is shared, and one regression suite per shape would just be
    // four near-duplicate cases.
    const types = [
      "Estimate",
      "SalesReceipt",
      "CreditMemo",
      "PurchaseOrder",
    ] as const;
    for (const type of types) {
      const xml = buildQueryRequest(type, {
        TxnID: "ABC-123",
        RefNumber: "REF-1",
        MaxReturned: 50,
        TxnDateRangeFilter: {
          FromTxnDate: "2026-01-01",
          ToTxnDate: "2026-12-31",
        },
        EntityFilter: { FullName: "Acme" },
        IncludeLineItems: true,
      });

      const order = emittedChildOrder(xml, `${type}QueryRq`, [
        "TxnID",
        "RefNumber",
        "MaxReturned",
        "TxnDateRangeFilter",
        "EntityFilter",
        "IncludeLineItems",
      ]);

      expect(order, `schema order broken for ${type}QueryRq`).toEqual([
        "TxnID",
        "RefNumber",
        "MaxReturned",
        "TxnDateRangeFilter",
        "EntityFilter",
        "IncludeLineItems",
      ]);
    }
  });

  it("JournalEntryQueryRq: IncludeLineItems sits after TxnDateRangeFilter", () => {
    // JournalEntryQueryRq tail order (per QBXML 16.0 schema):
    //   selectors → MaxReturned → ModifiedDateRangeFilter →
    //   TxnDateRangeFilter → EntityFilter → AccountFilter → RefNumberFilter
    //   → IncludeLineItems → IncludeLinkedTxns.
    // src/tools/journal-entries.ts emits the subset MaxReturned →
    // ModifiedDateRangeFilter → TxnDateRangeFilter → IncludeLineItems —
    // this test pins it.
    const xml = buildQueryRequest("JournalEntry", {
      TxnID: "JE-1",
      MaxReturned: 50,
      ModifiedDateRangeFilter: {
        FromModifiedDate: "2026-01-01T00:00:00",
        ToModifiedDate: "2026-12-31T23:59:59",
      },
      TxnDateRangeFilter: {
        FromTxnDate: "2026-01-01",
        ToTxnDate: "2026-12-31",
      },
      IncludeLineItems: true,
    });

    const order = emittedChildOrder(xml, "JournalEntryQueryRq", [
      "TxnID",
      "MaxReturned",
      "ModifiedDateRangeFilter",
      "TxnDateRangeFilter",
      "IncludeLineItems",
    ]);

    expect(order).toEqual([
      "TxnID",
      "MaxReturned",
      "ModifiedDateRangeFilter",
      "TxnDateRangeFilter",
      "IncludeLineItems",
    ]);
  });

  it("GeneralSummaryReportQueryRq: GeneralSummaryReportType → ReportPeriod → SummarizeColumnsBy → IncludeSubcolumns → ReportBasis", () => {
    // Canonical GeneralSummaryReportQueryRq <xs:sequence> order, position
    // numbers per the QBXML 16.0 SDK schema:
    //   1. GeneralSummaryReportType
    //   3. ReportPeriod
    //   13. SummarizeColumnsBy
    //   14. IncludeSubcolumns
    //   15. ReportBasis
    // Operator hit this on 2026-05-09: every qb_pnl_report call returned
    // statusCode -1 "QuickBooks found an error when parsing the provided XML
    // text stream" because buildReportRequest emitted ReportBasis at position
    // 3 — out of order, before SummarizeColumnsBy and IncludeSubcolumns.
    // Sim never re-emits XML so the regression was invisible until live.
    const xml = buildReportRequest({
      reportType: "ProfitAndLossStandard",
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      basis: "Accrual",
    });

    const order = emittedChildOrder(xml, "GeneralSummaryReportQueryRq", [
      "GeneralSummaryReportType",
      "ReportPeriod",
      "SummarizeColumnsBy",
      "IncludeSubcolumns",
      "ReportBasis",
    ]);

    expect(order).toEqual([
      "GeneralSummaryReportType",
      "ReportPeriod",
      "SummarizeColumnsBy",
      "IncludeSubcolumns",
      "ReportBasis",
    ]);
  });

  it("TransactionQueryRq: MaxReturned → TxnDateRangeFilter → AccountFilter", () => {
    // Canonical TransactionQueryRq <xs:sequence> order, position numbers per
    // the QBXML 16.0 SDK schema:
    //   1.  TxnID/TxnIDList (selectors)
    //   2.  RefNumber / RefNumberCaseSensitive
    //   3.  MaxReturned
    //   4.  ModifiedDateRangeFilter
    //   5.  TxnDateRangeFilter
    //   6.  EntityFilter
    //   7.  AccountFilter
    //   8.  RefNumberFilter
    //   9.  TransactionTypeFilter
    //   10. PostedFilter
    //   11. DetailLevel
    // src/tools/transactions.ts populates the filter dict in this exact order
    // (MaxReturned → TxnDateRangeFilter → AccountFilter for the subset it
    // exposes). This pins that the builder will emit it that way so future
    // edits cannot silently re-introduce the 2026-05-09 schema-order class
    // of bug — Phase 9 #37 was the same shape (ReportBasis at child position
    // 3 instead of 15).
    const xml = buildQueryRequest("Transaction", {
      MaxReturned: 500,
      TxnDateRangeFilter: {
        FromTxnDate: "2026-01-01",
        ToTxnDate: "2026-12-31",
      },
      AccountFilter: { FullName: "Rent Expense" },
    });

    const order = emittedChildOrder(xml, "TransactionQueryRq", [
      "MaxReturned",
      "TxnDateRangeFilter",
      "AccountFilter",
    ]);

    expect(order).toEqual([
      "MaxReturned",
      "TxnDateRangeFilter",
      "AccountFilter",
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
