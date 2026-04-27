# Handoff State

_Last updated: 2026-04-27 (post-Item 27 session) — Phase 6 fully closed._

## Last Session Summary

- **Closed Phase 6, Item 27** — IteratorID / IteratorRemainingCount support across 5 layers, pure-additive at the public API surface:
  - **Types** ([src/types/qbxml.ts](src/types/qbxml.ts)) — `QBXMLRequestBody.attributes?: Record<string, string>` (generic XML-attr passthrough), `QBXMLResponseBody.iteratorRemainingCount? | iteratorID?` (typed iterator metadata).
  - **Builder** ([src/qbxml/builder.ts](src/qbxml/builder.ts)) — serializes `attributes` alongside `requestID` with `escapeXml`. `buildQueryRequest`'s 3rd arg refactored from `version?: string` to `options?: { version?, iterator?, iteratorID? }`.
  - **Parser** ([src/qbxml/parser.ts](src/qbxml/parser.ts)) — surfaces `@_iteratorRemainingCount` / `@_iteratorID` from `*QueryRs` envelopes. `iteratorRemainingCount=0` (exhausted) round-trips correctly via `!== undefined` gate (load-bearing — `Number(0)` is falsy).
  - **Manager** ([src/session/manager.ts](src/session/manager.ts)) — new `queryEntityPaginated(entity, filters, options)` returns `{ entities, iteratorRemainingCount?, iteratorID? }`. Existing `queryEntity()` unchanged.
  - **Simulation store** ([src/session/simulation-store.ts:109](src/session/simulation-store.ts#L109)) — `handleQuery` reads `reqData["@_iterator"]`. Start = full result + `iteratorRemainingCount=0` + synthesized `SIM-ITER-<time>-<rand>` iteratorID. Continue/Stop = `statusCode=1` empty + no metadata. Sim does NOT page (simpler-strategy, pre-approved).
  - **Tool surface** — `qb_customer_list` / `qb_invoice_list` / `qb_bill_list` accept `paginate?` + `iteratorID?`. `qb_item_list` accepts both BUT requires `itemType` when paginating (iterators are scoped to a single `Item*QueryRq`). Default-path responses unchanged — no iterator keys leak.
- **New harness** — [scripts/verify-item27-iterator.mjs](scripts/verify-item27-iterator.mjs), 27 assertions across all 5 layers including wire-level builder→sim→response round-trip (the load-bearing assertion).
- **All 5 harnesses pass + build clean.** No README / instructions / ARCHITECTURE / DECISIONS / REQUIREMENTS changes needed (pre-approved simpler strategy, opt-in flag not new tool, wire envelope shape unchanged).

## Verify Before Continuing

- [ ] **Build.** `npm run build` exits 0.
- [ ] **Item 27 harness.** `node scripts/verify-item27-iterator.mjs` → 27/27 pass. Confirms 5-layer round-trip.
- [ ] **Item 29 harness.** `node scripts/verify-item29-input-validation.mjs` → 44/44.
- [ ] **Item 25/26/28 harness.** `node scripts/verify-item25-error-shape.mjs` → 47/47. Confirms `QBXMLResponseError` still propagates through new `queryEntityPaginated` path.
- [ ] **Pickup harness.** `node scripts/verify-pickup-2026-04-27.mjs` → 7/7.
- [ ] **Env matrix harness.** `node scripts/verify-item23-env-matrix.mjs` → 99/99.

## Next Task

**Phase 8 recommended next** (Phase 6 fully closed, Phase 7 Windows-only).

- [ ] **31.** Add `tests/` directory with Vitest: round-trip tests for builder→parser, simulation-store CRUD per entity, filter handling, and tool integration tests through the MCP server transport.
- [ ] **32.** Add `.gitignore` (`node_modules/`, `dist/`, `*.log`, `.env`), `.env.example` documenting all `QB_*` vars, and run `npm run build` to verify `dist/` produces working node entry. _(`.env.example` already shipped under Item 23 — Item 32 is just the `.gitignore` + smoke-test.)_

**Recommendation:** Item 32 first (~30 min, platform-agnostic). Then Item 31 (~3-4 hrs — port the four `.mjs` harnesses to Vitest; keep `verify-item23-env-matrix.mjs` separate due to subprocess `process.platform` mocking).

After Phase 8: only **Phase 7, Item 1** (live `QBXMLRP2` COM connection) remains — requires Windows + QuickBooks Desktop installed.

## Context Notes

- **Item 27 — request vs response attribute names differ.** Requests use `iterator` (lowercase, no I) + `iteratorID`; responses use `iteratorRemainingCount` + `iteratorID`. Both verified end-to-end in the harness's wire-level round-trip block — the load-bearing assertion. If a future change drifts on either name, that test fails first.
- **Item 27 — `iteratorRemainingCount === 0` ≠ absent.** `0` = "you got the last page, drained on this response"; absent = "wasn't an iterator request, or already drained on a prior request." Parser uses `!== undefined` gate because `Number(0)` is falsy. Harness asserts both.
- **Item 27 — `buildQueryRequest` signature changed.** 3rd arg `version?: string` → `options?: { version?, iterator?, iteratorID? }`. Only callers were `manager.ts:queryEntity` + new `queryEntityPaginated` (both updated). Other builder helpers (Add/Mod/Delete/Report) keep legacy `version?: string` 3rd arg — only Query supports iterator.
- **Item 27 — items pagination requires `itemType`.** Multi-subtype fan-out cannot paginate. Refusal is at the handler layer (not zod) so the error message can explain WHY. Pattern matches bills.ts pre-flight `success: false, error: "..."` from Phase 3 — these don't go through Item 25 wrapper because they fire before any session call.
- **Item 27 — `QBXMLRequestBody.attributes` is generic.** Currently only iterator state, but extends naturally if future QBXML versions add other request-element attributes.
- **Pre-flight validation blocks (carried).** Tools like [src/tools/invoices.ts:131-142](src/tools/invoices.ts#L131-L142) and the new items-no-itemType refusal in [src/tools/items.ts](src/tools/items.ts) produce `{ success: false, error: "..." }` (NOT canonical Item 25 `{ statusCode, statusMessage }`). Intentional — cross-field validation, not QB-side errors.
- **Item 26 audit trail (updated counts).** `grep -E "session\.(queryEntity|queryEntityPaginated|addEntity|modifyEntity|deleteEntity)" src/tools/*.ts | wc -l` → 76. `grep "statusMessage: e.message" src/tools/*.ts | wc -l` → 71. `grep "...(humanReadable ? { humanReadable } : {})" src/tools/*.ts | wc -l` → 71. Static-vs-wrapper diverges by 5 because list tools share one try/catch across paginated + legacy paths (4 tools × 1 extra static call) + items.ts non-paginated has a `Promise.all` over 5 subtypes (1 static, 5 runtime). When 71/71 diverge, a wrapper landed without humanReadable.
- **Bills use `AmountDue`, NOT `BalanceRemaining`** ([src/session/simulation-store.ts:954-956](src/session/simulation-store.ts#L954-L956)).
- **Verification gotcha (carried)** — `fakeServer`-captured handlers do NOT pass through zod when called directly. Item 27 harness wraps with `z.object(schema).safeParse(...)` in its `callTool` helper (~line 75-85). Use this pattern when porting to Vitest.
- **Verification gotcha (carried)** — `handleQuery` filters require uppercase `TxnID` / `RefNumber` / `FullName` when calling `session.queryEntity` directly. Tools translate from lowercase correctly.
- **Pickup harness leaves residue** ([scripts/verify-pickup-2026-04-27.mjs](scripts/verify-pickup-2026-04-27.mjs)) — creates `$1200 Rent Expense` bill against `Acme Office Supplies`, inflates AP from 0 to 1200 in same run. New harnesses should reseed or assert post-state explicitly. Item 27 harness uses fresh-per-run sim store (separate process) so no cross-contamination.
- **Item 31 outline.** `npm install -D vitest` (record in `DECISIONS.md` per CLAUDE.md "no new deps without a note"). Port 4 of 5 `.mjs` harnesses into `tests/*.test.ts`: `qbxml-roundtrip`, `simulation-store`, `iterator`, `error-shape`, `input-validation`. Keep `verify-item23-env-matrix.mjs` separate (subprocess `process.platform` mocking, harder to port). Add `npm test` → `vitest run`.
- **Item 32 outline.** `.gitignore` at project root: `node_modules/`, `dist/`, `*.log`, `.env`, `.DS_Store`. Verify with `git status` no previously-tracked file gets removed (may need `git rm --cached` for any tracked dist/log files — check before committing). Smoke test: `npm run build && node dist/index.js` boots cleanly, prints simulation banner, exits when stdin closes.
- **Item 1 (Phase 7) — Windows-only.** Requires QuickBooks Desktop installed. `npm install winax` (or `node-activex` — record choice in `DECISIONS.md`). Replace `openSession` / `sendRequest` throws in [session/manager.ts](src/session/manager.ts) with `OpenConnection2` / `BeginSession` / `ProcessRequest` / `EndSession` / `CloseConnection`. Wire `parseQBXMLResponse` for live responses. Cannot be marked complete without exercising on real Windows + QB box — leave as `partial` if developed off-platform.
