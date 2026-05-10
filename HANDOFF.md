## Handoff State

_Last updated: 2026-05-10. Phase 10 #44 closed (1099 summary + detail). Tool count 76 → 78. 351/351 tests green._

## Last Session Summary

- **Phase 10 #44 closed — `qb_1099_summary` + `qb_1099_detail` shipped.** Two new tools registered in fresh [src/tools/form-1099.ts](src/tools/form-1099.ts), wired in [src/index.ts](src/index.ts) (tools 77 + 78). January's 1099 prep workflow now has direct surface area instead of `qb_raw_query` aggregation.
- **Implementation diverges from the literal `Form1099QueryRq` plan in todo.md.** Aggregates server-side from existing typed `Bill` + `Check` queries via `session.queryEntity` rather than wiring a new wire request type. Three reasons: keeps the "tools never construct QBXML directly" rule (CLAUDE.md) intact; identical sim/live behavior with no new wire surface to verify against a Windows box; no dependency on QB Preferences' per-account 1099 box mapping. Tradeoff: every payment to an eligible vendor counts toward the threshold, not just payments hitting QB-flagged 1099 accounts — more permissive (safer) than QB's Form1099 wizard, documented loudly in both tool descriptions and [DECISIONS.md](DECISIONS.md#2026-05-10--qb_1099_summary--qb_1099_detail-aggregate-from-typed-bill--check-queries-not-form1099queryrq).
- **Vendor classification:** `IsVendorEligibleFor1099 === true` selects participants, `Vendor1099Type === 'MISC'` opts a vendor into 1099-MISC (default 1099-NEC). The seed was extended with 3 new 1099-eligible vendors (Joe Contractor / Sarah Designer LLC / ACME Property Mgmt) carrying `VendorTaxIdent` + `VendorAddress`; the existing two vendors got explicit `IsVendorEligibleFor1099: false` for clarity.
- **`qb_1099_summary` arg surface:** `taxYear` (default = last completed year — Jan-2026 returns TY2025), `fromDate` / `toDate` (override taxYear), `threshold` (default 600 — IRS TY2024+ general), `formType: 'NEC' | 'MISC' | 'all'`, `includeBelowThreshold` (default false). Returns sorted-desc-by-totalPaid vendor rows with `taxId` / `address` / `totalPaid` / `transactionCount` / `billCount` / `checkCount` / `meetsThreshold`, plus top-level `totalsByForm` + counts. Default behavior: only above-threshold vendors surface; pass `includeBelowThreshold:true` for review of sub-threshold spenders.
- **`qb_1099_detail` arg surface:** same date params + optional `vendorListId` / `vendorFullName` for single-vendor scope + optional `formType`. Returns per-transaction breakdown — each Bill / Check carries `txnId` / `txnDate` / `refNumber` / `total` / `memo` / `lines` (per-line `accountName` + `amount` + `memo`). No threshold filter (every transaction surfaces). Empty-on-scope-mismatch is structured success (not error).
- **Card payments excluded** from both tools per IRS Form 1099 instructions (the card processor reports those on 1099-K). The walk hits `Bill` and `Check` only — not `CreditCardCharge`.
- **24 new tests in [tests/form-1099.test.ts](tests/form-1099.test.ts).** Coverage: pure helpers (date-window resolution, NEC/MISC classification, bill-line totaling), aggregation engine (per-vendor Bill+Check sum, ineligible-vendor exclusion, out-of-window exclusion, empty result), summary tool (sort order, threshold filter, includeBelowThreshold, formType, explicit fromDate/toDate override, address/taxId surfacing, default taxYear), detail tool (per-transaction breakdown sorted by date, vendorListId scope, vendorFullName scope, no-match success, formType filter). Tests build Bill/Check fixtures via `session.addEntity` rather than seeding globally — the seed-only-vendors approach kept the existing 327 tests green. Test count 327 → 351.
- **Tool count 76 → 78.** README total updated. Server `instructions` block in [src/index.ts](src/index.ts) extended with a `qb_1099_summary` / `qb_1099_detail` line.

## Verify Before Continuing

If the next session starts within a few hours and no other agent has touched the tree, these can be skipped. Otherwise re-run:

- [ ] `npm run build` exits 0.
- [ ] `npm test` → `Test Files 14 passed | Tests 351 passed`. (vitest 4.1.5 sometimes throws a transient `Cannot read properties of undefined (reading 'config')` on a fresh run — re-run before assuming a real failure.)
- [ ] PowerShell `"" | & node dist/index.js` exits 0 with `Mode: simulation` printed.
- [ ] `%APPDATA%\Claude\claude_desktop_config.json` still has `mcpServers.quickbooks-desktop` pointing at `C:\nvm4w\nodejs\node.exe` (NOT system `node`).
- [ ] (Optional, requires Windows + QB) Live-smoke #44 by calling `qb_1099_summary({ taxYear: 2024 })` against `VR Tax & Consulting Inc..qbw` through Claude Desktop. Expected: returns vendors flagged `IsVendorEligibleFor1099` in the operator's books with their TY2024 totals; threshold-above vendors only by default. Then `qb_1099_detail({ taxYear: 2024, vendorFullName: "<some vendor>" })` returns each Bill / Check for that vendor with line-level breakdown. The exerciser script ([scripts/exercise-mcp-live.mjs](scripts/exercise-mcp-live.mjs)) has not been extended for #44 yet — adding 2 read-only probes is a 5-min follow-up if the operator wants pre-flight verification next session.

## Next Task

**Phase 10 has 3 remaining items (#45–47).** Ask the operator which one to pick — recommendations carried forward:

- **#47 — idempotency keys on creates** — defends against duplicate posts on agent retry. Optional `idempotencyKey: string` arg on every `*_create` / `*_add`. Per-`companyFile` in-memory cache. Composes well with #42 (read-only) — a write run with idempotency keys plus the operator's read-only diagnostic agent gives a complete safety story. **Now the highest-leverage item left in Phase 10** with #44 closed.
- **#45 — Memorized / recurring transaction CRUD** — read + execute first; create-side scope depends on SDK surface (Intuit's docs are partial — verify before scoping).
- **#46 — Bank reconciliation primitives** — `ReconcileQueryRq` (read-only, well-supported); writing reconciliation state via SDK is not exposed by Intuit. Scope read-only first.

After Phase 10, **Phase 11 (remaining missing reports)** has 9 high-value report tools sized by January-deadline urgency. **Phase 12 (workflows)** has the `qb_invoice_write_off` shortcut and the batch invoice/SR pattern (#58 — same envelope plumbing that #43 generalized).

## Context Notes

- **The 1099 aggregation strategy is structural, not opportunistic.** Aggregating from typed Bill + Check queries instead of wiring `Form1099QueryRq` is the right pattern for any future tool that "summarizes data already in QB" — it keeps the chokepoints we trust (typed query helpers + schema-pinned builder) and avoids inventing new wire surface that has to be schema-order verified. Apply the same pattern to Phase 11 reports where the report ALREADY exists as `GeneralSummaryReportQueryRq` / `GeneralDetailReportQueryRq` (use those — they're proven), but reach for typed queries + tool-side aggregation when the desired output shape doesn't map cleanly to a single QB report.
- **Card payments are NOT in the 1099 walk by design (IRS rule).** Bills paid via credit card go through `BillPaymentCreditCard`, but the original `Bill` IS counted in the walk's amount accounting (the bill total is what the operator owed the vendor; the card payment is the IRS-excluded *settlement* method, not the recognition event). Don't add CreditCardCharge to the walk later thinking it was an oversight — it's deliberate.
- **Tool defaults to last completed tax year.** `qb_1099_summary({})` in January 2026 returns TY2025. `defaultLastCompletedTaxYear()` reads `new Date().getUTCFullYear() - 1` — keep UTC to avoid timezone-drift on Dec 31 / Jan 1 edge calls. Tests use `defaultLastCompletedTaxYear()` directly to stay deterministic across the year boundary.
- **Bill totals come from line sum, NOT header `AmountDue`.** Paid bills have `AmountDue: 0` but the original total still reads from the line array. The aggregation passes `IncludeLineItems: true` on the `BillQueryRq` so lines come back. `billOriginalTotal` falls back to `AmountDue` if lines are stripped — defensive, not load-bearing.
- **Single-vendor scope filter that matches nothing is structured success, not error.** `qb_1099_detail({ vendorFullName: "Nonexistent" })` returns `{ vendors: [] }` with `isError: false`. The tool can't distinguish "operator typo'd the vendor name" from "this real vendor has no activity in the window" — surfacing both as empty success lets the operator compare against `qb_1099_summary` to disambiguate.
- **Seed strategy: vendors only, no Bills/Checks.** Adding `Bill` / `Check` rows to the global seed broke 7 existing tests in transaction-list.test.ts + balance-summary.test.ts + iterator.test.ts (counts and ordering changed because seeded bills hit Rent Expense / Payroll Expense). The 1099 tests build their own Bill/Check fixtures via `session.addEntity` — slower than direct store inject but goes through the proper handleAdd path so AmountDue / lines are computed correctly. Future tools that need their own transactions should follow the same pattern — keep the global seed minimal and lean on `addEntity` in tests.
- **78 tools registered.** #44 added 2 (qb_1099_summary, qb_1099_detail). The next two new-tool items are #45 (memorized — likely 2-3 read-side tools) and #46 (bank rec — 3 read-side tools); #47 (idempotency) is a per-tool flag, no new tool surface.
- **Carried hard-won gotchas** (unchanged from prior handoffs):
  - **Read-only gate is structurally load-bearing.** Every typed mutation goes through `addEntity` / `modifyEntity` / `deleteEntity` / `executeBatchAdd` — that's the chokepoint. CLAUDE.md's "tools never construct QBXML directly" rule is what makes this gate safe; if a future tool bypasses to `sendRequest` with hand-built mutation XML, the gate would silently miss it.
  - **`statusCode 9001` is a synthetic sentinel** for client-side gates. Reserved for read-only mode; pick 9002, 9003, etc. for unrelated future client-side rejections.
  - **Multi-request envelope plumbing is load-bearing for batch ops.** [src/session/simulation-store.ts](src/session/simulation-store.ts) `processRequest` outer-loop array-walking + `@_onError` handling generalizes to all future batch operations. Don't regress.
  - **`@_requestID` capture is mandatory for batch correctness.** Pinned in [tests/journal-entry-batch.test.ts](tests/journal-entry-batch.test.ts).
  - **stopOnError is HARDCODED in [src/qbxml/builder.ts](src/qbxml/builder.ts).** Sim store reads `@_onError` defensively.
  - **Compensating delete is REVERSE post order.** Most-recent JE deleted first.
  - **Sim's `validateJournalEntryBalance` rejects all-zero JEs with statusCode 3030.**
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
