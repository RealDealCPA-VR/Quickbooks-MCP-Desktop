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
  "StandardTermsRet",
  "DateDrivenTermsRet",
  "PaymentMethodRet",
  "SalesRepRet",
  "CustomerTypeRet",
  "VendorTypeRet",
  "SalesReceiptRet",
  "SalesReceiptLineRet",
  "CreditMemoRet",
  "CreditMemoLineRet",
  "PurchaseOrderRet",
  "PurchaseOrderLineRet",
  "JournalEntryRet",
  "JournalDebitLineRet",
  "JournalCreditLineRet",
  "DepositRet",
  "DepositLineRet",
  "TransferRet",
  "CheckRet",
  "SalesOrderRet",
  "SalesOrderLineRet",
  "TransactionRet",
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
      // The requestID attribute QB echoes back on every *Rs element. Used by
      // batch callers (Phase 10 #43) to align N responses to N input requests
      // when they share a *Rs name.
      const requestID =
        entryObj["@_requestID"] !== undefined
          ? String(entryObj["@_requestID"])
          : undefined;

      // Extract the data payload (everything that's not a status attribute)
      const data: Record<string, unknown> = {};
      for (const [dk, dv] of Object.entries(entryObj)) {
        if (!dk.startsWith("@_")) {
          data[dk] = dv;
        }
      }

      // Iterator metadata on *QueryRs envelopes (Item 27). Real QB caps
      // *QueryRq responses at ~500 rows by default and surfaces these
      // attributes on the response element to drive paged continuation.
      // parseAttributeValue: true coerces the count to a number for us.
      const iteratorRemainingCount =
        entryObj["@_iteratorRemainingCount"] !== undefined
          ? Number(entryObj["@_iteratorRemainingCount"])
          : undefined;
      const iteratorID =
        entryObj["@_iteratorID"] !== undefined
          ? String(entryObj["@_iteratorID"])
          : undefined;

      responses.push({
        type: key,
        statusCode,
        statusSeverity,
        statusMessage,
        data: Object.keys(data).length > 0 ? data : {},
        ...(requestID !== undefined ? { requestID } : {}),
        ...(iteratorRemainingCount !== undefined ? { iteratorRemainingCount } : {}),
        ...(iteratorID !== undefined ? { iteratorID } : {}),
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
 * Extract the ReportRet block from a report-style response (e.g.
 * GeneralSummaryReportQueryRs). Mirrors extractResponseData semantics —
 * scoped to a specific *Rs type, throws QBXMLResponseError on hard failure,
 * returns {} on the "no data" status (1) — but pulls out the embedded
 * <ReportRet> object rather than the raw response data block.
 *
 * Both modes return the same simplified shape:
 *   { ReportTitle, ReportBasis, ReportSubtitle?, FromReportDate?,
 *     ToReportDate?, AsOfDate?, Sections: [{ Name, Accounts: [{Name, Total}],
 *     Subtotal }], Totals: { ... } }
 *
 * Simulation builds this shape directly (see simulation-store.handleReportQuery).
 * Live mode receives QB's row-tree (TextRow / DataRow / SubtotalRow / TotalRow
 * under ReportData) and is translated by adaptLiveReportRet. Detection: the
 * presence of `ReportData` indicates live shape; `Sections` indicates sim shape.
 */
export function extractReportData(
  response: QBXMLResponse,
  expectedType?: string
): Record<string, unknown> {
  const data = extractResponseData(response, expectedType);
  const obj = Array.isArray(data) ? data[0] ?? {} : data;
  const reportRet = (obj as Record<string, unknown>).ReportRet;
  if (!reportRet) return {};
  const ret = (Array.isArray(reportRet) ? reportRet[0] : reportRet) as
    | Record<string, unknown>
    | undefined;
  if (!ret) return {};
  if (ret.ReportData && !ret.Sections) {
    return adaptLiveReportRet(ret);
  }
  return ret;
}

// ---------------------------------------------------------------------------
// Live-mode report-shape adapter
// ---------------------------------------------------------------------------

// Canonical section names per report kind. Keys are the labels QB emits in
// TextRow @_value (case-insensitive lookup); values are the section names the
// adapter exposes (matching simulation-store.handleReportQuery so the two
// modes produce identical Section.Name values). Live emits singular "Expense"/
// "Other Expense"; sim emits plural — we conform live to sim.
const PNL_SECTION_NAMES = new Map<string, string>([
  ["income", "Income"],
  ["cost of goods sold", "Cost of Goods Sold"],
  ["cogs", "Cost of Goods Sold"],
  ["expense", "Expenses"],
  ["other income", "Other Income"],
  ["other expense", "Other Expenses"],
]);

const BS_SECTION_NAMES = new Map<string, string>([
  ["assets", "Assets"],
  ["liabilities", "Liabilities"],
  ["equity", "Equity"],
]);

// Decode the numeric character references QB embeds in account names (the
// middle-dot &#183; in "60200 · Automobile Expense" being the common case).
// fast-xml-parser handles the five named XML entities but leaves numeric refs
// untouched.
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function asArray<T>(x: unknown): T[] {
  if (Array.isArray(x)) return x as T[];
  if (x === undefined || x === null) return [];
  return [x as T];
}

function colValue(row: Record<string, unknown>, colId: number): unknown {
  for (const c of asArray<Record<string, unknown>>(row.ColData)) {
    if (Number(c["@_colID"] ?? 0) === colId) return c["@_value"];
  }
  return undefined;
}

/**
 * Translate a live QB ReportRet (row-tree under ReportData) into the
 * simplified { Sections, Totals } shape the simulation emits.
 *
 * Algorithm:
 *   1. Merge TextRow / DataRow / SubtotalRow / TotalRow into a row-number-
 *      ordered timeline.
 *   2. Walk the timeline. Track the currently-open top-level section (starts
 *      when a TextRow's label matches a canonical section name; ends when a
 *      Subtotal/Total row matches "Total <name>" or "TOTAL <name>"
 *      case-insensitively).
 *   3. Each DataRow inside an open section becomes a leaf account
 *      ({Name, Total}). SubtotalRows WITH RowData are nested account-group
 *      rollups — skipped to avoid double-counting (the leaves that comprise
 *      them are already captured).
 *   4. Per-section subtotal: read directly from the closing "Total <name>"
 *      row's amount. Top-level Totals: looked up by label across all
 *      Subtotal/Total rows.
 *
 * Detects report kind by inspecting which canonical section labels appear
 * (Income/Expense → P&L; Assets/Liabilities/Equity → BS) so the adapter can
 * pick the right Totals shape without depending on ReportTitle (which varies
 * by QB locale).
 */
export function adaptLiveReportRet(
  reportRet: Record<string, unknown>
): Record<string, unknown> {
  const reportData = (reportRet.ReportData as Record<string, unknown>) ?? {};

  type Row = {
    rowNumber: number;
    kind: "text" | "data" | "subtotal" | "total";
    data: Record<string, unknown>;
  };
  const timeline: Row[] = [];
  for (const r of asArray<Record<string, unknown>>(reportData.TextRow)) {
    timeline.push({ rowNumber: Number(r["@_rowNumber"] ?? 0), kind: "text", data: r });
  }
  for (const r of asArray<Record<string, unknown>>(reportData.DataRow)) {
    timeline.push({ rowNumber: Number(r["@_rowNumber"] ?? 0), kind: "data", data: r });
  }
  for (const r of asArray<Record<string, unknown>>(reportData.SubtotalRow)) {
    timeline.push({ rowNumber: Number(r["@_rowNumber"] ?? 0), kind: "subtotal", data: r });
  }
  for (const r of asArray<Record<string, unknown>>(reportData.TotalRow)) {
    timeline.push({ rowNumber: Number(r["@_rowNumber"] ?? 0), kind: "total", data: r });
  }
  timeline.sort((a, b) => a.rowNumber - b.rowNumber);

  // Prefer P&L section names if any P&L-specific label appears in the
  // TextRows; fall back to BS otherwise. Either map is keyed by lowercase
  // label so case-insensitive lookups work for "Assets" vs "ASSETS".
  const textLabels = timeline
    .filter((r) => r.kind === "text")
    .map((r) => decodeXmlEntities(String(r.data["@_value"] ?? "")).toLowerCase());
  const isPnl = textLabels.some((l) => PNL_SECTION_NAMES.has(l));
  const sectionMap = isPnl ? PNL_SECTION_NAMES : BS_SECTION_NAMES;

  type Section = {
    Name: string;
    Accounts: { Name: string; Total: number }[];
    Subtotal: number;
  };
  const sections: Section[] = [];
  let openSection: Section | null = null;
  // Match closing rows by lower-cased "Total <section>" label.
  let openCloseLabel: string | null = null;
  const totalsByLabel = new Map<string, number>();

  for (const row of timeline) {
    if (row.kind === "text") {
      const labelRaw = decodeXmlEntities(String(row.data["@_value"] ?? ""));
      const labelLc = labelRaw.toLowerCase();
      const sectionName = sectionMap.get(labelLc);
      if (sectionName) {
        // Open a new top-level section. If a previous one was open and
        // never explicitly closed (rare — defensive), close it now.
        openSection = { Name: sectionName, Accounts: [], Subtotal: 0 };
        sections.push(openSection);
        openCloseLabel = `total ${labelLc}`;
      }
      // Non-section TextRows (account-group headers, meta-headers like
      // "Ordinary Income/Expense") are skipped — they don't change which
      // top-level section is open.
    } else if (row.kind === "data") {
      if (!openSection) continue;
      const name = decodeXmlEntities(String(colValue(row.data, 1) ?? ""));
      const total = Number(colValue(row.data, 2) ?? 0);
      if (!Number.isFinite(total)) continue;
      openSection.Accounts.push({ Name: name, Total: total });
    } else if (row.kind === "subtotal" || row.kind === "total") {
      const labelRaw = decodeXmlEntities(String(colValue(row.data, 1) ?? ""));
      const labelLc = labelRaw.toLowerCase();
      const value = Number(colValue(row.data, 2) ?? 0);
      if (Number.isFinite(value)) totalsByLabel.set(labelLc, value);

      // Section close: the row's label matches the open section's expected
      // close label ("total income" → closes Income). SubtotalRows WITH
      // RowData are nested rollups (e.g. "Total 60200 · Automobile Expense")
      // — those don't close the top-level section.
      if (
        openSection &&
        openCloseLabel &&
        labelLc === openCloseLabel &&
        !row.data.RowData
      ) {
        openSection.Subtotal = Number.isFinite(value) ? value : 0;
        openSection = null;
        openCloseLabel = null;
      }
    }
  }

  const lookup = (...labels: string[]): number | undefined => {
    for (const l of labels) {
      const v = totalsByLabel.get(l.toLowerCase());
      if (v !== undefined) return v;
    }
    return undefined;
  };

  const Totals: Record<string, number> = {};
  if (isPnl) {
    // TotalIncome aggregates Income + Other Income to match sim's contract;
    // TotalExpenses aggregates Expense + Other Expense the same way.
    const tIncome = (lookup("Total Income") ?? 0) + (lookup("Total Other Income") ?? 0);
    const tExpense = (lookup("Total Expense") ?? 0) + (lookup("Total Other Expense") ?? 0);
    const tCogs = lookup("Total COGS", "Total Cost of Goods Sold") ?? 0;
    // GrossProfit: trust QB's labelled value (Income - COGS, NOT including
    // Other Income — real-QB semantics). Fall back to derived if missing.
    const grossProfit = lookup("Gross Profit") ?? ((lookup("Total Income") ?? 0) - tCogs);
    const netIncome = lookup("Net Income") ?? 0;
    Totals.TotalIncome = round2(tIncome);
    Totals.TotalCOGS = round2(tCogs);
    Totals.TotalExpenses = round2(tExpense);
    Totals.GrossProfit = round2(grossProfit);
    Totals.NetIncome = round2(netIncome);
  } else {
    // BS: TOTAL ASSETS appears as a TotalRow; Total Liabilities and Total
    // Equity appear as SubtotalRows. Net Income (period) is typically a
    // DataRow inside the Equity section, not a top-level total.
    Totals.TotalAssets = round2(lookup("TOTAL ASSETS", "Total Assets") ?? 0);
    Totals.TotalLiabilities = round2(lookup("Total Liabilities") ?? 0);
    Totals.TotalEquity = round2(lookup("Total Equity") ?? 0);
    // NetIncome from any explicit "Net Income" subtotal/total row, or
    // from a "Net Income" DataRow we may have folded into the Equity
    // section's Accounts list.
    const netFromTotals = lookup("Net Income");
    if (netFromTotals !== undefined) {
      Totals.NetIncome = round2(netFromTotals);
    } else {
      const equity = sections.find((s) => s.Name === "Equity");
      const netRow = equity?.Accounts.find((a) => a.Name.toLowerCase() === "net income");
      Totals.NetIncome = round2(netRow?.Total ?? 0);
    }
  }

  // Pull the subtitle for "January through December 2024" / "As of December
  // 31, 2024" — useful context for the user but not part of the simplified
  // contract. Preserve where present.
  const out: Record<string, unknown> = {
    ReportTitle: reportRet.ReportTitle,
    ReportBasis: reportRet.ReportBasis,
    Sections: sections,
    Totals,
  };
  if (reportRet.ReportSubtitle) out.ReportSubtitle = reportRet.ReportSubtitle;
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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
