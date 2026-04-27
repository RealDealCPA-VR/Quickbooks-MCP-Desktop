# Handoff State

_Last updated: 2026-04-26_

## Last Session Summary

- **Closed Phase 5, Item 20 — `qb_pnl_report` and `qb_balance_sheet_report` via `GeneralSummaryReportQueryRq`** ([todo.md:43](todo.md#L43) checked). Phase 5 is now complete.
  - **Builder.** New `buildReportRequest({ reportType, fromDate?, toDate?, basis? }, version?)` in [src/qbxml/builder.ts](src/qbxml/builder.ts) emits a `GeneralSummaryReportQueryRq` with `<GeneralSummaryReportType>` / `<ReportPeriod>` (FromReportDate + ToReportDate) / `<ReportBasis>` (default Accrual) / `<SummarizeColumnsBy>TotalOnly</SummarizeColumnsBy>` / `<IncludeSubcolumns>0</IncludeSubcolumns>`. Report rqs are not list/txn queries — they got their own builder rather than overloading `buildQueryRequest`.
  - **Parser.** New `extractReportData(response, expectedType?)` in [src/qbxml/parser.ts](src/qbxml/parser.ts:140) pulls the `ReportRet` block out of the named `*Rs` body. Mirrors `extractResponseData` semantics (throws `QBXMLResponseError` on hard failure, returns `{}` on the "no data" status 1). Live-mode row-tree translation is documented as a Phase 7 follow-up in the jsdoc — until then the simulation owns the wire format.
  - **Simulation handler.** New `handleReportQuery` branch in [src/session/simulation-store.ts](src/session/simulation-store.ts) routes `GeneralSummaryReportQueryRq` (added before the `endsWith("QueryRq")` branch in `processRequest`). Rejects unknown `GeneralSummaryReportType` with statusCode 3120.
  - **P&L walk** — Income side: Invoice + SalesReceipt (positive) + CreditMemo (negative); each line's account resolves via `line.AccountRef` (rare on these txns) or `line.ItemRef → item.IncomeAccountRef / item.SalesOrPurchase.AccountRef`. Expense side: Bill + Check + CreditCardCharge ExpenseLine (AccountRef direct) + ItemLine (item.ExpenseAccountRef / COGSAccountRef / SalesOrPurchase.AccountRef). JournalEntry contributes — debit lines posting to expense accounts add positive expense; credit lines posting to income accounts add positive income. TxnDate filtered to `[fromDate, toDate]` inclusive. Lines whose account can't be resolved land in `Uncategorized Income` / `Uncategorized Expense` so totals reconcile.
  - **P&L sections** — single-pass `groupByAccountType` over the combined income + expense records with sectionMap `[Income, Other Income, Cost of Goods Sold, Expenses, Other Expenses]`. Records that don't match any section's types land in a trailing "Other" section that is visible but does NOT contribute to the named subtotals (it's audit cheese — the tool's `totalIncome` etc. derive from per-section subtotals, not a global total).
  - **Balance Sheet** — Asset / Liability / Equity sections built from `Account.Balance` (snapshot — `asOfDate` is advisory for those sections in simulation, documented). Period NetIncome (lifetime txn walk up to asOfDate) closes into Equity as a "Net Income" row, mirroring real QB's Retained Earnings + Net Income pattern. The accounting identity Assets = Liabilities + Equity reconciles by closing the simulation seed gap (the known $10,700 phantom AR — see prior handoff) into a "Balancing Adjustment (simulation seed gap)" Equity row.
  - **Manager wiring** — `QBSessionManager.runReport(reportType, { fromDate, toDate, basis })` in [src/session/manager.ts:212-227](src/session/manager.ts#L212-L227) rewrites to use the new builder + extractor (no longer the wrong `buildQueryRequest` + `extractResponseData` pair). Imports `buildReportRequest` and `extractReportData`.
  - **Tools.** Two new tools in [src/tools/reports.ts:373-487](src/tools/reports.ts#L373-L487):
    - `qb_pnl_report({ fromDate?, toDate?, basis? })` — returns `{ reportTitle, reportBasis, reportPeriod: { from, to }, sections: [{ name, accounts: [{ name, total }], subtotal }], totalIncome, totalCOGS, totalExpenses, grossProfit, netIncome }`.
    - `qb_balance_sheet_report({ asOfDate?, basis? })` — returns `{ reportTitle, reportBasis, asOfDate, sections: [...], totalAssets, totalLiabilities, totalEquity, netIncome }`. asOfDate defaults to today UTC.
    - Both wrapped in try/catch translating `QBXMLResponseError` → `{ success: false, statusCode, statusMessage }` + `isError: true` (Item 25 reference shape, same as Items 14/19/21).
  - **Bug squashed mid-implementation.** First pass had `groupByAccountType` returning `{ sections, total }` with `total` including unrouted records — that double-counted into per-section totals when the helper was called per-section (P&L COGS section's `total` ended up summing all expense records, not just COGS). Verification harness caught it: NetIncome was -3100 instead of expected -1050 in the JE-mixing test. Fix: refactor to a single combined-pass call across all 5 sections, return `sections[]` only, derive named totals from per-section subtotals. Same simplification — better correctness.
- **README updated** — `qb_pnl_report` / `qb_balance_sheet_report` rows added to Reports & Queries table at [README.md:200-201](README.md#L200-L201) with full description of walk semantics, section ordering, totals, basis, asOfDate semantics.
- **`instructions` block in [src/index.ts](src/index.ts) updated** — the `qb_balance_summary / qb_ar_aging / qb_ap_aging` line now also covers `qb_pnl_report / qb_balance_sheet_report` with their walk + closure semantics. Capabilities header updated to mention "P&L, Balance Sheet."
- **ACCEPTANCE_CRITERIA.md** — Item 20 entry written and placed at the top of the Completed section. Phase 5 header updated to "All Phase 5 items done."
- **No DECISIONS.md / ARCHITECTURE.md change** — the report path follows the existing builder → simulation-store → parser pipeline (just a new request type). The simplified-vs-row-tree shape is documented inline in `extractReportData` jsdoc + `handleReportQuery` method note rather than a standalone decision (it's a scope clarification, not a tradeoff among alternatives — Phase 7 will need to add a row-tree adapter when COM lands).
- **Verified.** `npm run build` green. Item 20 verification harness: **64/64 PASS**. Coverage:
  - **P&L empty period (`asOfDate=2030-01-01..2030-12-31`)** — `sections === []`, every total === 0.
  - **P&L seed-only state** — seed invoices have no `InvoiceLineRet` (only Subtotal/IsPaid headers); line walk yields nothing → totalIncome === 0. Confirms the walk doesn't fall back to `Subtotal` (correct — that'd double-count when real lines exist).
  - **P&L Bill ExpenseLine path** — created bill with `expenseLines: [Rent Expense $1200, Utilities $350]` for `txnDate=2026-03-15`. `qb_pnl_report({ fromDate: "2026-01-01", toDate: "2026-12-31" })` → totalExpenses 1550, Expenses section subtotal 1550, Rent Expense $1200, Utilities $350. Income section absent (correct — no income txns).
  - **P&L date filter** — same bill against `toDate: "2026-02-28"` → totalExpenses 0 (excluded).
  - **P&L JournalEntry path** — JE debit Rent Expense $500 / credit Checking $500 contributes $500 to Expense; JE debit Checking $1000 / credit Sales Revenue $1000 contributes $1000 to Income. Final: totalIncome 1000, totalExpenses 2050 (1550 bill + 500 JE), grossProfit 1000, netIncome -1050.
  - **P&L canonical section order** — Income before Expenses (and would be Income → Other Income → COGS → Expenses → Other Expenses if all populated).
  - **P&L basis passthrough** — defaults to Accrual; `basis: "Cash"` echoes back as Cash (currently identical aggregation).
  - **Balance Sheet sections** — Assets / Liabilities / Equity present in canonical order. Bank seeds in Assets ($45k Checking + $120k Savings).
  - **Balance Sheet identity** — `totalAssets === totalLiabilities + totalEquity` holds (191700 === 191700) thanks to the Balancing Adjustment row absorbing the seed gap.
  - **Balance Sheet Net Income row** — present in Equity, `total === body.netIncome`.
  - **Balance Sheet asOfDate default** — omitted asOfDate fills with today UTC.
  - **Schema validation** — both tools reject `04/26/2026` and `2026/04/26`; accept `2026-04-26` and `{}`. `qb_pnl_report` rejects unknown `basis` enum values.
  - **Unsupported reportType** — `manager.runReport("BogusReport", {})` throws `QBXMLResponseError` with statusCode 3120.
  - **Regressions** — Items 14 (qb_company_info → Demo Co), 19 (qb_ar_aging $16000, qb_ap_aging tracks the new bill at $1550), and 21 (qb_balance_summary netIncome -22800, Bank first) all still pass.

## Verify Before Continuing

- [ ] **Build.** `npm run build` exits 0.
- [ ] **`qb_pnl_report` empty period.** `qb_pnl_report({ fromDate: "2030-01-01", toDate: "2030-12-31" })` → `body.totalIncome === 0`, `body.totalExpenses === 0`, `body.netIncome === 0`, `body.sections === []`. Cheap tripwire that the txn walk + date filter are wired up.
- [ ] **`qb_pnl_report` populated path.** Create a bill with `expenseLines: [{ accountName: "Rent Expense", amount: 1200 }]` for `txnDate=2026-03-15`. Then `qb_pnl_report({ fromDate: "2026-01-01", toDate: "2026-12-31" })` → Expenses section subtotal === 1200, Rent Expense account === 1200. Confirms ExpenseLineRet → AccountRef → AccountType lookup chain works end-to-end.
- [ ] **`qb_balance_sheet_report` identity.** `qb_balance_sheet_report({ asOfDate: "2026-12-31" })` → `body.totalAssets === body.totalLiabilities + body.totalEquity` (after rounding). Confirms the Balancing Adjustment row is reconciling the seed gap.
- [ ] **`qb_balance_summary` regression.** Still emits canonical-ordered 6-group array; `body.subtotals.netIncome === -22800`. Confirms the new helpers in `simulation-store.ts` didn't shadow / conflict with Item 21's exports.
- [ ] **`qb_ar_aging` / `qb_ap_aging` regression.** AR still totals $16000 against the seeded invoices; AP still 0 on a clean process.
- [ ] **`qb_company_info` regression.** Auto-connects, returns Demo Co.

## Next Task

**Phase 6 — pick up `23` (env semantics) as the quick win, then `25` (structured-error sweep) as the bulk follow-up.**

### Phase 6 task list

- [ ] **23.** Fix `QB_SIMULATION` env semantics in [src/session/manager.ts:50-53](src/session/manager.ts#L50-L53) — currently `QB_SIMULATION=false` on Windows still simulates unless `QB_LIVE=1` is also set. Decide on one of:
  - Honor `QB_SIMULATION=false` alone (drop the `!process.env.QB_LIVE` clause), OR
  - Document the actual rule (live mode requires both Windows + `QB_LIVE=1` set; `QB_SIMULATION` is just a forced-on override) and align the README + .env.example so the operator can predict behavior.
  - The current logic is `simulationMode = QB_SIMULATION === "true" || not-windows || !QB_LIVE`. That's a 3-way OR which is hostile to reason about. Simpler: `simulationMode = QB_SIMULATION === "true" || (QB_SIMULATION !== "false" && (not-windows || !QB_LIVE))` — i.e. explicit `false` overrides the default-to-simulation behavior when on Windows + QB_LIVE.
  - Quick win: 5-line change + .env.example + README env table. Acceptance: matrix of (platform, QB_SIMULATION, QB_LIVE) → expected mode is documented and code matches.
- [ ] **25.** Wrap `session.queryEntity / addEntity / modifyEntity / deleteEntity` calls in tool handlers with try/catch — translate `QBXMLResponseError` into structured tool error responses (`isError: true` with `statusCode` + `statusMessage`) instead of letting them propagate as raw exceptions. **Items 14, 19, 21 are reference shapes** — Item 25's job is to converge the rest. Bulk sweep across all `src/tools/*.ts` files. Roughly 20+ tools that need the wrap. Acceptance: every tool's happy path still returns the same shape; every tool's "stale editSequence" / "not found" / "missing required field" path now returns `isError: true` with a structured payload instead of a raw stack trace.
- [ ] **26.** Status code mapping table for common QB errors (3120 missing field, 3170 modify failed, 3260 insufficient permission, 500 not found, etc.). Best done as a small util `qbStatusCodeMessage(statusCode: number): string` that the Item 25 wrapper consults to add a `humanReadable` field alongside `statusMessage`. Acceptance: every status code the simulation emits is in the table; the wrapper attaches `humanReadable` when present.
- [ ] **27.** `IteratorID` / `IteratorRemainingCount` support on large queries. Real QB caps at ~500 rows. Lower-priority for personal use (the local store has tens of records, not thousands), but worth doing before live-mode lands so iterator handling isn't a Phase 7 surprise.
- [ ] **28.** Validate `AccountType` enum in `qb_account_add` — reuse Item 21's `CANONICAL_ACCOUNT_TYPES` constant in [src/tools/reports.ts:17-24](src/tools/reports.ts#L17-L24). Currently any string passes through and QB rejects with cryptic 3120. Acceptance: invalid account type rejects at zod with clear list of allowed values; valid types pass through unchanged.
- [ ] **29.** Input validation for email / phone / postal / ISO date strings on relevant fields. Item 19 already added `ISO_DATE_RE` for date fields, so the date side of 29 overlaps — extend `ISO_DATE_RE` consumers across the rest of the tools. Acceptance: every date field rejects non-`YYYY-MM-DD`; email fields reject obvious non-emails; etc.

After Phase 6 closes, Phase 7 is `1` (live COM) and Phase 8 is `31` (Vitest) + `32` (.gitignore / .env.example) — both are bigger pieces of work.

## Context Notes

- **Item 20 implementation details that affect future edits.**
  - The simulation emits a simplified `ReportRet` shape (`{ ReportTitle, ReportBasis, FromReportDate, ToReportDate, Sections, Totals }`) — NOT real QB's row tree (TextRow / DataRow / SubtotalRow / TotalRow under ReportData). When Phase 7 (live COM) lands, the live response will carry the row tree; the live-side translation to the simplified shape needs to land in `extractReportData` (currently jsdoc-flagged) or in `manager.runReport` (probably the cleaner spot). Tests against this code today are simulation-only; live verification is gated on Phase 7.
  - `groupByAccountType` returns sections only (no `total` field). Callers derive subtotals via `sections.find((s) => s.Name === X)?.Subtotal ?? 0`. Records that don't match any section's types land in a trailing "Other" section that is visible but doesn't contribute to named totals. Don't reintroduce the global `total` field — the bug it caused (double-counting per-section calls) was a one-line write but a half-hour debug.
  - `walkJournalEntryLines` uses an inner `lookupType(name)` helper. Could lift to a class field if a third caller appears. Not worth doing for two callers.
  - The Balance Sheet "Balancing Adjustment (simulation seed gap)" row exists ONLY because the seed has phantom Account.Balance values that don't match the txn-walk-derived NetIncome. If a future task decides to fix the seed (the obvious move: re-derive seed account balances from a small set of opening-balance JEs), the adjustment row will collapse to $0 and disappear. Don't remove the adjustment logic — it's defensive against future seed drift.
- **Item 25 (next sweep) reference shape.** Items 14, 19, 21, 20 all use this pattern:
  ```ts
  try {
    // session.queryEntity / addEntity / etc.
    return { content: [{ type: "text" as const, text: JSON.stringify(success, null, 2) }] };
  } catch (err) {
    const e = err as { message?: string; statusCode?: number };
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        success: false,
        statusCode: e.statusCode ?? -1,
        statusMessage: e.message ?? "<entity>QueryRq failed",
      }) }],
      isError: true,
    };
  }
  ```
  Reuse this verbatim. Don't introduce a wrapper helper unless the sweep clearly warrants it (~20 tools — a small DRY helper that takes a label + the inner async fn would shave 6 lines per tool, but adds an indirection layer the existing reference tools don't have).
- **`QB_SIMULATION` env quirk (carried)** — the Item 23 task above is the dedicated fix; until then, on Windows you need both `QB_SIMULATION=false` AND `QB_LIVE=1` to get out of simulation mode. On non-Windows you're always in simulation regardless of env vars.
- **Bills use `AmountDue`, NOT `BalanceRemaining` (carried).** [src/session/simulation-store.ts:954-956](src/session/simulation-store.ts#L954-L956) is the source of truth.
- **Verification gotcha (carried)** — handlers captured via the `fakeServer` pattern do NOT pass through zod validation. To test schemas, parse via `z.object(schemaShape).safeParse(...)` separately. Item 20 harness uses this pattern.
- **Verification gotcha (carried)** — `handleQuery` filters require uppercase `TxnID` / `RefNumber` / `FullName` in the filter object when calling `session.queryEntity` directly. Tools translate from lowercase correctly. Verification scripts that invoke captured handlers get this for free.
- **REGRESSION_CHECKLIST §4 (QBXML round-trip) was partially covered.** Item 20 touched both builder and parser, but simulation mode bypasses XML round-trip in-process (the simulation store returns parsed `QBXMLResponse` objects directly without re-serializing). Live-mode round-trip lands with Phase 7. The new `arrayElements` in the parser (`ReportRet`, `ColDesc`, `DataRow`, `TextRow`, `SubtotalRow`, `TotalRow`, `ColData`) were added in Item 19's session preemptively and are sitting unused until live mode wires up; they're the right choice and don't hurt anything.

## Post-Task Chores

When Item 23 lands: `npm run build` green, [REGRESSION_CHECKLIST.md](REGRESSION_CHECKLIST.md) §1 (Build), §2 (Server Startup — confirm the new env-var rule prints the expected mode banner), §6 (Mode Boundary — confirm the simulationMode boolean still reads once at construction time, not per-request), Item 23 ticked in `todo.md`, `ACCEPTANCE_CRITERIA.md` entry written for Item 23, fresh `HANDOFF.md` pointing at Item 25 as the next big sweep.

When Item 25 lands: same flow but expand §3 (Tool Surface) — every changed tool's error path returns `isError: true` with structured payload, not raw stack trace. Spot-check 3-5 tools per domain.
