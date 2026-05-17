/**
 * 1099 reporting tools for QuickBooks Desktop MCP (Phase 10 #44).
 *
 * Surfaces qb_1099_summary + qb_1099_detail for January's 1099-NEC / 1099-MISC
 * filing workflow.
 *
 * Aggregation strategy: walk the existing typed Bill + Check stores via the
 * standard session.queryEntity helper, sum per-vendor totals across the date
 * window, classify by Vendor1099Type (NEC default; MISC where vendor opts in).
 *
 * Why aggregate server-side instead of wiring Form1099QueryRq:
 *  - Keeps the "tools never construct QBXML directly" rule (per CLAUDE.md) —
 *    no new wire-request schema-order surface to test.
 *  - Identical sim/live behavior. The same code path produces results in both
 *    modes; live mode just gets its Bill/Check rows from real QB's QueryRq
 *    rather than the simulation store.
 *  - We don't depend on QB Preferences' per-account 1099 box mapping. The
 *    tradeoff: every payment to an eligible vendor counts toward the threshold,
 *    not just payments hitting accounts QB has flagged for a specific 1099 box.
 *    In practice this is a more permissive (safer) signal — operators get a
 *    superset of vendors who *might* need a 1099, never miss a vendor who
 *    should. Documented in DECISIONS.md (2026-05-10).
 *
 * Card-payment exception (IRS): payments by credit card are reported by the
 * processor on 1099-K and excluded from 1099-NEC/MISC. Per that rule we walk
 * Bill (paid via check or other non-card means in real QB) and Check, NOT
 * CreditCardCharge. Documented in the tool description.
 *
 * Cash vs accrual: the aggregation is "amount posted to vendor in period" —
 * sum of bill original totals + check amounts. This matches real QB's
 * Form1099 wizard for most operators (where bills are paid same-period).
 * For strict cash-basis 1099 reporting in a multi-year-AP setup, the operator
 * should use real QB's wizard; that's outside scope.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { formatToolError } from "../util/format-tool-error.js";
import { ISO_DATE_RE } from "../util/validators.js";

// IRS general 1099-NEC and 1099-MISC reporting threshold (TY2024+). The few
// special-box thresholds ($10 royalties, $5,000 consumer-product resale) are
// not surfaced — operators with those edge cases should override `threshold`.
const DEFAULT_1099_THRESHOLD = 600;

type FormType = "NEC" | "MISC";

// Resolved date window + threshold + form filter. Pure value object so the
// aggregation can be tested without spinning up an MCP transport.
type ResolvedFilters = {
  fromDate: string;
  toDate: string;
  taxYear: number | null;
  threshold: number;
  formType: "NEC" | "MISC" | "all";
};

function resolveTaxYear(year: number): { fromDate: string; toDate: string } {
  return { fromDate: `${year}-01-01`, toDate: `${year}-12-31` };
}

function defaultLastCompletedTaxYear(today: Date = new Date()): number {
  return today.getUTCFullYear() - 1;
}

function resolveDateWindow(args: {
  taxYear?: number;
  fromDate?: string;
  toDate?: string;
}): { fromDate: string; toDate: string; taxYear: number | null } {
  if (args.fromDate || args.toDate) {
    // Explicit override — taxYear is informational only.
    return {
      fromDate: args.fromDate ?? "",
      toDate: args.toDate ?? "",
      taxYear: args.taxYear ?? null,
    };
  }
  const ty = args.taxYear ?? defaultLastCompletedTaxYear();
  const { fromDate, toDate } = resolveTaxYear(ty);
  return { fromDate, toDate, taxYear: ty };
}

function classifyVendorForm(vendor: Record<string, unknown>): FormType {
  // Vendor1099Type is a per-vendor opt-in for MISC — most contractors fall
  // under NEC (modern default for nonemployee compensation, post-2020 IRS
  // split). Empty/missing → NEC.
  const t = String(vendor.Vendor1099Type ?? "").toUpperCase();
  if (t === "MISC" || t === "1099-MISC") return "MISC";
  return "NEC";
}

// Resolve a transaction's vendor reference. Bill carries VendorRef; Check
// carries PayeeEntityRef (PayeeEntityRef can also point at Customer or
// Employee but in 1099 context only Vendor matches — non-Vendor refs are
// silently skipped by the lookup downstream).
function vendorRef(
  txn: Record<string, unknown>,
  field: "VendorRef" | "PayeeEntityRef"
): { listID?: string; fullName?: string } | null {
  const ref = txn[field] as Record<string, unknown> | undefined;
  if (!ref) return null;
  const listID = ref.ListID ? String(ref.ListID) : undefined;
  const fullName = ref.FullName ? String(ref.FullName) : undefined;
  if (!listID && !fullName) return null;
  return { listID, fullName };
}

// Total billed amount = sum of line amounts. Bills carry header AmountDue but
// that moves down with payment application — for 1099 we want the original
// billed total. Lines are surfaced when IncludeLineItems is true on the query.
function billOriginalTotal(bill: Record<string, unknown>): number {
  const expense = (bill.ExpenseLineRet as Array<Record<string, unknown>> | undefined) ?? [];
  const item = (bill.ItemLineRet as Array<Record<string, unknown>> | undefined) ?? [];
  let sum = 0;
  for (const l of expense) sum += Number(l.Amount ?? 0);
  for (const l of item) sum += Number(l.Amount ?? 0);
  // Fallback: if line arrays were stripped (caller forgot IncludeLineItems),
  // fall back to AmountDue. This is observably wrong for paid bills but
  // beats returning zero — surfaces the data the caller has access to.
  if (sum === 0) sum = Number(bill.AmountDue ?? 0);
  return sum;
}

// Per-vendor running aggregation. Built up as we walk Bill + Check; emitted as
// the final tool response.
type VendorAggregate = {
  listID: string;
  fullName: string;
  vendor: Record<string, unknown>;
  formType: FormType;
  billCount: number;
  billTotal: number;
  checkCount: number;
  checkTotal: number;
  bills: Array<{
    txnId: string;
    txnDate: string;
    refNumber: string;
    total: number;
    memo: string;
    lines: Array<{ accountName: string; amount: number; memo: string }>;
  }>;
  checks: Array<{
    txnId: string;
    txnDate: string;
    refNumber: string;
    total: number;
    memo: string;
    lines: Array<{ accountName: string; amount: number; memo: string }>;
  }>;
};

function emptyAggregate(
  vendor: Record<string, unknown>
): VendorAggregate {
  return {
    listID: String(vendor.ListID ?? ""),
    fullName: String(vendor.FullName ?? vendor.Name ?? ""),
    vendor,
    formType: classifyVendorForm(vendor),
    billCount: 0,
    billTotal: 0,
    checkCount: 0,
    checkTotal: 0,
    bills: [],
    checks: [],
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function lineSummary(
  lineArrays: Array<Array<Record<string, unknown>> | undefined>
): Array<{ accountName: string; amount: number; memo: string }> {
  const out: Array<{ accountName: string; amount: number; memo: string }> = [];
  for (const arr of lineArrays) {
    if (!arr) continue;
    for (const l of arr) {
      const accountRef = l.AccountRef as Record<string, unknown> | undefined;
      out.push({
        accountName: String(accountRef?.FullName ?? ""),
        amount: Number(l.Amount ?? 0),
        memo: String(l.Memo ?? ""),
      });
    }
  }
  return out;
}

/**
 * Walk Bill + Check stores, aggregate per-vendor totals. Returns the full
 * aggregation map keyed by vendor ListID; callers filter/format from there.
 *
 * Only 1099-eligible vendors (`IsVendorEligibleFor1099 === true`) are aggregated.
 * Transactions referencing other vendors are silently skipped.
 *
 * Exported for direct unit testing without the MCP transport.
 */
export async function aggregate1099Totals(
  session: QBSessionManager,
  filters: { fromDate: string; toDate: string }
): Promise<Map<string, VendorAggregate>> {
  // Pull eligible vendors. ActiveOnly excludes vendors deactivated mid-year
  // — a deactivation in Q4 doesn't erase Q1 payments. Real QB still 1099s
  // them; mirror that by querying with ActiveStatus omitted (default = All).
  const allVendors = await session.queryEntity("Vendor", {});
  const eligibleByID = new Map<string, Record<string, unknown>>();
  const eligibleByName = new Map<string, Record<string, unknown>>();
  for (const v of allVendors) {
    if (v.IsVendorEligibleFor1099 !== true) continue;
    const listID = String(v.ListID ?? "");
    const fullName = String(v.FullName ?? v.Name ?? "");
    if (listID) eligibleByID.set(listID, v);
    if (fullName) eligibleByName.set(fullName, v);
  }

  const aggregates = new Map<string, VendorAggregate>();
  const ensureAggregate = (vendor: Record<string, unknown>): VendorAggregate => {
    const id = String(vendor.ListID ?? "");
    let agg = aggregates.get(id);
    if (!agg) {
      agg = emptyAggregate(vendor);
      aggregates.set(id, agg);
    }
    return agg;
  };

  const dateFilter = {
    TxnDateRangeFilter: {
      FromTxnDate: filters.fromDate,
      ToTxnDate: filters.toDate,
    },
    IncludeLineItems: true,
  };

  // Bills — VendorRef.
  const bills = await session.queryEntity("Bill", dateFilter);
  for (const bill of bills) {
    const ref = vendorRef(bill, "VendorRef");
    if (!ref) continue;
    const vendor =
      (ref.listID && eligibleByID.get(ref.listID)) ||
      (ref.fullName && eligibleByName.get(ref.fullName));
    if (!vendor) continue;

    const total = billOriginalTotal(bill);
    if (total === 0) continue;

    const agg = ensureAggregate(vendor);
    agg.billCount += 1;
    agg.billTotal = round2(agg.billTotal + total);
    agg.bills.push({
      txnId: String(bill.TxnID ?? ""),
      txnDate: String(bill.TxnDate ?? ""),
      refNumber: String(bill.RefNumber ?? ""),
      total: round2(total),
      memo: String(bill.Memo ?? ""),
      lines: lineSummary([
        bill.ExpenseLineRet as Array<Record<string, unknown>> | undefined,
        bill.ItemLineRet as Array<Record<string, unknown>> | undefined,
      ]),
    });
  }

  // Checks — PayeeEntityRef. Real QB's PayeeEntityRef can point at Customer
  // or Employee, not just Vendor. The eligibleByID/Name lookup naturally
  // skips non-vendor payees (their listIDs aren't in the eligible map).
  const checks = await session.queryEntity("Check", dateFilter);
  for (const check of checks) {
    const ref = vendorRef(check, "PayeeEntityRef");
    if (!ref) continue;
    const vendor =
      (ref.listID && eligibleByID.get(ref.listID)) ||
      (ref.fullName && eligibleByName.get(ref.fullName));
    if (!vendor) continue;

    // Header Amount is the check total — Bill needs sum-of-lines because
    // AmountDue moves with payment, but Check.Amount is the issued amount
    // and doesn't change after post.
    const total = Number(check.Amount ?? 0);
    if (total === 0) continue;

    const agg = ensureAggregate(vendor);
    agg.checkCount += 1;
    agg.checkTotal = round2(agg.checkTotal + total);
    agg.checks.push({
      txnId: String(check.TxnID ?? ""),
      txnDate: String(check.TxnDate ?? ""),
      refNumber: String(check.RefNumber ?? ""),
      total: round2(total),
      memo: String(check.Memo ?? ""),
      lines: lineSummary([
        check.ExpenseLineRet as Array<Record<string, unknown>> | undefined,
        check.ItemLineRet as Array<Record<string, unknown>> | undefined,
      ]),
    });
  }

  return aggregates;
}

// Format the address sub-object the way the rest of the tool surface does
// (camelCase keys; only fields that are present).
function formatAddress(
  addr: Record<string, unknown> | undefined
): Record<string, string> | null {
  if (!addr) return null;
  const out: Record<string, string> = {};
  if (addr.Addr1) out.addr1 = String(addr.Addr1);
  if (addr.Addr2) out.addr2 = String(addr.Addr2);
  if (addr.City) out.city = String(addr.City);
  if (addr.State) out.state = String(addr.State);
  if (addr.PostalCode) out.postalCode = String(addr.PostalCode);
  if (addr.Country) out.country = String(addr.Country);
  return Object.keys(out).length > 0 ? out : null;
}

export function registerForm1099Tools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  // -----------------------------------------------------------------------
  // qb_1099_summary
  // -----------------------------------------------------------------------
  server.tool(
    "qb_1099_summary",
    "Summarize 1099-eligible vendor payments for a tax year. Walks Bill + Check transactions in the date window filtered to vendors with IsVendorEligibleFor1099=true; aggregates per-vendor totals; classifies by 1099-NEC (default — nonemployee compensation) or 1099-MISC (Vendor1099Type='MISC' on the vendor record — typically rents/royalties); compares each total against the IRS general $600 threshold. Card payments are excluded per IRS Form 1099 instructions (the card processor reports those on 1099-K). Set includeBelowThreshold:true to surface vendors below the threshold (useful for review — sometimes a vendor sneaks past via multiple small bills you forgot to flag). Defaults to last completed tax year — `qb_1099_summary({})` in January 2026 returns TY2025 totals; explicit fromDate/toDate override the taxYear arg. Docs/limitations: the aggregation does NOT honor QB Preferences' per-account 1099 box mapping (every payment to an eligible vendor counts); for strict box-by-box reporting use real QB's Form1099 wizard.",
    {
      taxYear: z.number().int().optional().describe("Calendar tax year (e.g. 2024). Sets fromDate=YYYY-01-01 and toDate=YYYY-12-31. Default: last completed year (current year − 1)."),
      fromDate: z.string().regex(ISO_DATE_RE).optional().describe("Override taxYear with an explicit window start (YYYY-MM-DD). When set, taxYear is informational only."),
      toDate: z.string().regex(ISO_DATE_RE).optional().describe("Override taxYear with an explicit window end (YYYY-MM-DD)."),
      threshold: z.number().nonnegative().optional().describe("Reporting threshold. Default 600 (IRS general 1099-NEC + 1099-MISC threshold for TY2024+). Override to 10 for royalty-only views, etc."),
      formType: z.enum(["NEC", "MISC", "all"]).optional().describe("Filter by form type. 'NEC' returns only 1099-NEC vendors (nonemployee compensation); 'MISC' returns only 1099-MISC vendors (rents/royalties). Default 'all'."),
      includeBelowThreshold: z.boolean().optional().describe("When true, vendors below the threshold are still surfaced (with meetsThreshold=false). Default false — only at-or-above-threshold vendors appear in the response."),
    },
    async ({ taxYear, fromDate, toDate, threshold, formType, includeBelowThreshold }) => {
      const session = getSession();
      try {
        const window = resolveDateWindow({ taxYear, fromDate, toDate });
        if (!window.fromDate || !window.toDate) {
          return errorResponse(
            -1,
            "fromDate and toDate must both be set when not using taxYear",
            null
          );
        }
        const effectiveThreshold = threshold ?? DEFAULT_1099_THRESHOLD;
        const effectiveFormType = formType ?? "all";

        const aggregates = await aggregate1099Totals(session, {
          fromDate: window.fromDate,
          toDate: window.toDate,
        });

        let aboveCount = 0;
        let belowCount = 0;
        const totalsByForm: Record<FormType, number> = { NEC: 0, MISC: 0 };
        const vendorRows: Array<Record<string, unknown>> = [];

        for (const agg of aggregates.values()) {
          if (effectiveFormType !== "all" && agg.formType !== effectiveFormType) continue;
          const totalPaid = round2(agg.billTotal + agg.checkTotal);
          const meetsThreshold = totalPaid >= effectiveThreshold;
          if (meetsThreshold) aboveCount++;
          else belowCount++;
          totalsByForm[agg.formType] = round2(totalsByForm[agg.formType] + totalPaid);
          if (!meetsThreshold && !includeBelowThreshold) continue;

          const v = agg.vendor;
          vendorRows.push({
            listId: agg.listID,
            vendorName: agg.fullName,
            companyName: v.CompanyName ?? null,
            taxId: v.VendorTaxIdent ?? null,
            address: formatAddress(v.VendorAddress as Record<string, unknown> | undefined),
            formType: agg.formType,
            totalPaid,
            transactionCount: agg.billCount + agg.checkCount,
            billCount: agg.billCount,
            billTotal: agg.billTotal,
            checkCount: agg.checkCount,
            checkTotal: agg.checkTotal,
            meetsThreshold,
          });
        }

        // Sort by totalPaid desc — operators want the highest-spend vendors
        // surfaced first (those are the ones most likely to need a 1099).
        vendorRows.sort(
          (a, b) => Number(b.totalPaid ?? 0) - Number(a.totalPaid ?? 0)
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              taxYear: window.taxYear,
              fromDate: window.fromDate,
              toDate: window.toDate,
              threshold: effectiveThreshold,
              formType: effectiveFormType,
              totalEligibleVendors: aggregates.size,
              vendorsAboveThreshold: aboveCount,
              vendorsBelowThreshold: belowCount,
              totalsByForm,
              vendors: vendorRows,
            }, null, 2),
          }],
        };
      } catch (err) {
        return errorResponse(
          (err as { statusCode?: number }).statusCode ?? -1,
          (err as { message?: string }).message ?? "qb_1099_summary failed",
          null
        );
      }
    }
  );

  // -----------------------------------------------------------------------
  // qb_1099_detail
  // -----------------------------------------------------------------------
  server.tool(
    "qb_1099_detail",
    "Per-transaction breakdown of 1099-eligible vendor payments. Same Bill + Check walk as qb_1099_summary but returns each transaction as a row with txnId / txnDate / refNumber / total / memo / lines (per-line accountName + amount + memo). Use to verify the summary, drill into a specific vendor, or export to a 1099 prep spreadsheet. Card payments excluded per IRS rule. Optional vendorListId / vendorFullName scopes to a single vendor. No threshold filter (every transaction is surfaced regardless of vendor total) — combine with qb_1099_summary's threshold output to prioritize. Defaults to last completed tax year.",
    {
      taxYear: z.number().int().optional().describe("Calendar tax year. Default: last completed year."),
      fromDate: z.string().regex(ISO_DATE_RE).optional().describe("Override taxYear (YYYY-MM-DD)."),
      toDate: z.string().regex(ISO_DATE_RE).optional().describe("Override taxYear (YYYY-MM-DD)."),
      vendorListId: z.string().optional().describe("Scope to a single vendor by ListID."),
      vendorFullName: z.string().optional().describe("Scope to a single vendor by FullName (alternative to vendorListId)."),
      formType: z.enum(["NEC", "MISC", "all"]).optional().describe("Filter by form type. Default 'all'."),
    },
    async ({ taxYear, fromDate, toDate, vendorListId, vendorFullName, formType }) => {
      const session = getSession();
      try {
        const window = resolveDateWindow({ taxYear, fromDate, toDate });
        if (!window.fromDate || !window.toDate) {
          return errorResponse(
            -1,
            "fromDate and toDate must both be set when not using taxYear",
            null
          );
        }
        const effectiveFormType = formType ?? "all";

        const aggregates = await aggregate1099Totals(session, {
          fromDate: window.fromDate,
          toDate: window.toDate,
        });

        const vendorRows: Array<Record<string, unknown>> = [];
        for (const agg of aggregates.values()) {
          if (effectiveFormType !== "all" && agg.formType !== effectiveFormType) continue;
          if (vendorListId && agg.listID !== vendorListId) continue;
          if (vendorFullName && agg.fullName !== vendorFullName) continue;

          const v = agg.vendor;
          // Merge bills + checks into one transaction list, sorted by date.
          // Each carries `type` so the operator can disambiguate at a glance.
          const transactions: Array<Record<string, unknown>> = [];
          for (const b of agg.bills) {
            transactions.push({
              type: "Bill",
              txnId: b.txnId,
              txnDate: b.txnDate,
              refNumber: b.refNumber,
              total: b.total,
              memo: b.memo,
              lines: b.lines,
            });
          }
          for (const c of agg.checks) {
            transactions.push({
              type: "Check",
              txnId: c.txnId,
              txnDate: c.txnDate,
              refNumber: c.refNumber,
              total: c.total,
              memo: c.memo,
              lines: c.lines,
            });
          }
          transactions.sort((a, b) => String(a.txnDate ?? "").localeCompare(String(b.txnDate ?? "")));

          vendorRows.push({
            listId: agg.listID,
            vendorName: agg.fullName,
            companyName: v.CompanyName ?? null,
            taxId: v.VendorTaxIdent ?? null,
            address: formatAddress(v.VendorAddress as Record<string, unknown> | undefined),
            formType: agg.formType,
            totalPaid: round2(agg.billTotal + agg.checkTotal),
            transactionCount: transactions.length,
            transactions,
          });
        }

        // Single-vendor filter that matches nothing is a structured (success)
        // empty response — not an error. The operator may have asked for a
        // vendor with no activity in the window, which is a real-but-empty
        // answer. Caller-side scope mismatches (typo'd vendor name) surface
        // as `vendors: []` and the operator can compare against qb_1099_summary.

        vendorRows.sort(
          (a, b) => Number(b.totalPaid ?? 0) - Number(a.totalPaid ?? 0)
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              taxYear: window.taxYear,
              fromDate: window.fromDate,
              toDate: window.toDate,
              formType: effectiveFormType,
              vendors: vendorRows,
            }, null, 2),
          }],
        };
      } catch (err) {
        return errorResponse(
          (err as { statusCode?: number }).statusCode ?? -1,
          (err as { message?: string }).message ?? "qb_1099_detail failed",
          null
        );
      }
    }
  );
}

// Shared error-response shape — same format as the rest of the tool surface
// (Item 25 contract): isError:true, statusCode + statusMessage + humanReadable.
function errorResponse(
  statusCode: number,
  statusMessage: string,
  _extra: Record<string, unknown> | null
): { content: Array<{ type: "text"; text: string }>; isError: true } {
  // Synthesizes a thrown-style error so formatToolError can apply the
  // status-code table + the #65 heuristic uniformly with every other
  // tool error path. The cast is safe because formatToolError only reads
  // `.message` + `.statusCode` and the helper's return type satisfies
  // the caller's narrower shape.
  return formatToolError(
    { message: statusMessage, statusCode },
    { fallbackMessage: statusMessage },
  );
}

// Re-exports used by tests for direct unit testing without the MCP transport.
export {
  classifyVendorForm,
  resolveDateWindow,
  defaultLastCompletedTaxYear,
  billOriginalTotal,
};
