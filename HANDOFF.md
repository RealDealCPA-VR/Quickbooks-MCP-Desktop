# Handoff State

_Last updated: 2026-05-16. **Phase 17 #79 vehicle mileage shipped** — Phase 17 is now CLOSED (every item 75–81 done). 3 new tools in fresh [src/tools/vehicle-mileage.ts](src/tools/vehicle-mileage.ts): `qb_vehicle_list` (read-only Vehicle discovery), `qb_vehicle_mileage_list`, `qb_vehicle_mileage_add`. **NO `_update` tool** (qbXML SDK has no `VehicleMileageModRq` at any version through 16.0) and **NO `_delete` tool in this cut** (mileage logs are auditable; future thin add). Sim store extensions: new `VehicleFilter` handleQuery branch (scopes by `VehicleRef`, distinct from `EntityFilter`), new `TripDateRangeFilter` branch (scopes by `TripStartDate` — VehicleMileage has NO `TxnDate` field), new generic `BillableStatus` filter branch, new `computeTotals` branch deriving `TotalMiles = OdometerEnd − OdometerStart` when undefined (explicit totalMiles wins). 3 vehicles + 4 mileage trips seeded (1 inactive vehicle, 1 NotBillable trip, 1 trip without CustomerRef = IRS office run — covers every filter dimension). Four lists in sync (builder.ts + manager.ts + simulation-store.ts + CLAUDE.md line 58). Parser arrayElements extended with `VehicleRet` + `VehicleMileageRet`. Tool count 141 → 144. 1275 → 1315 tests green (+40 new tests). README sync done: tool count bumped in both spots, new `### Vehicle Mileage` section between Time Tracking and Reference Lists. Build + test + simulation banner clean._

## Last Session Summary

- **#79 vehicle mileage — DONE.** 3 tools shipped:
  - `qb_vehicle_list` — `VehicleQueryRq`. Read-only Vehicle discovery surface paired with `qb_vehicle_mileage_add`. Filters: `nameFilter` (Contains) / `vehicleListId` (ListID fetch) / `includeInactive` (default false → ActiveOnly) / `maxReturned`. Vehicle CRUD lives in QB Desktop's UI — vehicles are infrequent setup work and operators add them there directly.
  - `qb_vehicle_mileage_list` — `VehicleMileageQueryRq`. Filters: `txnId` / `vehicleName` / `vehicleListId` (server-side `VehicleFilter`) / `customerName` / `customerListId` (POST-FILTERED at tool layer — QB's `VehicleMileageQueryRq` has no `CustomerFilter`) / `fromDate` / `toDate` (server-side `TripDateRangeFilter` scoping `TripStartDate` — NOT TxnDate) / `billableStatus` (server-side `BillableStatus` filter — `Billable` | `NotBillable` | `HasBeenBilled`) / `maxReturned` / `paginate` / `iteratorID`. Paginate auto-defaults MaxReturned=500.
  - `qb_vehicle_mileage_add` — `VehicleMileageAddRq`. REQUIRED: `vehicleName | vehicleListId` AND `tripStartDate` + `tripEndDate` AND either `totalMiles` directly OR BOTH `odometerStart` + `odometerEnd`. Optional `customerName | customerListId` / `itemName | itemListId` / `className` / `notes` / `billable` (true → `BillableStatus='Billable'`, false → `'NotBillable'`, unset omits — matches QB default). Standard idempotencyKey + read-only gate.

- **Structural notes — VehicleMileage is non-posting + immutable:**
  - **NON-POSTING.** No GL effect, no AR/AP movement. Pinned by a test: `Customer.Balance` does NOT move when a billable trip against Acme is added.
  - **Immutable from SDK perspective.** The qbXML SDK exposes NO `VehicleMileageModRq` at any version through 16.0 — there is no `_update` tool. If a trip needs to change, operator deletes via QB Desktop's UI and re-adds via `qb_vehicle_mileage_add`. Tool description calls this out loudly.
  - **VehicleMileage has NO `TxnDate` field.** TripStartDate / TripEndDate ARE the canonical timestamps. The new `TripDateRangeFilter` branch in `handleQuery` is distinct from the existing `TxnDateRangeFilter` branch (which scopes `TxnDate`).
  - **VehicleMileage is the only transaction with `VehicleRef`.** New `VehicleFilter` branch in `handleQuery` scopes by it — distinct from `EntityFilter` because VehicleMileage carries BOTH a VehicleRef AND optionally a CustomerRef, and `EntityFilter` on this query type targets neither (`EntityFilter` chain is `EntityRef ?? CustomerRef ?? VendorRef ?? PayeeEntityRef` — no VehicleRef coverage).
  - **`computeTotals` extended** with a VehicleMileage branch deriving `TotalMiles = OdometerEnd − OdometerStart` when TotalMiles is undefined AND both odometers are supplied. Mirrors the Check.Amount / Deposit.DepositTotal / SalesTaxPaymentCheck.TotalAmount / StatementCharge.Amount "derive when undefined" pattern.
  - **New generic `BillableStatus` filter branch** in `handleQuery`. One-line, usable for any entity carrying BillableStatus. Only VehicleMileage uses it today (TimeTracking post-filters at the tool layer because QB's TimeTrackingQueryRq has no BillableStatus filter; if a future workflow needs server-side billable scoping on another entity type, the branch is already in place).

- **Infrastructure changes (in sync across 4 lists per CLAUDE.md canonical-invariant rule):**
  - `buildDeleteRequest`'s isTransaction in [src/qbxml/builder.ts](src/qbxml/builder.ts)
  - `deleteEntity`'s isTransaction in [src/session/manager.ts](src/session/manager.ts)
  - `isTransactionType` in [src/session/simulation-store.ts](src/session/simulation-store.ts)
  - CLAUDE.md doc list at line 58
  - **NOT** in `BANK_AFFECTING_TXN_TYPES` (non-posting, no Bank/CC posting).
  - 2 new parser arrayElements: `VehicleRet` + `VehicleMileageRet`.

- **Half-odometer-pair validation order:** the `qb_vehicle_mileage_add` tool checks `hasOdometerStart && !hasOdometerEnd` (or vice versa) BEFORE the generic "missing distance source" check. This means an operator who supplied just one odometer side gets the precise "must come together" message rather than the generic "Provide either totalMiles, or BOTH odometers" message. This ordering was caught + fixed by a failing test in the first run (the test asserted the specific half-pair message via regex).

- **Sim seed: 3 vehicles + 4 mileage trips:**
  - Vehicles: `V0000001` "2023 Ford F-150" (active), `V0000002` "2022 Toyota Camry" (active), `V0000003` "2020 Honda Civic (retired)" (inactive — IsActive: false; surfaces in `qb_vehicle_list({includeInactive:true})` only).
  - Trips on 2024-11-04 / -05 (Acme, F-150, billable, odometer-bracketed) / 2024-11-06 (Global, Camry, billable, no odometer = totalMiles only) / 2024-11-07 (no CustomerRef = IRS office trip, F-150, NotBillable). Covers every filter dimension: customer/no-customer, billable/non-billable, odometer-bracketed/totalMiles-only, 2 active vehicles + skip the inactive one.
  - Non-posting so seeded mileage doesn't disturb pinned Customer.Balance fixtures (Acme=15000 / Global=8500 / TechStart=3200).

- **40 new tests in [tests/vehicle-mileage.test.ts](tests/vehicle-mileage.test.ts) across 4 layers** — all green. Coverage:
  - sim seed + handleAdd basics (7 — Vehicle ActiveStatus splits, VehicleMileage seed count, TxnID assignment proves transaction routing, TotalMiles derivation from odometer pair, explicit override wins, totalMiles-only persistence, non-posting Customer.Balance unchanged on billable trip)
  - sim handleQuery filters (4 — VehicleFilter by ListID + FullName matches VehicleRef, TripDateRangeFilter scopes TripStartDate, BillableStatus narrows)
  - `qb_vehicle_list` (4 — default ActiveOnly, includeInactive, nameFilter Contains, vehicleListId fetch)
  - `qb_vehicle_mileage_list` (9 — default 4, txnId / vehicleName / vehicleListId / customerName post-filter dropping no-CustomerRef entries / fromDate-toDate / billableStatus filters + paginate auto-default)
  - `qb_vehicle_mileage_add` (13 — happy paths totalMiles+refs+billable / odometer-derives / explicit-wins / vehicleListId form / billable:false / billable-unset-omits-field, validation errors missing-vehicle / missing-distance-source / half-odometer-pair, idempotency replay + 9002 conflict, read-only 9001 with seed untouched)

- **README sync done.** Tool count 141 → 144 in both spots (`## Tools (144 total)` header + architecture diagram `(144 tools)` inset). New `### Vehicle Mileage` section between Time Tracking and Reference Lists explains Schedule C / Form 4562 framing, the non-posting + immutable-from-SDK posture, the read-only Vehicle list decision, the TripStartDate-not-TxnDate filter detail, and the full tool table.

- **[src/index.ts](src/index.ts) got:** import + register call (line 85 + 229) + new Capabilities bullet (line 23 — "Vehicle mileage logs (Schedule C / Form 4562 — billable + non-billable trips)") + new `qb_vehicle_*` instructions block entry above `qb_time_track_*` + extension of the idempotency-keyed-tools enumeration with `qb_vehicle_mileage_add`.

- **Tool count enumeration:** re-counted via `(Get-ChildItem "src\tools\*.ts" -File | Select-String -Pattern "server\.tool\(" | Measure-Object).Count` → **144 distinct `server.tool` calls across 31 files**. Matches the README header.

## Verify Before Continuing

Re-run if the tree has been touched (skip if next session starts within hours):

- [ ] `npm run build` → exit 0 (tsc clean).
- [ ] `npm test` → `Test Files 52 passed | Tests 1315 passed`.
- [ ] `"" | & node dist/index.js` → exit 0, `Mode: simulation` printed.
- [ ] **(Windows + QB) #79 first live exercise.** Connect to `VR Tax & Consulting Inc..qbw` (or any company file with at least one active Vehicle — add one in QB Desktop under Lists → Customer & Vendor Profile Lists → Vehicle List if none exists). Walk the mileage cycle:
  1. `qb_vehicle_list({})` — confirm at least one active vehicle returns. Capture its `FullName` and `ListID`.
  2. `qb_vehicle_mileage_add({ vehicleName: "<vehicle>", tripStartDate: "<today>", tripEndDate: "<today>", odometerStart: <current odometer>, odometerEnd: <current + 25>, notes: "Live test trip" })` — confirm `success: true`, `vehicleMileage.TotalMiles === 25` (derived from odometer pair), and a TxnID returned.
  3. `qb_vehicle_mileage_list({ vehicleName: "<vehicle>" })` — confirm the new trip surfaces.
  4. `qb_vehicle_mileage_add({ vehicleListId: "<listid>", tripStartDate: "<today>", tripEndDate: "<today>", totalMiles: 12, billable: true, customerName: "<any active customer>" })` — confirm explicit totalMiles persists, BillableStatus='Billable', CustomerRef attached.
  5. `qb_vehicle_mileage_list({ billableStatus: "Billable" })` — confirm only billable trips surface (the trip from step 4 should be there; trip from step 2 should not).
  - **If a schema-order class of bug surfaces (statusCode -1 from QBXMLRP2)** on `VehicleMileageAddRq` / `VehicleMileageQueryRq` / `VehicleQueryRq`, capture envelope via `QB_DEBUG_QBXML=1` and pin canonical child order in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts) the way #37 did for `GeneralSummaryReportQueryRq`. The JS key insertion order in the tool layer (per qbxmlops130 schema) is `VehicleRef → TripStartDate → TripEndDate → OdometerStart → OdometerEnd → TotalMiles → CustomerRef → ItemRef → ClassRef → Notes → BillableStatus`.
- [ ] **(Windows + QB) Carried — #81 statement charges first live exercise** against `VR Tax & Consulting Inc..qbw`. (See prior handoff section for exact steps.)
- [ ] **(Windows + QB) Carried — #80 inventory adjustments first live exercise.**
- [ ] **(Windows + QB) Carried — #77 sales tax first live exercise.**
- [ ] **(Windows + QB) Carried — #76 sales orders first live exercise.**
- [ ] **(Windows + QB) Carried — #70 `qb_engagement_profitability` first live exercise.**
- [ ] **(Windows + QB) Carried — #78 time tracking first live exercise.** TimeTrackingAddRq canonical child order: `TxnDate → EntityRef → CustomerRef → ItemServiceRef → Duration → ClassRef → PayrollItemWageRef → Notes → IsBillable → BillableStatus`.
- [ ] **(Windows + QB) Carried — #71 `qb_client_packet` first live exercise.**
- [ ] **(Windows + QB) Carried — #75 banking primitives first live exercise.**
- [ ] **(Windows + QB) Carried — #69 `qb_tax_line_mapping` + #68 `qb_trial_balance_export` first live exercises.**
- [ ] **(Windows + QB) Carried — Phase 18 #85 / #86 first live exercises** of `qb_closing_date_get` / `qb_closing_date_set` (9005 + UI navigation) / all five MCP prompts in Claude Desktop's `/` picker.
- [ ] **(Windows + QB) Carried — `qb_session_status` first live exercise** (zero wire I/O default + fail-soft probe/closingDate).
- [ ] **(Windows + QB) Carried — #84 transient-retry path, #82 host_query field surface, #55 W-2 wire shape, #59 attachment enablement, #54 SCF section labels.** Lowest priority.

## Next Task

**Operator picks next.** With #79 closed, **Phase 17 is COMPLETE** (every item 75–81 done). Remaining work clusters:

- **Phase 13–14 coverage gaps** — DataExt (#61), sub-customer (#62), memo search (#63), dry-run (#64), better errors (#65), audit log (#66 — Enterprise-only).
- **#72 generic `qb_transaction_list`** (Phase 16) — composite fanout across the 6 customer-side txn types ("show me everything for customer X in March" → 1 call instead of 6).
- **Follow-up — VehicleMileage delete:** if mistake-correction workflows surface, add `qb_vehicle_mileage_delete` as a thin tool over the existing `deleteEntity("VehicleMileage", txnId)` path — the four-list sync infrastructure is already in place, so it's a one-tool add with parallel test coverage (delete happy path / unknown TxnID 500 / read-only 9001 / non-posting invariant — no balance to reverse).
- **Follow-up — StatementCharge in ReceivePayment.AppliedToTxn:** extend `validateTxnApplications` + `applyTxnApplications` in [src/session/simulation-store.ts](src/session/simulation-store.ts) to walk both Invoice AND StatementCharge stores when resolving an AppliedToTxn TxnID. Currently a `qb_payment_receive` with `appliedTo: [{txnId: "<statementChargeTxnId>"}]` rejects with "Invoice not found". Low-priority — operators can pay via an unapplied receive-payment in the meantime.

## Context Notes

- **Authoritative tool count is 144** (re-enumerated via `(Get-ChildItem "src\tools\*.ts" -File | Select-String -Pattern "server\.tool\(" | Measure-Object).Count` → 144 distinct calls across 31 files). README + architecture diagram both reflect 144. Don't blindly increment from a HANDOFF figure — re-grep before bumping.

- **#79 VehicleMileage has NO `TxnDate` field.** TripStartDate / TripEndDate are the canonical timestamps. The new `TripDateRangeFilter` branch in `handleQuery` is parallel to `TxnDateRangeFilter` (which scopes `TxnDate`). If you add another date-range-scoped tool against VehicleMileage in the future, use TripDateRangeFilter — the TxnDateRangeFilter branch is a no-op against this entity.

- **#79 VehicleMileage is non-posting** — same posture as TimeTracking. No GL effect, no AR/AP movement, not in `BANK_AFFECTING_TXN_TYPES`. Trips with a `CustomerRef` are tagged for billing (Time/Costs dialog) but don't move that customer's `Balance`. A test pins this against Acme.

- **#79 NO `_update` tool — qbXML SDK has no `VehicleMileageModRq`.** Grepped against qbxmlops20.xml → qbxmlops140.xml — zero hits. Trips are immutable from the SDK's perspective. If an operator asks "how do I correct a trip?" — the answer is delete it in QB Desktop's UI and re-add via `qb_vehicle_mileage_add`. Tool description calls this out loudly.

- **#79 NO `_delete` tool in this cut** — mileage logs are auditable records (Schedule C / Form 4562) and operators rarely delete them. The four-list sync infrastructure IS in place (`VehicleMileage` is in builder.ts / manager.ts / simulation-store.ts isTransaction lists + CLAUDE.md line 58) so a future `qb_vehicle_mileage_delete` is a thin add — one new tool, ~3 tests (happy path / unknown TxnID 500 / read-only 9001), no sim handler changes (handleTxnDel's generic path handles non-posting delete fine; no balance to reverse).

- **#79 half-odometer-pair validation order matters.** The "must come together" check fires BEFORE the generic "totalMiles or pair" check in `qb_vehicle_mileage_add`. An operator who supplied just `odometerStart` (no `odometerEnd`) gets the precise message rather than the generic. A test asserts this via regex; if you reorder these checks the test will catch the regression.

- **#79 `billable` boolean shape:** `true` → `BillableStatus='Billable'`; `false` → `'NotBillable'`; unset omits the field entirely (matches QB default). DIFFERENT FROM TimeTracking which also emits `IsBillable: boolean` alongside `BillableStatus` (the legacy primary boolean + the round-trip enum). VehicleMileage only carries `BillableStatus` — no IsBillable field per the schema.

- **#79 four-list sync caught for the FIFTH consecutive transaction type** (`InventoryAdjustment` #80 → `SalesTaxPaymentCheck` #77 → `TimeTracking` #78 → `StatementCharge` #81 → now `VehicleMileage` #79). The rule is unchanged: any new transaction type updates four locations — `isTransaction` in [src/qbxml/builder.ts](src/qbxml/builder.ts), `isTransaction` in [src/session/manager.ts](src/session/manager.ts), `isTransactionType` in [src/session/simulation-store.ts](src/session/simulation-store.ts), AND the CLAUDE.md doc list at line 58. Tests catch divergence (TxnDel routing breaks if any list is out of sync) — but the CLAUDE.md doc list has no test coverage; it drifts silently.

- **Carried gotchas (unchanged from prior handoffs — all still apply):**
  - **#81 StatementCharge is the only single-row-at-header transaction type** — no `*LineAdd` array; ItemRef/Quantity/Rate/Amount live at the txn HEADER. `convertLinesAddToRet` is a no-op for it.
  - **#81 `adjustPartyBalanceForTxn` + `adjustPartyBalanceForTxnMod` amountField union now includes `"Amount"`.**
  - **#81 customer re-target on update reverses-then-applies the full Amount.** Mirrors Invoice's policy.
  - **#81 ReceivePayment limitation.** `validateTxnApplications` hardcodes the Invoice store — payments referencing a StatementCharge TxnID will reject.
  - **#80 InventoryAdjustment is the first transaction type that mutates ItemInventory state.** Two-phase commit invariant — `applyInventoryAdjustment` validates every line BEFORE mutating any items.
  - **#80 NO `_update` tool** — operational pattern is delete + recreate.
  - **#80 AverageCost preserved at zero qty** — pinned test.
  - **#77 SalesReceipt seed is dated 2025-01-15** deliberately — falls outside windowed tests.
  - **#77 liability report is HEADER-level only** — per-line tax flagging is not modeled in sim.
  - **#77 SalesTaxPaymentCheck vs Check distinction** — payment check reduces sales-tax-item liability; regular check posted to a tax-liability account would double-count.
  - **#76 SalesOrder is non-posting** — Customer.Balance does NOT move on SO add or delete.
  - **#76 convert idempotency skip-on-replay** — same pattern as estimate convert.
  - **#70 `IncludeLineItems: true` is LOAD-BEARING** for any tool that walks line-level data on Bill/Check/CreditCardCharge/SalesOrder.
  - **#70 customer scope on time is POST-FILTERED.**
  - **#70 customer scope on Bill/Check/CCC is LINE-LEVEL.**
  - **#70 `customerRefMatches` accepts EITHER ListID OR FullName match.**
  - **#78 EntityFilter priority reorder** — `handleQuery` does `EntityRef ?? CustomerRef ?? VendorRef ?? PayeeEntityRef`. #79 adds a parallel `VehicleFilter` branch that scopes `VehicleRef` (NOT in the EntityFilter chain — VehicleMileage carries both VehicleRef and CustomerRef and EntityFilter on this query type targets neither).
  - **#78 Duration is ISO 8601 PT-H-M-S only.**
  - **#78 IsBillable + BillableStatus co-emission.** #79 emits BillableStatus only (no IsBillable — VehicleMileage schema doesn't carry that field).
  - **#71 fail-soft contract** — `sections.<name>` is either the success payload OR an `{ error: {...} }` block.
  - **#71 payroll has THREE skip states** — Pro → 9003, wire-zero → 9004, probe-fail → error.
  - **#71 GL defaults to PnLOnly scope** for cost reasons.
  - **#71 customerListId / customerName is OPTIONAL CONTEXT, NOT A FILTER.** #70 INVERTS this.
  - **#71 AccountQueryRq failure is the only non-fail-soft path** for #71; #70's parallel is CustomerQueryRq failure.
  - **#75 EntityFilter strict improvement** — `handleQuery` matches `PayeeEntityRef` for Check / BillPaymentCheck / BillPaymentCreditCard / CreditCardCharge / CreditCardCredit.
  - **#75 / #77 / #81 / #79 `computeTotals` "set when undefined, preserve override" pattern** — Check.Amount / Deposit.DepositTotal / SalesTaxPaymentCheck.TotalAmount / StatementCharge.Amount / VehicleMileage.TotalMiles. #76 (SalesOrder.TotalAmount) inverts: always derives. #80 (InventoryAdjustment.TotalAmount) ALWAYS overrides.
  - **#75 Sim does NOT move `Bank.Account.Balance`** on Deposit/Transfer/Check.
  - **#67 default path is zero wire I/O.** Probe is opt-in.
  - **#68 RECON_TOLERANCE = 0.01.**
  - **#69 "Mapped" definition** — TaxLineName non-empty.
  - **#85 SDK gap is permanent** — `qb_closing_date_set` always 9005 + UI navigation.
  - **Synthetic statusCodes**: 9001 read-only, 9002 idempotency conflict, 9003 edition unsupported, 9004 payroll subscription required, 9005 SDK has no write path.
  - **#86 prompts registration** uses `reg<Args>(entry)` helper + `as const` tuple.
  - **AR-side `Customer.Balance` discount math is correct; AP-side is NOT** — future `qb_bill_write_off` needs the parallel fix.
  - **Dispatch order in `processRequest`**: non-entity-typed `*QueryRq` / `*ModRq` / `AttachableAddRq` MUST precede the `endsWith` catch-alls.
  - **Iterator wire names diverge**: `iterator`/`iteratorID` on request, `iteratorRemainingCount`/`iteratorID` on response.
  - **fast-xml-parser does NOT decode numeric character entities** — use `decodeXmlEntities`.
  - **fast-xml-parser DOES coerce numeric-looking text to numbers** — `<CheckNumber>1001</CheckNumber>` → `1001` (number), not `"1001"`.
  - **Live verification requires `C:\nvm4w\nodejs\node.exe` v20.20.2** (system PATH v22 breaks winax).
  - **QBXMLRP2 cannot OPEN a `.qbw`**, only attach to one QB Desktop has already loaded.
  - **BillPayment* total is on `TotalAmount`**, not `Amount` — coalesce `TotalAmount ?? Amount`.
