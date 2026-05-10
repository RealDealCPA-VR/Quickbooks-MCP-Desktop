# Acceptance Criteria

Per-task definition of "done." A task is complete only when its criteria are observably satisfied AND `REGRESSION_CHECKLIST.md` passes.

If criteria change during implementation, update them here in the same session — never silently move the goalposts.

Item numbers map to `todo.md`. Add criteria below as you pick up each task. Move completed entries to the bottom under "Completed."

---

## Template

```markdown
## Item N — <Short title> _(Phase X)_

**Status:** pending | in-progress | done | partial

**Behavioral criteria** _(observable, testable, no ambiguity)_:
- [ ] <Criterion 1 — describe what someone calling the tool sees>
- [ ] <Criterion 2>
- [ ] <Edge case>
- [ ] <Error case>

**Regression criteria** _(things that should still work after the change)_:
- [ ] <Adjacent tool / behavior that uses shared code>
- [ ] <Seed-data assumption that should still hold>

**Documentation criteria**:
- [ ] README updated if a tool was added/renamed/removed
- [ ] `instructions` block in src/index.ts updated if a tool surface changed
- [ ] `ARCHITECTURE.md` / `DECISIONS.md` / `REQUIREMENTS.md` updated if applicable

**Verification commands**:
```bash
npm run build
npm run dev   # in another terminal: exercise the tool through an MCP client
```

**Notes**: <gotchas, scope clarifications, follow-ups discovered>
```

---

## Phase 3 — Transaction completeness

_(All Phase 3 items complete — see Completed below.)_

---

## Phase 4 — Missing tools / coverage gaps

_(All Phase 4 in-scope items complete — Items 10, 11, 12, 13, 30. See Completed for entries. Item 24 (dead-code hygiene) and remaining Phase 4 plumbing items (23, 25-29) still open per `todo.md`.)_

---

## Phase 5 — Reporting

_(All Phase 5 items done — see Completed below.)_

---

## Phase 6 — Plumbing, validation, ergonomics

_(Items 23 + 25 + 26 + 27 + 28 + 29 done — see Completed below. Phase 6 fully closed.)_

---

## Phase 9 — Critical bug fixes

_(All Phase 9 items closed. Item 37 done 2026-05-09 — schema-order + live-adapter fix landed without an ACCEPTANCE_CRITERIA entry; the canonical regression sits in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts) and [tests/report-adapter.test.ts](tests/report-adapter.test.ts). Items 38 + 39 done 2026-05-09 — see Completed below.)_

---

_(Don't pre-write criteria for distant tasks — they tend to drift before implementation, and writing them up-front wastes effort if priorities shift.)_

---

## Completed

_(Move entries here when criteria are satisfied. Keep the criteria list intact — it's the historical record of what "done" meant for that task.)_

---

### Item 41 — Line-level detail in `*_list` responses (`includeLineItems`) _(Phase 10)_ — done 2026-05-09

**Status:** done

**Behavioral criteria** _(observable, testable, no ambiguity)_:
- [x] Optional `includeLineItems: boolean` arg added to seven list tools — `qb_invoice_list`, `qb_bill_list`, `qb_sales_receipt_list`, `qb_credit_memo_list`, `qb_purchase_order_list`, `qb_estimate_list`, `qb_journal_entry_list`. Default `false`. Scope expanded from the HANDOFF's six-tool plan to include `qb_journal_entry_list` because the existing JE tool description already promised lines on every row, which conflicted with the strip-by-default behavior — adding the JE opt-in keeps the description honest.
- [x] When the arg is omitted or `false`, list responses return header fields only — matches real QB's `*QueryRq` default behavior. Each row carries `TxnID`, `RefNumber`, `TxnDate`, `CustomerRef` / `VendorRef`, `Subtotal` / `AmountDue` / `BalanceRemaining` / `IsPaid` (where applicable), `EditSequence`, but no `*LineRet` arrays.
- [x] When the arg is `true`, list responses surface the type-specific `*LineRet` array(s) on each row: `InvoiceLineRet`, `ExpenseLineRet` + `ItemLineRet` (Bill carries both), `SalesReceiptLineRet`, `CreditMemoLineRet`, `PurchaseOrderLineRet`, `EstimateLineRet`, `JournalDebitLineRet` + `JournalCreditLineRet`. Each `*LineRet` row carries `TxnLineID` + `Amount` + entity-type-specific fields per Item 17.
- [x] Tool layer threads `IncludeLineItems = true` into the filter dict at the schema-required position (after every other filter the tool emits, before the implicit `IncludeLinkedTxns` slot). Pinned at the wire level in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts) for InvoiceQueryRq, BillQueryRq, JournalEntryQueryRq, and (looped) Estimate / SalesReceipt / CreditMemo / PurchaseOrder QueryRqs.
- [x] Tool layer threads `IncludeLineItems` ONLY when the arg is truthy — `includeLineItems: false` (explicit) and `undefined` both omit the wire flag. Pinned via `vi.spyOn(session, "queryEntity")` reading `Object.keys(filters)` in [tests/include-line-items.test.ts](tests/include-line-items.test.ts).
- [x] Sim `handleQuery` strips `*LineRet` / `*LinesRet` keys from each result entity by default (regex `/Line(s?)Ret$/`). When the request body carries `IncludeLineItems` truthy (boolean `true` for in-process callers, string `"true"` for the wire form after a fast-xml-parser round trip), the strip is skipped. Both shapes pinned in [tests/include-line-items.test.ts](tests/include-line-items.test.ts).
- [x] Header-level fields computed FROM lines (`Subtotal`, `AmountDue`, `BalanceRemaining`, `IsPaid`, `TotalDebit`, `TotalCredit`, `AppliedAmount`, `TotalAmount`) survive the strip — those are header fields, not line fields, even though they're derived from the line set.
- [x] `AppliedToTxnRet` (the credit-memo / payment-application relationship array) survives the strip — its key does not match the regex (no "Line" segment). Confirmed via tests. The strip is line-data-specific, not relationship-data-generic.

**Regression criteria** _(things that should still work after the change)_:
- [x] `qb_estimate_convert_to_invoice` ([src/tools/estimates.ts](src/tools/estimates.ts)) reads `EstimateLineRet` from a `queryEntity` response to map onto `InvoiceLineAdd`. Updated to internally pass `IncludeLineItems: true` so the strip-by-default doesn't break the convert flow. Pinned in [tests/include-line-items.test.ts](tests/include-line-items.test.ts) — convert preserves the source estimate's line amounts on the new invoice (4×125 + 2×200 ≡ 500 + 400).
- [x] AR / AP aging (`qb_ar_aging` / `qb_ap_aging` in [src/tools/reports.ts](src/tools/reports.ts)) call `queryEntity("Invoice", {})` / `queryEntity("Bill", {})` for header-only data (`IsPaid`, `BalanceRemaining`, `DueDate`, `CustomerRef` / `VendorRef`). Unaffected by the strip — never read line data.
- [x] Report walks (`buildPnLReport`, `buildBalanceSheetReport`, `buildBalanceSummary`, `handleTransactionQuery`) read entities directly via `getStore` — they bypass `handleQuery` entirely. The strip-by-default change does not touch the report path.
- [x] Add-side response (the entity returned from `addEntity`) is unchanged — `*LineRet` arrays still appear on the create response since `addEntity` doesn't route through `handleQuery`. Existing simulation-store tests (`Item 17 — InvoiceLineAdd → InvoiceLineRet conversion`) still pass.
- [x] Iterator tests still pass — iterator state on the request element (`@_iterator` / `@_iteratorID` attributes) is unaffected by the IncludeLineItems gate.
- [x] `npm run build` clean. `npm test` → 11 files / 286 tests passed (was 10 / 244; +1 file `include-line-items.test.ts` with 39 new tests + 3 new tests in `builder-emit-order.test.ts`).

**Documentation criteria**:
- [x] Tool descriptions on all seven list tools updated to surface the `includeLineItems` arg + its default-off behavior. Per-arg `.describe()` strings mirror the description language for consistency.
- [x] No `instructions` block change in [src/index.ts](src/index.ts) — `includeLineItems` is a per-tool ergonomics layer, not a new top-level surface.
- [x] No `DECISIONS.md` change — matches established Phase 6 patterns (default-off opt-in args). The line-strip-by-default behavior matches real QB exactly, so there's no novel sim-fidelity tradeoff to document.
- [x] No `ARCHITECTURE.md` / `REQUIREMENTS.md` change — this enriches an existing tool surface; no boundary moved, no product behavior redefined.
- [x] No README tool-count bump — #41 enriches existing tools rather than adding new ones. Tool count remains 75.

**Verification commands**:
```bash
npm run build              # TypeScript clean
npm test                   # 286/286 (incl. 42 net new across include-line-items.test.ts + builder-emit-order.test.ts)
"" | & node dist/index.js  # Server startup; tool list unchanged at 75
# Live (Windows + QB) — pending live exercise:
# Through Claude Desktop: qb_invoice_list({ fromDate: "2024-01-01", toDate: "2024-12-31", includeLineItems: true })
# Expect: rows from FY2024 invoices each carrying an InvoiceLineRet array with item / qty / rate / amount / TxnLineID per line. Default call without includeLineItems returns same row count, header-only.
```

**Notes**:
- Behavior change for any pre-#41 caller that relied on the sim returning lines on `qb_*_list` without the flag: those callers now get header-only by default. The fix is one-line: add `includeLineItems: true` to the call. This is acceptable because (a) live QB had this contract all along — pre-#41 callers in live mode were already getting header-only, (b) the sim was the outlier silently leaking line data, and (c) the personal-tool standard (CLAUDE.md) doesn't require backwards-compatibility shims.
- The vi.spyOn pattern (now used in 3 test files: iterator.test.ts Layer 8, transaction-list.test.ts, include-line-items.test.ts) is the canonical way to assert tool-layer transformations on the args before they hit the manager. Cleaner than asserting on built XML or sim behavior because it isolates the tool contract.
- The `JournalEntry` opt-in is a minor scope expansion vs the HANDOFF's six-tool plan. Without it the JE tool description ("Each entry carries JournalDebitLineRet + JournalCreditLineRet arrays") would have become a lie in sim mode (and was already a lie in live mode). Adding the opt-in keeps the contract honest in both modes for trivial extra cost.
- Per-tool tests live in [tests/include-line-items.test.ts](tests/include-line-items.test.ts) under three describe blocks: (1) sim contract (header-only by default, lines on opt-in), (2) tool layer filter dict (omits / includes / explicit-false handling), (3) sim gate truthy semantics (boolean true, wire string "true", missing). Plus a separate block pinning the `qb_estimate_convert_to_invoice` regression.
- Wire-level schema-order pins live in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts) — InvoiceQueryRq + BillQueryRq each get their own test (PaidStatus is in the sequence, IncludeLineItems sits after it); JournalEntryQueryRq gets its own (no PaidStatus, IncludeLineItems sits after TxnDateRangeFilter); the four no-PaidStatus types (Estimate / SalesReceipt / CreditMemo / PurchaseOrder) share a looped test because their tail position is identical.

---

### Item 40 — `qb_transaction_list_by_account` _(Phase 10)_ — done 2026-05-09

**Status:** done

**Behavioral criteria** _(observable, testable, no ambiguity)_:
- [x] New tool `qb_transaction_list_by_account` registered alongside the rest in [src/tools/transactions.ts](src/tools/transactions.ts) (new file). Wired in [src/index.ts](src/index.ts); tool 75. Top-level `instructions` block documents the surface explicitly (sign convention + sim line-level limitation).
- [x] Required input: either `accountName` (FullName) or `accountListId`. Calling without either returns `{ success: false, error: "Either accountName or accountListId is required" }` with `isError: true` — does NOT round-trip to the sim / live wire.
- [x] Optional inputs: `fromDate` / `toDate` (ISO `YYYY-MM-DD`, schema-validated), `maxReturned` (number), `includeRunningBalance` (boolean, default true).
- [x] Tool layer populates filters in TransactionQueryRq schema-required child order: `MaxReturned → TxnDateRangeFilter → AccountFilter`. Pinned in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts) and verified at the tool layer via `vi.spyOn(session, "queryTransactions")` reading `Object.keys(filters)`.
- [x] Manager exposes `queryTransactions(filters)` as a thin wrapper over `queryEntity("Transaction", filters)` — keeps the "tools never construct QBXML directly" rule intact (CLAUDE.md). Returns `Record<string, unknown>[]` (TransactionRet rows).
- [x] Simulation handler `handleTransactionQuery` in [src/session/simulation-store.ts](src/session/simulation-store.ts) routed via `key === "TransactionQueryRq"` (NOT the generic `handleQuery` per-type path, which would hit a non-existent "Transaction" store and return empty). Fans out across Invoice / SalesReceipt / CreditMemo (income via item resolution) + Bill / Check (expense+item lines) + JournalEntry (debit + credit lines with account-natural-direction sign convention). Emits one TransactionRet per matching line with `{ TxnID, TxnType, TxnDate, Account: { FullName }, Amount (signed), RefNumber?, Memo?, Entity: { FullName }?, TimeCreated, TimeModified }`. Sorted by TxnDate ascending with TimeCreated tiebreaker.
- [x] Sign convention: positive Amount = increases the target account's natural balance. Bill ExpenseLine on Rent Expense (natural-debit) → +Amount. CreditMemo line on Sales Revenue (natural-credit) → -Amount. JE debit on natural-debit account → +Amount; JE debit on natural-credit account → -Amount. Pinned in [tests/transaction-list.test.ts](tests/transaction-list.test.ts).
- [x] AccountFilter resolves both shapes — `{ FullName }` direct, `{ ListID }` canonicalized to FullName via the Account store. Missing AccountFilter rejects with `statusCode 3120` ("There is a missing element: AccountFilter").
- [x] Response shape: `{ count, account, fromDate, toDate, currentBalance?, openingBalance?, runningBalanceError?, transactions: TransactionRet[] }`. When `includeRunningBalance` is unset/true and the AccountQueryRq succeeds, every row carries `RunningBalance` in addition to `Amount`.
- [x] Running-balance math (per HANDOFF guidance): `openingBalance = currentBalance − Σ period postings`, walks forward per row. Exact when `toDate ≥ now`; approximate (overstated by post-period postings) for historical windows — documented limitation in tool description and code comment. `includeRunningBalance: false` opts out of the AccountQueryRq round trip; response then omits `currentBalance` / `openingBalance` / per-row `RunningBalance`.
- [x] Empty result (no matching rows) returns `{ count: 0, transactions: [] }` (NOT an error) so callers can distinguish "no activity" from "request failed."
- [x] Tool wraps `queryTransactions` + the optional `queryEntity("Account", ...)` in try/catch translating `QBXMLResponseError` → `{ success: false, statusCode, statusMessage, humanReadable? }` with `isError: true` (Item 25 reference shape). Running-balance failures (e.g. account lookup throws) are caught separately and surfaced as `runningBalanceError` in the otherwise-successful response — the row list is preserved.

**Regression criteria** _(things that should still work after the change)_:
- [x] Parser registers `TransactionRet` in `arrayElements` so single-row responses parse as `TransactionRet: [...]` (consistent with every other entity Ret). No other parser change.
- [x] Generic per-type query path (`handleQuery`) is untouched — the routing change is `if (key === "TransactionQueryRq") handleTransactionQuery else handleQuery`. Per-type list tools (`qb_invoice_list`, `qb_bill_list`, etc.) work identically.
- [x] The seed snapshot semantics are preserved — `handleAdd` does NOT mutate `Account.Balance` (matches real QB, where `Account.Balance` is computed from posting history rather than incremented in-place). The running-balance test exploits this: after 3 postings totaling +4600 to Rent Expense (seed Balance 24000), the closing RunningBalance walks back to exactly 24000 — confirming opening was correctly computed as `24000 − 4600 = 19400`.
- [x] `npm run build` clean. `npm test` → 10 files / 244 tests passed (was 9 / 228; +1 file `transaction-list.test.ts` with 15 new tests + 1 new test in `builder-emit-order.test.ts` Layer for the schema-order pin = 16 net additions).

**Documentation criteria**:
- [x] README "Reports & Queries" table gets a new `qb_transaction_list_by_account` row covering the running-balance algorithm, sign convention, sim line-level limitation, and arg surface. Tool count bumped from 70 → 75 (count was stale by 4 prior tools too — corrected on this change).
- [x] `instructions` block in [src/index.ts](src/index.ts) gets a dedicated bullet — sits above the Reports section since it's a cross-type query rather than a summary report.
- [x] No `DECISIONS.md` entry — the cross-type-fanout sim-fidelity tradeoff (line-level only, no implicit AR/AP counter-postings) is documented inline in the tool description and `handleTransactionQuery` jsdoc, not as a sweeping architectural decision. If/when we extend sim to surface implicit counter-postings (Phase 17 banking primitives might force this), a DECISIONS entry will land then.
- [x] No `ARCHITECTURE.md` change — `queryTransactions` slots alongside `queryEntity` / `queryEntityPaginated` as another method on QBSessionManager; no new layer or boundary introduced.
- [x] No `REQUIREMENTS.md` change — this exposes existing QB capability rather than redefining product behavior.

**Verification commands**:
```bash
npm run build              # TypeScript clean
npm test                   # 244/244 (incl. 16 net new across transaction-list.test.ts + builder-emit-order.test.ts)
"" | & node dist/index.js  # Server startup; tool list now includes qb_transaction_list_by_account
# Live (Windows + QB) — pending live exercise:
# Through Claude Desktop: qb_transaction_list_by_account({ accountName: "Rent Expense", fromDate: "2024-01-01", toDate: "2024-12-31" })
# Expect: rows from Bill / Check / JE that posted to Rent Expense in FY2024, sorted by TxnDate, with RunningBalance walking from openingBalance to a value within ±0.01 of the account's current Balance.
```

**Notes**:
- Sim emits LINE-LEVEL postings only — the documented first-cut limitation. Filtering the sim by AR / AP / Bank / CC returns empty unless you explicitly post to those accounts via JournalEntry (which DOES carry direct AccountRef). Live QB returns the full posting tree without this limitation. Operators using the sim for dev should populate test scenarios via JE if they need balance-sheet-account postings to surface in this view.
- The HANDOFF math (`opening = currentBalance − periodSum`) is exact when `toDate ≥ now`. For historical period queries with subsequent postings, the alternative (fetch full history, slice in tool) trades a wider round trip for exact values — deferred. Tool description tells operators to omit `toDate` to skip the approximation.
- `queryTransactions` is the first cross-type query method on QBSessionManager. If Phase 16 #72 (`qb_transaction_list({ types: [...], filters })`) lands, the same method underlies it — just with `TransactionTypeFilter` populated. Schema-order is already pinned for that future extension.
- 16 net new tests vs 244 total. The vi.spyOn pattern from #39 (assert filter-dict order before it hits the builder) carries forward — used here to pin TransactionQueryRq schema order at the tool layer in addition to the wire-level pin in builder-emit-order.test.ts.

---

### Item 39 — Pagination DX: default `maxReturned=500` when `paginate: true` _(Phase 9)_ — done 2026-05-09

**Status:** done

**Behavioral criteria** _(observable, testable, no ambiguity)_:
- [x] Calling any list tool with `paginate: true` and no `maxReturned` no longer requires the caller to also pass `maxReturned`. The tool layer coalesces an unset `maxReturned` to 500 (QB's effective per-batch cap) before calling `session.queryEntityPaginated`.
- [x] Default-coalesce applies to all four tools that expose `paginate`: `qb_customer_list`, `qb_invoice_list`, `qb_bill_list`, `qb_item_list`.
- [x] An explicit `maxReturned` value still wins — `paginate: true, maxReturned: 50` sends `<MaxReturned>50</MaxReturned>`, NOT 500.
- [x] `iteratorID` alone (without `paginate: true`) also implies pagination, so the same default applies — a Continue call with no `maxReturned` gets 500.
- [x] Non-paginated calls are untouched — `qb_customer_list({})` still calls `session.queryEntity` with no `MaxReturned` filter (would be a regression to silently inject 500 into the legacy path).
- [x] Tool descriptions surface the default — `paginate` description ends with "Auto-defaults maxReturned to 500 if unset." and `maxReturned` description notes "Defaults to 500 when paginate is enabled (QB's per-batch cap); otherwise QB-driven."

**Regression criteria** _(things that should still work after the change)_:
- [x] `qb_customer_list({})` without paginate → no `MaxReturned` filter set; legacy path through `queryEntity` unchanged.
- [x] `qb_invoice_list({ maxReturned: 25 })` without paginate → `MaxReturned=25` passes through unchanged.
- [x] `qb_item_list({ paginate: true })` (no `itemType`) still refuses with the structured `{ success: false, error: "..." }` shape from Item 27 — pagination still requires `itemType` regardless of the new default.
- [x] Schema-required child order in the QBXML envelope is preserved — `MaxReturned` still emits at position 2 (after `TxnID` / `RefNumber` selectors), per the `<xs:sequence>` order pinned in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts).
- [x] Layer 5 + Layer 6 iterator tool tests in [tests/iterator.test.ts](tests/iterator.test.ts) still pass — pagination Start → Continue → exhausted loop unchanged.
- [x] `npm run build` passes. `npm test` → 9 files / 228 tests passed (was 9 / 214; +14 new in the new "Layer 8" describe block).

**Documentation criteria**:
- [x] Tool descriptions on all four tools (`qb_customer_list`, `qb_invoice_list`, `qb_bill_list`, `qb_item_list`) updated to surface the 500 default — both the top-level tool description and the per-arg `paginate` / `maxReturned` `.describe()` strings.
- [x] No README change needed — pagination cap was already documented as "real QB caps each *QueryRq response at ~500 rows" in the Item 27 entry; the new default just makes that the visible behavior of the tool surface.
- [x] No `instructions` block update in [src/index.ts](src/index.ts) needed — pagination remains a per-tool ergonomics layer.
- [x] No `ARCHITECTURE.md` / `DECISIONS.md` / `REQUIREMENTS.md` change — this is a default-value tweak inside an established pattern, no new tradeoff or product behavior.

**Verification commands**:
```bash
npm run build              # TypeScript clean
npm test                   # 228/228 (incl. 14 new in iterator.test.ts Layer 8)
"" | & node dist/index.js  # Server startup; tool list still includes all four list tools
```

**Notes**:
- The "missing element: MaxReturned" error message rewrite (overlapping with Item 65 — better error surfaces) was scoped out of #39 deliberately. With the default in place, callers who pass `paginate: true` alone never hit the error in the first place. Item 65 will still address the error-rewrite for callers who explicitly pass `paginate: true, maxReturned: 0` or otherwise manage to trigger the original QB rejection.
- Five files touched: [src/tools/customers.ts](src/tools/customers.ts), [src/tools/invoices.ts](src/tools/invoices.ts), [src/tools/bills.ts](src/tools/bills.ts), [src/tools/items.ts](src/tools/items.ts), [tests/iterator.test.ts](tests/iterator.test.ts). No production logic moved between layers — the coalesce sits at the tool handler, NOT at the manager / builder layer, so other paths into `queryEntityPaginated` (e.g. future tools, direct manager use in tests) get explicit control over `MaxReturned` rather than inheriting the default.
- Phase 9 fully closed with #39. Phase 10 #40 (`qb_transaction_list_by_account`) is the next biggest operator ask and would close out the P0 surface before Phase 11 reports.

---

### Item 38 — `qb_balance_summary` `asOfDate` honored via BS + P&L reports _(Phase 9)_ — done 2026-05-09

**Status:** done

**Behavioral criteria** _(observable, testable, no ambiguity)_:
- [x] Tool params replaced: dropped `fromDate` / `toDate` (both were silently ignored pre-#38). New params: `asOfDate` (optional, ISO `YYYY-MM-DD`, defaults to today UTC) + `basis` (optional `"Accrual" | "Cash"`, defaults to `"Accrual"`). Schema still rejects `MM/DD/YYYY` and `YYYY/MM/DD`.
- [x] Tool sources Asset / Liability / Equity per-account totals from `runReport("BalanceSheetStandard", { toDate: asOfDate, basis })`. Sources Income / Expense per-account totals from `runReport("ProfitAndLossStandard", { toDate: asOfDate, basis })` (no `fromDate` — lifetime through `asOfDate`). Calls are sequential (QBXMLRP2 serializes COM calls; sequential avoids parallel-openSession races in live mode).
- [x] AccountQuery still runs (single call) to populate the name → AccountType lookup. The 16-way canonical bucketing (Bank → AccountsReceivable → ... → Equity → Income → ... → NonPosting) is preserved by joining the BS / P&L per-account totals back to the chart-of-accounts type.
- [x] BS Equity synthetic rows (`Net Income`, `Balancing Adjustment (simulation seed gap)`) are filtered out of `balanceSummary` to avoid double-counting. They're already accounted for in `subtotals.netIncome` / `subtotals.equity`.
- [x] NonPosting accounts (estimates, POs, sales orders) — absent from BS and P&L because they don't post to GL — fall back to `Account.Balance`. Same signal QB itself surfaces on the chart of accounts for these account types.
- [x] Subtotals come from the report Totals blocks: `assets = bsTotals.TotalAssets`, `liabilities = bsTotals.TotalLiabilities`, `equity = bsTotals.TotalEquity`, `income = pnlTotals.TotalIncome`, `expenses = pnlTotals.TotalExpenses`, `netIncome = pnlTotals.NetIncome`.
- [x] Response shape: `{ asOfDate, reportBasis, balanceSummary: [{ accountType, accounts, total }], subtotals, totalAccounts }`. The misleading `asOfNote` and `asOfDateRange` from Item 21 are gone.
- [x] Bucket logic extracted as exported `buildBalanceSummary` in [src/tools/reports.ts](src/tools/reports.ts) for direct unit testing (same pattern as `adaptLiveReportRet`).
- [x] Tool wrapped in try/catch translating `QBXMLResponseError` → `{ success: false, statusCode, statusMessage, humanReadable? }` with `isError: true` (Item 25 reference shape).

**Regression criteria** _(things that should still work after the change)_:
- [x] `qb_balance_summary` (no args) on fresh seed: Bank bucket first, total 165000 (Checking 45k + Savings 120k), AR bucket present @ 26700, AP bucket present @ 3700. `subtotals.assets === 191700`, `subtotals.liabilities === 3700`. Pinned in [tests/balance-summary.test.ts](tests/balance-summary.test.ts).
- [x] `qb_balance_summary` `subtotals.income / .expenses / .netIncome` now reflect the actual P&L walk. With seed (which carries no invoice / bill line arrays) all three are 0. **Supersedes Item 21's regression criterion of `subtotals.netIncome === -22800`** — that number was read from arbitrary seeded `Account.Balance` fields not backed by transactions; the new value is the truthful walk. [scripts/verify-pickup-2026-04-27.mjs](scripts/verify-pickup-2026-04-27.mjs) updated to assert the new contract (Bank-first @ 165000, `asOfDate` present).
- [x] `qb_balance_sheet_report` and `qb_pnl_report` unchanged — the new tool composes them rather than replacing them. The 2026-05-09 row-tree adapter ([src/qbxml/parser.ts](src/qbxml/parser.ts) `adaptLiveReportRet`) is now exercised on every `qb_balance_summary` call in live mode.
- [x] `qb_ar_aging` / `qb_ap_aging` / `qb_company_info` / `qb_account_list` paths unchanged — only `qb_balance_summary` rerouted.
- [x] `npm run build` passes. `npm test` → 9 files / 214 tests passed (was 8 / 199; +1 file `balance-summary.test.ts` with 15 new tests).

**Documentation criteria**:
- [x] README "Reports & Queries" table updated — `qb_balance_summary` row reflects the BS + P&L sourcing and the new `asOfDate` / `basis` params.
- [x] `instructions` block in [src/index.ts](src/index.ts) updated — the `qb_balance_summary / qb_ar_aging / qb_ap_aging` line covers the new BS + P&L composition path explicitly.
- [x] [DECISIONS.md](DECISIONS.md) entry — "qb_balance_summary sources AS/LI/EQ from BalanceSheetStandard and INC/EXP from ProfitAndLossStandard" — covers the two-report compose, alternatives rejected (drop INC/EXP / sim-only walk / keep `fromDate`), tradeoffs (sim asOfDate advisory for AS/LI/EQ; INC/EXP buckets disappear when P&L empty; two reports per call), and revisit trigger (Item 68 `qb_trial_balance_export`).
- [x] No `ARCHITECTURE.md` change — the report path was already established (Item 20 + 2026-05-09 adapter). #38 just composes existing primitives.

**Verification commands**:
```bash
npm run build              # TypeScript clean
npm test                   # 214/214 (incl. 15 new in balance-summary.test.ts)
"" | & node dist/index.js  # Server startup; tool list still includes qb_balance_summary
# Live (Windows + QB):
"C:/nvm4w/nodejs/node.exe" scripts/exercise-mcp-live.mjs  # 28/28 read-only tools (was 25/25; +3 balance_summary probes)
```

**Notes**:
- Sim caveat preserved: BalanceSheetStandard reads `Account.Balance` for AS/LI/EQ in simulation (snapshot — `asOfDate` is advisory there). The P&L walk IS date-bounded in both modes. Same caveat `qb_balance_sheet_report` already documents.
- The sim's seeded `Account.Balance` for income / expense accounts (Sales Revenue=185000, Consulting Revenue=72000, etc.) is now ignored by `qb_balance_summary`. The seeded invoices have `Subtotal` but no line arrays — so the P&L walk yields 0. This is the intended truthful behavior; the "phantom AR" $26,700 - the seed gap that the BS Balancing-Adjustment row reconciles - shows up in `subtotals.equity` (188000 = 191700 assets − 3700 liabilities + 0 net income) rather than disappearing silently.
- Item 39 (`paginate: true` defaulting `maxReturned=500`) is the next quick win after #38; queued in `todo.md`.

---

### Item 27 — IteratorID / IteratorRemainingCount support on large queries _(Phase 6)_ — done 2026-04-27

**Status:** done

**Behavioral criteria** _(observable, testable, no ambiguity)_:
- [x] `buildQueryRequest(entity, filters, { iterator: "Start" | "Continue" | "Stop", iteratorID? })` emits the iterator state as XML attributes on the `*QueryRq` element (e.g. `<CustomerQueryRq requestID="1" iterator="Continue" iteratorID="{abc}">`), NOT as child elements. requestID, filter children, and iterator attributes coexist on the same element.
- [x] iteratorID values are XML-escaped when serialized (defensive — real QB iteratorIDs are GUIDs but the contract is "opaque string").
- [x] `parseQBXMLResponse` surfaces `@_iteratorRemainingCount` and `@_iteratorID` from `*QueryRs` envelopes onto `QBXMLResponseBody.iteratorRemainingCount` (number) and `iteratorID` (string). `iteratorRemainingCount=0` (exhausted) round-trips correctly and is distinct from "absent."
- [x] Responses without iterator attributes have neither field on the parsed `QBXMLResponseBody` (regression invariant — only set when the server explicitly emitted them).
- [x] New `QBSessionManager.queryEntityPaginated(entity, filters, { iterator?, iteratorID? })` returns `{ entities, iteratorRemainingCount?, iteratorID? }`. Existing `queryEntity()` signature is unchanged — pure-additive API.
- [x] Simulation `iterator="Start"` returns the full result set in one shot with `iteratorRemainingCount=0` and a synthesized `iteratorID` like `SIM-ITER-<time>-<rand>`. Sim does not actually page (seed data is small); the contract still matches what real QB looks like on a final page.
- [x] Simulation `iterator="Continue"` and `iterator="Stop"` return `statusCode=1` empty data with no iterator metadata, mirroring how real QB treats an exhausted iterator.
- [x] Tools `qb_customer_list`, `qb_invoice_list`, `qb_bill_list` accept `paginate?: boolean` + `iteratorID?: string`. When either is set, the response surfaces `iteratorRemainingCount` and `iteratorID` (when present) alongside the result array.
- [x] `qb_item_list` accepts `paginate` + `iteratorID` but REQUIRES `itemType` when paginating — iterators are scoped to a single `Item*QueryRq`, so the multi-subtype fan-out path cannot paginate. Refusal returns `isError: true` with a structured `{ success: false, error: "..." }` payload before any session call.
- [x] Caller's pagination loop: Start → response with iteratorID → Continue with that iteratorID until `iteratorRemainingCount === 0` or absent. The two-step loop completes correctly through the simulation.

**Regression criteria** _(things that should still work after the change)_:
- [x] Non-paginated calls to `qb_customer_list` / `qb_invoice_list` / `qb_bill_list` / `qb_item_list` produce the EXACT same JSON shape as before — no `iteratorRemainingCount` or `iteratorID` keys leak into the default-path response.
- [x] `qb_item_list` multi-subtype fan-out (no `itemType`, no `paginate`) still works and merges across all 5 stores.
- [x] All other tools (`qb_account_list`, `qb_vendor_list`, `qb_estimate_list`, `qb_payment_list`, `qb_employee_list`, etc.) are untouched — they call `queryEntity` (legacy), which now passes `{ version }` instead of `version` directly to `buildQueryRequest`. The signature change is internal.
- [x] Item 25/26 wrapper still fires for `*Query*` calls — manager's `queryEntityPaginated` re-throws `QBXMLResponseError` on hard failure, so tool wrappers translate it correctly.
- [x] Item 29 schema validation still fires before the iterator path — `paginate: "yes"` would still be rejected by zod (boolean, not string).
- [x] All four prior harnesses pass: env-matrix 99/99, pickup 7/7, error-shape 47/47, input-validation 44/44.

**Documentation criteria**:
- [x] No README change needed — pagination is an opt-in flag on existing tools, not a new tool. (The `qb_*_list` tool count and table are unchanged.)
- [x] `instructions` block in `src/index.ts` not affected — pagination is a per-tool ergonomics layer, not a new capability surface.
- [x] No `ARCHITECTURE.md` change — the QBXML envelope shape is unchanged; iterator attrs are part of the existing request-element contract. The two-mode session and tool-registration boundaries are untouched.
- [x] No `DECISIONS.md` entry — the simpler-strategy choice (sim returns all in one shot) was already pre-approved in the HANDOFF outline, no new tradeoff to record.
- [x] No `REQUIREMENTS.md` change — pagination is a wire-protocol fidelity feature, not a product behavior change.

**Verification commands**:
```bash
npm run build
node scripts/verify-item27-iterator.mjs        # 27/27 pass
node scripts/verify-item29-input-validation.mjs # 44/44 pass (regression guard)
node scripts/verify-item25-error-shape.mjs      # 47/47 pass (regression guard)
node scripts/verify-pickup-2026-04-27.mjs       # 7/7 pass (regression guard)
node scripts/verify-item23-env-matrix.mjs       # 99/99 pass (regression guard)
```

**Notes**:
- The simpler-strategy simulation (return everything on Start, exhausted on Continue) is faithful enough for dev. If seed data ever grows past 500 records, switch to the faithful strategy: maintain a session-scoped iterator-state map keyed by iteratorID with cursor + page size. Until then, the contract round-trips cleanly.
- `buildQueryRequest`'s 3rd arg signature changed from `version?: string` to `options?: { version?, iterator?, iteratorID? }`. The only caller was `manager.ts` (queryEntity + new queryEntityPaginated); both updated. Other builder helpers (`buildAddRequest`, `buildModRequest`, `buildDeleteRequest`, `buildReportRequest`) keep the legacy `version?: string` 3rd arg — only `buildQueryRequest` supports iterator.
- `QBXMLRequestBody.attributes?: Record<string, string>` is the generic mechanism — currently only used for iterator state, but extends naturally if future QBXML versions add other request-element attributes.
- `iteratorRemainingCount === 0` and "absent" mean different things: 0 = "you got the last page, iterator drained on this response"; absent = "this wasn't an iterator request, or the iterator was already drained on a prior request." The harness has explicit assertions for both.
- The items-pagination refusal lives at the handler layer (not zod refinement) so the error message can explain WHY pagination needs itemType. Following the bills.ts pre-flight pattern from Phase 3.
- Wire-level round-trip assertion (builder → sim → response) is the load-bearing one: it proves the three layers agree on `@_iterator` / `@_iteratorID` attribute names on the request side and `@_iteratorRemainingCount` / `@_iteratorID` on the response side. Two separate naming conventions (request vs response) — both verified end-to-end.

---

### Item 29 — Input format validation: email / phone / postal / ISO date _(Phase 6)_ — done 2026-04-27

**Status:** done

**Behavioral criteria** _(observable, testable, no ambiguity)_:
- [x] Every `txnDate` / `dueDate` / `fromDate` / `toDate` / `asOfDate` / `hiredDate` / `invoiceTxnDate` / `invoiceDueDate` field across the tool surface rejects malformed input at the zod layer with `code: "invalid_string"` and the field name on `path[0]`. Confirmed: 11 representative tools (invoice/bill/estimate/sales-receipt/credit-memo/PO/JE/payment create + invoice list filter + employee add hiredDate + 3 reports) all reject malformed dates.
- [x] Every contact-bearing tool (`qb_customer_add`/`update`, `qb_vendor_add`/`update`, `qb_employee_add`/`update`) rejects malformed `email` at zod (no `@`, no domain, leading/trailing `@`) with `code: "invalid_string"`.
- [x] The same surfaces reject letters-only or too-short `phone` strings.
- [x] `qb_customer_add` (billPostalCode) and `qb_vendor_add` (postalCode) reject too-short / junk-character postal codes.
- [x] Schema rejection produces zod's default validation error (NOT the canonical Item 25 `{ statusCode, statusMessage, humanReadable? }` shape — that wrapper only runs on input that passed the schema). Same architectural split as Item 28.
- [x] Valid input (`"2026-04-27"`, `"jane@example.com"`, `"(555) 123-4567"`, `"94110-1234"`, `"K1A 0B1"`) passes through every regex unchanged. End-to-end `qb_invoice_create` with valid args still succeeds.

**Regression criteria** _(things that should still work after the change)_:
- [x] `src/tools/reports.ts` no longer carries a local `ISO_DATE_RE` const — it now imports from `src/util/validators.js`. `qb_pnl_report` / `qb_balance_sheet_report` / `qb_ar_aging` / `qb_ap_aging` / `qb_balance_summary` all still reject malformed dates (Item 19/21 regression guard — the regex moved, behavior didn't).
- [x] Item 25 wrapper still produces canonical structured payloads on QB-side errors. Item 28 enum validation still fires for `qb_account_add`. The two existing harnesses (`verify-item25-error-shape.mjs`, `verify-pickup-2026-04-27.mjs`) both pass unchanged.
- [x] Seed data still loads (3 customers / 2 vendors / 0 invoices / 0 bills baseline preserved).
- [x] No existing tool surface changed — the schemas got more restrictive on additive paths only. Filter paths (e.g. `qb_invoice_list`'s `fromDate`) tightened too because malformed filter dates previously silently matched nothing; now they fail loudly at zod.
- [x] `npm run build` passes.

**Documentation criteria**:
- [x] No README change — tool surface didn't change, only schema strictness.
- [x] No `instructions` block change in `src/index.ts` — same.
- [x] No `ARCHITECTURE.md` / `DECISIONS.md` / `REQUIREMENTS.md` change — input validation is a refinement of existing schemas, not a new architectural pattern. The split between zod-layer rejection and Item 25 wrapper is documented in the harness comment and the Item 28 acceptance entry below.
- [x] `src/util/validators.ts` carries the rationale for permissive vs strict regex shapes inline.

**Verification commands**:
```bash
npm run build
node scripts/verify-item29-input-validation.mjs    # 44/44 pass
node scripts/verify-item25-error-shape.mjs         # 47/47 pass (unchanged)
node scripts/verify-pickup-2026-04-27.mjs          # 7/7 pass (unchanged)
node scripts/verify-item23-env-matrix.mjs          # 99/99 pass (unchanged)
```

**Notes**: Postal regex coverage matched HANDOFF.md's earlier "bill+ship in create + update" estimate only partially — only `customers.ts:billPostalCode` (create) and `vendors.ts:postalCode` (create) actually exist. The update paths for both don't expose a postal field. No `shipPostalCode` exists. Total swept: 44 date fields, 6 email, 6 phone, 2 postal — all from a single shared regex const each, so future tools that add a date/email/phone/postal field just import the regex; no decision tree.

The simulation store doesn't need to change — it already accepts whatever string gets through, and now zod is gate-keeping shape correctness one layer earlier. QB itself will continue to do semantic validation on the live side (e.g. "this date is in a closed period").

---

### Item 28 — Validate `AccountType` enum in `qb_account_add` _(Phase 6)_ — done 2026-04-27

**Status:** done

**Behavioral criteria** _(observable, testable, no ambiguity)_:
- [x] `accountType` argument on `qb_account_add` is now `z.enum(ACCOUNT_TYPES)` (was `z.string()`) at [src/tools/accounts.ts:73-75](src/tools/accounts.ts#L73-L75). The local `ACCOUNT_TYPES` const at [src/tools/accounts.ts:10-15](src/tools/accounts.ts#L10-L15) covers all 16 canonical QB types: `Bank, AccountsReceivable, OtherCurrentAsset, FixedAsset, OtherAsset, AccountsPayable, CreditCard, OtherCurrentLiability, LongTermLiability, Equity, Income, CostOfGoodsSold, Expense, OtherIncome, OtherExpense, NonPosting`.
- [x] Calling the schema with an unknown type rejects at zod with `code: "invalid_enum_value"`, `path: ["accountType"]`, `options: <16-element array>`, and a message that lists all 16 canonical values verbatim (e.g. `"Invalid enum value. Expected 'Bank' | 'AccountsReceivable' | ... | 'NonPosting', received 'Garbage'"`). The LLM caller can self-correct from the message alone.
- [x] All 16 canonical types still parse successfully (no off-by-one in the enum membership).
- [x] End-to-end happy path: `qb_account_add({ name, accountType: "Bank" })` returns `{ success: true, account: ... }` exactly as before. The wrapper at [src/tools/accounts.ts:91-114](src/tools/accounts.ts#L91-L114) is unchanged.

**Regression criteria** _(things that should still work after the change)_:
- [x] `npm run build` green.
- [x] [scripts/verify-item25-error-shape.mjs](scripts/verify-item25-error-shape.mjs) extended from 44 → 47 checks (3 new Item 28 assertions: schema rejects unknown with canonical list in error; schema accepts every canonical type; end-to-end add with `Bank` still succeeds). 47/47 pass.
- [x] [scripts/verify-pickup-2026-04-27.mjs](scripts/verify-pickup-2026-04-27.mjs) — 7/7 pass. Reports / aging / company-info untouched.
- [x] [scripts/verify-item23-env-matrix.mjs](scripts/verify-item23-env-matrix.mjs) — 99/99 pass. Item 23 unaffected.
- [x] Existing 10 seed accounts in the simulation store still pass through `qb_account_list` unchanged (their `AccountType` strings are all canonical, so no migration needed).
- [x] `qb_account_list`'s `accountType` filter remains `z.string().optional()` — intentional: a filter that silently matches nothing on a typo is the same observable behavior as it was before. Only the additive create path needed strictness.

**Documentation criteria**:
- [x] No README change — the tool's external contract (name, return shape) is unchanged; only the input is narrowed.
- [x] No `instructions` block change in [src/index.ts](src/index.ts) — same reason.
- [x] No `ARCHITECTURE.md` / `DECISIONS.md` change — narrowing a zod type is local hygiene, not a structural shift.
- [x] `todo.md` Item 28 checkbox flipped.

**Verification commands**:
```bash
npm run build
node scripts/verify-item25-error-shape.mjs   # 47/47 pass
node scripts/verify-pickup-2026-04-27.mjs    # 7/7 pass
node scripts/verify-item23-env-matrix.mjs    # 99/99 pass
```

**Notes**:
- One-line change in tool code, three new harness assertions, ~25 lines of harness scaffolding (the fakeServer pattern was extended to capture schemas in addition to handlers — the carry-over from HANDOFF context note "handlers captured via the fakeServer pattern do NOT pass through zod validation"). The schemas Map keeps schema-level checks self-contained without booting an MCP transport.
- The rejection happens at SDK registration / dispatch time, NOT in the Item 25 wrapper. So the response shape on invalid input is the SDK's default validation error, not the canonical `{ statusCode, statusMessage, humanReadable? }` shape. This is intentional and noted in the harness comment — Item 25's invariant ("every wrapper produces canonical structured payload") still holds because the wrapper never runs on schema-rejected input.
- Did NOT consolidate with Item 21's `CANONICAL_ACCOUNT_TYPES` in [src/tools/reports.ts:17-24](src/tools/reports.ts#L17-L24) per HANDOFF guidance — that one is a `readonly string[]` ordered for report grouping (Bank → AR → ... → Equity → Income → ... → Expense), a different shape with different semantic intent. Kept the local `accounts.ts` const.

---

### Item 26 — Status-code mapping table for QB errors _(Phase 6)_ — done 2026-04-27

**Status:** done

**Behavioral criteria** _(observable, testable, no ambiguity)_:
- [x] New util module [src/util/qb-status-codes.ts](src/util/qb-status-codes.ts) exports `qbStatusCodeMessage(statusCode: number): string | undefined`. Lookup-table-driven (not switch).
- [x] Table covers every status code the simulation store actually emits in error paths. Audit: `grep -E "statusCode: [0-9]+" src/session/simulation-store.ts` finds codes `0, 1, 500, 3030, 3120, 3170`. The wrapper only fires on throw, so success codes (`0`) and the parser's "no records" non-error (`1`, converted to `{}` in [src/qbxml/parser.ts:154-159](src/qbxml/parser.ts#L154-L159)) never reach the lookup. Error codes covered: `500, 3030, 3120, 3170`.
- [x] Table also covers `3260` (insufficient permission) for forward-compat with live mode — real QB returns this when an account/employee delete is blocked by transaction history.
- [x] Every Item 25 wrapper across the 15 tool files attaches `humanReadable: <string>` to the canonical error response when `qbStatusCodeMessage(e.statusCode ?? -1)` returns a string. Spread is conditional: `...(humanReadable ? { humanReadable } : {})` — no `humanReadable: undefined` field on the wire.
- [x] When the throw carries an unknown statusCode (or the `-1` fallback for non-`QBXMLResponseError` throws), the response has no `humanReadable` field at all — silent on unknowns, present on knowns.
- [x] Estimate convert special-case: the `markAcceptedError` partial-state object (the third session call in `qb_estimate_convert_to_invoice`, which intentionally allows failure without rolling back the invoice) also gets `humanReadable` attached. Type widened to `{ statusCode: number; statusMessage: string; humanReadable?: string }`.

**Regression criteria** _(things that should still work after the change)_:
- [x] `npm run build` green.
- [x] [scripts/verify-item25-error-shape.mjs](scripts/verify-item25-error-shape.mjs) extended from 39 → 44 checks (5 new humanReadable assertions: 2 direct lookup-table sanity + 2 wrapper-integration with known codes + 1 wrapper-integration with synthetic non-QBXML throw asserting absent field). 44/44 pass.
- [x] [scripts/verify-pickup-2026-04-27.mjs](scripts/verify-pickup-2026-04-27.mjs) — 7/7 pass. Confirms reports / aging / company-info untouched.
- [x] [scripts/verify-item23-env-matrix.mjs](scripts/verify-item23-env-matrix.mjs) — 99/99 pass. Item 23 unaffected.
- [x] All 71 wrapper callsites have humanReadable attached (one-to-one match: 71 `statusMessage: e.message` ↔ 71 `...(humanReadable ? ...)`). Pre-flight validation blocks (the `error: "Either customerName ..."` shape that predates Item 25, used in invoices / sales-receipts / credit-memos / estimates / payments / bills / purchase-orders) intentionally do NOT get the spread — they have no statusCode and `humanReadable` isn't in scope.

**Documentation criteria**:
- [x] No README change — internal contract, not tool-surface.
- [x] No `instructions` block change in [src/index.ts](src/index.ts).
- [x] No `ARCHITECTURE.md` / `DECISIONS.md` change — adding a lookup table is local hygiene, not a structural shift.
- [x] `todo.md` Item 26 checkbox flipped.

**Verification commands**:
```bash
npm run build
node scripts/verify-item25-error-shape.mjs   # 44/44 pass
node scripts/verify-pickup-2026-04-27.mjs    # 7/7 pass
node scripts/verify-item23-env-matrix.mjs    # 99/99 pass
```

**Notes**:
- No helper introduced. Each wrapper adds two lines: `const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);` after the existing `const e = err as { ... };`, and `...(humanReadable ? { humanReadable } : {})` inside the JSON response object. Same reasoning as Item 25 — abstracting ~30 callsites would obscure which QBXML op each tool runs.
- The lookup-table approach (vs. switch statement) lets future agents audit table contents trivially: open `src/util/qb-status-codes.ts`, read the object literal, done. No hidden codepaths.
- Closing-pattern replace_all initially over-matched 11 pre-flight validation blocks (those `if (!args.customerName) return { ..., error: "...", isError: true }` early-returns share the same closing shape as the wrapper). Those were reverted in a follow-up sweep — `humanReadable` would have been a TS error there since the validation runs before any `const humanReadable` declaration. Kept the over-match → revert pattern documented here so future sweeps know to check.

---

### Item 25 — Structured-error sweep across CRUD tools _(Phase 6)_ — done 2026-04-27

**Status:** done

**Behavioral criteria** _(observable, testable, no ambiguity)_:
- [x] Every `session.queryEntity / addEntity / modifyEntity / deleteEntity` call across `src/tools/*.ts` is wrapped in try/catch — verified by grep: 0 unwrapped session calls remain.
- [x] Every wrapped error path produces the canonical Item 25 shape: `{ success: false, statusCode: number, statusMessage: string }` with `isError: true`. Non-Error throws (no `.statusCode`) get `statusCode = -1` per the reference; the `statusMessage` falls back to a per-op label naming the operation that failed (e.g. `"BillModRq failed"`, `"TxnDelRq (Invoice) failed"`, `"ListDelRq (Customer) failed"`).
- [x] Real `QBXMLResponseError` instances (the simulation's failure shape) propagate their `statusCode` and `message` faithfully — confirmed in [scripts/verify-item25-error-shape.mjs](scripts/verify-item25-error-shape.mjs): "not found" cases return `statusCode=500`, JE imbalance returns `statusCode=3030`.
- [x] Tools that previously had a bespoke wrapper using the legacy `{ success: false, error, statusCode }` shape were normalized to the canonical `{ statusCode, statusMessage }` shape so all tools converge. Touched: `accounts.ts` (make_inactive + delete), `bills.ts` (update + bill_pay), `credit-memos.ts` (create + update + apply + delete), `employees.ts` (make_inactive + delete), `estimates.ts` (update + delete + convert's two inner wrappers), `invoices.ts` (update), `journal-entries.ts` (all four), `payments.ts` (receive + apply), `purchase-orders.ts` (create + update + delete), `sales-receipts.ts` (create + update + delete).
- [x] Tools that had no wrapper got one: `customers.ts` (all four), `vendors.ts` (all four), `items.ts` (all four), `lists.ts` (all six), `accounts.ts` (list + add + update), `employees.ts` (list + add + update), `bills.ts` (list + create + delete + bill_payment_list), `invoices.ts` (list + create + delete), `payments.ts` (payment_list), `estimates.ts` (list + create + convert's queryEntity for source estimate), `sales-receipts.ts` (list), `credit-memos.ts` (list), `purchase-orders.ts` (list).
- [x] Tool families covered: customers, vendors, accounts, employees, items, invoices, bills, bill payments, payments, estimates, sales receipts, credit memos, purchase orders, journal entries, lists (Class / Terms / PaymentMethod / SalesRep / CustomerType / VendorType). Reports (Item 14, 19, 20, 21) was the reference shape — no changes needed there.
- [x] `qb_estimate_convert_to_invoice` retains its multi-step shape: the markAccepted side-effect is allowed to fail without rolling back the invoice creation; the partial-state response now uses `markAcceptedError: { statusCode, statusMessage }` (was `{ message, statusCode }`) — same partial semantics, normalized field names.

**Regression criteria** _(things that should still work after the change)_:
- [x] `npm run build` passes (no TypeScript errors).
- [x] Pickup verification harness `scripts/verify-pickup-2026-04-27.mjs` (7 checks: P&L empty, P&L populated, Balance Sheet identity, balance summary, AR/AP aging, company info) still 7/7 PASS.
- [x] Item 23 env-matrix harness `scripts/verify-item23-env-matrix.mjs` still 99/99 PASS.
- [x] New harness `scripts/verify-item25-error-shape.mjs` exercises 19 error paths + 20 happy-path smokes across every CRUD tool family — 39/39 PASS.
- [x] Happy-path response shapes (the `count + <entityArray>` envelope) unchanged — confirmed by the 20 happy-path smokes asserting the previous fields still exist.
- [x] No tool's success path regresses to `isError: true` (the wrapper only changes the failure path).

**Documentation criteria**:
- [x] No README change — the error-shape change is internal contract, not user-facing tool surface.
- [x] No `instructions` block change in src/index.ts — same reason.
- [x] No `ARCHITECTURE.md` change — wrapping handler bodies in try/catch is local hygiene, not a structural shift.
- [x] No `DECISIONS.md` change — the "no wrapper helper" choice was already noted in HANDOFF.md context (~120 lines saved isn't worth the abstraction across 20 callsites). Documented inline in the per-tool code.

**Verification commands**:
```bash
npm run build
node scripts/verify-item25-error-shape.mjs
node scripts/verify-pickup-2026-04-27.mjs
node scripts/verify-item23-env-matrix.mjs
```

**Notes**:
- The reference shape from HANDOFF.md was carried verbatim across all wrappers. No helper introduced — six lines of boilerplate per call × ~30 wrappers = ~180 lines of repetition, but extracting a `wrapSessionCall` helper would have replaced that with an indirection that obscures which operation each tool runs. The trade was worth it: every tool's error branch is locally readable, and grep for `statusMessage: e.message ?? "<op>` lists every operation in the codebase.
- The fallback `statusMessage` label for each call uses real QBXML request names (`InvoiceQueryRq`, `BillModRq`, `TxnDelRq (Invoice)`, `ListDelRq (Customer)`) rather than tool names. Rationale: when a real `QBXMLResponseError` propagates, its message is QB's own (e.g. `"Object 'NOPE' specified in the request cannot be found"`) — that wins. The fallback only fires when something throws a plain `Error` without `.statusCode`, which in practice is unexpected internal failures (TypeError, etc.). Naming the QBXML op makes the tool's structural place in the QBXML protocol traceable from the error alone.
- Item 26 (`qbStatusCodeMessage(code)` lookup util) is the natural follow-on. Every wrapper currently surfaces the raw `e.message` from QB; a future wrapper can attach a `humanReadable` field by passing the statusCode through a small lookup table. The wrapper sites are already uniform, so adding `humanReadable` is a single sweep across the same callsites.
- Item 25 sweep target list (per HANDOFF context note) was complete: customers, vendors, accounts, invoices, bills, items, payments, estimates, sales-receipts, credit-memos, purchase-orders, journal-entries, employees, lists were all touched. Reports already conformed (no changes).
- The `qb_estimate_convert_to_invoice` flow has two side effects (invoice creation + markAccepted). Per HANDOFF "Item 25 reference shape" guidance, the second side effect is allowed to fail without rolling back the first — that's the partial-state semantics callers already depend on. The wrapper normalization preserved that semantic; only the field names in `markAcceptedError` changed (`{ message, statusCode }` → `{ statusCode, statusMessage }`). If a future caller depended on the old `markAcceptedError.message` field name, they'll see `markAcceptedError.statusMessage` now.


### Item 23 — `QB_SIMULATION` env semantics _(Phase 6)_ — done 2026-04-27

**Status:** done

**Behavioral criteria** _(observable, testable, no ambiguity)_:
- [x] `resolveSimulationMode(env, platform)` exported from [src/session/manager.ts](src/session/manager.ts) is a pure function that returns the boolean per the documented rule: `QB_SIMULATION="true"` forces simulation, `QB_SIMULATION="false"` forces live, otherwise simulate unless `platform === "win32" && QB_LIVE === "1"`.
- [x] Constructor calls `resolveSimulationMode(process.env, process.platform)` — no inline boolean expression.
- [x] On non-Windows with `QB_SIMULATION=false`, the constructor sets `simulationMode=false`; subsequent `openSession()` throws "Live QuickBooks connection requires Windows…" (verified: `node -e` smoke confirms the throw).
- [x] On Windows with `QB_SIMULATION=false` and `QB_LIVE` unset, the resolver returns `false` (was `true` before — that was the surprising behavior the task targeted).
- [x] On Windows with `QB_SIMULATION=true`, the resolver returns `true` regardless of `QB_LIVE` (forced override preserved).
- [x] Any `QB_SIMULATION` value other than `"true"` / `"false"` (e.g. `"1"`, `"yes"`, `""`) is treated as unset and defers to the platform/QB_LIVE rule.
- [x] Any `QB_LIVE` value other than `"1"` is treated as not-set when resolving the default branch (tightened from the prior `!process.env.QB_LIVE` truthiness check, which would have wrongly accepted `QB_LIVE="0"` as opting into live).
- [x] Matrix harness `scripts/verify-item23-env-matrix.mjs` exercises 90 combinations (3 platforms × 6 `QB_SIMULATION` × 5 `QB_LIVE`) plus 9 canonical cases — all 99 pass.

**Regression criteria** _(things that should still work after the change)_:
- [x] `npm run build` passes.
- [x] Pickup verification harness `scripts/verify-pickup-2026-04-27.mjs` (7 checks: P&L empty, P&L populated, Balance Sheet identity, balance summary regression, AR/AP aging, company info) still 7/7 PASS — Item 23 is constructor-side only and doesn't touch any tool path.
- [x] Default behavior on non-Windows with no env vars is unchanged: simulation banner prints, simulation session opens, all tools work.
- [x] `simulationMode` is still read once at construction time (no per-request re-evaluation) — the resolver is called from the constructor only.

**Documentation criteria**:
- [x] [README.md](README.md) — env table updated to clarify `QB_SIMULATION` accepts `"true"` / `"false"` / unset, and `QB_LIVE` is honored only when `QB_SIMULATION` is unset. New "Mode resolution matrix" subsection enumerates all 7 canonical (platform, sim, live) → mode rows.
- [x] `.env.example` created at repo root, documenting every `QB_*` variable with the same matrix wording. Already covered by `.gitignore` (.env is ignored, .env.example tracked).
- [x] No `ARCHITECTURE.md` change — env-driven mode selection was already in scope of the existing two-mode session design; this is a behavioral fix, not a structural one.
- [x] No `DECISIONS.md` change — the choice between "honor explicit false" vs "document quirk" was a small ergonomics call, not a tradeoff with lasting consequences.

**Verification commands**:
```bash
npm run build
node scripts/verify-item23-env-matrix.mjs
node scripts/verify-pickup-2026-04-27.mjs
QB_SIMULATION=false node -e "import('./dist/session/manager.js').then(({QBSessionManager})=>{const m=new QBSessionManager({companyFile:'sim',appName:'v',qbxmlVersion:'16.0',connectionMode:'optimistic'}); m.openSession().catch(e=>console.log('threw:',e.message.slice(0,80)));});"
```

**Notes**:
- The resolver lives next to the class (same file) instead of in a `util/env.ts` because (a) one consumer, (b) it's tightly coupled to the constructor's contract, (c) tests import it directly from `manager.js`. If a second consumer appears (e.g. a future `qb_session_info` tool that wants to display the rule outcome), promote at that point.
- The original code's `!process.env.QB_LIVE` check accepted any truthy QB_LIVE (including `"0"`, `"false"`) as opting into live mode. The new `=== "1"` check is stricter and matches the README's documented "Set to `1`" wording. This is a behavior change for users who were relying on undocumented truthiness, but the README never promised that contract.
- On non-Windows, `QB_SIMULATION="false"` now triggers a constructor that proceeds (no banner), then throws at `openSession()` — that's the right shape: the constructor honors the user's request, and the platform check happens at the moment we actually need to open a connection. If a future task wants to fail fast at construction time on impossible (platform, mode) combos, that's an additional check; it doesn't replace the resolver.


### Item 20 — `qb_pnl_report` / `qb_balance_sheet_report` via `GeneralSummaryReportQueryRq` _(Phase 5)_ — done 2026-04-26

**Status:** done

**Behavioral criteria** _(observable, testable, no ambiguity)_:
- [x] `buildReportRequest({ reportType, fromDate?, toDate?, basis? }, version?)` in [src/qbxml/builder.ts](src/qbxml/builder.ts) emits a `GeneralSummaryReportQueryRq` with `<GeneralSummaryReportType>`, `<ReportPeriod>` (FromReportDate / ToReportDate), `<ReportBasis>` (default Accrual), `<SummarizeColumnsBy>TotalOnly</SummarizeColumnsBy>`, `<IncludeSubcolumns>0</IncludeSubcolumns>`. Report rqs are not list/txn queries — they got their own builder.
- [x] `extractReportData(response, expectedType?)` in [src/qbxml/parser.ts](src/qbxml/parser.ts) pulls the `ReportRet` block out of the named `*Rs` body, returning `{}` on the "no data" status (1) and re-throwing `QBXMLResponseError` on hard failure.
- [x] `QBSessionManager.runReport(reportType, { fromDate, toDate, basis })` in [src/session/manager.ts](src/session/manager.ts) wires the new builder + extractor (no longer reuses `buildQueryRequest` / `extractResponseData`).
- [x] Simulation handler `handleReportQuery` in [src/session/simulation-store.ts](src/session/simulation-store.ts) routes `GeneralSummaryReportQueryRq` (added before the `endsWith("QueryRq")` branch in `processRequest`). Rejects unknown `GeneralSummaryReportType` with `statusCode: 3120`.
- [x] **P&L** (`reportType=ProfitAndLossStandard`):
  - [x] Income walk: Invoice + SalesReceipt (positive), CreditMemo (negative). Lines resolve their account via line.AccountRef (rare on these txns), or via line.ItemRef → item.IncomeAccountRef / item.SalesOrPurchase.AccountRef. Unresolved lines → "Uncategorized Income".
  - [x] Expense walk: Bill + Check + CreditCardCharge ExpenseLineRet (AccountRef direct) + ItemLineRet (item.ExpenseAccountRef / COGSAccountRef / SalesOrPurchase.AccountRef). Unresolved → "Uncategorized Expense".
  - [x] JournalEntry contributes: debit lines posting to expense accounts add positive expense; credit lines posting to income accounts add positive income. Asset/liability/equity lines don't contribute to P&L.
  - [x] Filter: `TxnDate ∈ [fromDate, toDate]` inclusive on both bounds. Missing bounds = unbounded.
  - [x] Sections in canonical order: Income → Other Income → Cost of Goods Sold → Expenses → Other Expenses. Each section: `{ name, accounts: [{ name, total }], subtotal }` with accounts sorted alphabetically.
  - [x] Top-level totals: `totalIncome`, `totalCOGS`, `totalExpenses`, `grossProfit = totalIncome − totalCOGS`, `netIncome = totalIncome − totalCOGS − totalExpenses`.
  - [x] `basis: "Accrual" | "Cash"` accepted (currently identical in simulation; live mode lands with Phase 7).
- [x] **Balance Sheet** (`reportType=BalanceSheetStandard`):
  - [x] Assets / Liabilities / Equity sections built from `Account.Balance` (snapshot — `asOfDate` is advisory for those sections in simulation, documented).
  - [x] Period NetIncome (lifetime txn walk up to asOfDate) closes into Equity as a "Net Income" row, mirroring real QB's "Retained Earnings + Net Income" pattern.
  - [x] Accounting identity Assets = Liabilities + Equity reconciles by closing the simulation seed gap into a "Balancing Adjustment (simulation seed gap)" Equity row. The known $10,700 phantom AR shows up here.
  - [x] Top-level totals: `totalAssets`, `totalLiabilities`, `totalEquity`, `netIncome`. After the balancing adjustment, `totalAssets === totalLiabilities + totalEquity` always holds.
  - [x] Optional `asOfDate` zod param (regex-validated `YYYY-MM-DD`, defaults to today UTC).
- [x] Both tools wrapped in try/catch translating `QBXMLResponseError` → `{ success: false, statusCode, statusMessage }` with `isError: true` (Item 25 reference shape).
- [x] Both tools registered via `registerReportTools` (auto-discovered through the existing wire-up in [src/index.ts](src/index.ts)).
- [x] Schema rejects `04/26/2026` and `2026/04/26`; accepts `2026-04-26` and `{}`.

**Regression criteria** _(things that should still work after the change)_:
- [x] `qb_balance_summary` (Item 21) — still emits canonical-ordered array, `Bank` first with total 165000, `subtotals.netIncome === -22800`.
- [x] `qb_ar_aging` (Item 19) — seed sanity unchanged (`totalAccountsReceivable === 16000`, all in `90+`, Global Industries first).
- [x] `qb_ap_aging` (Item 19) — empty path unchanged.
- [x] `qb_company_info` (Item 14) — auto-connect path still returns `Demo Co`.
- [x] `qb_invoice_create` / `qb_bill_create` — still functional (the verification harness creates txns and reads them back through the new report tools, so a regression here would surface as P&L numbers being wrong).

**Documentation criteria**:
- [x] README Reports & Queries table — `qb_pnl_report` and `qb_balance_sheet_report` rows added with full description of walk semantics, section ordering, totals, basis, and asOfDate semantics.
- [x] `instructions` block in [src/index.ts](src/index.ts) updated — the `qb_balance_summary / qb_ar_aging / qb_ap_aging` line now also covers `qb_pnl_report / qb_balance_sheet_report` with their walk + closure semantics.
- [x] No `ARCHITECTURE.md` change — the report path follows the existing builder → simulation-store → parser pipeline (just a new request type). Live-mode row-tree translation is documented as a Phase 7 follow-up in code comments (`extractReportData` jsdoc + `handleReportQuery` method note).
- [x] `DECISIONS.md` not updated — the simplified-vs-row-tree shape decision is documented inline in `extractReportData` and `handleReportQuery` rather than a standalone decision (it's a scope clarification, not a tradeoff among alternatives).

**Verification commands**:
```bash
npm run build              # TypeScript clean
node verify_item20.mjs     # P&L + BS happy paths + regressions — see HANDOFF.md
```

**Notes**:
- Simulation-mode `ReportRet` shape diverges from real QB's row-tree wire format. Documented inline (`extractReportData` jsdoc + `handleReportQuery` method note). Phase 7 (live COM) will need a row-tree → simplified-shape adapter; until then the simulation owns the wire format.
- `IncludeSubcolumns=0` / `SummarizeColumnsBy=TotalOnly` only — multi-period / class / customer slicing is out of Item 20 scope.
- Cash basis is currently identical to Accrual in simulation (revenue recognition tied to ReceivePayment is a separate piece of work). The basis param is plumbed through to ReportRet for callers, but doesn't change aggregation yet.
- The Balance Sheet uses `Account.Balance` as a snapshot rather than walking transactions for asset/liability/equity. This is a pragmatic simplification — real QB walks every transaction through every account through history. The seed gap surfaces transparently as the "Balancing Adjustment" row so the operator sees the discrepancy.

---

### Item 19 — `qb_ar_aging` / `qb_ap_aging` — open-txn walk + 0-30 / 31-60 / 61-90 / 90+ buckets _(Phase 5)_ — done 2026-04-26

**Status:** done

**Behavioral criteria** _(observable, testable, no ambiguity)_:
- [x] `qb_ar_aging` queries `Invoice` records (not `Customer.Balance`), filters to `IsPaid !== true && Number(BalanceRemaining) > 0`, and groups the survivors by `CustomerRef.FullName`.
- [x] `qb_ap_aging` queries `Bill` records (not `Vendor.Balance`), filters to `IsPaid !== true && Number(AmountDue) > 0`, and groups the survivors by `VendorRef.FullName`. (Bills use `AmountDue` as the open-balance field — the bill-side equivalent of an invoice's `BalanceRemaining`.)
- [x] Both tools age each open transaction by `daysOutstanding = floor((asOfDate − dueDate) / day)`, where `dueDate = txn.DueDate ?? txn.TxnDate ?? asOfDate`. Date math uses `Date.UTC` to avoid local-TZ drift on YYYY-MM-DD inputs.
- [x] Bucket boundaries (real QB defaults): `daysOutstanding <= 30` → `0-30` (collapses negative/future-dated into current), `31..60` → `31-60`, `61..90` → `61-90`, `> 90` → `90+`. Verified at every boundary (0, 30, 31, 60, 61, 90, 91, −30 days).
- [x] Single invoice/bill = single bucket (no per-line aging). Scope guard from handoff.
- [x] Per-party rows: `{ name, balance, buckets: { "0-30", "31-60", "61-90", "90+" }, txnCount }`. Sorted by `balance` desc.
- [x] Top-level response: `{ asOfDate, totalAccountsReceivable | totalAccountsPayable, bucketTotals, customers | vendors }`. `totalAccounts*` equals the sum of `bucketTotals` across all 4 buckets.
- [x] Optional `asOfDate` zod param, regex-validated `YYYY-MM-DD` (matches Item 21's `ISO_DATE_RE` constant). Defaults to `new Date().toISOString().split("T")[0]` (today, UTC) when omitted.
- [x] Schema rejects `04/26/2026`, `2026/04/26`; accepts `2026-04-26` and `{}`.
- [x] DueDate fallback: an open invoice with no `DueDate` ages from `TxnDate` instead. Verified — created an invoice without `dueDate` (txnDate `2025-12-01`); `qb_ar_aging({ asOfDate: "2026-01-01" })` puts it in `31-60` (31 days from TxnDate).
- [x] Both handlers wrapped in try/catch translating `QBXMLResponseError` → `{ success: false, statusCode, statusMessage }` with `isError: true` (Item 25 reference shape, opportunistic since the file was being rewritten anyway).
- [x] Seed sanity: 2 unpaid seed invoices ($7500 Acme due 2024-12-01, $8500 Global Industries due 2024-12-15) with `asOfDate=2026-04-26` → `bucketTotals = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 16000 }`, customers sorted Global → Acme.
- [x] AP path with no seeded bills: empty `vendors`, `totalAccountsPayable === 0`, all bucket totals 0.
- [x] AP path with 4 created bills hitting all 4 buckets ($100 / $200 / $400 / $800): per-bucket totals match exactly, single vendor row sums to $1500 with `txnCount === 4`.

**Regression criteria** _(things that should still work after the change)_:
- [x] `qb_balance_summary` (Item 21) — still emits canonical-ordered array, `Bank` first with total 165000, `subtotals.netIncome === -22800`.
- [x] `qb_company_info` (Item 14) — auto-connect path still returns `Demo Co`.
- [x] `qb_invoice_create` / `qb_bill_create` — still functional (verified by harness creating live entities, then querying them through the aging tools).

**Documentation criteria**:
- [x] README Reports & Queries table — `qb_ar_aging` / `qb_ap_aging` rows expanded to describe the open-txn walk, bucket bands, and `asOfDate` semantics.
- [x] Tool descriptions in [src/tools/reports.ts](src/tools/reports.ts) accurately describe filtering rules, fallback behavior, bucket bands, and "single txn = single bucket" guarantee.
- [x] No `ARCHITECTURE.md` change — no new pattern was introduced (open-txn walk is the obvious correct implementation; the Customer/Vendor `Balance` denormalized rollup was the bug).
- [x] No `DECISIONS.md` change — bucket boundaries are straight from QB's documented summary aging report, not a tradeoff.

**Verification commands**:
```bash
npm run build         # TypeScript clean
node verify_item19.mjs   # 54/54 PASS — see HANDOFF.md "Last Session Summary" for the matrix
```

**Notes**:
- `runReport` was deliberately not touched (handoff scope guard — that's Item 20).
- `Terms` → `DueDate` derivation was deliberately not implemented (out of scope per handoff). Operator-supplied `DueDate` is the only path; absence falls back to `TxnDate`.
- The seed customer rollup `Balance` ($26,700) doesn't match the seeded open-invoice total ($16,000) — known seed-data inconsistency the handoff flagged. Not a bug in this tool; the tool is correct to walk transactions, not the rollup.

---

### Item 21 — `qb_balance_summary` canonical ordering + subtotals + advisory date range _(Phase 5)_ — done 2026-04-26 — _superseded 2026-05-09 by Item 38_

**Status:** done (superseded — `fromDate` / `toDate` were ignored; replaced by Item 38's `asOfDate` + BS / P&L sourcing. The canonical-order bucket contract DOES carry forward; only the data source and date-param shape changed.)

**Behavioral criteria** _(observable, testable, no ambiguity)_:
- [x] `qb_balance_summary` (no args) returns `balanceSummary` as an **array** (not an object) of `{ accountType, accounts, total }` entries.
- [x] Entries are emitted in canonical QB order: Assets (Bank → AccountsReceivable → OtherCurrentAsset → Inventory → FixedAsset → OtherAsset) → Liabilities (AccountsPayable → CreditCard → OtherCurrentLiability → LongTermLiability) → Equity → Income (Income → OtherIncome) → Expenses (CostOfGoodsSold → Expense → OtherExpense) → NonPosting. Empty groups are skipped (operator-friendly).
- [x] Unknown / future AccountType values land in a trailing `Other` bucket so nothing is silently dropped.
- [x] Response includes a `subtotals` block: `{ assets, liabilities, equity, income, expenses, netIncome }` where `netIncome = income − expenses`. With seed data: assets=191700, liabilities=3700, equity=0, income=257000, expenses=279800, netIncome=−22800.
- [x] Optional `fromDate` / `toDate` zod params (regex-validated `YYYY-MM-DD`). When either is passed, the response surfaces `asOfDateRange: { from, to }` (the unset side is `null`) AND a string `asOfNote` explaining that simulation balances are a current snapshot, not date-windowed.
- [x] When neither date is passed, `asOfDateRange` is `null` and `asOfNote` is omitted from the JSON entirely (not `null`, not empty string).
- [x] Invalid date strings (e.g. `"01/01/2026"`) are rejected by the zod schema before the handler runs.
- [x] Errors from the underlying `session.queryEntity("Account", {})` call are translated into `{ success: false, statusCode, statusMessage }` with `isError: true` (Item 25 reference shape, mirroring `qb_company_info`).

**Regression criteria** _(things that should still work after the change)_:
- [x] `totalAccounts: 10` in the response (seed unchanged).
- [x] Per-group account name ordering preserved from seed insertion order (Bank: `["Checking","Savings"]`; Income: `["Sales Revenue","Consulting Revenue"]`).
- [x] `qb_company_info` still works (no shared state damaged).
- [x] `qb_account_list` regression: still returns 10 accounts (the new constants + handler are tool-local).

**Documentation criteria**:
- [x] README "Reports & Queries" table description updated to reflect canonical ordering, subtotals, and advisory date params.
- [x] `instructions` block in [src/index.ts](src/index.ts) — left as `"Connection & company info"` for the section ownership of `qb_company_info`; the `qb_balance_summary` description string carries the granular detail.
- [x] No DECISIONS.md entry needed (canonical ordering is from QB's documented report layout; not a tradeoff).
- [x] No ARCHITECTURE.md change (still a thin reshape over `queryEntity("Account", ...)` — `runReport` was deliberately not touched; that debt belongs with Item 20).

**Verification commands**:
```bash
npm run build
# Then via verification harness:
#   qb_balance_summary({}) -> assert canonical order, 6 non-empty groups, subtotals correct, totalAccounts=10
#   qb_balance_summary({fromDate, toDate}) -> assert asOfDateRange + asOfNote present
#   zod schema rejects "01/01/2026"
```

**Notes**: The shape change (`balanceSummary: Record<string,...>` → `balanceSummary: [...]`) is intentional and breaking — the previous shape relied on JS object insertion order which is brittle and operator-meaningless. Any future caller is expected to read by `accountType` field. Item 21 deliberately does NOT implement actual date-window balance reconstruction — that's a transaction-walk problem that lands with Item 20 (P&L / Balance Sheet via `GeneralSummaryReportQueryRq`). The `asOfNote` is the honesty mechanism: surface the simulation gap rather than fake the calculation. Numeric totals are rounded to 2 decimals via a local `round2` helper to avoid floating-point fuzz showing up in the response.

### Item 14 — Real `CompanyQueryRq` in `qb_company_info` _(Phase 5)_ — done 2026-04-26

**Status:** done

**Behavioral criteria** _(observable, testable, no ambiguity)_:
- [x] `qb_company_info` (no args) returns a structured payload with a `companyInfo` object containing `CompanyName`, `LegalCompanyName`, `Address` (Addr1/City/State/PostalCode/Country block), `LegalAddress`, `Phone`, `Email`, `CompanyType`, `EIN`, `FirstMonthInFiscalYear`, `FirstMonthInIncomeTaxYear`, `TaxForm`, `IsSampleCompany`, `SubscriberID`, `CompanyFilePath`.
- [x] The payload still surfaces session state for operator transparency: `connected`, `simulationMode`, `companyFile`, `sessionTicket`, `openedAt`. The hardcoded `serverInfo` block is gone (it was stale and never updated as tools were added).
- [x] In simulation mode the seeded company comes back: `CompanyName: "Demo Co"`, fiscal year `January`, `TaxForm: "Form1120"`, `IsSampleCompany: true`.
- [x] Calling `qb_company_info` BEFORE any explicit `qb_session_connect` still works — the tool auto-connects via `session.queryEntity` (which routes through `sendRequest` → `openSession`), so the operator can call it as a first move.

**Regression criteria** _(things that should still work after the change)_:
- [x] `qb_balance_summary` still returns the 10 seeded accounts grouped by AccountType (no overlap with the new Company seed/store).
- [x] `qb_account_list` / `qb_customer_list` / `qb_vendor_list` etc. unaffected — adding a new `Company` store does not bleed into other entity lookups.
- [x] `qb_session_connect` / `qb_session_disconnect` still work; sessionTicket and openedAt still surface through the new payload.

**Documentation criteria**:
- [x] README "Reports" tool table description for `qb_company_info` updated to reflect the real query.
- [x] `instructions` block in [src/index.ts](src/index.ts) — left as `"Connection & company info"` (still accurate; the granular field list lives in the tool's description).
- [x] No DECISIONS.md entry needed (no tradeoff — straightforward implementation of an obvious gap).
- [x] No ARCHITECTURE.md change (Company is just another entity routed through the standard query path; no new subsystem).

**Verification commands**:
```bash
npm run build
# Then via verification harness:
#   qb_company_info -> assert companyInfo.CompanyName === "Demo Co", IsSampleCompany === true
#   qb_balance_summary -> assert totalAccounts === 10 (regression)
#   prior-handoff regression suite (account/invoice/JE/bill paths) all green
```

**Notes**: Company is a singleton in real QB — exactly one record per company file. Stored as a single-entry Map keyed by sentinel `"COMPANY"` so the existing `getStore`/`handleQuery` flow needs no special-case branch (the generic path returns `[companySeed]`, applies no filters since the request has none, and wraps as `{ CompanyRet: [companySeed] }`). `CompanyRet` deliberately stays out of the parser's `arrayElements` set (spec is singular); `flattenEntityArray` handles both single-object and array shapes so the consumer is uniform either way. Read-only — no `CompanyMod`, no nested address validation. If the operator ever needs to edit company info that's a separate item.

### Item 12 (JournalEntry) — Journal entry tools (`qb_journal_entry_list` / `_create` / `_update` / `_delete`) _(Phase 4)_ — done 2026-04-26

**Status:** done (4 of 4 families in Item 12 — Item 12 is now fully complete).

**Behavioral criteria** _(create / list / delete)_:
- [x] All four tools registered and listed by the MCP server. Verified J1.
- [x] `qb_journal_entry_create` with balanced `debits` + `credits` arrays returns a JE with both `JournalDebitLineRet` + `JournalCreditLineRet` arrays (each line carrying `TxnLineID` + `AccountRef` + `Amount`) plus `TotalDebit` and `TotalCredit` (always equal, derived in `computeTotals`). Verified J2.
- [x] `qb_journal_entry_create` with `sum(debits) !== sum(credits)` is rejected with `isError: true` + `statusCode: 3030` and the entry is NOT persisted (subsequent `qb_journal_entry_list` cannot find it). Verified J3.
- [x] `qb_journal_entry_create` with empty `debits` (or empty `credits`) is rejected by zod (`.min(1)`); the simulation never receives the request. Verified J4.
- [x] `qb_journal_entry_create` does NOT move any Customer/Vendor balance, even when lines carry `entityName` (per-line entity-balance moves are deferred per the handoff — `EntityRef` is recorded faithfully on the stored entity but no balance side effect). Verified J5.
- [x] `qb_journal_entry_list` filters by `txnId` (TxnID), `refNumber`, `fromDate`/`toDate` (TxnDateRangeFilter), `modifiedFrom`/`modifiedTo` (ModifiedDateRangeFilter). Verified J6.
- [x] `qb_journal_entry_delete` happy path: subsequent `qb_journal_entry_list { txnId }` returns `count: 0`. No customer/vendor balance side effect (no per-line entity bookkeeping to reverse). Verified J7.
- [x] `qb_journal_entry_delete` unknown `txnId` returns `isError: true` with `statusCode: 500`. Verified J8.

**Behavioral criteria** _(`qb_journal_entry_update` — header / line edits, balance invariant)_:
- [x] Header-only mod (no `debits`, no `credits`) leaves the existing line sets, `TotalDebit`, and `TotalCredit` untouched; `EditSequence` rotates and `TimeModified` updates. Verified U1.
- [x] When `debits` is provided, the array REPLACES the JE's `JournalDebitLineRet` wholesale — debit lines whose `TxnLineID` is not listed are dropped. Same for `credits` and `JournalCreditLineRet`. The two sides are independent. Verified U2.
- [x] A line entry with a `txnLineID` matching an existing line preserves that `TxnLineID` and merges the mod's fields onto the existing line (e.g. memo-only mod preserves accountName and amount). Verified U2.
- [x] After a line mod, `TotalDebit` and `TotalCredit` recompute from the new line sets via `computeTotals` (JournalEntry branch added to the post-mod recompute conjunction). Verified U2.
- [x] A mod that breaks the balance invariant (post-mod `sum(debits) !== sum(credits)`) is rejected with `statusCode: 3030`; the JE does NOT mutate (re-fetched JE has the pre-mod amounts, line shapes, and `EditSequence`). Verified U3.
- [x] Updating only one side (e.g. `debits` provided, `credits` omitted) is allowed when the post-mod sums still balance (the unmodified side carries forward). Verified U4.
- [x] Stale `editSequence` rejects with `statusCode: 3170`; the JE does NOT mutate. Verified U5.
- [x] `EditSequence` rotates after every successful mod. Verified U6.

**Regression criteria**:
- [x] `qb_invoice_update` line mod still recomputes `Subtotal` + `BalanceRemaining` (computeTotals JournalEntry branch did not regress Invoice path). Verified R1.
- [x] `qb_estimate_update` line mod still recomputes `Subtotal`. Verified R2.
- [x] `qb_bill_update` line mod still recomputes `AmountDue`. Verified R3.
- [x] `qb_sales_receipt_update` line mod still recomputes `Subtotal` + `TotalAmount`. Verified R4.
- [x] `qb_credit_memo_update` line mod still recomputes `Subtotal` + `TotalAmount` + `RemainingValue` and moves customer balance by the delta. Verified R5.
- [x] `qb_purchase_order_update` line mod still recomputes `TotalAmount`; vendor balance unchanged. Verified R6.

**Build / structural criteria**:
- [x] `npm run build` passes (no TypeScript errors).
- [x] `instructions` block in [src/index.ts](src/index.ts) updated with a `qb_journal_entry_*` bullet describing the debit/credit balance invariant (3030), per-line entity-balance deferral, and replacement-line semantics.
- [x] README tool count bumped 66 → 70; new "Journal Entries" section with intro paragraphs + 4-row tool table; `JournalEntryQueryRq/AddRq/ModRq` added to the QBXML reference list.
- [x] `JournalDebitLineRet` and `JournalCreditLineRet` added to `arrayElements` in [src/qbxml/parser.ts](src/qbxml/parser.ts) so single-line responses still come back as arrays.
- [x] `convertLinesAddToRet` regex `/^(.+?)Line(s?)Add$/` matches `JournalDebitLineAdd` / `JournalCreditLineAdd` for free; tool layer pre-computes `Amount` so `convertLineAddToRet` honors it (no qty/rate/cost on JE lines).
- [x] `applyLineMods` regex `/^(.+?)Line(s?)Mod$/` matches `JournalDebitLineMod` / `JournalCreditLineMod` for free.
- [x] JournalEntry already wired in `isTransactionType` ([src/session/simulation-store.ts](src/session/simulation-store.ts)), `buildDeleteRequest` transaction list ([src/qbxml/builder.ts](src/qbxml/builder.ts)), `deleteEntity` transaction list ([src/session/manager.ts](src/session/manager.ts)).

---

### Item 12 (PurchaseOrder) — Purchase order tools (`qb_purchase_order_list` / `_create` / `_update` / `_delete`) _(Phase 4)_ — done 2026-04-26

**Status:** done (3 of 4 families in Item 12; JournalEntry still pending under Item 12)

**Behavioral criteria** _(create / list / delete)_:
- [x] All four tools registered and listed by the MCP server.
- [x] `qb_purchase_order_create` with a `lines` array returns `TotalAmount = sum(line.Amount)` derived server-side via `computeTotals`. POs have NO separate `Subtotal` header — the line set aggregates straight to `TotalAmount` (distinct from Invoice/Estimate/SalesReceipt/CreditMemo). Verified P1.
- [x] Each line's `Amount` is computed at the tool layer as `quantity * cost` (POs use Cost, not Rate). Tool also pre-computes Amount so `convertLineAddToRet` honors the explicit value. Verified P2.
- [x] `qb_purchase_order_create` returns `PurchaseOrderLineRet` array with one entry per `lines[]`, each with a freshly-generated `TxnLineID` and computed `Amount`. Verified P3.
- [x] `qb_purchase_order_create` does NOT post to AP — vendor `Balance` is unchanged after creation (POs are non-posting; only bills entered against received items move the vendor balance). Verified P4 (vendor.Balance delta = 0).
- [x] `qb_purchase_order_create` with no lines (empty array or omitted) is rejected by the zod schema (`lines` is `.min(1)`). Verified P5.
- [x] `qb_purchase_order_create` with `isManuallyClosed: true` stores the flag on the entity; default omits the flag. Verified P6.
- [x] `qb_purchase_order_list` filters by `txnId` (TxnID), `vendorName` (EntityFilter scoped to VendorRef), `refNumber`, `fromDate`/`toDate` (TxnDateRangeFilter). Verified J-series.
- [x] `qb_purchase_order_delete` happy path: subsequent `qb_purchase_order_list { txnId }` returns `count: 0`; vendor balance unchanged (no AP posting to reverse). Verified G1, G2.
- [x] `qb_purchase_order_delete` unknown `txnId` returns `isError: true` with `statusCode: 500`. Verified H1.

**Behavioral criteria** _(`qb_purchase_order_update` — header / line edits)_:
- [x] Header-only mod (no `lines`) leaves the existing `PurchaseOrderLineRet`, `TotalAmount`, and `TxnLineID`s untouched. Verified B1, B2.
- [x] When `lines` is provided, the array REPLACES the PO's `PurchaseOrderLineRet` wholesale — lines whose `TxnLineID` is not listed are dropped. Verified D1.
- [x] A line entry with a `txnLineID` matching an existing line preserves that `TxnLineID` and merges the mod's fields onto the existing line (Cost carried over when only Quantity is passed; `applyLineMods` re-derives Amount = Quantity * Cost). Verified D2, D3.
- [x] After a line mod, `TotalAmount` recomputes from the new line set via `computeTotals` (PurchaseOrder branch added to the post-mod recompute list). Verified D4.
- [x] After a line mod, vendor `Balance` is unchanged — POs are non-posting, no balance bookkeeping on the mod path. Verified D5 (vendor.Balance delta = 0 across grow + shrink mods).
- [x] `isManuallyClosed` toggles correctly on mod (false → true and back). Verified M1.
- [x] Stale `editSequence` rejects with `statusCode: 3170`; the PO does NOT mutate. Verified C1, C2.
- [x] `EditSequence` rotates after every successful mod. Verified B3.

**Regression criteria**:
- [x] `qb_invoice_update` line mod still recomputes `Subtotal` + `BalanceRemaining` (computeTotals PurchaseOrder branch did not regress Invoice path). Verified N1.
- [x] `qb_estimate_update` line mod still recomputes `Subtotal`. Verified N2.
- [x] `qb_bill_update` line mod still recomputes `AmountDue` (Cost-based itemLines still re-derive Amount via `applyLineMods`). Verified N3.
- [x] `qb_sales_receipt_update` line mod still recomputes `Subtotal` + `TotalAmount`. Verified N4.
- [x] `qb_credit_memo_update` line mod still recomputes `Subtotal` + `TotalAmount` + `RemainingValue` and moves customer balance by the delta. Verified N5.
- [x] `qb_credit_memo_apply` still re-applies atomically and preserves customer balance. Verified N6.
- [x] `qb_payment_apply` still moves customer balance by `-appliedSum`. Verified N7.

**Build / structural criteria**:
- [x] `npm run build` passes (no TypeScript errors).
- [x] `instructions` block in [src/index.ts](src/index.ts) updated with a `qb_purchase_order_*` bullet describing the non-posting nature, Cost-based lines, `TotalAmount` derivation (no Subtotal split), and `isManuallyClosed` flag.
- [x] README tool count bumped 62 → 66; new "Purchase Orders" section with intro paragraphs + 4-row tool table.
- [x] `convertLinesAddToRet` regex `/^(.+?)Line(s?)Add$/` already matches `PurchaseOrderLineAdd` — no parser/builder changes needed.
- [x] `applyLineMods` regex `/^(.+?)Line(s?)Mod$/` matches `PurchaseOrderLineMod` for free; existing Quantity * Cost re-derivation works unchanged.
- [x] PurchaseOrder already wired in `isTransactionType` ([src/session/simulation-store.ts](src/session/simulation-store.ts)), `arrayElements` ([src/qbxml/parser.ts](src/qbxml/parser.ts)), `buildDeleteRequest` transaction list ([src/qbxml/builder.ts](src/qbxml/builder.ts)), `deleteEntity` transaction list ([src/session/manager.ts](src/session/manager.ts)).

### Item 12 (CreditMemo) — Credit memo tools (`qb_credit_memo_list` / `_create` / `_update` / `_apply` / `_delete`) _(Phase 4)_ — done 2026-04-26

**Status:** done (2 of 4 families in Item 12; PurchaseOrder / JournalEntry still pending under Item 12)

**Behavioral criteria** _(create / list / delete)_:
- [x] All five tools registered and listed by the MCP server.
- [x] `qb_credit_memo_create` with a `lines` array returns `Subtotal = sum(line.Amount)` derived server-side via `computeTotals`. Verified A1.
- [x] `qb_credit_memo_create` returns `TotalAmount = Subtotal + SalesTaxTotal` (SalesTaxTotal defaults to 0). Verified A2.
- [x] `qb_credit_memo_create` returns `RemainingValue = TotalAmount − AppliedAmount` (AppliedAmount defaults to 0 when no `appliedTo` is passed; RemainingValue starts at TotalAmount). Verified A3.
- [x] `qb_credit_memo_create` returns `CreditMemoLineRet` array with one entry per `lines[]`, each with a freshly-generated `TxnLineID` and computed `Amount`. Verified A4.
- [x] `qb_credit_memo_create` posts to AR — customer `Balance` moves by `-TotalAmount` regardless of whether `appliedTo` is passed. Verified A5 (delta = -1000 on first create with no appliedTo).
- [x] `qb_credit_memo_create` with `appliedTo: [{txnId, amount}]` reduces each named invoice's `BalanceRemaining` by `amount` and bumps `AppliedAmount`; flips `IsPaid` when balance hits zero. The customer balance moves only by `-TotalAmount` — application does NOT move it again. Verified P1–P4.
- [x] `qb_credit_memo_create` records `AppliedToTxnRet` array on the memo (one entry per applied invoice with TxnLineID + TxnID + PaymentAmount). Memo `AppliedAmount` = sum(applied), `RemainingValue` = TotalAmount − AppliedAmount. Verified P5.
- [x] `qb_credit_memo_create` with `appliedTo` summing > TotalAmount returns `isError: true` with `statusCode: 500` (overapplication guard at the simulation layer). Verified Q1.
- [x] `qb_credit_memo_create` with an unknown `txnId` in `appliedTo` returns `isError: true` with `statusCode: 500` and does NOT mutate any partial state — atomic rejection. Verified Q2.
- [x] `qb_credit_memo_list` filters by `txnId` (TxnID), `customerName` (EntityFilter), `refNumber`, `fromDate`/`toDate` (TxnDateRangeFilter). Verified J-series.
- [x] `qb_credit_memo_delete` happy path: subsequent `qb_credit_memo_list { txnId }` returns `count: 0`; customer balance reverses by `+TotalAmount`; any applied invoice's `BalanceRemaining` is restored. Verified G1–G3.
- [x] `qb_credit_memo_delete` unknown `txnId` returns `isError: true` with `statusCode: 500`. Verified H1.

**Behavioral criteria** _(`qb_credit_memo_update` — header / line edits)_:
- [x] Header-only mod (no `lines`) leaves the existing `CreditMemoLineRet`, `Subtotal`, `TotalAmount`, `RemainingValue`, `AppliedAmount`, and `TxnLineID`s untouched. Verified B1–B5.
- [x] When `lines` is provided, the array REPLACES the memo's `CreditMemoLineRet` wholesale — lines whose `TxnLineID` is not listed are dropped. Verified D1.
- [x] A line entry with a `txnLineID` matching an existing line preserves that `TxnLineID` and merges the mod's fields onto the existing line (Rate carried over when only Quantity is passed). Verified D2, D3.
- [x] After a line mod, `Subtotal` / `TotalAmount` / `RemainingValue` recompute from the new line set via `computeTotals`. Verified D4.
- [x] After a line mod, customer `Balance` adjusts by `-(newTotalAmount − oldTotalAmount)` so the AR-negative posting stays consistent (memo grew → customer balance drops further; memo shrank → customer balance recovers). Verified D5 (delta = -200 when total grew 1000 → 1200), D6 (delta = +500 when total shrank 1200 → 700).
- [x] `AppliedAmount` is preserved across line mods — a memo with prior applications keeps its application bookkeeping intact through header / line edits. `RemainingValue` recomputes as `TotalAmount − AppliedAmount`. Verified D7 (memo with applied=400, total mod 1000→1200, AppliedAmount stays 400, RemainingValue becomes 800).
- [x] Stale `editSequence` rejects with `statusCode: 3170`; the memo does NOT mutate. Verified C1, C2.
- [x] `EditSequence` rotates after every successful mod. Verified B6.

**Behavioral criteria** _(`qb_credit_memo_apply` — re-application path)_:
- [x] Tool registered. Verified R0.
- [x] Pass `txnId` + `editSequence` + replacement `applyTo: [{txnId, amount}]`. The new array REPLACES the memo's prior application wholesale. Verified R1 (1 invoice → 2 invoices).
- [x] Previously-applied invoices have their `BalanceRemaining` / `AppliedAmount` / `IsPaid` restored by the previously-applied amount. Verified R2 (Invoice A's BR jumps back from 0 → 1000 when the application moves to Invoice B + C).
- [x] Newly-applied invoices have their `BalanceRemaining` reduced by the new applied amount. Verified R3.
- [x] Memo `AppliedToTxnRet` reflects the new application set; `AppliedAmount` = sum(new applied); `RemainingValue` = `TotalAmount − AppliedAmount`. Verified R4.
- [x] Customer `Balance` does NOT move on re-apply — the credit pool just shifts between memo `RemainingValue` and invoice `BalanceRemaining`. Verified R5 (no delta in Customer.Balance before/after re-apply).
- [x] Pass `applyTo: []` to fully unapply: memo `RemainingValue` returns to `TotalAmount`, `AppliedAmount` = 0, `AppliedToTxnRet` = []. Previously-applied invoices fully restored. Customer balance unchanged. Verified S1–S3.
- [x] `sum(applyTo.amount) > TotalAmount` rejects with `statusCode: 500` and the prior application is NOT disturbed (validate-first ordering). Verified T1, T2.
- [x] Unknown invoice `txnId` in `applyTo` rejects with `statusCode: 500`; prior application untouched. Verified T3.
- [x] Stale `editSequence` rejects with `statusCode: 3170`; memo state unchanged. Verified T4.
- [x] `TotalAmount` is immutable on this path — `applyTo` mods do NOT recompute or replace `TotalAmount`. Verified R4.

**Regression criteria**:
- [x] `qb_invoice_update` line mod still recomputes `Subtotal` + `BalanceRemaining` (computeTotals CreditMemo branch did not regress Invoice path). Verified N1.
- [x] `qb_estimate_update` line mod still recomputes `Subtotal`. Verified N2.
- [x] `qb_bill_update` line mod still recomputes `AmountDue`. Verified N3.
- [x] `qb_sales_receipt_update` line mod still recomputes `Subtotal` + `TotalAmount`. Verified N4 (shared post-mod recompute path with newly-added CreditMemo branch).
- [x] `qb_payment_apply` still closes invoices end-to-end via `applyTxnApplications`. Verified N5.
- [x] `qb_payment_receive` still moves customer balance by `-appliedSum` (NOT by full TotalAmount — distinguishing AR-payment semantics from CreditMemo's full-TotalAmount posting). Verified N6.
- [x] `qb_class_list` returns 3 active seed classes. Verified N7.

**Documentation criteria**:
- [x] README updated: tool count 57 → 62; new "Credit Memos" section with intro paragraphs (AR-negative posting, RemainingValue tracking, apply-vs-update distinction) and 5-row tool table.
- [x] `instructions` block in [src/index.ts](src/index.ts) updated — qb_credit_memo_* bullet documents the AR-negative semantics, customer-balance posting at memo level, RemainingValue tracking, the apply path's no-customer-balance-move guarantee, and stale-editSequence rejection.
- [x] No new `DECISIONS.md` entry — CreditMemo follows the established CRUD + apply-mod patterns; the customer-balance-at-memo-level (vs. ReceivePayment's apply-time posting) is a domain semantic, not an architectural choice.
- [x] No `ARCHITECTURE.md` change — CreditMemo is the same builder/parser/store path as Invoice/Estimate/SalesReceipt, with new helpers `applyCreditMemo` / `reverseCreditMemoApplication` / `handleCreditMemoApplyMod` mirroring the ReceivePayment plumbing.

**Verification commands**:
```bash
npm run build              # exits 0
node scratch-verify.mjs    # inline verification script (deleted post-verification)
```

**Notes**:
- The structural difference between CreditMemo and ReceivePayment is *where* customer balance moves: ReceivePayment moves it at apply time (`-appliedSum`, the rest is `UnusedPayment`); CreditMemo moves it at memo-add time (`-TotalAmount`, regardless of application). Re-application on CreditMemo therefore does NOT touch customer balance — it just shifts bookkeeping between `RemainingValue` and invoice `BalanceRemaining`. This is mirrored in `applyCreditMemoApplications` (no `adjustEntityBalance` call) vs. `applyTxnApplications` (calls `adjustEntityBalance` with `-appliedSum`).
- `adjustPartyBalanceForTxnMod` was extended with an optional `sign: 1 | -1 = 1` parameter and `amountField: "TotalAmount"` member. The sign inverts both the same-party delta path and the reverse-then-apply path uniformly. Bill/Invoice continue to call without `sign` (defaults to +1); CreditMemo passes `sign: -1` because TotalAmount growing means customer balance shrinking.
- Discount handling on `AppliedToTxn` lines is intentionally not exposed in `qb_credit_memo_create` / `_apply` — uncommon for credit memos, and the existing `qb_payment_receive` discount path establishes the precedent for the rare case where it matters (discounts on AR closures live on the payment, not the memo).
- The `applyLineMods` regex `^(.+?)Line(s?)Mod$` at [simulation-store.ts](src/session/simulation-store.ts) caught `CreditMemoLineMod` with zero handler changes, exactly as predicted. Builder/parser unchanged: `CreditMemoRet` / `CreditMemoLineRet` / `AppliedToTxnRet` were already in `arrayElements`; CreditMemo was already in `buildDeleteRequest`'s transaction list.

### Item 12 (SalesReceipt) — Sales receipt tools (`qb_sales_receipt_list` / `_create` / `_update` / `_delete`) _(Phase 4)_ — done 2026-04-26

**Status:** done (1 of 4 families in Item 12; CreditMemo / PurchaseOrder / JournalEntry still pending under Item 12)

**Behavioral criteria** _(create / list / delete)_:
- [x] All four tools registered and listed by the MCP server.
- [x] `qb_sales_receipt_create` with a `lines` array returns `Subtotal = sum(line.Amount)` derived server-side via `computeTotals`. Verified A1 (qty=10 × rate=100 → Subtotal=1000).
- [x] `qb_sales_receipt_create` returns `TotalAmount = Subtotal + SalesTaxTotal` (SalesTaxTotal defaults to 0). Verified A2 (TotalAmount=1000).
- [x] `qb_sales_receipt_create` returns `SalesReceiptLineRet` array with one entry per `lines[]`, each with a freshly-generated `TxnLineID` and computed `Amount`. Verified A3.
- [x] `qb_sales_receipt_create` is AR-untouched — customer `Balance` does NOT change. Verified A4 (cash sale; no AR posting).
- [x] `qb_sales_receipt_create` does NOT set `BalanceRemaining`, `IsPaid`, or `AppliedAmount` (no AR fields). Verified A5.
- [x] `qb_sales_receipt_create` carries `PaymentMethodRef`, `DepositToAccountRef` onto the entity when supplied. Verified A6.
- [x] `qb_sales_receipt_list` filters by `txnId` (TxnID), `customerName` (EntityFilter), `refNumber`, `fromDate`/`toDate` (TxnDateRangeFilter). Verified J-series.
- [x] `qb_sales_receipt_delete` happy path: subsequent `qb_sales_receipt_list { txnId }` returns `count: 0`; customer balance unchanged. Verified G1, G2.
- [x] `qb_sales_receipt_delete` unknown `txnId` returns `isError: true` with `statusCode: 500`. Verified H1.

**Behavioral criteria** _(`qb_sales_receipt_update`)_:
- [x] Header-only mod (no `lines`) leaves the existing `SalesReceiptLineRet`, `Subtotal`, `TotalAmount`, and `TxnLineID`s untouched. Verified B1–B4.
- [x] When `lines` is provided, the array REPLACES the receipt's `SalesReceiptLineRet` wholesale — lines whose `TxnLineID` is not listed are dropped. Verified D1.
- [x] A line entry with a `txnLineID` matching an existing line preserves that `TxnLineID` and merges the mod's fields onto the existing line (Rate carried over when only Quantity is passed). Verified D2, D3.
- [x] After a line mod, `Subtotal` and `TotalAmount` recompute from the new line set via `computeTotals` (post-mod recompute branch extended to fire for SalesReceipt). Verified D4, D5.
- [x] `qb_sales_receipt_update` is AR-untouched — customer `Balance` does NOT change before/after header or line mods. Verified B5, D6.
- [x] Stale `editSequence` rejects with `statusCode: 3170`; the receipt does NOT mutate. Verified C1, C2.
- [x] `EditSequence` rotates after every successful mod. Verified B6.

**Regression criteria**:
- [x] `qb_invoice_update` line mod still recomputes Subtotal + BalanceRemaining (computeTotals SalesReceipt branch did not regress Invoice path). Verified N1.
- [x] `qb_estimate_update` line mod still recomputes Subtotal (Estimate branch in post-mod recompute condition still fires). Verified N2.
- [x] `qb_bill_update` line mod still recomputes AmountDue. Verified N3.
- [x] `qb_payment_apply` still closes invoices end-to-end. Verified N4.
- [x] `qb_estimate_convert_to_invoice` still works (shared addEntity path). Verified N5.
- [x] Seed data still loads and `qb_class_list` returns 3 active seed classes. Verified N6.

**Documentation criteria**:
- [x] README updated: tool count 53 → 57; new "Sales Receipts" section with intro paragraphs and 4-row tool table.
- [x] `instructions` block in [src/index.ts](src/index.ts) updated — qb_sales_receipt_* bullet documents the cash-sale semantics, deposit account, line + Subtotal + TotalAmount derivation, AR-untouched guarantee, and stale-editSequence rejection.
- [x] No new `DECISIONS.md` entry — SalesReceipt fits the existing CRUD shape; no architectural choice was made (post-mod recompute extension mirrors the Estimate addition from Item 13).
- [x] No `ARCHITECTURE.md` change — SalesReceipt is the same builder/parser/store path as Invoice/Estimate.

**Verification commands**:
```bash
npm run build              # exits 0
node scratch-verify.mjs    # 38-check inline script (deleted post-verification)
```

**Notes**:
- SalesReceipt's `computeTotals` branch only derives `Subtotal` + `TotalAmount`. Real QB has additional tax fields (`SalesTaxPercentage`, etc.) but those are not derived from lines — they're carried as-is. The simulation defaults `SalesTaxTotal` to 0 if undefined.
- `DepositToAccountRef` is preserved on the stored entity but the simulation does NOT post a corresponding ledger entry against the named account (no GL-balance bookkeeping yet — same scope-line as Invoice/Bill, which also don't update GL accounts in the sim, only the customer/vendor balance).
- The `applyLineMods` regex `^(.+?)Line(s?)Mod$` at [simulation-store.ts:1087](src/session/simulation-store.ts#L1087) caught `SalesReceiptLineMod` with zero handler changes, exactly as predicted by the prior handoff.

### Item 13 — Estimate tools (`qb_estimate_update` / `qb_estimate_delete` / `qb_estimate_convert_to_invoice`) _(Phase 4)_ — done 2026-04-26

**Status:** done

**Behavioral criteria** _(`qb_estimate_update`)_:
- [x] Tool registered and listed by the MCP server. Verified F1 (IsAccepted update via tool path).
- [x] Header-only mod (no `lines`) leaves the existing `EstimateLineRet`, `Subtotal`, and `TxnLineID`s untouched. Verified B1–B6.
- [x] When `lines` is provided, the array REPLACES the estimate's `EstimateLineRet` wholesale — lines whose `TxnLineID` is not listed are dropped. Verified D1 (2 → 1).
- [x] A line entry with a `txnLineID` matching an existing line preserves that `TxnLineID` and merges the mod's fields onto the existing line. Verified D2 (TxnLineID preserved), D3 (Rate carried from existing).
- [x] A line entry with `txnLineID: '-1'` (or omitted) gets a freshly-generated `TxnLineID` and is treated as a new line. Verified E2 (new TxnLineID ≠ existing or '-1').
- [x] After a line mod, `Subtotal` recomputes from the new line set via `computeTotals` (extended to fire for Estimate). Verified D5 (1200), E4 (1325).
- [x] `Amount` re-derives from the merged line: `Quantity * Rate` when both are present (changing only `quantity` on an existing line picks up the existing `rate`); explicit `amount` wins when provided. Verified D4 (12 * 100 = 1200 from merge), E3 (5 * 25 = 125).
- [x] Estimates don't post to AR — `qb_estimate_update` (header or line mod) does NOT touch customer `Balance`. Verified A7, B6, D6.
- [x] `isAccepted: true` flag flips the stored `IsAccepted` field. Verified F1.

**Behavioral criteria** _(`qb_estimate_delete`)_:
- [x] Tool registered. Verified G1 (delete returned a result object).
- [x] Successful delete removes the estimate from the store. Verified G2 (post-delete query returns empty).
- [x] Estimate delete does NOT touch customer `Balance` (estimates are non-posting). Verified G3.
- [x] Delete is wrapped in try/catch and surfaces `isError: true` + `statusCode` for unknown TxnIDs. Verified H1/H2 (statusCode 500).

**Behavioral criteria** _(`qb_estimate_convert_to_invoice`)_:
- [x] Tool registered. Verified J1 (returns invoice object).
- [x] Invoice CustomerRef matches the source estimate. Verified J2.
- [x] Invoice's `InvoiceLineRet` count matches the estimate's `EstimateLineRet` count; each line carries ItemRef, Desc, Quantity, Rate, Amount. Verified J3, J6, J7.
- [x] Invoice TxnLineIDs are freshly generated (not carried from estimate). Verified J8.
- [x] Invoice Subtotal matches estimate Subtotal (1300). Verified J4.
- [x] Invoice posts to AR — customer `Balance` bumps by Subtotal. Verified J13 (delta = +1300).
- [x] Invoice RefNumber defaults to estimate's RefNumber when not overridden. Verified J9.
- [x] Invoice Memo defaults to `"Converted from estimate <ref>"` when not overridden. Verified J10.
- [x] Operator-supplied `invoiceTxnDate` / `invoiceDueDate` / `invoiceRefNumber` / `invoiceMemo` override defaults. Verified M1–M4.
- [x] Default `markAccepted=true` flips estimate `IsAccepted: true` after invoice creation. Verified J11 + J12.
- [x] `markAccepted: false` leaves estimate `IsAccepted` unchanged. Verified K2 + K3.
- [x] Convert non-existent estimate returns `isError: true` (tool layer) — verified at the tool-handler level by inspection (the `if (!estimate)` short-circuit returns the structured error before any side effects).

**Error criteria**:
- [x] `qb_estimate_update` unknown `txnId` rejects via `isError: true` with statusCode 500. Verified I1/I2 via `session.modifyEntity` rejection (the tool's try/catch surfaces this).
- [x] `qb_estimate_update` stale `editSequence` rejects with statusCode 3170. The failed mod does NOT mutate the estimate. Verified C1/C2/C3.
- [x] `qb_estimate_update` new line (no `txnLineID` / `'-1'`) without `itemName`/`itemListId` rejected by `estimateLineModSchema.refine` at the zod boundary. (Schema-only, mirrors invoiceLineModSchema in tools/invoices.ts.)
- [x] `qb_estimate_update` new line without `amount` AND without (`quantity` AND `rate`) rejected by the same refine — Amount must be derivable. (Same.)
- [x] `qb_estimate_delete` unknown `txnId` rejects via `isError: true` with statusCode 500. Verified H1/H2.
- [x] `qb_estimate_convert_to_invoice` source estimate not found returns structured error before any invoice creation. (Tool-layer pre-check — inspection-verified.)

**Regression criteria**:
- [x] `qb_estimate_list` still returns persisted estimates. Verified N5.
- [x] `qb_estimate_create` (now with `lines` support) still creates estimates with the line set converted to `EstimateLineRet`. Verified A1–A6 + J0.
- [x] `qb_invoice_update` (Item 6) still computes Subtotal/BalanceRemaining via the shared `applyLineMods` + `computeTotals` path. Verified N1a–N1c (line mod 5*100 → 10*100 → Subtotal=1000, BalanceRemaining=1000).
- [x] `qb_bill_update` (Item 7) still recomputes AmountDue. Verified N2 (mod from 100 → 250).
- [x] `qb_class_list` (Item 30) still returns 3 active classes. Verified N3.
- [x] `qb_payment_apply` (Item 8) still closes invoices via `ReceivePaymentMod` + `AppliedToTxnMod`. Verified N4 (BalanceRemaining=0 after apply).

**Documentation criteria**:
- [x] README header tool count bumped 50 → 53. Estimate section expanded from 2-tool to 5-tool with intro paragraphs documenting the line-mod semantics, customer-balance non-effect, and the convert flow's carry-over fields + `markAccepted` flag + post-create mark order.
- [x] `instructions` block in [src/index.ts](src/index.ts) updated — estimate bullet now enumerates list/create/update/delete/convert_to_invoice, documents the `lines` argument on create, the wholesale-replace + Subtotal-recompute on update, and the convert tool's mark-after-create order + `markAccepted: false` opt-out.
- [x] `todo.md` Item 13 marked `[x]`.
- [x] `ACCEPTANCE_CRITERIA.md` entry moved to Completed (this entry).
- [x] No new `DECISIONS.md` entry — Option A (tool-layer composition for convert) is just chained primitives. The single architectural touch (extending `handleMod`'s post-mod recompute branch to include Estimate) is a one-line rule extension that mirrors the existing Invoice/Bill semantic for the same line-mod regex; not a tradeoff worth a separate entry.

**Implementation notes**:
- New tool module [src/tools/estimates.ts](src/tools/estimates.ts) hosts all five estimate tools. Estimates were previously co-located with payments in [src/tools/payments.ts](src/tools/payments.ts) — extracted now to follow the "one file per entity domain" convention from CLAUDE.md, since the estimate section was about to balloon from 2 tools to 5. The file header in payments.ts updated accordingly.
- `qb_estimate_create` gained a `lines` arg (same shape as `qb_invoice_create`) — out of strict scope for Item 13 but necessary for `qb_estimate_convert_to_invoice` to be useful end-to-end through the tool surface (without it, the operator can't seed estimates with lines via this MCP and the convert tool has nothing to convert).
- `estimateLineModSchema` mirrors `invoiceLineModSchema` exactly: every field optional, refine requires the create-shape fields ONLY when `txnLineID` is absent or `'-1'`. New lines need `itemName`/`itemListId` AND a way to derive Amount (explicit `amount`, or `quantity` + `rate`).
- `qb_estimate_update` builds the `EstimateLineMod` array only when `args.lines` is provided — header-only mods send no line key and `applyLineMods` short-circuits via `lineModKeys.size === 0`. Try/catch wraps `session.modifyEntity` so simulation 500s and 3170s surface as structured tool errors with `isError: true` + `statusCode` (same pattern as Item 6/7). `isAccepted` is a header field passed through unchanged.
- `qb_estimate_delete` wraps `session.deleteEntity("Estimate", txnId)`. Estimate is in the transaction list at [src/qbxml/builder.ts:115-131](src/qbxml/builder.ts#L115-L131) and routes to `TxnDelRq`. Wrapped in try/catch for the unknown-TxnID case (matches Item 11's structured-error pattern). No customer-balance reversal needed because estimates don't post to AR — the `handleTxnDel` path's adjust call only fires for Invoice/Bill.
- `qb_estimate_convert_to_invoice` is Option A from the prior handoff — pure tool-layer composition. Flow: `queryEntity("Estimate", { TxnID })` → `addEntity("Invoice", { CustomerRef, [carry-over header fields], InvoiceLineAdd: mapped })` → `modifyEntity("Estimate", { IsAccepted: true })`. The mark step runs LAST so a successful invoice is preserved even if the mark fails (surfaced as `markAcceptedError` in the response, distinct from `success: false`). Carries `ClassRef` / `TermsRef` / `SalesRepRef` / `PORefNumber` from the estimate header when present (these can exist on real-QB estimates even though `qb_estimate_create` doesn't accept them yet — the convert tool reads from any estimate, not just MCP-created ones).
- Simulation-store change: extended `handleMod`'s post-mod recompute branch in [src/session/simulation-store.ts](src/session/simulation-store.ts) to fire for Estimate too. Estimate has only `Subtotal` to re-derive (no `AmountDue`, no `BalanceRemaining`, no `IsPaid` — estimates aren't posted to any ledger), and `computeTotals` already handled `Estimate` for the Subtotal case (added in Phase 1 Item 16). The pre-delete that fires for Bill (`delete updated.AmountDue`) is correctly Bill-only — Estimate has no field that needs clearing because `computeTotals` always overwrites Subtotal.
- Verified end-to-end with a 62-check inline script (deleted post-verification): A-series (estimate create with lines + Subtotal derivation + AR-untouched), B-series (header-only mod preservation), C-series (stale EditSequence rejection), D-series (wholesale line replace with merge-by-TxnLineID + Subtotal recompute + AR-untouched), E-series (new-line addition with fresh TxnLineID + Subtotal recompute), F-series (IsAccepted via update), G/H-series (delete happy path + AR-untouched + unknown-TxnID error), I-series (update unknown TxnID error), J-series (default convert with all 13 sub-checks for invoice shape, line carry-over, refnum/memo defaults, mark-accepted, customer balance bump), K-series (markAccepted=false skip), M-series (operator field overrides), N-series regressions for invoice_update / bill_update / class_list / payment_apply / estimate_list. `npm run build` green throughout.

---

### Item 30 — Reference list tools (Class / Terms / PaymentMethod / SalesRep / CustomerType / VendorType) _(Phase 4)_ — done 2026-04-26

**Status:** done

**Behavioral criteria**:
- [x] Six new tools registered and listed by the MCP server: `qb_class_list`, `qb_terms_list`, `qb_payment_method_list`, `qb_sales_rep_list`, `qb_customer_type_list`, `qb_vendor_type_list`. Verified A1–A6.
- [x] Each tool returns a non-empty array when seed data exists for the entity type. Counts: Class=3, StandardTerms=3, DateDrivenTerms=2, PaymentMethod=4, SalesRep=2, CustomerType=3, VendorType=3. Verified B1–B6.
- [x] Each tool returns `{ count: 0, ... : [] }` (graceful empty) when the underlying store has no entities matching the filter. Verified C1.
- [x] `nameFilter`, `activeOnly`, `listId`, `maxReturned` pass through to the simulation's `handleQuery` and behave the same way as in `qb_account_list` / `qb_employee_list`:
  - [x] `nameFilter` is a Contains match against `Name` / `FullName`. Verified D1 (qb_terms_list `nameFilter: "Net"` returns only Net 15 / Net 30 / 2% 10 Net 30).
  - [x] `activeOnly` defaults to true; explicit `activeOnly: false` includes inactive entries. Verified D2 (added an inactive class, default list excludes it, `activeOnly: false` includes it).
  - [x] `listId` fetches a single specific entity. Verified D3.
  - [x] `maxReturned` caps the result count. Verified D4.
- [x] `qb_terms_list` fans across `StandardTerms` + `DateDrivenTerms` by default and merges; result count = StandardTerms count + DateDrivenTerms count. Each row carries a `TermsType` discriminator field set to `"StandardTerms"` or `"DateDrivenTerms"`. Verified E1.
- [x] `qb_terms_list { termsType: "Standard" }` returns only `StandardTerms` rows; `{ termsType: "DateDriven" }` returns only `DateDrivenTerms` rows. Verified E2/E3.
- [x] `qb_sales_rep_list` does NOT accept `nameFilter` (sales reps are keyed by Initial, not Name) — schema-enforced. Confirmed by reading the tool's schema.

**Error criteria**:
- [x] Tools follow existing list-tool conventions (qb_account_list / qb_employee_list / qb_customer_list) which do NOT wrap session errors in try/catch. Reference list queries are read-only and the only meaningful error path is the underlying transport — no need for the structured-error pattern that mutating tools (Items 5/7/8/9/10/11) use.

**Regression criteria**:
- [x] `qb_account_list` defaults still return seed accounts (10). Verified F1.
- [x] `qb_employee_list` defaults still return seed employees. Verified F2.
- [x] `qb_customer_list` defaults still return seed customers (3). Verified F3.
- [x] Item 10 smoke — `qb_account_make_inactive` still works. Verified F4.
- [x] Item 11 smoke — `qb_employee_make_inactive` still works. Verified F5.
- [x] Phase 3 Item 9 smoke — `qb_bill_pay` still closes bills. Verified F6.

**Documentation criteria**:
- [x] README header tool count bumped 44 → 50.
- [x] New "Reference Lists" section between Employees and Reports & Queries explains the read-only nature, the StandardTerms/DateDrivenTerms split for `qb_terms_list`, and lists tool table rows for all six.
- [x] `instructions` block in [src/index.ts](src/index.ts) updated — new bullet enumerates all six tools and explains the `qb_terms_list` fan-out.
- [x] `ACCEPTANCE_CRITERIA.md` entry moved to Completed (this entry).
- [x] No new `DECISIONS.md` entry — fan-out for `qb_terms_list` follows the established `qb_bill_payment_list` pattern (Item 9). Tool-only-no-add/update/delete is the established pattern for read-only reference data (operators define new classes/terms/etc. in QB itself).

**Implementation notes**:
- Tool layer in [src/tools/lists.ts](src/tools/lists.ts) (new file): six tools, all thin wrappers around `session.queryEntity(<type>, filters)`. `qb_terms_list` is the one outlier — fans across `StandardTerms` + `DateDrivenTerms` via `Promise.all`, attaching a `TermsType` discriminator to each row before merging (mirrors the `qb_bill_payment_list` pattern). `qb_sales_rep_list` omits `nameFilter` because real QB SalesRep records are keyed by `Initial`, not by a Name field — `nameFilter` would silently no-op against `e.Name ?? e.FullName` since neither is set.
- Parser in [src/qbxml/parser.ts](src/qbxml/parser.ts): six new `*Ret` entries added to `arrayElements` so multi-element responses come back as arrays even when a single entity exists — `StandardTermsRet`, `DateDrivenTermsRet`, `PaymentMethodRet`, `SalesRepRet`, `CustomerTypeRet`, `VendorTypeRet` (`ClassRet` was already registered).
- Simulation in [src/session/simulation-store.ts](src/session/simulation-store.ts): seed data added at the end of `seedData()` for all seven stores (Class, StandardTerms, DateDrivenTerms, PaymentMethod, SalesRep, CustomerType, VendorType). No request-handler changes needed — the generic `handleQuery` path with `getStore(entityType)` works as-is for any list entity, exactly as the prior Item 11 handoff predicted.
- Builder in [src/qbxml/builder.ts](src/qbxml/builder.ts): no changes — `buildQueryRequest` is generic (`${entityType}QueryRq`) so Class / StandardTerms / DateDrivenTerms / PaymentMethod / SalesRep / CustomerType / VendorType all flow through the existing path.
- Verified end-to-end with a 25-check inline script (deleted post-verification): A1–A6 tool registration; B1–B6 seed-data presence per type; C1 graceful empty; D1–D4 filter pass-through (nameFilter / activeOnly / listId / maxReturned); E1–E3 termsType fan-out; F1–F6 regressions. `npm run build` green throughout.

---

### Item 11 — `qb_employee_make_inactive` + `qb_employee_delete` _(Phase 4)_ — done 2026-04-26

**Status:** done

**Behavioral criteria**:
- [x] `qb_employee_make_inactive` is registered and listed by the MCP server. Accepts `listId` + `editSequence` only (bare-minimum schema). Verified A1.
- [x] Calling `qb_employee_make_inactive` with a valid `listId` + matching `editSequence` returns the modified employee with `IsActive: false` and a fresh `EditSequence`. Verified A3/A4.
- [x] After deactivation, the employee does NOT appear in `qb_employee_list { activeOnly: true }`. Verified A5.
- [x] After deactivation, the employee DOES appear in `qb_employee_list { activeOnly: false }` — record preserved, just hidden. Verified A6.
- [x] Reversible via `qb_employee_update { isActive: true }`. Verified A7/A8.
- [x] `qb_employee_delete` is registered and listed. Accepts `listId` only. Verified C1.
- [x] `qb_employee_delete` removes the employee from the store (subsequent list queries don't contain it). Verified C2.
- [x] `qb_employee_delete` returns `{ success: true, deleted: { ListDelType: "Employee", ListID: <id> } }` on success. Verified C1.

**Error criteria**:
- [x] `qb_employee_make_inactive` with stale `editSequence` returns `isError: true` + `statusCode: 3170`. Verified B1; employee stays active after rejection (B2).
- [x] `qb_employee_make_inactive` with unknown `listId` returns `isError: true` + `statusCode: 500`. Verified B3.
- [x] `qb_employee_delete` with unknown `listId` returns `isError: true` + `statusCode: 500`. Verified D1.
- [x] Both tools wrap session calls in try/catch (same pattern as Items 5/7/8/9/10) — simulation errors surface as structured `isError: true` + `statusCode`, not raw exceptions.
- [x] `qb_employee_delete` tool description warns about the inactive-vs-delete tradeoff (real QB returns 3260/3170 for employees with paycheck/timesheet history).

**Regression criteria**:
- [x] `qb_employee_list` (existing) still returns seed employees. Verified E1.
- [x] `qb_employee_add` (existing) still creates employees with `IsActive: true`. Verified E2.
- [x] `qb_employee_update` (existing) still updates non-IsActive fields (Phone). Verified E3.
- [x] Shared `handleListDel` plumbing intact — Account delete still works. Verified E4.
- [x] Item 10 smoke — `qb_account_make_inactive` still flips `IsActive`. Verified E5.
- [x] Phase 3 Item 9 smoke — `qb_bill_pay` still closes bills (AmountDue=0, IsPaid=true). Verified E6.

**Documentation criteria**:
- [x] README employee section: explains `qb_employee_make_inactive` (preferred for employees with history) vs `qb_employee_delete` (hard delete) tradeoff. Tool table rows added for both.
- [x] `instructions` block in [src/index.ts](src/index.ts) updated — employee bullet now mentions delete + make_inactive with the inactive-vs-delete tradeoff.
- [x] Tool count in README header bumped 42 → 44.
- [x] `ACCEPTANCE_CRITERIA.md` entry moved to Completed (this entry).
- [x] No new `DECISIONS.md` entry — same two-separate-tools pattern as Item 10 (an established QB SDK convention, not a project-specific tradeoff).

**Implementation notes**:
- Tool layer in [src/tools/employees.ts](src/tools/employees.ts):
  - `qb_employee_make_inactive` is a thin wrapper around `session.modifyEntity("Employee", { ListID, EditSequence, IsActive: false })`. Bare-minimum schema (just `listId` + `editSequence`) — operators wanting to mutate FirstName / LastName / Phone / Email should still use `qb_employee_update`.
  - `qb_employee_delete` wraps `session.deleteEntity("Employee", listId)`. Tool description explicitly warns about real QB's 3260/3170 rejection for employees with paycheck/timesheet history and recommends `make_inactive` as the safer default.
  - Both tools use the established try/catch pattern from Items 5/7/8/9/10.
- Simulation in [src/session/simulation-store.ts](src/session/simulation-store.ts) — no changes needed. `handleMod`'s generic `{...modData}` spread already supports `IsActive` mutation; `handleListDel` already routes `Employee` to its own per-entity store generically (the entityType is read from `ListDelType`). Same as Item 10.
- Verified end-to-end with a 20-check inline script (deleted post-verification): A1–A8 make_inactive happy path including reversibility via `qb_employee_update`; B1–B3 stale-EditSequence (3170) and unknown-listId (500) error paths with no side effects on rejection; C1–C2 delete happy path; D1 delete error path; E1–E6 regressions for `qb_employee_list` defaults, `qb_employee_add` IsActive default, `qb_employee_update` non-IsActive fields (Phone), shared `handleListDel` plumbing via Account delete, Item 10 `qb_account_make_inactive` smoke, and Phase 3 Item 9 `qb_bill_pay` smoke. `npm run build` green throughout.

---

### Item 10 — `qb_account_delete` + `qb_account_make_inactive` _(Phase 4)_ — done 2026-04-26

**Status:** done

**Behavioral criteria**:
- [x] `qb_account_make_inactive` is registered and listed by the MCP server. Accepts `listId` + `editSequence` only (bare-minimum schema). Verified A1.
- [x] Calling `qb_account_make_inactive` with a valid `listId` + matching `editSequence` returns the modified account with `IsActive: false` and a fresh `EditSequence`. Verified A4/A5.
- [x] After deactivation, the account does NOT appear in `qb_account_list { activeOnly: true }`. Verified A6.
- [x] After deactivation, the account DOES appear in `qb_account_list { activeOnly: false }` — record preserved, just hidden. Verified A7.
- [x] Reversible via `qb_account_update { isActive: true }`. Verified A8/A9.
- [x] `qb_account_delete` is registered and listed. Accepts `listId` only. Verified C1.
- [x] `qb_account_delete` removes the account from the store (subsequent list queries don't contain it). Verified C4.
- [x] `qb_account_delete` returns `{ success: true, deleted: { ListDelType: "Account", ListID: <id> } }` on success. Verified C2/C3.

**Error criteria**:
- [x] `qb_account_make_inactive` with stale `editSequence` returns `isError: true` + `statusCode: 3170`. Verified B1/B2; account stays active after rejection (B3).
- [x] `qb_account_make_inactive` with unknown `listId` returns `isError: true` + `statusCode: 500`. Verified B4/B5.
- [x] `qb_account_delete` with unknown `listId` returns `isError: true` + `statusCode: 500`. Verified D1/D2.
- [x] Both tools wrap session calls in try/catch (same pattern as Items 5/7/8/9) — simulation errors surface as structured `isError: true` + `statusCode`, not raw exceptions.
- [x] `qb_account_delete` tool description warns about the inactive-vs-delete tradeoff (real QB returns 3260/3170 for accounts with history).

**Regression criteria**:
- [x] `qb_account_list` (existing) still returns the seed accounts. Verified E1/E2 (Checking + Utilities seed accounts present).
- [x] `qb_account_add` (existing) still creates accounts with `IsActive: true`. Verified E3/E4.
- [x] `qb_account_update` (existing) still updates non-IsActive fields (Description). Verified E5/E6.
- [x] Shared `handleListDel` plumbing intact — Customer delete still works. Verified E7.
- [x] Phase 3 Item 9 (`qb_bill_pay`) smoke — bill_pay closure + IsPaid flip + payment TotalAmount. Verified F1–F3.

**Documentation criteria**:
- [x] README account section: explains `qb_account_make_inactive` (preferred for accounts with history) vs `qb_account_delete` (hard delete) tradeoff. Tool table rows added for both.
- [x] `instructions` block in [src/index.ts](src/index.ts) updated — account bullet now mentions delete + make_inactive with the inactive-vs-delete tradeoff.
- [x] Tool count in README header bumped 40 → 42.
- [x] `ACCEPTANCE_CRITERIA.md` entry moved to Completed (this entry).
- [x] No new `DECISIONS.md` entry — two-separate-tools (vs discriminated) was the recommended choice in the prior handoff and matches the existing pattern (e.g. `qb_invoice_delete` is its own tool, not a mode of `qb_invoice_update`).

**Implementation notes**:
- Tool layer in [src/tools/accounts.ts](src/tools/accounts.ts):
  - `qb_account_make_inactive` is a thin wrapper around `session.modifyEntity("Account", { ListID, EditSequence, IsActive: false })`. Bare-minimum schema (just `listId` + `editSequence`) — operators wanting to mutate Name / AccountNumber / Description should still use `qb_account_update`.
  - `qb_account_delete` wraps `session.deleteEntity("Account", listId)`. Tool description explicitly warns about real QB's 3260/3170 rejection for accounts with history and recommends `make_inactive` as the safer default.
  - Both tools use the established try/catch pattern from Items 5/7/8/9 — `session.*Entity` errors surface as `isError: true` + structured `error` + `statusCode`.
- Simulation in [src/session/simulation-store.ts](src/session/simulation-store.ts) — no changes needed. `handleMod`'s generic `{...modData}` spread already supports `IsActive` mutation; `handleListDel` already supports `Account` (the entityType is read from `ListDelType` and the per-entity store is generic).
- Verified end-to-end with a 30-check inline script (deleted post-verification): A1–A9 make_inactive happy path including reversibility via `qb_account_update`; B1–B5 stale-EditSequence and unknown-listId error paths; C1–C4 delete happy path; D1/D2 delete error path; E1–E7 regressions for `qb_account_list` defaults, `qb_account_add` IsActive, `qb_account_update` non-IsActive fields, and shared `handleListDel` plumbing via Customer; F1–F3 Phase 3 Item 9 smoke. `npm run build` green throughout.

---

### Item 9 — `qb_bill_pay` + `qb_bill_payment_list` _(Phase 3)_ — done 2026-04-26

**Status:** done

**Behavioral criteria**:
- [x] `qb_bill_pay` is registered and listed by the MCP server. Routes via `paymentMethod: "check" | "creditcard"` discriminator to `BillPaymentCheck` or `BillPaymentCreditCard`. Verified A1–A10 (check route) + E1–E5 (credit card route — payment lands in correct store, NOT the other).
- [x] `applyTo: [{txnId, amount, discountAmount?, discountAccountName?}]` is required and non-empty (`z.array(...).min(1)`); empty array rejected at the simulation level too with statusCode 500. Verified G1/G2.
- [x] Each `applyTo` entry reduces the named bill's `AmountDue` by `paymentAmount + discountAmount`. Verified A3 (500 → 0), B1 (1000 → 700), C1+C3 (multi-bill split), D1 (950 + 50 discount → 0), H1 (over-payment → -50).
- [x] Bill `IsPaid` flips to true when `AmountDue` hits 0 exactly. Verified A4, C2/C4, D2, E2.
- [x] Over-payment leaves `AmountDue` negative + `IsPaid` false (vendor credit semantics — matches Invoice over-application policy from Item 6). Verified H1/H2 (AmountDue = -50, IsPaid = false).
- [x] Vendor `Balance` decreases by the applied sum (NOT including discount). Verified A5 (-500), B3 (-300), C5 (-500 across two bills), D3 (-950 NOT -1000), E3 (-400), H3 (-150 on over-pay).
- [x] `BillPaymentCheck.TotalAmount` / `BillPaymentCreditCard.TotalAmount` returned on the response = sum of applied PaymentAmounts (NOT including discount, since discount isn't a cash flow). Verified A6, C6, D4, H4.
- [x] `AppliedToTxnRet` array carries `TxnLineID`, `TxnID`, `PaymentAmount`, optional `DiscountAmount` + `DiscountAccountRef`. Verified A7–A9, C7, D5/D6.
- [x] `qb_bill_payment_list` fans out across both `BillPaymentCheck` + `BillPaymentCreditCard` stores by default; `paymentType: "check" | "creditcard"` scopes to one. Verified I1/I2 (mixed inventory: count = checkStore + ccStore, both stores have entries from prior checks).
- [x] `Bill.IsPaid` field added by `computeTotals` symmetric with Invoice — bills created via `qb_bill_create` have `IsPaid = false` initially (since `AmountDue > 0`); bills with no lines or explicit `AmountDue: 0` have `IsPaid = true`. Verified A1/A2 (created bill has `AmountDue=500`, `IsPaid=false`).

**Error criteria**:
- [x] Unknown bill `txnId` in `applyTo` rejects with `isError: true`, statusCode 500. CRITICAL atomicity invariant: a valid line followed by an orphan in the SAME `AppliedToTxnAdd` array does NOT mutate the valid bill or move vendor balance. Verified F1–F6 (line 1 = real bill $800, line 2 = orphan; rejected; real bill still AmountDue=800/IsPaid=false; vendor balance UNCHANGED; NO phantom payment in store).
- [x] Empty `applyTo` array rejected at the simulation level (defensive — tool layer's `z.array(...).min(1)` gates this first, but the simulation guards too in case a future caller bypasses the schema). Verified G1/G2.
- [x] Tool layer's try/catch wraps `session.addEntity` so simulation 500s surface as structured `isError: true` + `statusCode` (same pattern as Items 5/8).

**Regression criteria**:
- [x] `qb_payment_receive` (Item 5) Add path with `appliedTo` still closes invoices and moves customer balance. Verified J1/J2.
- [x] `qb_payment_apply` (Item 8) `ReceivePaymentMod` path still re-applies an existing payment to a new invoice. Verified L1.
- [x] `qb_bill_update` (Item 7) line mod still recomputes `AmountDue` and moves vendor balance by the delta. Verified K1/K2/K3 — including the new `IsPaid` field staying false on a non-zero AmountDue post-update.
- [x] `qb_bill_create` (Item 4) still creates a bill with `AmountDue = sum(lines)` and `IsPaid = false`. Verified A1/A2 (used as setup throughout).
- [x] AP aging would reflect the post-payment vendor balance — `qb_ap_aging` reads `Vendor.Balance` directly per Item 18, which is moved end-to-end via `adjustEntityBalance("Vendor", refKey, -appliedSum)` in `applyBillPayment`.
- [x] No new TypeScript errors; `npm run build` green throughout.

**Documentation criteria**:
- [x] README bill section: two new paragraphs explain `qb_bill_pay` semantics (paymentMethod discriminator, applyTo required, AmountDue reduction, IsPaid flip, discount handling, over-payment policy, atomic orphan rejection) and `qb_bill_payment_list` fan-out. Tool table rows added for both.
- [x] `instructions` block in [src/index.ts](src/index.ts) bill bullet expanded with `qb_bill_pay` + `qb_bill_payment_list` semantics.
- [x] Tool count in README header bumped 38 → 40.
- [x] `ACCEPTANCE_CRITERIA.md` entry moved to Completed (this entry).
- [x] No new `DECISIONS.md` entry — single-tool-with-discriminator + single-list-with-fanout were the recommended choices in the prior handoff and don't introduce surprise tradeoffs. Parallel `applyBillPayment` (rather than a generic `applyTxnPayments` extracted from the AR side) follows CLAUDE.md's "three similar lines is better than a premature abstraction" — there are exactly 2 call sites and the divergent fields (no AppliedAmount/UnusedPayment on bill payments, different store/balance/ref) make the abstraction shape uncertain. Will revisit if a third payment kind lands.

**Implementation notes**:
- Tool layer in [src/tools/bills.ts](src/tools/bills.ts):
  - New `appliedToBillSchema` duplicated alongside `appliedToSchema` from [src/tools/payments.ts](src/tools/payments.ts) — same field shape but the named entity is a Bill. Hoisting to a shared file deferred (8 lines, two call sites; no share-pressure yet).
  - `qb_bill_pay` is a single tool with `paymentMethod: z.enum(["check", "creditcard"])` discriminator. Routes to `addEntity("BillPaymentCheck", ...)` or `addEntity("BillPaymentCreditCard", ...)` in the handler. Optional `bankAccountName` / `creditCardAccountName` / `apAccountName` fields propagate as `BankAccountRef` / `CreditCardAccountRef` / `APAccountRef` (real QB SDK shape).
  - `applyTo` uses `.min(1)` so the schema rejects empty arrays at the boundary.
  - try/catch wraps `session.addEntity` so simulation 500s surface as structured tool errors with `isError: true` + `statusCode` (same pattern as Items 5/8).
  - `qb_bill_payment_list` fans out via `Promise.all` when no `paymentType` is provided (parallel queries on both stores). Single-type queries skip the fan-out. `MaxReturned` is applied per-store on the fan-out path — documented in the field's `.describe()`.
- Simulation in [src/session/simulation-store.ts](src/session/simulation-store.ts):
  - New `applyBillPayment(payment)` is a parallel function to `applyReceivePayment`. Two-pass: validate every TxnID exists in the Bill store first (atomicity), then mutate. No overapplication-vs-TotalAmount check because BillPayment's TotalAmount is derived from the applied sum (not a separable header total like ReceivePayment's). Sets `payment.TotalAmount = appliedSum` so consumers don't have to re-derive.
  - Bill mutation: `bill.AmountDue -= paymentAmount + discountAmount`, `bill.IsPaid = bill.AmountDue === 0`. Strict equality (no clamping on over-payment) matches Item 6's BalanceRemaining policy.
  - Vendor balance moves via the existing `adjustEntityBalance("Vendor", refKey, -appliedSum)` helper from Item 18 — same machinery as Item 5's AR-side customer balance move.
  - `handleAdd` branches on `entityType === "BillPaymentCheck" || entityType === "BillPaymentCreditCard"` and dispatches to `applyBillPayment`. Mirrors the existing `entityType === "ReceivePayment"` branch.
  - `computeTotals` extended: Bill branch now sets `result.IsPaid = Number(result.AmountDue ?? 0) === 0`. Symmetric with Invoice's `IsPaid` derivation. Invoice's `IsPaid` set independently a few lines below — kept separate for readability since Invoice's `BalanceRemaining` formula has more inputs (Subtotal + SalesTaxTotal − AppliedAmount).
  - No `BillPaymentCheckMod` / `BillPaymentCreditCardMod` path — Item 9 is Add-only. Re-targeting bill payments is implicit Phase 4 work; not currently in the todo list.
- Parser in [src/qbxml/parser.ts](src/qbxml/parser.ts): added `BillPaymentCheckRet`, `BillPaymentCreditCardRet` to `arrayElements` so live mode parses single-bill-payment responses as 1-element arrays. `AppliedToTxnRet` was already there from Item 5.
- Verified end-to-end with a 51-check inline script (deleted post-verification per "no test infra yet"): single-bill check happy path with full close-out + IsPaid flip + vendor balance drop (A1–A10), partial pay with bill open + IsPaid false (B1–B3), multi-bill split closing both bills atomically (C1–C7), discount preservation with vendor-balance-only-by-paid-amount (D1–D6), credit card route lands in correct store (E1–E5), orphan TxnID atomicity — line 1 valid + line 2 orphan = NO mutation anywhere (F1–F6), empty applyTo rejection (G1/G2), over-payment producing negative AmountDue + IsPaid false + full vendor balance hit (H1–H4), `qb_bill_payment_list` fan-out (I1/I2), regressions for Item 5 `qb_payment_receive` (J1/J2), Item 7 `qb_bill_update` line mod with new IsPaid field (K1–K3), Item 8 `qb_payment_apply` (L1). One verification-script bug surfaced and fixed: `vbal()` helper used `ListFilter: { FullName: ... }` which the sim doesn't recognize, so it silently returned all vendors and `r[0]` was wrong on any non-first vendor. Fixed by querying all + `find(v => v.FullName === name)`. Implementation was correct throughout. `npm run build` green.

---

### Item 8 — `qb_payment_apply` (`ReceivePaymentMod` + `AppliedToTxnMod`) _(Phase 3)_ — done 2026-04-26

**Status:** done

**Behavioral criteria**:
- [x] `qb_payment_apply` is registered and listed by the MCP server. Verified A5/B/C/D/E paths all execute through the tool's `session.modifyEntity("ReceivePayment", ...)` plumbing.
- [x] Calling with `txnId` + `editSequence` + `applyTo: [{txnId, amount}]` against a previously-unapplied payment closes the named invoice (`BalanceRemaining` → 0, `IsPaid=true`, `AppliedAmount` bumps by amount), drops customer balance by the applied sum, and rotates the payment's `EditSequence`. Verified A5–A12.
- [x] Re-targeting from invoice A → invoice B atomically reverses A (BR/AppliedAmount/IsPaid restored) and applies B. Customer balance moves by the *change* in applied sum (delta=0 in same-amount case, signed when amounts differ). Verified B4–B10 (re-target with delta=0) and C7 (delta=+700 → balance drops by 700) and D5 (delta=-600 → balance rises by 600).
- [x] `applyTo: []` (or omitted `AppliedToTxnMod` block) fully unapplies the payment: the previously-applied invoices are restored, customer balance is restored, payment carries `AppliedToTxnRet=[]` + `AppliedAmount=0` + `UnusedPayment=TotalAmount`. Verified E2–E8.
- [x] Discount is preserved through the mod path: `DiscountAmount` reduces `BalanceRemaining` alongside the payment but does NOT count toward `AppliedAmount` and does NOT move the customer balance. `DiscountAccountRef` round-trips. Verified F1–F7.
- [x] Multi-invoice application splits a single payment across N invoices in one call. Verified J1–J6 (2-invoice split).
- [x] Header fields (`memo`, `refNumber`, `txnDate`, `paymentMethodName`) propagate through the mod and persist via re-query. Verified K1–K4 for memo + refNumber.
- [x] `payment.AppliedAmount = sum(new applied)` and `payment.UnusedPayment = TotalAmount - sum(new applied)` recompute after every mod. Verified across A6, B12/B13, C8/C9, D6/D7, E7/E8, F7, J5/J6.

**Error criteria**:
- [x] Unknown invoice `txnId` in `applyTo` rejects with `isError: true`, statusCode 500. The failed mod does NOT reverse the existing application or move the customer balance. Verified H2–H6.
- [x] Overapplication (`sum(applyTo.amount) > payment.TotalAmount`) rejects with statusCode 500. The simulation is the authoritative gate (the tool can't validate against TotalAmount without a pre-query). Verified I1–I5; payment + invoice state untouched after rejection.
- [x] Stale `editSequence` rejects with statusCode 3170 via the global `handleMod` EditSequence check. The failed mod does NOT mutate the payment or invoices. Verified G1–G4.

**Regression criteria**:
- [x] `qb_payment_receive` (Item 5) Add path with `appliedTo` still closes invoices and moves customer balance. Verified L1.
- [x] `qb_invoice_update` (Item 6) header-only mod still propagates Memo. Verified M1.
- [x] `qb_bill_update` (Item 7) line-mod still recomputes `AmountDue`. Verified N1.
- [x] `qb_payment_list` returns the modded payment with intact `AppliedToTxnRet` (verified throughout — every check re-queried via `getPayment`).
- [x] AR aging reflects the moved customer balance — Item 18's helpers `adjustEntityBalance` / `Customer.Balance` direct read drive both the apply and reverse paths.

**Documentation criteria**:
- [x] README payment section: intro paragraph explains `qb_payment_apply` semantics — replacement-array, reverse-then-apply, customer-balance-by-delta, empty-array-fully-unapplies, immutable TotalAmount, 3170 rejection on stale editSequence. Tool table row added.
- [x] `instructions` block in [src/index.ts](src/index.ts): `qb_payment_*` line expanded to flag `qb_payment_apply` + the immutable-TotalAmount rule + 3170 rejection.
- [x] Tool count in README header bumped 37 → 38.
- [x] `ACCEPTANCE_CRITERIA.md` entry moved to Completed (this entry).
- [x] No new `DECISIONS.md` entry — the validate-then-reverse-then-apply ordering is the obvious atomicity choice (avoids the rollback-on-orphan edge case) and falls naturally out of the existing two-pass pattern in `applyTxnApplications`. The "TotalAmount is immutable on this path" choice matches real QB and is documented in the tool description.

**Implementation notes**:
- Tool layer in [src/tools/payments.ts](src/tools/payments.ts):
  - Reused the existing `appliedToSchema` from Item 5 — same shape (`txnId`, `amount`, optional `discountAmount` + `discountAccountName`).
  - `applyTo` is required (no `.optional()`), but the tool accepts `applyTo: []` to fully unapply. Forcing the operator to pass an explicit array (even empty) makes intent unambiguous.
  - Builds `AppliedToTxnMod` blocks in the same shape as `AppliedToTxnAdd` from Item 5 — the simulation engine accepts both because `applyTxnApplications` only reads `TxnID` / `PaymentAmount` / `DiscountAmount` / `DiscountAccountRef` from each line.
  - try/catch wraps `session.modifyEntity` so simulation 500s (orphan TxnID, overapplication) and 3170s (stale EditSequence) surface as structured tool errors with `isError: true` + `statusCode`.
  - Optional header fields (`memo`, `refNumber`, `txnDate`, `paymentMethodName`) propagate through the same merge path used by `qb_payment_receive`.
- Simulation engine refactor in [src/session/simulation-store.ts](src/session/simulation-store.ts):
  - Split `applyReceivePayment`'s validation pass into a standalone `validateTxnApplications(lines, totalAmount)` helper. Pure — returns ok/error with no mutation. Reused by `applyTxnApplications` (called inline) and by `handleReceivePaymentMod` (called BEFORE the reversal so a doomed mod never disturbs payment state).
  - New `applyTxnApplications(payment, lines)` is the engine for both Add and Mod paths. Takes the line array directly so the caller controls where it comes from (`payment.AppliedToTxnAdd` for Add, `modData.AppliedToTxnMod` for Mod).
  - `applyReceivePayment` is now a thin shim that reads `payment.AppliedToTxnAdd`, deletes it, and hands the array to `applyTxnApplications`.
  - New `reverseReceivePaymentApplication(payment)` walks `payment.AppliedToTxnRet` and undoes every per-invoice bump + customer balance move. Tolerates orphan TxnIDs in the prior application (silently skipped on per-invoice undo, but still moves customer balance by the named applied sum — the original Add path moved the customer balance regardless of where the targets ended up). Resets `AppliedToTxnRet=[]`, `AppliedAmount=0`, `UnusedPayment=TotalAmount`.
  - New `handleReceivePaymentMod` in `handleMod`: short-circuits before the Bill/Invoice line-mod plumbing (the AppliedToTxnMod block doesn't match `/^(.+?)Line(s?)Mod$/` and the rest of the path doesn't apply). Flow: validate → reverse → apply → merge headers → bump TimeModified + EditSequence → persist. Reserved keys (`AppliedToTxnMod`, `AppliedToTxnRet`, `AppliedAmount`, `UnusedPayment`, `TotalAmount`, `TxnID`, `EditSequence`) stripped from the header merge — the engine owns those, the operator can't overwrite.
  - `validateTxnApplications` is called twice per mod (once in `handleReceivePaymentMod`, once inside `applyTxnApplications`). Cheap (O(N) per pass), and the redundant call is the price of keeping `applyTxnApplications` self-validating for the Add path.
- Verified end-to-end with an 84-check inline script (deleted post-verification per "no test infra yet"): single-invoice apply (A1–A12), re-target with delta-zero balance (B1–B13), increase applied with positive delta on customer balance (C1–C9), decrease applied with negative delta (D1–D7), full unapply via empty AppliedToTxnMod (E1–E8), discount preservation through mod path (F1–F7), stale-EditSequence rejection without rollback (G1–G4), orphan TxnID rejection without side effects (H1–H6) — confirms the validate-first ordering works, overapplication rejection (I1–I5), multi-invoice split (J1–J6), header field propagation (K1–K4), and regressions for `qb_payment_receive` Item 5 (L1), `qb_invoice_update` Item 6 (M1), `qb_bill_update` Item 7 (N1). `npm run build` green throughout.

---

### Item 6 — `qb_invoice_update` line mod (`InvoiceLineMod`) _(Phase 3)_ — done 2026-04-26

**Status:** done

**Behavioral criteria**:
- [x] `qb_invoice_update` accepts an optional `lines: [{txnLineID?, itemName?, itemListId?, description?, quantity?, rate?, amount?}]` arg. Verified A1 setup + B/D/E/F/G mods.
- [x] Header-only mod (no `lines`) leaves the existing `InvoiceLineRet` array, `Subtotal`, `BalanceRemaining`, `IsPaid`, and `AppliedAmount` untouched. Memo propagates. Verified B1–B9.
- [x] When `lines` is provided, the array REPLACES the invoice's `InvoiceLineRet` wholesale — lines whose `TxnLineID` is not listed are dropped. Verified D1 (2 → 1) and F1 (2 → 1 again with different existing line).
- [x] A line entry with a `txnLineID` matching an existing line preserves that `TxnLineID` and merges the mod's fields onto the existing line. Verified D2 (TxnLineID preserved), D3 (rate carried), D5 (Desc merged), F3 (rate carried via partial merge).
- [x] A line entry without `txnLineID` (or with `'-1'`) gets a freshly-generated `TxnLineID` and is treated as a new line. Verified E3 (new TxnLineID ≠ either prior ID).
- [x] After a line mod, `Subtotal` recomputes from the new line set; `BalanceRemaining = Subtotal + SalesTaxTotal - AppliedAmount` recomputes; `IsPaid = (BalanceRemaining === 0)` recomputes. Verified D6/D7/D8, E5, F5/F6, G3/G5/G6.
- [x] `AppliedAmount` is preserved across line mods (paid portions don't disappear when lines change). Verified D9 (=0 preserved), G4 (=600 preserved across over-apply mod).
- [x] If a line mod drops `Subtotal` below `AppliedAmount`, `BalanceRemaining` goes negative (over-application state) and `IsPaid` becomes false. No clamping. Verified G5 (BR=-300) and G6 (IsPaid=false on negative).
- [x] Customer `Balance` adjusts by `newBalanceRemaining - oldBalanceRemaining` (signed delta). Verified D10 (-50), E6 (+75), F (transitive), G7 (-700 on over-apply), and reverse-then-apply on customer change H3 (-500) + H4 (+500).
- [x] An `Amount` re-derives from the merged line: `Quantity * Rate` when both are present (changing only `quantity` on an existing line picks up the existing `rate`); explicit `amount` wins when provided; otherwise carries from the merge. Verified F4 (`5 * 100 = 500` from existing rate), E4 (explicit `Amount: 75` honored), D4 (`2 * 100 = 200` from preserved fields).

**Error criteria**:
- [x] Unknown `txnId` rejects via `isError: true` with statusCode 500. Verified I1/I2 via tool's try/catch wrapper around `session.modifyEntity`.
- [x] Stale `editSequence` rejects with statusCode 3170. The failed mod does NOT mutate the invoice. Verified C1/C2/C3.
- [x] New line (no `txnLineID` / `'-1'`) without `itemName`/`itemListId` rejected by `invoiceLineModSchema.refine` at the zod boundary. (Schema-only, not exercised in the QBSessionManager-level script.)
- [x] New line without `amount` AND without (`quantity` AND `rate`) rejected by the same refine — Amount must be derivable. (Same.)

**Regression criteria**:
- [x] `qb_invoice_create` still creates with `Subtotal = sum(lines)` and customer balance bump. Verified M1/M2.
- [x] `qb_invoice_delete` still reverses customer balance. Verified N1.
- [x] `qb_invoice_list` still returns persisted invoices with intact `InvoiceLineRet` (verified throughout — every mod check re-queried via getInvoice).
- [x] `qb_bill_update` still works (Item 7 path) — same `applyLineMods`, same `EditSequence` enforcement, same generalized party-balance helper. Verified K1 (create=100), K2 (mod=250), K3 (vendor balance moved by +150).
- [x] `qb_payment_receive` (Item 5) still applies and updates invoice `BalanceRemaining` / `AppliedAmount`. Verified G1 (AppliedAmount=600), G2 (BalanceRemaining=400) — payment side worked end-to-end before the line-mod.
- [x] `qb_customer_update` with fresh `EditSequence` still succeeds. Verified L1.
- [x] AR aging reflects post-mod customer balance — reads `Customer.Balance` directly per Item 18; balance moves are end-to-end-verified.

**Documentation criteria**:
- [x] README invoice section: intro paragraph documents `lines` semantics, BalanceRemaining recompute, AppliedAmount preservation, negative-on-overapply, customer-balance delta, and the 3170 rejection. Tool table row updated with `lines` shape and customer-balance delta description.
- [x] `instructions` block in [src/index.ts](src/index.ts) invoice bullet expanded with mod semantics, `AppliedAmount` preservation, over-apply behavior, and 3170 rejection.
- [x] `ACCEPTANCE_CRITERIA.md` entry moved to Completed (this entry).
- [x] No new `DECISIONS.md` entry — Item 7's "Bill line-mod uses wholesale replacement with merge-by-TxnLineID" already documents the generic line-mod approach. The negative-`BalanceRemaining` policy (accept, no clamp) follows directly from `BalanceRemaining = Subtotal + SalesTaxTotal - AppliedAmount` and matches real QB; not a tradeoff worth a separate entry.

**Implementation notes**:
- Tool layer in [src/tools/invoices.ts](src/tools/invoices.ts):
  - `invoiceLineModSchema` mirrors Item 7's pattern: every field optional so a partial mod (e.g. just `description` on an existing line) works; refine requires the create-shape fields ONLY when `txnLineID` is absent or `'-1'`. New lines need `itemName`/`itemListId` AND a way to derive Amount (explicit `amount`, or `quantity` + `rate`).
  - `qb_invoice_update` builds the `InvoiceLineMod` array only when `args.lines` is provided — header-only mods send no line key and `applyLineMods` short-circuits via `lineModKeys.size === 0`.
  - Try/catch wraps `session.modifyEntity` so simulation 500s and 3170s surface as structured tool errors with `isError: true` + `statusCode` (same pattern as Item 5/7).
- Simulation `handleMod` in [src/session/simulation-store.ts](src/session/simulation-store.ts):
  - Generalized `adjustVendorBalanceForBillMod` → `adjustPartyBalanceForTxnMod(partyType, refField, amountField, before, after, oldAmount)`. Bill and Invoice share the same machinery; the only per-entity choices are which ref field to read and which amount field maps to the party's open balance.
  - `oldPartyAmount` capture branches on `entityType`: Bill reads `existing.AmountDue`, Invoice reads `existing.BalanceRemaining`. Captured BEFORE `applyLineMods` so the pre-mod value is preserved.
  - Recompute branch fires for both Bill and Invoice when `lineModKeys.size > 0`. For Bill, `delete updated.AmountDue` first (because `computeTotals` only sets `AmountDue` when undefined — preserves explicit overrides). For Invoice, no pre-delete needed because `computeTotals` always overwrites `Subtotal` / `BalanceRemaining` / `IsPaid`. `AppliedAmount` is read from `result.AppliedAmount ?? 0` and preserved.
  - `applyLineMods` itself is unchanged — the `/^(.+?)Line(s?)Mod$/` regex matched `InvoiceLineMod` for free.
- Verified end-to-end with a 61-check inline script (deleted post-verification per "no test infra yet"): invoice setup with line totals + customer balance bump (A1–A7), header-only mod with full preservation (B1–B9), stale-EditSequence rejection (C1–C3), wholesale line drop with field merge + balance delta (D1–D10), new line addition with fresh TxnLineID + balance delta (E1–E6), quantity-only mod re-deriving Amount via existing rate (F1–F6), over-application from line drop on partially-paid invoice with negative BalanceRemaining + customer balance delta (G1–G7), customer-change reverse-then-apply (H1–H4), unknown-TxnID rejection (I1/I2), and full regressions for `qb_bill_update` (K1–K3), `qb_customer_update` (L1), `qb_invoice_create` (M1/M2), `qb_invoice_delete` (N1). One verification-script bug surfaced and fixed: the script was holding object references from `queryEntity` and reading `.Balance` later, which returned the latest mutated value rather than a snapshot — `getCustomerBalance(name)` helper now captures the value as a Number at query time. Implementation was correct throughout. `npm run build` green.

---

### Item 7 — `qb_bill_update` (BillModRq) _(Phase 3)_ — done 2026-04-25

**Status:** done

**Behavioral criteria**:
- [x] `qb_bill_update` is registered and listed by the MCP server. Verified via setup step (bill created and TxnID/EditSequence captured).
- [x] Calling with `txnId` + `editSequence` + a new `memo` returns the bill with the new memo and a fresh `EditSequence`. Verified Header-only memo mod check.
- [x] Header-only mod (no line args) leaves the existing `ExpenseLineRet` and `AmountDue` untouched.
- [x] Header field updates propagate: `memo`, `vendorName` (verified explicitly via vendor-change check), `txnDate` / `dueDate` / `refNumber` follow the same `{...modData}` spread path so propagate identically.
- [x] `expenseLines` wholesale-replace + merge-by-`TxnLineID` semantics work: a single-entry mod with `{txnLineID: rentLineId, memo: ...}` survives only the rent line, preserves account + amount from the existing line, and recomputes `AmountDue` to 100. Verified Line-mod merge check.
- [x] New line (no `txnLineID`) gets a freshly-generated `TxnLineID`; existing line passed by `TxnLineID` only is preserved untouched. Verified "new line gets fresh TxnLineID" check.
- [x] `AmountDue` recomputes via `computeTotals` after line mods. Verified across all line-mod paths (100, 175, 275, 375).
- [x] Vendor `Balance` adjusts by `newAmountDue - oldAmountDue` (signed delta). Verified `-50` (line drop), `+75` (line add), `+100` (item line add), and full reverse-then-apply on vendor change.
- [x] Mixing expense and item ledgers: `ItemLineMod` alone leaves `ExpenseLineRet` untouched; both contribute to `AmountDue`. Verified items-alongside-expenses check.
- [x] Item line `Quantity` mod re-derives `Amount = Quantity * Cost` from the merged line. Verified with `Q=10, C=20 (existing) → A=200`.

**Error criteria**:
- [x] Unknown `txnId` rejects via `isError: true` with statusCode 500. Verified via tool's try/catch wrapper around `session.modifyEntity`.
- [x] Stale `editSequence` rejects with statusCode 3170 ("EditSequence does not match"). The failed mod does NOT mutate the bill (verified by re-querying the bill's memo post-rejection).
- [x] New expense line (no `txnLineID`) without `accountName`/`accountListId` rejected by `expenseLineModSchema.refine` at the zod boundary.
- [x] New item line (no `txnLineID`) without `itemName`/`itemListId`/`quantity`/`cost` rejected by `itemLineModSchema.refine`.

**Regression criteria**:
- [x] `qb_bill_create` still works (`AmountDue = sum(lines)`, vendor balance bumps).
- [x] `qb_bill_delete` still reverses vendor balance.
- [x] `qb_bill_list` still returns persisted bills with intact `ExpenseLineRet` / `ItemLineRet` (verified throughout — every mod check re-queried the bill via `getBill` and inspected the line arrays).
- [x] `qb_customer_update` still works with a fresh `EditSequence` (verified via Acme `CompanyName` update).
- [x] `qb_invoice_update` still works (verified via INV-1001 memo header-only mod). The strict `EditSequence` check accepts a freshly-queried sequence as expected.
- [x] Seed `INV-1002` untouched (no test path modified it).
- [x] AP aging would reflect the post-mod vendor balance — `qb_ap_aging` reads `Vendor.Balance` directly per Item 18, and the balance moves are verified end-to-end.

**Documentation criteria**:
- [x] README bill table: `qb_bill_update` row inserted between create and delete; bill section intro paragraph documents `txnLineID` semantics and the `editSequence` → 3170 rejection.
- [x] `instructions` block in [src/index.ts](src/index.ts) updated: bill bullet now lists update and explains that line arrays REPLACE the line set wholesale with merge-by-`txnLineID`.
- [x] `DECISIONS.md` entry: "Strict EditSequence validation in simulation handleMod" — documents global `handleMod` tightening and the rationale.
- [x] `DECISIONS.md` entry: "Bill line-mod uses wholesale replacement with merge-by-TxnLineID" — documents the chosen middle ground between pure-replace and full per-line diff.
- [x] Tool count in README header bumped 36 → 37.

**Implementation notes**:
- Tool layer in [src/tools/bills.ts](src/tools/bills.ts):
  - Two new schemas: `expenseLineModSchema` and `itemLineModSchema`. Each makes nearly every field optional (so partial mods on existing lines work) and uses `.refine()` to require the create-shape fields ONLY when `txnLineID` is absent or `'-1'`.
  - `qb_bill_update` handler builds `ExpenseLineMod` / `ItemLineMod` arrays only when the corresponding tool arg is provided — so a header-only mod sends no line keys at all and `applyLineMods` short-circuits via `lineModKeys.size === 0`.
  - try/catch wraps `session.modifyEntity` so simulation 500s and 3170s surface as structured tool errors with `isError: true` + `statusCode` (same pattern as `qb_payment_receive` from Item 5).
- Simulation `handleMod` in [src/session/simulation-store.ts](src/session/simulation-store.ts):
  - Strict `EditSequence` check is global (any entity type), keyed on the request including `EditSequence`. Three lines, returns 3170 on mismatch, applied BEFORE any mutation so a mismatched mod can't leak partial state.
  - `applyLineMods(existing, modData)` is generic on `*LineMod` keys — the regex `/^(.+?)Line(s?)Mod$/` finds every line-mod key, processes the mod array against the entity's existing `*LineRet`, and produces a new `*LineRet` array. Item 6 (`qb_invoice_update` line mod) reuses this helper with no changes.
  - `omitKeys` strips the `*LineMod` keys before the spread `{...lineModResult.entityWithLines, ...stripped}` so the raw mod arrays don't end up persisted on the entity.
  - `adjustVendorBalanceForBillMod` handles both the same-vendor delta path and the vendor-change reverse-then-apply path. Vendor identity check uses `ListID` first, falls back to `FullName`. Same machinery is reusable for Phase 3 item 6 (Customer/Invoice) — consider extracting to a generic `adjustPartyBalanceForTxnMod` when item 6 lands.
- Amount re-derivation in `applyLineMods`: `Quantity * Rate` (Invoice/Estimate convention) takes precedence over `Quantity * Cost` (Bill ItemLine convention). For ExpenseLineMod (no qty/rate/cost), neither branch fires and `Amount` carries from the merge — operator's explicit `Amount` wins.
- Item 6's path is now straightforward: it'll add an `invoiceLineModSchema` to [src/tools/invoices.ts](src/tools/invoices.ts), wire `InvoiceLineMod` in the tool, extend the `entityType === "Bill"` branch in `handleMod` to also include `"Invoice"` (recompute `Subtotal` + `BalanceRemaining` + `IsPaid`), and add a customer-balance equivalent of `adjustVendorBalanceForBillMod`. The line-mod plumbing itself is already done.
- Verified end-to-end with a 17-check inline script (deleted post-verification per "no test infra yet"): bill setup with vendor balance bump, header-only mod (memo + EditSequence advance + lines/AmountDue/balance unchanged), stale-EditSequence rejection (3170 + bill not mutated), unknown-TxnID rejection (500), single-line merge by TxnLineID with line-drop balance delta (-50), new line with fresh TxnLineID + existing-line preservation by TxnLineID-only (+75 delta), parallel ItemLineMod alongside existing ExpenseLineRet (+100), item-qty mod with merged-Cost re-derivation (10 * 20 = 200), vendor-change reverse-then-apply (office −375, cloud +375), `qb_customer_update` regression with fresh editSequence, `qb_invoice_update` regression on INV-1001, `qb_bill_create` Item 4 regression, `qb_bill_delete` Item 18 regression. `npm run build` green throughout.

---

### Item 5 — Payment applied to invoices _(Phase 3)_ — done 2026-04-25

**Status:** done

**Behavioral criteria**:
- [x] `qb_payment_receive` accepts `appliedTo: [{txnId, amount, discountAmount?, discountAccountName?}]` array. Verified C1, F1, G1.
- [x] Each applied invoice's `BalanceRemaining` decreases by the applied amount. Verified C5 (7500→4500), D3 (4500→0), E3 (1000→0), F5/F6, G2.
- [x] When `BalanceRemaining` reaches 0, the invoice's `IsPaid` flips to true. Verified D4, E4, F5/F6, G3. Partial closeout leaves `IsPaid=false` (C7).
- [x] Customer `Balance` decreases by the total applied amount (not the gross payment). Verified C8 (-3000), E5 (only -1000 of $1500 gross), F7 (-500), G5 (-950 of $950 + $50 discount).
- [x] Unapplied amount (`TotalAmount > sum(appliedTo.amount)`) remains as customer credit and is returned as `UnusedPayment` on the payment payload. Verified B3 (500), E2 (500), F4/G6 (0).
- [x] Calling `qb_payment_receive` without `appliedTo` records the payment as fully unapplied. Verified B1–B5: AppliedAmount=0, UnusedPayment=totalAmount, no AppliedToTxnRet, no customer balance change.

**Regression criteria**:
- [x] `qb_payment_list` shows the new payment with `AppliedAmount` and `AppliedToTxnRet` intact across query round-trip. Verified K1–K3.
- [x] `qb_invoice_list` reflects updated `BalanceRemaining` and `IsPaid` on the affected invoices (verified throughout C/D/E/F/G via direct query lookups by RefNumber).
- [x] AR aging still runs after payment activity (L1). Report reads `Customer.Balance` directly per Item 18, so the moved balance flows through automatically.

**Edge / error criteria** (added during implementation):
- [x] Strict TxnID validation: an unknown `txnId` returns `isError: true` with statusCode 500 and the bad TxnID in the error message; no invoice is mutated. Verified H1–H3. See DECISIONS.md 2026-04-25 entry.
- [x] Overapplication (sum(appliedTo.amount) > totalAmount) rejected at the tool-layer schema-after-coercion check. Verified I1–I2. Floating-point tolerance: `+1e-9`.
- [x] Pre-existing customer-required validation still works (J1).
- [x] Discount handling: `discountAmount` closes invoice alongside `amount` but is NOT counted toward `AppliedAmount` on the invoice and does NOT reduce the customer balance — matches real QB semantics. Verified G2/G4/G5/G6 with `DiscountAccountRef` on the response payload.

**Documentation criteria**:
- [x] README payment section updated: intro paragraph describes `appliedTo` semantics + strict TxnID rule + UnusedPayment formula; tool table row mentions `appliedTo`.
- [x] `instructions` block in [src/index.ts](src/index.ts) updated: `qb_payment_*` line flags `appliedTo` and the prepayment-without-appliedTo path.
- [x] `DECISIONS.md` 2026-04-25 entry added: "Strict TxnID validation in `qb_payment_receive` AppliedToTxnAdd."

**Implementation notes**:
- Tool-layer schema in [src/tools/payments.ts:7-14](src/tools/payments.ts#L7-L14): `appliedToSchema` requires `txnId` + `amount`; `discountAmount` and `discountAccountName` are optional. Per-line refinement intentionally NOT used — `txnId` and `amount` are required directly via `z.string()` / `z.number()`, so the schema rejects missing fields without a `.refine()` predicate.
- Tool-layer overapplication check at [src/tools/payments.ts:50-63](src/tools/payments.ts#L50-L63): runs before the request is built, returns `isError: true` with the computed sum and the totalAmount. Floating-point slack: `+1e-9`. Rejects at the tool layer rather than the simulation so live mode also gets the friendly error message instead of a cryptic QB rejection.
- Tool-layer try/catch at [src/tools/payments.ts:96-106](src/tools/payments.ts#L96-L106) wraps `session.addEntity` so a 500 from the simulation (orphan TxnID) surfaces as a structured tool error instead of a raw exception. Pattern is candidate for replication on other tools when Phase 6 item 25 lands.
- Side-effect logic centralized in `applyReceivePayment` at [src/session/simulation-store.ts:332-432](src/session/simulation-store.ts#L332-L432). Two-pass design: pass 1 validates every TxnID (atomicity — orphan in line 5 of 5 must NOT leave lines 1-4 mutated); pass 2 applies invoice mutations and customer-balance delta. Phase 3 item 8 (`qb_payment_apply` via `ReceivePaymentMod`) will reuse this exact helper from `handleMod` — currently inline because there's only one call site.
- `AppliedToTxnRet` carries `TxnLineID` (from `nextId()`), `TxnID`, `PaymentAmount`, and conditionally `DiscountAmount` + `DiscountAccountRef`. Added to parser's `arrayElements` set at [src/qbxml/parser.ts:46](src/qbxml/parser.ts#L46) so live mode parses single-applied-invoice responses as a 1-element array, matching multi-application shape.
- Customer balance moves via the existing `adjustEntityBalance` helper from Item 18 with a negative delta, exactly as the previous handoff predicted. Skipped when `appliedSum === 0` so prepayments don't accidentally bump customer balance.
- Order in `handleAdd`: `applyReceivePayment` runs AFTER `convertLinesAddToRet` + `computeTotals` (both are no-ops for ReceivePayment) and BEFORE `store.set`, so an orphan-TxnID rejection short-circuits without leaving a phantom payment in the store.
- Verified end-to-end with a 51-check inline script (deleted post-verification per "no test infra yet"): seed sanity, prepayment without appliedTo, single-invoice partial application, full closeout with `IsPaid` flip, unapplied-portion-as-credit (1500 paid / 1000 applied / 500 unused), multi-invoice application, discount handling with proper customer-balance and AppliedAmount semantics, strict TxnID validation, overapplication rejection, missing-customer regression, persistence via `qb_payment_list`, and AR aging smoke. `npm run build` green.

### Item 4 — Bill expense + item lines _(Phase 3)_ — done 2026-04-25

**Status:** done

**Behavioral criteria**:
- [x] `qb_bill_create` accepts `expenseLines: [{accountName | accountListId, amount, memo?, className?}]` array.
- [x] `qb_bill_create` accepts `itemLines: [{itemName | itemListId, quantity, cost, memo?}]` array.
- [x] At least one of `expenseLines` or `itemLines` is required — header-only bills (and empty arrays for both) are rejected with `isError: true` and a message that names both arg keys.
- [x] Created bill's `AmountDue` equals sum of all expense + item line amounts. Verified C5 (350), D5 (262.5), E3 (80) — all line-derived.
- [x] Vendor `Balance` increases accordingly. Verified H1 — `Office Supplies Co` balance moved from 2500 → 2500 + 717.5 (sum of four bills) via Item 18's `adjustPartyBalanceForTxn` integration.
- [x] AP aging reflects the new bill. Verified I2 — `qb_ap_aging` output mentions `Office Supplies` after activity.

**Regression criteria**:
- [x] Existing transaction tools still work: `qb_invoice_list { refNumber: "INV-1001" }` returns the seed invoice with `BalanceRemaining = 7500` (verified K1, K2).
- [x] Existing vendor-required validation still works: `qb_bill_create` without `vendorName`/`vendorListId` returns `isError: true` (verified B1).
- [x] Bills persist with their lines: subsequent `qb_bill_list` retrieval of `BILL-EXP-1` returns `AmountDue = 350` and the 2-element `ExpenseLineRet` array intact (verified J3, J4).

**Documentation criteria**:
- [x] README bill table updated: `qb_bill_create` row now describes `expenseLines` / `itemLines` schemas and the `quantity * cost` math; intro paragraph notes that lines are required.
- [x] `instructions` block in [src/index.ts](src/index.ts) updated: `qb_bill_*` line now flags that `qb_bill_create` requires line items and that `AmountDue` is derived from lines.
- [x] `DECISIONS.md` 2026-04-25 entry added at top: "Drop `amountDue` arg from `qb_bill_create`" — records the schema break and reasoning.

**Implementation notes**:
- Two zod refinements live alongside the schema definitions in [src/tools/bills.ts](src/tools/bills.ts) so per-line `AccountRef` / `ItemRef` validation fires at the schema boundary, not in the handler. F1 + F2 verify both refinements reject lines that omit the relevant ref.
- Per-line `Amount = quantity * cost` is computed in the tool handler before `session.addEntity("Bill", data)`. The simulation's line-converter at [src/session/simulation-store.ts:349-368](src/session/simulation-store.ts#L349-L368) only computes `Quantity * Rate` (Bill item lines use `Cost`, not `Rate`), so doing the math in the tool layer is the right boundary — it keeps the converter honest about what real QB derives server-side and what it doesn't.
- The previously-optional `amountDue` arg was removed entirely. `computeTotals` in the simulation is now the single source of truth for the bill total. Logged in `DECISIONS.md` because zod's default `unknownKeys: "strip"` means a caller passing `amountDue` will silently lose it rather than getting a clear rejection — future agents should not "fix" that by re-adding the arg without rereading the decision entry.
- `ClassRef` on expense lines (`className` arg → `ClassRef.FullName`) supported for class tracking, matching the acceptance note. Item lines deliberately do NOT take `className` — the acceptance criterion only specified it on expense lines, and Phase 4 item 30 will land a proper `qb_class_list` tool that makes this discoverable across both line types.
- Verified end-to-end with a 35-check inline script (deleted post-verification per "no test infra yet"): header-only rejection (incl. empty-arrays variant), expense-only with `Memo` preservation, item-only with the `qty * cost` math (12.5 → 62.5 line, 100 → 200 line), mixed bills, per-line ref validation, `accountListId` variant, vendor balance integration with Item 18, AP aging integration, persistence via `qb_bill_list`, invoice regression, and `ClassRef` on expense lines. `npm run build` green.

---

### Item 2 — Per-subtype Item request types _(Phase 2)_ — done 2026-04-25

**Status:** done

**Behavioral criteria**:
- [x] `qb_item_list` accepts an optional `itemType` arg. When provided, only that subtype is queried.
- [x] When `itemType` is omitted, the tool fans out across all five subtypes and merges results via `Promise.all` + `flat()`.
- [x] `qb_item_add` routes to the correct `Item<Subtype>AddRq` based on the required `itemType` arg — verified each subtype lands in its own store and does not leak into others.
- [x] `qb_item_update` routes to the correct `Item<Subtype>ModRq` (added required `itemType` arg per the implementation note in `HANDOFF.md`).
- [x] Subtype-specific fields are accepted: Inventory accepts `assetAccountName` / `cogsAccountName` / `cost`; Service items take the same schema but routing makes the inapplicable fields a no-op at the simulation level. Light-touch single-schema chosen — see `DECISIONS.md` 2026-04-25 entry.

**Regression criteria**:
- [x] All seed items still appear when `qb_item_list` is called with no `itemType` (fan-out merges to 3).
- [x] Invoice creation referencing `"Consulting Services"` by `ItemRef.FullName` still resolves and computes Subtotal correctly.

**Documentation criteria**:
- [x] README item table updated with the `itemType` arg behavior per tool.
- [x] `ARCHITECTURE.md` Invariant #7 updated — dropped the "currently violates" clause and described the new tool-layer routing.
- [x] `src/index.ts` `instructions` block updated with the subtype enum + when `itemType` is required.
- [x] `DECISIONS.md` entry added for the light-touch schema choice (single zod schema across subtypes, route on `itemType`).

**Implementation notes**:
- `ITEM_SUBTYPES` constant defined locally in [src/tools/items.ts:11-17](src/tools/items.ts#L11-L17) — kept independent of the simulation store's internals per the layer-hygiene note in the prior handoff. The simulation-store's `ITEM_SUBTYPES` constant has been deleted as part of this task because the only thing that read it (the generic `ItemQueryRq` shim) has also been deleted.
- `qb_item_list` fan-out uses `Promise.all` so the five subtype queries run in parallel rather than serially.
- All four tools share a single `itemTypeSchema = z.enum([...])` so the operator-facing values stay identical across `add` / `update` / `delete` / `list`.
- Verified end-to-end with a 29-check inline script (deleted post-verification per "no test infra yet" project state): per-subtype query routing (3 occupied + 2 empty subtypes), fan-out merge total = 3, fan-out filter passthrough (`NameFilter='Widget'` → 1), per-subtype add (Service / Inventory / OtherCharge each land in correct store, no cross-store leakage), Inventory subtype-specific fields preserved (`Cost` / `COGSAccountRef` / `AssetAccountRef`), per-subtype mod with `TimeModified` bump, per-subtype delete returns correct `ListDelType`, wrong-subtype delete fails with 500 (proves real subtype isolation), shim removal proven (generic `Item` query returns 0), and full regression spot-checks for Customer/Account/Invoice + invoice line referencing item by FullName.

---

### Item 3 — Item delete uses correct subtype _(Phase 2)_ — done 2026-04-25

**Status:** done

**Behavioral criteria**:
- [x] `qb_item_delete` requires `itemType` and sends `ListDelType: "Item<Subtype>"` (e.g. `"ItemService"`) instead of `"Item"`. Verified by inspecting the response payload's `ListDelType` field on each subtype.
- [x] Deletion succeeds for each subtype. Verified Service / Inventory / OtherCharge directly; NonInventory and Group share the exact same code path and routing.

**Regression criteria**:
- [x] `qb_customer_delete` still returns `ListDelType: "Customer"` (verified — shared `ListDelRq` machinery is unaffected).
- [x] `qb_account_delete` still returns `ListDelType: "Account"` (verified).
- [x] Wrong-subtype delete (e.g. deleting Service ListID via the `ItemInventory` route) fails cleanly with statusCode 500 "object not found" — proves the per-subtype store isolation is real, not just cosmetic.

**Implementation notes**:
- Implemented in the same edit as Item 2 in [src/tools/items.ts:140-156](src/tools/items.ts#L140-L156). The handoff recommendation to bundle Items 2 + 3 was correct: they share the same tool file, the same routing pattern, and the same verification surface.
- The simulation's `handleListDel` already reads `ListDelType` from the request directly, so per-subtype types hit per-subtype stores with no further simulation changes needed.

---

### Item 22 — Split Item store by subtype _(Phase 1)_ — done 2026-04-25

**Status:** done

**Behavioral criteria**:
- [x] Simulation store has separate maps for `ItemService`, `ItemInventory`, `ItemNonInventory`, `ItemOtherCharge`, `ItemGroup`. Created lazily by the existing `getStore` helper — no schema change needed beyond routing.
- [x] A query for `ItemServiceQueryRq` returns only service items, wrapped in `ItemServiceRet`. Verified the wrapping element directly via raw response inspection.
- [x] Same for each subtype: `ItemInventoryQueryRq` → `ItemInventoryRet`, `ItemNonInventoryQueryRq` → `ItemNonInventoryRet`. Empty subtypes (`ItemOtherCharge`, `ItemGroup`) return `statusCode 1` ("not found") and produce no `*Ret` key.
- [x] Seed data migrated: each of the 3 seed items is placed into `Item${i.ItemType}` at seed time. The legacy `Item` store is no longer seeded.

**Regression criteria**:
- [x] `qb_item_list` (which still uses generic `ItemQueryRq`) returns all 3 seed items via the transitional shim in `handleQuery`. Verified via `mgr.queryEntity("Item", {})` returning 3.
- [x] All existing query filters apply through the shim: `NameFilter` (Widget → 1), `ActiveStatus=ActiveOnly` (3), `MaxReturned` (cap), `FullName` (exact match).
- [x] Non-Item entity queries unaffected: Customer (Acme.Balance=15000), Account (10 chart entries), Invoice (INV-1001 BalanceRemaining=7500).

**Documentation criteria**:
- [x] No README change required — `qb_item_list` surface is unchanged from the operator's perspective.
- [x] No `instructions` block change in [src/index.ts](src/index.ts) — same reason.
- [x] `ARCHITECTURE.md` Invariant #7 deliberately NOT marked resolved — the violation is in the tool layer (generic `ItemQueryRq`), and Phase 2 item 2 is what flips it. Item 22 is the simulation-side prerequisite only.
- [x] No `DECISIONS.md` entry — Option A (shim in simulation store, isolated to one branch in `handleQuery`) was the recommended path in the prior handoff and introduces no surprise tradeoffs. Option B (rewriting `qb_item_list` to issue 5 queries up front) was rejected because it bleeds Phase 2 item 2's tool-side work into a Phase 1 simulation task.

**Implementation notes**:
- New private constant `ITEM_SUBTYPES` at [src/session/simulation-store.ts:43-55](src/session/simulation-store.ts#L43-L55) — single source of truth for the 5 subtype names. Used by the query shim and (implicitly) by seed routing through string concatenation.
- `handleQuery` shim at [src/session/simulation-store.ts:114-127](src/session/simulation-store.ts#L114-L127): when `entityType === "Item"`, results are merged across all 5 subtype stores via `flatMap`. All downstream filters (`ListID`, `FullName`, `EntityFilter`, `TxnDateRangeFilter`, `ModifiedDateRangeFilter`, `PaidStatus`, `RefNumber`, `NameFilter`, `ActiveStatus`, `MaxReturned`) apply uniformly because they operate on the merged array — no per-store filter dispatch needed. Results return wrapped in `ItemRet` (the legacy element name the existing tool expects), NOT in any `Item${Subtype}Ret`.
- Seed migration at [src/session/simulation-store.ts:786-792](src/session/simulation-store.ts#L786-L792): each seed item is routed via `this.getStore(\`Item${i.ItemType}\`)` based on its `ItemType` discriminator. The discriminator values (`Service` / `Inventory` / `NonInventory` / `OtherCharge` / `Group`) map 1:1 to the subtype suffixes, so string concatenation suffices — no lookup table needed.
- `isTransactionType` deliberately not extended — items are list entities and must not enter the transaction array.
- `handleAdd` / `handleMod` / `handleListDel` deliberately NOT changed for Item subtypes. The existing dispatch (regex-derived `entityType` from request key) already routes per-subtype requests to their per-subtype stores. The catch is that the legacy `qb_item_add` / `qb_item_update` / `qb_item_delete` tools still build generic `ItemAddRq` / `ItemModRq` / `ListDelType: "Item"` requests — those land in the now-empty `Item` store and are functionally broken until Phase 2 items 2 + 3. This is anticipated; Item 22's acceptance criterion explicitly does NOT require the write-side tools to keep working.
- Verified end-to-end with a 16-check inline script (deleted post-verification per "no test infra yet"): per-subtype query shape (Service/Inventory/NonInventory each return the right `*Ret` array with the right ItemType), empty-subtype behavior (statusCode 1, no leaked `*Ret` key), subtype isolation (ItemService doesn't leak Inventory items), generic shim merge total = 3 (proves no double-count from a stale `Item` store), all four filters through the shim, and regression spot-checks for Customer/Account/Invoice.

---

### Item 18 — Update entity balances on transaction activity _(Phase 1)_ — done 2026-04-25

**Status:** done

**Behavioral criteria**:
- [x] Adding an invoice for `Acme Corporation` increases that customer's `Balance` by the invoice `BalanceRemaining`.
- [x] Adding a bill for a vendor increases that vendor's `Balance` by `AmountDue`.
- [ ] Recording a payment applied to an invoice (Phase 3 item 5) decreases the customer's `Balance` and the invoice's `BalanceRemaining` by the applied amount. _(Out of scope for Item 18 — the helper `adjustEntityBalance` is designed so Phase 3 item 5 can call it directly with a negative delta. Verified by Phase F round-trip in this task's verification, which proves the negative-delta path works.)_
- [x] Deleting an invoice/bill reverses the balance change.
- [x] `qb_ar_aging` and `qb_ap_aging` reflect these changes immediately. _(Reports read `Customer.Balance` / `Vendor.Balance` directly per HANDOFF — no report-side change needed; verified that the source field moves on activity.)_

**Regression criteria**:
- [x] Initial seed balances remain at their seeded values until activity touches them.

**Implementation notes**:
- New helper `adjustEntityBalance(entityType, refKey, delta)` at [src/session/simulation-store.ts:417-450](src/session/simulation-store.ts#L417-L450). Looks up by `ListID` first (exact `Map.get`), falls back to a `FullName` linear scan. Orphan ref → silent no-op so creation never blocks. `TotalBalance` mirrors `Balance` only on the Customer branch (vendors have no such field per seed shape; verified A2 + C2 in the verification script). Zero-delta short-circuit + `Number.isFinite` guard so a malformed amount never poisons a balance.
- Thin adapter `adjustPartyBalanceForTxn(txn, partyType, amountField, sign)` at [src/session/simulation-store.ts:455-475](src/session/simulation-store.ts#L455-L475) pulls the ref + amount off a stored transaction and applies a signed delta. `sign: 1 | -1` lets `handleAdd` and `handleTxnDel` share one call site without duplicating ref-extraction logic. Phase 3 item 5 (payment apply) will call `adjustEntityBalance` directly with a negative delta — it does NOT need the txn-shaped adapter, since the payment carries its own structure.
- `handleAdd` call site at [src/session/simulation-store.ts:304-308](src/session/simulation-store.ts#L304-L308): only `Invoice` (Customer / `BalanceRemaining`) and `Bill` (Vendor / `AmountDue`) trigger the bump. Other transaction types (Estimate, PurchaseOrder, SalesReceipt, etc.) deliberately do NOT mutate party balances — estimates/POs aren't AR/AP, and SalesReceipt/CreditMemo etc. need explicit per-type rules that belong with their tools (Phase 4 item 12).
- `handleTxnDel` refactored at [src/session/simulation-store.ts:508-538](src/session/simulation-store.ts#L508-L538) — `store.has` → `store.get` so we can read the entity, reverse the delta via the same adapter (sign = -1), then delete. Preserves the original 500 not-found response shape.
- `handleMod` deliberately untouched. Modifying an invoice's `BalanceRemaining` only happens via payment application (Phase 3 item 5) or line modification (Phase 3 items 6/7); each of those will own its own helper call.
- Verified end-to-end with a 17-check inline script (deleted post-verification per "no test infra yet"): seed preservation (Acme + Office Supplies + vendor-has-no-TotalBalance), invoice-add bumps customer (with TotalBalance mirroring), bill-add bumps vendor (with no TotalBalance leak), FullName-only ref resolves, orphan ref doesn't block creation and doesn't create a phantom customer, invoice + bill delete each reverse the delta, full add→delete round-trip nets to zero, Estimate doesn't move customer balance, PurchaseOrder doesn't move vendor balance, Customer add (non-transaction) still works, seed INV-1001 still untouched, AR-source field moves on new activity.

---

### Item 16 — Compute totals in simulation `handleAdd` _(Phase 1)_ — done 2026-04-25

**Status:** done

**Behavioral criteria**:
- [x] Created invoices return `Subtotal = sum(InvoiceLineRet.Amount)`.
- [x] Created invoices return `BalanceRemaining = Subtotal + SalesTaxTotal - AppliedAmount`.
- [x] Created invoices return `IsPaid = (BalanceRemaining === 0)`.
- [x] Created bills return `AmountDue = sum(line amounts)` if not explicitly provided.
- [x] Created estimates return `Subtotal = sum(line amounts)`.
- [x] No-line invoices/bills/estimates return `Subtotal = 0` (not undefined). Bill no-line case returns `AmountDue = 0`.

**Regression criteria**:
- [x] Item 17 still produces correct line arrays.
- [x] Customer/vendor add still works (no-op for these — non-transactional).

**Implementation notes**:
- New helper `computeTotals(entity, entityType)` at [src/session/simulation-store.ts:367-403](src/session/simulation-store.ts#L367-L403). Runs after `convertLinesAddToRet` so every line is in `*LineRet` form before summing — see the call site at [src/session/simulation-store.ts:300-302](src/session/simulation-store.ts#L300-L302).
- `lineSum` walks every key matching `/^(.+?)Line(s?)Ret$/` and sums `Amount` across all of them. Bill is the only multi-line-key entity today (`ExpenseLineRet` + `ItemLineRet`), but the regex makes it free for any future entity that lands.
- Per-entity dispatch is explicit, not generic: only `Invoice`/`Estimate` get `Subtotal`, only `Bill` gets `AmountDue`, only `Invoice` gets `BalanceRemaining`/`IsPaid`. Other transaction types (SalesReceipt, CreditMemo, PurchaseOrder, etc.) are intentionally NOT touched — they have no tools yet and the right field names per type need verification when those tools land in Phase 4 item 12.
- Bill `AmountDue` honors an explicit value from the caller (`if (... && result.AmountDue === undefined)`). Invoice/Estimate `Subtotal` always overwrites — real QB doesn't let you override the line-derived subtotal, and an explicit subtotal contradicting the lines would be a bug worth surfacing, not silently honoring.
- `SalesTaxTotal` and `AppliedAmount` default to `0` when absent and are normalized via `Number(... ?? 0)` so the response always has numeric fields (criterion: "not undefined"). `Number.isNaN` guard on per-line sum so a malformed `Amount` doesn't poison the total — silently skipped instead.
- `IsPaid = (BalanceRemaining === 0)` — strict equality on numbers. Floating-point drift (e.g. `0.1 + 0.2 - 0.3 !== 0`) is a known risk if a future test uses non-trivial fractions; not a problem for the current Phase 1 acceptance values.
- `handleMod` deliberately untouched (per HANDOFF directive — line-mod recomputation belongs to Phase 3 items 6 and 7). Seed invoices have hardcoded totals from `seedData()` and remain frozen because `computeTotals` only fires inside `handleAdd`.
- Verified end-to-end with a 39-check inline script (deleted post-verification per "no test infra yet"): all 6 acceptance bullets, explicit-tax-and-applied invoice, fully-paid invoice (`IsPaid=true`), no-line cases for all three entities, Bill with parallel expense+item lines, Bill with explicit `AmountDue` preserved, Estimate doesn't get invoice-only fields, persistence via list, Customer/Vendor non-transaction (no totals attempted), seed `INV-1001` untouched, and Item 15 `PaidStatus` filter regression on the now-computed `IsPaid`.

---

### Item 17 — Convert `*LineAdd` to `*LineRet` in simulation responses _(Phase 1)_ — done 2026-04-25

**Status:** done

**Behavioral criteria**:
- [x] Creating an invoice with 2 lines via `qb_invoice_create` returns a response containing `InvoiceLineRet` (not `InvoiceLineAdd`) with 2 entries.
- [x] Each `InvoiceLineRet` entry has a generated `TxnLineID`.
- [x] Each line has `Amount` computed as `Quantity * Rate` if both supplied; otherwise echoes the explicit `Amount` if provided; otherwise `0`.
- [x] Subsequent `qb_invoice_list` retrieval of the same invoice returns the same `InvoiceLineRet` array (persistence verification).
- [x] Same conversion happens for `EstimateLineRet`, Bill `ExpenseLineRet` + `ItemLineRet`, and any other `*LineAdd` → `*LineRet` pair.

**Regression criteria**:
- [x] Existing seed invoices (which have no lines) still list correctly.
- [x] Item 15's filters still work after this change.

**Documentation criteria**:
- [x] None required — internal correctness change.

**Implementation notes**:
- Generic helper `convertLinesAddToRet` at [src/session/simulation-store.ts:312-359](src/session/simulation-store.ts#L312-L359) scans the entity for keys matching `/^(.+?)Line(s?)Add$/` and rewrites each into a `*LineRet` array. Only invoked for transaction entities (the `isTransactionType` gate in `handleAdd`) — list entities never carry line arrays.
- Single-line input (parsed by fast-xml-parser as an object, not array) is normalized to a 1-element array before mapping, so the response always has a homogeneous `*LineRet` shape regardless of input cardinality.
- `Amount` rule per acceptance: `Quantity * Rate` if both present → fallback to explicit `Amount` → fallback to `0`. Bill `ItemLineAdd` uses `Cost`, not `Rate`, so `Quantity * Cost` is NOT auto-computed — explicit `Amount` is required for those lines (matches real QB behavior).
- Adopted real QBXML element names (`ExpenseLineRet`, `ItemLineRet`, no Bill prefix) over the handoff's draft `BillExpenseLineRet` / `BillItemLineRet` because live mode will return the standard names — staying consistent across modes.
- Parser `arrayElements` extended at [src/qbxml/parser.ts:39-55](src/qbxml/parser.ts#L39-L55) with `ExpenseLineRet`, `ItemLineRet`, `SalesReceiptLineRet`, `CreditMemoLineRet`, `PurchaseOrderLineRet`, `SalesOrderLineRet`, `DepositLineRet` — single-line responses now parse as 1-element arrays for live mode.
- `TxnLineID` reuses `nextId()` (counter + base36 timestamp). Real QB uses a different ID format but downstream code only cares about presence + uniqueness.
- Verified end-to-end with a 30-check inline script (deleted post-verification per "no test infra yet"): 2-line invoice, persistence via list, single-line normalization, all three Amount fallback paths, no-line invoice (no `*LineRet` key produced — preserves seed invoice shape), Bill with parallel `ExpenseLineAdd` + `ItemLineAdd`, Estimate, Customer non-transaction (no conversion attempted), and Item 15 filter regression.

---

### Item 15 — Transaction filters in simulation store _(Phase 1)_ — done 2026-04-25

**Status:** done

**Behavioral criteria**:
- [x] `qb_invoice_list` with `customerName: "Acme Corporation"` returns only invoices where `CustomerRef.FullName === "Acme Corporation"`.
- [x] `qb_invoice_list` with `customerListId: "80000001-1234567890"` returns only invoices for that customer.
- [x] `qb_invoice_list` with `fromDate: "2024-11-01"`, `toDate: "2024-11-10"` returns only invoices with `TxnDate` lexicographically between (inclusive).
- [x] `qb_invoice_list` with `fromDate` only (no `toDate`) returns invoices on or after `fromDate`. Same for `toDate` only.
- [x] `qb_invoice_list` with `paidStatus: "PaidOnly"` returns only invoices where `IsPaid === true`. With `"NotPaidOnly"`, only `IsPaid !== true`. With `"All"` (or unset), no filter.
- [x] `qb_invoice_list` with `refNumber: "INV-1001"` returns only the invoice with that exact `RefNumber`.
- [x] `qb_bill_list` vendor variant of EntityFilter verified (matches via `VendorRef`).
- [x] Combining filters narrows results (AND semantics).
- [x] Empty result set returns 0 results (handled by existing zero-result branch returning statusCode 1).

**Regression criteria**:
- [x] `qb_customer_list` with existing filters (`nameFilter`, `activeOnly`, `maxReturned`, `listId`) still works unchanged.
- [x] `qb_invoice_list` with `txnId` (existing filter) still returns the single matching invoice.
- [x] Seed data still loads — 2 invoices appear on a no-filter `qb_invoice_list` call.
- [x] No regression in non-transaction list tools — verified via `Customer.NameFilter` / `Customer.ActiveStatus` / `Account.MaxReturned` checks.

**Documentation criteria**:
- [x] No README change required.
- [x] No architecture change.
- [x] No `DECISIONS.md` entry — implementation followed advertised filter shapes; no surprises.

**Implementation notes**:
- All filter handlers added to [src/session/simulation-store.ts](src/session/simulation-store.ts#L139-L227) immediately after the existing `FullName` filter and before `NameFilter` (so transaction-only filters are grouped together, list-only filters stay where they were).
- `EntityFilter` matches `CustomerRef.ListID/FullName` or `VendorRef.ListID/FullName` — entities only carry one ref, so a single check covers both invoice and bill cases without needing entity-type dispatch.
- All date comparisons are lexicographic on ISO strings, including `ModifiedDateRangeFilter` against full ISO `TimeModified`. If a future caller passes a `YYYY-MM-DD` string for `ToModifiedDate`, same-day modifications could be excluded — flag for future work if it bites.
- `PaidStatus`: relies on the stored `IsPaid` boolean. Item 16 will compute `IsPaid` from `BalanceRemaining === 0` — at that point the filter still works, so no follow-up needed here.
- `RefNumber`: exact match only. `RefNumberFilter` (partial / case-sensitive) deferred — record decision if/when added.
- Verified end-to-end with a 28-check standalone script that round-tripped through `buildQueryRequest` → `SimulationStore.processRequest` → `extractResponseData` (script deleted post-verification per "no test infra yet" project state).

---
