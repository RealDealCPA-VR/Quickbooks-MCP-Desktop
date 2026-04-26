# Handoff State

_Last updated: 2026-04-26_

## Last Session Summary

- **Closed Phase 5, Item 21 — `qb_balance_summary` canonical AccountType ordering + subtotals + advisory date range** ([todo.md:44](todo.md#L44) checked). The tool no longer returns an order-fragile `Record<string, ...>`; it now emits a canonically-ordered array with category subtotals and surfaces an advisory `asOfNote` when date params are passed. Three changes in [src/tools/reports.ts](src/tools/reports.ts):
  - **Canonical ordering constants** at [src/tools/reports.ts:11-26](src/tools/reports.ts#L11-L26). Six const arrays (`ASSET_TYPES`, `LIABILITY_TYPES`, `EQUITY_TYPES`, `INCOME_TYPES`, `EXPENSE_TYPES`, `NONPOSTING_TYPES`) compose into `CANONICAL_ACCOUNT_TYPES`, matching real QB's balance-summary report order: Bank → AccountsReceivable → OtherCurrentAsset → Inventory → FixedAsset → OtherAsset → AccountsPayable → CreditCard → OtherCurrentLiability → LongTermLiability → Equity → Income → OtherIncome → CostOfGoodsSold → Expense → OtherExpense → NonPosting. The same arrays double as the inputs to per-band subtotal sums (DRY).
  - **Tool rewrite** at [src/tools/reports.ts:79-176](src/tools/reports.ts#L79-L176). Bucket accounts by `AccountType` into a `Map`, then walk `CANONICAL_ACCOUNT_TYPES` to emit non-empty groups in order. Empty groups are skipped (operator-friendly — real QB also hides empty bands). Anything with an unrecognized AccountType lands in a trailing `Other` bucket so nothing is silently dropped. Subtotals block computed from the same buckets via a `sumOf(types)` helper. New optional zod params `fromDate` / `toDate` with regex `^\d{4}-\d{2}-\d{2}$`. When either is passed, `asOfDateRange` populates with the unset side as `null`, and a string `asOfNote` is appended explaining that simulation balances are a snapshot. When neither is passed, `asOfDateRange: null` and `asOfNote` is omitted (JSON.stringify drops the `undefined` key naturally). Wrapped in try/catch translating `QBXMLResponseError` → structured `{ success: false, statusCode, statusMessage }` with `isError: true` (Item 25 reference shape, mirroring `qb_company_info`).
  - **`round2` helper** at [src/tools/reports.ts:30](src/tools/reports.ts#L30). All numeric totals pass through it before serialization to keep float fuzz out of the response (e.g. `185000 + 72000 = 257000` rather than `257000.00000004`).
- **README updated** — `qb_balance_summary` row in the Reports & Queries table at [README.md:197](README.md#L197) now describes canonical ordering, subtotals, and the advisory date params.
- **ACCEPTANCE_CRITERIA.md** — Item 21 entry written and moved to Completed at the top of the Completed section. Phase 5 header updated to indicate Items 14 + 21 done, 19 + 20 still open.
- **No DECISIONS.md / ARCHITECTURE.md change** — canonical ordering is straight from QB's documented report layout, not a tradeoff. `runReport` was deliberately not touched (the handoff scope guard); that debt belongs with Item 20.
- **Verified.** `npm run build` green. Item 21 verification harness: 31/31 PASS. Coverage:
  - `qb_balance_summary({})` returns balanceSummary as a 6-element array in canonical order: Bank → AccountsReceivable → AccountsPayable → Income → CostOfGoodsSold → Expense.
  - Per-group totals match seed: Bank=165000 (Checking 45000 + Savings 120000), AccountsReceivable=26700, AccountsPayable=3700, Income=257000, CostOfGoodsSold=95000, Expense=184800.
  - Per-group account name lists preserve seed insertion order.
  - Subtotals: assets=191700, liabilities=3700, equity=0, income=257000, expenses=279800, **netIncome=−22800**.
  - `asOfDateRange === null` and `asOfNote` absent when no dates passed.
  - With `fromDate`+`toDate`: `asOfDateRange` populated, `asOfNote` mentions "Simulation mode", balances unchanged (advisory only).
  - With `fromDate` alone: `asOfDateRange.to === null`, `asOfNote` still present.
  - Zod schema (parsed directly via `z.object(schemaShape).safeParse`) rejects `"01/01/2026"`, accepts `"2026-01-01"`, accepts empty `{}`.
  - Regression: `totalAccounts: 10`, `qb_company_info` still returns the seeded Demo Co with auto-connect.

## Verify Before Continuing

- [ ] **Build.** `npm run build` exits 0.
- [ ] **`qb_balance_summary` returns canonical-ordered array.** No args; `body.balanceSummary` is an **array** (not object), entries `{ accountType, accounts, total }`. With seed: 6 groups in this exact order — `Bank`, `AccountsReceivable`, `AccountsPayable`, `Income`, `CostOfGoodsSold`, `Expense`. `body.balanceSummary[0].accountType === "Bank"` and `body.balanceSummary[0].total === 165000` are the cheap tripwires.
- [ ] **`qb_balance_summary` subtotals correct.** No args; `body.subtotals.netIncome === -22800` (single number that exercises the income−expenses calc end-to-end). `body.subtotals.assets === 191700`, `body.subtotals.liabilities === 3700`. Proves the per-band sumOf walks the right type lists.
- [ ] **`qb_balance_summary` date params populate `asOfDateRange` + `asOfNote`.** Call with `{ fromDate: "2026-01-01", toDate: "2026-04-26" }`. Returned `body.asOfDateRange.from === "2026-01-01"`, `body.asOfDateRange.to === "2026-04-26"`, `typeof body.asOfNote === "string"` and includes `"Simulation mode"`. Same call with no args → `body.asOfDateRange === null` and `"asOfNote" in body === false`. Proves the dateRangeRequested branch toggles correctly.
- [ ] **`qb_company_info` regression — still returns Demo Co.** Auto-connect path untouched.

## Next Task

**Phase 5, Item 19 — `asOfDate` filtering on `qb_ar_aging` / `qb_ap_aging` with 0-30 / 31-60 / 61-90 / 90+ buckets** ([todo.md:42](todo.md#L42)).

Current implementation lives at [src/tools/reports.ts:179-256](src/tools/reports.ts#L179-L256) (after the Item 21 rewrite shifted line numbers — verify by opening the file). Both tools currently:
1. Accept `asOfDate` as an optional `z.string()` arg.
2. Query `Customer` (or `Vendor`) entities filtered by `ActiveStatus: "ActiveOnly"`.
3. Return a list of customers/vendors with `Balance > 0`, sorted by balance desc.
4. **Ignore `asOfDate` entirely** (it just echoes back in the response).

That's not aging — it's a balance dump. Real aging walks **open transactions** (invoices for AR, bills for AP) and ages each one independently from its `DueDate` to `asOfDate`.

### Implementation shape

1. **Switch the data source.** Don't query Customer/Vendor balance fields — query open invoices (AR) and open bills (AP) directly:
   - AR: `session.queryEntity("Invoice", {})` then filter to `IsPaid === false` and `BalanceRemaining > 0`.
   - AP: `session.queryEntity("Bill", {})` then filter to `IsPaid === false` and `BalanceRemaining > 0`.
   - Both have `IsPaid` + `BalanceRemaining` populated by the simulation store today (Item 16 wired this for invoices, and the same compute path covers bills — verify in [src/session/simulation-store.ts](src/session/simulation-store.ts)). The HANDOFF.md regression suite already exercises invoice creation, so the open-invoice subset is reliable; bills less so (no seeded bills, only ones the operator creates in-session).
2. **Compute days outstanding per transaction.** For each open txn:
   - Effective due date = `txn.DueDate ?? txn.TxnDate` (DueDate is operator-supplied today; not all bills will have one — see Context Notes).
   - `daysOutstanding = floor((asOfDate − dueDate) / day)`. If `asOfDate < dueDate` → `daysOutstanding < 0` (the txn is "current," not yet due). Treat as `0-30` band (or carve out an explicit `Future` / `NotYetDue` band — see scope guard).
3. **Bucket boundaries** (real QB defaults):
   - `0-30`: `daysOutstanding <= 30` (includes future-dated and on-time).
   - `31-60`: `31 <= d <= 60`.
   - `61-90`: `61 <= d <= 90`.
   - `90+`: `d > 90`.
4. **Aggregate per customer/vendor.** Group open txns by `CustomerRef.FullName` (AR) / `VendorRef.FullName` (AP). For each party, emit:
   ```json
   {
     "name": "Acme Corporation",
     "balance": 7500,
     "buckets": { "current": 0, "31-60": 0, "61-90": 0, "90+": 7500 }
   }
   ```
   (or keep `0-30` keying — bikeshed pick whichever reads cleanly). Sort by total balance desc.
5. **Aggregate totals.** Top-level `bucketTotals: { "0-30": ..., "31-60": ..., "61-90": ..., "90+": ... }` summing across all parties. Plus existing `totalAccountsReceivable` / `totalAccountsPayable` (sum of all buckets).
6. **`asOfDate` default** — today's date in `YYYY-MM-DD`. Add the same regex validation pattern used in Item 21 (`ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/`); promote that constant to module scope if you haven't already, or copy it locally.

### Suggested response shape

```json
{
  "asOfDate": "2026-04-26",
  "totalAccountsReceivable": 26700,
  "bucketTotals": { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 26700 },
  "customers": [
    { "name": "Acme Corporation", "balance": 7500,
      "buckets": { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 7500 } },
    { "name": "Global Industries", "balance": 8500,
      "buckets": { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 8500 } }
  ]
}
```

(Same shape for AP, swap `customers` → `vendors`, `totalAccountsReceivable` → `totalAccountsPayable`.)

### Scope guards

- **Don't compute per-line aging.** A single invoice = a single bucket. Aging at the line-item level is not how QB's standard aging report works.
- **Don't pull from the Customer/Vendor `Balance` field.** That's a denormalized rollup — using it for aging double-counts when an operator partially-pays an invoice (the customer's `Balance` updates but you also need the per-invoice `BalanceRemaining`). The whole point of Item 19 is to walk the open transactions.
- **Don't wire DueDate computation from Terms.** Real QB derives `DueDate` from `TermsRef + TxnDate`. That's a separate piece of work. For Item 19, fall back to `TxnDate` when `DueDate` is missing and document it in the response (e.g. add a per-row `dueDateSource: "DueDate" | "TxnDate (fallback)"` if it helps debugging — optional).
- **Don't touch `runReport`.** Same scope guard as Item 21 — `runReport` is the Item 20 problem.

### After Item 19
- 20: P&L + Balance Sheet via `GeneralSummaryReportQueryRq`. The `runReport` path at [src/session/manager.ts:213-225](src/session/manager.ts#L213-L225) is still stub-shaped — Item 20 has to actually parse `ReportRet` rows. This is where the transaction-walk problem (the same one Item 19 surfaces in miniature) gets solved generically.
- After Phase 5 ships, Phase 6 plumbing items: 23 (env semantics), 25 (sweep tools to use the try/catch + `isError: true` shape that `qb_company_info` and `qb_balance_summary` already model), 26 (status code mapping), 27 (iterators), 28 (AccountType validation), 29 (input validation).

## Context Notes

- **Item 21 implementation details that affect future edits.**
  - Canonical-order constants live at module scope in [src/tools/reports.ts:11-26](src/tools/reports.ts#L11-L26). When Item 28 lands (validate `AccountType` enum on `qb_account_add`), reuse `CANONICAL_ACCOUNT_TYPES` as the source of truth — don't duplicate the list in another file.
  - The `Other` bucket at the end of `balanceSummary` is a future-proofing concern — if QB ever adds a new AccountType, accounts of that type will surface as `{ accountType: "Other", accounts: ["FullName [NewType]"], total: ... }` instead of being silently dropped. Don't remove this branch.
  - `round2` is intentionally local to `reports.ts`. If a third report tool starts needing it, lift it to a shared util — but two callers isn't enough to justify the move.
  - The shape change from `Record<string, ...>` to `Array<{ accountType, accounts, total }>` is intentionally breaking. Any future caller is expected to read by `accountType` field. No callers in the codebase today — the tool is consumed by an LLM via the MCP transport, which is fine with shape changes as long as the tool description stays accurate.
- **Open-transaction filtering for Item 19.**
  - The seed has 2 unpaid invoices: `T0000001-INV` (Acme, $7500, DueDate 2024-12-01) and `T0000002-INV` (Global Industries, $8500, DueDate 2024-12-15). Both are >90 days past due relative to today (2026-04-26), so the simplest sanity check is "AR aging puts $16,000 in the 90+ bucket and 0 elsewhere." The seeded customer `Balance` total is $26,700, which means there's $10,700 of phantom AR balance not backed by open invoices — that's expected (the seed sets customer balances independently from invoice history; that's a seed-data inconsistency that will surface once you switch the aging tool to walk invoices).
  - **No seeded bills.** AP aging will return an empty `vendors` array on a fresh process unless the operator creates bills first. Fine — but the verification harness for Item 19 should create at least one bill via `qb_bill_create` to exercise the AP path. Use the `qb_bill_create` tool with a `dueDate` that puts it into a known bucket.
  - `DueDate` is **operator-supplied** today, not auto-computed from Terms ([src/tools/bills.ts:190](src/tools/bills.ts#L190), [src/tools/bills.ts:266](src/tools/bills.ts#L266)). If `DueDate` is absent, fall back to `TxnDate`. Don't try to compute due dates from Terms — that's a separate piece of work (and a bigger one than it sounds; Terms can be standard or date-driven, see the seeded `StandardTerms` / `DateDrivenTerms` stores).
- **Project conventions reminder** ([CLAUDE.md](CLAUDE.md) § Stable Code Conventions): TS strict, ESM with `.js` extensions on relative imports, every zod field has `.describe()`, every tool registered in [src/index.ts](src/index.ts) and listed in the README tool table, structured tool errors via try/catch + `isError: true` + `statusCode` (Item 21 + Item 14 are the reference shapes — keep the rest of the tools converging on this).
- **Verification gotcha (carried)** — `handleQuery` filters require **uppercase** `TxnID` / `RefNumber` / `FullName` in the filter object when calling `session.queryEntity` directly. Tools translate from lowercase correctly. Verification scripts that invoke captured handlers get this for free; ad-hoc `queryEntity` calls in throwaway debug code do not.
- **Verification gotcha (new)** — handlers captured via the `fakeServer` pattern do NOT pass through zod validation (the MCP SDK's `server.tool` wraps the handler with the schema, and we capture only the inner handler). Item 19's harness should validate the zod schema separately by parsing it via `z.object(schemaShape).safeParse(...)` — see the Item 21 harness in the prior session's git diff for the exact pattern.

## Post-Task Chores

When Item 19 lands: `npm run build` green, [REGRESSION_CHECKLIST.md](REGRESSION_CHECKLIST.md) walked (especially §3 Tool Surface to confirm aging buckets sum correctly; §1 Build for any new helper modules; existing `qb_balance_summary` / `qb_company_info` regressions still pass), Item 19 ticked in `todo.md`, `ACCEPTANCE_CRITERIA.md` entry written for Item 19 (acceptance: bucket totals correct, per-party aging correct, asOfDate honored, fallback to TxnDate when DueDate absent), Phase 5 status updated to "Items 14, 19, 21 done — Item 20 still open." Fresh `HANDOFF.md` pointing at Item 20 (P&L / Balance Sheet via `GeneralSummaryReportQueryRq` + the `runReport` parse work).
