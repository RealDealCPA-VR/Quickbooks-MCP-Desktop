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
import {
  buildQueryRequest,
  buildQBXMLRequest,
  buildReportRequest,
  buildCustomDetailReportRequest,
  buildGeneralDetailReportRequest,
  buildPayrollSummaryReportRequest,
} from "../src/qbxml/builder.js";

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

  it("GeneralSummaryReportQueryRq StatementOfCashFlows: type → ReportPeriod → SummarizeColumnsBy → IncludeSubcolumns → ReportBasis", () => {
    // Phase 11 #54 — qb_statement_of_cash_flows rides the same buildReportRequest
    // emit path as P&L / BS, just with a different reportType payload. Pin
    // explicitly so a future SCF-specific child (e.g. a SummarizeColumnsBy
    // override) can't accidentally slot itself out of order. Schema position
    // for StatementOfCashFlows is identical to the other GeneralSummaryReport
    // types — no SCF-specific children in QBXML 16.0.
    const xml = buildReportRequest({
      reportType: "StatementOfCashFlows",
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
    expect(xml).toContain("<GeneralSummaryReportType>StatementOfCashFlows</GeneralSummaryReportType>");
  });

  it("GeneralSummaryReportQueryRq with ReportEntityFilter: type → ReportPeriod → ReportEntityFilter → SummarizeColumnsBy → IncludeSubcolumns → ReportBasis", () => {
    // Phase 11 #49 — qb_sales_by_customer_summary passes ReportEntityFilter
    // through buildReportRequest to scope SalesByCustomerSummary to one
    // customer. Schema-order: ReportEntityFilter sits between ReportPeriod
    // and the SummarizeColumnsBy / IncludeSubcolumns / ReportBasis tail.
    // Without an explicit pin here a future filter-dict edit could slot
    // ReportEntityFilter after ReportBasis and re-introduce the schema-order
    // bug class for SalesByCustomerSummary live calls.
    const xml = buildReportRequest({
      reportType: "SalesByCustomerSummary",
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      basis: "Accrual",
      entityFilter: { FullName: "Acme Corp" },
    });

    const order = emittedChildOrder(xml, "GeneralSummaryReportQueryRq", [
      "GeneralSummaryReportType",
      "ReportPeriod",
      "ReportEntityFilter",
      "SummarizeColumnsBy",
      "IncludeSubcolumns",
      "ReportBasis",
    ]);

    expect(order).toEqual([
      "GeneralSummaryReportType",
      "ReportPeriod",
      "ReportEntityFilter",
      "SummarizeColumnsBy",
      "IncludeSubcolumns",
      "ReportBasis",
    ]);

    // ReportEntityFilter contains the FullName child (or ListID — ListID
    // takes precedence when both are supplied).
    expect(xml).toContain("<FullName>Acme Corp</FullName>");

    // Backwards compatibility: when entityFilter is omitted, the emit shape
    // is identical to pre-#49 (the original P&L / BS shape that landed in
    // #37). The ReportEntityFilter element must NOT appear.
    const plain = buildReportRequest({
      reportType: "ProfitAndLossStandard",
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      basis: "Accrual",
    });
    expect(plain).not.toContain("ReportEntityFilter");
  });

  it("GeneralSummaryReportQueryRq with ReportItemFilter: type → ReportPeriod → ReportItemFilter → SummarizeColumnsBy → IncludeSubcolumns → ReportBasis", () => {
    // Phase 11 #50 — qb_sales_by_item_summary passes ReportItemFilter through
    // buildReportRequest to scope SalesByItemSummary to one item. Schema-order:
    // ReportItemFilter sits immediately after ReportEntityFilter (whether or
    // not the entity filter is present) and before the SummarizeColumnsBy /
    // IncludeSubcolumns / ReportBasis tail. Pin so a future filter-dict edit
    // can't slot ReportItemFilter after ReportBasis (same bug class as #37).
    const xml = buildReportRequest({
      reportType: "SalesByItemSummary",
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      basis: "Accrual",
      itemFilter: { FullName: "Consulting Services" },
    });

    const order = emittedChildOrder(xml, "GeneralSummaryReportQueryRq", [
      "GeneralSummaryReportType",
      "ReportPeriod",
      "ReportItemFilter",
      "SummarizeColumnsBy",
      "IncludeSubcolumns",
      "ReportBasis",
    ]);

    expect(order).toEqual([
      "GeneralSummaryReportType",
      "ReportPeriod",
      "ReportItemFilter",
      "SummarizeColumnsBy",
      "IncludeSubcolumns",
      "ReportBasis",
    ]);

    // Both filters present together (rare in practice, but the schema allows
    // it — e.g. "what did we sell of widget X to customer Y"). Pin the
    // EntityFilter-before-ItemFilter relative order.
    const both = buildReportRequest({
      reportType: "SalesByItemSummary",
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      basis: "Accrual",
      entityFilter: { FullName: "Acme Corp" },
      itemFilter: { FullName: "Consulting Services" },
    });
    const bothOrder = emittedChildOrder(both, "GeneralSummaryReportQueryRq", [
      "GeneralSummaryReportType",
      "ReportPeriod",
      "ReportEntityFilter",
      "ReportItemFilter",
      "SummarizeColumnsBy",
      "IncludeSubcolumns",
      "ReportBasis",
    ]);
    expect(bothOrder).toEqual([
      "GeneralSummaryReportType",
      "ReportPeriod",
      "ReportEntityFilter",
      "ReportItemFilter",
      "SummarizeColumnsBy",
      "IncludeSubcolumns",
      "ReportBasis",
    ]);

    // Backwards compatibility: omit itemFilter, the element must NOT appear.
    const plain = buildReportRequest({
      reportType: "ProfitAndLossStandard",
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      basis: "Accrual",
    });
    expect(plain).not.toContain("ReportItemFilter");
  });

  it("GeneralDetailReportQueryRq: type → ReportPeriod → ReportAccountFilter → ReportEntityFilter → ReportItemFilter → ReportModifiedDateRangeFilter → ReportBasis → IncludeColumn", () => {
    // Phase 11 #49 — qb_sales_by_customer_detail (and the planned Phase 11
    // #50/#52 sales/expense detail variants) ride on this new wire request.
    // Inferred from QBXML 16.0 SDK schema patterns; pin so future filter-dict
    // edits in buildGeneralDetailReportRequest can't silently re-introduce
    // the schema-order class of bug for the detail-report tools.
    //
    // The exact xs:sequence position numbers per the QBXML 16.0 SDK XSD have
    // not been verified line-by-line in this session — if live QBXMLRP2
    // surfaces statusCode -1 "found an error when parsing" against this
    // builder, that's the same class as the 2026-05-09 P&L bug (#37) and
    // the fix is to reorder children to match the actual XSD <xs:sequence>.
    const xml = buildGeneralDetailReportRequest({
      reportType: "SalesByCustomerDetail",
      fromDate: "2026-05-01",
      toDate: "2026-05-31",
      account: { FullName: "Sales Revenue" },
      entityFilter: { FullName: "Acme Corp" },
      itemFilter: { FullName: "Consulting" },
      fromModifiedDate: "2026-05-01",
      toModifiedDate: "2026-05-31",
      basis: "Accrual",
      includeColumns: ["TxnType", "Date", "Num", "Name", "Memo", "Amount"],
    });

    const order = emittedChildOrder(xml, "GeneralDetailReportQueryRq", [
      "GeneralDetailReportType",
      "ReportPeriod",
      "ReportAccountFilter",
      "ReportEntityFilter",
      "ReportItemFilter",
      "ReportModifiedDateRangeFilter",
      "ReportBasis",
      "IncludeColumn",
    ]);

    expect(order).toEqual([
      "GeneralDetailReportType",
      "ReportPeriod",
      "ReportAccountFilter",
      "ReportEntityFilter",
      "ReportItemFilter",
      "ReportModifiedDateRangeFilter",
      "ReportBasis",
      "IncludeColumn",
    ]);

    // Multiple <IncludeColumn> children — one per requested column. The
    // builder serializes string[] as repeated sibling elements (no wrapper).
    expect(xml.match(/<IncludeColumn>/g) ?? []).toHaveLength(6);
    expect(xml).toContain("<IncludeColumn>Amount</IncludeColumn>");

    // Bare-minimum emit (just type + basis, no filters) — pin that no
    // accidental empty filter elements appear when caller passes nothing.
    const bare = buildGeneralDetailReportRequest({
      reportType: "SalesByCustomerDetail",
    });
    expect(bare).toContain("<GeneralDetailReportType>SalesByCustomerDetail</GeneralDetailReportType>");
    expect(bare).toContain("<ReportBasis>Accrual</ReportBasis>");
    expect(bare).not.toContain("ReportAccountFilter");
    expect(bare).not.toContain("ReportEntityFilter");
    expect(bare).not.toContain("ReportItemFilter");
    expect(bare).not.toContain("ReportPeriod");
    expect(bare).not.toContain("ReportModifiedDateRangeFilter");
    expect(bare).not.toContain("IncludeColumn");
  });

  it("CustomDetailReportQueryRq: CustomDetailReportType → ReportPeriod → ReportAccountFilter → ReportClearedStatusFilter → ReportModifiedDateRangeFilter → ReportBasis → IncludeColumn", () => {
    // Phase 11 #56 + #56a — bank-rec read side. Pinning the emit order so
    // future filter-dict edits in src/qbxml/builder.ts can't silently
    // re-introduce the schema-order class of bug for the bank-rec read tools.
    // The exact xs:sequence position numbers per the QBXML 16.0 SDK XSD have
    // not been verified line-by-line in this session — if live QBXMLRP2
    // surfaces statusCode -1 "found an error when parsing" against this
    // builder, that's the same class as the 2026-05-09 P&L bug (#37) and
    // the fix is to reorder children to match the actual XSD <xs:sequence>.
    const xml = buildCustomDetailReportRequest({
      reportType: "CustomTxnDetail",
      fromDate: "2026-05-01",
      toDate: "2026-05-31",
      account: { FullName: "Checking" },
      clearedStatusFilter: "UnclearedOnly",
      fromModifiedDate: "2026-05-01",
      basis: "Accrual",
      includeColumns: ["TxnType", "Date", "Num", "Name", "Memo", "Amount", "ClearedStatus"],
    });

    const order = emittedChildOrder(xml, "CustomDetailReportQueryRq", [
      "CustomDetailReportType",
      "ReportPeriod",
      "ReportAccountFilter",
      "ReportClearedStatusFilter",
      "ReportModifiedDateRangeFilter",
      "ReportBasis",
      "IncludeColumn",
    ]);

    expect(order).toEqual([
      "CustomDetailReportType",
      "ReportPeriod",
      "ReportAccountFilter",
      "ReportClearedStatusFilter",
      "ReportModifiedDateRangeFilter",
      "ReportBasis",
      "IncludeColumn",
    ]);

    // Multiple <IncludeColumn> children — one per requested column. The
    // builder serializes string[] as repeated sibling elements (no wrapper).
    expect(xml.match(/<IncludeColumn>/g) ?? []).toHaveLength(7);
    expect(xml).toContain("<IncludeColumn>ClearedStatus</IncludeColumn>");
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

  it("multi-request envelope (Phase 10 #43 batch JE): N AddRq blocks, sequential requestIDs, single stopOnError envelope", () => {
    // Phase 10 #43 — qb_journal_entry_batch_create packs N JournalEntryAddRq
    // blocks into one envelope under <QBXMLMsgsRq onError="stopOnError">.
    // Each block must carry its own sequential requestID (the wire-side anchor
    // session.executeBatchAdd uses to align response slots back to input
    // index when the JournalEntryAddRs blocks come back). This test pins the
    // structural contract — same envelope pattern reused by #58 (batch
    // invoice/SR) when wired.
    const xml = buildQBXMLRequest({
      version: "16.0",
      requests: [
        {
          type: "JournalEntryAddRq",
          requestID: "1",
          body: {
            JournalEntryAdd: {
              JournalDebitLineAdd: [{ AccountRef: { FullName: "X" }, Amount: 1 }],
              JournalCreditLineAdd: [{ AccountRef: { FullName: "Y" }, Amount: 1 }],
            },
          },
        },
        {
          type: "JournalEntryAddRq",
          requestID: "2",
          body: {
            JournalEntryAdd: {
              JournalDebitLineAdd: [{ AccountRef: { FullName: "X" }, Amount: 2 }],
              JournalCreditLineAdd: [{ AccountRef: { FullName: "Y" }, Amount: 2 }],
            },
          },
        },
        {
          type: "JournalEntryAddRq",
          requestID: "3",
          body: {
            JournalEntryAdd: {
              JournalDebitLineAdd: [{ AccountRef: { FullName: "X" }, Amount: 3 }],
              JournalCreditLineAdd: [{ AccountRef: { FullName: "Y" }, Amount: 3 }],
            },
          },
        },
      ],
    });

    // Single envelope (one MsgsRq open + one close) — N requests share it,
    // they are NOT each in their own envelope.
    expect(xml.match(/<QBXMLMsgsRq /g) ?? []).toHaveLength(1);
    expect(xml.match(/<\/QBXMLMsgsRq>/g) ?? []).toHaveLength(1);
    // stopOnError is the only envelope mode the builder emits.
    expect(xml).toContain('<QBXMLMsgsRq onError="stopOnError">');

    // N AddRq blocks, each with sequential requestID.
    expect(xml.match(/<JournalEntryAddRq /g) ?? []).toHaveLength(3);
    const idMatches = [...xml.matchAll(/<JournalEntryAddRq requestID="(\d+)"/g)].map(
      (m) => m[1],
    );
    expect(idMatches).toEqual(["1", "2", "3"]);
  });

  it("PayrollSummaryReportQueryRq: PayrollSummaryReportType → ReportPeriod → SummarizeColumnsBy → ReportEntityFilter (Phase 11 #55)", () => {
    // Conservative subset of PayrollSummaryReportQueryRq's <xs:sequence>
    // emitted by buildPayrollSummaryReportRequest. Distinct from
    // GeneralSummaryReportQueryRq — different report-type discriminator
    // (PayrollSummaryReportType, not GeneralSummaryReportType) and no
    // ReportBasis child (payroll reports are inherently cash). The first
    // live exercise of qb_w2_summary may surface a schema-order rejection
    // (statusCode -1 "found an error when parsing") if the actual XSD
    // requires a different position for SummarizeColumnsBy or
    // ReportEntityFilter — same class as the 2026-05-09 #37 P&L bug. This
    // test pins the conservative subset so any future builder edit can't
    // re-introduce the regression class undetected.
    const xml = buildPayrollSummaryReportRequest({
      reportType: "EmployeeWagesTaxesAdjustments",
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
      entityFilter: { FullName: "Alice Johnson" },
    });

    const order = emittedChildOrder(xml, "PayrollSummaryReportQueryRq", [
      "PayrollSummaryReportType",
      "ReportPeriod",
      "SummarizeColumnsBy",
      "ReportEntityFilter",
    ]);

    expect(order).toEqual([
      "PayrollSummaryReportType",
      "ReportPeriod",
      "SummarizeColumnsBy",
      "ReportEntityFilter",
    ]);

    // Defensive: payroll reports are inherently cash — there is NO
    // ReportBasis child in PayrollSummaryReportQueryRq. If a future edit
    // accidentally adds one (e.g. via a copy-paste from buildReportRequest),
    // this assertion catches it before live mode rejects.
    expect(xml).not.toContain("<ReportBasis>");
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
