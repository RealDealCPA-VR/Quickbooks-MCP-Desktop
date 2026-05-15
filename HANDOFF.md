# Handoff State

_Last updated: 2026-05-15. **Phase 17 #76 sales orders shipped.** 5 new tools in fresh [src/tools/sales-orders.ts](src/tools/sales-orders.ts) — `qb_sales_order_list` / `_create` / `_update` / `_delete` / `_convert_to_invoice`. Pure composite over existing generic add/mod/del/query primitives; no new wire types, no manager methods, no parser changes. The four sync points (builder `isTransaction` / manager `isTransaction` / sim-store `isTransactionType` / parser `arrayElements` for `SalesOrderRet` + `SalesOrderLineRet`) were already in place from prior work, so this was a tools-layer task only. Sim store gained two strict improvements: `computeTotals` SalesOrder branch (`TotalAmount = lineSum`, mirrors PurchaseOrder) + post-line-mod recompute allow-list extension. One seeded SalesOrder (`S0000001-SO` against Acme, $3,500 two-line) for fresh-sim list/convert exercise. 35 new tests across 6 layers — all green. Tool count 124 → 129; 1116 → 1151 tests green. README sync done: new `### Sales Orders` section between Purchase Orders and Journal Entries, architecture diagram inset bumped in both spots. Build + test + simulation banner clean._

## Last Session Summary

- **#76 sales orders — DONE.** 5 tools shipped. Pattern mirrors `estimates.ts` (closest convert-to-invoice analog) + `purchase-orders.ts` (closest IsManuallyClosed analog) + `deposits.ts` (latest CRUD with paginate + idempotency).
  - `qb_sales_order_list` — customer / txnId / refNumber / date filters; paginate auto-defaults maxReturned to 500; includeLineItems opt-in (Phase 10 #41 strips by default).
  - `qb_sales_order_create` — customer + lines (Rate-based, mirrors invoice/estimate) + optional dueDate / poNumber / isManuallyClosed / memo + idempotency.
  - `qb_sales_order_update` — txnId + editSequence + header fields + replacement lines (wholesale) + IsManuallyClosed flip.
  - `qb_sales_order_delete` — TxnDelRq; pure record removal (non-posting, no customer-balance reversal).
  - `qb_sales_order_convert_to_invoice` — read source with `IncludeLineItems:true` → InvoiceAdd with CustomerRef + carried lines + optional ClassRef/TermsRef/SalesRepRef/PONumber header refs → mark source `IsManuallyClosed: true` (default; pass `markClosed:false` for partial conversions). Idempotent replay skips the mark-closed flip (original call already ran it; re-running would fail with 3170).

- **Sim improvements (strict, paired with #76):**
  - [src/session/simulation-store.ts](src/session/simulation-store.ts) `computeTotals` now derives `SalesOrder.TotalAmount = sum(SalesOrderLineRet.Amount)` — mirrors PurchaseOrder (non-posting, no Subtotal/SalesTaxTotal split in sim's first cut).
  - `handleMod`'s post-line-mod recompute allow-list now includes SalesOrder so partial line edits re-derive TotalAmount correctly.
  - One SalesOrder seed (`S0000001-SO` / Acme / two lines / $3,500 / `IsManuallyClosed: false`) added to `seedData()` for parity with deposits/checks/transfers/time-tracking seeds.

- **35 new tests in [tests/sales-orders.test.ts](tests/sales-orders.test.ts) across 6 layers.** Coverage: sim TotalAmount derivation + non-posting invariant on Acme `Balance`; list filter matrix; create happy paths + customer-ref validation + idempotency (replay + 9002 conflict) + read-only 9001; update header-only + line replacement + IsManuallyClosed flip + stale editSequence 3170 + unknown TxnID 500 + 9001; delete happy + 500 + 9001; convert-to-invoice happy (lines map + source marks closed + customer AR moves by BalanceRemaining) + override-wins + `markClosed:false` leaves SO open + unknown source + source-without-CustomerRef defensive guard + idempotency replay skips mark-closed flip + 9002 cross-source conflict + 9001.

- **README sync done.** Tool count `124 → 129` in both spots (`## Tools (129 total)` header + architecture diagram `(129 tools)` inset). New `### Sales Orders` section between Purchase Orders and Journal Entries — explains the customer-side analog framing, the Estimate-vs-SalesOrder distinction (quotes vs committed-but-not-fulfilled), the convert-to-invoice contract, plus a 5-row tool table.

- **src/index.ts** got the import + register call + a new bullet under the Transactions section of the instructions block (mirrors the existing purchase-order line) + extension of the idempotency-keyed-tools enumeration with `qb_sales_order_create, qb_sales_order_convert_to_invoice` + a new line in the top-of-file Capabilities comment.

- **Tool count enumeration:** re-counted via `Grep -p "server\.tool\(" src/tools` → 129 distinct `server.tool` calls across 27 files. Matches the README header.

## Verify Before Continuing

Re-run if the tree has been touched (skip if next session starts within hours):

- [ ] `npm run build` → exit 0 (tsc clean).
- [ ] `npm test` → `Test Files 48 passed | Tests 1151 passed`.
- [ ] `"" | & node dist/index.js` → exit 0, `Mode: simulation` printed.
- [ ] **(Windows + QB) #76 first live exercise.** Connect to `VR Tax & Consulting Inc..qbw`. Run through the full SO lifecycle against an active customer:
  1. `qb_sales_order_create({ customerName: "<active client>", refNumber: "TEST-SO-001", lines: [{ itemName: "<seeded service item>", quantity: 5, rate: 100 }, { itemName: "<another service>", quantity: 1, rate: 250 }] })` — confirm `success: true`, `salesOrder.TotalAmount === 750`, two `SalesOrderLineRet` rows present with TxnLineIDs.
  2. `qb_sales_order_list({ customerName: "<active client>", includeLineItems: true })` — confirm the new SO surfaces with the lines intact.
  3. `qb_sales_order_update({ txnId, editSequence, memo: "live-test updated", isManuallyClosed: false })` — confirm IsManuallyClosed stays false; capture new editSequence.
  4. `qb_sales_order_convert_to_invoice({ salesOrderTxnId: <txnId>, markClosed: false })` — confirm `success: true`, `salesOrderMarkedClosed: false`, new invoice carries the same two lines + the SO's RefNumber. Verify the SO remains open via a follow-up list call (partial-conversion path).
  5. `qb_sales_order_convert_to_invoice({ salesOrderTxnId: <txnId> })` — confirm the second invoice posts AND `salesOrderMarkedClosed: true`. (Real QB allows multiple invoices against one SO; whether the operator wants this in their workflow is separate.)
  6. `qb_sales_order_delete({ txnId })` — confirm `success: true`. Invoices spawned against the SO should NOT be touched (per the tool description).
  - **If a schema-order class of bug surfaces (statusCode -1 from QBXMLRP2)**, capture envelope via `QB_DEBUG_QBXML=1` and pin canonical child order in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts) the way #37 did for `GeneralSummaryReportQueryRq`. The JS key insertion order in the tool layer is CustomerRef → TxnDate → RefNumber → DueDate → PONumber → IsManuallyClosed → Memo → SalesOrderLineAdd (matches estimate / PO emit patterns which are already live-validated).
- [ ] **(Windows + QB) Carried — #70 `qb_engagement_profitability` first live exercise** against `VR Tax & Consulting Inc..qbw`. Six different `*QueryRq` wire types layered.
- [ ] **(Windows + QB) Carried — #78 time tracking first live exercise.** TimeTrackingAddRq canonical child order: `TxnDate → EntityRef → CustomerRef → ItemServiceRef → Duration → ClassRef → PayrollItemWageRef → Notes → IsBillable → BillableStatus`.
- [ ] **(Windows + QB) Carried — #71 `qb_client_packet` first live exercise.** Six different `*QueryRq` wire types.
- [ ] **(Windows + QB) Carried — #75 banking primitives first live exercise.** `qb_deposit_create` / `qb_check_create` / `qb_transfer_create` + list / delete companions.
- [ ] **(Windows + QB) Carried — #69 `qb_tax_line_mapping` + #68 `qb_trial_balance_export` first live exercises** against `VR Tax & Consulting Inc..qbw`.
- [ ] **(Windows + QB) Carried — Phase 18 #85 / #86 first live exercises** of `qb_closing_date_get` / `qb_closing_date_set` (9005 + UI navigation) / all five MCP prompts in Claude Desktop's `/` picker.
- [ ] **(Windows + QB) Carried — `qb_session_status` first live exercise** (zero wire I/O default + fail-soft probe/closingDate).
- [ ] **(Windows + QB) Carried — #84 transient-retry path, #82 host_query field surface, #55 W-2 wire shape, #59 attachment enablement, #54 SCF section labels.** Lowest priority.

## Next Task

**Operator picks next.** With #76 closed the highest-leverage remaining items in roughly descending operator-value order:

- **#77 sales tax** (Phase 17) — `qb_sales_tax_liability_report` / `qb_sales_tax_payment_create` / `qb_sales_tax_code_list` / `qb_sales_tax_item_list` / `qb_sales_tax_agency_list`. Monthly necessity for any client with taxable sales.
- **#80 inventory adjustments** (Phase 17) — `qb_inventory_adjustment_add` / `_list`. `InventoryAdjustmentAddRq` / `InventoryAdjustmentQueryRq`.
- **#81 statement charges** (Phase 17) — `qb_statement_charge_add` / `_list` / `_update` / `_delete`. Service-business time-and-materials billing without a formal invoice.
- **#79 vehicle mileage** (Phase 17) — `qb_vehicle_mileage_add` / `_list` / `qb_vehicle_list`. Tax-practice staple (Schedule C / Form 4562).
- **Phase 13–14 coverage gaps** — DataExt (#61), sub-customer (#62), memo search (#63), dry-run (#64), better errors (#65), audit log (#66 — Enterprise-only).

## Context Notes

- **Authoritative tool count is 129** (re-enumerated via `Grep -p "server\.tool\(" src/tools` → 129 distinct calls across 27 files). README + architecture diagram both reflect 129. Don't blindly increment from a HANDOFF figure — re-grep before bumping.

- **#76 was infrastructure-already-wired.** The SalesOrder type was in `isTransactionType` ([src/session/simulation-store.ts](src/session/simulation-store.ts):4489), the parallel `isTransaction` array in [src/qbxml/builder.ts](src/qbxml/builder.ts):529 and [src/session/manager.ts](src/session/manager.ts):1445, plus `SalesOrderRet` / `SalesOrderLineRet` registered in parser `arrayElements` ([src/qbxml/parser.ts](src/qbxml/parser.ts):71-72) — all from prior work. Only the tools layer + a `computeTotals` branch + a `handleMod` recompute allow-list entry + one seed were missing. **The three transaction-type lists must stay in sync** across builder.ts / manager.ts / simulation-store.ts; CLAUDE.md calls this out as the canonical invariant.

- **README structure landed:** Sales Orders section sits between Purchase Orders and Journal Entries. Architecture diagram (the ASCII box) inset bumped 124 → 129 in two places. Future-tool category sections should mirror this pattern: framing paragraphs (often calling out distinctions from sibling types — Estimate vs SalesOrder, Bill vs Check, etc.), then a `| Tool | Description |` table.

- **The convert-to-invoice idempotency pattern is now a 2x example.** Both `qb_estimate_convert_to_invoice` and `qb_sales_order_convert_to_invoice` skip the source-mark flip on idempotent replay — the original call already ran it (or was told not to), and re-running would fail with statusCode 3170 because the source's EditSequence is now stale. Future convert-style composites (e.g. a possible PO → Bill / Receive Inventory flow) should follow the same skip-on-replay contract. Pinned in [tests/sales-orders.test.ts](tests/sales-orders.test.ts) "idempotency replay returns the original invoice WITHOUT re-attempting the markClosed flip".

- **Sales-side `Rate` vs purchase-side `Cost`** — keep these straight. Sales (Invoice / Estimate / SalesReceipt / CreditMemo / SalesOrder) use `Rate` per unit on lines. Purchase (PO) uses `Cost`. The element name matters at the wire layer; QB will reject `<Rate>` on a `PurchaseOrderLineAdd` and `<Cost>` on a `SalesOrderLineAdd`. Both compute Amount = qty × per-unit-price internally.

- **`IsManuallyClosed` is the SalesOrder analog of Estimate's `IsAccepted`.** Both are write fields on the header that signal "this committed thing is now done from the originating-document's POV" — flip true after a successful convert-to-invoice; expose on Add + Mod; PO has the same flag with the same semantics on the AP side. Real QB also tracks derived `IsFullyInvoiced` flags (header + per-line) that derive from line-level invoicing state; this server's first cut doesn't model that derivation — invoices and sales orders aren't linked at the line-ID level. If a future task needs accurate `IsFullyInvoiced` tracking, that would be the place to start.

- **Carried gotchas (unchanged from prior handoffs — all still apply):**
  - **#76 SalesOrder is non-posting** — `Customer.Balance` does NOT move on SO add or delete. The customer balance only moves when an invoice is created against the order (via convert or a manual `qb_invoice_create`).
  - **#76 convert idempotency skip-on-replay** — same pattern as estimate convert. The first call posts the invoice + flips IsManuallyClosed. Replay returns the cached invoice without re-attempting the flip (source's EditSequence is stale, would 3170).
  - **#70 `IncludeLineItems: true` is LOAD-BEARING** for any tool that walks line-level data on Bill/Check/CreditCardCharge/SalesOrder. Both sim ([src/session/simulation-store.ts](src/session/simulation-store.ts) `handleQuery` ~line 425) and real QB strip `*LineRet` from query responses without it. #76's convert tool reads SalesOrderLineRet via `IncludeLineItems: true` per the comment at the call site.
  - **#70 customer scope on time is POST-FILTERED.** QB's `TimeTrackingQueryRq` has NO `CustomerFilter` at any qbxml version.
  - **#70 customer scope on Bill/Check/CCC is LINE-LEVEL.** Bills carry `VendorRef` on the header (whom you paid), not `CustomerRef` (which job it was for).
  - **#70 summary OMITTED when any section is error or any toggle off.** Partial profitability silently misreports gross profit. Caller MUST branch on `sectionStatus`.
  - **#70 customer lookup is the one non-fail-soft path.**
  - **#70 first cross-tool consumer of `parseDurationToHours`** from [src/tools/time-tracking.ts](src/tools/time-tracking.ts).
  - **#70 `customerRefMatches` accepts EITHER ListID OR FullName match.**
  - **#78 EntityFilter priority reorder** — `handleQuery` does `EntityRef ?? CustomerRef ?? VendorRef ?? PayeeEntityRef`.
  - **#78 Duration is ISO 8601 PT-H-M-S only.**
  - **#78 IsBillable + BillableStatus co-emission.**
  - **#71 fail-soft contract** — `sections.<name>` is either the success payload OR an `{ error: {...} }` block; `sectionStatus.<name>` is `'ok' | 'skipped' | 'error'`.
  - **#71 payroll has THREE skip states** — Pro → 9003, wire-zero → 9004, probe-fail → error.
  - **#71 GL defaults to PnLOnly scope** for cost reasons.
  - **#71 customerListId / customerName is OPTIONAL CONTEXT, NOT A FILTER.** #70 INVERTS this — customer IS the engagement.
  - **#71 AccountQueryRq failure is the only non-fail-soft path** for #71; #70's parallel is CustomerQueryRq failure.
  - **#75 EntityFilter strict improvement** — `handleQuery` matches `PayeeEntityRef` for Check / BillPaymentCheck / BillPaymentCreditCard / CreditCardCharge / CreditCardCredit.
  - **#75 `computeTotals` Check.Amount / Deposit.DepositTotal** — "set when undefined, preserve explicit overrides". #76 follows the SAME pattern for SalesOrder.TotalAmount (always derives, since SO has no caller-side explicit-total path that matters).
  - **#75 Sim does NOT move `Bank.Account.Balance`** on Deposit/Transfer/Check.
  - **#67 default path is zero wire I/O.** Probe is opt-in.
  - **#68 RECON_TOLERANCE = 0.01.** AR/AP drift in sim seed is deliberate.
  - **#69 "Mapped" definition** — TaxLineName non-empty. TaxLineID alone is unmapped.
  - **#85 SDK gap is permanent** — `qb_closing_date_set` always 9005 + UI navigation.
  - **Synthetic statusCodes**: 9001 read-only, 9002 idempotency conflict, 9003 edition unsupported, 9004 payroll subscription required, 9005 SDK has no write path.
  - **#86 prompts registration** uses `reg<Args>(entry)` helper + `as const` tuple.
  - **Three transaction-type lists must stay in sync** across builder / manager / simulation-store. #78 added TimeTracking to all three; #76 did NOT need to (SalesOrder was already in all three from prior work).
  - **AR-side `Customer.Balance` discount math is correct; AP-side is NOT** — future `qb_bill_write_off` needs the parallel fix.
  - **Dispatch order in `processRequest`**: non-entity-typed `*QueryRq` / `*ModRq` / `AttachableAddRq` MUST precede the `endsWith` catch-alls.
  - **Iterator wire names diverge**: `iterator`/`iteratorID` on request, `iteratorRemainingCount`/`iteratorID` on response.
  - **fast-xml-parser does NOT decode numeric character entities** — use `decodeXmlEntities`.
  - **fast-xml-parser DOES coerce numeric-looking text to numbers** — `<CheckNumber>1001</CheckNumber>` → `1001` (number), not `"1001"`.
  - **Live verification requires `C:\nvm4w\nodejs\node.exe` v20.20.2** (system PATH v22 breaks winax).
  - **QBXMLRP2 cannot OPEN a `.qbw`**, only attach to one QB Desktop has already loaded.
  - **BillPayment* total is on `TotalAmount`**, not `Amount` — coalesce `TotalAmount ?? Amount`.
