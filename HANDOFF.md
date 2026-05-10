# Handoff State

_Last updated: 2026-05-09 (after Phase 10 #41 close). Build clean, 286/286 tests green (was 244, +42 new for #41). Tool count unchanged at 75 (#41 enriches existing tools rather than adding new ones). Phase 10 has 6 more open items (#42-47). Next session picks one — recommended: #43 (`qb_journal_entry_batch_create`) or #42 (read-only session flag) — but operator priority can override._

## Last Session Summary

- **Closed Phase 10 #41 — line-level detail in `*_list` responses (`includeLineItems`).** Optional `includeLineItems: boolean` arg added to seven list tools: `qb_invoice_list`, `qb_bill_list`, `qb_sales_receipt_list`, `qb_credit_memo_list`, `qb_purchase_order_list`, `qb_estimate_list`, `qb_journal_entry_list`. Default `false` (header-only, matches real QB). Set `true` to surface the type-specific `*LineRet` array(s) on each row.
- **Scope expanded to seven tools** — HANDOFF originally specified six, but `qb_journal_entry_list`'s description already promised lines on every row. The strip-by-default change would have made it lie in sim (and was already lying in live). Adding the JE opt-in keeps the contract honest in both modes for trivial extra cost.
- **Sim contract: `handleQuery` now strips `*LineRet` / `*LinesRet` keys** from each result entity by default via regex `/Line(s?)Ret$/`. When `IncludeLineItems` is truthy in the request body — boolean `true` (in-process callers) OR string `"true"` (the wire form after a fast-xml-parser round trip) — the strip is skipped. Both shapes pinned in [tests/include-line-items.test.ts](tests/include-line-items.test.ts).
- **Header-derived totals survive the strip** — `Subtotal`, `AmountDue`, `BalanceRemaining`, `IsPaid`, `TotalDebit`, `TotalCredit`, `AppliedAmount`, `TotalAmount`. They're computed FROM lines but they are HEADER fields and live at the entity root, not inside the *LineRet arrays.
- **`AppliedToTxnRet` (relationship array) survives the strip** — its key has no "Line" segment so it doesn't match the regex. The strip is line-data-specific, not relationship-data-generic.
- **Internal consumer fixed: `qb_estimate_convert_to_invoice`** ([src/tools/estimates.ts](src/tools/estimates.ts)) reads `EstimateLineRet` from a `queryEntity` response to map onto `InvoiceLineAdd`. Now passes `IncludeLineItems: true` internally so the strip-by-default doesn't break the convert flow. Pinned end-to-end in the test file (4×125 + 2×200 → invoice carries 500 + 400 line amounts).
- **Schema-order pins** in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts): InvoiceQueryRq + BillQueryRq each get their own (PaidStatus is in the sequence; IncludeLineItems sits after); JournalEntryQueryRq gets its own (no PaidStatus; IncludeLineItems sits after TxnDateRangeFilter); the four no-PaidStatus types (Estimate / SalesReceipt / CreditMemo / PurchaseOrder) share a looped test because their tail position is identical.
- **Tool-layer contract pinned** via `vi.spyOn(session, "queryEntity")` reading `Object.keys(filters)` — for all seven tools: missing/false omits the wire flag, true threads `IncludeLineItems: true` as the LAST key in the filter dict (schema-order tail).
- **42 new tests across 2 files.** [tests/include-line-items.test.ts](tests/include-line-items.test.ts) (new file) covers the sim contract (header-only by default, lines on opt-in), tool-layer filter dict (omits / includes / explicit-false), sim gate truthy semantics (boolean true, wire string "true", missing), plus the convert-tool regression. [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts) gets 3 new tests (Bill, JournalEntry, looped Estimate/SR/CM/PO).
- **Acceptance criteria entry added** in [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md) under Phase 10 (newest first). No README tool-count change — #41 enriches existing tools, doesn't add new ones.
- **286/286 tests green** (was 244 + 42 new). Build clean.

## Verify Before Continuing

- [ ] `npm run build` exits 0.
- [ ] `npm test` → `Test Files 11 passed | Tests 286 passed`. (vitest 4.1.5 sometimes throws a transient `Cannot read properties of undefined (reading 'config')` on a fresh run — re-run before assuming a real failure.)
- [ ] PowerShell `"" | & node dist/index.js` exits 0 with `Mode: simulation` printed.
- [ ] `%APPDATA%\Claude\claude_desktop_config.json` still has `mcpServers.quickbooks-desktop` pointing at `C:\nvm4w\nodejs\node.exe` (NOT system `node`).
- [ ] (Optional, requires Windows + QB) Live-smoke #41 by calling `qb_invoice_list({ fromDate: "2024-01-01", toDate: "2024-12-31", includeLineItems: true })` against `VR Tax & Consulting Inc..qbw` through Claude Desktop. Expect: rows from FY2024 invoices each carrying an `InvoiceLineRet` array. Default call without `includeLineItems` returns the same row count, header-only. The exerciser script ([scripts/exercise-mcp-live.mjs](scripts/exercise-mcp-live.mjs)) has not been extended for #41 yet — adding probes for `includeLineItems: true` on at least one of the 7 tools is a 5-min follow-up if the operator wants pre-flight verification next session.

## Next Task

**Phase 10 has 6 remaining items (#42-47).** Recommended: pick by operator value, not by smallest-first.

**Top candidates:**
- **#43 — `qb_journal_entry_batch_create({ entries: [...] })`** — atomic batch JE. Heaviest lift in Phase 10 (multi-request envelope with `<QBXMLMsgsRq onError="stopOnError">` semantics). Replaces the operator's `credit-card-qb-batch` skill's Excel intermediate. Would also unlock the same envelope pattern for #58 (batch invoice/SR). Big workflow win.
- **#42 — read-only session flag** — `qb_session_connect({ readOnly: true })` gates every `*_add` / `*_update` / `*_delete` / `*_apply` tool to throw a structured error. Big confidence win for unattended automation but moderate engineering — affects every mutation tool. Touches breadth, not depth.
- **#44 — `qb_1099_summary` / `qb_1099_detail`** — January-staple for any practice issuing 1099s. `Form1099QueryRq` (1099-MISC + 1099-NEC). Returns vendor + threshold + tracked amounts.
- **#47 — idempotency keys on creates** — defends against duplicate invoices on agent retry / network glitch. Optional `idempotencyKey: string` arg on every `*_create` / `*_add`. Server stores recent `(key → created TxnID/ListID)` pairs in the simulation store and the live session manager (in-memory, scoped to current `companyFile`).
- **#45 — Memorized / recurring transaction CRUD** — read + execute first; create-side scope depends on SDK surface (Intuit's docs are partial — verify before scoping).
- **#46 — Bank reconciliation primitives** — `ReconcileQueryRq` (read-only, well-supported); writing reconciliation state via SDK is not exposed by Intuit. Scope read-only first.

## Context Notes

- **Sim line-strip behavior change is intentional** and matches real QB exactly. Pre-#41 callers in sim mode that relied on lines coming back without the flag get header-only now — fix is one line: add `includeLineItems: true` to the call. Pre-#41 callers in live mode were already getting header-only (real QB had this contract all along), so the change closes a sim/live divergence rather than introducing one.
- **The sim's IncludeLineItems gate is dual-shape** — accepts both boolean `true` (in-process callers handing the filter dict directly to `QBSessionManager.queryEntity`) AND string `"true"` (the wire form after fast-xml-parser round-trips, which surfaces every element value as a string). Pinned in `tests/include-line-items.test.ts`. If you ever add another truthy-style flag (e.g. `IncludeLinkedTxns`, `IncludeRetElement`), use the same dual-shape check.
- **The strip regex is `/Line(s?)Ret$/`** — matches `InvoiceLineRet`, `ExpenseLineRet`, `JournalCreditLineRet`, etc. If a future entity adds a new line key (e.g. `SalesTaxLineRet`), it'll be stripped automatically. AppliedToTxnRet does NOT match (no "Line" segment) and stays — that's the relationship array, not a line breakdown.
- **`qb_estimate_convert_to_invoice` is the only internal consumer of `queryEntity` that reads line data.** Other internal callers (AR/AP aging, JE list pre-#41, etc.) read header-only. If a future tool adds a `queryEntity` call that needs lines, it must explicitly pass `IncludeLineItems: true` — otherwise the strip-by-default will silently drop them.
- **Phase 10 #41's vi.spyOn pattern is now used in 3 test files** (iterator.test.ts Layer 8, transaction-list.test.ts, include-line-items.test.ts). It's the canonical way to assert tool-layer transformations on the args before they hit the manager. Cleaner than asserting on built XML or sim behavior because it isolates the tool contract.
- **75 tools registered** (unchanged from #40 — #41 enriches existing tools). Phase 10 will add up to 6 more (#42-47). #43, #44, #45, #46 each add new tool surface; #42 is a session-level flag (no new tool); #47 is a per-tool optional arg (no new tool).
- **Carried hard-won gotchas** (unchanged from prior handoff):
  - `switchCompanyFile` is the only path to mutate `config.companyFile` post-construction. `config` is private; use `getCompanyFile()` accessor.
  - `session.addEntity("Customer", data)` takes FLAT entity fields (`{ Name: "X" }`), NOT `{ CustomerAdd: { Name: "X" } }`. Builder wraps automatically.
  - Bills use `AmountDue`, not `BalanceRemaining`.
  - Iterator wire names diverge — requests use `iterator` + `iteratorID` (lowercase, no I); responses use `iteratorRemainingCount` + `iteratorID`.
  - QBXMLRP2 cannot OPEN a `.qbw`; can only attach to one QB Desktop already has loaded ([src/index.ts:109-110](src/index.ts#L109-L110)).
  - Live cert flow on a fresh PC: Screen 1 = "Yes, always; allow access even if QuickBooks is not running" → Continue. Screen 2 = type literal `Yes` (case-sensitive) → Continue. Already approved on this PC.
  - Windows tmp-dir cleanup race: `fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })`.
  - Restoring `delete`d env vars in tests: `delete process.env.X`, NOT `process.env.X = undefined` (the latter sets the literal string `"undefined"`).
  - Sim-reset is asymmetric and intentional — `switchCompanyFile("simulation")` twice still reseeds the second time. Pinned by [tests/company-switching.test.ts:80-99](tests/company-switching.test.ts#L80-L99).
  - QB Desktop allows only one file open per instance — multi-file is sequential, not concurrent.
  - OneDrive concern unresolved — `.qbw` lives in a OneDrive-synced folder (sync paused). Intuit warns about corruption risk for QB files in cloud-sync folders.
  - **fast-xml-parser does NOT decode numeric character entities** (`&#183;` middle-dot stays literal). The `decodeXmlEntities` helper in [src/qbxml/parser.ts](src/qbxml/parser.ts) handles them — reuse it if any future code surfaces account names from live QB responses.
  - **Live verification requires `C:\nvm4w\nodejs\node.exe`** (v20.20.2 — winax-compatible). System PATH is v22.17.0 which would break the prebuilt winax binary. The Claude Desktop config already pins this. Verification scripts: `"C:/nvm4w/nodejs/node.exe" scripts/exercise-mcp-live.mjs` (broad surface, 28/28).
