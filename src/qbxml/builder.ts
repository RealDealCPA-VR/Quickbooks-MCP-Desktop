/**
 * QBXML message builder.
 *
 * Constructs well-formed QBXML request documents from structured inputs.
 * The QBXML format is the standard message protocol for communicating
 * with QuickBooks Desktop via the SDK's session manager.
 */

import type { QBXMLRequest, QBXMLRequestBody } from "../types/qbxml.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>';
const QBXML_DOCTYPE =
  '<?qbxml version="__VERSION__"?>';
const DEFAULT_QBXML_VERSION = "16.0";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a complete QBXML request document string from structured input.
 *
 * Example output:
 * ```xml
 * <?xml version="1.0" encoding="utf-8"?>
 * <?qbxml version="16.0"?>
 * <QBXML>
 *   <QBXMLMsgsRq onError="stopOnError">
 *     <CustomerQueryRq requestID="1">
 *       <MaxReturned>100</MaxReturned>
 *     </CustomerQueryRq>
 *   </QBXMLMsgsRq>
 * </QBXML>
 * ```
 */
export function buildQBXMLRequest(request: QBXMLRequest): string {
  const version = request.version || DEFAULT_QBXML_VERSION;
  const lines: string[] = [
    XML_HEADER,
    QBXML_DOCTYPE.replace("__VERSION__", version),
    "<QBXML>",
    '  <QBXMLMsgsRq onError="stopOnError">',
  ];

  let autoId = 1;
  for (const req of request.requests) {
    const requestID = req.requestID ?? String(autoId++);
    const attrParts: string[] = [`requestID="${escapeXml(requestID)}"`];
    if (req.attributes) {
      for (const [k, v] of Object.entries(req.attributes)) {
        if (v === undefined || v === null) continue;
        attrParts.push(`${k}="${escapeXml(String(v))}"`);
      }
    }
    lines.push(`    <${req.type} ${attrParts.join(" ")}>`);
    lines.push(...serializeBody(req.body, 3));
    lines.push(`    </${req.type}>`);
  }

  lines.push("  </QBXMLMsgsRq>");
  lines.push("</QBXML>");

  return lines.join("\n");
}

/**
 * Build a single QBXML request body (convenience wrapper).
 */
function buildSingleRequest(
  type: string,
  body: Record<string, unknown>,
  version?: string
): string {
  return buildQBXMLRequest({
    version: version || DEFAULT_QBXML_VERSION,
    requests: [{ type, body }],
  });
}

// ---------------------------------------------------------------------------
// Request builders for common operations
// ---------------------------------------------------------------------------

export function buildQueryRequest(
  entityType: string,
  filters: Record<string, unknown> = {},
  options: {
    version?: string;
    iterator?: "Start" | "Continue" | "Stop";
    iteratorID?: string;
  } = {}
): string {
  const requestBody: QBXMLRequestBody = {
    type: `${entityType}QueryRq`,
    body: filters,
  };

  // Iterator state lives on the request element as XML attributes (per
  // Intuit's spec), NOT as child elements. The builder routes them through
  // QBXMLRequestBody.attributes so the request emits e.g.
  //   <CustomerQueryRq requestID="1" iterator="Continue" iteratorID="{...}">
  const attributes: Record<string, string> = {};
  if (options.iterator) attributes.iterator = options.iterator;
  if (options.iteratorID) attributes.iteratorID = options.iteratorID;
  if (Object.keys(attributes).length > 0) {
    requestBody.attributes = attributes;
  }

  return buildQBXMLRequest({
    version: options.version || DEFAULT_QBXML_VERSION,
    requests: [requestBody],
  });
}

export function buildAddRequest(
  entityType: string,
  data: Record<string, unknown>,
  version?: string
): string {
  const addBody: Record<string, unknown> = {};
  addBody[`${entityType}Add`] = data;
  return buildSingleRequest(`${entityType}AddRq`, addBody, version);
}

export function buildModRequest(
  entityType: string,
  data: Record<string, unknown>,
  version?: string
): string {
  const modBody: Record<string, unknown> = {};
  modBody[`${entityType}Mod`] = data;
  return buildSingleRequest(`${entityType}ModRq`, modBody, version);
}

/**
 * Build a ClearedStatusModRq envelope. Structural outlier — unlike entity-typed
 * *ModRq calls (CustomerMod, InvoiceMod, …), ClearedStatusMod targets a single
 * transaction (or line within one) and mutates only its cleared-status field.
 * It's the canonical bank-reconciliation primitive in the QBXML SDK; there is
 * no `ReconcileQueryRq` / `ReconcileAddRq` / `ReconcileModRq` (verified against
 * the qbxmlops130/140 schemas).
 *
 * Schema-required child order (QBXML 13.0+ SDK):
 *   TxnID → TxnLineID? → ClearedStatus
 * TxnLineID is optional — omit it to mark the whole transaction
 * (Check/Deposit/Transfer, where the header is the bank-affecting posting);
 * include it for split-line transactions where only one line cleared.
 *
 * ClearedStatus is one of three enum values: "Cleared", "NotCleared", "Pending"
 * (matches the QB Desktop reconciliation UI's three-state model).
 */
export function buildClearedStatusModRequest(
  params: {
    txnId: string;
    clearedStatus: "Cleared" | "NotCleared" | "Pending";
    txnLineId?: string;
  },
  version?: string
): string {
  const modBody: Record<string, unknown> = {
    TxnID: params.txnId,
  };
  if (params.txnLineId) modBody.TxnLineID = params.txnLineId;
  modBody.ClearedStatus = params.clearedStatus;
  return buildSingleRequest(
    "ClearedStatusModRq",
    { ClearedStatusMod: modBody },
    version
  );
}

/**
 * Build a GeneralSummaryReportQueryRq for P&L / Balance Sheet style reports.
 *
 * Report rqs are structurally distinct from list/txn queries — they take
 * <ReportPeriod> / <ReportBasis> / <SummarizeColumnsBy> / <IncludeSubcolumns>
 * children rather than the entity-filter shape buildQueryRequest emits — so
 * they get their own builder rather than overloading buildQueryRequest.
 *
 * Canonical GeneralSummaryReportQueryRq <xs:sequence> order (children that
 * land on the wire today, position numbers per the QBXML SDK schema):
 *   1.  GeneralSummaryReportType
 *   3.  ReportPeriod (FromReportDate, ToReportDate)
 *   13. SummarizeColumnsBy
 *   14. IncludeSubcolumns
 *   15. ReportBasis
 * Emitting ReportBasis BEFORE SummarizeColumnsBy/IncludeSubcolumns trips
 * QBXMLRP2 with statusCode -1 "found an error when parsing the provided XML
 * text stream" — same class as the 2026-05-09 Customer/Invoice schema-order
 * bugs. Pinned in tests/builder-emit-order.test.ts.
 *
 * `params` shape:
 *   { reportType, fromDate?, toDate?, basis? }
 * P&L uses fromDate + toDate. Balance Sheet treats toDate as the asOfDate
 * (real QB's BalanceSheet rqs use ToReportDate alone). Basis defaults to
 * Accrual. SummarizeColumnsBy defaults to TotalOnly and IncludeSubcolumns to
 * 0 — multi-period / class / customer slicing is out of Item 20 scope.
 */
export function buildReportRequest(
  params: {
    reportType: string;
    fromDate?: string;
    toDate?: string;
    basis?: "Accrual" | "Cash";
    entityFilter?: { FullName?: string; ListID?: string };
    itemFilter?: { FullName?: string; ListID?: string };
  },
  version?: string
): string {
  const body: Record<string, unknown> = {
    GeneralSummaryReportType: params.reportType,
  };

  const reportPeriod: Record<string, unknown> = {};
  if (params.fromDate) reportPeriod.FromReportDate = params.fromDate;
  if (params.toDate) reportPeriod.ToReportDate = params.toDate;
  if (Object.keys(reportPeriod).length > 0) {
    body.ReportPeriod = reportPeriod;
  }

  // ReportEntityFilter (Phase 11 #49) — narrows reports like SalesByCustomerSummary
  // to a single customer. Schema position is between ReportPeriod and the
  // SummarizeColumnsBy/IncludeSubcolumns/ReportBasis tail; emitting it here
  // preserves the canonical <xs:sequence> order pinned in
  // tests/builder-emit-order.test.ts. Skipped silently for P&L / BS calls that
  // don't pass it (existing emit shape unchanged).
  if (params.entityFilter) {
    const ef: Record<string, unknown> = {};
    if (params.entityFilter.ListID) ef.ListID = params.entityFilter.ListID;
    else if (params.entityFilter.FullName) ef.FullName = params.entityFilter.FullName;
    if (Object.keys(ef).length > 0) body.ReportEntityFilter = ef;
  }

  // ReportItemFilter (Phase 11 #50) — narrows reports like SalesByItemSummary to
  // a single item. Schema position is immediately after ReportEntityFilter
  // (same relative order as in GeneralDetailReportQueryRq, where they're
  // already pinned at positions 4/5). Skipped silently when not supplied.
  if (params.itemFilter) {
    const itf: Record<string, unknown> = {};
    if (params.itemFilter.ListID) itf.ListID = params.itemFilter.ListID;
    else if (params.itemFilter.FullName) itf.FullName = params.itemFilter.FullName;
    if (Object.keys(itf).length > 0) body.ReportItemFilter = itf;
  }

  body.SummarizeColumnsBy = "TotalOnly";
  body.IncludeSubcolumns = 0;
  body.ReportBasis = params.basis ?? "Accrual";

  return buildSingleRequest("GeneralSummaryReportQueryRq", body, version);
}

/**
 * Build a GeneralDetailReportQueryRq for per-line / per-transaction detail
 * reports — SalesByCustomerDetail, SalesByItemDetail, ExpensesByVendorDetail,
 * CustomerBalanceDetail, VendorBalanceDetail, ProfitAndLossDetail, etc. (Phase
 * 11 #49 lands the first of these — SalesByCustomerDetail — and the others
 * will plug into this same builder by passing different `reportType` values).
 *
 * Differs from buildCustomDetailReportRequest:
 *   - GeneralDetailReportType is a separate SDK enum from CustomDetailReportType
 *     — `SalesByCustomerDetail` is NOT a valid CustomDetailReportType value
 *     (verified the hard way; the operator paid for that lesson on #53).
 *   - Adds ReportEntityFilter / ReportItemFilter (customer/item scoping) that
 *     CustomDetailReportQueryRq lacks for the same purpose.
 *   - No ReportClearedStatusFilter (cleared-status is only meaningful on
 *     bank-account scoped reports, which is what CustomDetailReport handles).
 *
 * Schema-required <xs:sequence> emit order, inferred from QBXML 16.0 SDK
 * schema patterns and pinned in tests/builder-emit-order.test.ts:
 *   1.  GeneralDetailReportType
 *   2.  ReportPeriod (FromReportDate?, ToReportDate?)
 *   3.  ReportAccountFilter (FullName | ListID)
 *   4.  ReportEntityFilter (FullName | ListID)
 *   5.  ReportItemFilter (FullName | ListID)
 *   6.  ReportModifiedDateRangeFilter (FromModifiedDate?, ToModifiedDate?)
 *   7.  ReportBasis
 *   8.  IncludeColumn (repeated)
 *
 * NOTE: as with buildCustomDetailReportRequest, the exact schema-position
 * numbers per the QBXML 16.0 XSD have not been verified line-by-line in this
 * session. If live QBXMLRP2 surfaces statusCode -1 "found an error when
 * parsing" against this builder, the fix is to reorder children to match the
 * actual <xs:sequence> — same class as the 2026-05-09 #37 P&L schema-order
 * bug.
 */
export function buildGeneralDetailReportRequest(
  params: {
    reportType: string;
    fromDate?: string;
    toDate?: string;
    account?: { FullName?: string; ListID?: string };
    entityFilter?: { FullName?: string; ListID?: string };
    itemFilter?: { FullName?: string; ListID?: string };
    fromModifiedDate?: string;
    toModifiedDate?: string;
    basis?: "Accrual" | "Cash";
    includeColumns?: string[];
  },
  version?: string
): string {
  const body: Record<string, unknown> = {
    GeneralDetailReportType: params.reportType,
  };

  const reportPeriod: Record<string, unknown> = {};
  if (params.fromDate) reportPeriod.FromReportDate = params.fromDate;
  if (params.toDate) reportPeriod.ToReportDate = params.toDate;
  if (Object.keys(reportPeriod).length > 0) {
    body.ReportPeriod = reportPeriod;
  }

  if (params.account) {
    const acct: Record<string, unknown> = {};
    if (params.account.ListID) acct.ListID = params.account.ListID;
    else if (params.account.FullName) acct.FullName = params.account.FullName;
    if (Object.keys(acct).length > 0) body.ReportAccountFilter = acct;
  }

  if (params.entityFilter) {
    const ef: Record<string, unknown> = {};
    if (params.entityFilter.ListID) ef.ListID = params.entityFilter.ListID;
    else if (params.entityFilter.FullName) ef.FullName = params.entityFilter.FullName;
    if (Object.keys(ef).length > 0) body.ReportEntityFilter = ef;
  }

  if (params.itemFilter) {
    const itf: Record<string, unknown> = {};
    if (params.itemFilter.ListID) itf.ListID = params.itemFilter.ListID;
    else if (params.itemFilter.FullName) itf.FullName = params.itemFilter.FullName;
    if (Object.keys(itf).length > 0) body.ReportItemFilter = itf;
  }

  if (params.fromModifiedDate || params.toModifiedDate) {
    const mod: Record<string, unknown> = {};
    if (params.fromModifiedDate) mod.FromModifiedDate = params.fromModifiedDate;
    if (params.toModifiedDate) mod.ToModifiedDate = params.toModifiedDate;
    body.ReportModifiedDateRangeFilter = mod;
  }

  body.ReportBasis = params.basis ?? "Accrual";

  if (params.includeColumns && params.includeColumns.length > 0) {
    body.IncludeColumn = params.includeColumns;
  }

  return buildSingleRequest(
    "GeneralDetailReportQueryRq",
    body,
    version
  );
}

/**
 * Build a CustomDetailReportQueryRq for transaction-detail reports with
 * column-level control. Used by Phase 11 #56 + #56a (bank-rec read side) —
 * the only QBXML reporting surface that returns ClearedStatus per transaction
 * (not exposed as a field on any *Ret element nor as a filter on any *QueryRq).
 *
 * Differs from buildReportRequest (GeneralSummaryReportQueryRq):
 *   - Returns row-level transaction detail rather than account-level totals.
 *   - Supports per-column inclusion via repeated <IncludeColumn> children.
 *   - Supports a ReportClearedStatusFilter (UnclearedOnly / ClearedOnly / All)
 *     which GeneralSummaryReport does not.
 *
 * Schema-required <xs:sequence> emit order pinned in
 * tests/builder-emit-order.test.ts:
 *   1.  CustomDetailReportType
 *   2.  ReportPeriod (FromReportDate?, ToReportDate?)
 *   3.  ReportAccountFilter (FullName | ListID)
 *   4.  ReportClearedStatusFilter
 *   5.  ReportModifiedDateRangeFilter (FromModifiedDate?, ToModifiedDate?)
 *   6.  ReportBasis
 *   7.  IncludeColumn (repeated)
 * The exact schema position numbers per the QBXML 16.0 SDK XSD have not been
 * verified line-by-line against qbxmlops130/140 in this session — if live
 * QBXMLRP2 surfaces statusCode -1 "found an error when parsing" against this
 * builder, that's the same class of bug as the 2026-05-09 #37 P&L bug and
 * the fix is to reorder children to match the XSD's <xs:sequence>.
 */
export function buildCustomDetailReportRequest(
  params: {
    reportType?: string;
    fromDate?: string;
    toDate?: string;
    account?: { FullName?: string; ListID?: string };
    clearedStatusFilter?: "ClearedOnly" | "UnclearedOnly" | "All";
    fromModifiedDate?: string;
    toModifiedDate?: string;
    basis?: "Accrual" | "Cash";
    includeColumns?: string[];
  },
  version?: string
): string {
  const body: Record<string, unknown> = {
    CustomDetailReportType: params.reportType ?? "CustomTxnDetail",
  };

  const reportPeriod: Record<string, unknown> = {};
  if (params.fromDate) reportPeriod.FromReportDate = params.fromDate;
  if (params.toDate) reportPeriod.ToReportDate = params.toDate;
  if (Object.keys(reportPeriod).length > 0) {
    body.ReportPeriod = reportPeriod;
  }

  if (params.account) {
    const acct: Record<string, unknown> = {};
    // ListID-form takes precedence when both supplied — matches QB's behavior
    // (more specific selector wins).
    if (params.account.ListID) acct.ListID = params.account.ListID;
    else if (params.account.FullName) acct.FullName = params.account.FullName;
    if (Object.keys(acct).length > 0) body.ReportAccountFilter = acct;
  }

  if (params.clearedStatusFilter) {
    body.ReportClearedStatusFilter = params.clearedStatusFilter;
  }

  if (params.fromModifiedDate || params.toModifiedDate) {
    const mod: Record<string, unknown> = {};
    if (params.fromModifiedDate) mod.FromModifiedDate = params.fromModifiedDate;
    if (params.toModifiedDate) mod.ToModifiedDate = params.toModifiedDate;
    body.ReportModifiedDateRangeFilter = mod;
  }

  body.ReportBasis = params.basis ?? "Accrual";

  if (params.includeColumns && params.includeColumns.length > 0) {
    // Multiple <IncludeColumn> children — serializeBody emits arrays as
    // repeated sibling elements with the same tag name (each value wrapped
    // in its own <IncludeColumn>...</IncludeColumn>), which matches the
    // xs:sequence cardinality QBXML wants.
    body.IncludeColumn = params.includeColumns;
  }

  return buildSingleRequest(
    "CustomDetailReportQueryRq",
    body,
    version
  );
}

/**
 * Build a PayrollSummaryReportQueryRq for payroll/W-2 reporting (Phase 11 #55).
 *
 * Distinct from buildReportRequest (GeneralSummaryReportQueryRq):
 *   - Different request element + different report-type discriminator
 *     (`PayrollSummaryReportType`, not `GeneralSummaryReportType`).
 *   - Always cash-basis in real QB — there is no `ReportBasis` child on
 *     PayrollSummaryReportQueryRq (payroll reports are inherently cash).
 *   - Has `SummarizeColumnsBy="TotalOnly"` and a `ReportEntityFilter` for
 *     scoping to a single employee.
 *
 * Schema-required <xs:sequence> emit order, conservative subset (the report
 * supports more children — DisplayReport / IncludeColumn / SummarizeRowsBy —
 * but for the W-2 use case we only need these). Pinned in
 * tests/builder-emit-order.test.ts:
 *   1. PayrollSummaryReportType
 *   2. ReportPeriod (FromReportDate?, ToReportDate?)
 *   3. SummarizeColumnsBy
 *   4. ReportEntityFilter (FullName | ListID)
 *
 * NOTE: as with the other report builders, the exact schema-position numbers
 * per the QBXML 16.0 SDK XSD have not been verified line-by-line against
 * qbxmlops130/140 in this session — if live QBXMLRP2 surfaces statusCode -1
 * "found an error when parsing" against this builder, that's the same class
 * of bug as the 2026-05-09 #37 P&L bug; the fix is to reorder children to
 * match the actual XSD <xs:sequence>.
 */
export function buildPayrollSummaryReportRequest(
  params: {
    reportType: string;
    fromDate?: string;
    toDate?: string;
    entityFilter?: { FullName?: string; ListID?: string };
  },
  version?: string
): string {
  const body: Record<string, unknown> = {
    PayrollSummaryReportType: params.reportType,
  };

  const reportPeriod: Record<string, unknown> = {};
  if (params.fromDate) reportPeriod.FromReportDate = params.fromDate;
  if (params.toDate) reportPeriod.ToReportDate = params.toDate;
  if (Object.keys(reportPeriod).length > 0) {
    body.ReportPeriod = reportPeriod;
  }

  // SummarizeColumnsBy=TotalOnly mirrors buildReportRequest's default — single
  // total column per employee row. The W-2 use case is YTD totals; period
  // slicing is out of #55 scope.
  body.SummarizeColumnsBy = "TotalOnly";

  if (params.entityFilter) {
    const ef: Record<string, unknown> = {};
    if (params.entityFilter.ListID) ef.ListID = params.entityFilter.ListID;
    else if (params.entityFilter.FullName) ef.FullName = params.entityFilter.FullName;
    if (Object.keys(ef).length > 0) body.ReportEntityFilter = ef;
  }

  return buildSingleRequest("PayrollSummaryReportQueryRq", body, version);
}

export function buildDeleteRequest(
  entityType: string,
  listIdOrTxnId: string,
  version?: string
): string {
  // QB uses ListDelRq for list entities, TxnDelRq for transactions
  const isTransaction = [
    "Invoice",
    "Bill",
    "Payment",
    "Estimate",
    "SalesReceipt",
    "CreditMemo",
    "PurchaseOrder",
    "JournalEntry",
    "Deposit",
    "Transfer",
    "Check",
    "BillPaymentCheck",
    "BillPaymentCreditCard",
    "ReceivePayment",
    "SalesOrder",
    // Phase 11 #52 — kept in sync with isTransactionType in simulation-store
    "CreditCardCharge",
    "CreditCardCredit",
    // Phase 17 #78 — TimeTracking is a transaction in QB (carries TxnID +
    // EditSequence, deletes via TxnDelRq) even though it's non-posting (no
    // GL effect, no AR/AP movement). The three transaction-type lists across
    // builder.ts / manager.ts / simulation-store.ts must stay in sync.
    "TimeTracking",
    // Phase 17 #77 — SalesTaxPaymentCheck. Posted via SalesTaxPaymentCheckAddRq;
    // structurally a check (carries BankAccountRef + PayeeEntityRef + lines)
    // but its lines reduce sales-tax-item liability rather than expense GL.
    // Carries TxnID + EditSequence, deletes via TxnDelRq. Three lists in sync.
    "SalesTaxPaymentCheck",
    // Phase 17 #80 — InventoryAdjustment. Posted via InventoryAdjustmentAddRq;
    // each line adjusts one ItemInventory's QuantityOnHand and/or AverageCost
    // (via QuantityAdjustment / ValueAdjustment containers). Carries TxnID +
    // EditSequence, deletes via TxnDelRq. Three lists in sync.
    "InventoryAdjustment",
    // Phase 17 #81 — StatementCharge. Service-business T&M billing without a
    // formal invoice; structurally single-line (ItemRef + Quantity + Rate at
    // the txn header — no *LineAdd array, unlike Invoice/Bill). AR-posting
    // (Customer.Balance moves by +Amount on add, -Amount on delete). Carries
    // TxnID + EditSequence, deletes via TxnDelRq. Four lists in sync (the
    // three runtime arrays PLUS the CLAUDE.md doc list at line 58).
    "StatementCharge",
  ].includes(entityType);

  if (isTransaction) {
    return buildSingleRequest("TxnDelRq", {
      TxnDelType: entityType,
      TxnID: listIdOrTxnId,
    }, version);
  }

  return buildSingleRequest("ListDelRq", {
    ListDelType: entityType,
    ListID: listIdOrTxnId,
  }, version);
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function serializeBody(
  body: Record<string, unknown>,
  depth: number
): string[] {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      if (value.length === 0) {
        // Empty arrays still need a wire-level marker so the receiver can
        // distinguish "field present but empty" from "field absent". Without
        // this, e.g. qb_credit_memo_apply with applyTo: [] would strip
        // AppliedToTxnMod entirely and the simulation could not tell whether
        // the caller wanted to fully unapply (apply path) or had no apply
        // intent at all (update path with header-only changes).
        lines.push(`${indent}<${key}/>`);
      } else {
        for (const item of value) {
          if (typeof item === "object" && item !== null) {
            lines.push(`${indent}<${key}>`);
            lines.push(
              ...serializeBody(item as Record<string, unknown>, depth + 1)
            );
            lines.push(`${indent}</${key}>`);
          } else {
            lines.push(`${indent}<${key}>${escapeXml(String(item))}</${key}>`);
          }
        }
      }
    } else if (typeof value === "object") {
      lines.push(`${indent}<${key}>`);
      lines.push(
        ...serializeBody(value as Record<string, unknown>, depth + 1)
      );
      lines.push(`${indent}</${key}>`);
    } else if (typeof value === "boolean") {
      lines.push(`${indent}<${key}>${value ? "true" : "false"}</${key}>`);
    } else {
      lines.push(`${indent}<${key}>${escapeXml(String(value))}</${key}>`);
    }
  }

  return lines;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
