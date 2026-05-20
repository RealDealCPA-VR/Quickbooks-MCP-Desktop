/**
 * Time tracking tools for QuickBooks Desktop MCP.
 *
 * Phase 17 #78 — TimeTrackingAdd / TimeTrackingQuery. Each TimeTracking entry
 * records ONE work session — a date, a worker (Employee / Vendor / OtherName
 * via EntityRef), an optional client/job (CustomerRef), an optional service
 * item (ItemServiceRef), and a duration. Non-posting: TimeTracking creates
 * no GL effect on its own. Two downstream surfaces consume it:
 *   1. Payroll — hourly employees' timesheets feed paycheck calculations
 *      when PayrollItemWageRef is set (the SDK exposes the link but the
 *      compute step requires a payroll subscription).
 *   2. Billing — billable entries (IsBillable: true) can later flow onto
 *      invoices via the Time/Costs dialog; until then they live as
 *      uninvoiced work-in-progress.
 *
 * TimeTracking is a TRANSACTION in QB (TxnID + EditSequence + TxnDelRq), so
 * it lives alongside Invoice/Bill/Check/etc. in the transaction-type lists.
 * It carries NO line set — the entry IS the line. Duration is ISO 8601
 * (PT-H-M-S); the tool layer accepts decimal `hours` as a friendlier alias
 * and round-trips both forms.
 *
 * Foundation for Phase 15 #70 (qb_engagement_profitability) — that composite
 * needs hours-per-job to compute service-business profitability. Also the
 * primary blocker on any service-business billing-by-time workflow.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { formatToolError } from "../util/format-tool-error.js";
import { ISO_DATE_RE } from "../util/validators.js";

// ---------------------------------------------------------------------------
// Duration helpers (pure — exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Parse an ISO 8601 duration in PT-H-M-S form into decimal hours.
 *
 * QB's TimeTracking Duration field accepts ISO 8601 durations restricted to
 * the time portion only — `PT8H`, `PT8H30M`, `PT45M`, `PT8H30M15S`. Returns
 * null on malformed input (missing PT prefix, day/year components, unknown
 * units) so callers can branch on `null` rather than catching exceptions.
 *
 * Examples:
 *   "PT8H"        → 8
 *   "PT8H30M"     → 8.5
 *   "PT45M"       → 0.75
 *   "PT8H30M15S"  → 8.504166666666666
 *   "PT0H"        → 0
 *   "P1D"         → null  (day component unsupported by QB)
 *   "8 hours"     → null  (free-form text rejected)
 */
export function parseDurationToHours(iso: string): number | null {
  if (typeof iso !== "string") return null;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return null;
  const [, hStr, mStr, sStr] = m;
  // PT alone with no H/M/S components is malformed.
  if (hStr === undefined && mStr === undefined && sStr === undefined) return null;
  const h = Number(hStr ?? 0);
  const min = Number(mStr ?? 0);
  const s = Number(sStr ?? 0);
  return h + min / 60 + s / 3600;
}

/**
 * Format decimal hours as an ISO 8601 PT-H-M-S duration string.
 *
 * Rounds to the nearest second before splitting into H/M/S so that decimal
 * inputs like 8.5 emit cleanly as "PT8H30M" rather than carrying floating-
 * point drift into the seconds field. Omits zero components except for the
 * pathological 0-hours case which emits "PT0H" (rather than the malformed
 * "PT" which parseDurationToHours rejects).
 *
 * Examples:
 *   8       → "PT8H"
 *   8.5     → "PT8H30M"
 *   0.75    → "PT45M"
 *   0       → "PT0H"
 *   0.0001  → "PT0H"  (rounds to zero seconds)
 *
 * Throws on negative or non-finite input — caller must validate at the
 * Zod boundary.
 */
export function formatHoursAsDuration(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) {
    throw new Error(`Invalid hours: ${hours} (must be a non-negative finite number)`);
  }
  const totalSeconds = Math.round(hours * 3600);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h === 0 && m === 0 && s === 0) return "PT0H";
  let out = "PT";
  if (h > 0) out += `${h}H`;
  if (m > 0) out += `${m}M`;
  if (s > 0) out += `${s}S`;
  return out;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerTimeTrackingTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_time_track_list",
    "List or search time-tracking entries (TimeTracking transactions) in QuickBooks Desktop. Each row represents ONE work session — a date, a worker (Employee/Vendor/OtherName), an optional customer/job, an optional service item, and a Duration (ISO 8601 PT-H-M-S). Each row also surfaces a derived `hours` field (decimal hours parsed from Duration) for convenience. Filter by txnId, worker (entityName / entityListId — applies server-side via EntityFilter), customer (customerName / customerListId — applied as a POST-FILTER in the tool layer because QB's TimeTrackingQueryRq has no CustomerFilter), date range, or billable-only flag (also post-filtered). Set paginate:true for iterator-based pagination — maxReturned defaults to 500 when paginate is enabled.",
    {
      txnId: z.string().optional().describe("Fetch a specific time-tracking entry by TxnID"),
      entityName: z.string().optional().describe("Worker (Employee/Vendor/OtherName) full name — scoped server-side via TimeTrackingQueryRq's EntityFilter"),
      entityListId: z.string().optional().describe("Worker ListID (alternative to entityName)"),
      customerName: z.string().optional().describe("Customer/job FullName — POST-FILTERED in the tool layer (QB's TimeTrackingQueryRq has no CustomerFilter). Pulls the wire result first, then filters; combining with paginate may miss matches beyond the page."),
      customerListId: z.string().optional().describe("Customer ListID (alternative to customerName) — also POST-FILTERED"),
      fromDate: z.string().regex(ISO_DATE_RE).optional().describe("Start date filter (YYYY-MM-DD) — inclusive against TxnDate"),
      toDate: z.string().regex(ISO_DATE_RE).optional().describe("End date filter (YYYY-MM-DD) — inclusive against TxnDate"),
      billableOnly: z.boolean().optional().describe("When true, only return entries with IsBillable === true. Post-filtered (QB's TimeTrackingQueryRq has no billable-status filter)."),
      maxReturned: z.number().optional().describe("Maximum results. Defaults to 500 when paginate is enabled (QB's per-batch cap); otherwise QB-driven."),
      paginate: z.boolean().optional().describe("Enable iterator-based pagination. Response surfaces iteratorRemainingCount + iteratorID. Auto-defaults maxReturned to 500 if unset."),
      iteratorID: z.string().optional().describe("Continue an existing iterator by passing the iteratorID from a prior paginated response. Implies paginate."),
    },
    async (args) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      const effectiveMaxReturned =
        args.maxReturned ?? (args.paginate || args.iteratorID ? 500 : undefined);

      if (args.txnId) filters.TxnID = args.txnId;
      if (effectiveMaxReturned) filters.MaxReturned = effectiveMaxReturned;
      if (args.fromDate || args.toDate) {
        filters.TxnDateRangeFilter = { FromTxnDate: args.fromDate, ToTxnDate: args.toDate };
      }
      if (args.entityName || args.entityListId) {
        const ef: Record<string, unknown> = {};
        if (args.entityListId) ef.ListID = args.entityListId;
        else if (args.entityName) ef.FullName = args.entityName;
        filters.EntityFilter = ef;
      }

      // Post-filters applied to the wire response (QB's TimeTrackingQueryRq
      // has no CustomerFilter / billable filter, so these run client-side).
      // Each entry's `hours` field is derived from Duration on the way out so
      // callers don't have to parse PT-H-M-S themselves.
      const applyPostFilters = (
        entries: Record<string, unknown>[]
      ): Record<string, unknown>[] => {
        let out = entries;
        if (args.customerListId || args.customerName) {
          const targetListId = args.customerListId;
          const targetName = args.customerName;
          out = out.filter((e) => {
            const ref = e.CustomerRef as Record<string, unknown> | undefined;
            if (!ref) return false;
            if (targetListId && String(ref.ListID ?? "") === targetListId) return true;
            if (targetName && String(ref.FullName ?? "") === targetName) return true;
            return false;
          });
        }
        if (args.billableOnly) {
          out = out.filter((e) => e.IsBillable === true);
        }
        return out.map((e) => {
          const duration = e.Duration ? String(e.Duration) : null;
          const hours = duration !== null ? parseDurationToHours(duration) : null;
          return { ...e, hours };
        });
      };

      try {
        if (args.paginate || args.iteratorID) {
          const result = await session.queryEntityPaginated("TimeTracking", filters, {
            iterator: args.iteratorID ? "Continue" : "Start",
            iteratorID: args.iteratorID,
          });
          const entries = applyPostFilters(result.entities);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                count: entries.length,
                entries,
                ...(result.iteratorRemainingCount !== undefined
                  ? { iteratorRemainingCount: result.iteratorRemainingCount }
                  : {}),
                ...(result.iteratorID !== undefined
                  ? { iteratorID: result.iteratorID }
                  : {}),
              }, null, 2),
            }],
          };
        }

        const wire = await session.queryEntity("TimeTracking", filters);
        const entries = applyPostFilters(wire);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: entries.length, entries }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "TimeTrackingQueryRq failed" });
      }
    }
  );

  server.tool(
    "qb_time_track_add",
    "Create a new TimeTracking entry in QuickBooks Desktop. Records a single work session for ONE worker (Employee / Vendor / OtherName via entityName | entityListId) on a given date. Duration is supplied either as decimal `hours` (e.g. 8.5 → PT8H30M) or as `duration` (ISO 8601 PT-H-M-S — overrides hours when both supplied). Optional customer (customerName | customerListId) attaches the work to a job; optional service item (itemServiceName | itemServiceListId) names what to bill as. billable:true sets IsBillable for downstream invoice flows (the Time/Costs dialog). TimeTracking is NON-POSTING — no GL effect, no AR/AP movement; downstream consumers are payroll (when payrollItemWageName is set) and billing. Read-only sessions reject with statusCode 9001.",
    {
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("Work date (YYYY-MM-DD). Default: today (when omitted, QB uses today)."),
      entityName: z.string().optional().describe("Worker (Employee / Vendor / OtherName) full name — REQUIRED unless entityListId is supplied. This is WHO did the work, not the customer the work is billed to."),
      entityListId: z.string().optional().describe("Worker ListID (alternative to entityName)"),
      customerName: z.string().optional().describe("Customer / job FullName the work is tracked against (optional — required only when downstream invoicing needs it)"),
      customerListId: z.string().optional().describe("Customer ListID (alternative to customerName)"),
      itemServiceName: z.string().optional().describe("Service item FullName describing what to bill as (e.g. 'Consulting Services'). Required only if billable and you want the invoice line to pre-populate."),
      itemServiceListId: z.string().optional().describe("Service item ListID (alternative to itemServiceName)"),
      hours: z.number().positive().optional().describe("Work duration in decimal hours (e.g. 8.5 = 8 hours 30 minutes). Converted to ISO 8601 PT-H-M-S before sending to QB. Required unless `duration` is supplied."),
      duration: z.string().regex(/^PT(?:\d+H)?(?:\d+M)?(?:\d+S)?$/).optional().describe("Pre-formatted ISO 8601 PT-H-M-S duration (e.g. 'PT8H30M'). Overrides `hours` when both supplied. Useful when carrying a value verbatim from another QB query."),
      className: z.string().optional().describe("Class FullName (optional, for class tracking)"),
      payrollItemWageName: z.string().optional().describe("PayrollItemWage FullName — links the timesheet entry to a payroll wage item so paycheck calculations pick it up. Requires a payroll subscription on the live QB; sim records the ref verbatim."),
      notes: z.string().optional().describe("Free-form notes / work description (printed on timesheet reports + the Time/Costs dialog)"),
      billable: z.boolean().optional().describe("When true, marks the entry as billable (IsBillable=true, BillableStatus='Billable'). Required for downstream invoice flow via the Time/Costs dialog. Default unset = NotBillable."),
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original result without creating a duplicate entry (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002."),
      dryRun: z.boolean().optional().describe("If true, preview what this call WOULD do without committing. See qb_customer_add's dryRun docs for the full composition matrix."),
    },
    async (args) => {
      const session = getSession();

      if (!args.entityName && !args.entityListId) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "Either entityName or entityListId is required (the worker who did the work)",
            }),
          }],
          isError: true,
        };
      }

      if (args.hours === undefined && args.duration === undefined) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "Either hours or duration is required",
            }),
          }],
          isError: true,
        };
      }

      // duration wins when both supplied (operator's explicit verbatim
      // override). Validate format separately from the Zod regex so the
      // error message names the malformed value.
      let durationIso: string;
      if (args.duration !== undefined) {
        const parsedCheck = parseDurationToHours(args.duration);
        if (parsedCheck === null) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: `Malformed duration: ${args.duration}. Expected ISO 8601 PT-H-M-S form (e.g. 'PT8H30M').`,
              }),
            }],
            isError: true,
          };
        }
        durationIso = args.duration;
      } else {
        durationIso = formatHoursAsDuration(args.hours!);
      }

      const data: Record<string, unknown> = {
        Duration: durationIso,
      };
      if (args.txnDate) data.TxnDate = args.txnDate;
      if (args.entityListId) {
        data.EntityRef = { ListID: args.entityListId };
      } else {
        data.EntityRef = { FullName: args.entityName };
      }
      if (args.customerListId) {
        data.CustomerRef = { ListID: args.customerListId };
      } else if (args.customerName) {
        data.CustomerRef = { FullName: args.customerName };
      }
      if (args.itemServiceListId) {
        data.ItemServiceRef = { ListID: args.itemServiceListId };
      } else if (args.itemServiceName) {
        data.ItemServiceRef = { FullName: args.itemServiceName };
      }
      if (args.className) data.ClassRef = { FullName: args.className };
      if (args.payrollItemWageName) {
        data.PayrollItemWageRef = { FullName: args.payrollItemWageName };
      }
      if (args.notes) data.Notes = args.notes;
      if (args.billable !== undefined) {
        // Both fields emitted: IsBillable is the legacy/primary boolean QB
        // honors on AddRq; BillableStatus is the enum that round-trips back
        // on the Ret. Setting both keeps downstream readers (the Time/Costs
        // dialog, qb_time_track_list with billableOnly) unambiguous.
        data.IsBillable = args.billable;
        data.BillableStatus = args.billable ? "Billable" : "NotBillable";
      }

      if (args.dryRun) {
        try {
          const preview = await session.addEntityDryRun("TimeTracking", data, args.idempotencyKey);
          const { entity, ...rest } = preview;
          const persistedDuration = entity?.Duration ? String(entity.Duration) : null;
          const hours = persistedDuration !== null ? parseDurationToHours(persistedDuration) : null;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                dryRun: true,
                ...rest,
                ...(entity ? { timeTracking: { ...entity, hours } } : {}),
              }, null, 2),
            }],
          };
        } catch (err) {
          return formatToolError(err, { fallbackMessage: "TimeTrackingAddRq dry-run failed" });
        }
      }

      try {
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent("TimeTracking", data, args.idempotencyKey)
          : { entity: await session.addEntity("TimeTracking", data), replayed: false };
        // Derive `hours` from the persisted Duration so the response shape
        // matches what qb_time_track_list returns.
        const persistedDuration = result.Duration ? String(result.Duration) : null;
        const hours = persistedDuration !== null ? parseDurationToHours(persistedDuration) : null;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              timeTracking: { ...result, hours },
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "TimeTrackingAddRq failed" });
      }
    }
  );
}
