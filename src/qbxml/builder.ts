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
export function buildSingleRequest(
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
