/**
 * Canonical QBXML <xs:sequence> child order for the request types this
 * server emits. Source of truth for two consumers:
 *
 *   1. `tests/builder-emit-order.test.ts` — asserts the builder serializes
 *      filter dicts in the order listed here. A future filter-dict edit in
 *      any tool that re-orders elements gets caught at the test layer
 *      instead of on the wire as a `statusCode -1` (the schema-order class
 *      of bug — Phase 9 #37 was the canonical case).
 *   2. `src/util/format-tool-error.ts` — when QB rejects a request with
 *      `"missing element: X"` / `"out of order: X"` / etc., the wrapper
 *      surfaces the canonical sequence to the agent so it can fix the
 *      offending payload without guesswork.
 *
 * Scope:
 *   - Sequences listed below are confirmed by the pinned tests + the
 *     filter dicts the tools actually populate (verified via grep — see
 *     the project-snapshot section in CLAUDE.md).
 *   - Each list is the SUBSET of the XSD <xs:sequence> the server uses.
 *     Fields not in the map don't break the heuristic — the wrapper still
 *     surfaces the offending field name, it just omits the `schemaOrder`
 *     candidates section.
 *   - Extending the map: add the new sequence here, add a pin in
 *     `tests/builder-emit-order.test.ts`, the wrapper picks it up
 *     automatically. Do NOT speculate about fields the tools don't use —
 *     the QBXML SDK's xs:sequence is the only authoritative source and
 *     adding fields without verifying their position risks misleading the
 *     agent into a worse fix.
 */

export const SCHEMA_ORDER: Record<string, readonly string[]> = {
  // -----------------------------------------------------------------------
  // List entity queries — the standard list filter shape.
  // -----------------------------------------------------------------------
  CustomerQueryRq: [
    "ListID",
    "FullName",
    "MaxReturned",
    "ActiveStatus",
    "FromModifiedDate",
    "ToModifiedDate",
    "NameFilter",
    "NameRangeFilter",
    "TotalBalanceFilter",
    "CurrencyFilter",
    "ClassFilter",
    "OwnerID",
    "IncludeRetElement",
  ],
  VendorQueryRq: [
    "ListID",
    "FullName",
    "MaxReturned",
    "ActiveStatus",
    "FromModifiedDate",
    "ToModifiedDate",
    "NameFilter",
    "NameRangeFilter",
    "TotalBalanceFilter",
    "CurrencyFilter",
    "OwnerID",
    "IncludeRetElement",
  ],
  EmployeeQueryRq: [
    "ListID",
    "FullName",
    "MaxReturned",
    "ActiveStatus",
    "FromModifiedDate",
    "ToModifiedDate",
    "NameFilter",
    "NameRangeFilter",
    "EmployeeType",
    "OwnerID",
    "IncludeRetElement",
  ],
  AccountQueryRq: [
    "ListID",
    "FullName",
    "MaxReturned",
    "ActiveStatus",
    "FromModifiedDate",
    "ToModifiedDate",
    "NameFilter",
    "NameRangeFilter",
    "AccountType",
    "CurrencyFilter",
    "OwnerID",
    "IncludeRetElement",
  ],
  // Item subtype queries — five variants sharing the same shape.
  ItemServiceQueryRq: [
    "ListID",
    "FullName",
    "MaxReturned",
    "ActiveStatus",
    "FromModifiedDate",
    "ToModifiedDate",
    "NameFilter",
    "NameRangeFilter",
    "OwnerID",
    "IncludeRetElement",
  ],
  ItemInventoryQueryRq: [
    "ListID",
    "FullName",
    "MaxReturned",
    "ActiveStatus",
    "FromModifiedDate",
    "ToModifiedDate",
    "NameFilter",
    "NameRangeFilter",
    "OwnerID",
    "IncludeRetElement",
  ],
  ItemNonInventoryQueryRq: [
    "ListID",
    "FullName",
    "MaxReturned",
    "ActiveStatus",
    "FromModifiedDate",
    "ToModifiedDate",
    "NameFilter",
    "NameRangeFilter",
    "OwnerID",
    "IncludeRetElement",
  ],
  ItemOtherChargeQueryRq: [
    "ListID",
    "FullName",
    "MaxReturned",
    "ActiveStatus",
    "FromModifiedDate",
    "ToModifiedDate",
    "NameFilter",
    "NameRangeFilter",
    "OwnerID",
    "IncludeRetElement",
  ],
  ItemGroupQueryRq: [
    "ListID",
    "FullName",
    "MaxReturned",
    "ActiveStatus",
    "FromModifiedDate",
    "ToModifiedDate",
    "NameFilter",
    "NameRangeFilter",
    "OwnerID",
    "IncludeRetElement",
  ],
  // List-shaped support entities (no NameFilter on some).
  ClassQueryRq: [
    "ListID",
    "FullName",
    "MaxReturned",
    "ActiveStatus",
    "FromModifiedDate",
    "ToModifiedDate",
    "NameFilter",
    "NameRangeFilter",
  ],
  StandardTermsQueryRq: [
    "ListID",
    "FullName",
    "MaxReturned",
    "ActiveStatus",
    "FromModifiedDate",
    "ToModifiedDate",
    "NameFilter",
    "NameRangeFilter",
  ],
  PaymentMethodQueryRq: [
    "ListID",
    "FullName",
    "MaxReturned",
    "ActiveStatus",
    "FromModifiedDate",
    "ToModifiedDate",
    "NameFilter",
    "NameRangeFilter",
  ],
  SalesRepQueryRq: [
    "ListID",
    "FullName",
    "MaxReturned",
    "ActiveStatus",
    "FromModifiedDate",
    "ToModifiedDate",
    "NameFilter",
    "NameRangeFilter",
  ],
  CustomerTypeQueryRq: [
    "ListID",
    "FullName",
    "MaxReturned",
    "ActiveStatus",
    "FromModifiedDate",
    "ToModifiedDate",
    "NameFilter",
    "NameRangeFilter",
  ],
  VendorTypeQueryRq: [
    "ListID",
    "FullName",
    "MaxReturned",
    "ActiveStatus",
    "FromModifiedDate",
    "ToModifiedDate",
    "NameFilter",
    "NameRangeFilter",
  ],
  SalesTaxCodeQueryRq: [
    "ListID",
    "FullName",
    "MaxReturned",
    "ActiveStatus",
    "FromModifiedDate",
    "ToModifiedDate",
    "NameFilter",
    "NameRangeFilter",
  ],
  ShipMethodQueryRq: [
    "ListID",
    "FullName",
    "MaxReturned",
    "ActiveStatus",
    "FromModifiedDate",
    "ToModifiedDate",
    "NameFilter",
    "NameRangeFilter",
  ],
  VehicleQueryRq: [
    "ListID",
    "FullName",
    "MaxReturned",
    "ActiveStatus",
    "FromModifiedDate",
    "ToModifiedDate",
    "NameFilter",
    "NameRangeFilter",
  ],

  // -----------------------------------------------------------------------
  // Transaction entity queries. The standard "AR-side" shape (Invoice, Bill)
  // carries the full filter set; the "no-PaidStatus" variants (Estimate,
  // SalesReceipt, CreditMemo, PurchaseOrder, SalesOrder) skip PaidStatus.
  // Pinned in tests/builder-emit-order.test.ts.
  // -----------------------------------------------------------------------
  InvoiceQueryRq: [
    "TxnID",
    "RefNumber",
    "MaxReturned",
    "ModifiedDateRangeFilter",
    "TxnDateRangeFilter",
    "EntityFilter",
    "AccountFilter",
    "RefNumberFilter",
    "CurrencyFilter",
    "PaidStatus",
    "IncludeLineItems",
    "IncludeLinkedTxns",
    "OwnerID",
  ],
  BillQueryRq: [
    "TxnID",
    "RefNumber",
    "MaxReturned",
    "ModifiedDateRangeFilter",
    "TxnDateRangeFilter",
    "EntityFilter",
    "AccountFilter",
    "RefNumberFilter",
    "CurrencyFilter",
    "PaidStatus",
    "IncludeLineItems",
    "IncludeLinkedTxns",
    "OwnerID",
  ],
  EstimateQueryRq: [
    "TxnID",
    "RefNumber",
    "MaxReturned",
    "ModifiedDateRangeFilter",
    "TxnDateRangeFilter",
    "EntityFilter",
    "AccountFilter",
    "RefNumberFilter",
    "CurrencyFilter",
    "IncludeLineItems",
    "IncludeLinkedTxns",
  ],
  SalesReceiptQueryRq: [
    "TxnID",
    "RefNumber",
    "MaxReturned",
    "ModifiedDateRangeFilter",
    "TxnDateRangeFilter",
    "EntityFilter",
    "AccountFilter",
    "RefNumberFilter",
    "CurrencyFilter",
    "IncludeLineItems",
    "IncludeLinkedTxns",
  ],
  CreditMemoQueryRq: [
    "TxnID",
    "RefNumber",
    "MaxReturned",
    "ModifiedDateRangeFilter",
    "TxnDateRangeFilter",
    "EntityFilter",
    "AccountFilter",
    "RefNumberFilter",
    "CurrencyFilter",
    "IncludeLineItems",
    "IncludeLinkedTxns",
  ],
  PurchaseOrderQueryRq: [
    "TxnID",
    "RefNumber",
    "MaxReturned",
    "ModifiedDateRangeFilter",
    "TxnDateRangeFilter",
    "EntityFilter",
    "AccountFilter",
    "RefNumberFilter",
    "CurrencyFilter",
    "IncludeLineItems",
    "IncludeLinkedTxns",
  ],
  SalesOrderQueryRq: [
    "TxnID",
    "RefNumber",
    "MaxReturned",
    "ModifiedDateRangeFilter",
    "TxnDateRangeFilter",
    "EntityFilter",
    "AccountFilter",
    "RefNumberFilter",
    "CurrencyFilter",
    "IncludeLineItems",
    "IncludeLinkedTxns",
  ],
  JournalEntryQueryRq: [
    "TxnID",
    "RefNumber",
    "MaxReturned",
    "ModifiedDateRangeFilter",
    "TxnDateRangeFilter",
    "EntityFilter",
    "AccountFilter",
    "RefNumberFilter",
    "IncludeLineItems",
    "IncludeLinkedTxns",
  ],
  // Banking transaction queries — same shape as the no-PaidStatus
  // transaction set.
  CheckQueryRq: [
    "TxnID",
    "RefNumber",
    "MaxReturned",
    "ModifiedDateRangeFilter",
    "TxnDateRangeFilter",
    "EntityFilter",
    "AccountFilter",
    "RefNumberFilter",
    "IncludeLineItems",
    "IncludeLinkedTxns",
  ],
  DepositQueryRq: [
    "TxnID",
    "MaxReturned",
    "ModifiedDateRangeFilter",
    "TxnDateRangeFilter",
    "EntityFilter",
    "AccountFilter",
    "IncludeLineItems",
    "IncludeLinkedTxns",
  ],
  TransferQueryRq: [
    "TxnID",
    "MaxReturned",
    "ModifiedDateRangeFilter",
    "TxnDateRangeFilter",
    "AccountFilter",
  ],
  CreditCardChargeQueryRq: [
    "TxnID",
    "RefNumber",
    "MaxReturned",
    "ModifiedDateRangeFilter",
    "TxnDateRangeFilter",
    "EntityFilter",
    "AccountFilter",
    "RefNumberFilter",
    "IncludeLineItems",
    "IncludeLinkedTxns",
  ],
  CreditCardCreditQueryRq: [
    "TxnID",
    "RefNumber",
    "MaxReturned",
    "ModifiedDateRangeFilter",
    "TxnDateRangeFilter",
    "EntityFilter",
    "AccountFilter",
    "RefNumberFilter",
    "IncludeLineItems",
    "IncludeLinkedTxns",
  ],
  ReceivePaymentQueryRq: [
    "TxnID",
    "RefNumber",
    "MaxReturned",
    "ModifiedDateRangeFilter",
    "TxnDateRangeFilter",
    "EntityFilter",
    "AccountFilter",
    "RefNumberFilter",
    "IncludeLineItems",
    "IncludeLinkedTxns",
  ],
  BillPaymentCheckQueryRq: [
    "TxnID",
    "RefNumber",
    "MaxReturned",
    "ModifiedDateRangeFilter",
    "TxnDateRangeFilter",
    "EntityFilter",
    "AccountFilter",
    "RefNumberFilter",
    "IncludeLineItems",
    "IncludeLinkedTxns",
  ],
  BillPaymentCreditCardQueryRq: [
    "TxnID",
    "RefNumber",
    "MaxReturned",
    "ModifiedDateRangeFilter",
    "TxnDateRangeFilter",
    "EntityFilter",
    "AccountFilter",
    "RefNumberFilter",
    "IncludeLineItems",
    "IncludeLinkedTxns",
  ],
  InventoryAdjustmentQueryRq: [
    "TxnID",
    "RefNumber",
    "MaxReturned",
    "ModifiedDateRangeFilter",
    "TxnDateRangeFilter",
    "EntityFilter",
    "AccountFilter",
    "RefNumberFilter",
    "IncludeLineItems",
    "IncludeLinkedTxns",
  ],
  StatementChargeQueryRq: [
    "TxnID",
    "RefNumber",
    "MaxReturned",
    "ModifiedDateRangeFilter",
    "TxnDateRangeFilter",
    "EntityFilter",
    "AccountFilter",
    "RefNumberFilter",
  ],
  TimeTrackingQueryRq: [
    "TxnID",
    "MaxReturned",
    "ModifiedDateRangeFilter",
    "TxnDateRangeFilter",
    "EntityFilter",
    "BillableStatus",
    "IncludeLinkedTxns",
  ],
  VehicleMileageQueryRq: [
    "TxnID",
    "MaxReturned",
    "TripDateRangeFilter",
    "EntityFilter",
    "VehicleFilter",
    "BillableStatus",
  ],

  // -----------------------------------------------------------------------
  // Cross-cutting + reports.
  // -----------------------------------------------------------------------
  TransactionQueryRq: [
    "TxnID",
    "TxnIDList",
    "RefNumber",
    "RefNumberCaseSensitive",
    "MaxReturned",
    "ModifiedDateRangeFilter",
    "TxnDateRangeFilter",
    "EntityFilter",
    "AccountFilter",
    "RefNumberFilter",
    "TransactionTypeFilter",
    "PostedFilter",
    "DetailLevel",
    "IncludeRetElement",
  ],
  GeneralSummaryReportQueryRq: [
    "GeneralSummaryReportType",
    "DisplayReport",
    "ReportPeriod",
    "ReportAccountFilter",
    "ReportEntityFilter",
    "ReportItemFilter",
    "ReportClassFilter",
    "ReportTxnTypeFilter",
    "ReportModifiedDateRangeFilter",
    "ReportDetailLevelFilter",
    "ReportPostingStatusFilter",
    "SummarizeRowsBy",
    "SummarizeColumnsBy",
    "IncludeSubcolumns",
    "ReportBasis",
    "ReportCalendar",
    "ReturnRows",
    "ReturnColumns",
  ],
  GeneralDetailReportQueryRq: [
    "GeneralDetailReportType",
    "DisplayReport",
    "ReportPeriod",
    "ReportAccountFilter",
    "ReportEntityFilter",
    "ReportItemFilter",
    "ReportClassFilter",
    "ReportTxnTypeFilter",
    "ReportModifiedDateRangeFilter",
    "ReportDetailLevelFilter",
    "ReportPostingStatusFilter",
    "SummarizeRowsBy",
    "ReportBasis",
    "ReportCalendar",
    "ReturnRows",
    "ReturnColumns",
    "IncludeColumn",
  ],
  CustomDetailReportQueryRq: [
    "CustomDetailReportType",
    "DisplayReport",
    "ReportPeriod",
    "ReportAccountFilter",
    "ReportEntityFilter",
    "ReportItemFilter",
    "ReportClassFilter",
    "ReportTxnTypeFilter",
    "ReportClearedStatusFilter",
    "ReportModifiedDateRangeFilter",
    "ReportDetailLevelFilter",
    "ReportPostingStatusFilter",
    "SummarizeRowsBy",
    "ReportBasis",
    "ReportCalendar",
    "ReturnRows",
    "ReturnColumns",
    "IncludeColumn",
  ],
  PayrollSummaryReportQueryRq: [
    // Order matches the inline-pinned subsequence in
    // tests/builder-emit-order.test.ts (Phase 11 #55): the conservative
    // subset emitted by buildPayrollSummaryReportRequest puts
    // SummarizeColumnsBy BEFORE ReportEntityFilter. Distinct from
    // GeneralSummaryReportQueryRq (which has the entity filter much
    // earlier in the sequence).
    "PayrollSummaryReportType",
    "DisplayReport",
    "ReportPeriod",
    "SummarizeRowsBy",
    "SummarizeColumnsBy",
    "IncludeSubcolumns",
    "ReportEntityFilter",
    "ReportCalendar",
    "ReturnRows",
    "ReturnColumns",
  ],
  DataExtDefQueryRq: ["OwnerID", "AssignToObject"],
  AttachableQueryRq: [
    "ListID",
    "ObjectFilter",
    "MaxReturned",
    "FromModifiedDate",
    "ToModifiedDate",
    "IncludeRetElement",
  ],
  HostQueryRq: [],
  CompanyQueryRq: [],
  PreferencesQueryRq: [],
};

/**
 * Reverse index from field name to the request types that declare it. Built
 * lazily on first lookup so import-time cost is zero — typical session never
 * hits the heuristic path.
 */
let fieldIndex: Map<string, string[]> | null = null;

function buildFieldIndex(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [reqType, fields] of Object.entries(SCHEMA_ORDER)) {
    for (const f of fields) {
      const list = out.get(f) ?? [];
      list.push(reqType);
      out.set(f, list);
    }
  }
  return out;
}

/**
 * Look up which request types declare a given field, plus their canonical
 * child sequence. Returns at most `limit` candidates (default 20) — the
 * heuristic surfaces these so an agent can identify which request type
 * its payload belongs to without guessing. A field like `OwnerID` appears
 * in ~15 request types; the default needs to cover that fan-out so the
 * agent sees the candidate matching its in-flight call.
 */
export function findSchemaOrderForField(
  field: string,
  limit = 20,
): { request: string; sequence: readonly string[] }[] {
  if (!fieldIndex) fieldIndex = buildFieldIndex();
  const requests = fieldIndex.get(field);
  if (!requests || requests.length === 0) return [];
  return requests.slice(0, limit).map((request) => ({
    request,
    sequence: SCHEMA_ORDER[request],
  }));
}

/**
 * Resolve the canonical schema-order for a specific request type. Returns
 * undefined when the request isn't in the map (caller should surface only
 * the field name in that case — no canonical order known).
 */
export function getSchemaOrder(requestType: string): readonly string[] | undefined {
  return SCHEMA_ORDER[requestType];
}

/**
 * Test-only reset of the lazily-built reverse index. Production never calls
 * this — the index is stable for the life of the process.
 */
export function resetSchemaOrderIndex(): void {
  fieldIndex = null;
}
