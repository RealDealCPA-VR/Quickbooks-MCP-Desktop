# Handoff State

_Last updated: 2026-05-15. **Phase 17 #80 inventory adjustments shipped.** 3 new tools in fresh [src/tools/inventory-adjustments.ts](src/tools/inventory-adjustments.ts) — `qb_inventory_adjustment_create` / `_list` / `_delete`. Pure composites over the existing generic primitives; no new manager methods. 2 new parser arrayElements (`InventoryAdjustmentRet`, `InventoryAdjustmentLineRet`). `InventoryAdjustment` added to all three transaction-type lists (builder.ts / manager.ts / simulation-store.ts) — first new transaction type that is NOT bank-affecting (no entry in `BANK_AFFECTING_TXN_TYPES`; AccountRef is the P&L offset). New sim handlers `applyInventoryAdjustment` (handleAdd dispatch — two-phase commit; mutates ItemInventory.QuantityOnHand / QuantityOnHandValue / AverageCost; normalizes both QuantityAdjustment / ValueAdjustment input shapes to QuantityDifference + ValueDifference + Amount on lines) + `reverseInventoryAdjustment` (handleTxnDel — orphan-item silent skip). Sim seed bumped: Widget A from cost-only to QuantityOnHand=100 / AverageCost=12 / QuantityOnHandValue=1200; new Widget B (I0000004, ItemInventory) at 40 / 22 / 880 for multi-item tests. NO seeded InventoryAdjustment — bare list returns count=0; tests build state via `session.addEntity`. CLAUDE.md transaction-entities list updated (added TimeTracking, SalesTaxPaymentCheck, InventoryAdjustment — three types that had been missed in prior phase doc updates). 43 new tests across 5 layers — all green. Tool count 134 → 137; 1193 → 1236 tests green. README sync done: new `### Inventory Adjustments` section between Sales Tax and Journal Entries, architecture diagram inset bumped in both spots. Build + test + simulation banner clean._

## Last Session Summary

- **#80 inventory adjustments — DONE.** 3 tools shipped:
  - `qb_inventory_adjustment_list` — `InventoryAdjustmentQueryRq`. Header fields by default; `includeLineItems:true` surfaces normalized `InventoryAdjustmentLineRet` (each line carries QuantityDifference + ValueDifference + Amount + ItemRef regardless of which input shape was used). Filters: `txnId / refNumber / accountName / accountListId / fromDate / toDate / maxReturned`. AccountFilter is a tool-layer post-filter (not server-side EntityFilter) because real QB scopes server-side but sim's generic handleQuery doesn't recognize AccountFilter for this entity.
  - `qb_inventory_adjustment_create` — `InventoryAdjustmentAddRq`. Required: `accountName | accountListId` (the offsetting GL account — typically COGS or Inventory Adjustment expense) + `lines` array (≥1). Each line picks one of three shapes: pure quantity (`newQuantity` XOR `quantityDifference` — value moves at current AverageCost), pure value (`newValue` XOR `valueDifference` — repricing without count change), combined (any value field paired with any quantity field — routes through ValueAdjustment because real QB needs the value side explicit when both move). Standard idempotencyKey + read-only gate behaviors. Optional CustomerRef / ClassRef for cost allocation.
  - `qb_inventory_adjustment_delete` — `TxnDelRq` with TxnDelType=InventoryAdjustment. Reverses every line's qty/value delta against still-present ItemInventory (orphan items silently skipped — matches credit-memo reversal precedent).

- **Infrastructure changes (in sync across builder.ts / manager.ts / simulation-store.ts):**
  - Three transaction-type lists extended with `InventoryAdjustment` per the CLAUDE.md canonical-invariant rule.
  - **NOT** in `BANK_AFFECTING_TXN_TYPES` — distinct from #75 (Deposit/Check/Transfer) and #77 (SalesTaxPaymentCheck) which all draw against bank/CC accounts. InventoryAdjustment posts against an Inventory Adjustment expense / COGS account; no ClearedStatus default; doesn't participate in `qb_uncleared_transactions` or `qb_reconciliation_discrepancy`.
  - 2 new parser arrayElements: `InventoryAdjustmentRet`, `InventoryAdjustmentLineRet`.

- **Sim handler additions in [src/session/simulation-store.ts](src/session/simulation-store.ts):**
  - New `applyInventoryAdjustment(entity)` helper dispatched from `handleAdd` after the JournalEntry branch (around the existing if-else chain at the end of handleAdd's pre-persist phase). Two-phase commit: validates EVERY line first (item lookup, mutually-exclusive QuantityAdjustment / ValueAdjustment branches, NewQuantity-or-QuantityDifference / NewValue-or-ValueDifference required), accumulates planned mutations into a `Plan[]` array, commits only after the full set passes. Running-state Maps (`runningQty / runningValue / runningAvgCost`) keyed on ItemListID so multi-line same-item adjustments compose correctly.
  - New `reverseInventoryAdjustment(target)` dispatched from `handleTxnDel` after the CreditMemo branch. Walks the deleted txn's `InventoryAdjustmentLineRet`, decrements each item's QuantityOnHand by `line.QuantityDifference` and QuantityOnHandValue by `line.ValueDifference`, recomputes AverageCost when newQty > 0 (else preserves prior cost). Orphan items silently skipped.
  - New private `findInventoryItem(ref)` helper — ListID first, FullName fallback (matches the existing `findInventoryItem`-style lookup pattern used elsewhere).
  - **AverageCost preservation at zero qty** — when an adjustment drops QuantityOnHand to 0, the prior AverageCost is preserved (real QB does the same — a future restock keeps cost-basis history; otherwise dividing $0 by 0 units would corrupt the field).

- **Sim seed bumps:**
  - Widget A (I0000003) bumped from `Cost: 12.00` only to also carry `QuantityOnHand: 100, AverageCost: 12.00, QuantityOnHandValue: 1200.00`. Class invariant: `QuantityOnHandValue = QuantityOnHand × AverageCost`.
  - New Widget B (I0000004) ItemInventory at `Price: 50, Cost: 22, QuantityOnHand: 40, AverageCost: 22, QuantityOnHandValue: 880`. Provides a second item for multi-line adjustment testing.
  - **NO seeded InventoryAdjustment** — bare `qb_inventory_adjustment_list` returns count=0 against fresh sim. Operators / tests build state via `session.addEntity` or the tool. Avoids pre/post-state consistency complexity (would need to either seed Widget A at 95 with an adjustment claiming -5 delta, or seed both at clean baseline with a no-op adjustment — neither is clean).

- **CLAUDE.md transaction-entities list update:** the canonical list at line 58 was missing the three trailing transaction types added in recent phases (#78 TimeTracking, #77 SalesTaxPaymentCheck, #80 InventoryAdjustment). All three added in one edit.

- **43 new tests in [tests/inventory-adjustments.test.ts](tests/inventory-adjustments.test.ts) across 5 layers** — all green. Coverage: sim handleAdd (14 — seed shape, NewQuantity / QuantityDifference / NewValue / ValueDifference / combined input forms, two-line two-item, AverageCost preservation at zero qty, multi-line same-item running composition, ItemRef-by-ListID, missing AccountRef, missing lines, unknown item with two-phase guarantee, both-branches, neither-branch, empty QuantityAdjustment); sim handleTxnDel (4 — full qty reversal, value-only reversal recomputing AverageCost, two-item reversal, orphan-item silent skip); `qb_inventory_adjustment_list` (6 — bare empty, post-create surface, includeLineItems normalized deltas, txnId / refNumber / accountName / date filters); `qb_inventory_adjustment_create` (13 — NewQuantity / quantityDifference / valueDifference / combined newQuantity+newValue / multi-line happy, itemListId, missing accountRef upfront, idempotencyKey replay (verifies state mutated ONCE) + 9002 conflict, read-only 9001, sim-layer 3120 fallback for Zod-bypassed neither-branch + empty-lines (fakeServer harness bypass), unknown-item structured error with humanReadable); `qb_inventory_adjustment_delete` (3 — happy path with state reversal, unknown TxnID 500, read-only 9001).

- **README sync done.** Tool count 134 → 137 in both spots (`## Tools (137 total)` header + architecture diagram `(137 tools)` inset). New `### Inventory Adjustments` section between Sales Tax and Journal Entries — explains the AccountRef-as-offset model, the three input shapes (pure-qty / pure-value / combined), AverageCost recomputation rules + zero-qty preservation, two-phase commit guarantee, the no-update design choice (delete + recreate), Enterprise-only field omissions, plus a 3-row tool table.

- **src/index.ts** got: import + register call + new Capabilities bullet ("Inventory adjustments (shrinkage, count corrections, value write-downs)") + new `qb_inventory_adjustment_*` instructions block entry above sales-tax + extension of the idempotency-keyed-tools enumeration with `qb_inventory_adjustment_create`.

- **Tool count enumeration:** re-counted via `Grep -c "server\.tool\(" src/tools` → **137 distinct `server.tool` calls across 29 files**. Matches the README header.

## Verify Before Continuing

Re-run if the tree has been touched (skip if next session starts within hours):

- [ ] `npm run build` → exit 0 (tsc clean).
- [ ] `npm test` → `Test Files 50 passed | Tests 1236 passed`.
- [ ] `"" | & node dist/index.js` → exit 0, `Mode: simulation` printed.
- [ ] **(Windows + QB) #80 first live exercise.** Connect to `VR Tax & Consulting Inc..qbw` (or any company file with inventory items). Walk the inventory adjustment cycle:
  1. `qb_item_list({ itemType: "Inventory" })` — confirm at least one ItemInventory exists with QuantityOnHand surfaced (real QB carries QuantityOnHand on every Inventory item).
  2. `qb_inventory_adjustment_create({ accountName: "<an inventory adjustment / COGS account>", lines: [{ itemName: "<an inventory item>", quantityDifference: -1 }] })` — confirm `success: true`, the txn returns with TotalAmount = -1 × current AverageCost, and the next `qb_item_list` shows that item's QuantityOnHand decremented by 1.
  3. `qb_inventory_adjustment_list({ includeLineItems: true })` — confirm the new adjustment surfaces with normalized `QuantityDifference: -1 + ValueDifference: -<avgCost>` on the line (real QB normalizes both input shapes to these two fields on read).
  4. `qb_inventory_adjustment_delete({ txnId: "<TxnID>" })` — confirm the prior item's QuantityOnHand restores via `qb_item_list`. Real QB enforces no-mutation-after-deletion-blocked-on-related-txns rules; the orphan-skip path on the sim side is defensive only.
  - **If a schema-order class of bug surfaces (statusCode -1 from QBXMLRP2)** on `InventoryAdjustmentAddRq`, capture envelope via `QB_DEBUG_QBXML=1` and pin canonical child order in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts) the way #37 did for `GeneralSummaryReportQueryRq`. The JS key insertion order in the tool layer is `AccountRef → TxnDate → RefNumber → CustomerRef → ClassRef → Memo → InventoryAdjustmentLineAdd*`. Per-line: `ItemRef → QuantityAdjustment | ValueAdjustment` (mutually exclusive — sim handler enforces).
  - **Try a value-only adjustment** (`{ accountName: "...", lines: [{ itemName: "...", valueDifference: -100 }] }`) to validate the ValueAdjustment branch on real QB. If real QB requires a NewQuantity or QuantityDifference even on pure value adjustments (some SDK versions did), surface the error at the tool layer before submission.
- [ ] **(Windows + QB) Carried — #77 sales tax first live exercise** against `VR Tax & Consulting Inc..qbw`.
- [ ] **(Windows + QB) Carried — #76 sales orders first live exercise** against `VR Tax & Consulting Inc..qbw`.
- [ ] **(Windows + QB) Carried — #70 `qb_engagement_profitability` first live exercise.**
- [ ] **(Windows + QB) Carried — #78 time tracking first live exercise.** TimeTrackingAddRq canonical child order: `TxnDate → EntityRef → CustomerRef → ItemServiceRef → Duration → ClassRef → PayrollItemWageRef → Notes → IsBillable → BillableStatus`.
- [ ] **(Windows + QB) Carried — #71 `qb_client_packet` first live exercise.**
- [ ] **(Windows + QB) Carried — #75 banking primitives first live exercise.**
- [ ] **(Windows + QB) Carried — #69 `qb_tax_line_mapping` + #68 `qb_trial_balance_export` first live exercises.**
- [ ] **(Windows + QB) Carried — Phase 18 #85 / #86 first live exercises** of `qb_closing_date_get` / `qb_closing_date_set` (9005 + UI navigation) / all five MCP prompts in Claude Desktop's `/` picker.
- [ ] **(Windows + QB) Carried — `qb_session_status` first live exercise** (zero wire I/O default + fail-soft probe/closingDate).
- [ ] **(Windows + QB) Carried — #84 transient-retry path, #82 host_query field surface, #55 W-2 wire shape, #59 attachment enablement, #54 SCF section labels.** Lowest priority.

## Next Task

**Operator picks next.** With #80 closed, remaining Phase 17 items + Phase 13-14 coverage gaps:

- **#81 statement charges** (Phase 17) — `qb_statement_charge_add` / `_list` / `_update` / `_delete`. `StatementChargeAddRq` / `StatementChargeQueryRq`. Service-business time-and-materials billing without a formal invoice; mentioned in #72 (generic transaction list) as one of the 6 transaction types but no dedicated tool yet.
- **#79 vehicle mileage** (Phase 17) — `qb_vehicle_mileage_add` / `_list` / `qb_vehicle_list`. Tax-practice staple (Schedule C / Form 4562 mileage logs).
- **Phase 13–14 coverage gaps** — DataExt (#61), sub-customer (#62), memo search (#63), dry-run (#64), better errors (#65), audit log (#66 — Enterprise-only).

## Context Notes

- **Authoritative tool count is 137** (re-enumerated via `Grep -c "server\.tool\(" src/tools` → 137 distinct calls across 29 files). README + architecture diagram both reflect 137. Don't blindly increment from a HANDOFF figure — re-grep before bumping.

- **#80 InventoryAdjustment is the first transaction type that mutates ItemInventory state.** No prior transaction touches QuantityOnHand / AverageCost / QuantityOnHandValue (Bills with item lines record the cost but don't move QuantityOnHand in sim — the item-receipt-against-bill linkage isn't modeled). Any future tool that needs to read post-adjustment inventory state should query `ItemInventory` after the adjustment posts; tests confirm the round-trip works.

- **#80 two-phase commit invariant** — `applyInventoryAdjustment` validates every line BEFORE mutating any items. A doomed line in position 5 must not leave items 1-4 partially adjusted. This is enforced by accumulating a `Plan[]` array during validation and only mutating the items in a separate commit pass after the full validation succeeds. **Tests pin this invariant** (the "unknown ItemRef" test creates a 2-line adjustment where line 1 references Widget A and line 2 references a nonexistent item; confirms Widget A's state is UNTOUCHED after the rejection).

- **#80 NO `_update` tool** — `InventoryAdjustmentModRq` exists in QBXML SDK from version 12.0 but the operational pattern in real QB is delete + recreate. The recompute logic for partial line edits (rewind old deltas, re-apply new ones, handle items being added/removed across the mod) is meaningfully more complex than a regular `_update` and not requested. If a future operator pain point demands it, the path is: extend `applyInventoryAdjustment` to support a `previousLines: Line[]` arg that triggers the rewind walk first, then re-applies fresh planning.

- **#80 GL posting to AccountRef NOT modeled** in sim's first cut. Real QB posts the offset automatically (debit Inventory Adjustment expense, credit Inventory asset on shrinkage; reverse on stock-up). Sim mutation is item-state-only — `qb_pnl_report` won't show inventory adjustments as expenses, and `qb_balance_summary`'s Inventory account balance won't move. Same class of deferred work as #43 JE-line customer-balance bookkeeping. Adding it later: extend `walkTxnLines` (or whatever P&L walks) to recognize InventoryAdjustment as an expense source against the AccountRef.

- **#80 SalesReceipt / SalesOrder seed lines reference Widget A** — `tests/sales-by-customer.test.ts:126` and `tests/sales-by-item.test.ts:124` use `Widget A` as a line `ItemRef.FullName`. The seed bump (adding QuantityOnHand fields) does NOT change Widget A's identity (FullName, ListID, Price, Cost all unchanged), so these tests continue to pass — confirmed by full test suite green at 1236.

- **#80 sim seed deliberate omission** — no seeded InventoryAdjustment. Bare `qb_inventory_adjustment_list` returns count=0 against fresh sim. Avoids pre/post-state consistency entanglement (would need either Widget A at 95 with an adjustment claiming -5 delta, or seed both items at clean baseline with a no-op adjustment — neither is clean). Matches the precedent that some entity types have seeded transactions (SalesOrder, SalesTax SalesReceipt) and some don't (Estimate, JournalEntry initial seed varies). If an operator needs a richer fresh-sim experience, the pattern is to call the create tool twice on session start.

- **#80 AverageCost preserved at zero qty** — when QuantityOnHand falls to 0, AverageCost is intentionally preserved (not divided by 0, not zeroed). Cost-basis history matters for reporting + for any future restock that wants to inherit the prior cost. Pinned by the dedicated test "Quantity falls to zero — AverageCost is PRESERVED."

- **#80 multi-line same-item composition** — uses `runningQty` / `runningValue` / `runningAvgCost` Maps keyed on item ListID so multiple lines against the same item compose against the running state, not against the original stored state. Pinned by the "Multiple lines against the SAME item compose" test.

- **#80 input-shape normalization on read** — real QB returns `QuantityDifference + ValueDifference` regardless of which input form (NewQuantity / QuantityDifference / NewValue / ValueDifference) was used. Sim mirrors this via the post-mutation line-shape rewrite in `applyInventoryAdjustment`'s commit phase. Pinned by `qb_inventory_adjustment_list` includeLineItems test.

- **CLAUDE.md transaction-entities list line 58 had drifted** — was missing TimeTracking (#78), SalesTaxPaymentCheck (#77), and InventoryAdjustment (#80). Fixed in this session. The list is the canonical reference for "what types use TxnID + TxnDelRq vs ListID + ListDelRq" and must stay in sync with the three runtime arrays (builder.ts, manager.ts, simulation-store.ts). **Future PRs adding a new transaction type need to update FOUR places, not three.**

- **Carried gotchas (unchanged from prior handoffs — all still apply):**
  - **#77 SalesReceipt seed is dated 2025-01-15** deliberately — falls outside the 2024-windowed engagement-profitability tests + the 2025-12 customer-balance-detail tests.
  - **#77 liability report is HEADER-level only** — per-line tax flagging is not modeled in sim.
  - **#77 sales-tax agencies are Vendors, not a separate entity** — derived from distinct TaxVendorRef values.
  - **#77 SalesTaxPaymentCheck vs Check distinction** — payment check reduces sales-tax-item liability; regular check posted to a tax-liability account would double-count.
  - **#77 SalesTaxLiability custom report shape** — emits `Rows / ByAgency / Totals` rather than canonical `Sections / Totals`.
  - **#76 SalesOrder is non-posting** — Customer.Balance does NOT move on SO add or delete.
  - **#76 convert idempotency skip-on-replay** — same pattern as estimate convert.
  - **Convert-to-invoice idempotency pattern is now a 2x example** (estimate + sales order). Future convert-style composites should follow.
  - **#70 `IncludeLineItems: true` is LOAD-BEARING** for any tool that walks line-level data on Bill/Check/CreditCardCharge/SalesOrder.
  - **#70 customer scope on time is POST-FILTERED.**
  - **#70 customer scope on Bill/Check/CCC is LINE-LEVEL.**
  - **#70 summary OMITTED when any section is error or any toggle off.**
  - **#70 customer lookup is the one non-fail-soft path.**
  - **#70 first cross-tool consumer of `parseDurationToHours`** from [src/tools/time-tracking.ts](src/tools/time-tracking.ts).
  - **#70 `customerRefMatches` accepts EITHER ListID OR FullName match.**
  - **#78 EntityFilter priority reorder** — `handleQuery` does `EntityRef ?? CustomerRef ?? VendorRef ?? PayeeEntityRef`.
  - **#78 Duration is ISO 8601 PT-H-M-S only.**
  - **#78 IsBillable + BillableStatus co-emission.**
  - **#71 fail-soft contract** — `sections.<name>` is either the success payload OR an `{ error: {...} }` block.
  - **#71 payroll has THREE skip states** — Pro → 9003, wire-zero → 9004, probe-fail → error.
  - **#71 GL defaults to PnLOnly scope** for cost reasons.
  - **#71 customerListId / customerName is OPTIONAL CONTEXT, NOT A FILTER.** #70 INVERTS this.
  - **#71 AccountQueryRq failure is the only non-fail-soft path** for #71; #70's parallel is CustomerQueryRq failure.
  - **#75 EntityFilter strict improvement** — `handleQuery` matches `PayeeEntityRef` for Check / BillPaymentCheck / BillPaymentCreditCard / CreditCardCharge / CreditCardCredit.
  - **#75 `computeTotals` Check.Amount / Deposit.DepositTotal** — "set when undefined, preserve explicit overrides". #76 (SalesOrder.TotalAmount) inverts: always derives. #77 (SalesTaxPaymentCheck.TotalAmount) follows the same set-when-undefined pattern. **#80 (InventoryAdjustment.TotalAmount) ALWAYS overrides** — set explicitly by `applyInventoryAdjustment` from `Σ ValueDifference`; the operator can't sensibly override (it must reconcile with the per-line delta sum).
  - **#75 Sim does NOT move `Bank.Account.Balance`** on Deposit/Transfer/Check.
  - **#67 default path is zero wire I/O.** Probe is opt-in.
  - **#68 RECON_TOLERANCE = 0.01.**
  - **#69 "Mapped" definition** — TaxLineName non-empty.
  - **#85 SDK gap is permanent** — `qb_closing_date_set` always 9005 + UI navigation.
  - **Synthetic statusCodes**: 9001 read-only, 9002 idempotency conflict, 9003 edition unsupported, 9004 payroll subscription required, 9005 SDK has no write path.
  - **#86 prompts registration** uses `reg<Args>(entry)` helper + `as const` tuple.
  - **Three transaction-type lists must stay in sync** across builder / manager / simulation-store. **PLUS the CLAUDE.md doc list at line 58.** #80 added `InventoryAdjustment` to all four; prior handoff caught this for #77 / #78 in the runtime arrays but missed the CLAUDE.md doc — now fixed.
  - **AR-side `Customer.Balance` discount math is correct; AP-side is NOT** — future `qb_bill_write_off` needs the parallel fix.
  - **Dispatch order in `processRequest`**: non-entity-typed `*QueryRq` / `*ModRq` / `AttachableAddRq` MUST precede the `endsWith` catch-alls.
  - **Iterator wire names diverge**: `iterator`/`iteratorID` on request, `iteratorRemainingCount`/`iteratorID` on response.
  - **fast-xml-parser does NOT decode numeric character entities** — use `decodeXmlEntities`.
  - **fast-xml-parser DOES coerce numeric-looking text to numbers** — `<CheckNumber>1001</CheckNumber>` → `1001` (number), not `"1001"`.
  - **Live verification requires `C:\nvm4w\nodejs\node.exe` v20.20.2** (system PATH v22 breaks winax).
  - **QBXMLRP2 cannot OPEN a `.qbw`**, only attach to one QB Desktop has already loaded.
  - **BillPayment* total is on `TotalAmount`**, not `Amount` — coalesce `TotalAmount ?? Amount`.
