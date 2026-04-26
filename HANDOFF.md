# Handoff State

_Last updated: 2026-04-26_

## Last Session Summary

- **Closed Phase 5, Item 14 — real `CompanyQueryRq` in `qb_company_info`** ([todo.md:41](todo.md#L41) checked). The tool no longer fakes its payload from session state; it now round-trips `session.queryEntity("Company", {})` through the standard query path and merges the returned `companyInfo` with session state for operator transparency. Three changes:
  - **Simulation seed** — added a Company singleton at the end of `seedData()` in [src/session/simulation-store.ts:2037-2073](src/session/simulation-store.ts#L2037-L2073), stored under the sentinel key `"COMPANY"` in a single-entry `Company` Map. Seed payload: `CompanyName: "Demo Co"`, `LegalCompanyName: "Demo Co LLC"`, full `Address`/`LegalAddress` blocks (Springfield, IL), `Phone`, `Fax`, `Email`, `CompanyType: "Corporation"`, `EIN: "12-3456789"`, `FirstMonthInFiscalYear: "January"`, `FirstMonthInIncomeTaxYear: "January"`, `TaxForm: "Form1120"`, `IsSampleCompany: true`, `SubscriberID: "SIM-SUBSCRIBER-0001"`, `CompanyFilePath`. No new `handleQuery` branch — the generic path already returns `[companySeed]` (no filters in the request), wraps as `{ CompanyRet: [companySeed] }`, and the consumer's `flattenEntityArray` handles single-object/array uniformly.
  - **Tool rewrite** — [src/tools/reports.ts:18-58](src/tools/reports.ts#L18-L58). Calls `session.queryEntity("Company", {})`, takes `records[0]` as `companyInfo`, returns `{ connected, simulationMode, companyFile, sessionTicket, openedAt, companyInfo }`. Wrapped in try/catch that translates `QBXMLResponseError` into `{ isError: true, statusCode, statusMessage }` (early adopter of the Item 25 pattern; the rest of the tools still throw raw). The stale `serverInfo` block is gone — verified absent in the verification harness with `!("serverInfo" in body)`.
  - **No parser change** — `CompanyRet` deliberately NOT added to `arrayElements` in [src/qbxml/parser.ts:28-80](src/qbxml/parser.ts#L28-L80). Real QB returns a single `<CompanyRet>` element; spec is singular. `flattenEntityArray` at [src/qbxml/parser.ts:174-183](src/qbxml/parser.ts#L174-L183) wraps either shape into a one-element array, so the consumer is uniform.
  - **No builder/manager change** — `buildQueryRequest("Company", {})` produces `<CompanyQueryRq/>` via the existing path; `queryEntity` routes through the standard flow (Company is neither a transaction nor in any other special-case list).
- **README updated** — `qb_company_info` row in the Reports & Queries table at [README.md:196](README.md#L196) now describes the real query (CompanyQueryRq + the field set) plus auto-connect behavior. `instructions` block in [src/index.ts:105](src/index.ts#L105) left as `"Connection & company info"` (still accurate; the granular field list lives in the tool's description string).
- **ACCEPTANCE_CRITERIA.md** — Item 14 entry written and moved to Completed. Phase 5 section header added with a pointer to Items 19/20/21 still open.
- **No DECISIONS.md / ARCHITECTURE.md change** — singleton-via-Map is just a seed-data convention, not a new subsystem; no tradeoff to record.
- **Verified.** `npm run build` green. Item 14 verification harness: 5/5 PASS — qb_company_info auto-connects + returns full companyInfo (no stale serverInfo); balance_summary still 10 accounts; account_list still 10; customer_list still 3; qb_company_info auto-reconnects after qb_session_disconnect. Prior handoff regression suite (account_list / invoice round-trip / JE balanced+unbalanced / bill_update itemLines AmountDue) re-run: 5/5 PASS — confirms the Company seed addition didn't disturb the existing CRUD or balance-validate paths.

## Verify Before Continuing

- [ ] **Build.** `npm run build` exits 0.
- [ ] **`qb_company_info` returns the seeded companyInfo.** No args; payload has `companyInfo.CompanyName === "Demo Co"`, `companyInfo.IsSampleCompany === true`, `companyInfo.FirstMonthInFiscalYear === "January"`, `companyInfo.TaxForm === "Form1120"`, `companyInfo.Address.City === "Springfield"`. Top-level: `connected: true`, `simulationMode: true`, `sessionTicket` starting with `SIM-`, no `serverInfo` key. Proves the new query path round-trips and the stale block is gone.
- [ ] **`qb_balance_summary` regression — 10 seeded accounts.** `totalAccounts: 10`. Proves the new `Company` store didn't bleed into the Account store (separate `getStore` keys).
- [ ] **`qb_company_info` auto-connects on first call.** Fresh process: do NOT call `qb_session_connect` first; call `qb_company_info`. Returned `connected: true` and a fresh `sessionTicket`. Proves `session.queryEntity` → `sendRequest` → `openSession` chain still triggers on demand (this is operator UX — Company is the natural first call).

## Next Task

**Phase 5, Item 21 — `qb_balance_summary` date-range support + group by `AccountType` in canonical QB order** ([todo.md:44](todo.md#L44)). Smallest of the three remaining Phase 5 items; extension of an existing tool rather than a new subsystem.

Current implementation lives at [src/tools/reports.ts:60-89](src/tools/reports.ts#L60-L89). It has zero arguments, queries all accounts, and groups them by `AccountType` using JS `Object` (so order is insertion order). Two gaps to close:

1. **Date-range support.** Real QB `qb_balance_summary` (which is a thin slice over the account-balance side of the company file) supports `fromDate` / `toDate` to give "balance change between X and Y." For the simulation cut: accept optional `fromDate` / `toDate` (`YYYY-MM-DD`) zod params and document that they're advisory in simulation mode (the seeded `Balance` field is a current snapshot — without a transaction-history rebuild we can't compute as-of balances). Real implementation later would need to walk transactions per account between the dates. Keep the simulation behavior honest by surfacing an `asOfNote` field in the response when dates are passed (e.g. `"Simulation mode: Balance reflects current snapshot, not the requested date range"`). Don't fake it.
2. **Canonical AccountType ordering.** Real QB's balance summary groups accounts in this fixed order:
   - `Bank`, `AccountsReceivable`, `OtherCurrentAsset`, `Inventory`, `FixedAsset`, `OtherAsset` (Assets)
   - `AccountsPayable`, `CreditCard`, `OtherCurrentLiability`, `LongTermLiability` (Liabilities)
   - `Equity` (Equity)
   - `Income`, `OtherIncome` (Income)
   - `CostOfGoodsSold`, `Expense`, `OtherExpense` (Expenses)
   - `NonPosting` (last; rarely shown)

   Replace the `Record<string, ...>` accumulator with an explicit ordered list. Iterate the canonical order, pull matching accounts from each bucket, emit groups in canonical order. Unknown types (a future-proofing concern) can land in an `Other` bucket at the end.

3. **Subtotal layering.** Real QB shows subtotals per category band (Assets / Liabilities / Equity / Income / Expenses). For simulation: emit a `subtotals` block alongside `balanceSummary` with `assets`, `liabilities`, `equity`, `income`, `expenses`, `netIncome` (income − expenses). Net income is the headline operator-facing number on a balance-summary report, so it's worth surfacing.

Suggested response shape:
```json
{
  "asOfDateRange": { "from": "...", "to": "..." } | null,
  "asOfNote": "..." | undefined,
  "balanceSummary": [
    { "accountType": "Bank", "accounts": [...], "total": ... },
    { "accountType": "AccountsReceivable", "accounts": [...], "total": ... },
    ...
  ],
  "subtotals": {
    "assets": ...,
    "liabilities": ...,
    "equity": ...,
    "income": ...,
    "expenses": ...,
    "netIncome": ...
  },
  "totalAccounts": ...
}
```

Recommended scope guard: don't try to implement actual date-range balance reconstruction in this item — that's a transaction-walk problem that belongs with the larger P&L / Balance Sheet build (Item 20). Item 21 is shape correctness + ordering + subtotals.

After Item 21:
- 19: `asOfDate` filtering on `qb_ar_aging` / `qb_ap_aging` (medium — needs date-bucket logic on top of the existing aging query path)
- 20: P&L + Balance Sheet via `GeneralSummaryReportQueryRq` (largest — `runReport` path needs to actually parse `ReportRet` rows; this is where the transaction-walk problem mentioned above gets solved generically)

## Context Notes

- **Item 14 implementation details that affect future edits.**
  - Company is stored as a one-entry Map keyed by the sentinel `"COMPANY"`. The seed lives in [src/session/simulation-store.ts:2037-2073](src/session/simulation-store.ts#L2037-L2073). If a future task ever needs to support multiple company files in simulation (unlikely — real QB binds one process to one file), this Map shape already accommodates it without a refactor.
  - `qb_company_info` was the first tool to wrap `session.queryEntity` in try/catch with structured error translation (the Item 25 pattern). When Item 25 lands as a sweep across all tools, treat this one as the reference shape — the catch block at [src/tools/reports.ts:43-55](src/tools/reports.ts#L43-L55) is the template (`{ success: false, statusCode, statusMessage }` payload + `isError: true` flag).
  - `CompanyRet` is deliberately NOT in [src/qbxml/parser.ts:28-80](src/qbxml/parser.ts#L28-L80) `arrayElements`. Don't add it — real QB returns it singular, and `flattenEntityArray` already wraps the single-object case correctly. Adding it would just produce a `[obj]` shape that `extractResponseData` then has to re-flatten. Leave it alone.
  - The seeded company `CompanyFilePath` is hardcoded to the sample-company path. If a future change wires the simulation store to read `QBSessionManager.config.companyFile`, that's the spot to inject — but not necessary for Item 14 (the operator gets the active session's `companyFile` separately at the top level of the response).
- **Project conventions reminder** ([CLAUDE.md](CLAUDE.md) § Stable Code Conventions): TS strict, ESM with `.js` extensions on relative imports, every zod field has `.describe()`, every tool registered in [src/index.ts](src/index.ts) and listed in the README tool table, structured tool errors via try/catch + `isError: true` + `statusCode`.
- **Verification gotcha (carried)** — `handleQuery` filters require **uppercase** `TxnID` / `RefNumber` / `FullName` in the filter object when calling `session.queryEntity` directly. Tools translate from lowercase correctly. Verification scripts that invoke captured handlers get this for free; ad-hoc `queryEntity` calls in throwaway debug code do not.
- **Phase 5 carried context** — `runReport` at [src/session/manager.ts:213-225](src/session/manager.ts#L213-L225) is still stub-shaped. Item 21 (`qb_balance_summary` upgrade) does NOT need to touch `runReport` — it's a thin reshape over `queryEntity("Account", ...)`. Item 20 (P&L + Balance Sheet) is the one that has to pay the `runReport` debt.

## Post-Task Chores

When Item 21 lands: `npm run build` green, [REGRESSION_CHECKLIST.md](REGRESSION_CHECKLIST.md) walked (especially §3 Tool Surface to confirm `qb_balance_summary` returns canonical-order groups + subtotals; §1 Build for the date param plumbing; existing `qb_account_list` / `qb_customer_list` regressions still pass), Item 21 ticked in `todo.md`, `ACCEPTANCE_CRITERIA.md` entry written for Item 21 (acceptance: balanceSummary array in canonical AccountType order, subtotals block with assets/liabilities/equity/income/expenses/netIncome, optional asOfDateRange + asOfNote for simulation honesty). Fresh `HANDOFF.md` pointing at Item 19 (aging `asOfDate` filtering) — the natural next reporting feature once the balance summary shape is canonical.
