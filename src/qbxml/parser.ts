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
  // Phase 11 #55 — qb_w2_summary. PayrollSummaryReportQueryRq sim shape emits
  // one EmployeeWagesTaxesRet per employee under ReportRet; the row is what
  // the tool layer maps onto W-2 boxes.
  "EmployeeWagesTaxesRet",
  // Phase 12 #59 — attachments. AttachableQueryRq returns N AttachableRet rows;
  // a single hit must still surface as an array for the tool layer's filter
  // path to work uniformly.
  "AttachableRet",
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

// Statement of Cash Flows section labels. QB emits these in TextRow @_value
// using a mix of casings and an optional "OPERATING/INVESTING/FINANCING
// ACTIVITIES" or "Cash from operating/investing/financing activities" prefix.
// Map covers the variants observed in the QBXML SDK reference docs; lookup is
// case-insensitive against the lowercased label. Section closes match the
// "Net cash provided by <activity>" / "Total <activity>" labels — handled
// inline in adaptLiveReportRet so we don't need a parallel close-label map.
const SCF_SECTION_NAMES = new Map<string, string>([
  ["operating activities", "Operating Activities"],
  ["operating", "Operating Activities"],
  ["cash from operating activities", "Operating Activities"],
  ["cash provided by operating activities", "Operating Activities"],
  ["investing activities", "Investing Activities"],
  ["investing", "Investing Activities"],
  ["cash from investing activities", "Investing Activities"],
  ["cash provided by investing activities", "Investing Activities"],
  ["financing activities", "Financing Activities"],
  ["financing", "Financing Activities"],
  ["cash from financing activities", "Financing Activities"],
  ["cash provided by financing activities", "Financing Activities"],
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
  const hasBs = !isPnl && textLabels.some((l) => BS_SECTION_NAMES.has(l));
  // SCF detection: distinct section labels (Operating/Investing/Financing
  // Activities) — locale-stable. Skipped when P&L or BS labels already matched
  // to avoid mis-routing a P&L with an "Operating Income" account header
  // (would never carry the "Activities" suffix on its own).
  const isScf = !isPnl && !hasBs && textLabels.some((l) => SCF_SECTION_NAMES.has(l));

  // Flat-summary fork (Phase 11 #49 — SalesByCustomerSummary, plus future
  // expense-by-vendor-summary / sales-by-item-summary variants). These reports
  // have no per-section TextRows the adapter can open against; QB emits a
  // single flat list of DataRows with a closing TotalRow. Synthesize one
  // section keyed by the report's natural domain (e.g. "Sales") and route
  // every DataRow into it. Detection: neither PnL nor BS nor SCF section
  // labels were present in TextRows — that's locale-stable (the labels QB
  // emits in TextRow ARE the section names being opened; their absence means
  // the report isn't section-shaped).
  if (!isPnl && !hasBs && !isScf) {
    // Empty-data short-circuit: when QB returned no rows at all (status 1
    // "no matching object" path or a genuinely empty period), don't
    // synthesize a phantom section — return Sections: [] like the prior
    // adapter shape did. Avoids breaking callers that distinguish "report
    // returned no data" from "report returned one section with no accounts".
    const hasAnyData = timeline.some(
      (r) => r.kind === "data" || r.kind === "subtotal" || r.kind === "total",
    );
    if (!hasAnyData) {
      return {
        ReportTitle: reportRet.ReportTitle,
        ReportBasis: reportRet.ReportBasis,
        Sections: [],
        Totals: {},
      };
    }

    const accounts: { Name: string; Total: number }[] = [];
    for (const row of timeline) {
      if (row.kind !== "data") continue;
      const nameRaw = colValue(row.data, 1);
      if (nameRaw === undefined || nameRaw === null) continue;
      const name = decodeXmlEntities(String(nameRaw));
      // Find the rightmost numeric ColData on the row — QB's
      // SalesByCustomerSummary emits {Name, Amount} as ColID 1 and 2 but
      // future flat reports may have extra Subcolumns (e.g. % of total). The
      // total column is conventionally the last numeric.
      let total: number | undefined;
      for (const c of asArray<Record<string, unknown>>(row.data.ColData)) {
        const id = Number(c["@_colID"] ?? 0);
        if (id <= 1) continue;
        const v = Number(c["@_value"]);
        if (Number.isFinite(v)) total = v;
      }
      if (total === undefined || !Number.isFinite(total)) continue;
      accounts.push({ Name: name, Total: round2(total) });
    }

    let grandTotal: number | undefined;
    for (const row of timeline) {
      if (row.kind !== "total" && row.kind !== "subtotal") continue;
      const labelRaw = decodeXmlEntities(String(colValue(row.data, 1) ?? "")).toLowerCase();
      if (labelRaw !== "total" && labelRaw !== "totals") continue;
      const v = Number(colValue(row.data, 2));
      if (Number.isFinite(v)) {
        grandTotal = v;
        break;
      }
    }
    if (grandTotal === undefined) {
      grandTotal = accounts.reduce((s, a) => s + a.Total, 0);
    }
    const totalRounded = round2(grandTotal);

    // Section name heuristic — strip trailing "Summary" / "Detail" from the
    // ReportTitle and use what remains. Falls back to "Sales" which fits the
    // first flat report shipped (SalesByCustomer); future flat reports can
    // contribute their own canonical section name through this strip.
    const title = String(reportRet.ReportTitle ?? "");
    const stripped = title.replace(/\s+(Summary|Detail)$/i, "").trim();
    const sectionName =
      stripped.toLowerCase().includes("sales by customer") ? "Sales" :
      stripped || "Sales";

    const out: Record<string, unknown> = {
      ReportTitle: reportRet.ReportTitle,
      ReportBasis: reportRet.ReportBasis,
      Sections: [
        { Name: sectionName, Accounts: accounts, Subtotal: totalRounded },
      ],
      Totals: { TotalSales: totalRounded },
    };
    if (reportRet.ReportSubtitle) out.ReportSubtitle = reportRet.ReportSubtitle;
    return out;
  }

  const sectionMap = isPnl ? PNL_SECTION_NAMES : isScf ? SCF_SECTION_NAMES : BS_SECTION_NAMES;

  type Section = {
    Name: string;
    Accounts: { Name: string; Total: number }[];
    Subtotal: number;
  };
  const sections: Section[] = [];
  let openSection: Section | null = null;
  // Match closing rows by lower-cased close labels. PnL/BS use "Total <section>";
  // SCF uses richer variants ("Net cash provided by operating activities",
  // "Total operating activities") so we maintain a candidate list per section.
  let openCloseLabels: string[] = [];
  const totalsByLabel = new Map<string, number>();

  const scfCloseLabelsFor = (sectionName: string): string[] => {
    // SectionName is "Operating Activities" etc. — derive the activity word
    // for the various close-label patterns QB emits.
    const activity = sectionName.toLowerCase(); // e.g. "operating activities"
    const verb = activity.replace(/\s+activities$/, ""); // "operating"
    return [
      `total ${activity}`,
      `net cash provided by ${activity}`,
      `net cash used in ${activity}`,
      `net cash from ${activity}`,
      `net cash provided by ${verb} activities`,
      `cash provided by ${activity}`,
    ];
  };

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
        openCloseLabels = isScf ? scfCloseLabelsFor(sectionName) : [`total ${labelLc}`];
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

      // Section close: the row's label matches one of the open section's
      // expected close labels. SubtotalRows WITH RowData are nested rollups
      // (e.g. "Total 60200 · Automobile Expense") — those don't close the
      // top-level section.
      if (
        openSection &&
        openCloseLabels.includes(labelLc) &&
        !row.data.RowData
      ) {
        openSection.Subtotal = Number.isFinite(value) ? value : 0;
        openSection = null;
        openCloseLabels = [];
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
  } else if (isScf) {
    // SCF totals: NetCashIncrease (sum of three section subtotals), plus
    // CashAtBeginningOfPeriod and CashAtEndOfPeriod which QB usually emits
    // as standalone Subtotal/Total rows AFTER the three sections close.
    const netCashIncrease = lookup(
      "Net cash increase for period",
      "Net cash decrease for period",
      "Net increase in cash",
      "Net decrease in cash",
      "Net change in cash",
    );
    Totals.NetCashIncrease = round2(
      netCashIncrease !== undefined
        ? netCashIncrease
        : sections.reduce((s, sec) => s + sec.Subtotal, 0)
    );
    Totals.CashAtBeginningOfPeriod = round2(
      lookup("Cash at beginning of period", "Cash at beginning") ?? 0,
    );
    Totals.CashAtEndOfPeriod = round2(
      lookup("Cash at end of period", "Cash at end") ?? 0,
    );
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

// ---------------------------------------------------------------------------
// CustomDetailReport adapter (Phase 11 #56 + #56a)
// ---------------------------------------------------------------------------

/**
 * Extract a CustomDetailReportRet from a CustomDetailReportQueryRs response.
 * Distinct from extractReportData — that one is hard-coded to dispatch
 * GeneralSummaryReport's row-tree → {Sections, Totals} adapter via
 * adaptLiveReportRet. This one routes to adaptLiveCustomDetailReportRet for
 * the live row-tree → {Columns, Rows} translation, and returns the sim's
 * native {Columns, Rows} shape unchanged.
 *
 * Detection is structural: live emits `ReportData` (TextRow / DataRow /
 * SubtotalRow / TotalRow under it) and `ColDesc` (column metadata); sim emits
 * `Rows` directly. Returns {} on the "no data" status (1) — matches the
 * extractResponseData semantics so callers can treat the empty case
 * uniformly.
 */
export function extractCustomDetailReportData(
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
  if (ret.ReportData && !ret.Rows) {
    return adaptLiveCustomDetailReportRet(ret);
  }
  return ret;
}

/**
 * Extract a GeneralDetailReportRet from a GeneralDetailReportQueryRs response
 * (Phase 11 #49 — SalesByCustomerDetail, plus the planned #50/#52 sales /
 * expense detail variants that share this envelope). Wire shape is structurally
 * identical to CustomDetailReport — ColDesc metadata + ReportData row tree —
 * so we delegate to the same adapter (adaptLiveCustomDetailReportRet) for the
 * live → {Columns, Rows} translation. Returns the sim's native {Columns, Rows}
 * shape unchanged. Returns {} on the "no data" status (1).
 */
export function extractGeneralDetailReportData(
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
  if (ret.ReportData && !ret.Rows) {
    return adaptLiveCustomDetailReportRet(ret);
  }
  return ret;
}

/**
 * Translate a live QB CustomDetailReportRet (row-tree under ReportData) into
 * the simplified {Columns, Rows} shape the simulation emits. Designed for
 * `CustomDetailReportType=CustomTxnDetail` with column inclusion specifically
 * for the bank-rec read tools (TxnType / Date / Num / Name / Memo / Amount /
 * ClearedStatus). Other CustomDetailReport types (CustomSummary etc.) are
 * out of scope — the adapter would still produce a Columns + Rows shape but
 * the column titles would be whatever ColDesc emits.
 *
 * Algorithm:
 *   1. Read ColDesc[] → map colID → { Title, Type } so each row can name its
 *      cells. ColDesc.@_colID is the join key matching ColData.@_colID inside
 *      each DataRow.
 *   2. Walk DataRow[] (skip TextRow / SubtotalRow / TotalRow — those are
 *      formatting rows, not transaction rows).
 *   3. For each DataRow, build a flat object keyed by colID-resolved title
 *      with the cell @_value. Number-type cells get coerced to Number;
 *      everything else stays a string. Decode embedded numeric-character
 *      entities (the "&#183;" middle-dot QB emits in account/item names —
 *      see decodeXmlEntities jsdoc).
 *
 * Output:
 *   { ReportTitle?, ReportSubtitle?, ReportBasis?, Columns: [{Title, Type}],
 *     Rows: [{ <colTitle>: value, ... }] }
 *
 * `RowData.@_rowType` on a DataRow contains the actual TxnType QB tracks
 * internally (e.g. "Check", "Deposit") — surfaced as `_rowType` on each row
 * so callers can disambiguate even when the IncludeColumn list omits TxnType.
 */
export function adaptLiveCustomDetailReportRet(
  reportRet: Record<string, unknown>
): Record<string, unknown> {
  const reportData = (reportRet.ReportData as Record<string, unknown>) ?? {};

  // ColDesc lives at reportRet.ColDesc OR reportRet.ColDescList.ColDesc
  // depending on the QBXML version. Probe both.
  const colDescList = reportRet.ColDescList as Record<string, unknown> | undefined;
  const colDescs = asArray<Record<string, unknown>>(
    reportRet.ColDesc ?? colDescList?.ColDesc
  );
  type ColInfo = { title: string; type: string };
  const colByID = new Map<number, ColInfo>();
  const columns: ColInfo[] = [];
  for (const cd of colDescs) {
    const id = Number(cd["@_colID"] ?? 0);
    // ColDesc carries a ColTitle child which may itself be an object
    // ({ #text, @_titleRow? }) or a plain string per QBXML version. Coerce.
    const titleRaw = cd.ColTitle ?? cd["@_colTitle"] ?? "";
    const title = typeof titleRaw === "object" && titleRaw !== null
      ? String((titleRaw as Record<string, unknown>).value
          ?? (titleRaw as Record<string, unknown>)["#text"]
          ?? "")
      : String(titleRaw);
    const type = String(cd.ColType ?? cd["@_colType"] ?? "");
    const info: ColInfo = { title: decodeXmlEntities(title), type };
    colByID.set(id, info);
    columns.push(info);
  }

  // Number-coerce columns whose ColType indicates a numeric value. QBXML
  // ColType values cover Amount / Quantity / Price / Number / etc.; treat
  // any of those as numeric. Date-coerce we leave as string (callers parse
  // YYYY-MM-DD themselves and would lose timezone disambiguation through Date).
  const isNumericColType = (t: string): boolean => {
    const lc = t.toLowerCase();
    return (
      lc === "amount" ||
      lc === "amounttype" ||
      lc === "quantity" ||
      lc === "quantitytype" ||
      lc === "price" ||
      lc === "pricetype" ||
      lc === "number" ||
      lc === "numbertype"
    );
  };

  const rows: Record<string, unknown>[] = [];
  for (const dr of asArray<Record<string, unknown>>(reportData.DataRow)) {
    const row: Record<string, unknown> = {};
    // QB tracks the underlying transaction type at @_rowType on the row
    // wrapper (e.g. "Check", "Deposit"). Surface it as _rowType so callers
    // can disambiguate even when IncludeColumn omits TxnType.
    const rowType = dr["@_rowType"];
    if (rowType !== undefined) row._rowType = String(rowType);
    for (const cell of asArray<Record<string, unknown>>(dr.ColData)) {
      const id = Number(cell["@_colID"] ?? 0);
      const info = colByID.get(id);
      if (!info) continue;
      const raw = cell["@_value"];
      if (raw === undefined || raw === null || raw === "") continue;
      const decoded = decodeXmlEntities(String(raw));
      const value = isNumericColType(info.type) ? Number(decoded) : decoded;
      // Fall back to the raw string if numeric coercion produced NaN — better
      // than dropping the cell silently.
      row[info.title] = Number.isNaN(value as number) ? decoded : value;
    }
    rows.push(row);
  }

  const out: Record<string, unknown> = {
    ReportTitle: reportRet.ReportTitle,
    ReportBasis: reportRet.ReportBasis,
    Columns: columns.map((c) => ({ Title: c.title, Type: c.type })),
    Rows: rows,
  };
  if (reportRet.ReportSubtitle) out.ReportSubtitle = reportRet.ReportSubtitle;
  return out;
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
