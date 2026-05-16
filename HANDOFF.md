# Handoff State

_Last updated: 2026-05-16. **Phase 17 #81 statement charges shipped.** 4 new tools in fresh [src/tools/statement-charges.ts](src/tools/statement-charges.ts) — `qb_statement_charge_list` / `_create` / `_update` / `_delete`. Structurally unique: only transaction type in this server with NO `*LineAdd` array (ItemRef / Quantity / Rate / Amount live at the txn header — single-row billing). New `computeTotals` branch derives `Amount = Quantity * Rate` at header level. AR-positive posting (Customer.Balance moves by +Amount on add, -Amount on delete; mods re-derive Amount on Qty/Rate change and reconcile balance by delta). `adjustPartyBalanceForTxn` + `adjustPartyBalanceForTxnMod` amountField union extended with `"Amount"` (strict improvement; serves any future header-Amount txn type). Four lists in sync (builder.ts / manager.ts / simulation-store.ts + CLAUDE.md doc list at line 58). NEW parser arrayElement: `StatementChargeRet` only (no `*LineRet` — header-level fields). NOT in BANK_AFFECTING_TXN_TYPES. NO seed (matches #80 precedent — preserves existing customer-balance test fixtures). 39 new tests across 7 layers — all green. Tool count 137 → 141; 1236 → 1275 tests green. README sync done: new `### Statement Charges` section between Inventory Adjustments and Journal Entries; architecture diagram inset bumped in both spots. Build + test + simulation banner clean._

## Last Session Summary

- **#81 statement charges — DONE.** 4 tools shipped:
  - `qb_statement_charge_list` — `StatementChargeQueryRq`. Header fields only (no line-Ret on this entity type — see structural notes below). Filters: `txnId / refNumber / customerName / customerListId (server-side EntityFilter) / fromDate / toDate / maxReturned / paginate / iteratorID`. Paginate auto-defaults MaxReturned=500.
  - `qb_statement_charge_create` — `StatementChargeAddRq`. Required: `customerName | customerListId` AND `itemName | itemListId` AND either explicit `amount` OR both `quantity + rate`. Optional `txnDate / dueDate / refNumber / description / className`. Standard idempotencyKey + read-only gate. Customer.Balance moves by +Amount (= quantity × rate when not explicit).
  - `qb_statement_charge_update` — `StatementChargeModRq`. Pass `txnId + editSequence` plus any header field. Changing `quantity` OR `rate` without `amount` re-derives `Amount = newQuantity × newRate` via the new "delete-then-recompute" block in handleMod. Explicit `amount` mod wins over qty change. Customer re-target reverses old amount against old customer, applies new to new. Stale editSequence → 3170.
  - `qb_statement_charge_delete` — `TxnDelRq` with TxnDelType=StatementCharge. Reverses Customer.Balance by -Amount.

- **Structural notes — StatementCharge is unique in this server:**
  - **Single-row at the txn header** — no `*LineAdd` array. ItemRef / Quantity / Rate / Amount live directly on the transaction body. The simulation's `convertLinesAddToRet` pass is a no-op for StatementCharge (no key matches `/^(.+?)Line(s?)Add$/`).
  - `computeTotals` gets a dedicated branch: `Amount = Quantity * Rate` when `Amount === undefined` (mirrors the Check.Amount / Deposit.DepositTotal / SalesTaxPaymentCheck.TotalAmount "set when undefined" pattern; explicit Amount on create wins).
  - `handleMod` gets a separate "delete-then-recompute" block that fires when `modData.Amount === undefined && (modData.Quantity !== undefined || modData.Rate !== undefined)` — deletes `updated.Amount` then re-runs computeTotals so the new Qty × Rate sticks.
  - **`adjustPartyBalanceForTxn` + `adjustPartyBalanceForTxnMod` amountField union extended** to include `"Amount"` (was `"BalanceRemaining" | "AmountDue" | "TotalAmount"`). Strict improvement — any future header-Amount transaction type uses the same helpers.

- **Infrastructure changes (in sync across 4 lists per CLAUDE.md canonical-invariant rule):**
  - `buildDeleteRequest`'s isTransaction in [src/qbxml/builder.ts](src/qbxml/builder.ts)
  - `deleteEntity`'s isTransaction in [src/session/manager.ts](src/session/manager.ts)
  - `isTransactionType` in [src/session/simulation-store.ts](src/session/simulation-store.ts)
  - CLAUDE.md doc list at line 58
  - **NOT** in `BANK_AFFECTING_TXN_TYPES` — AR-posting, not bank. No ClearedStatus default; doesn't participate in `qb_uncleared_transactions` or `qb_reconciliation_discrepancy`.
  - 1 new parser arrayElement: `StatementChargeRet` only (no `*LineRet`).

- **Sim handler dispatch (in [src/session/simulation-store.ts](src/session/simulation-store.ts)):**
  - `handleAdd` post-persist branch after CreditMemo: `adjustPartyBalanceForTxn(finalEntity, "Customer", "Amount", +1)`.
  - `handleTxnDel` post-store-lookup branch after InventoryAdjustment: `adjustPartyBalanceForTxn(target, "Customer", "Amount", -1)`.
  - `handleMod` flow: captures `oldPartyAmount = existing.Amount` BEFORE merge (mirrors Invoice BalanceRemaining capture); after merge + optional Amount re-derive, calls `adjustPartyBalanceForTxnMod("Customer", "CustomerRef", "Amount", existing, updated, oldPartyAmount)` for same-customer delta or full reverse-then-apply on customer re-target.

- **Sim seed: deliberately omitted** (matches #80 precedent — bare `qb_statement_charge_list` returns count=0 against fresh sim; tests build state via `session.addEntity`). Reason: any seeded StatementCharge would change Customer.Balance from the pinned 15000 / 8500 / 3200 values that existing tests (engagement-profitability, customer-balance-detail, ar-aging, trial-balance-export) lock onto. Avoiding the disturbance is the same tradeoff #80 made for InventoryAdjustment.

- **No batch tool in this cut.** Operator confirmed: single-charge create is the primary workflow; bulk month-end billing pattern uses N independent create calls. The #43-style atomic batch (qb_journal_entry_batch_create / qb_invoice_batch_create / qb_sales_receipt_batch_create) can be added if operator pain emerges — the infrastructure (executeBatchAdd / multi-request envelope plumbing) is in place.

- **Limitation documented loudly in README + tool description:** `ReceivePayment.AppliedToTxnAdd` doesn't walk the StatementCharge store yet — `validateTxnApplications` in [src/session/simulation-store.ts](src/session/simulation-store.ts) looks up only the Invoice store. Payments referencing a StatementCharge TxnID will reject with "Invoice not found". Workaround today: customer pays a statement charge via an unapplied `qb_payment_receive` (the customer's open AR drops by TotalAmount but the underlying StatementCharge.Amount field stays unchanged in sim). Real QB closes statement charges via ReceivePayment just like invoices; future work extends `applyTxnApplications` to fan across both stores.

- **Intentional omissions from the tool surface:** `BillingDate` (operator confirmed — rarely shifted; QB uses TxnDate as fallback), `Taxable`, `SalesTaxCodeRef`, `OverrideItemAccountRef`, `Other1`, `Other2`. Keeps the first-cut API surface minimal; extend if a real workflow needs them.

- **39 new tests in [tests/statement-charges.test.ts](tests/statement-charges.test.ts) across 7 layers** — all green. Coverage:
  - sim handleAdd (6 — Amount = Qty*Rate derive, explicit Amount override, Amount-only persistence, +Amount AR posting, CustomerRef by ListID, orphan-CustomerRef silent no-op)
  - sim handleTxnDel (2 — -Amount reversal, unknown TxnID 500 with no state mutation)
  - sim handleMod (6 — Quantity-only re-derive + balance delta, Rate-only re-derive, explicit Amount wins over qty change, header-only mod preserves Amount, customer re-target reverses-and-applies, stale EditSequence 3170)
  - `qb_statement_charge_list` (7 — empty fresh sim, post-create surface, txnId / customerName / refNumber / date filters, paginate auto-default MaxReturned=500)
  - `qb_statement_charge_create` (7 — happy path qty*rate, explicit amount override, missing customerRef / itemRef / amount-source 3120 errors, idempotencyKey replay (verifies AR posted ONCE not twice) + 9002 conflict, read-only 9001)
  - `qb_statement_charge_update` (7 — header-only mod, qty re-derive, explicit amount wins, customer re-target balance reconcile, stale editSequence 3170, unknown TxnID 500, read-only 9001)
  - `qb_statement_charge_delete` (3 — happy path with balance reversal, unknown TxnID 500, read-only 9001)

- **README sync done.** Tool count 137 → 141 in both spots (`## Tools (141 total)` header + architecture diagram `(141 tools)` inset). New `### Statement Charges` section between Inventory Adjustments and Journal Entries explains the single-row-at-header structure, the qty*rate vs explicit-amount derivation, AR posting rules, the customer re-target reverse-then-apply policy, and the ReceivePayment limitation.

- **[src/index.ts](src/index.ts) got:** import + register call + new Capabilities bullet ("Statement charges (single-line AR billing without an invoice)") + new `qb_statement_charge_*` instructions block entry above inventory adjustments + extension of the idempotency-keyed-tools enumeration with `qb_statement_charge_create`.

- **Tool count enumeration:** re-counted via `Grep -c "server\.tool\(" src/tools` → **141 distinct `server.tool` calls across 30 files**. Matches the README header.

## Verify Before Continuing

Re-run if the tree has been touched (skip if next session starts within hours):

- [ ] `npm run build` → exit 0 (tsc clean).
- [ ] `npm test` → `Test Files 51 passed | Tests 1275 passed`.
- [ ] `"" | & node dist/index.js` → exit 0, `Mode: simulation` printed.
- [ ] **(Windows + QB) #81 first live exercise.** Connect to `VR Tax & Consulting Inc..qbw` (or any company file with at least one active service item and at least one active customer). Walk the statement-charge cycle:
  1. `qb_item_list({ itemType: "Service" })` — find an active service item; capture its `FullName` and `ListID`.
  2. `qb_customer_list({})` — find an active customer; capture its `Balance` and `FullName`.
  3. `qb_statement_charge_create({ customerName: "<customer>", itemName: "<service item>", quantity: 2, rate: 50, refNumber: "SC-TEST-001", description: "Live test charge" })` — confirm `success: true`, `statementCharge.Amount === 100`, and that `qb_customer_list` shows the customer's `Balance` increased by 100.
  4. `qb_statement_charge_list({ customerName: "<customer>" })` — confirm the new charge surfaces with `Amount: 100`.
  5. `qb_statement_charge_update({ txnId: "<TxnID>", editSequence: "<editSeq>", quantity: 4 })` — confirm `statementCharge.Amount === 200` (re-derived from new qty × original rate) and the customer's `Balance` increased by another 100 (delta from 100 → 200).
  6. `qb_statement_charge_delete({ txnId: "<TxnID>" })` — confirm `Balance` reverts to its original pre-test value.
  - **If a schema-order class of bug surfaces (statusCode -1 from QBXMLRP2)** on `StatementChargeAddRq` / `StatementChargeQueryRq` / `StatementChargeModRq`, capture envelope via `QB_DEBUG_QBXML=1` and pin canonical child order in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts) the way #37 did for `GeneralSummaryReportQueryRq`. The JS key insertion order in the tool layer (per qbxmlops130 schema) is `CustomerRef → TxnDate → RefNumber → DueDate → ItemRef → Desc → Quantity → Rate → ClassRef → Amount`.
  - **Try a fixed-fee charge** (`{ customerName: "...", itemName: "...", amount: 250 }` with no quantity/rate) to validate the Amount-without-qty/rate branch on real QB. Some live SDK versions may reject this and require Quantity=1 + Rate=Amount; if so, surface the error at the tool layer.
- [ ] **(Windows + QB) Carried — #80 inventory adjustments first live exercise** against `VR Tax & Consulting Inc..qbw`. (Connect → `qb_item_list({itemType:"Inventory"})` → adjust qty/value → list with includeLineItems → delete; see prior handoff section in todo.md #80 for exact steps.)
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

**Operator picks next.** With #81 closed, remaining Phase 17 + Phase 13–14 work:

- **#79 vehicle mileage** (Phase 17) — `qb_vehicle_mileage_add` / `_list` / `qb_vehicle_list`. `VehicleMileageAddRq` / `VehicleMileageQueryRq` / `VehicleQueryRq`. Tax-practice staple (Schedule C / Form 4562 mileage logs). Last remaining Phase 17 item.
- **Phase 13–14 coverage gaps** — DataExt (#61), sub-customer (#62), memo search (#63), dry-run (#64), better errors (#65), audit log (#66 — Enterprise-only).
- **#72 generic `qb_transaction_list`** (Phase 16) — composite fanout across the 6 customer-side txn types ("show me everything for customer X in March" → 1 call instead of 6).
- **Follow-up — StatementCharge in ReceivePayment.AppliedToTxn:** extend `validateTxnApplications` + `applyTxnApplications` in [src/session/simulation-store.ts](src/session/simulation-store.ts) to walk both Invoice AND StatementCharge stores when resolving an AppliedToTxn TxnID. Currently a `qb_payment_receive` with `appliedTo: [{txnId: "<statementChargeTxnId>"}]` rejects with "Invoice not found". Low-priority — operators can pay via an unapplied receive-payment in the meantime, but real QB closes statement charges through ReceivePayment exactly like invoices.

## Context Notes

- **Authoritative tool count is 141** (re-enumerated via `Grep -c "server\.tool\(" src/tools` → 141 distinct calls across 30 files). README + architecture diagram both reflect 141. Don't blindly increment from a HANDOFF figure — re-grep before bumping.

- **#81 StatementCharge is the only single-row-at-header transaction type in this server.** Every other transaction (Invoice, Bill, Estimate, SalesReceipt, CreditMemo, PurchaseOrder, JournalEntry, Deposit, Check, Transfer, BillPaymentCheck, BillPaymentCreditCard, SalesOrder, CreditCardCharge, CreditCardCredit, SalesTaxPaymentCheck, InventoryAdjustment) carries a `*LineAdd` array — even single-line transactions like Check or Deposit go through `convertLinesAddToRet`. StatementCharge breaks the pattern: ItemRef / Quantity / Rate / Amount live directly on the txn body. `convertLinesAddToRet` is a no-op for it; `computeTotals` has a dedicated branch to derive Amount at header level. Future maintainers extending sim handlers: don't grep for "*LineRet" patterns to find StatementCharge — it isn't there.

- **#81 `adjustPartyBalanceForTxn` + `adjustPartyBalanceForTxnMod` amountField union now includes `"Amount"`.** Strict improvement — was `"BalanceRemaining" | "AmountDue" | "TotalAmount"`, now plus `"Amount"`. Any future header-Amount transaction type can use these helpers without further widening. If you add `"Amount"` to more transaction types, no API change needed.

- **#81 customer re-target on update reverses-then-applies the full Amount.** Same convention as Invoice (`adjustPartyBalanceForTxnMod` with sign=+1). Same-customer mods move balance by the delta (`newAmount − oldAmount`); customer changes trigger full reverse-then-apply. Tests pin both paths.

- **#81 BillingDate / Taxable / SalesTaxCodeRef / OverrideItemAccountRef / Other1 / Other2 intentionally NOT exposed** on the tool surface. Per operator confirmation during scope-setting: BillingDate operators rarely shift (defaults to TxnDate on real QB); tax fields and override-account live in a deferred sales-tax integration; Other1/Other2 are vestigial fields rarely used. Extend if a real workflow surfaces the need.

- **#81 ReceivePayment limitation.** `validateTxnApplications` in [src/session/simulation-store.ts](src/session/simulation-store.ts) hardcodes `this.getStore("Invoice")` — payments referencing a StatementCharge TxnID will reject. Future fix: walk both stores (or any AR-posting transaction store). Two-line change at the validation site plus per-line lookup adjustment in `applyTxnApplications`. Operator can pay statement charges today via unapplied receive-payment (customer's open AR drops by TotalAmount; statement charge's Amount stays unchanged — matches the operator's request that "this is enough for first cut").

- **#81 four-list sync caught for the third consecutive transaction type** (`InventoryAdjustment` (#80) → `SalesTaxPaymentCheck` (#77) → `TimeTracking` (#78) → now `StatementCharge` (#81)). The rule is: any new transaction type updates four locations — `isTransaction` in [src/qbxml/builder.ts](src/qbxml/builder.ts), `isTransaction` in [src/session/manager.ts](src/session/manager.ts), `isTransactionType` in [src/session/simulation-store.ts](src/session/simulation-store.ts), AND the CLAUDE.md doc list at line 58. Tests catch divergence (TxnDel routing breaks if any list is out of sync) — but the CLAUDE.md doc list has no test coverage; it drifts silently. Future PRs adding a new transaction type: grep for the latest `"StatementCharge"` insertion to find all four sites at once.

- **#81 NO seed deliberate omission.** Bare `qb_statement_charge_list` returns count=0 against fresh sim. Avoids disturbing Customer.Balance fixtures (Acme=15000 / Global=8500 / TechStart=3200) that engagement-profitability, customer-balance-detail, ar-aging, and trial-balance-export tests lock onto. Matches the #80 InventoryAdjustment precedent. If a future workflow needs richer fresh-sim StatementCharge experience, the operator creates them via `qb_statement_charge_create` at session start.

- **Carried gotchas (unchanged from prior handoffs — all still apply):**
  - **#80 InventoryAdjustment is the first transaction type that mutates ItemInventory state.** No prior transaction touches QuantityOnHand / AverageCost / QuantityOnHandValue.
  - **#80 two-phase commit invariant** — `applyInventoryAdjustment` validates every line BEFORE mutating any items. Tests pin this.
  - **#80 NO `_update` tool** — `InventoryAdjustmentModRq` exists but operational pattern is delete + recreate.
  - **#80 GL posting to AccountRef NOT modeled** in sim's first cut. Same deferred class as #43 JE-line customer-balance bookkeeping.
  - **#80 SalesReceipt / SalesOrder seed lines reference Widget A** — `tests/sales-by-customer.test.ts:126` and `tests/sales-by-item.test.ts:124`. Seed bump doesn't change Widget A's identity.
  - **#80 AverageCost preserved at zero qty** — pinned test.
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
  - **#75 `computeTotals` Check.Amount / Deposit.DepositTotal** — "set when undefined, preserve explicit overrides". #76 (SalesOrder.TotalAmount) inverts: always derives. #77 (SalesTaxPaymentCheck.TotalAmount) follows the same set-when-undefined pattern. #80 (InventoryAdjustment.TotalAmount) ALWAYS overrides. **#81 (StatementCharge.Amount) follows the "set when undefined, preserve override" pattern** — explicit Amount on create wins; on update the dedicated "delete-then-recompute" block lets a Qty- or Rate-only mod re-derive.
  - **#75 Sim does NOT move `Bank.Account.Balance`** on Deposit/Transfer/Check.
  - **#67 default path is zero wire I/O.** Probe is opt-in.
  - **#68 RECON_TOLERANCE = 0.01.**
  - **#69 "Mapped" definition** — TaxLineName non-empty.
  - **#85 SDK gap is permanent** — `qb_closing_date_set` always 9005 + UI navigation.
  - **Synthetic statusCodes**: 9001 read-only, 9002 idempotency conflict, 9003 edition unsupported, 9004 payroll subscription required, 9005 SDK has no write path.
  - **#86 prompts registration** uses `reg<Args>(entry)` helper + `as const` tuple.
  - **Four lists must stay in sync** across builder / manager / simulation-store + CLAUDE.md doc list (caught for #77, #78, #80, now #81 in a row).
  - **AR-side `Customer.Balance` discount math is correct; AP-side is NOT** — future `qb_bill_write_off` needs the parallel fix.
  - **Dispatch order in `processRequest`**: non-entity-typed `*QueryRq` / `*ModRq` / `AttachableAddRq` MUST precede the `endsWith` catch-alls.
  - **Iterator wire names diverge**: `iterator`/`iteratorID` on request, `iteratorRemainingCount`/`iteratorID` on response.
  - **fast-xml-parser does NOT decode numeric character entities** — use `decodeXmlEntities`.
  - **fast-xml-parser DOES coerce numeric-looking text to numbers** — `<CheckNumber>1001</CheckNumber>` → `1001` (number), not `"1001"`.
  - **Live verification requires `C:\nvm4w\nodejs\node.exe` v20.20.2** (system PATH v22 breaks winax).
  - **QBXMLRP2 cannot OPEN a `.qbw`**, only attach to one QB Desktop has already loaded.
  - **BillPayment* total is on `TotalAmount`**, not `Amount` — coalesce `TotalAmount ?? Amount`.
