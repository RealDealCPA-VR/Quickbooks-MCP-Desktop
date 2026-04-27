/**
 * QBXML message builder.
 *
 * Constructs well-formed QBXML request documents from structured inputs.
 * The QBXML format is the standard message protocol for communicating
 * with QuickBooks Desktop via the SDK's session manager.
 */

import type { QBXMLRequest } from "../types/qbxml.js";

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
    lines.push(`    <${req.type} requestID="${requestID}">`);
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
  version?: string
): string {
  return buildSingleRequest(`${entityType}QueryRq`, filters, version);
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
 * Build a GeneralSummaryReportQueryRq for P&L / Balance Sheet style reports.
 *
 * Report rqs are structurally distinct from list/txn queries — they take
 * <ReportPeriod> / <ReportBasis> / <SummarizeColumnsBy> / <IncludeSubcolumns>
 * children rather than the entity-filter shape buildQueryRequest emits — so
 * they get their own builder rather than overloading buildQueryRequest.
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

  body.ReportBasis = params.basis ?? "Accrual";
  body.SummarizeColumnsBy = "TotalOnly";
  body.IncludeSubcolumns = 0;

  return buildSingleRequest("GeneralSummaryReportQueryRq", body, version);
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
