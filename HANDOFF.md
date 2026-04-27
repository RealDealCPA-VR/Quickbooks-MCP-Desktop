# Handoff State

_Last updated: 2026-04-27 (post-Item 31 session) — Phase 8 fully closed. Only Phase 7 Item 1 remains._

## Last Session Summary

- **Closed Phase 8 Item 31** — added Vitest suite under [tests/](tests/), 5 files / 178 assertions, runnable via `npm test`.
  - Ports: `iterator.test.ts` (27), `input-validation.test.ts` (44), `error-shape.test.ts` (47) — assertion counts match the original `.mjs` harnesses exactly.
  - New: `qbxml-roundtrip.test.ts` (40, builder/parser shape) + `simulation-store.test.ts` (20, CRUD + filters + EditSequence concurrency).
- **Closed Phase 8 Item 32** — `.gitignore` already covered required entries; `.env.example` already shipped under Item 23. Only work was the smoke-test (`node dist/index.js </dev/null` → banner + exit 0).
- **Tooling.** `vitest@4.1.5` added to `devDependencies`; `package.json` `"test": "vitest run"`. Decision recorded in [DECISIONS.md](DECISIONS.md) `2026-04-27 — Vitest`. The 5 `verify-*.mjs` harnesses are kept (they verify `dist/`; Vitest verifies `src/` — complementary).

## Verify Before Continuing

- [ ] **Build.** `npm run build` exits 0.
- [ ] **Vitest suite.** `npm test` → `Test Files 5 passed | Tests 178 passed`. Counts must be exact: 27 + 44 + 47 + 40 + 20.
- [ ] **dist smoke-test.** `node dist/index.js </dev/null` exits 0 and prints `Mode: simulation` in the banner.
- [ ] **Item 27 harness.** `node scripts/verify-item27-iterator.mjs` → 27/27.
- [ ] **Item 29 harness.** `node scripts/verify-item29-input-validation.mjs` → 44/44.
- [ ] **Item 25/26/28 harness.** `node scripts/verify-item25-error-shape.mjs` → 47/47.
- [ ] **Pickup harness.** `node scripts/verify-pickup-2026-04-27.mjs` → 7/7.
- [ ] **Env matrix harness.** `node scripts/verify-item23-env-matrix.mjs` → 99/99.

## Next Task

**Phase 7, Item 1** — Windows + QuickBooks Desktop required. Last item; closes the entire 33-task list.

- [ ] **1.** Implement live `QBXMLRP2` COM connection in [src/session/manager.ts](src/session/manager.ts) (add `winax` / `node-activex` dep, replace throws in `openSession` / `sendRequest` with real `OpenConnection2` / `BeginSession` / `ProcessRequest` / `EndSession` / `CloseConnection` calls, wire `parseQBXMLResponse` for live responses).

## Context Notes

- **Item 1 — Windows-only.** Cannot be marked complete without exercising on a real Windows + QB Desktop box. If developed off-platform, leave as `partial` in `HANDOFF.md` with the exact verification steps spelled out. Record `winax` vs `node-activex` choice in [DECISIONS.md](DECISIONS.md) before installing.
- **Item 1 — wiring points.** `openSession` (currently throws) lives at [src/session/manager.ts:99-107](src/session/manager.ts#L99-L107). `sendRequest` live branch (currently throws) at [src/session/manager.ts:150-153](src/session/manager.ts#L150-L153). `closeSession` live no-op at [src/session/manager.ts:117-120](src/session/manager.ts#L117-L120). `parseQBXMLResponse` is already imported and ready for the live response path. The `simulationMode` branch is the contract live mode must match.
- **Test setup gotcha (carried).** `session.addEntity("Customer", data)` takes FLAT entity fields (`{ Name: "X", Phone: "Y" }`), NOT `{ CustomerAdd: { Name: "X" } }`. The builder wraps in `<CustomerAdd>` automatically. Double-wrap silently makes the inner `CustomerAdd` a stored field on the entity (handleAdd's `reqData[addKey] ?? reqData` fallback tolerates both shapes but the wrong shape produces garbage rather than erroring). Same for `modifyEntity`. Returns the entity object directly — already unwrapped from `*Ret`.
- **Vitest setup pattern.** Tests import from `src/` directly using the `.js` extensions the project uses for Node16 ESM. Vitest's Vite-based resolver handles `./manager.js` → `./manager.ts` automatically. No `vitest.config.ts` needed. fakeServer pattern (capture handlers + schemas via `fakeServer.tool(name, desc, schema, handler)`) lives at [tests/iterator.test.ts:33-50](tests/iterator.test.ts#L33-L50) — canonical implementation for porting more tests.
- **Verification gotcha (carried).** `handleQuery` filters require uppercase `TxnID` / `RefNumber` / `FullName` when calling `session.queryEntity` directly. Tools translate from lowercase correctly.
- **Item 27 wire names diverge.** Requests use `iterator` (lowercase, no I) + `iteratorID`; responses use `iteratorRemainingCount` + `iteratorID`. Parser uses `!== undefined` gate because `Number(0)` is falsy — `iteratorRemainingCount === 0` means "drained on this response," absent means "not an iterator request." Live mode must surface these correctly.
- **`buildQueryRequest` 3rd-arg signature.** `options?: { version?, iterator?, iteratorID? }`. Other builder helpers (Add/Mod/Delete/Report) keep legacy `version?: string` 3rd arg — only Query supports iterator.
- **Pre-flight validation blocks.** Tools like [src/tools/invoices.ts:131-142](src/tools/invoices.ts#L131-L142) and the items-no-itemType refusal in [src/tools/items.ts](src/tools/items.ts) produce `{ success: false, error: "..." }` (NOT canonical Item 25 `{ statusCode, statusMessage }`). Intentional — cross-field validation, not QB-side errors.
- **Bills use `AmountDue`, NOT `BalanceRemaining`** ([src/session/simulation-store.ts:954-956](src/session/simulation-store.ts#L954-L956)).
- **Pickup harness leaves residue** — [scripts/verify-pickup-2026-04-27.mjs](scripts/verify-pickup-2026-04-27.mjs) creates `$1200 Rent Expense` bill against `Acme Office Supplies`, inflates AP from 0 to 1200 in same run. Vitest tests use `newSession()` per-test (separate `QBSessionManager` + fresh `SimulationStore`) so cross-test contamination doesn't apply.
