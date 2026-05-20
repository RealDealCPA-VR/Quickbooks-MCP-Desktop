/**
 * Vehicle mileage tools for QuickBooks Desktop MCP.
 *
 * Phase 17 #79 — VehicleMileage + Vehicle. Tax-practice staple: every
 * Schedule C self-employed return and every Form 4562 vehicle-listing
 * needs a clean mileage log for business miles driven. The QBXML SDK
 * exposes:
 *   - VehicleQueryRq            (read-only list of vehicles)
 *   - VehicleMileageAddRq       (log one trip)
 *   - VehicleMileageQueryRq     (read trip log)
 *
 * Notably absent: VehicleMileageModRq. The SDK has NO write path to
 * mutate an existing trip at any qbXML version through 16.0 — operators
 * delete + recreate on real QB Desktop. This server reflects that:
 * there is no qb_vehicle_mileage_update tool, and VehicleMileage is
 * intentionally NOT in the *Mod surface even though the four
 * transaction-type lists still carry it for TxnDelRq routing.
 *
 * VehicleMileage is a TRANSACTION in QB (TxnID + TimeCreated/Modified +
 * deletes via TxnDelRq) but NON-POSTING — no GL effect, no AR/AP
 * movement. It's a write-once payload consumed by:
 *   1. Schedule C / Form 4562 prep (mileage × IRS standard rate =
 *      deductible expense).
 *   2. Customer billing — billable trips with a CustomerRef + ItemRef
 *      flow onto invoices via the Time/Costs dialog, same path
 *      TimeTracking uses.
 *
 * Vehicle is a LIST entity (ListID + FullName + IsActive). The SDK
 * exposes VehicleAddRq + VehicleModRq + VehicleQueryRq, but this server
 * exposes only the read-only list — vehicles are infrequent setup work
 * (a CPA firm adds a new truck once a year), and operators do it
 * directly in QB Desktop's UI. Extend if a real workflow surfaces the
 * need.
 *
 * Schema canonical child order for VehicleMileageAddRq (per qbxmlops130
 * — pin in tests/builder-emit-order.test.ts if live QB rejects with
 * statusCode -1 on a schema-order class of bug):
 *   VehicleRef → TripStartDate → TripEndDate → OdometerStart →
 *   OdometerEnd → TotalMiles → CustomerRef → ItemRef → ClassRef →
 *   Notes → BillableStatus
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { formatToolError } from "../util/format-tool-error.js";
import { ISO_DATE_RE } from "../util/validators.js";

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerVehicleMileageTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_vehicle_list",
    "List vehicles registered in QuickBooks Desktop's Vehicle list. Used to discover valid vehicleName / vehicleListId values for qb_vehicle_mileage_add. Default scope is active vehicles only — pass includeInactive:true to see retired vehicles. Vehicles are infrequent setup work (typically added directly in QB Desktop's UI); this server exposes only the read-only list, not VehicleAdd / VehicleMod.",
    {
      nameFilter: z.string().optional().describe("Substring match against the vehicle's FullName (case-sensitive Contains, mirrors QB's default NameFilter MatchCriterion)"),
      vehicleListId: z.string().optional().describe("Fetch a specific vehicle by ListID"),
      includeInactive: z.boolean().optional().describe("When true, include vehicles flagged IsActive=false. Default false (active vehicles only) matches QB's default report view."),
      maxReturned: z.number().optional().describe("Maximum results. QB-driven default; cap at 500 per the SDK."),
    },
    async (args) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      if (args.vehicleListId) filters.ListID = args.vehicleListId;
      if (args.nameFilter) {
        filters.NameFilter = { MatchCriterion: "Contains", Name: args.nameFilter };
      }
      filters.ActiveStatus = args.includeInactive ? "All" : "ActiveOnly";
      if (args.maxReturned) filters.MaxReturned = args.maxReturned;

      try {
        const wire = await session.queryEntity("Vehicle", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: wire.length, vehicles: wire }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "VehicleQueryRq failed" });
      }
    }
  );

  server.tool(
    "qb_vehicle_mileage_list",
    "List or search vehicle mileage trips (VehicleMileage transactions) in QuickBooks Desktop. Each row represents ONE trip — a vehicle (VehicleRef), trip start + end dates, optional odometer readings, total miles, optional customer/job (for billable trips), optional service item (sets the billing rate), and a BillableStatus. Filter by txnId, vehicle (vehicleName / vehicleListId — server-side via VehicleFilter), customer (customerName / customerListId — POST-FILTERED at the tool layer because QB's VehicleMileageQueryRq has no CustomerFilter), trip date range (TripStartDate-scoped, NOT TxnDate — VehicleMileage has no TxnDate field), or billableStatus ('Billable' | 'NotBillable' | 'HasBeenBilled'). Set paginate:true for iterator-based pagination — maxReturned defaults to 500 when paginate is enabled.",
    {
      txnId: z.string().optional().describe("Fetch a specific trip by TxnID"),
      vehicleName: z.string().optional().describe("Vehicle FullName — scoped server-side via VehicleMileageQueryRq's VehicleFilter"),
      vehicleListId: z.string().optional().describe("Vehicle ListID (alternative to vehicleName)"),
      customerName: z.string().optional().describe("Customer/job FullName — POST-FILTERED in the tool layer (QB's VehicleMileageQueryRq has no CustomerFilter). Pulls the wire result first, then filters; combining with paginate may miss matches beyond the page."),
      customerListId: z.string().optional().describe("Customer ListID (alternative to customerName) — also POST-FILTERED"),
      fromDate: z.string().regex(ISO_DATE_RE).optional().describe("Start date filter (YYYY-MM-DD) — inclusive against TripStartDate"),
      toDate: z.string().regex(ISO_DATE_RE).optional().describe("End date filter (YYYY-MM-DD) — inclusive against TripStartDate"),
      billableStatus: z.enum(["Billable", "NotBillable", "HasBeenBilled"]).optional().describe("Scope to one BillableStatus value. Server-side filter."),
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
        filters.TripDateRangeFilter = { FromTripDate: args.fromDate, ToTripDate: args.toDate };
      }
      if (args.vehicleName || args.vehicleListId) {
        const vf: Record<string, unknown> = {};
        if (args.vehicleListId) vf.ListID = args.vehicleListId;
        else if (args.vehicleName) vf.FullName = args.vehicleName;
        filters.VehicleFilter = vf;
      }
      if (args.billableStatus) filters.BillableStatus = args.billableStatus;

      // Post-filter by customer at the tool layer — QB's VehicleMileageQueryRq
      // has no CustomerFilter (mirrors TimeTracking's situation), so callers
      // pulling a customer's full trip log over a large window must be aware
      // that combining customerName with paginate may miss matches past the
      // first page.
      const applyPostFilters = (
        entries: Record<string, unknown>[]
      ): Record<string, unknown>[] => {
        if (!args.customerListId && !args.customerName) return entries;
        const targetListId = args.customerListId;
        const targetName = args.customerName;
        return entries.filter((e) => {
          const ref = e.CustomerRef as Record<string, unknown> | undefined;
          if (!ref) return false;
          if (targetListId && String(ref.ListID ?? "") === targetListId) return true;
          if (targetName && String(ref.FullName ?? "") === targetName) return true;
          return false;
        });
      };

      try {
        if (args.paginate || args.iteratorID) {
          const result = await session.queryEntityPaginated("VehicleMileage", filters, {
            iterator: args.iteratorID ? "Continue" : "Start",
            iteratorID: args.iteratorID,
          });
          const trips = applyPostFilters(result.entities);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                count: trips.length,
                trips,
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

        const wire = await session.queryEntity("VehicleMileage", filters);
        const trips = applyPostFilters(wire);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: trips.length, trips }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "VehicleMileageQueryRq failed" });
      }
    }
  );

  server.tool(
    "qb_vehicle_mileage_add",
    "Log a vehicle mileage trip (VehicleMileage) in QuickBooks Desktop. Records ONE trip on ONE vehicle (vehicleName | vehicleListId — REQUIRED). Distance is supplied either as `totalMiles` directly OR as both `odometerStart` + `odometerEnd` (the sim derives TotalMiles = end − start when totalMiles is omitted; explicit totalMiles wins). Optional customer (customerName | customerListId) attaches the trip to a job for billable mileage; optional service item (itemName | itemListId) sets the billing rate. billable:true sets BillableStatus='Billable' (Time/Costs dialog can carry this onto a future invoice); billable:false → 'NotBillable'; unset leaves the field absent (QB's default). VehicleMileage is NON-POSTING — no GL effect, no AR/AP movement. The QBXML SDK has NO VehicleMileageModRq, so trips are immutable from the SDK's perspective; delete + recreate on real QB if a trip needs to change. Read-only sessions reject with statusCode 9001.",
    {
      vehicleName: z.string().optional().describe("Vehicle FullName from qb_vehicle_list — REQUIRED unless vehicleListId is supplied"),
      vehicleListId: z.string().optional().describe("Vehicle ListID (alternative to vehicleName)"),
      tripStartDate: z.string().regex(ISO_DATE_RE).describe("Trip start date (YYYY-MM-DD) — REQUIRED. For single-day trips, set this and tripEndDate to the same value."),
      tripEndDate: z.string().regex(ISO_DATE_RE).describe("Trip end date (YYYY-MM-DD) — REQUIRED. For single-day trips, match tripStartDate."),
      odometerStart: z.number().int().nonnegative().optional().describe("Odometer reading at trip start. Optional, but if supplied odometerEnd must also be supplied (the pair derives TotalMiles when totalMiles is omitted)."),
      odometerEnd: z.number().int().nonnegative().optional().describe("Odometer reading at trip end. Must be ≥ odometerStart (a rollback typically signals a data-entry error; the sim accepts the negative delta but flags it via response)."),
      totalMiles: z.number().nonnegative().optional().describe("Trip distance in miles. Required unless BOTH odometerStart + odometerEnd are supplied. When totalMiles is explicit it overrides the odometer-derived value."),
      customerName: z.string().optional().describe("Customer / job FullName for billable trips (optional). Required only when this trip should flow onto a future invoice via the Time/Costs dialog."),
      customerListId: z.string().optional().describe("Customer ListID (alternative to customerName)"),
      itemName: z.string().optional().describe("Service item FullName naming what the trip should bill as on a future invoice (typically a 'Mileage' service item with a per-mile Rate)"),
      itemListId: z.string().optional().describe("Service item ListID (alternative to itemName)"),
      className: z.string().optional().describe("Class FullName (optional, for class tracking)"),
      notes: z.string().optional().describe("Free-form notes / trip description (printed on mileage reports + the Time/Costs dialog)"),
      billable: z.boolean().optional().describe("When true, sets BillableStatus='Billable' (Time/Costs dialog can carry this onto a future invoice); false sets 'NotBillable'; unset leaves the field absent (QB's default)."),
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original result without creating a duplicate trip (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002."),
      dryRun: z.boolean().optional().describe("If true, preview what this call WOULD do without committing. See qb_customer_add's dryRun docs for the full composition matrix."),
    },
    async (args) => {
      const session = getSession();

      if (!args.vehicleName && !args.vehicleListId) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "Either vehicleName or vehicleListId is required",
            }),
          }],
          isError: true,
        };
      }

      // Mileage source: either explicit totalMiles, OR both odometers. Rejecting
      // a partial odometer pair (only start, only end) upfront so the sim
      // never has to guess at a missing reading. The half-pair check runs
      // FIRST so an operator who supplied just one side gets a precise
      // "they must come together" message rather than the generic
      // totalMiles-or-odometer-pair-needed message.
      const hasOdometerStart = args.odometerStart !== undefined;
      const hasOdometerEnd = args.odometerEnd !== undefined;
      const hasOdometerPair = hasOdometerStart && hasOdometerEnd;
      if ((hasOdometerStart && !hasOdometerEnd) || (!hasOdometerStart && hasOdometerEnd)) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "odometerStart and odometerEnd must be supplied together (or omit both and pass totalMiles directly)",
            }),
          }],
          isError: true,
        };
      }
      if (args.totalMiles === undefined && !hasOdometerPair) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "Provide either totalMiles, or BOTH odometerStart + odometerEnd",
            }),
          }],
          isError: true,
        };
      }

      // Canonical child order per qbxmlops130: VehicleRef → TripStartDate →
      // TripEndDate → OdometerStart → OdometerEnd → TotalMiles → CustomerRef
      // → ItemRef → ClassRef → Notes → BillableStatus. JS object insertion
      // order is preserved through fast-xml-parser's serializer; if live QB
      // rejects with statusCode -1, pin the order in builder-emit-order.test.ts
      // the way #37 did for GeneralSummaryReportQueryRq.
      const data: Record<string, unknown> = {};
      if (args.vehicleListId) {
        data.VehicleRef = { ListID: args.vehicleListId };
      } else {
        data.VehicleRef = { FullName: args.vehicleName };
      }
      data.TripStartDate = args.tripStartDate;
      data.TripEndDate = args.tripEndDate;
      if (hasOdometerStart) data.OdometerStart = args.odometerStart;
      if (hasOdometerEnd) data.OdometerEnd = args.odometerEnd;
      if (args.totalMiles !== undefined) data.TotalMiles = args.totalMiles;
      if (args.customerListId) {
        data.CustomerRef = { ListID: args.customerListId };
      } else if (args.customerName) {
        data.CustomerRef = { FullName: args.customerName };
      }
      if (args.itemListId) {
        data.ItemRef = { ListID: args.itemListId };
      } else if (args.itemName) {
        data.ItemRef = { FullName: args.itemName };
      }
      if (args.className) data.ClassRef = { FullName: args.className };
      if (args.notes) data.Notes = args.notes;
      if (args.billable !== undefined) {
        data.BillableStatus = args.billable ? "Billable" : "NotBillable";
      }

      if (args.dryRun) {
        try {
          const preview = await session.addEntityDryRun("VehicleMileage", data, args.idempotencyKey);
          const { entity, ...rest } = preview;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                dryRun: true,
                ...rest,
                ...(entity ? { vehicleMileage: entity } : {}),
              }, null, 2),
            }],
          };
        } catch (err) {
          return formatToolError(err, { fallbackMessage: "VehicleMileageAddRq dry-run failed" });
        }
      }

      try {
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent("VehicleMileage", data, args.idempotencyKey)
          : { entity: await session.addEntity("VehicleMileage", data), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              vehicleMileage: result,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "VehicleMileageAddRq failed" });
      }
    }
  );
}
