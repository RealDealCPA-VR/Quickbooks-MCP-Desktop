# Handoff State

_Last updated: 2026-05-14. **#69 `qb_tax_line_mapping` CLOSED.** New tool exposes Account.TaxLineInfoRet — direct bridge from QB chart of accounts to a tax-prep workpaper. Paired with sim-seed update (8 of 10 accounts now carry TaxLineInfoRet so qb_trial_balance_export's `taxLine` column populates in sim too) + a strict-improvement AccountType filter in handleQuery. Tool count 107 → 108; 921 → 949 tests green._

## Last Session Summary

- **#69 `qb_tax_line_mapping` — CLOSED.** New tool registered in [src/tools/reports.ts](src/tools/reports.ts) right after `qb_trial_balance_export`. Pure read-side composite over `session.queryEntity("Account", filters)` — no new wire types, no manager method, no parser changes (`AccountQueryRq` + `AccountRet` were already covered by the existing infrastructure). Args: `accountListId?` / `accountName?` / `accountType?` / `includeInactive?` (default false) / `includeUnmapped?` (default false). Returns `{ count, mappedCount, unmappedCount, accounts: [{accountListId, accountName, accountNumber, accountType, isActive, taxLineId, taxLineName, isUnmapped}] }`.

- **Pure helper `buildTaxLineMapping(accounts, options)` exported from [src/tools/reports.ts](src/tools/reports.ts).** Handles the projection + sort + mapped/unmapped split. Tool wrapper is pure I/O orchestration. **"Mapped" definition:** `TaxLineInfoRet.TaxLineName` is a non-empty string. An account with `TaxLineID` alone (no name) is `isUnmapped: true` (the name is the workpaper-readable label every consumer keys on) but `taxLineId` is still preserved on the row as an audit signal. **Sort:** canonical TB_ACCOUNT_TYPES order → AccountNumber (lex compare since AccountNumber is a string in QB) → alphabetical FullName; numbered accounts sort before unnumbered within type; unknown AccountTypes sort last alphabetically.

- **Sim seed update — 8 of 10 accounts now carry TaxLineInfoRet.** [src/session/simulation-store.ts](src/session/simulation-store.ts) `seedData()` — Checking / Accounts Receivable / Accounts Payable / Sales Revenue / Cost of Goods Sold / Rent Expense / Utilities / Payroll Expense each got `TaxLineInfoRet: { TaxLineID, TaxLineName }` using QB Desktop's standard naming (B/S-Assets / B/S-Liabs/Eq. / Income / COGS / Deductions). **Savings + Consulting Revenue intentionally left UNMAPPED** so the `includeUnmapped` filter has something to exercise against fresh seed. **Adjacent strict-improvement effect:** `qb_trial_balance_export`'s `taxLine` column now surfaces non-null values for the seeded mapped accounts in sim (was always null pre-#69 because the seed didn't carry `TaxLineInfoRet`); pinned in the new tax-line-mapping integration test.

- **Sim handleQuery — `AccountType` filter now applied (strict improvement).** Pre-#69, `handleQuery` silently ignored `AccountType` on AccountQueryRq → `qb_account_list({accountType: "Income"})` returned every account in sim. New filter slot in [src/session/simulation-store.ts](src/session/simulation-store.ts:387-394) applies `AccountType` exactly the same way the live wire path does. No existing tests passed AccountType to handleQuery, so nothing breaks; every existing caller that already passed AccountType through (qb_account_list) now behaves correctly in sim.

- **Tests.** 28 new tests in [tests/tax-line-mapping.test.ts](tests/tax-line-mapping.test.ts) across 4 layers: (1) `buildTaxLineMapping` unit — 12 covering default-mapped-only, includeUnmapped:true, taxLineId/taxLineName surfacing, TaxLineID-only treated as unmapped, empty-name treated as unmapped, count math, mapped/unmapped split, canonical sort with numbered-before-unnumbered + unknown-AccountType-last, IsActive preservation, empty input, missing FullName/Name skip; (2) e2e via QBSessionManager — 8 covering 8-mapped/2-unmapped seed shape, includeUnmapped:true full count, Checking row carries seeded TaxLineInfoRet end-to-end, AccountType filter scopes the wire query, Income scope mapped vs includeUnmapped, ListID + FullName scopes, sort order against fresh seed; (3) tool surface via fake McpServer harness — 7 covering canonical envelope, includeUnmapped split, accountType filter, accountListId scope, accountName scope, empty-result-as-success, error wrapping with humanReadable; (4) integration with #68 — 1 pinning that `qb_trial_balance_export` now surfaces `taxLine` from sim seed.

- **Docs.** [README.md](README.md) tool count 107 → 108, architecture diagram 107 → 108, new row in Reports & Queries table right after `qb_trial_balance_export`, stale "empty in sim" note on the trial-balance row updated. [src/index.ts](src/index.ts) instructions block: reports category line gained `qb_tax_line_mapping`, plus a sentence on the bridge-to-tax-prep purpose; trial-balance taxLine note updated. [todo.md](todo.md) #69 flipped to `[x]` with full closeout notes.

## Verify Before Continuing

Re-run if the tree has been touched (skip if next session starts within hours):

- [ ] `npm run build` → exit 0 (tsc clean).
- [ ] `npm test` → `Test Files 41 passed | Tests 949 passed`.
- [ ] `"" | & node dist/index.js` → exit 0, `Mode: simulation` printed; banner does NOT print "QBXML debug log: enabled" when `QB_DEBUG_QBXML` is unset.
- [ ] **(Windows + QB) First live exercise of `qb_tax_line_mapping`.** Call `qb_tax_line_mapping({})` against `VR Tax & Consulting Inc..qbw`. Confirm: `count > 0` (the chart should have tax-line assignments on most income/expense accounts after years of tax-prep work); first row's `accountType === "Bank"` (canonical sort puts Bank first); each row's `taxLineName` matches what QB Desktop shows in the chart (Edit → Edit Account → Tax-Line Mapping). Then call `qb_tax_line_mapping({ includeUnmapped: true })` — `unmappedCount` is itself a workpaper-prep audit signal (every income/expense account SHOULD be mapped before filing). Then call `qb_tax_line_mapping({ accountType: "Income", includeUnmapped: true })` — surfaces the income-side mapping subset most relevant to the 1120-S K-1 walk for VR Tax. Cross-check against `qb_trial_balance_export({})` — every TB row should have a `taxLine` matching the corresponding `qb_tax_line_mapping` row's `taxLineName` (both read from the same Account.TaxLineInfoRet path).
- [ ] **(Windows + QB) Carried — Phase 15 #68 first-live exercises** (from prior session, still pending). Full `qb_trial_balance_export` walk against `VR Tax & Consulting Inc..qbw` last completed FY (2024-12-31), Accrual basis. Confirm rows.length > 0, Bank first, totalDebits === totalCredits to the cent, all four crossChecks reconcile (real reconciled book should tie cleanly), `taxLine` populated for most accounts (now also exercises #69). Run with `includeLastActivityDate: true` and confirm dates populate. Run `/trial_balance_workup` from Claude Desktop with same params.
- [ ] **(Windows + QB) Carried — Phase 18 #85 / #86 first-live exercises** (from prior sessions). `qb_closing_date_get` wire shape; `qb_closing_date_set` returns 9005 with UI navigation; all five MCP prompts surface in Claude Desktop's `/` picker.
- [ ] **(Windows + QB) Carried — `qb_session_status` first-live exercise** (from prior session). `qb_session_status({})`, `{probe: true}`, `{includeClosingDate: true}` against `VR Tax & Consulting Inc..qbw`; confirm zero wire I/O on the default + fail-soft probe/closingDate.
- [ ] **(Windows + QB) Carried — #84 transient-retry path, #82 host_query field surface, #55 W-2 wire shape, #59 attachment enablement, #54 SCF section labels.** All verified-by-construction structurally but not live-pinned. Lowest priority; details preserved in git history.

## Next Task

**Operator picks next.** With #69 closed, the highest-leverage remaining items (in roughly descending operator-value order):

- **#75 banking primitives** (Phase 17) — would unblock real bank reconciliation workflows. Currently the read-side reconciliation tools (`qb_cleared_status_update`, `qb_uncleared_transactions`, `qb_reconciliation_discrepancy`) are present but the create-side primitives (Deposit, Transfer, Check directly to a bank account) are not. Pairs with the `/month_end_close` prompt — that prompt assumes the operator can create missing entries during reconciliation.

- **#71 `qb_client_packet(customerListId, taxYear)`** (Phase 15) — bundles TB (now ready via #68!) + GL (#53) + bank rec discrepancy (#56) + payroll summary (#55) + fixed asset detail. The workflow run 2,000 times per tax season. Composite that calls existing tools — most of the prerequisites are now in place. Now that #69 is closed, the TB component carries `taxLine` for the workpaper grouping step too. Cheap composite to ship.

- **#78 time tracking** (Phase 17) — unblocks #70 (`qb_engagement_profitability`) which can't compute hours-per-job without `TimeTrackingQueryRq`.

- **#70 `qb_engagement_profitability(customerListId, dateRange)`** (Phase 15) — pulls revenue + time + reimbursable expenses for a job. Closer to ClosePilot's surface than the raw aging report. Requires #78 (time tracking) as prerequisite.

- **#76 sales orders / #77 sales tax / #80 inventory adjustments / #81 statement charges** — domain coverage gaps from Phase 17.

- **Phase 13–14 coverage gaps** — custom fields / DataExt (#61), sub-customer hierarchy (#62), memo full-text search (#63), dry-run mode (#64), better error surfaces (#65), audit log (#66 — Enterprise-only).

## Context Notes

- **#69 "Mapped" definition is load-bearing.** A row is mapped when `TaxLineInfoRet.TaxLineName` is a non-empty string. `TaxLineID` alone (no name) → unmapped. Empty-string `TaxLineName` → unmapped. The `taxLineId` field is still preserved on every row regardless (when present in the source) — useful audit signal for an account assigned to a custom or stale TaxLineID code that QB couldn't resolve to a name.

- **#69 sim seed deliberately leaves Savings + Consulting Revenue UNMAPPED.** This gives `includeUnmapped:true` something to exercise against fresh seed. If you ever rework the seed to map every account, update [tests/tax-line-mapping.test.ts](tests/tax-line-mapping.test.ts) layer-2 tests in lockstep — they pin `mappedCount: 8` and `unmappedCount: 2` against fresh seed.

- **#69 sim handleQuery now applies `AccountType` filter (was silently ignored pre-#69).** Strict improvement. Every caller that already passed AccountType through (`qb_account_list({accountType: "Income"})`, `qb_general_ledger({accountType: "Expense"})`) now behaves correctly in sim instead of returning every account. No existing tests broke because none of them passed AccountType. If you add new sim-mode tests against `qb_account_list` with an accountType filter, they'll now correctly scope.

- **#69 sim seed taxLine names follow QB Desktop's actual naming convention** (B/S-Assets / B/S-Liabs/Eq. / Income / COGS / Deductions) but the specific TaxLineID enum values (28, 29, 38, 50, 51, 52, 100, 101) are representative, NOT literal copies of QB's internal enum. They're stable enough for sim testing — operators reading sim output should recognize the format. If a future test depends on a specific TaxLineID, pin the value directly in the seed comment.

- **#69 NonPosting accounts are NOT excluded by default in `qb_tax_line_mapping`** (unlike `qb_trial_balance_export` which excludes them by TB convention). NonPosting accounts (estimates, POs, sales orders) generally don't have tax-line assignments in QB anyway — the typical case is they just don't surface (since `includeUnmapped: false`). But if real QB has a NonPosting account with a tax-line assignment for some reason, it WILL surface; pass an explicit `accountType` filter to scope.

- **#69 integration with #68:** `qb_trial_balance_export`'s `taxLine` column now populates from sim seed (was always null pre-#69). The TB tool reads from the same `Account.TaxLineInfoRet.TaxLineName` path that `qb_tax_line_mapping` reads from — they're projection-aligned. The integration test at the bottom of [tests/tax-line-mapping.test.ts](tests/tax-line-mapping.test.ts) pins this. The unit-level TB test at [tests/trial-balance-export.test.ts](tests/trial-balance-export.test.ts:155-161) was unaffected (uses its own fixture accounts, not the seed).

- **Carried gotchas (unchanged from prior handoffs):**
  - **#67 default path is zero wire I/O — load-bearing for orchestration retry loops.** Don't add a wire call to the default path. Use `probe: true` for active probing.
  - **#67 fail-soft on `probe` / `includeClosingDate`** — failures land INSIDE the response, not as `isError`.
  - **#68 `RECON_TOLERANCE = 0.01`** is the bookkeeping standard. Tighter false-fires on rounding; looser hides real subledger drift.
  - **#68 sim seed has deliberate AR/AP drift** — pinned by e2e tests asserting the cross-check FIRES (not that the seed reconciles). If you ever fix the seed, update those tests in lockstep.
  - **#68 sim P&L walk is empty against fresh seed** — seed item lines don't resolve to income accounts; the existing `qb_pnl_report` has the same behavior. TB tests work around this by asserting against AP (the natural-credit account guaranteed present).
  - **#68 contra-balance column flip is load-bearing** — matches CPA workpaper convention.
  - **#68 `Account.AccountNumber` is a string** (`1000-1`, `1000.A` etc.) — sort uses `localeCompare`, not numeric.
  - **#85 SDK gap is permanent.** Do not speculatively wire a `PreferencesModRq` builder. Canonical response for any future preference write is 9005 + UI navigation.
  - **Synthetic statusCode reservations**: 9001 read-only, 9002 idempotency conflict, 9003 edition unsupported, 9004 payroll subscription required, 9005 SDK has no write path, 9006+ reserved.
  - **#86 prompts registration uses a `reg<Args>(entry)` helper + `as const` tuple** — load-bearing.
  - **Three transaction-type lists must stay in sync**: `buildDeleteRequest` in [src/qbxml/builder.ts](src/qbxml/builder.ts), inline `isTransaction` in `manager.deleteEntity` ([src/session/manager.ts](src/session/manager.ts)), `isTransactionType` in [src/session/simulation-store.ts](src/session/simulation-store.ts). Canonical 16-type set in [CLAUDE.md](CLAUDE.md).
  - **AR-side `Customer.Balance` discount math is correct; AP-side is NOT.** Future `qb_bill_write_off` needs the parallel fix.
  - **Dispatch order in `processRequest`**: non-entity-typed `*QueryRq` / `*ModRq` / `AttachableAddRq` branches MUST precede the `endsWith` catch-alls.
  - **Iterator wire names diverge**: `iterator`/`iteratorID` on request, `iteratorRemainingCount`/`iteratorID` on response.
  - **fast-xml-parser does NOT decode numeric character entities** — use `decodeXmlEntities` in [parser.ts](src/qbxml/parser.ts).
  - **Live verification requires `C:\nvm4w\nodejs\node.exe` v20.20.2** (system PATH v22 breaks winax).
  - **QBXMLRP2 cannot OPEN a `.qbw`**, only attach to one QB Desktop has already loaded.
  - **BillPayment* total is on `TotalAmount`**, not `Amount` — coalesce `TotalAmount ?? Amount`.
  - **Bill ItemLineAdd in test fixtures should pass explicit `Amount`** (or use Rate).
