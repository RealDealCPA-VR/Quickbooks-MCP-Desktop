# Handoff State

_Last updated: 2026-05-09 (later turn). Builder-emit-order regression test shipped — 3 new vitest tests pin the schema-order contract at the builder layer (the test class that would have caught both rounds of the 2026-05-09 schema-order bug). Total suite now 192/192 green across 7 files. All Phase 1-8 todo items are closed; no concrete next implementation work — see Next Task._

## Last Session Summary

- **Builder-emit-order regression test shipped.** New file [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts) (3 tests) directly asserts that `buildQueryRequest` emits children in insertion order, which is the contract that lets tools produce schema-compliant XML by populating filter dicts in canonical sequence:
  - **CustomerQueryRq** filter sequence: `ListID → MaxReturned → ActiveStatus → NameFilter` — matches the `<xs:sequence>` defined in `qbxmlops*.xml` and the order [src/tools/customers.ts:45-56](src/tools/customers.ts#L45-L56) populates the dict in.
  - **InvoiceQueryRq** full transaction filter sequence: `TxnID → MaxReturned → ModifiedDateRangeFilter → TxnDateRangeFilter → EntityFilter → AccountFilter → RefNumberFilter → CurrencyFilter → PaidStatus` — pins the canonical order for all transaction *QueryRqs that share this child group, so future edits to invoices / bills / estimates / sales-receipts / credit-memos / POs / JEs cannot re-introduce the 2026-05-09 schema-order bug undetected.
  - **Insertion-order preservation** (defensive): pass keys in non-canonical order, assert they emit in that same non-canonical order. Catches future refactors that route filters through structures that lose insertion order (Map by normalized key, JSON shape transform, sort, etc.).
- **Helper function** `emittedChildOrder(xml, requestType, candidates)` extracts the substring inside the named request element and returns the candidate names sorted by their position in the emitted XML. Lives inside the test file (single-use, not exported).
- **Why this test was needed.** `SimulationStore.handleQuery` does not re-serialize the request — it inspects the parsed filter object — so simulation never surfaces schema-order bugs. The 2026-05-09 bugs (CustomerQueryRq, then InvoiceQueryRq) only showed up under live QBXMLRP2, which rejected out-of-order children with the cryptic "QuickBooks found an error when parsing the provided XML text stream". Pinning emit order at the builder layer is the cheapest place to catch this class of regression pre-live.
- **Counts.** Vitest: 189 → 192 across 6 → 7 files. No tool count change. Build clean.
- **No code changes outside the test file.** Builder behavior was already correct — this test pins the contract, it doesn't fix anything.

## Verify Before Continuing

- [ ] **Build.** `npm run build` exits 0.
- [ ] **Vitest suite.** `npm test` → `Test Files 7 passed | Tests 192 passed`.
  - **Note:** vitest 4.1.5 occasionally reports a transient "Cannot read properties of undefined (reading 'config')" failure on the first run with a fresh process — observed once during this session, cleared instantly on re-run. If you see it, run `npm test` again before assuming a real failure.
- [ ] **dist smoke.** `node dist/index.js` with closed stdin exits 0 and prints `Mode: simulation`. On Windows / PowerShell: `"" | & node dist/index.js` (the empty pipe closes stdin). On bash: `node dist/index.js < /dev/null`.
- [ ] **Live MCP exerciser** (only re-run if you suspect a regression in the live path). No live behavior changed this session — only a test file was added. Steps to re-verify on a Windows + QB Desktop box:
  1. `cd "C:\Users\VR\Projects\Quickbooks MCP Desktop"`
  2. `$env:Path = "C:\Users\VR\AppData\Local\nvm;C:\nvm4w\nodejs;" + $env:Path; node --version` → `v20.20.2`.
  3. QB Desktop must be open with the target `.qbw`.
  4. `node scripts\exercise-mcp-live.mjs` → expected `OK: 20/20 read-only tools returned structured responses`.

## Next Task

**No concrete implementation task is queued.** All Phase 1-8 todo items are closed and the builder-emit-order regression test (the prior carried quality follow-up) is now shipped. Two open items remain, both blocked on operator action:

1. **Live-test `qb_company_open` + `qb_company_list`** (carried, blocked). Sim-tested only. Requires:
   - A second client `.qbw` accessible on disk.
   - `QB_COMPANY_ROOT` set to its parent directory.
   - From an MCP client (or extending [scripts/exercise-mcp-live.mjs](scripts/exercise-mcp-live.mjs) — `qb_company_list` is read-only and safe to add; `qb_company_open` should stay out of the read-only exerciser), call `qb_company_list` → confirm both files surface, then call `qb_company_open` against one of them. Documented constraint: QBXMLRP2 cannot OPEN a `.qbw` that QB itself hasn't loaded — so opening a non-loaded file will surface a QBXMLRP2 error, which is itself worth observing once for error-shape coverage.

2. **Operator-driven feature requests / bug reports.** With the fix list closed, future sessions are likely "user found something" or "user wants new tool/workflow". When that happens, follow CLAUDE.md PICKUP → WORK → VERIFY → HANDOFF — and add a new phase to [todo.md](todo.md) if the request is non-trivial.

If neither of those is in scope, this is a clean stopping point.

## Context Notes

- **Builder emit order is contract.** The builder serializes children via `Object.entries(body)` — i.e. insertion order. Tools rely on this to produce schema-compliant XML by populating filter dicts in QB's canonical `<xs:sequence>` order. Do NOT introduce normalization (sorts, Map keys, JSON shape transforms) into the filter-flow without updating the regression tests in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts) — and don't update those tests to match a regression. The whole point of the test is that breaking the contract requires a deliberate, traceable edit to both the builder and the test.
- **Schema-order is silent in simulation.** [src/session/simulation-store.ts](src/session/simulation-store.ts) `handleQuery` reads parsed filter objects directly — it never re-emits XML. Schema-order regressions therefore pass simulation cleanly and only fail under live QBXMLRP2. The builder-emit-order tests are now the only pre-live signal for this bug class.
- **Canonical filter sequences.** The two pinned by the new tests:
  - `CustomerQueryRq` (and other simple list *QueryRqs): `ListID/FullName (selector) → MaxReturned → ActiveStatus → FromModifiedDate/ToModifiedDate → NameFilter/NameRangeFilter → tail.`
  - `InvoiceQueryRq` (and other transaction *QueryRqs that share this filter group — Bill, Estimate, SalesReceipt, CreditMemo, PurchaseOrder, JournalEntry): `TxnID/RefNumber (selectors) → MaxReturned → ModifiedDateRangeFilter → TxnDateRangeFilter → EntityFilter → AccountFilter → RefNumberFilter → CurrencyFilter → PaidStatus → IncludeLineItems → IncludeLinkedTxns.`
- **`switchCompanyFile` is the ONLY way to mutate `config.companyFile` post-construction** (carried). Tools never reach into `QBSessionManager.config` directly — it's private. `getCompanyFile()` is a narrow read-only accessor; future tools that need other config fields should add another narrow accessor, NOT widen access to `config` as a whole.
- **Sim-reset contract is asymmetric and intentional** (carried). `switchCompanyFile("simulation") → switchCompanyFile("simulation")` (same path twice) STILL reseeds the second time. Real QB persists per-file; the sim has no persistence layer. Pinned by [tests/company-switching.test.ts:80-99](tests/company-switching.test.ts#L80-L99). DECISIONS.md (2026-05-09 sim-reset entry) records the tradeoff.
- **Live `qb_company_open` constraint** (carried). QBXMLRP2 cannot OPEN a `.qbw` file — it can only attach to one QB Desktop already has loaded. Documented in [src/index.ts:109-110](src/index.ts#L109-L110).
- **Windows tmp-dir cleanup race** (carried). `fs.rm(tmpDir, { recursive: true, force: true })` ENOTEMPTYs sometimes on Windows. Fix: `maxRetries: 5, retryDelay: 50`.
- **Restoring `delete`d env vars** (carried). When an env var is `undefined` before a test, restore it with `delete process.env.X`, NOT `process.env.X = undefined` (the latter sets the literal string `"undefined"`).
- **74 tools registered** (unchanged this session).
- **Test setup gotcha** (carried). `session.addEntity("Customer", data)` takes FLAT entity fields (`{ Name: "X" }`), NOT `{ CustomerAdd: { Name: "X" } }`. The builder wraps in `<CustomerAdd>` automatically.
- **Bills use `AmountDue`, NOT `BalanceRemaining`** (carried).
- **Item 27 wire names diverge** (carried). Requests use `iterator` (lowercase, no I) + `iteratorID`; responses use `iteratorRemainingCount` + `iteratorID`.
- **Cert flow** for live (carried): Screen 1 = "Yes, always; allow access even if QuickBooks is not running" → Continue. Screen 2 = type literal `Yes` (case-sensitive) → Continue. Already approved on this PC.
- **OneDrive concern unresolved** (carried) — `.qbw` lives in a OneDrive-synced folder (sync paused). Intuit warns about corruption risk for QB files in cloud-sync folders.
- **Multi-file is sequential, not concurrent** (carried) — QB Desktop only allows one file open per instance.
