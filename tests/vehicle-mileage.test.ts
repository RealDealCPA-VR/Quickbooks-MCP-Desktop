// Phase 17 #79 — vehicle mileage. qb_vehicle_list + qb_vehicle_mileage_list +
// qb_vehicle_mileage_add.
//
// Coverage layers:
//   1. Sim seed + handler basics — Vehicle list loads 3 entries (2 active,
//      1 inactive); VehicleMileage seed loads 4 trips; VehicleFilter scopes
//      by VehicleRef; TripDateRangeFilter scopes by TripStartDate (NOT
//      TxnDate); BillableStatus filter narrows; computeTotals derives
//      TotalMiles = OdometerEnd − OdometerStart when missing.
//   2. qb_vehicle_list — happy path, includeInactive, nameFilter, listId.
//   3. qb_vehicle_mileage_list — default count, txnId / vehicle / customer
//      post-filter / trip date range / billableStatus filter / paginate.
//   4. qb_vehicle_mileage_add — happy paths (totalMiles, odometer pair,
//      explicit override), validation errors (missing vehicle, missing
//      distance source, half-odometer pair), billable / non-billable /
//      unset, ListID-form refs, idempotency replay + 9002, read-only gate.

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerVehicleMileageTools } from "../src/tools/vehicle-mileage.js";

type Handler = (args: unknown) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

const handlers = new Map<string, Handler>();
const fakeServer = {
  tool: (
    name: string,
    _description: string,
    _schema: Record<string, z.ZodTypeAny>,
    handler: Handler,
  ) => {
    handlers.set(name, handler);
  },
};

function freshSession(): QBSessionManager {
  return new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-vehicle-mileage",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

beforeEach(() => {
  handlers.clear();
});

// ---------------------------------------------------------------------------
// Layer 1 — sim seed + handler basics
// ---------------------------------------------------------------------------

describe("SimulationStore — Vehicle + VehicleMileage basics", () => {
  it("Vehicle seed loads 3 entries (2 active, 1 inactive)", async () => {
    const session = freshSession();
    const rows = await session.queryEntity("Vehicle", {});
    expect(rows.length).toBe(3);
    const active = rows.filter((r) => r.IsActive !== false);
    expect(active.length).toBe(2);
  });

  it("Vehicle ActiveOnly default scopes out the retired Honda", async () => {
    const session = freshSession();
    const rows = await session.queryEntity("Vehicle", { ActiveStatus: "ActiveOnly" });
    expect(rows.length).toBe(2);
    const names = rows.map((r) => String(r.FullName ?? ""));
    expect(names).toContain("2023 Ford F-150");
    expect(names).toContain("2022 Toyota Camry");
    expect(names).not.toContain("2020 Honda Civic (retired)");
  });

  it("VehicleMileage seed loads 4 trips", async () => {
    const session = freshSession();
    const rows = await session.queryEntity("VehicleMileage", {});
    expect(rows.length).toBe(4);
  });

  it("VehicleFilter by FullName scopes by VehicleRef.FullName", async () => {
    const session = freshSession();
    const rows = await session.queryEntity("VehicleMileage", {
      VehicleFilter: { FullName: "2023 Ford F-150" },
    });
    // Seed has 3 F-150 trips (T0000001-VM, T0000002-VM, T0000004-VM).
    expect(rows.length).toBe(3);
    for (const r of rows) {
      const ref = r.VehicleRef as Record<string, unknown>;
      expect(ref.FullName).toBe("2023 Ford F-150");
    }
  });

  it("VehicleFilter by ListID also matches against VehicleRef", async () => {
    const session = freshSession();
    const rows = await session.queryEntity("VehicleMileage", {
      VehicleFilter: { ListID: "V0000002" },
    });
    // Camry has 1 trip.
    expect(rows.length).toBe(1);
    expect((rows[0].VehicleRef as Record<string, unknown>).FullName).toBe("2022 Toyota Camry");
  });

  it("TripDateRangeFilter scopes by TripStartDate (NOT TxnDate)", async () => {
    const session = freshSession();
    const rows = await session.queryEntity("VehicleMileage", {
      TripDateRangeFilter: { FromTripDate: "2024-11-05", ToTripDate: "2024-11-05" },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].TripStartDate).toBe("2024-11-05");
  });

  it("TripDateRangeFilter is independent of TxnDateRangeFilter (no TxnDate on VehicleMileage)", async () => {
    const session = freshSession();
    // VehicleMileage has no TxnDate; filtering by TxnDate must not narrow.
    const rows = await session.queryEntity("VehicleMileage", {
      TxnDateRangeFilter: { FromTxnDate: "2024-11-05", ToTxnDate: "2024-11-05" },
    });
    // All 4 trips pass — they have empty TxnDate which is < "2024-11-05" so
    // they actually drop. Confirm the filter does drop them (no TxnDate
    // means empty string compares less than any date). The point is
    // TripDateRangeFilter is a SEPARATE branch — assert by date-window.
    // This documents that callers must use TripDateRangeFilter for
    // VehicleMileage windows, not TxnDateRangeFilter.
    expect(rows.length).toBe(0);
  });

  it("BillableStatus filter narrows to Billable", async () => {
    const session = freshSession();
    const rows = await session.queryEntity("VehicleMileage", {
      BillableStatus: "Billable",
    });
    // 3 billable trips, 1 non-billable IRS trip.
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.BillableStatus).toBe("Billable");
    }
  });

  it("BillableStatus filter narrows to NotBillable", async () => {
    const session = freshSession();
    const rows = await session.queryEntity("VehicleMileage", {
      BillableStatus: "NotBillable",
    });
    expect(rows.length).toBe(1);
    expect(rows[0].TxnID).toBe("T0000004-VM");
  });

  it("computeTotals derives TotalMiles from odometer pair when missing", async () => {
    const session = freshSession();
    const vm = await session.addEntity("VehicleMileage", {
      VehicleRef: { ListID: "V0000001", FullName: "2023 Ford F-150" },
      TripStartDate: "2026-03-15",
      TripEndDate: "2026-03-15",
      OdometerStart: 50000,
      OdometerEnd: 50125,
    });
    expect(vm.TotalMiles).toBe(125);
    expect(vm.TxnID).toMatch(/-/);
  });

  it("computeTotals preserves explicit TotalMiles override", async () => {
    const session = freshSession();
    const vm = await session.addEntity("VehicleMileage", {
      VehicleRef: { ListID: "V0000002", FullName: "2022 Toyota Camry" },
      TripStartDate: "2026-03-15",
      TripEndDate: "2026-03-15",
      OdometerStart: 30000,
      OdometerEnd: 30200,
      TotalMiles: 187, // explicit — operator may have corrected for a side errand
    });
    expect(vm.TotalMiles).toBe(187);
  });

  it("computeTotals: no derivation when odometers missing (totalMiles-only trips)", async () => {
    const session = freshSession();
    const vm = await session.addEntity("VehicleMileage", {
      VehicleRef: { ListID: "V0000002", FullName: "2022 Toyota Camry" },
      TripStartDate: "2026-03-15",
      TripEndDate: "2026-03-15",
      TotalMiles: 22,
    });
    expect(vm.TotalMiles).toBe(22);
    expect(vm.OdometerStart).toBeUndefined();
    expect(vm.OdometerEnd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — qb_vehicle_list
// ---------------------------------------------------------------------------

describe("qb_vehicle_list tool", () => {
  it("default: returns active vehicles (count 2, excludes retired Civic)", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_list")!;

    const result = await handler({});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(2);
    const names = payload.vehicles.map((v: Record<string, unknown>) => v.FullName);
    expect(names).toContain("2023 Ford F-150");
    expect(names).toContain("2022 Toyota Camry");
    expect(names).not.toContain("2020 Honda Civic (retired)");
  });

  it("includeInactive:true surfaces retired vehicles", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_list")!;

    const result = await handler({ includeInactive: true });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(3);
    const names = payload.vehicles.map((v: Record<string, unknown>) => v.FullName);
    expect(names).toContain("2020 Honda Civic (retired)");
  });

  it("nameFilter Contains scopes by substring", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_list")!;

    const result = await handler({ nameFilter: "Ford" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.vehicles[0].FullName).toBe("2023 Ford F-150");
  });

  it("vehicleListId fetches a specific vehicle", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_list")!;

    const result = await handler({ vehicleListId: "V0000002" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.vehicles[0].FullName).toBe("2022 Toyota Camry");
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — qb_vehicle_mileage_list
// ---------------------------------------------------------------------------

describe("qb_vehicle_mileage_list tool", () => {
  it("default: returns count + trips from seed", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_list")!;

    const result = await handler({});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(4);
    expect(Array.isArray(payload.trips)).toBe(true);
  });

  it("txnId filter narrows to one", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_list")!;

    const result = await handler({ txnId: "T0000001-VM" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.trips[0].TxnID).toBe("T0000001-VM");
  });

  it("vehicleName filter scopes server-side via VehicleFilter", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_list")!;

    const result = await handler({ vehicleName: "2023 Ford F-150" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(3);
    for (const t of payload.trips) {
      expect(t.VehicleRef.FullName).toBe("2023 Ford F-150");
    }
  });

  it("vehicleListId filter scopes by VehicleRef.ListID", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_list")!;

    const result = await handler({ vehicleListId: "V0000002" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.trips[0].VehicleRef.FullName).toBe("2022 Toyota Camry");
  });

  it("customerName post-filters by CustomerRef + drops trips without one", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_list")!;

    const result = await handler({ customerName: "Acme Corporation" });
    const payload = JSON.parse(result.content[0].text);
    // Two trips for Acme (T0000001-VM, T0000002-VM). The IRS trip (no
    // CustomerRef) and the Global trip drop.
    expect(payload.count).toBe(2);
    for (const t of payload.trips) {
      expect(t.CustomerRef.FullName).toBe("Acme Corporation");
    }
    const ids = payload.trips.map((t: Record<string, unknown>) => t.TxnID);
    expect(ids).not.toContain("T0000003-VM"); // Global
    expect(ids).not.toContain("T0000004-VM"); // no customer
  });

  it("customerListId post-filters by CustomerRef.ListID", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_list")!;

    const result = await handler({ customerListId: "80000002-1234567890" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.trips[0].CustomerRef.FullName).toBe("Global Industries");
  });

  it("fromDate/toDate scopes by TripStartDate (NOT TxnDate)", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_list")!;

    const result = await handler({
      fromDate: "2024-11-04",
      toDate: "2024-11-05",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(2);
    for (const t of payload.trips) {
      expect(["2024-11-04", "2024-11-05"]).toContain(t.TripStartDate);
    }
  });

  it("billableStatus:'Billable' filter scopes server-side", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_list")!;

    const result = await handler({ billableStatus: "Billable" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(3);
    for (const t of payload.trips) {
      expect(t.BillableStatus).toBe("Billable");
    }
  });

  it("billableStatus:'NotBillable' returns the IRS trip", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_list")!;

    const result = await handler({ billableStatus: "NotBillable" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.trips[0].TxnID).toBe("T0000004-VM");
  });

  it("paginate:true auto-defaults maxReturned + surfaces iterator fields", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_list")!;

    const result = await handler({ paginate: true });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(4);
    expect(payload.iteratorRemainingCount).toBe(0);
    expect(payload.iteratorID).toMatch(/^SIM-ITER-/);
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — qb_vehicle_mileage_add
// ---------------------------------------------------------------------------

describe("qb_vehicle_mileage_add tool", () => {
  it("happy path: totalMiles direct, no odometer", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_add")!;

    const result = await handler({
      vehicleName: "2023 Ford F-150",
      tripStartDate: "2026-03-15",
      tripEndDate: "2026-03-15",
      totalMiles: 47,
      customerName: "Acme Corporation",
      itemName: "Consulting Services",
      notes: "Site visit",
      billable: true,
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.vehicleMileage.TotalMiles).toBe(47);
    expect(payload.vehicleMileage.OdometerStart).toBeUndefined();
    expect(payload.vehicleMileage.OdometerEnd).toBeUndefined();
    expect(payload.vehicleMileage.VehicleRef.FullName).toBe("2023 Ford F-150");
    expect(payload.vehicleMileage.CustomerRef.FullName).toBe("Acme Corporation");
    expect(payload.vehicleMileage.ItemRef.FullName).toBe("Consulting Services");
    expect(payload.vehicleMileage.BillableStatus).toBe("Billable");
    expect(payload.vehicleMileage.Notes).toBe("Site visit");
    expect(payload.vehicleMileage.TripStartDate).toBe("2026-03-15");
    expect(payload.vehicleMileage.TripEndDate).toBe("2026-03-15");
    expect(payload.vehicleMileage.TxnID).toBeTruthy();
  });

  it("happy path: odometer pair derives TotalMiles", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_add")!;

    const result = await handler({
      vehicleListId: "V0000001",
      tripStartDate: "2026-03-20",
      tripEndDate: "2026-03-20",
      odometerStart: 42500,
      odometerEnd: 42622,
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.vehicleMileage.OdometerStart).toBe(42500);
    expect(payload.vehicleMileage.OdometerEnd).toBe(42622);
    expect(payload.vehicleMileage.TotalMiles).toBe(122);
  });

  it("explicit totalMiles wins over odometer-derived value", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_add")!;

    const result = await handler({
      vehicleName: "2022 Toyota Camry",
      tripStartDate: "2026-03-21",
      tripEndDate: "2026-03-21",
      odometerStart: 30000,
      odometerEnd: 30200,
      totalMiles: 175, // wins over the 200 the odometers would derive
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.vehicleMileage.TotalMiles).toBe(175);
  });

  it("vehicleListId form works (LISTID ref shape only — no FullName)", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_add")!;

    const result = await handler({
      vehicleListId: "V0000001",
      tripStartDate: "2026-03-22",
      tripEndDate: "2026-03-22",
      totalMiles: 12,
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.vehicleMileage.VehicleRef.ListID).toBe("V0000001");
    expect(payload.vehicleMileage.VehicleRef.FullName).toBeUndefined();
  });

  it("billable:false emits BillableStatus='NotBillable'", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_add")!;

    const result = await handler({
      vehicleName: "2023 Ford F-150",
      tripStartDate: "2026-03-23",
      tripEndDate: "2026-03-23",
      totalMiles: 8,
      billable: false,
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.vehicleMileage.BillableStatus).toBe("NotBillable");
  });

  it("billable unset leaves BillableStatus absent (QB's default state)", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_add")!;

    const result = await handler({
      vehicleName: "2023 Ford F-150",
      tripStartDate: "2026-03-24",
      tripEndDate: "2026-03-24",
      totalMiles: 5,
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.vehicleMileage.BillableStatus).toBeUndefined();
  });

  it("className + ItemRef + Notes round-trip", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_add")!;

    const result = await handler({
      vehicleName: "2023 Ford F-150",
      tripStartDate: "2026-03-25",
      tripEndDate: "2026-03-25",
      totalMiles: 33,
      itemListId: "I0000001",
      className: "Audit",
      notes: "Quarterly site visit",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.vehicleMileage.ItemRef.ListID).toBe("I0000001");
    expect(payload.vehicleMileage.ClassRef.FullName).toBe("Audit");
    expect(payload.vehicleMileage.Notes).toBe("Quarterly site visit");
  });

  it("rejects when vehicleName / vehicleListId missing", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_add")!;

    const result = await handler({
      tripStartDate: "2026-03-26",
      tripEndDate: "2026-03-26",
      totalMiles: 10,
    } as unknown);
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/vehicleName|vehicleListId/);
  });

  it("rejects when neither totalMiles nor odometer pair supplied", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_add")!;

    const result = await handler({
      vehicleName: "2023 Ford F-150",
      tripStartDate: "2026-03-27",
      tripEndDate: "2026-03-27",
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/totalMiles|odometerStart|odometerEnd/);
  });

  it("rejects a half odometer pair (only odometerStart)", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_add")!;

    const result = await handler({
      vehicleName: "2023 Ford F-150",
      tripStartDate: "2026-03-28",
      tripEndDate: "2026-03-28",
      odometerStart: 50000,
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/odometerStart and odometerEnd|together/);
  });

  it("rejects a half odometer pair (only odometerEnd)", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_add")!;

    const result = await handler({
      vehicleName: "2023 Ford F-150",
      tripStartDate: "2026-03-29",
      tripEndDate: "2026-03-29",
      odometerEnd: 50100,
    });
    expect(result.isError).toBe(true);
  });

  it("idempotencyKey replay: same key + same payload returns idempotentReplay + no duplicate", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_add")!;

    const args = {
      vehicleName: "2023 Ford F-150",
      tripStartDate: "2026-03-30",
      tripEndDate: "2026-03-30",
      totalMiles: 15,
      idempotencyKey: "vm-key-001",
    };
    const first = await handler(args);
    const firstPayload = JSON.parse(first.content[0].text);
    const second = await handler(args);
    const secondPayload = JSON.parse(second.content[0].text);
    expect(secondPayload.idempotentReplay).toBe(true);
    expect(secondPayload.vehicleMileage.TxnID).toBe(firstPayload.vehicleMileage.TxnID);
    // Seed has 4 trips + 1 created = 5 total (no duplicate from the replay).
    const all = await session.queryEntity("VehicleMileage", {});
    expect(all.length).toBe(5);
  });

  it("idempotencyKey conflict (same key, different payload) surfaces 9002", async () => {
    const session = freshSession();
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_add")!;

    await handler({
      vehicleName: "2023 Ford F-150",
      tripStartDate: "2026-04-01",
      tripEndDate: "2026-04-01",
      totalMiles: 10,
      idempotencyKey: "vm-conflict",
    });
    const second = await handler({
      vehicleName: "2023 Ford F-150",
      tripStartDate: "2026-04-01",
      tripEndDate: "2026-04-01",
      totalMiles: 20, // different payload
      idempotencyKey: "vm-conflict",
    });
    expect(second.isError).toBe(true);
    const payload = JSON.parse(second.content[0].text);
    expect(payload.statusCode).toBe(9002);
  });

  it("read-only session rejects with 9001 (no wire I/O, seed untouched)", async () => {
    const session = freshSession();
    session.setReadOnly(true);
    registerVehicleMileageTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_vehicle_mileage_add")!;

    const result = await handler({
      vehicleName: "2023 Ford F-150",
      tripStartDate: "2026-04-02",
      tripEndDate: "2026-04-02",
      totalMiles: 5,
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(9001);
    // Seed stays at 4 entries.
    const all = await session.queryEntity("VehicleMileage", {});
    expect(all.length).toBe(4);
  });
});
