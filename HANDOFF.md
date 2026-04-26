# Handoff State

_Last updated: 2026-04-26_

## Last Session Summary

- **Closed Phase 5, Item 19 — `qb_ar_aging` / `qb_ap_aging` rewritten to walk open transactions and bucket by aging band** ([todo.md:42](todo.md#L42) checked). Both tools now do real aging instead of dumping `Customer.Balance` / `Vendor.Balance` rollups. Five changes in [src/tools/reports.ts](src/tools/reports.ts):
  - **Aging-bucket helpers at module scope** ([src/tools/reports.ts:32-58](src/tools/reports.ts#L32-L58)). `BUCKET_KEYS` const tuple, `BucketKey` type, `emptyBuckets()` factory, `bucketFor(days)` → `0-30 | 31-60 | 61-90 | 90+`, plus `dateUTC(s)` and `daysBetween(asOfDate, dueDate)`. Date math uses `Date.UTC` to dodge local-TZ drift on YYYY-MM-DD inputs (regex pre-validates so `split("-").map(Number)` is safe). Negative `daysOutstanding` (asOfDate < dueDate, i.e. not yet due) collapses into the `0-30` band — matches QB's standard summary aging layout.
  - **`qb_ar_aging` rewrite** ([src/tools/reports.ts:182-260](src/tools/reports.ts#L182-L260)). Queries `Invoice` (not `Customer`), filters to `IsPaid !== true && Number(BalanceRemaining) > 0`, ages each open invoice by `(asOfDate − DueDate ?? TxnDate ?? asOfDate)`, groups by `CustomerRef.FullName` into `{ name, balance, buckets, txnCount }` rows. Top-level response: `{ asOfDate, totalAccountsReceivable, bucketTotals, customers }`. Customers sorted by balance desc. `totalAccountsReceivable` derived from `bucketTotals` (single source of truth — sums always reconcile). Wrapped in try/catch translating `QBXMLResponseError` → `{ success: false, statusCode, statusMessage }` with `isError: true` (Item 25 reference shape, opportunistic since the file was being rewritten).
  - **`qb_ap_aging` rewrite** ([src/tools/reports.ts:262-340](src/tools/reports.ts#L262-L340)). Same skeleton, swapped for `Bill` / `VendorRef` / `AmountDue`. Bills use `AmountDue` as the open-balance field — the bill-side equivalent of an invoice's `BalanceRemaining`. The handoff for Item 19 said both have `BalanceRemaining`; verified in [src/session/simulation-store.ts:954-955](src/session/simulation-store.ts#L954-L955) — bills only get `AmountDue + IsPaid`, not `BalanceRemaining`. Adjusted accordingly.
  - **`asOfDate` zod param** — both tools accept `z.string().regex(ISO_DATE_RE).optional()` (reusing the same constant Item 21 added). Defaults to `new Date().toISOString().split("T")[0]` (today, UTC) when omitted. Schema rejects `04/26/2026`, `2026/04/26`; accepts `2026-04-26` and `{}`.
  - **Tool descriptions tightened** ([src/tools/reports.ts:182](src/tools/reports.ts#L182), [src/tools/reports.ts:262](src/tools/reports.ts#L262)) — describe filtering rules, fallback behavior, bucket bands, and "single txn = single bucket" guarantee, so the LLM consumer (and future readers) can predict behavior from the description alone.
- **README updated** — `qb_ar_aging` / `qb_ap_aging` rows in the Reports & Queries table at [README.md:198-199](README.md#L198-L199) now describe the open-txn walk, bucket bands, and `asOfDate` semantics.
- **ACCEPTANCE_CRITERIA.md** — Item 19 entry written and placed at the top of the Completed section. Phase 5 header updated to "Items 14, 19, 21 done — Item 20 still open."
- **No DECISIONS.md / ARCHITECTURE.md change** — bucket bands are straight from QB's documented summary aging report (not a tradeoff). The open-txn walk is the obvious correct implementation; the Customer/Vendor `Balance` rollup was the bug. `runReport` was deliberately not touched (handoff scope guard — that's Item 20).
- **Verified.** `npm run build` green. Item 19 verification harness: **54/54 PASS**. Coverage:
  - **AR seed sanity (asOfDate=2026-04-26)** — both seeded unpaid invoices (Acme $7500 due 2024-12-01, Global $8500 due 2024-12-15) land in `90+`. Total `$16,000`. `bucketTotals = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 16000 }`. Customers sorted Global → Acme. `txnCount === 1` per row.
  - **AR bucket boundaries (sweeping asOfDate over Acme's 2024-12-01 due date)** — every boundary verified: 0 / 30 / 31 / 60 / 61 / 90 / 91 / −30 days → `0-30` / `0-30` / `31-60` / `31-60` / `61-90` / `61-90` / `90+` / `0-30`. The `<= 30` band correctly absorbs negative-days (future-dated) txns.
  - **`asOfDate` default** — no-arg call fills `asOfDate` with today (UTC). Seed still buckets in `90+`.
  - **TxnDate fallback** — created an invoice with `txnDate=2025-12-01` and **no** `dueDate`. `qb_ar_aging({ asOfDate: "2026-01-01" })` puts the $1234 line in `31-60` (31 days from TxnDate). Confirms the `DueDate ?? TxnDate` chain.
  - **AP empty path** — no seeded bills → `vendors: []`, `totalAccountsPayable: 0`, all bucket totals 0. No throws on empty Bill store.
  - **AP created-bill path** — created 4 bills under "Office Supplies Inc" with due dates `2026-04-20 / 2026-03-01 / 2026-02-01 / 2025-01-01` and amounts `100 / 200 / 400 / 800`. With `asOfDate=2026-04-26`: `bucketTotals = { "0-30": 100, "31-60": 200, "61-90": 400, "90+": 800 }`, single vendor row sums to 1500 with `txnCount === 4`. All 4 bands exercised.
  - **Zod schema** — both tools reject `04/26/2026` and `2026/04/26`; accept `2026-04-26` and `{}`. Validated by `z.object(schemaShape).safeParse(...)` (the verified-handler-bypass-zod gotcha from prior handoff).
  - **Regression — Item 21** — `qb_balance_summary` still emits canonical-ordered array, `Bank` first with total 165000, `subtotals.netIncome === -22800`.
  - **Regression — Item 14** — `qb_company_info` auto-connect path still returns `Demo Co`.

## Verify Before Continuing

- [ ] **Build.** `npm run build` exits 0.
- [ ] **`qb_ar_aging` seed sanity.** `qb_ar_aging({ asOfDate: "2026-04-26" })` returns `body.totalAccountsReceivable === 16000`, `body.bucketTotals["90+"] === 16000`, all other buckets 0, and `body.customers.length === 2` with Global Industries first ($8500). Cheap tripwire that the open-invoice walk is wired up. If this returns ~$26,700 (the customer rollup total), the fix didn't take.
- [ ] **`qb_ar_aging` bucket boundary at +31 days.** `qb_ar_aging({ asOfDate: "2025-01-01" })` puts Acme's $7500 in `31-60`, not `0-30`. Cheap tripwire on the `bucketFor` boundary (off-by-one would surface as `0-30`).
- [ ] **`qb_ap_aging` empty when no bills.** Fresh process, no bills created. `qb_ap_aging({ asOfDate: "2026-04-26" })` returns `body.vendors === []`, `body.totalAccountsPayable === 0`. Confirms the AP path doesn't pull from the (still-populated) Vendor `Balance` rollup.
- [ ] **`qb_balance_summary` regression.** Still emits canonical-ordered 6-group array; `body.subtotals.netIncome === -22800`. Confirms the new helpers in `reports.ts` didn't shadow / conflict with Item 21's exports.
- [ ] **`qb_company_info` regression.** Auto-connects, returns Demo Co.

## Next Task

**Phase 5, Item 20 — `qb_pnl_report` and `qb_balance_sheet_report` via `GeneralSummaryReportQueryRq`** ([todo.md:43](todo.md#L43)).

Today there are no real P&L or Balance Sheet tools. `qb_balance_summary` (Item 21) is account-balance grouping, not a true Balance Sheet report. The session's `runReport` plumbing exists but is stub-shaped:

- [src/session/manager.ts:212-224](src/session/manager.ts#L212-L224) — `runReport` builds via `buildQueryRequest`, sends, calls `extractResponseData(response)` with no second arg, returns `data[0] ?? {}`. That's wrong for report responses — `GeneralSummaryReportQueryRq` returns a `ReportRet` block with `ReportTitle`, `ReportSubtitle`, `ReportBasis`, `NumRows`, `NumColumns`, `ColDesc[]`, `ReportData.DataRow[]`/`TextRow[]`/`SubtotalRow[]`/`TotalRow[]`. The current code returns `{}` because `extractResponseData` looks at the first `*Rs` element name and there's no `ReportRet` extraction path.

### Implementation shape

1. **Builder.** `GeneralSummaryReportQueryRq` is structurally different from a list/txn query — see Intuit's spec. Skeleton:
   ```xml
   <GeneralSummaryReportQueryRq>
     <GeneralSummaryReportType>ProfitAndLossStandard</GeneralSummaryReportType>
     <ReportPeriod>
       <FromReportDate>2026-01-01</FromReportDate>
       <ToReportDate>2026-04-26</ToReportDate>
     </ReportPeriod>
     <ReportBasis>Accrual</ReportBasis>           <!-- or Cash -->
     <SummarizeColumnsBy>TotalOnly</SummarizeColumnsBy>
     <IncludeSubcolumns>0</IncludeSubcolumns>
   </GeneralSummaryReportQueryRq>
   ```
   Probably worth adding a `buildReportRequest(reportType, params, version)` to [src/qbxml/builder.ts](src/qbxml/builder.ts) instead of overloading `buildQueryRequest` — report rqs aren't list/txn queries and have their own param shape (`ReportPeriod`, `ReportBasis`, `SummarizeColumnsBy`, etc.).
2. **Parser.** `ReportRet` rows are nested. Real shape (sketch):
   ```
   ReportRet
     ReportTitle, ReportSubtitle, ReportBasis, NumRows, NumColumns
     ColDesc[]   (one per column; first is usually "Label")
     ReportData
       DataRow[]    — RowData.value (the label) + ColData[].value (the numbers)
       TextRow[]    — section headers ("Income", "Expenses")
       SubtotalRow[] — group subtotals
       TotalRow[]   — grand total
   ```
   Each row type is a sibling under `ReportData`, and they interleave to express the report's tree structure (Section header → Data rows → Subtotal → next section). Add a `extractReportData(response)` to [src/qbxml/parser.ts](src/qbxml/parser.ts) (parallel to `extractResponseData`) that pulls the `ReportRet` block out of the envelope and normalizes the row arrays. `arrayElements` registration: `ColDesc`, `DataRow`, `TextRow`, `SubtotalRow`, `TotalRow`, and probably `ColData`. fast-xml-parser strips empty elements, so empty `<ColData>` cells need a sentinel — see prior gotcha note.
3. **Simulation store.** This is the harder half. Real QB walks every transaction through every account and aggregates by GL account into a tree (Income → ServiceIncome / SalesIncome → SubtotalRow; Expense → … → SubtotalRow; NetIncome → TotalRow). The simulation needs to do the same. Approach:
   - Walk all `Invoice` / `SalesReceipt` / `CreditMemo` lines (income side) and `Bill` / `Check` / `CreditCardCharge` lines (expense side).
   - Bucket each line's `Amount` under its `AccountRef.FullName` → look up that account's `AccountType`.
   - For P&L: emit only Income / OtherIncome / CostOfGoodsSold / Expense / OtherExpense buckets. Compute NetIncome.
   - For Balance Sheet: emit Asset / Liability / Equity buckets, derive NetIncome (Income − Expenses), close into Equity. Same canonical ordering as Item 21's `CANONICAL_ACCOUNT_TYPES`.
   - `ReportPeriod.FromReportDate` / `ToReportDate` filter the transaction walk by `TxnDate`.
4. **Tools.** Two new tools in [src/tools/reports.ts](src/tools/reports.ts):
   - `qb_pnl_report` — `{ fromDate, toDate, basis }` (basis defaults to `"Accrual"`). Returns `{ reportTitle, reportPeriod, basis, sections: [{ name, accounts: [{ name, total }], subtotal }], netIncome }`.
   - `qb_balance_sheet_report` — `{ asOfDate }`. Returns `{ reportTitle, asOfDate, sections: [...], totalAssets, totalLiabilities, totalEquity, netIncome }`.
5. **Wrap in try/catch + `isError: true`** — same Item 25 reference shape Item 19 / Item 21 use.

### Suggested response shape (P&L)

```json
{
  "reportTitle": "Profit & Loss",
  "reportBasis": "Accrual",
  "reportPeriod": { "from": "2026-01-01", "to": "2026-04-26" },
  "sections": [
    { "name": "Income",
      "accounts": [{ "name": "Service Income", "total": 200000 }, { "name": "Product Sales", "total": 57000 }],
      "subtotal": 257000 },
    { "name": "Cost of Goods Sold",
      "accounts": [{ "name": "Materials", "total": 95000 }],
      "subtotal": 95000 },
    { "name": "Expenses",
      "accounts": [{ "name": "Office Supplies", "total": 8800 }, ... ],
      "subtotal": 184800 }
  ],
  "grossProfit": 162000,
  "netIncome": -22800
}
```

(Balance Sheet mirrors with Assets / Liabilities / Equity bands and `asOfDate`.)

### Scope guards

- **Don't try to render the QB report-row tree verbatim.** Real QB's `ReportRet` is a flat array of typed rows that visually reconstructs a tree via row types and indentation. The MCP consumer is an LLM, not a print preview — the simplified `sections[]` shape above is more useful and easier to compute. Keep the raw tree behind the parser; tools surface the simplified shape.
- **Don't change `qb_balance_summary`'s output shape.** That tool is for a quick balance dump (Item 21). `qb_balance_sheet_report` is a separate, period-aware report. Both can coexist.
- **Don't compute YTD vs custom periods generically.** P&L takes `from`/`to`. Balance Sheet takes `asOfDate`. Don't add a `period: "ytd" | "qtd" | "month"` shorthand — just take explicit dates.
- **Don't build full MultiPeriod columns.** `IncludeSubcolumns=0`, `SummarizeColumnsBy=TotalOnly` only. MultiPeriod / class / customer slicing is a separate piece of work (real QB has 5+ axes you can pivot by — that's report tooling, not minimal P&L).
- **Don't implement live-mode COM yet.** Item 1 (Phase 7) is the only place real QBXMLRP2 calls go. For Item 20, simulation-only is fine — when Phase 7 lands, the live `sendRequest` plumbing will replace the current throw and the parser path covers both modes equally.

### After Item 20

- Phase 5 closes. Move to Phase 6: `23` (env semantics), `25` (sweep tool handlers to use the structured-error try/catch — Items 14, 19, 21 are now the reference; Item 25's job is to converge the rest), `26` (status code mapping table), `27` (iterators on large queries), `28` (AccountType enum validation — reuse Item 21's `CANONICAL_ACCOUNT_TYPES`), `29` (input validation: email/phone/postal/ISO date — Item 19 already added `ISO_DATE_RE` for date fields, so the date side of `29` overlaps).

## Context Notes

- **Item 19 implementation details that affect future edits.**
  - `BUCKET_KEYS` / `BucketKey` / `emptyBuckets` / `bucketFor` / `daysBetween` / `dateUTC` are all module-local in [src/tools/reports.ts](src/tools/reports.ts). If a third aging tool starts needing them (unlikely — there are only AR and AP), lift to a shared util. Two callers isn't enough yet.
  - `daysBetween` deliberately uses `Date.UTC` to avoid the trap where `new Date("2026-04-26").getTime()` is interpreted as UTC midnight but `new Date(2026, 3, 26).getTime()` is interpreted as local midnight, and the difference depending on TZ can flip a boundary case (e.g. asOfDate=dueDate could land in `0-30` in UTC but `90+` if the local clock has already crossed midnight). Don't switch to `new Date(s).getTime()` — keep `Date.UTC`.
  - `bucketFor` is `<= 30 / <= 60 / <= 90 / else` — the `<=` upper bounds are deliberate. Real QB's report says "31-60" inclusive on both sides; the math `daysOutstanding = floor(...)` puts boundary days on the lower-band side. Verified at every boundary in the harness.
  - The `txnCount` field on per-party rows is debugging cheese — useful when a customer has 8 invoices spread across buckets and the operator needs to know how many txns make up the $X balance. Costs nothing to compute. Don't remove it.
- **Bills use `AmountDue`, NOT `BalanceRemaining`.** [src/session/simulation-store.ts:950-956](src/session/simulation-store.ts#L950-L956) is the source of truth — `computeTotals` for `Bill` only sets `AmountDue` + `IsPaid`. The original Item 19 handoff said "Both have `IsPaid` + `BalanceRemaining` populated by the simulation store today" — that's wrong for bills. If a future task touches bill payment math, remember `AmountDue` is the open-balance field.
- **Seed AR has a known $10,700 phantom balance.** Customer `Balance` rollup totals $26,700, but seeded open invoices total $16,000. The Item 19 tool walks invoices, so AR aging shows $16,000 — that's *correct*, the rollup was wrong. If a future task tries to reconcile, fix the seed (subtract $10,700 from the appropriate customer's seeded `Balance`), don't unfix the aging tool.
- **Empty bill store on fresh process.** AP aging will return empty `vendors` until the operator (or a verification harness) creates bills via `qb_bill_create`. That's expected and correct — there are no seeded bills.
- **Project conventions reminder** ([CLAUDE.md](CLAUDE.md) § Stable Code Conventions): TS strict, ESM with `.js` extensions on relative imports, every zod field has `.describe()`, every tool registered in [src/index.ts](src/index.ts) and listed in the README tool table, structured tool errors via try/catch + `isError: true` + `statusCode` (Items 14, 19, 21 are reference shapes — Item 25 is the sweep that converges the rest).
- **Verification gotcha (carried)** — handlers captured via the `fakeServer` pattern do NOT pass through zod validation (the MCP SDK's `server.tool` wraps the handler with the schema, and we capture only the inner handler). Validate the zod schema separately by parsing it via `z.object(schemaShape).safeParse(...)` — the Item 19 harness uses this pattern; reuse it for Item 20.
- **Verification gotcha (carried)** — `handleQuery` filters require **uppercase** `TxnID` / `RefNumber` / `FullName` in the filter object when calling `session.queryEntity` directly. Tools translate from lowercase correctly. Verification scripts that invoke captured handlers get this for free; ad-hoc `queryEntity` calls in throwaway debug code do not.

## Post-Task Chores

When Item 20 lands: `npm run build` green, [REGRESSION_CHECKLIST.md](REGRESSION_CHECKLIST.md) walked (especially §3 Tool Surface for the new report tools, §4 QBXML Round-Trip for the `ReportRet` parsing path, §1 Build for the new builder/parser additions, existing `qb_ar_aging` / `qb_ap_aging` / `qb_balance_summary` / `qb_company_info` regressions still pass), Item 20 ticked in `todo.md`, `ACCEPTANCE_CRITERIA.md` entry written for Item 20 (acceptance: report period honored, sections in canonical AccountType order, NetIncome reconciles, Balance Sheet `asOfDate` honored, both modes structurally identical responses), Phase 5 status updated to "All Phase 5 done." Fresh `HANDOFF.md` pointing at the start of Phase 6 (Item 23 env semantics is the next quick win, then Item 25 is the bulk sweep).
