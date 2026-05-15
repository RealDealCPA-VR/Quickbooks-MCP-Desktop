/**
 * qb_engagement_profitability — Per-engagement (customer/job) revenue + time +
 * reimbursable expense rollup (Phase 15 #70).
 *
 * Closer to ClosePilot's "is this job worth it?" surface than the raw AR aging
 * report. For one customer over one date window, returns:
 *
 *   • Revenue   — Invoice + SalesReceipt − CreditMemo line totals where the
 *                 parent txn's CustomerRef matches the target.
 *   • Time      — TimeTracking entries whose CustomerRef matches the target;
 *                 hours rolled up by worker + by service item, billable vs
 *                 non-billable split. (Time is unblocked by #78.)
 *   • Reimbursable expenses — Bill / Check / CreditCardCharge ExpenseLineRet
 *                 + ItemLineRet rows whose line-level CustomerRef matches the
 *                 target (job-costing) — the lines you'd pass-through onto the
 *                 client invoice.
 *
 * Pure composite over existing session primitives (queryEntity for each of
 * Customer / Invoice / SalesReceipt / CreditMemo / TimeTracking / Bill / Check
 * / CreditCardCharge). No new wire types, no parser changes, no manager
 * methods.
 *
 * Fail-soft per section: a section's failure does NOT fail the whole tool —
 * it lands in `sections.<name>.error` and `sectionStatus.<name>` flips to
 * 'error'. The summary block is only emitted when ALL three queried sections
 * succeed (a partial summary would silently misreport profitability — better
 * to omit it and force the caller to branch on sectionStatus).
 *
 * The whole tool fails ONLY when the customer lookup itself fails (no match
 * → 3120; underlying CustomerQueryRq throws → that error bubbles up). The
 * customer IS the engagement — no customer means no engagement to profile.
 *
 * Customer scoping is server-side via the per-type *Filter where the schema
 * supports it (Invoice/SR/CM via EntityFilter; the resolved ListID drives the
 * match). Bill/Check/CCC do NOT carry CustomerRef on the header — the line-
 * level CustomerRef is the job-costing tag — so those three are pulled with
 * date-range scoping then filtered LINE-BY-LINE in the tool layer. Same model
 * as the post-filter contract qb_time_track_list documents.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";
import { ISO_DATE_RE } from "../util/validators.js";
import { parseDurationToHours } from "./time-tracking.js";

const MAX_ROWS_PER_CALL = 500;

type SectionStatus = "ok" | "skipped" | "error";

type ErrorBlock = {
  error: {
    statusCode: number;
    statusMessage: string;
    humanReadable?: string;
  };
};

function asErrorBlock(err: unknown, fallback: string): ErrorBlock {
  const e = err as { message?: string; statusCode?: number };
  const sc = e.statusCode ?? -1;
  const humanReadable = qbStatusCodeMessage(sc);
  return {
    error: {
      statusCode: sc,
      statusMessage: e.message ?? fallback,
      ...(humanReadable ? { humanReadable } : {}),
    },
  };
}

function customerRefMatches(
  ref: unknown,
  targetListId: string,
  targetFullName: string,
): boolean {
  if (!ref || typeof ref !== "object") return false;
  const r = ref as Record<string, unknown>;
  if (r.ListID !== undefined && String(r.ListID) === targetListId) return true;
  if (r.FullName !== undefined && String(r.FullName) === targetFullName) return true;
  return false;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function registerEngagementProfitabilityTools(
  server: McpServer,
  getSession: () => QBSessionManager,
): void {
  server.tool(
    "qb_engagement_profitability",
    "Per-engagement profitability rollup for one customer/job over a date window (Phase 15 #70). Pulls revenue (Invoice + SalesReceipt − CreditMemo header totals scoped server-side via EntityFilter), time (TimeTracking entries POST-FILTERED by CustomerRef — QB's TimeTrackingQueryRq has no CustomerFilter), and reimbursable expenses (Bill / Check / CreditCardCharge ExpenseLineRet + ItemLineRet rows whose LINE-LEVEL CustomerRef tags this customer for job-costing). Returns each section's payload plus a derived summary (revenue / reimbursableExpenseCost / grossProfit / marginPct / billableHours / totalHours / revenuePerHour). Pure composite over existing session primitives — no new wire types. customerListId (preferred — exact match) OR customerName is REQUIRED (the engagement IS the customer); the tool rejects with statusCode 3120 if neither resolves. fromDate / toDate are both REQUIRED (engagements have explicit windows; no defaults). Each of the three sections is FAIL-SOFT: a single section's wire failure lands in `sections.<name>.error` with `sectionStatus.<name>: 'error'`, but the rest of the response still returns. The `summary` block is OMITTED when any section reports 'error' — a partial summary would misrepresent profitability. Section toggles (`includeRevenue` / `includeTime` / `includeReimbursableExpenses`) all default true; flip individually to false to skip a section (sectionStatus flips to 'skipped'; summary still requires all three queried sections to be ok, so toggling any off also omits summary). Use cases: 'is this job profitable?', 'effective hourly rate on this client', 'is the engagement break-even after pass-throughs?', monthly job-cost reviews. Read-side; does NOT require a writable session.",
    {
      customerListId: z.string().optional()
        .describe("Customer/job ListID (preferred — exact match). One of customerListId | customerName is REQUIRED."),
      customerName: z.string().optional()
        .describe("Customer/job FullName (alternative to customerListId). One of customerListId | customerName is REQUIRED."),
      fromDate: z.string().regex(ISO_DATE_RE)
        .describe("Engagement window start (YYYY-MM-DD, inclusive against TxnDate). Required — engagements have explicit windows."),
      toDate: z.string().regex(ISO_DATE_RE)
        .describe("Engagement window end (YYYY-MM-DD, inclusive against TxnDate). Required."),
      basis: z.enum(["Accrual", "Cash"]).optional()
        .describe("Accounting basis. Defaults to Accrual. Threaded for parity with other reports; identical in simulation."),
      includeRevenue: z.boolean().optional()
        .describe("When false, skip the revenue section (sectionStatus.revenue: 'skipped'). Summary block requires all three queried sections — toggling any off omits summary. Default true."),
      includeTime: z.boolean().optional()
        .describe("When false, skip the time section (sectionStatus.time: 'skipped'). Default true."),
      includeReimbursableExpenses: z.boolean().optional()
        .describe("When false, skip the reimbursable-expenses section (sectionStatus.reimbursableExpenses: 'skipped'). Default true."),
    },
    async (args) => {
      const session = getSession();

      // -----------------------------------------------------------------
      // Customer lookup — the one non-fail-soft path. No customer, no
      // engagement to profile.
      // -----------------------------------------------------------------
      if (!args.customerListId && !args.customerName) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 3120,
              statusMessage: "Either customerListId or customerName is required",
            }),
          }],
          isError: true,
        };
      }

      if (args.fromDate > args.toDate) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 3120,
              statusMessage: `fromDate (${args.fromDate}) must be on or before toDate (${args.toDate})`,
            }),
          }],
          isError: true,
        };
      }

      let resolvedCustomer: { listId: string; fullName: string; balance?: number };
      try {
        const customerFilters: Record<string, unknown> = {};
        if (args.customerListId) customerFilters.ListID = args.customerListId;
        if (args.customerName) customerFilters.FullName = args.customerName;
        const matches = await session.queryEntity("Customer", customerFilters);
        if (matches.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                statusCode: 3120,
                statusMessage: `Customer ${args.customerListId ?? args.customerName} not found`,
                humanReadable: qbStatusCodeMessage(3120),
              }),
            }],
            isError: true,
          };
        }
        const c = matches[0] as Record<string, unknown>;
        resolvedCustomer = {
          listId: String(c.ListID ?? ""),
          fullName: String(c.FullName ?? c.Name ?? ""),
          ...(c.Balance !== undefined ? { balance: Number(c.Balance) } : {}),
        };
      } catch (err) {
        const block = asErrorBlock(err, "CustomerQueryRq failed");
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              ...block.error,
              statusMessage: `qb_engagement_profitability pre-flight failed: ${block.error.statusMessage}`,
            }),
          }],
          isError: true,
        };
      }

      const targetListId = resolvedCustomer.listId;
      const targetFullName = resolvedCustomer.fullName;
      const fromDate = args.fromDate;
      const toDate = args.toDate;
      const basis = args.basis ?? "Accrual";

      const includeRevenue = args.includeRevenue !== false;
      const includeTime = args.includeTime !== false;
      const includeReimb = args.includeReimbursableExpenses !== false;

      const sections: Record<string, unknown> = {};
      const sectionStatus: Record<string, SectionStatus> = {
        revenue: "skipped",
        time: "skipped",
        reimbursableExpenses: "skipped",
      };

      // -----------------------------------------------------------------
      // Section: Revenue (Invoice + SalesReceipt − CreditMemo).
      //
      // Server-side scope via EntityFilter (txn-header CustomerRef match) +
      // TxnDateRangeFilter. CreditMemo amounts are subtracted on the way
      // into the running total but emitted as positive `amount` rows; the
      // running net is exposed via netRevenue.
      // -----------------------------------------------------------------
      type RevenueRow = {
        txnType: "Invoice" | "SalesReceipt" | "CreditMemo";
        txnId: string;
        txnDate: string;
        refNumber: string;
        amount: number;
        memo?: string;
      };

      if (includeRevenue) {
        try {
          const baseFilters: Record<string, unknown> = {
            MaxReturned: MAX_ROWS_PER_CALL,
            TxnDateRangeFilter: { FromTxnDate: fromDate, ToTxnDate: toDate },
            EntityFilter: { ListID: targetListId },
          };

          const [invoices, salesReceipts, creditMemos] = await Promise.all([
            session.queryEntity("Invoice", baseFilters),
            session.queryEntity("SalesReceipt", baseFilters),
            session.queryEntity("CreditMemo", baseFilters),
          ]);

          const rows: RevenueRow[] = [];
          let invoiceTotal = 0;
          let salesReceiptTotal = 0;
          let creditMemoTotal = 0;

          for (const inv of invoices) {
            const total = Number(inv.Subtotal ?? 0) + Number(inv.SalesTaxTotal ?? 0);
            invoiceTotal += total;
            rows.push({
              txnType: "Invoice",
              txnId: String(inv.TxnID ?? ""),
              txnDate: String(inv.TxnDate ?? ""),
              refNumber: String(inv.RefNumber ?? ""),
              amount: round2(total),
              ...(inv.Memo !== undefined ? { memo: String(inv.Memo) } : {}),
            });
          }
          for (const sr of salesReceipts) {
            const total = Number(sr.TotalAmount ?? (Number(sr.Subtotal ?? 0) + Number(sr.SalesTaxTotal ?? 0)));
            salesReceiptTotal += total;
            rows.push({
              txnType: "SalesReceipt",
              txnId: String(sr.TxnID ?? ""),
              txnDate: String(sr.TxnDate ?? ""),
              refNumber: String(sr.RefNumber ?? ""),
              amount: round2(total),
              ...(sr.Memo !== undefined ? { memo: String(sr.Memo) } : {}),
            });
          }
          for (const cm of creditMemos) {
            const total = Number(cm.TotalAmount ?? (Number(cm.Subtotal ?? 0) + Number(cm.SalesTaxTotal ?? 0)));
            creditMemoTotal += total;
            rows.push({
              txnType: "CreditMemo",
              txnId: String(cm.TxnID ?? ""),
              txnDate: String(cm.TxnDate ?? ""),
              refNumber: String(cm.RefNumber ?? ""),
              amount: round2(total),
              ...(cm.Memo !== undefined ? { memo: String(cm.Memo) } : {}),
            });
          }

          rows.sort((a, b) => {
            if (a.txnDate !== b.txnDate) return a.txnDate < b.txnDate ? -1 : 1;
            return a.txnId < b.txnId ? -1 : a.txnId > b.txnId ? 1 : 0;
          });

          const netRevenue = invoiceTotal + salesReceiptTotal - creditMemoTotal;

          sections.revenue = {
            fromDate,
            toDate,
            basis,
            invoiceCount: invoices.length,
            salesReceiptCount: salesReceipts.length,
            creditMemoCount: creditMemos.length,
            invoiceTotal: round2(invoiceTotal),
            salesReceiptTotal: round2(salesReceiptTotal),
            creditMemoTotal: round2(creditMemoTotal),
            netRevenue: round2(netRevenue),
            transactions: rows,
          };
          sectionStatus.revenue = "ok";
        } catch (err) {
          sections.revenue = asErrorBlock(err, "Revenue section failed");
          sectionStatus.revenue = "error";
        }
      }

      // -----------------------------------------------------------------
      // Section: Time (TimeTracking entries against this customer).
      //
      // QB's TimeTrackingQueryRq has NO CustomerFilter at any version, so
      // the customer scope is a POST-FILTER (matches qb_time_track_list's
      // documented behavior). Server-side scope is the date range only.
      // Rollups: byWorker (EntityRef = the worker), byServiceItem.
      // -----------------------------------------------------------------
      type TimeEntry = {
        txnId: string;
        txnDate: string;
        entityName: string;
        entityListId?: string;
        duration: string;
        hours: number;
        isBillable: boolean;
        itemServiceName?: string;
        itemServiceListId?: string;
        notes?: string;
      };

      if (includeTime) {
        try {
          const wire = await session.queryEntity("TimeTracking", {
            MaxReturned: MAX_ROWS_PER_CALL,
            TxnDateRangeFilter: { FromTxnDate: fromDate, ToTxnDate: toDate },
          });

          const matching = wire.filter((e) =>
            customerRefMatches(e.CustomerRef, targetListId, targetFullName),
          );

          let totalHours = 0;
          let billableHours = 0;
          let nonBillableHours = 0;
          const byWorker = new Map<string, {
            entityName: string;
            entityListId?: string;
            hours: number;
            billableHours: number;
            entryCount: number;
          }>();
          const byServiceItem = new Map<string, {
            itemServiceName: string;
            itemServiceListId?: string;
            hours: number;
            entryCount: number;
          }>();
          const entries: TimeEntry[] = [];

          for (const e of matching) {
            const duration = String(e.Duration ?? "");
            const hours = duration ? (parseDurationToHours(duration) ?? 0) : 0;
            const isBillable = e.IsBillable === true;
            const entityRef = e.EntityRef as Record<string, unknown> | undefined;
            const entityName = String(entityRef?.FullName ?? "");
            const entityListId = entityRef?.ListID !== undefined ? String(entityRef.ListID) : undefined;
            const itemRef = e.ItemServiceRef as Record<string, unknown> | undefined;
            const itemServiceName = itemRef?.FullName !== undefined ? String(itemRef.FullName) : undefined;
            const itemServiceListId = itemRef?.ListID !== undefined ? String(itemRef.ListID) : undefined;

            totalHours += hours;
            if (isBillable) billableHours += hours;
            else nonBillableHours += hours;

            const workerKey = entityListId ?? entityName;
            const w = byWorker.get(workerKey) ?? {
              entityName,
              ...(entityListId ? { entityListId } : {}),
              hours: 0,
              billableHours: 0,
              entryCount: 0,
            };
            w.hours += hours;
            if (isBillable) w.billableHours += hours;
            w.entryCount += 1;
            byWorker.set(workerKey, w);

            if (itemServiceName) {
              const itemKey = itemServiceListId ?? itemServiceName;
              const it = byServiceItem.get(itemKey) ?? {
                itemServiceName,
                ...(itemServiceListId ? { itemServiceListId } : {}),
                hours: 0,
                entryCount: 0,
              };
              it.hours += hours;
              it.entryCount += 1;
              byServiceItem.set(itemKey, it);
            }

            entries.push({
              txnId: String(e.TxnID ?? ""),
              txnDate: String(e.TxnDate ?? ""),
              entityName,
              ...(entityListId ? { entityListId } : {}),
              duration,
              hours: round2(hours),
              isBillable,
              ...(itemServiceName ? { itemServiceName } : {}),
              ...(itemServiceListId ? { itemServiceListId } : {}),
              ...(e.Notes !== undefined ? { notes: String(e.Notes) } : {}),
            });
          }

          entries.sort((a, b) => {
            if (a.txnDate !== b.txnDate) return a.txnDate < b.txnDate ? -1 : 1;
            return a.txnId < b.txnId ? -1 : a.txnId > b.txnId ? 1 : 0;
          });

          const byWorkerArr = [...byWorker.values()]
            .map((w) => ({
              ...w,
              hours: round2(w.hours),
              billableHours: round2(w.billableHours),
            }))
            .sort((a, b) => b.hours - a.hours);

          const byServiceItemArr = [...byServiceItem.values()]
            .map((i) => ({ ...i, hours: round2(i.hours) }))
            .sort((a, b) => b.hours - a.hours);

          sections.time = {
            fromDate,
            toDate,
            entryCount: matching.length,
            totalHours: round2(totalHours),
            billableHours: round2(billableHours),
            nonBillableHours: round2(nonBillableHours),
            byWorker: byWorkerArr,
            byServiceItem: byServiceItemArr,
            entries,
          };
          sectionStatus.time = "ok";
        } catch (err) {
          sections.time = asErrorBlock(err, "Time section failed");
          sectionStatus.time = "error";
        }
      }

      // -----------------------------------------------------------------
      // Section: Reimbursable Expenses (Bill + Check + CreditCardCharge).
      //
      // Bill/Check/CCC do NOT carry a header-level CustomerRef — job-costing
      // tags live on each *Line* (ExpenseLineRet / ItemLineRet carry their
      // own CustomerRef). So we pull all parents in the date window and
      // walk lines line-by-line, keeping only those whose CustomerRef
      // matches the target.
      //
      // Each surviving line carries:
      //   - parent txn metadata (txnType / txnId / txnDate / refNumber /
      //     vendorName)
      //   - line-level fields (accountName, amount, memo, billable state)
      //
      // The total here is the SUM of matched line amounts, NOT the parent
      // txn totals — important because one bill might split across multiple
      // jobs and only a subset of its lines tag THIS customer.
      // -----------------------------------------------------------------
      type ExpenseLineRow = {
        txnType: "Bill" | "Check" | "CreditCardCharge";
        txnId: string;
        txnDate: string;
        refNumber: string;
        vendorName: string;
        accountName: string;
        itemName?: string;
        amount: number;
        memo?: string;
        isBillable?: boolean;
        billableStatus?: string;
      };

      if (includeReimb) {
        try {
          // IncludeLineItems is REQUIRED here — real QB strips *LineRet
          // from Bill/Check/CCC query responses unless this flag is set, and
          // the sim mirrors that behavior. Without it, every line we'd walk
          // to find a line-level CustomerRef tag is silently absent.
          const dateFilters: Record<string, unknown> = {
            MaxReturned: MAX_ROWS_PER_CALL,
            TxnDateRangeFilter: { FromTxnDate: fromDate, ToTxnDate: toDate },
            IncludeLineItems: true,
          };
          const [bills, checks, ccCharges] = await Promise.all([
            session.queryEntity("Bill", dateFilters),
            session.queryEntity("Check", dateFilters),
            session.queryEntity("CreditCardCharge", dateFilters),
          ]);

          const rows: ExpenseLineRow[] = [];
          let total = 0;
          let billableTotal = 0;
          let nonBillableTotal = 0;
          const counts = { Bill: 0, Check: 0, CreditCardCharge: 0 };
          const seenParents = { Bill: new Set<string>(), Check: new Set<string>(), CreditCardCharge: new Set<string>() };

          const walk = (
            txnType: "Bill" | "Check" | "CreditCardCharge",
            parents: Record<string, unknown>[],
            vendorRefField: "VendorRef" | "PayeeEntityRef",
          ): void => {
            for (const parent of parents) {
              const vendorRef = parent[vendorRefField] as Record<string, unknown> | undefined;
              const vendorName = String(vendorRef?.FullName ?? "");
              const txnId = String(parent.TxnID ?? "");
              const txnDate = String(parent.TxnDate ?? "");
              const refNumber = String(parent.RefNumber ?? "");

              for (const lineKey of ["ExpenseLineRet", "ItemLineRet"]) {
                const lines = parent[lineKey];
                if (!Array.isArray(lines)) continue;
                for (const line of lines as Record<string, unknown>[]) {
                  if (!customerRefMatches(line.CustomerRef, targetListId, targetFullName)) continue;

                  const accountRef = line.AccountRef as Record<string, unknown> | undefined;
                  const itemRef = line.ItemRef as Record<string, unknown> | undefined;
                  const accountName = String(accountRef?.FullName ?? "");
                  const itemName = itemRef?.FullName !== undefined ? String(itemRef.FullName) : undefined;
                  const amount = Number(line.Amount ?? 0);
                  const isBillable = line.BillableStatus === "Billable" || line.BillableStatus === "HasBeenBilled";
                  total += amount;
                  if (isBillable) billableTotal += amount;
                  else nonBillableTotal += amount;

                  if (!seenParents[txnType].has(txnId)) {
                    seenParents[txnType].add(txnId);
                    counts[txnType] += 1;
                  }

                  rows.push({
                    txnType,
                    txnId,
                    txnDate,
                    refNumber,
                    vendorName,
                    accountName,
                    ...(itemName ? { itemName } : {}),
                    amount: round2(amount),
                    ...(line.Memo !== undefined ? { memo: String(line.Memo) } : {}),
                    ...(line.BillableStatus !== undefined ? {
                      isBillable,
                      billableStatus: String(line.BillableStatus),
                    } : {}),
                  });
                }
              }
            }
          };

          walk("Bill", bills, "VendorRef");
          walk("Check", checks, "PayeeEntityRef");
          walk("CreditCardCharge", ccCharges, "PayeeEntityRef");

          rows.sort((a, b) => {
            if (a.txnDate !== b.txnDate) return a.txnDate < b.txnDate ? -1 : 1;
            return a.txnId < b.txnId ? -1 : a.txnId > b.txnId ? 1 : 0;
          });

          sections.reimbursableExpenses = {
            fromDate,
            toDate,
            lineCount: rows.length,
            billCount: counts.Bill,
            checkCount: counts.Check,
            creditCardChargeCount: counts.CreditCardCharge,
            total: round2(total),
            billableTotal: round2(billableTotal),
            nonBillableTotal: round2(nonBillableTotal),
            lines: rows,
          };
          sectionStatus.reimbursableExpenses = "ok";
        } catch (err) {
          sections.reimbursableExpenses = asErrorBlock(err, "Reimbursable expenses section failed");
          sectionStatus.reimbursableExpenses = "error";
        }
      }

      // -----------------------------------------------------------------
      // Derived summary — only when EVERY queried section succeeded. If
      // any section errored, omit the summary (partial profitability is
      // worse than no profitability).
      // -----------------------------------------------------------------
      const allOk =
        (!includeRevenue || sectionStatus.revenue === "ok") &&
        (!includeTime || sectionStatus.time === "ok") &&
        (!includeReimb || sectionStatus.reimbursableExpenses === "ok");

      let summary: Record<string, number | null> | undefined;
      if (allOk && includeRevenue && includeTime && includeReimb) {
        const rev = sections.revenue as { netRevenue: number };
        const time = sections.time as { totalHours: number; billableHours: number };
        const exp = sections.reimbursableExpenses as { total: number };
        const grossProfit = rev.netRevenue - exp.total;
        const marginPct = rev.netRevenue !== 0
          ? round2((grossProfit / rev.netRevenue) * 100)
          : null;
        const revenuePerHour = time.totalHours > 0
          ? round2(rev.netRevenue / time.totalHours)
          : null;
        const billableRate = time.billableHours > 0
          ? round2(rev.netRevenue / time.billableHours)
          : null;
        summary = {
          revenue: rev.netRevenue,
          reimbursableExpenseCost: exp.total,
          grossProfit: round2(grossProfit),
          marginPct,
          billableHours: time.billableHours,
          totalHours: time.totalHours,
          revenuePerHour,
          billableRate,
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            customer: resolvedCustomer,
            fromDate,
            toDate,
            basis,
            generatedAt: new Date().toISOString(),
            sections,
            sectionStatus,
            ...(summary ? { summary } : {}),
          }, null, 2),
        }],
      };
    },
  );
}
