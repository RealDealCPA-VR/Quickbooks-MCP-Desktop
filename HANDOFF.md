# Handoff State

_Last updated: 2026-05-17. **Phase 13 #61 shipped — DataExt custom-field support (read-only V1).** New `qb_custom_field_list` discovery tool + `includeCustomFields: boolean` opt-in on seven entity list tools. Tool count **145 → 146**. Tests **1336 → 1367** (+31 new)._

## Last Session Summary

- **#61 DataExt custom fields — DONE.** Read-only V1 scope per the spec: read CF VALUES via `includeCustomFields: true` on entity list tools (which translates to the underlying `OwnerID` wire filter), discover CF DEFINITIONS via the new `qb_custom_field_list`. Write surface (DataExtAdd / DataExtMod / DataExtDel for setting CF values on existing entities) deliberately deferred — operators set CF values in QB Desktop's UI directly, and the read-only surface meets the operator's "Currently invisible" pain.

- **Architecture mirrors Phase 10 #41 IncludeLineItems.** Same strip-by-default pattern: real QB hides `DataExtRet` from query responses unless the request carries `<OwnerID>`. New `stripDataExtKeys` / `filterDataExtByOwner` helpers parallel the existing `stripLineRetKeys` in [src/session/simulation-store.ts](src/session/simulation-store.ts). Mod tools that re-read an entity (e.g. duplicate, write-off) are unaffected — they only matter for *QueryRq paths where the strip applies.

- **Architectural call — no DataExtDef ADD/MOD/DEL exposed.** Defining new custom fields is infrequent setup work that operators do in QB Desktop's UI directly (Lists → Customer & Vendor Profile Lists → Custom Fields, or Add/Edit Multiple List Entries → Custom Fields columns). The QBXML SDK exposes `DataExtDefAddRq` / `DataExtDefModRq` / `DataExtDefDelRq` but verifying their wire shape against a live QB instance is deferred. For V1 the discovery tool is read-only and the value-setting tools are deferred to a future session if a real workflow surfaces.

- **Architectural call — strict opt-in default.** The default response shape for every list tool is unchanged (no `DataExtRet` on rows) so existing callers don't break. Agents have to flip `includeCustomFields: true` explicitly — keeps payloads lean and matches real QB's wire default. Same UX as `includeLineItems`.

- **List tools extended** with `includeCustomFields: boolean` + `customFieldOwnerId: string` args (7 tools):
  - [src/tools/customers.ts](src/tools/customers.ts) — `qb_customer_list`
  - [src/tools/vendors.ts](src/tools/vendors.ts) — `qb_vendor_list`
  - [src/tools/invoices.ts](src/tools/invoices.ts) — `qb_invoice_list`
  - [src/tools/bills.ts](src/tools/bills.ts) — `qb_bill_list`
  - [src/tools/items.ts](src/tools/items.ts) — `qb_item_list`
  - [src/tools/accounts.ts](src/tools/accounts.ts) — `qb_account_list`
  - [src/tools/employees.ts](src/tools/employees.ts) — `qb_employee_list`
  - Each translates the boolean flag into `filters.OwnerID = customFieldOwnerId ?? "0"` at the END of the *QueryRq filter sequence (schema-order tail position pinned in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts)).

- **New tool** [src/tools/custom-fields.ts](src/tools/custom-fields.ts) — `qb_custom_field_list` wraps `DataExtDefQueryRq`. Args:
  - `assignToObject?` — filter to defs applicable to one of 27 entity types (full QBXML SDK enum: Account / Customer / Vendor / Employee / Item / OtherName / Invoice / Bill / Estimate / SalesReceipt / CreditMemo / PurchaseOrder / SalesOrder / Check / Deposit / Transfer / JournalEntry / CreditCardCharge / CreditCardCredit / ReceivePayment / TimeTracking / InventoryAdjustment / ItemReceipt / BuildAssembly / Charge / SalesTaxPaymentCheck / VendorCredit).
  - `ownerId?` — scope to a single namespace; `"0"` is the standard company-defined namespace, UUIDs are third-party app namespaces.
  - Returns `{ count, customFields: [...DataExtDefRet shapes with AssignToObject set...] }`.

- **Parser changes** ([src/qbxml/parser.ts](src/qbxml/parser.ts)): `DataExtRet` + `DataExtDefRet` + `AssignToObject` registered in arrayElements. Critical so callers can iterate `entity.DataExtRet[]` uniformly even on a single-CF entity (fast-xml-parser collapses single-element arrays without this).

- **Sim seed** ([src/session/simulation-store.ts](src/session/simulation-store.ts)):
  - 4 representative CPA-firm CF definitions in the new `DataExtDef` store: `Engagement Type` + `Partner Assigned` (AssignToObject: Customer); `1099 Box` (Vendor); `Project Code` (Invoice / Estimate / SalesReceipt).
  - CF values on Acme Corporation (ListID `80000001-1234567890`): `Engagement Type = 1120-S`, `Partner Assigned = V. Vasquez`.
  - CF values on Joe Contractor (ListID `90000003-1234567890`): `1099 Box = NEC-1`.
  - CF values on the first seed invoice (TxnID `T0000001-INV`): `Project Code = PRJ-2024-Q4`.

- **Sim handler dispatch:** `DataExtDefQueryRq` gets a dedicated `handleDataExtDefQuery` method ([src/session/simulation-store.ts](src/session/simulation-store.ts)) inserted BEFORE the `endsWith("QueryRq")` catch-all — necessary because the generic `handleQuery` doesn't know about the `AssignToObject` repeating filter. `OwnerID` single-filter narrows to a namespace; `AssignToObject` (single or array) is OR-style and matches any def whose `AssignToObject` set contains a requested value.

- **Sim handleQuery OwnerID branch:** added immediately after the IncludeLineItems gate in the generic `handleQuery`. Default (no OwnerID) → `stripDataExtKeys` removes `DataExtRet` from every row. With OwnerID present → `filterDataExtByOwner` retains only entries matching the requested namespace; alien namespaces (e.g. unknown UUID) drop the `DataExtRet` key entirely rather than emitting an empty array (would otherwise surface as `<DataExtRet/>` on a future serialization round trip).

- **31 new tests** across 4 layers:
  - Layer 1 (4) — parser round-trip pins: DataExtRet single + multi-entry; DataExtDefRet single + multi-AssignToObject arrays.
  - Layer 2 (6) — sim `DataExtDefQueryRq` handler: default returns all 4 defs; AssignToObject narrows to Customer (2 defs), Vendor (1), Invoice (1); OwnerID single-filter; missing-match empty.
  - Layer 3 (7) — sim `handleQuery` OwnerID gate: strip default; surface on Acme; alien OwnerID drops key; surface on Joe Contractor / seed invoice; entities without CFs come back without the key; IncludeLineItems + OwnerID compose independently.
  - Layer 4 (11) — tool surface: `qb_custom_field_list` happy + assignToObject:Customer / Vendor / Invoice / Account-empty / ownerId override; `qb_customer_list` / `qb_vendor_list` / `qb_invoice_list` strip-by-default vs. opt-in surfacing.
  - Plus 3 schema-order pins in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts): CustomerQueryRq OwnerID-after-NameFilter, InvoiceQueryRq OwnerID-after-IncludeLineItems, DataExtDefQueryRq OwnerID → AssignToObject.

- **[src/index.ts](src/index.ts) got:** new `registerCustomFieldTools` import + call, plus a dedicated Phase 13 #61 entry in the `instructions` block above the `qb_company_info` line covering the discovery tool + `includeCustomFields` opt-in pattern + the write-surface deferral.

- **[README.md](README.md) sync done:** tool count bumped 145 → 146 in both the `## Tools (146 total)` header and the architecture diagram inset. New row added to the Reference Lists table covering `qb_custom_field_list` + the pairing pattern with the seven list tools.

- **Tool count enumeration:** re-counted via `(Get-ChildItem "src\tools\*.ts" -File | Select-String -Pattern "server\.tool\(" | Measure-Object).Count` → **146 distinct `server.tool` calls** (145 prior + 1 new `qb_custom_field_list`).

## Verify Before Continuing

Re-run if the tree has been touched (skip if next session starts within hours):

- [ ] `npm run build` → exit 0 (tsc clean).
- [ ] `npm test` → `Test Files 54 passed | Tests 1367 passed`.
- [ ] `"" | & node dist/index.js` → exit 0, `Mode: simulation` printed.
- [ ] **(Windows + QB) #61 first live exercise.** Connect to `VR Tax & Consulting Inc..qbw`. Walk the CF read cycle:
  1. `qb_custom_field_list({})` — should return whatever CF defs are configured on the real company file (may differ from sim's seed; structure should match — one row per `(OwnerID, DataExtName)` with `AssignToObject` array). If the live file has no CFs configured, expect `count: 0`.
  2. `qb_custom_field_list({ assignToObject: "Customer" })` — narrows to defs targeting customers; should reduce vs. step 1 unless the operator has no Customer-only CFs.
  3. `qb_customer_list({ includeCustomFields: true })` — every returned customer should carry `DataExtRet` IF the live file has any CF values stored on customers. If no CFs are stored anywhere, every row's `DataExtRet` will be absent (the gate fires, but there's nothing to surface).
  4. `qb_customer_list({})` (no flag) — confirm `DataExtRet` is ABSENT on every row (strip-by-default contract). This is the regression-pin: if the live wire ever started leaking DataExtRet without an OwnerID, the strip would be silently bypassed.
  - **If a schema-order class of bug surfaces (statusCode -1)** on any of the *QueryRq calls with OwnerID, that's a `tests/builder-emit-order.test.ts` issue — the OwnerID position is pinned for CustomerQueryRq and InvoiceQueryRq but not for every tool that got `includeCustomFields`. Extending the pins to vendor / bill / item / account / employee would catch a future filter-dict re-order regression at the test layer rather than on the wire.
- [ ] **(Windows + QB) Carried — #72 `qb_transaction_list` first live exercise.** (Steps in prior handoff under git log `b733562`.)
- [ ] **(Windows + QB) Carried — #79 vehicle mileage first live exercise** against `VR Tax & Consulting Inc..qbw`. (Steps in prior handoff under git log `a2e9b58`.)
- [ ] **(Windows + QB) Carried — #81 statement charges first live exercise.**
- [ ] **(Windows + QB) Carried — #80 inventory adjustments first live exercise.**
- [ ] **(Windows + QB) Carried — #77 sales tax first live exercise.**
- [ ] **(Windows + QB) Carried — #76 sales orders first live exercise.**
- [ ] **(Windows + QB) Carried — #70 `qb_engagement_profitability` first live exercise.**
- [ ] **(Windows + QB) Carried — #78 time tracking first live exercise.**
- [ ] **(Windows + QB) Carried — #71 `qb_client_packet` first live exercise.**
- [ ] **(Windows + QB) Carried — #75 banking primitives first live exercise.**
- [ ] **(Windows + QB) Carried — #69 `qb_tax_line_mapping` + #68 `qb_trial_balance_export` first live exercises.**
- [ ] **(Windows + QB) Carried — Phase 18 #85 / #86 first live exercises** of `qb_closing_date_get` / `qb_closing_date_set` (9005 + UI navigation) / all five MCP prompts in Claude Desktop's `/` picker.
- [ ] **(Windows + QB) Carried — `qb_session_status` first live exercise** (zero wire I/O default + fail-soft probe/closingDate).
- [ ] **(Windows + QB) Carried — #84 transient-retry path, #82 host_query field surface, #55 W-2 wire shape, #59 attachment enablement, #54 SCF section labels.** Lowest priority.

## Next Task

**Operator picks next.** With #61 closed, the remaining Phase 13 cluster is three items + the other clusters below:

- **Phase 13 — Data model gaps (remaining)** — customer contact in invoice list (#60), sub-customer/job helpers (#62), memo full-text search (#63).
- **Phase 14 — Safety + DX** — dry-run mode (#64), better error surfaces with schema-order hints (#65), audit log read on Enterprise (#66).
- **Phase 16 follow-ons** — streaming responses (#73), MCP-side caching of stable lookups (#74).
- **Follow-up — DataExt write surface (#61 V2):** if a real workflow surfaces, add `qb_custom_field_set` / `qb_custom_field_delete` wrapping `DataExtAdd` / `DataExtDel` (and possibly `DataExtMod` for value updates). Wire shape:
  ```xml
  <DataExtAddRq>
    <DataExtAdd>
      <OwnerID>0</OwnerID>
      <DataExtName>Engagement Type</DataExtName>
      <ListDataExtType>Customer</ListDataExtType>    <!-- OR TxnDataExtType for transactions -->
      <ListObjRef><FullName>Acme Corporation</FullName></ListObjRef>
      <DataExtValue>1120-S</DataExtValue>
    </DataExtAdd>
  </DataExtAddRq>
  ```
  Verify the exact schema against qbxmlops*.xml before building — the live wire shape may differ slightly from the docs (especially the ListDataExt vs. TxnDataExt discriminator). Defer until a real operator workflow needs it.
- **Follow-up — VehicleMileage delete:** if mistake-correction workflows surface, add `qb_vehicle_mileage_delete` as a thin tool over the existing `deleteEntity("VehicleMileage", txnId)` path.
- **Follow-up — StatementCharge in ReceivePayment.AppliedToTxn:** extend `validateTxnApplications` + `applyTxnApplications` in [src/session/simulation-store.ts](src/session/simulation-store.ts) to walk both Invoice AND StatementCharge stores when resolving an AppliedToTxn TxnID.
- **Follow-up — JournalEntry in `qb_transaction_list`:** if a workflow needs JE alongside customer/vendor txns, extend sim's `handleQuery` `EntityFilter` chain to peek per-line `EntityRef` for JE specifically.

## Context Notes

- **Authoritative tool count is 146** (re-enumerated via `(Get-ChildItem "src\tools\*.ts" -File | Select-String -Pattern "server\.tool\(" | Measure-Object).Count` → 146 distinct calls across 32 files; new module is [src/tools/custom-fields.ts](src/tools/custom-fields.ts)). README + architecture diagram both reflect 146. Don't blindly increment from a HANDOFF figure — re-grep before bumping.

- **#61 architecture posture — READ-ONLY V1, mirrors Phase 10 #41 IncludeLineItems.** The default-strip + opt-in-flag pattern is now established across two surfaces (`*LineRet` via `includeLineItems`, `DataExtRet` via `includeCustomFields`). Future surfaces that need the same "verbose details hidden by default, opt-in via flag" pattern should follow the same template: `stripFooKeys` helper paired with a gate in `handleQuery`, plus a per-tool boolean arg translated into the wire filter at the END of the *QueryRq filter sequence. The flags compose — a tool can flip BOTH `includeLineItems` AND `includeCustomFields` and get both surfaces back.

- **#61 OwnerID positioning — schema tail.** In every entity *QueryRq schema sequence (CustomerQueryRq, VendorQueryRq, InvoiceQueryRq, BillQueryRq, ItemServiceQueryRq, AccountQueryRq, EmployeeQueryRq, …), `OwnerID` is the LAST child after the type-specific tail. For list entities that's after `NameFilter` / `ActiveStatus`; for transaction entities that's after `IncludeLineItems`. The seven tools all populate filters in this order. Two pins in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts) cover Customer + Invoice; vendor / bill / item / account / employee are NOT pinned individually — a future filter-dict re-order in those tools would surface as a wire-side parse error (statusCode -1) on first live exercise without test-layer detection. Cheap follow-up: extend the pin list.

- **#61 alien-namespace contract.** When the operator passes `customFieldOwnerId: "unknown-uuid"`, the response strips `DataExtRet` ENTIRELY rather than emitting an empty array. Rationale: an empty array would serialize as `<DataExtRet/>` on a future round trip, which is wire-noise. The current contract: "DataExtRet key present iff the entity has at least one CF in the requested namespace."

- **#61 sim seed has 4 DataExtDef + 3 CF-bearing entities.** Tests rely on Acme Corporation (Customer, 2 CFs) / Joe Contractor (Vendor, 1 CF) / T0000001-INV (Invoice, 1 CF). If a future test fixture or seed reset removes any of these, the data-ext-custom-fields tests fail. The defs themselves cover the four CPA-firm-typical fields: `Engagement Type` / `Partner Assigned` on Customer, `1099 Box` on Vendor, `Project Code` on Invoice/Estimate/SalesReceipt.

- **#61 AssignToObject zod enum has 27 values.** [src/tools/custom-fields.ts](src/tools/custom-fields.ts) `ASSIGN_TO_OBJECTS` array. Includes the less-common entity types (BuildAssembly, Charge, ItemReceipt, SalesTaxPaymentCheck, VendorCredit) because the QBXML SDK exposes CFs on them. If a real workflow surfaces a CF on an entity type NOT in this enum, add it to the list and update the test (`Layer 4 — qb_custom_field_list — returns empty for an entity type with no defined CFs (e.g. Account)` exercises an entity-type-not-found path).

- **#61 NO `qb_custom_field_set` / `qb_custom_field_delete` shipped.** Spec literal: "Add `includeCustomFields: boolean` and a separate `qb_custom_field_list` to discover what's defined per entity." Write is out of scope for V1. If the operator wants to set CF values mid-conversation, the wire request is `DataExtAddRq` (or `DataExtModRq` for value updates) and the dispatcher branch in `processRequest` would need a `handleDataExtAdd` mirror of `handleAttachableAdd` — defer until a real workflow needs it.

- **Carried gotchas (unchanged from prior handoffs — all still apply):**
  - **#72 architecture posture — COMPOSITE over typed queries, NOT a single `TransactionQueryRq`.**
  - **#72 JournalEntry NOT exposed.** Sim's `handleQuery` `EntityFilter` chain walks header refs only.
  - **#72 mixed customer-side + vendor-side types ALLOWED only when no entity scope is supplied.**
  - **#72 `maxPerType` is per-type, not aggregate.**
  - **#79 VehicleMileage has NO `TxnDate` field.** TripStartDate / TripEndDate are the canonical timestamps.
  - **#79 VehicleMileage is non-posting + immutable from SDK perspective.** No `VehicleMileageModRq` exists — no `_update` tool.
  - **#79 four-list sync** for any new transaction type: `isTransaction` in [src/qbxml/builder.ts](src/qbxml/builder.ts), `isTransaction` in [src/session/manager.ts](src/session/manager.ts), `isTransactionType` in [src/session/simulation-store.ts](src/session/simulation-store.ts), AND the CLAUDE.md doc list at line 58.
  - **#81 StatementCharge is single-row-at-header** — no `*LineAdd` array; ItemRef/Quantity/Rate/Amount live at the txn HEADER.
  - **#81 ReceivePayment limitation.** `validateTxnApplications` hardcodes the Invoice store — payments referencing a StatementCharge TxnID will reject.
  - **#80 InventoryAdjustment is the first transaction type that mutates ItemInventory state.** Two-phase commit invariant.
  - **#80 NO `_update` tool** — operational pattern is delete + recreate.
  - **#76 SalesOrder is non-posting** — Customer.Balance does NOT move on SO add or delete.
  - **#70 `IncludeLineItems: true` is LOAD-BEARING** for any tool that walks line-level data on Bill/Check/CreditCardCharge/SalesOrder.
  - **#70 customer scope on time is POST-FILTERED.**
  - **#70 customer scope on Bill/Check/CCC is LINE-LEVEL.**
  - **#70 `customerRefMatches` accepts EITHER ListID OR FullName match.**
  - **#78 EntityFilter priority reorder** — `handleQuery` does `EntityRef ?? CustomerRef ?? VendorRef ?? PayeeEntityRef`.
  - **#78 Duration is ISO 8601 PT-H-M-S only.**
  - **#71 fail-soft contract** — `sections.<name>` is either the success payload OR an `{ error: {...} }` block.
  - **#71 payroll has THREE skip states** — Pro → 9003, wire-zero → 9004, probe-fail → error.
  - **#75 EntityFilter strict improvement** — `handleQuery` matches `PayeeEntityRef` for Check / BillPaymentCheck / BillPaymentCreditCard / CreditCardCharge / CreditCardCredit.
  - **#67 default path is zero wire I/O.** Probe is opt-in.
  - **#85 SDK gap is permanent** — `qb_closing_date_set` always 9005 + UI navigation.
  - **Synthetic statusCodes**: 9001 read-only, 9002 idempotency conflict, 9003 edition unsupported, 9004 payroll subscription required, 9005 SDK has no write path.
  - **AR-side `Customer.Balance` discount math is correct; AP-side is NOT** — future `qb_bill_write_off` needs the parallel fix.
  - **Dispatch order in `processRequest`**: non-entity-typed `*QueryRq` / `*ModRq` / `AttachableAddRq` / `DataExtDefQueryRq` MUST precede the `endsWith` catch-alls.
  - **Iterator wire names diverge**: `iterator`/`iteratorID` on request, `iteratorRemainingCount`/`iteratorID` on response.
  - **fast-xml-parser does NOT decode numeric character entities** — use `decodeXmlEntities`.
  - **fast-xml-parser DOES coerce numeric-looking text to numbers** — `<CheckNumber>1001</CheckNumber>` → `1001` (number), not `"1001"`.
  - **Live verification requires `C:\nvm4w\nodejs\node.exe` v20.20.2** (system PATH v22 breaks winax).
  - **QBXMLRP2 cannot OPEN a `.qbw`**, only attach to one QB Desktop has already loaded.
  - **BillPayment* total is on `TotalAmount`**, not `Amount` — coalesce `TotalAmount ?? Amount`.
