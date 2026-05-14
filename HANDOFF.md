# Handoff State

_Last updated: 2026-05-14. **#71 qb_client_packet CLOSED.** One new composite tool — `qb_client_packet(taxYear, customerListId?, customerName?, basis?, 5 section toggles, glScope?, bankReconDiscrepancySinceDate?)` — bundles Trial Balance + General Ledger + bank rec discrepancy + Payroll Summary (W-2 boxes) + Fixed Asset detail across one tax year. Pure composite over existing session primitives; no new wire types, no parser changes, no manager methods. Fail-soft per section (the `qb_session_status` contract). Tool count 120 → 121; 1014 → 1037 tests green._

## Last Session Summary

- **#71 qb_client_packet — CLOSED.** New tool file [src/tools/client-packet.ts](src/tools/client-packet.ts) registered in [src/index.ts](src/index.ts) via `registerClientPacketTools`. The workflow a CPA fires at the start of every tax return now collapses from 5-7 separate tool invocations (TB / GL / bank rec fanout / W-2 / fixed asset detail) into one call returning a single structured JSON packet.

- **Why the scope was a single file:** every prerequisite was already shipped. The tool reuses `buildTrialBalance` + `buildGeneralLedgerSection` directly from [src/tools/reports.ts](src/tools/reports.ts) (both already exported). Bank-rec row formatting + W-2 box mapping are inlined (12 lines + 18 lines respectively) rather than extracted from reconciliation.ts / reports.ts — small enough to duplicate, and decoupling the composite from the surface shape of two other tools is worth the duplication. Composing on existing tool _handlers_ was not an option (those return `{ content: [...] }` shapes and have their own error wrappers); composing on _session primitives_ (`queryEntity` / `queryTransactions` / `runReport` / `runCustomDetailReport` / `runPayrollSummaryReport` / `getHostInfo`) is the correct boundary.

- **API:** `taxYear` required (no default — partial-year client packets aren't supported, the workpaper model is annual). Optional context: `customerListId` / `customerName` (lookup surfaces FullName + Balance as a packet header; does NOT filter underlying reports — the .qbw file IS the client). Optional control: `basis` (Accrual default), five section toggles (`includeTrialBalance` / `includeGeneralLedger` / `includeBankReconDiscrepancy` / `includePayrollSummary` / `includeFixedAssetDetail`, all default true), `glScope: 'PnLOnly' | 'AllAccounts'` (default `PnLOnly` — Income/Expense/COGS/OtherIncome/OtherExpense; the typical tax-prep ask), `bankReconDiscrepancySinceDate` (default = start of taxYear).

- **Fail-soft per section** (same contract `qb_session_status` already established). A single section's failure lands in `sections.<name>.error` with `sectionStatus.<name>` flipping to `'error'`; the rest of the packet still returns. Only `AccountQueryRq` (the shared chart-of-accounts pre-fetch) failing fails the whole tool. **Payroll has three skip states:**
  1. Edition probe → Pro → `skipped(9003)` (no payroll surface on stock Pro)
  2. Wire returns zero rows → `skipped(9004)` (subscription likely inactive OR no employees with YTD activity in the tax year)
  3. Probe itself fails → `error` block (HostQueryRq couldn't even run — distinct from the gates above)

- **Bank rec discrepancy fans out across every Bank + CreditCard account** on the file. Per-account `runCustomDetailReport` failures land INSIDE that account's entry (not as warnings), so siblings stay clean — the operator sees exactly which accounts failed without losing the successful ones.

- **Fixed Asset Detail is a new surface** — no existing tool exposes it. Pulls every active `FixedAsset` account, fans out `queryTransactions` for the tax-year window, returns per-account current `Balance` + `openingBalance` / `closingBalance` / `periodChange` + every posting in the window (Form 4562 input). Empty `accounts` array against fresh seed is NOT an error condition (typical service businesses have no fixed assets); the section status stays `'ok'`.

- **Tests:** 23 new tests in [tests/client-packet.test.ts](tests/client-packet.test.ts). Coverage layers: (1) registration; (2) full default packet shape — top-level fields, every `sectionStatus` value in {ok, skipped, error}, TB rowCount + cross-checks, GL scope + accountCount, recon perAccount fanout, payroll W-2 box mapping (SSN masked to last 4), FA empty-on-fresh-seed + populated after seeding a FixedAsset account + a Check posting to it; (3) `glScope: 'AllAccounts'` vs default PnLOnly; (4) `bankReconDiscrepancySinceDate` override flow; (5) `taxYear: 2020` (no YTD seed) triggers payroll skipped(9004); (6) section toggles — TB-only-off, all-off (every status flipped to `'skipped'`, no payloads), `includePayrollSummary: false` skips probe entirely; (7) customer context — listId lookup, name lookup, unknown-customer warning + customer:null; (8) fail-soft contract — monkey-patched `runPayrollSummaryReport` failure (only payroll section flips to error), monkey-patched `queryEntity("Account")` failure (whole tool fails with `pre-flight failed:` prefix), monkey-patched per-account `runCustomDetailReport` failure (one account's entry has error, sibling stays clean); (9) Pro edition gate (`skipped(9003)`); (10) basis Cash pass-through to TB/GL section payloads.

- **Docs:** [src/index.ts](src/index.ts) instructions block extended with the `qb_client_packet` category line right before `qb_company_open`. [todo.md](todo.md) #71 flipped to `[x]` with full closeout notes. **README NOT YET TOUCHED** — the README's tool count + architecture diagram still say 120 (was bumped to 120 at #75 closeout); the operator might want to bump to 121 + add a `## Workpaper Composites` mini-section at next quiet moment. Low priority; the tool is fully discoverable via `tools/list`.

## Verify Before Continuing

Re-run if the tree has been touched (skip if next session starts within hours):

- [ ] `npm run build` → exit 0 (tsc clean).
- [ ] `npm test` → `Test Files 45 passed | Tests 1037 passed`.
- [ ] `"" | & node dist/index.js` → exit 0, `Mode: simulation` printed; banner does NOT print "QBXML debug log: enabled" when `QB_DEBUG_QBXML` is unset.
- [ ] **(Windows + QB) First live exercise of #71.** Connect to `VR Tax & Consulting Inc..qbw`. Run `qb_client_packet({ taxYear: 2024 })` (or last completed FY) and confirm: (1) `success: true`; (2) `sectionStatus` shows `'ok'` for `trialBalance` / `generalLedger` / `bankReconciliationDiscrepancy` / `fixedAssetDetail`, and either `'ok'` or `'skipped'` (9004) for `payrollSummary` depending on subscription state; (3) `sections.trialBalance.rows.length > 0` and the four cross-checks land in `sections.trialBalance.crossChecks`; (4) `sections.generalLedger.scope === 'PnLOnly'` and accountCount matches the file's active P&L accounts; (5) `sections.bankReconciliationDiscrepancy.perAccount` has one entry per Bank + CreditCard account; (6) `sections.fixedAssetDetail.accounts` populated if the chart has Fixed Asset accounts (and `accountCount: 0` cleanly if not). Then run `qb_client_packet({ taxYear: 2024, customerListId: '<a real customer>' })` and confirm the `customer: { listId, fullName, balance? }` header surfaces. **If any underlying *QueryRq rejects with statusCode -1 ("error when parsing the provided XML text stream"), it's the schema-order class of bug** — capture the envelope via `QB_DEBUG_QBXML=1` (writes `./logs/qbxml-YYYYMMDD.log`), compare child order against QB's `<xs:sequence>` for the offending request, and pin the canonical order in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts) the way #37 did for `GeneralSummaryReportQueryRq`. The composite layers SIX different *QueryRq wire types (Account, Invoice, Bill, Customer, BalanceSheetStandard report, ProfitAndLossStandard report, CustomTxnDetail report, PayrollSummary report, TransactionQueryRq) so any schema-order bug from any of them surfaces here.
- [ ] **(Windows + QB) Carried — #75 banking primitives first live exercise.** Walk through one of each: `qb_deposit_create({ depositToAccountName: "Checking", lines: [{ entityName: "<existing customer>", accountName: "Sales Revenue", amount: 250 }] })` — confirm response carries `DepositTotal: 250` + `ClearedStatus: "NotCleared"`; `qb_check_create({ accountName: "Checking", payeeName: "<existing vendor>", expenseLines: [{ accountName: "Office Expenses", amount: 50 }] })` — confirm `Amount: 50` + `ClearedStatus: "NotCleared"`; `qb_transfer_create({ fromAccountName: "Checking", toAccountName: "Savings", amount: 1000 })` — confirm `TransferFromAccountRef` / `TransferToAccountRef` round-trip cleanly. Then `qb_deposit_list({})` / `qb_check_list({})` / `qb_transfer_list({})` — each should return the freshly-created entity. Cleanup: `qb_deposit_delete` / `qb_check_delete` / `qb_transfer_delete` the test entities before disconnecting.
- [ ] **(Windows + QB) Carried — Phase 15 #69 first live exercise** of `qb_tax_line_mapping` against `VR Tax & Consulting Inc..qbw`. Confirms `Account.TaxLineInfoRet` surfaces cleanly, cross-checks against `qb_trial_balance_export({})` taxLine column. (Note: #71 also surfaces TaxLineName via its TB section — pin both at the same time.)
- [ ] **(Windows + QB) Carried — Phase 15 #68 first live exercises** of `qb_trial_balance_export` against last completed FY (2024-12-31), Accrual basis. Confirm rows.length > 0, totalDebits === totalCredits, all four crossChecks reconcile. (Note: #71 reuses the same `buildTrialBalance` helper, so #68 and #71 share verification.)
- [ ] **(Windows + QB) Carried — Phase 18 #85 / #86 first live exercises** (still pending). `qb_closing_date_get` wire shape; `qb_closing_date_set` returns 9005 with UI navigation; all five MCP prompts surface in Claude Desktop's `/` picker.
- [ ] **(Windows + QB) Carried — `qb_session_status` first live exercise** (still pending). Zero wire I/O on the default + fail-soft probe/closingDate.
- [ ] **(Windows + QB) Carried — #84 transient-retry path, #82 host_query field surface, #55 W-2 wire shape, #59 attachment enablement, #54 SCF section labels.** All verified-by-construction structurally but not live-pinned. Lowest priority.

## Next Task

**Operator picks next.** With #71 closed, the highest-leverage remaining items in roughly descending operator-value order:

- **#78 time tracking** (Phase 17) — `qb_time_track_add` / `_list`. `TimeTrackingAddRq` / `TimeTrackingQueryRq`. Unblocks #70 (`qb_engagement_profitability`) which can't compute hours-per-job without it. Also blocks any service-business billing-by-time workflow. New wire types — heavier than #75 / #71 but still bounded.

- **#70 `qb_engagement_profitability(customerListId, dateRange)`** (Phase 15) — pulls revenue + time + reimbursable expenses for a job. Needs #78 (time tracking) first. Once #78 lands this is the natural pair — same composite shape as #71 (multi-section packet over session primitives).

- **#76 sales orders** (Phase 17) — `qb_sales_order_create` / `_list` / `_update` / `_delete` / `_convert_to_invoice`. Same shape as #75 — pure composite over existing primitives. Sales orders are tracked in `isTransactionType` already.

- **#77 sales tax / #80 inventory adjustments / #81 statement charges** (Phase 17) — remaining domain coverage gaps.

- **Phase 13–14 coverage gaps** — DataExt (#61), sub-customer (#62), memo search (#63), dry-run (#64), better errors (#65), audit log (#66 — Enterprise-only).

- **README sync** (low priority cleanup) — bump tool count 120 → 121, add a `## Workpaper Composites` section documenting `qb_client_packet` next to existing report tools. Architecture diagram unchanged (no new layers).

## Context Notes

- **#71 fail-soft contract is load-bearing.** `sections.<name>` is either the success payload OR an `{ error: { statusCode, statusMessage, humanReadable? } }` block; `sectionStatus.<name>` is `'ok' | 'skipped' | 'error'`. Tests pin both shapes against monkey-patched session methods. Orchestrators relying on the packet should branch on `sectionStatus` before parsing the nested shape — that's the documented contract.

- **#71 payroll has THREE distinct skip states** — not just one: edition-Pro → 9003, wire-returns-zero → 9004, probe-itself-failed → error block. Tests pin all three. The `includePayrollSummary: false` toggle is a FOURTH path (no payload at all; status stays `'skipped'`). Future tests adding payroll-section assertions should pick the right state to mock.

- **#71 GL defaults to `PnLOnly` scope** for cost reasons — `AllAccounts` fans out across every GL-eligible account (~50-100 in a typical small business; N round trips in live mode). Tax-prep workflows mostly want P&L accounts anyway. The `scope` field is on the response so downstream consumers know which set was returned.

- **#71 `customerListId` / `customerName` is OPTIONAL CONTEXT, NOT A FILTER.** When supplied, the customer is looked up and surfaced as a packet header for labeling purposes. The underlying TB / GL / bank rec / payroll / FA sections are WHOLE-FILE (the .qbw IS the client). Future tests that pass a customer arg expecting it to scope the underlying reports are wrong — the report contents are identical with or without the arg.

- **#71 AccountQueryRq failure is the only non-fail-soft path.** Without the chart of accounts no section can build. If the operator ever wants this to be fail-soft too (e.g. partial packet from cached accounts) that's a future refactor; today it returns `success: false` + `isError: true` with `pre-flight failed:` prefix.

- **#71 fixed asset detail empty array is NOT an error.** Service businesses typically have no FixedAsset accounts. Tests pin both states: empty against fresh seed (status stays `'ok'`) and populated after seeding a FixedAsset + a Check posting to it.

- **#71 bank rec per-account error pattern is unique.** Errors land INSIDE the `perAccount[i].error` block; the section's overall status stays `'ok'` as long as the high-level loop succeeded. Mirrors how `qb_general_ledger` handles per-account fetch failures (warnings array) but the per-account-error-inside-the-entry pattern is new and worth knowing — it lets operators see exactly which bank account failed without parsing a warnings array.

- **Carried gotchas (unchanged from prior handoffs):**
  - **#75 EntityFilter strict improvement** — `handleQuery` matches `PayeeEntityRef` in addition to `CustomerRef`/`VendorRef` for Check / BillPaymentCheck / BillPaymentCreditCard / CreditCardCharge / CreditCardCredit.
  - **#75 `computeTotals` Check.Amount / Deposit.DepositTotal** — "set when undefined, preserve explicit overrides"; on line mod, header field deleted before re-derive (Bill's `AmountDue` pattern).
  - **#75 Transfer self-transfer guard is tool-layer-only** (statusCode 3120). Raw `session.addEntity("Transfer", ...)` bypasses it.
  - **#75 Sim does NOT move `Bank.Account.Balance`** on Deposit/Transfer/Check (matches existing AR/AP precedent — line walks pick up activity, snapshots stay static).
  - **#67 default path is zero wire I/O** — don't add wire calls to the default path. Use `probe: true` for active probing.
  - **#67 fail-soft on `probe` / `includeClosingDate`** — failures land INSIDE the response, not as `isError`. (Same pattern #71 adopted per-section.)
  - **#68 `RECON_TOLERANCE = 0.01`** is the bookkeeping standard.
  - **#68 sim seed has deliberate AR/AP drift** — pinned by e2e tests asserting the cross-check FIRES (not that the seed reconciles).
  - **#68 contra-balance column flip is load-bearing** — matches CPA workpaper convention.
  - **#68 `Account.AccountNumber` is a string** (`1000-1`, `1000.A` etc.) — sort uses `localeCompare`, not numeric.
  - **#69 "Mapped" definition** — `TaxLineInfoRet.TaxLineName` non-empty. `TaxLineID` alone → unmapped row, but `taxLineId` preserved as audit signal.
  - **#69 sim seed leaves Savings + Consulting Revenue UNMAPPED** — tests pin `mappedCount: 8` / `unmappedCount: 2`.
  - **#85 SDK gap is permanent** — `qb_closing_date_set` always returns 9005 + UI navigation. Do not speculatively wire a `PreferencesModRq` builder.
  - **Synthetic statusCodes**: 9001 read-only, 9002 idempotency conflict, 9003 edition unsupported, 9004 payroll subscription required, 9005 SDK has no write path, 9006+ reserved.
  - **#86 prompts registration uses a `reg<Args>(entry)` helper + `as const` tuple** — load-bearing.
  - **Three transaction-type lists must stay in sync**: `buildDeleteRequest` in [src/qbxml/builder.ts](src/qbxml/builder.ts), inline `isTransaction` in `manager.deleteEntity` ([src/session/manager.ts](src/session/manager.ts)), `isTransactionType` in [src/session/simulation-store.ts](src/session/simulation-store.ts). Canonical 16-type set in [CLAUDE.md](CLAUDE.md).
  - **AR-side `Customer.Balance` discount math is correct; AP-side is NOT.** Future `qb_bill_write_off` needs the parallel fix.
  - **Dispatch order in `processRequest`**: non-entity-typed `*QueryRq` / `*ModRq` / `AttachableAddRq` branches MUST precede the `endsWith` catch-alls.
  - **Iterator wire names diverge**: `iterator`/`iteratorID` on request, `iteratorRemainingCount`/`iteratorID` on response.
  - **fast-xml-parser does NOT decode numeric character entities** — use `decodeXmlEntities` in [parser.ts](src/qbxml/parser.ts).
  - **fast-xml-parser DOES coerce numeric-looking text to numbers** — `<CheckNumber>1001</CheckNumber>` parses back as `1001` (number), not `"1001"` (string). If a test sends a numeric-string field into the sim and reads it back, wrap the assertion in `String(...)`.
  - **Live verification requires `C:\nvm4w\nodejs\node.exe` v20.20.2** (system PATH v22 breaks winax).
  - **QBXMLRP2 cannot OPEN a `.qbw`**, only attach to one QB Desktop has already loaded.
  - **BillPayment* total is on `TotalAmount`**, not `Amount` — coalesce `TotalAmount ?? Amount`.
  - **Bill ItemLineAdd in test fixtures should pass explicit `Amount`** (or use Rate).
