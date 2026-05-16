# Handoff State

_Last updated: 2026-05-16. **Phase 16 #72 shipped — `qb_transaction_list` (cross-type unified transaction list).** Single new tool registered in [src/tools/transactions.ts](src/tools/transactions.ts) next to the existing `qb_transaction_list_by_account`. Pure composite over typed `*QueryRq` calls — one round trip per requested TxnType, all sharing a canonical `EntityFilter + TxnDateRangeFilter`. NO new wire types, NO new manager methods, NO sim-store changes, NO parser changes. Tool count **144 → 145**. Tests **1315 → 1336** (+21 new). Build + simulation banner clean._

## Last Session Summary

- **#72 `qb_transaction_list` — DONE.** Cross-type unified transaction list. Single call returns invoices + sales receipts + payments + credit memos + statement charges (under a customer scope), OR bills + bill payments + checks + credit-card charges (under a vendor scope), sorted chronologically with a `TxnType` tag injected onto every row. Replaces the 5–6 separate per-type list calls for the canonical "show me everything for Customer X in March" workflow.

- **Architectural call — rejected the literal spec, shipped a composite.** todo.md said "Wire as a single `TransactionQueryRq` with the requested types under `IncludeAll`. Keep per-type tools as thin wrappers for compatibility." Two reasons that path was wrong:
  - `IncludeAll` is not in the QBXML schema at any version — the spec was speculative.
  - `TransactionQueryRq` requires `AccountFilter` on the wire (real QB rejects without it; sim handler `handleTransactionQuery` pins this at `statusCode 3120` in [src/session/simulation-store.ts:1963-1977](src/session/simulation-store.ts)) AND returns LINE-LEVEL POSTING rows — wrong cardinality for "show me everything for Customer X" because the operator wants transaction headers, not posting lines (a 5-line invoice would produce 5+ rows under TransactionQueryRq).
  - Same architectural call as **#48 `qb_customer_balance_detail`** and **#51 `qb_vendor_balance_detail`** — those tools rejected the same single-wire path for the same reasons. Documented in a comment block above the new tool registration in [src/tools/transactions.ts](src/tools/transactions.ts).
  - Per-type list tools intentionally **NOT** removed. They remain the right surface for "give me all the invoices in March" without the cross-type fanout overhead. Spec hint about keeping them "as thin wrappers" already matches their current state.

- **Tool API surface:**
  - **Scope (exactly one direction):** `customerName | customerListId` (customer-side) OR `vendorName | vendorListId` (vendor-side). Mutually exclusive — both rejects 3120.
  - **Date window:** `fromDate?` / `toDate?` (YYYY-MM-DD). At least one of `{customer scope, vendor scope, fromDate, toDate}` is required to prevent unbounded fanout (3120 with actionable message).
  - **Types narrowing:** `types?` array. Customer-side accepted: `Invoice` / `SalesReceipt` / `ReceivePayment` / `CreditMemo` / `StatementCharge` / `Estimate` / `SalesOrder`. Vendor-side: `Bill` / `BillPaymentCheck` / `BillPaymentCreditCard` / `Check` / `CreditCardCharge` / `CreditCardCredit` / `PurchaseOrder`. **JournalEntry deliberately NOT exposed** (see below). Mixed customer-side + vendor-side types ALLOWED only when no entity scope is supplied (audit walk over a date window); under a scope, mixing rejects 3120 with the bad type named.
  - **Defaults:** customer scope (or no scope) → AR-affecting types `[Invoice, SalesReceipt, ReceivePayment, CreditMemo, StatementCharge]`; vendor scope → AP-affecting types `[Bill, BillPaymentCheck, BillPaymentCreditCard, Check, CreditCardCharge]`. Estimate / SalesOrder / PurchaseOrder / CreditCardCredit are non-default; opt-in via `types`.
  - **`maxPerType`** (default 500): per-type cap. Hitting the cap on any type surfaces a warning per-type.
  - **`includeLineItems`** (default false): threads through to every underlying typed query so the response rows carry full `*LineRet` detail. Per #41's strip-by-default policy.

- **Response shape** (returns transaction headers, not posting lines — distinct from `qb_transaction_list_by_account`):
  ```
  {
    scope: { direction: "customer"|"vendor"|"all", customerName?/customerListId?/vendorName?/vendorListId? },
    fromDate, toDate,
    types: [...],
    typeCounts: { Invoice: N, SalesReceipt: M, ... },
    count,
    transactions: [ { TxnType, ...full *Ret shape... } ],  // sorted by TxnDate asc, TimeCreated tiebreaker
    warnings?: [...]                                       // maxPerType cap hits
  }
  ```

- **Sim correctness** — works entirely through `session.queryEntity(<TxnType>, sharedFilters)`. The shared filter dict is built in canonical schema-order: `MaxReturned → TxnDateRangeFilter → EntityFilter → IncludeLineItems`. Each typed `*QueryRq` is already schema-order-pinned in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts), so no new pin was needed.

- **Entity canonicalization (ListID → FullName) mirrors #48's pattern** in `qb_customer_balance_detail`: when the operator supplies `customerListId`, the tool resolves it to `FullName` via a `CustomerQueryRq` first, then passes `EntityFilter: { FullName: ... }` to the typed queries. Sim's match-by-ListID path in `handleQuery` doesn't always hit stored refs added via `addEntity` without a hydrated ListID; canonicalizing to FullName is robust across both modes.

- **JournalEntry deliberately NOT exposed in the type enum.** JE's per-line `EntityRef` is not modeled in sim's `EntityFilter` chain at [src/session/simulation-store.ts:282-296](src/session/simulation-store.ts#L282-L296) — `handleQuery` walks header refs only via `EntityRef ?? CustomerRef ?? VendorRef ?? PayeeEntityRef`. JE postings against AR/AP are reachable via `qb_transaction_list_by_account` on the AR/AP account directly. Future work could add JE walk support if `handleQuery`'s `EntityFilter` is extended to peek per-line refs for JE specifically.

- **21 new tests in [tests/transaction-list-unified.test.ts](tests/transaction-list-unified.test.ts) across 3 layers — all green:**
  - Layer 1 (7) — happy paths: customer scope default types (5 fixtures, sort chronologically, typeCounts), TxnType tag injection, date window narrowing, explicit types narrowing (Invoice + ReceivePayment), vendor scope defaults, no-scope mode with date range, customerListId scope.
  - Layer 2 (11) — validation: both directions rejected 3120, both customerName+customerListId rejected 3120, both vendorName+vendorListId rejected 3120, no bound rejected 3120, vendor-side type under customer scope rejected with bad type named, customer-side type under vendor scope rejected, mixed types allowed without entity scope, unknown customer 500, unknown vendor 500, empty types[] zod-rejected, JournalEntry not in zod enum rejected.
  - Layer 3 (3) — edges: maxPerType=1 surfaces warning, includeLineItems:true threads through (InvoiceLineRet survives), default strips lines per #41.

- **Test fixtures use uniquely-named entities (`TxList Customer Inc.` / `TxList Vendor LLC`)** so they don't conflict with the sim seed's Acme / Office Supplies Co fixtures (which other tests' count expectations rely on). 5 customer-side fixtures (Invoice / SalesReceipt / ReceivePayment in March 2025; CreditMemo / StatementCharge in April 2025), 3 vendor-side fixtures (Bill / Check / BillPaymentCheck applied to the Bill — empty AppliedToTxnAdd reject was caught + fixed on first run).

- **[src/index.ts](src/index.ts) got:** new instructions block entry below the existing `qb_transaction_list_by_account` line (extends line 140 region). No new capability bullet needed (already covered by the "Raw QBXML query access" / "Cross-type" framing). Tool count enum in instructions still implicit.

- **[README.md](README.md) sync done:** tool count bumped 144 → 145 in both spots (`## Tools (145 total)` header + architecture diagram `(145 tools)` inset). New table row added directly below `qb_transaction_list_by_account` covering scope direction / type enum / defaults / validation rules / JournalEntry omission / `maxPerType` warning / distinction from `qb_transaction_list_by_account`.

- **Tool count enumeration:** re-counted via `(Get-ChildItem "src\tools\*.ts" -File | Select-String -Pattern "server\.tool\(" | Measure-Object).Count` → **145 distinct `server.tool` calls across 31 files**. Matches the README header.

## Verify Before Continuing

Re-run if the tree has been touched (skip if next session starts within hours):

- [ ] `npm run build` → exit 0 (tsc clean).
- [ ] `npm test` → `Test Files 53 passed | Tests 1336 passed`.
- [ ] `"" | & node dist/index.js` → exit 0, `Mode: simulation` printed.
- [ ] **(Windows + QB) #72 first live exercise.** Connect to `VR Tax & Consulting Inc..qbw`. Walk the unified-list cycle:
  1. Pick a customer from `qb_customer_list({})` that has multiple transaction types (an Invoice + a ReceivePayment at minimum). Capture its `FullName`.
  2. `qb_transaction_list({ customerName: "<customer>" })` — confirm default 5 customer-side types are fanned out (Invoice/SR/RP/CM/StatementCharge), TxnType tag on every row, chronological sort, typeCounts adds up to count.
  3. `qb_transaction_list({ customerName: "<customer>", types: ["Invoice"], includeLineItems: true })` — confirm InvoiceLineRet survives on every row.
  4. `qb_transaction_list({ vendorName: "<vendor>" })` against a vendor with paid bills — confirm Bill + BillPaymentCheck both surface, sort chronologically.
  5. `qb_transaction_list({ customerName: "<customer>", types: ["Bill"] })` — confirm 3120 rejection with "vendor-side and incompatible with customer scope" message.
  - **If a schema-order class of bug surfaces (statusCode -1 from QBXMLRP2)** on any of the underlying typed queries, that's a regression in the pre-existing `*QueryRq` schema-order — not a #72 issue. Each typed query is already pinned in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts).
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

**Operator picks next.** With #72 closed, the remaining clusters are:

- **Phase 13 — Data model gaps** — customer contact in invoice list (#60), DataExt custom fields (#61), sub-customer/job helpers (#62), memo full-text search (#63).
- **Phase 14 — Safety + DX** — dry-run mode (#64), better error surfaces with schema-order hints (#65), audit log read on Enterprise (#66).
- **Phase 16 follow-ons** — streaming responses (#73), MCP-side caching of stable lookups (#74).
- **Follow-up — VehicleMileage delete:** if mistake-correction workflows surface, add `qb_vehicle_mileage_delete` as a thin tool over the existing `deleteEntity("VehicleMileage", txnId)` path. Infrastructure already in place — one-tool add with parallel test coverage.
- **Follow-up — StatementCharge in ReceivePayment.AppliedToTxn:** extend `validateTxnApplications` + `applyTxnApplications` in [src/session/simulation-store.ts](src/session/simulation-store.ts) to walk both Invoice AND StatementCharge stores when resolving an AppliedToTxn TxnID. Currently rejects with "Invoice not found".
- **Follow-up — JournalEntry in `qb_transaction_list`:** if a workflow needs JE alongside customer/vendor txns, extend sim's `handleQuery` `EntityFilter` chain at [src/session/simulation-store.ts:282-296](src/session/simulation-store.ts#L282-L296) to peek per-line `EntityRef` for JE specifically, then add `JournalEntry` to the customer-side type enum in [src/tools/transactions.ts](src/tools/transactions.ts). Real QB already filters JE by per-line entity ref; sim is the only blocker.

## Context Notes

- **Authoritative tool count is 145** (re-enumerated via `(Get-ChildItem "src\tools\*.ts" -File | Select-String -Pattern "server\.tool\(" | Measure-Object).Count` → 145 distinct calls across 31 files). README + architecture diagram both reflect 145. Don't blindly increment from a HANDOFF figure — re-grep before bumping.

- **#72 architecture posture — COMPOSITE over typed queries, NOT a single `TransactionQueryRq`.** The literal spec in todo.md ("single TransactionQueryRq with IncludeAll") was rejected for two reasons: (a) `IncludeAll` is not in the schema; (b) `TransactionQueryRq` requires `AccountFilter` and returns line-level POSTING rows, wrong cardinality for "show me everything for Customer X". Same architectural call as #48 / #51. The composite pattern is the right one for any future cross-type tool that needs to fan out by entity ref rather than account.

- **#72 JournalEntry NOT exposed.** Sim's `handleQuery` `EntityFilter` chain ([src/session/simulation-store.ts:282-296](src/session/simulation-store.ts#L282-L296)) walks header refs only — JE has no header EntityRef (only per-line). Real QB filters JE by per-line entity ref; sim doesn't model this. If a future workflow needs JE in the unified list, extend handleQuery's EntityFilter branch to peek `JournalDebitLine[].EntityRef` + `JournalCreditLine[].EntityRef` when entity type is JournalEntry, then add JournalEntry to the type enum.

- **#72 mixed customer-side + vendor-side types ALLOWED only when no entity scope is supplied.** This is the audit-walk-over-a-date-window use case ("what happened in March across everything"). Under a customer or vendor scope, mixing rejects 3120 because the EntityFilter direction is fixed — pointing a customer-scope EntityFilter at a Bill type would silently return empty in sim (Bill carries VendorRef, not CustomerRef) and is almost certainly a caller mistake.

- **#72 `maxPerType` is per-type, not aggregate.** Default 500. A `qb_transaction_list` against a customer with 5 default types would cap at 2500 rows total before warnings. If aggregate cap matters for a workflow, the operator combines `maxPerType` with explicit `types` narrowing.

- **Carried gotchas (unchanged from prior handoffs — all still apply):**
  - **#79 VehicleMileage has NO `TxnDate` field.** TripStartDate / TripEndDate are the canonical timestamps. The `TripDateRangeFilter` branch in `handleQuery` is parallel to `TxnDateRangeFilter`.
  - **#79 VehicleMileage is non-posting + immutable from SDK perspective.** No `VehicleMileageModRq` exists — no `_update` tool.
  - **#79 four-list sync** for any new transaction type: `isTransaction` in [src/qbxml/builder.ts](src/qbxml/builder.ts), `isTransaction` in [src/session/manager.ts](src/session/manager.ts), `isTransactionType` in [src/session/simulation-store.ts](src/session/simulation-store.ts), AND the CLAUDE.md doc list at line 58. Tests catch divergence (TxnDel routing breaks if any list is out of sync) — but the CLAUDE.md doc list has no test coverage; it drifts silently.
  - **#81 StatementCharge is single-row-at-header** — no `*LineAdd` array; ItemRef/Quantity/Rate/Amount live at the txn HEADER.
  - **#81 ReceivePayment limitation.** `validateTxnApplications` hardcodes the Invoice store — payments referencing a StatementCharge TxnID will reject.
  - **#80 InventoryAdjustment is the first transaction type that mutates ItemInventory state.** Two-phase commit invariant.
  - **#80 NO `_update` tool** — operational pattern is delete + recreate.
  - **#76 SalesOrder is non-posting** — Customer.Balance does NOT move on SO add or delete.
  - **#70 `IncludeLineItems: true` is LOAD-BEARING** for any tool that walks line-level data on Bill/Check/CreditCardCharge/SalesOrder.
  - **#70 customer scope on time is POST-FILTERED.**
  - **#70 customer scope on Bill/Check/CCC is LINE-LEVEL.**
  - **#70 `customerRefMatches` accepts EITHER ListID OR FullName match.**
  - **#78 EntityFilter priority reorder** — `handleQuery` does `EntityRef ?? CustomerRef ?? VendorRef ?? PayeeEntityRef`. #79 adds a parallel `VehicleFilter` branch.
  - **#78 Duration is ISO 8601 PT-H-M-S only.**
  - **#71 fail-soft contract** — `sections.<name>` is either the success payload OR an `{ error: {...} }` block.
  - **#71 payroll has THREE skip states** — Pro → 9003, wire-zero → 9004, probe-fail → error.
  - **#75 EntityFilter strict improvement** — `handleQuery` matches `PayeeEntityRef` for Check / BillPaymentCheck / BillPaymentCreditCard / CreditCardCharge / CreditCardCredit.
  - **#67 default path is zero wire I/O.** Probe is opt-in.
  - **#85 SDK gap is permanent** — `qb_closing_date_set` always 9005 + UI navigation.
  - **Synthetic statusCodes**: 9001 read-only, 9002 idempotency conflict, 9003 edition unsupported, 9004 payroll subscription required, 9005 SDK has no write path.
  - **AR-side `Customer.Balance` discount math is correct; AP-side is NOT** — future `qb_bill_write_off` needs the parallel fix.
  - **Dispatch order in `processRequest`**: non-entity-typed `*QueryRq` / `*ModRq` / `AttachableAddRq` MUST precede the `endsWith` catch-alls.
  - **Iterator wire names diverge**: `iterator`/`iteratorID` on request, `iteratorRemainingCount`/`iteratorID` on response.
  - **fast-xml-parser does NOT decode numeric character entities** — use `decodeXmlEntities`.
  - **fast-xml-parser DOES coerce numeric-looking text to numbers** — `<CheckNumber>1001</CheckNumber>` → `1001` (number), not `"1001"`.
  - **Live verification requires `C:\nvm4w\nodejs\node.exe` v20.20.2** (system PATH v22 breaks winax).
  - **QBXMLRP2 cannot OPEN a `.qbw`**, only attach to one QB Desktop has already loaded.
  - **BillPayment* total is on `TotalAmount`**, not `Amount` — coalesce `TotalAmount ?? Amount`.
