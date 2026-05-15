# Handoff State

_Last updated: 2026-05-15. **Phase 17 #77 sales tax shipped.** 5 new tools in fresh [src/tools/sales-tax.ts](src/tools/sales-tax.ts) — `qb_sales_tax_code_list` / `qb_sales_tax_item_list` / `qb_sales_tax_agency_list` / `qb_sales_tax_liability_report` / `qb_sales_tax_payment_create`. Pure composites over existing primitives + one new sim handler branch (`SalesTaxLiability` in `handleReportQuery`). 5 new parser arrayElements (`SalesTaxCodeRet`, `ItemSalesTaxRet`, `ItemSalesTaxGroupRet`, `SalesTaxPaymentCheckRet`, `SalesTaxPaymentCheckLineRet`). `SalesTaxPaymentCheck` added to all three transaction-type lists (builder.ts / manager.ts / simulation-store.ts) + `BANK_AFFECTING_TXN_TYPES`. Seed data: 2 agencies (IL DoR, CA SBoE — flagged `IsSalesTaxAgency: true`), 3 ItemSalesTax (7.5% IL + 7.25% / 2.25% CA), 1 ItemSalesTaxGroup (CA-LA Combined), 3 SalesTaxCodes (TAX/NON/OUT), 1 taxed SalesReceipt against TechStart for fresh-sim liability exercise (dated 2025-01-15 deliberately — sidesteps the 2024-windowed engagement-profitability tests + 2025-12 customer-balance-detail tests; cash-sale receipt doesn't post to AR so it doesn't disturb AR-aging fixtures either). 42 new tests across 8 layers — all green. Tool count 129 → 134; 1151 → 1193 tests green. README sync done: new `### Sales Tax` section between Sales Orders and Journal Entries, architecture diagram inset bumped in both spots. Build + test + simulation banner clean._

## Last Session Summary

- **#77 sales tax — DONE.** 5 tools shipped:
  - `qb_sales_tax_code_list` — `SalesTaxCodeQueryRq`. Short flags (TAX/NON/OUT) stamped on customers + lines. Codes carry NO rate (just `IsTaxable`). Pattern mirrors `qb_class_list`.
  - `qb_sales_tax_item_list` — fans across `ItemSalesTaxQueryRq` + `ItemSalesTaxGroupQueryRq` by default; pass `taxItemType: 'Item' | 'Group'` to scope. Each row stamped with `ItemType` discriminator. Items expose `TaxRate` (decimal percent) + `TaxVendorRef` (the agency). Groups bundle items via `ItemSalesTaxRef` array. Pattern mirrors `qb_terms_list`'s StandardTerms + DateDrivenTerms fan-out.
  - `qb_sales_tax_agency_list` — composite that walks active ItemSalesTax records, extracts distinct `TaxVendorRef` values, optionally enriches each agency with a Vendor lookup (`includeVendorDetails: true` default; pass false to skip the N+1 round-trip cost). Returns per-agency `taxItems: [{name, listId, taxRate}]` rollup. Real QB has NO separate SalesTaxAgency entity — agencies ARE Vendors that happen to appear as TaxVendorRef.
  - `qb_sales_tax_liability_report` — wraps `GeneralSummaryReportQueryRq` with `GeneralSummaryReportType=SalesTaxLiability`. Returns `rows` (per tax item: agencyName / taxItemName / taxRate / taxCollected / taxPaid / taxPayable) + `byAgency` rollup + `totals` (grand). TaxCollected walks Invoice + SalesReceipt SalesTaxTotal scoped to header `ItemSalesTaxRef` (CreditMemo subtracts). TaxPaid walks SalesTaxPaymentCheckLineRet per item. Filters: fromDate / toDate / basis.
  - `qb_sales_tax_payment_create` — wraps `SalesTaxPaymentCheckAddRq`. DISTINCT from `qb_check_create` — lines reduce sales-tax-item liability via `ItemSalesTaxRef` references, NOT posting to expense/liability GL (a regular Check posted to a tax-liability account would double-count). Required: `bankAccountName/ListId`, `payeeName/ListId`, `lines: [{salesTaxItemName, amount}]` (at least one). `TotalAmount` derives from line sum. Bank-affecting (default `ClearedStatus: NotCleared`). Idempotency on create.

- **Infrastructure changes (in sync across builder.ts / manager.ts / simulation-store.ts):**
  - Three transaction-type lists extended with `SalesTaxPaymentCheck` per the CLAUDE.md canonical-invariant rule.
  - `BANK_AFFECTING_TXN_TYPES` extended with `SalesTaxPaymentCheck` (defaults to `ClearedStatus: NotCleared`, participates in `qb_uncleared_transactions`).
  - 5 new parser arrayElements: `SalesTaxCodeRet`, `ItemSalesTaxRet`, `ItemSalesTaxGroupRet`, `SalesTaxPaymentCheckRet`, `SalesTaxPaymentCheckLineRet` — single-hit responses surface as arrays uniformly.
  - `computeTotals` extended with `SalesTaxPaymentCheck` branch — `TotalAmount = sum(SalesTaxPaymentCheckLineRet.Amount)` when undefined. Explicit override wins (mirrors Check.Amount / Deposit.DepositTotal pattern from #75).
  - `handleReportQuery` extended with `SalesTaxLiability` branch + new private `buildSalesTaxLiabilityReport(from, to, basis)` helper. Emits custom shape (`Rows / ByAgency / Totals`) rather than the standard `Sections / Totals` envelope because liability rows carry multiple measures per row.

- **Seed data added in [src/session/simulation-store.ts](src/session/simulation-store.ts) `seedData()`:**
  - 2 sales-tax agency vendors: `IL Department of Revenue` (90000010), `CA State Board of Equalization` (90000011) — both flagged `IsSalesTaxAgency: true` for clarity (real QB derives this from being referenced in a TaxVendorRef; the flag is sim-clarity sugar).
  - 3 SalesTaxCodes: `TAX` (IsTaxable: true), `NON` (IsTaxable: false), `OUT` (IsTaxable: false — out-of-state exempt).
  - 3 ItemSalesTax: `IL State Tax` 7.5% → IL agency, `CA State Tax` 7.25% → CA agency, `CA County Tax` 2.25% → CA agency.
  - 1 ItemSalesTaxGroup: `CA-LA Combined` bundling the two CA items via `ItemSalesTaxRef` array.
  - 1 taxed SalesReceipt: `T0000001-SR`, TechStart, **dated 2025-01-15**, $1,000 Subtotal + $75 IL state tax @ 7.5% = $1,075 TotalAmount, `ItemSalesTaxRef: { FullName: "IL State Tax" }`.

- **SalesReceipt rather than Invoice for the seed** — deliberate. A cash-sale receipt does NOT post to AR, so adding it does not disturb existing customer-balance / AR-aging / trial-balance test fixtures (those pin specific values derived from the open-invoice set: e.g. `tests/trial-balance-export.test.ts:362` pins AR aging total = 16000; `tests/engagement-profitability.test.ts:577,587` pin TechStart having zero revenue in 2024). The liability-report walk handles SalesReceipt identically to Invoice (both contribute SalesTaxTotal when carrying an ItemSalesTaxRef). The 2025-01-15 date deliberately falls outside the 2024-windowed engagement-profitability tests + the 2025-12 customer-balance-detail tests so existing date-bounded fixtures still hold.

- **42 new tests in [tests/sales-tax.test.ts](tests/sales-tax.test.ts) across 8 layers** — all green. Coverage: sim seed loads (6 — codes/items/groups/agencies/receipt counts + non-posting invariant on TechStart Balance); SalesTaxLiability sim report walk (7 — happy path, CA-zero rows, date filter exclusion, per-agency rollup, grand totals reconciliation, CreditMemo subtraction, payment-reduces-payable); SalesTaxPaymentCheck handleAdd (4 — TotalAmount derivation, explicit-override-wins, NotCleared default, TxnDelRq routing proves three-list sync); `qb_sales_tax_code_list` (3 — happy + nameFilter + listId); `qb_sales_tax_item_list` (4 — default fanout, scope-to-Item, scope-to-Group, TaxRate+TaxVendorRef on rows); `qb_sales_tax_agency_list` (5 — distinct derivation, sorted per-agency taxItems, vendorDetails enrichment, opt-out, taxRate convenience); `qb_sales_tax_liability_report` (6 — happy + reportPeriod echo + date filter + byAgency + totals reconcile + payment-flow integration); `qb_sales_tax_payment_create` (7 — single + multi-line happy + missing-bank + missing-payee + idempotency replay + 9002 conflict + 9001 read-only).

- **README sync done.** Tool count 129 → 134 in both spots (`## Tools (134 total)` header + architecture diagram `(134 tools)` inset). New `### Sales Tax` section between Sales Orders and Journal Entries — explains the SalesTaxCode vs ItemSalesTax vs ItemSalesTaxGroup three-entity model, the agency derivation (Vendors via TaxVendorRef), the liability-report contract (TaxCollected − TaxPaid = TaxPayable), the payment-check vs regular-check distinction, plus a 5-row tool table.

- **src/index.ts** got: import + register call + new `qb_sales_tax_*` bullet in the instructions block (mirrors the deposit/check/transfer line shape from #75) + extension of the idempotency-keyed-tools enumeration with `qb_sales_tax_payment_create` + new line in the top-of-file Capabilities comment ("Sales tax workflows (codes, items, agencies, liability report, payment)").

- **Tool count enumeration:** re-counted via `Grep -p "server\.tool\(" src/tools` → 134 distinct `server.tool` calls across 28 files. Matches the README header.

## Verify Before Continuing

Re-run if the tree has been touched (skip if next session starts within hours):

- [ ] `npm run build` → exit 0 (tsc clean).
- [ ] `npm test` → `Test Files 49 passed | Tests 1193 passed`.
- [ ] `"" | & node dist/index.js` → exit 0, `Mode: simulation` printed.
- [ ] **(Windows + QB) #77 first live exercise.** Connect to `VR Tax & Consulting Inc..qbw`. Walk the sales-tax cycle:
  1. `qb_sales_tax_code_list({})` — confirm the operator's actual codes surface (TAX/NON/OUT are sim seeds; live will show whatever's in the company file).
  2. `qb_sales_tax_item_list({})` — confirm both items and groups surface with `ItemType` discriminator; rows carry `TaxRate` + `TaxVendorRef` (items) or `ItemSalesTaxRef` array (groups).
  3. `qb_sales_tax_agency_list({})` — confirm distinct agencies derived from item TaxVendorRefs; with `includeVendorDetails: true` each row carries the Vendor record.
  4. `qb_sales_tax_liability_report({ fromDate: "<period start>", toDate: "<period end>" })` — confirm per-item rows with TaxCollected / TaxPaid / TaxPayable + per-agency rollups + grand totals. **If the live report adapter returns a wire shape that doesn't fit the current `Rows / ByAgency / Totals` schema** (the GeneralSummaryReport row-tree translator was built for P&L / BS / SCF), capture envelope via `QB_DEBUG_QBXML=1` and extend the live adapter — same class of work as the #54 SCF section-label deferred verification.
  5. `qb_sales_tax_payment_create({ bankAccountName: "Checking", payeeName: "<agency>", lines: [{ salesTaxItemName: "<item>", amount: <owed> }] })` — confirm `success: true`, derived TotalAmount = line sum, NotCleared status, TxnID returned. Verify next `qb_sales_tax_liability_report` call shows TaxPaid bumped + TaxPayable reduced by the payment amount.
  - **If a schema-order class of bug surfaces (statusCode -1 from QBXMLRP2)** on `SalesTaxPaymentCheckAddRq`, capture envelope via `QB_DEBUG_QBXML=1` and pin canonical child order in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts) the way #37 did for `GeneralSummaryReportQueryRq`. The JS key insertion order in the tool layer is `BankAccountRef → TxnDate → RefNumber → PayeeEntityRef → IsToBePrinted → Memo → SalesTaxPaymentCheckLineAdd`. The line element name is `SalesTaxPaymentCheckLineAdd` (parsed back as `SalesTaxPaymentCheckLineRet`) — if real QB uses a different naming convention (`ItemSalesTaxPaymentCheckLine*`?) the parser arrayElement registration + builder/sim handler will need a flip.
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

**Operator picks next.** With #77 closed the highest-leverage remaining items in roughly descending operator-value order:

- **#80 inventory adjustments** (Phase 17) — `qb_inventory_adjustment_add` / `_list`. `InventoryAdjustmentAddRq` / `InventoryAdjustmentQueryRq`. For shrinkage, count corrections, write-offs of damaged stock.
- **#81 statement charges** (Phase 17) — `qb_statement_charge_add` / `_list` / `_update` / `_delete`. Service-business time-and-materials billing without a formal invoice.
- **#79 vehicle mileage** (Phase 17) — `qb_vehicle_mileage_add` / `_list` / `qb_vehicle_list`. Tax-practice staple (Schedule C / Form 4562).
- **Phase 13–14 coverage gaps** — DataExt (#61), sub-customer (#62), memo search (#63), dry-run (#64), better errors (#65), audit log (#66 — Enterprise-only).

## Context Notes

- **Authoritative tool count is 134** (re-enumerated via `Grep -p "server\.tool\(" src/tools` → 134 distinct calls across 28 files). README + architecture diagram both reflect 134. Don't blindly increment from a HANDOFF figure — re-grep before bumping.

- **#77 sales tax has the most parser arrayElements added in any single Phase 17 ticket** — 5 new tags. Each is needed because real QB returns one-or-many shapes for these elements and `fast-xml-parser` only auto-arrays when the tag is registered. The new tags are `SalesTaxCodeRet`, `ItemSalesTaxRet`, `ItemSalesTaxGroupRet`, `SalesTaxPaymentCheckRet`, `SalesTaxPaymentCheckLineRet`. Future sales-tax tools (mod, delete, list for SalesTaxPaymentCheck) won't need parser additions.

- **#77 SalesReceipt-rather-than-Invoice seed choice** — a cash-sale receipt was used for the taxed-txn seed (not an Invoice) because Invoice posts to AR and would have invalidated three existing test pins: `tests/trial-balance-export.test.ts:362` (AR aging = 16000), `tests/engagement-profitability.test.ts:577,587` (TechStart zero revenue in 2024). SalesReceipt is the right fixture — same SalesTaxTotal walk semantics for liability, zero AR impact. **Future sales-tax test additions should also prefer SalesReceipt over Invoice for the same reason.**

- **#77 SalesTaxLiability custom report shape** — emits `Rows / ByAgency / Totals` rather than the canonical `Sections / Totals` envelope every other GeneralSummaryReport uses. Reason: liability rows carry multiple measures per row (TaxCollected + TaxPaid + TaxPayable) — a single-measure `Sections.Accounts[].Total` shape can't represent that. Implication for live verification: the GeneralSummaryReport row-tree translator (`adaptLiveReportRet`) was built for P&L / BS / SCF — the SalesTaxLiability live wire shape may not fit and the adapter may need extension. **Same class of work as #54 SCF section labels.**

- **#77 sales-tax agencies are Vendors, not a separate entity** — real QB has no SalesTaxAgency entity. Agencies are derived from distinct `TaxVendorRef` values across active ItemSalesTax records. The seed flags two specific vendors with `IsSalesTaxAgency: true` for clarity but the derivation path does NOT depend on that flag (it walks `getStore("Vendor")` indirectly via `qb_sales_tax_agency_list`'s per-agency vendor lookup). Live behavior should match — if the operator's actual sales-tax agencies don't carry an explicit `IsSalesTaxAgency` flag in QB's schema, the derivation still works.

- **#77 SalesTaxPaymentCheck vs Check distinction is the critical mental model** — a regular `qb_check_create` posted to a sales-tax-liability account would DOUBLE-COUNT because real QB's payable account is debited automatically by the payment check. The tool descriptions make this explicit; the operator pattern is "always use `qb_sales_tax_payment_create` for sales-tax payments, never `qb_check_create`." Sim doesn't enforce this distinction (no liability-account double-count detection), but the documentation is explicit.

- **Convert-to-invoice idempotency pattern is now a 2x example** (from #76). Both `qb_estimate_convert_to_invoice` and `qb_sales_order_convert_to_invoice` skip the source-mark flip on idempotent replay. Future convert-style composites should follow the same skip-on-replay contract.

- **Carried gotchas (unchanged from prior handoffs — all still apply):**
  - **#77 SalesReceipt seed is dated 2025-01-15** deliberately — falls outside the 2024-windowed engagement-profitability tests + the 2025-12 customer-balance-detail tests. Any new seed addition that risks shifting a pinned customer balance / report total should use a similar out-of-window date OR use a transaction type with no AR/AP impact (SalesReceipt cash sales, JournalEntry without entity refs, etc.).
  - **#77 liability report is HEADER-level only** — per-line tax flagging is not modeled in sim. For the typical month-end "what do I owe each agency?" question this is sufficient.
  - **#76 SalesOrder is non-posting** — Customer.Balance does NOT move on SO add or delete.
  - **#76 convert idempotency skip-on-replay** — same pattern as estimate convert.
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
  - **#75 `computeTotals` Check.Amount / Deposit.DepositTotal** — "set when undefined, preserve explicit overrides". #76 (SalesOrder.TotalAmount) inverts: always derives. #77 (SalesTaxPaymentCheck.TotalAmount) follows the SAME pattern as Check.Amount — set when undefined, explicit override wins.
  - **#75 Sim does NOT move `Bank.Account.Balance`** on Deposit/Transfer/Check.
  - **#67 default path is zero wire I/O.** Probe is opt-in.
  - **#68 RECON_TOLERANCE = 0.01.**
  - **#69 "Mapped" definition** — TaxLineName non-empty.
  - **#85 SDK gap is permanent** — `qb_closing_date_set` always 9005 + UI navigation.
  - **Synthetic statusCodes**: 9001 read-only, 9002 idempotency conflict, 9003 edition unsupported, 9004 payroll subscription required, 9005 SDK has no write path.
  - **#86 prompts registration** uses `reg<Args>(entry)` helper + `as const` tuple.
  - **Three transaction-type lists must stay in sync** across builder / manager / simulation-store. #77 added `SalesTaxPaymentCheck` to all three.
  - **AR-side `Customer.Balance` discount math is correct; AP-side is NOT** — future `qb_bill_write_off` needs the parallel fix.
  - **Dispatch order in `processRequest`**: non-entity-typed `*QueryRq` / `*ModRq` / `AttachableAddRq` MUST precede the `endsWith` catch-alls.
  - **Iterator wire names diverge**: `iterator`/`iteratorID` on request, `iteratorRemainingCount`/`iteratorID` on response.
  - **fast-xml-parser does NOT decode numeric character entities** — use `decodeXmlEntities`.
  - **fast-xml-parser DOES coerce numeric-looking text to numbers** — `<CheckNumber>1001</CheckNumber>` → `1001` (number), not `"1001"`.
  - **Live verification requires `C:\nvm4w\nodejs\node.exe` v20.20.2** (system PATH v22 breaks winax).
  - **QBXMLRP2 cannot OPEN a `.qbw`**, only attach to one QB Desktop has already loaded.
  - **BillPayment* total is on `TotalAmount`**, not `Amount` — coalesce `TotalAmount ?? Amount`.
