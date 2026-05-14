# Handoff State

_Last updated: 2026-05-13. **#68 `qb_trial_balance_export` CLOSED.** New tool that bundles TB + four reconciliation cross-checks into one call — collapses the operator's `/trial_balance_workup` prompt from an 8-tool recipe to a single composite. Tool count 106 → 107; 895 → 921 tests green._

## Last Session Summary

- **#68 `qb_trial_balance_export` — CLOSED.** New tool in [src/tools/reports.ts](src/tools/reports.ts) right after `qb_balance_summary`. Returns a tax-season-workpaper-shaped TB — one row per posting account with non-zero balance, debits/credits split by **natural-balance side** (Asset/Expense → debit column; Liability/Equity/Income → credit column; **contra-balances flip column** rather than emit as a negative number — matches the workpaper convention CPAs expect). Sorted canonical AccountType → AccountNumber → name. Each row carries `accountListId` / `accountName` / `accountNumber` / `accountType` / `taxLine` (from `Account.TaxLineInfoRet.TaxLineName`) / `debitBalance` / `creditBalance` / `isActive` / `lastActivityDate`. Plus **four cross-checks** with cent-tolerance match boolean + computed delta: `balanceSheet` (Assets ≡ Liab+Equity), `netIncome` (BS NetIncome ≡ P&L NetIncome), `arReconciliation` (TB AR ≡ AR aging total), `apReconciliation` (TB AP ≡ AP aging total). Composite of 5 wire calls in default path (`AccountQueryRq` + `BalanceSheetStandard` + `ProfitAndLossStandard` + `InvoiceQueryRq` + `BillQueryRq`); `includeLastActivityDate: true` adds N more (per-account `TransactionQueryRq` to surface most-recent posting date). NonPosting accounts excluded by TB convention.

- **Pure helper `buildTrialBalance(accounts, bsRet, pnlRet, arAgingTotal, apAgingTotal, options)` exported from [src/tools/reports.ts](src/tools/reports.ts).** All sign-convention + sort + cross-check arithmetic lives in the helper — the tool wrapper is pure I/O orchestration. Synthetic BS rows (`Net Income`, `Balancing Adjustment (simulation seed gap)`) filtered out of per-row TB (they're captured in `bsRet.Totals.NetIncome` and would pollute the rows). Sort uses `localeCompare` on AccountNumber (it's a string in QB — `1000-1`, `1000.A` etc. — strict numeric compare would mis-sort).

- **Prompt rewrite: `/trial_balance_workup`** in [src/prompts/workflows.ts](src/prompts/workflows.ts) collapsed from the prior 8-tool recipe (qb_balance_summary + qb_account_list + qb_tax_line_mapping + qb_balance_sheet_report + qb_pnl_report + qb_ar_aging + qb_ap_aging + qb_transaction_list_by_account) to a single `qb_trial_balance_export({ includeLastActivityDate: true })` call. Drill-down tools (qb_transaction_list_by_account / qb_general_ledger / qb_customer_balance_detail / qb_vendor_balance_detail) stay referenced for when a cross-check fires. [tests/mcp-prompts.test.ts](tests/mcp-prompts.test.ts) `references the four cross-check tools` test updated to `calls the one-shot qb_trial_balance_export tool and names the drill-down tools` — asserts the new reference set.

- **Tests.** 26 new tests in [tests/trial-balance-export.test.ts](tests/trial-balance-export.test.ts) across 2 layers: (1) `buildTrialBalance` unit — 17 covering natural-balance side, contra-balance column-flip (negative AR → Credit column), NonPosting exclusion, zero/inactive filtering, BS synthetic row drop, TaxLine surface, canonical sort, totals balance, 4 cross-checks under reconciling AND broken scenarios, cent-tolerance threshold (0.005 reconciles; 0.02 doesn't), lastActivityDate map, empty BS/PnL edge; (2) e2e via QBSessionManager — 9 covering wire orchestration, Checking debit column ($45000 from seed), AP credit column ($3700 from seed — AP is the natural-credit account guaranteed to be present since the sim's P&L walk is empty against fresh seed), NonPosting exclusion, AR/AP drift surfacing (fresh seed has Account.Balance=26700 on AR but open invoices walk to 16000 — tool correctly surfaces the $10700 delta), balanceSheet reconcile via the seed's `Balancing Adjustment` closure, netIncome match (both 0 against empty P&L).

- **Docs.** [README.md](README.md) tool count 106 → 107, architecture diagram 106 → 107, new row in Reports & Queries table right after `qb_balance_summary`. [src/index.ts](src/index.ts) instructions block extended on the reports category line. [todo.md](todo.md) #68 flipped to `[x]` with full closeout notes.

## Verify Before Continuing

Re-run if the tree has been touched (skip if next session starts within hours):

- [ ] `npm run build` → exit 0 (tsc clean).
- [ ] `npm test` → `Test Files 40 passed | Tests 921 passed`.
- [ ] `"" | & node dist/index.js` → exit 0, `Mode: simulation` printed; banner does NOT print "QBXML debug log: enabled" when `QB_DEBUG_QBXML` is unset.
- [ ] **(Windows + QB) First live exercise of `qb_trial_balance_export`.** Call `qb_trial_balance_export({ asOfDate: "2024-12-31", basis: "Accrual" })` against `VR Tax & Consulting Inc..qbw` (last completed year — full TB). Confirm: `rows.length > 0` (every posting account with non-zero balance); first row's `accountType === "Bank"` (canonical sort puts Bank first); `totals.totalDebits === totals.totalCredits` to the cent (real QB's BS NetIncome closes correctly, so the per-row TB should foot in live mode unlike sim); all four `crossChecks.*.matches` / `reconciles` are `true` (a real book that's been reconciled would tie cleanly — any false is a real audit signal). Then call with `includeLastActivityDate: true` and confirm `rows[*].lastActivityDate` is populated (ISO YYYY-MM-DD) for accounts with recent activity, `null` for dormant accounts. Compare `taxLine` against what QB Desktop shows in the chart of accounts (Edit → Edit Account → Tax-Line Mapping) for a few rows — should match.
- [ ] **(Windows + QB) Operator-driven `/trial_balance_workup` exercise from Claude Desktop.** With QB Desktop open against `VR Tax & Consulting Inc..qbw`, invoke `/trial_balance_workup` in Claude Desktop, supply `asOfDate: "2024-12-31"` and `basis: "Accrual"`. Confirm Claude actually calls `qb_trial_balance_export({ asOfDate, basis, includeLastActivityDate: true })` first, surfaces the workpaper table per the prompt's column spec, and the cross-check block correctly flags any reconciliation deltas.
- [ ] **(Windows + QB) Carried — Phase 18 #85 / #86 first-live exercises** (from prior session). `qb_closing_date_get` wire shape (verify `PreferencesQueryRs.PreferencesRet.AccountingPreferences.ClosingDate` is the actual emitted path); `qb_closing_date_set` returns 9005 with UI navigation; all five MCP prompts (`/month_end_close`, `/credit_card_qb_batch`, `/trial_balance_workup`, `/cc_statement_validator`, `/w2_prep`) surface in Claude Desktop's `/` picker.
- [ ] **(Windows + QB) Carried — `qb_session_status` first-live exercise** (from prior session). Call `qb_session_status({})` then `qb_session_status({ probe: true })` then `qb_session_status({ includeClosingDate: true })` against `VR Tax & Consulting Inc..qbw`; confirm zero wire I/O on the default + fail-soft probe/closingDate.
- [ ] **(Windows + QB) Carried — #84 transient-retry path, #82 host_query field surface, #55 W-2 wire shape, #59 attachment enablement, #54 SCF section labels.** All verified-by-construction structurally but not live-pinned. Lowest priority; details preserved in git history.

## Next Task

**Operator picks next.** With #68 closed, the highest-leverage remaining items (in roughly descending operator-value order):

- **#69 `qb_tax_line_mapping(accountListId?)`** (Phase 15) — would populate the `taxLine` column in `qb_trial_balance_export` rows for sim mode (currently always null there because the sim seed doesn't carry `Account.TaxLineInfoRet`; live mode populates from real QB). Also a direct bridge from books to tax software — the workpaper reviewer can group accounts by tax-line code (Sch C / 1120-S / 1065 / Sch E) without a separate lookup. Cheap to ship: `AccountQueryRq` already returns `TaxLineInfoRet`, this tool just exposes it. Sim improvement: seed each Account with a representative TaxLineInfoRet so e2e tests of TB rows surface taxLine.

- **#75 banking primitives** (Phase 17) — would unblock real bank reconciliation workflows. Currently the reconciliation tools (`qb_cleared_status_update`, `qb_uncleared_transactions`, `qb_reconciliation_discrepancy`) are present but the create-side primitives (Deposit, Transfer, Check directly to a bank account) are not. Pairs with the `/month_end_close` prompt — that prompt assumes the operator can create missing entries during reconciliation.

- **#78 time tracking** (Phase 17) — unblocks #70 (`qb_engagement_profitability`) which can't compute hours-per-job without `TimeTrackingQueryRq`.

- **#70 `qb_engagement_profitability(customerListId, dateRange)`** (Phase 15) — pulls revenue + time + reimbursable expenses for a job. Closer to ClosePilot's surface than the raw aging report. Requires #78 (time tracking) as prerequisite.

- **#71 `qb_client_packet(customerListId, taxYear)`** (Phase 15) — bundles TB (now ready via #68!) + GL + bank rec + fixed asset detail + payroll summary into one call. The workflow run 2,000 times per tax season. Composite that calls #68, #53 (GL), #56 (bank rec discrepancy), #55 (payroll summary), `qb_account_list` (FA detail).

- **#76 sales orders / #77 sales tax / #80 inventory adjustments / #81 statement charges** — domain coverage gaps from Phase 17.

- **Phase 13–14 coverage gaps** — custom fields / DataExt (#61), sub-customer hierarchy (#62), memo full-text search (#63), dry-run mode (#64), better error surfaces (#65), audit log (#66 — Enterprise-only).

## Context Notes

- **#68 cross-check tolerance is a hard `0.01` constant** (`RECON_TOLERANCE` in [src/tools/reports.ts](src/tools/reports.ts)). A delta ≤ 1 cent ties; > 1 cent is a real signal. This is the de-facto bookkeeping standard — anything tighter false-fires on rounding across separate report walks, anything looser hides real subledger drift.

- **#68 sim seed has deliberate subledger drift.** Fresh seed has `Account.Balance=26700` on AR but open invoices walk to `16000`; `Account.Balance=3700` on AP but every seeded bill is `IsPaid: true` so the walk is `0`. The TB cross-check correctly fires on both — that's exactly what the tool is meant to surface. Pinned by the e2e tests asserting the cross-check FIRES with the expected delta (not that the seed reconciles). If you ever rework the seed to make AR/AP tie, update those tests in lockstep.

- **#68 sim's P&L walk is empty against fresh seed.** The seed invoices have item lines but those items don't resolve to income accounts in the sim's `buildPnLReport` walk (the existing `qb_pnl_report` has the same empty-result behavior; not a #68 issue). This means no Income/Expense rows appear in the TB rows in sim — the e2e tests work around this by asserting against AP (the natural-credit account that DOES appear). Live mode against real QB will populate the P&L sections normally.

- **#68 `includeLastActivityDate: true` is opt-in by design.** N additional `TransactionQueryRq` round trips for an N-account chart is real cost (~10s for 200 accounts in live mode). The bare tool call stays cheap (5 wire calls total) for the common reconciliation use case; the workpaper workflow (the `/trial_balance_workup` prompt) opts in explicitly. Per-account failures land in `warnings` and the row's `lastActivityDate` stays null — one bad account doesn't poison the whole TB.

- **#68 contra-balance column flip is load-bearing.** A natural-debit account (Asset/Expense) with a negative balance emits in the CREDIT column, not as a negative debit. Same for natural-credit accounts. This matches how bookkeepers read a TB — negative numbers on a workpaper are an error signal. The "Customer Refunds Due" account in the unit-test fixtures specifically exercises this (negative AR → Credit column). If the operator ever pushes back on this convention, change the helper, not the tool.

- **#68 NonPosting exclusion is by TB convention.** Estimates / POs / sales orders don't post to GL and don't belong on a TB. Operators who want their balances should use `qb_balance_summary` (which surfaces them via the Account.Balance fallback). If the operator pushes back, add an `includeNonPosting` arg — but the default should stay false.

- **#68 `Account.AccountNumber` is a string, not a number, in QB.** Allows non-numeric chart styles (`1000-1`, `1000.A`, etc.). Sort uses `localeCompare` accordingly — strict numeric compare would mis-sort. Verified at the unit-test level via the seeded accounts.

- **Carried gotchas (unchanged from prior handoffs):**
  - **#67 default path is zero wire I/O — load-bearing for orchestration retry loops.** Don't add a wire call to the default path. Use `probe: true` for active probing.
  - **#67 fail-soft on `probe` / `includeClosingDate`** — failures land INSIDE the response, not as `isError`.
  - **#85 SDK gap is permanent.** Do not speculatively wire a `PreferencesModRq` builder. Canonical response for any future preference write is 9005 + UI navigation.
  - **#85 synthetic statusCode reservations**: 9001 read-only, 9002 idempotency conflict, 9003 edition unsupported, 9004 payroll subscription required, **9005 SDK has no write path**, 9006+ reserved.
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
