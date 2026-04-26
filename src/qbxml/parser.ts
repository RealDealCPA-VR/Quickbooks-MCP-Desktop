/**
 * QBXML response parser.
 *
 * Parses QBXML response XML documents returned from QuickBooks Desktop
 * into structured TypeScript objects.
 */

import { XMLParser } from "fast-xml-parser";
import type { QBXMLResponse, QBXMLResponseBody } from "../types/qbxml.js";

// ---------------------------------------------------------------------------
// XML parser configuration
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseAttributeValue: true,
  trimValues: true,
  isArray: (name: string) => {
    // These elements should always be arrays even when there's only one
    return arrayElements.has(name);
  },
});

/** QBXML elements that can appear multiple times and must always be arrays. */
const arrayElements = new Set([
  "CustomerRet",
  "VendorRet",
  "AccountRet",
  "ItemServiceRet",
  "ItemInventoryRet",
  "ItemNonInventoryRet",
  "ItemOtherChargeRet",
  "ItemGroupRet",
  "InvoiceRet",
  "InvoiceLineRet",
  "BillRet",
  "BillLineRet",
  "ExpenseLineRet",
  "ItemLineRet",
  "PaymentRet",
  "ReceivePaymentRet",
  "BillPaymentCheckRet",
  "BillPaymentCreditCardRet",
  "AppliedToTxnRet",
  "EstimateRet",
  "EstimateLineRet",
  "EmployeeRet",
  "ClassRet",
  "SalesReceiptRet",
  "SalesReceiptLineRet",
  "CreditMemoRet",
  "CreditMemoLineRet",
  "PurchaseOrderRet",
  "PurchaseOrderLineRet",
  "JournalEntryRet",
  "DepositRet",
  "DepositLineRet",
  "TransferRet",
  "CheckRet",
  "SalesOrderRet",
  "SalesOrderLineRet",
  "ReportRet",
  "ColDesc",
  "DataRow",
  "ColData",
  "TextRow",
  "SubtotalRow",
  "TotalRow",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a QBXML response XML string into a structured QBXMLResponse.
 */
export function parseQBXMLResponse(xml: string): QBXMLResponse {
  const parsed = xmlParser.parse(xml);

  // Navigate to the response message set
  const qbxml = parsed?.QBXML;
  if (!qbxml) {
    throw new QBXMLParseError("Invalid QBXML response: missing <QBXML> root element");
  }

  const msgsRs = qbxml.QBXMLMsgsRs;
  if (!msgsRs) {
    throw new QBXMLParseError("Invalid QBXML response: missing <QBXMLMsgsRs> element");
  }

  const responses: QBXMLResponseBody[] = [];

  for (const [key, value] of Object.entries(msgsRs)) {
    if (key.startsWith("@_")) continue; // skip XML attributes

    const responseEntries = Array.isArray(value) ? value : [value];

    for (const entry of responseEntries) {
      if (typeof entry !== "object" || entry === null) continue;

      const entryObj = entry as Record<string, unknown>;
      const statusCode = Number(entryObj["@_statusCode"] ?? -1);
      const statusSeverity = String(entryObj["@_statusSeverity"] ?? "Error");
      const statusMessage = String(entryObj["@_statusMessage"] ?? "Unknown error");

      // Extract the data payload (everything that's not a status attribute)
      const data: Record<string, unknown> = {};
      for (const [dk, dv] of Object.entries(entryObj)) {
        if (!dk.startsWith("@_")) {
          data[dk] = dv;
        }
      }

      responses.push({
        type: key,
        statusCode,
        statusSeverity,
        statusMessage,
        data: Object.keys(data).length > 0 ? data : {},
      });
    }
  }

  return { responses };
}

/**
 * Extract the first successful response's data, or throw if all failed.
 */
export function extractResponseData(
  response: QBXMLResponse,
  expectedType?: string
): Record<string, unknown> | Record<string, unknown>[] {
  for (const rs of response.responses) {
    if (expectedType && rs.type !== expectedType) continue;
    if (rs.statusCode === 0 || rs.statusSeverity === "Info") {
      return rs.data;
    }
  }

  // Check for informational "no matches" (status code 1 = no data)
  for (const rs of response.responses) {
    if (expectedType && rs.type !== expectedType) continue;
    if (rs.statusCode === 1) {
      return {};
    }
  }

  const firstError = response.responses.find(
    (r) => r.statusSeverity === "Error"
  );
  throw new QBXMLResponseError(
    firstError?.statusMessage ?? "Unknown QBXML error",
    firstError?.statusCode ?? -1
  );
}

/**
 * Flatten entity arrays from a QBXML query response.
 * QBXML returns entities like { CustomerRet: [...] } — this extracts the array.
 */
export function flattenEntityArray(
  data: Record<string, unknown>,
  entityRetName: string
): Record<string, unknown>[] {
  const entities = data[entityRetName];
  if (!entities) return [];
  return Array.isArray(entities)
    ? (entities as Record<string, unknown>[])
    : [entities as Record<string, unknown>];
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class QBXMLParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QBXMLParseError";
  }
}

export class QBXMLResponseError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "QBXMLResponseError";
    this.statusCode = statusCode;
  }
}
