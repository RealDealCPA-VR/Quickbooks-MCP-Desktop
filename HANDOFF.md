# Handoff State

_Last updated: 2026-04-27 (planning session — no code changes). Phase 7 expanded from 1 item to 4 to cover seamless multi-company workflow._

## Last Session Summary

- **Pickup verification** — all 8 gates passed at session start: `npm run build` 0, `npm test` 178/178 (5 files), dist smoke-test exit 0, all 5 `.mjs` harnesses green (27 + 44 + 47 + 7 + 99). No code touched after that.
- **Phase 7 expanded** — added Items 34/35/36 to [todo.md](todo.md) to make multi-client work seamless: `qb_company_open` (switch active `.qbw` at runtime), `qb_company_list` (discover files under `QB_COMPANY_ROOT`), and a Vitest file for the switching flow. Operator's clients all live in one folder on a local file server; they must be navigable in a single chat session without restarting the server.
- **F13 added to [REQUIREMENTS.md](REQUIREMENTS.md)** — sequential multi-company workflow is now an explicit product promise (4 sub-requirements). Concurrent multi-file remains out of scope (QB Desktop only allows one open file per instance anyway).

## Verify Before Continuing

- [ ] **Build.** `npm run build` exits 0.
- [ ] **Vitest suite.** `npm test` → `Test Files 5 passed | Tests 178 passed`. Counts: 27 + 44 + 47 + 40 + 20.
- [ ] **dist smoke-test.** `node dist/index.js </dev/null` exits 0 and prints `Mode: simulation` in the banner.

(The 5 `.mjs` harnesses under `scripts/verify-*.mjs` are still green from the prior session; re-run if you suspect drift.)

## Next Task

**Phase 7, Item 1** — still the gating task. Items 34–36 are meaningless until live mode works (and they're best implemented in the same Windows session that proves out the COM connection, so `qb_company_open` can be exercised against real `.qbw` files immediately).

- [ ] **1.** Implement live `QBXMLRP2` COM connection in [src/session/manager.ts](src/session/manager.ts) (add `winax` / `node-activex` dep, replace throws in `openSession` / `sendRequest` with real `OpenConnection2` / `BeginSession` / `ProcessRequest` / `EndSession` / `CloseConnection` calls, wire `parseQBXMLResponse` for live responses).

After Item 1, in this order:

- [ ] **34.** `qb_company_open` tool — close active session, swap `companyFile`, open new session. Sim mode resets `SimulationStore` to fresh seed (deliberate sim-fidelity tradeoff — record in [DECISIONS.md](DECISIONS.md) when implementing).
- [ ] **35.** `qb_company_list` tool — enumerate `*.qbw` under `QB_COMPANY_ROOT` (default = dirname of `QB_COMPANY_FILE`). Pure FS op; identical in live and sim.
- [ ] **36.** `tests/company-switching.test.ts` — Vitest coverage for switching + listing.

## Context Notes

- **Item 1 — Windows-only.** Cannot be marked complete without exercising on a real Windows + QB Desktop box. If developed off-platform, leave `partial` here with verification steps. Record `winax` vs `node-activex` choice in [DECISIONS.md](DECISIONS.md) before installing.
- **Item 1 — wiring points.** `openSession` (currently throws) at [src/session/manager.ts:99-107](src/session/manager.ts#L99-L107). `sendRequest` live branch at [src/session/manager.ts:150-153](src/session/manager.ts#L150-L153). `closeSession` live no-op at [src/session/manager.ts:117-120](src/session/manager.ts#L117-L120). `parseQBXMLResponse` is already imported and ready for the live response path. The `simulationMode` branch is the contract live mode must match.
- **Item 34 — design hint.** `QBSessionManager.config` is private but the manager is a singleton owned by the lazy `getSessionManager()` factory in [src/index.ts:123-130](src/index.ts#L123-L130). Cleanest implementation: add a public `switchCompanyFile(path: string)` method on `QBSessionManager` that calls `closeSession()`, mutates `this.config.companyFile`, calls `new SimulationStore()` if `simulationMode`, then `openSession()`. Tools call that — they never touch config directly.
- **Item 35 — env semantics.** Add `QB_COMPANY_ROOT` to the `.env.example` and document in README env table. Default fallback should be `path.dirname(config.companyFile)` so existing single-file users get a usable default.
- **Item 36 — switching resets sim state is INTENTIONAL.** Real QB persists per-file; sim doesn't. Document this as a known sim-fidelity gap in [DECISIONS.md](DECISIONS.md) when Item 34 lands, and add a note to F13 in [REQUIREMENTS.md](REQUIREMENTS.md) if behavior diverges further.
- **Multi-file is sequential, not concurrent.** QB Desktop only allows one file open per instance. Don't try to support multiple simultaneous sessions — the QBXMLRP2 SDK will reject it, and [REQUIREMENTS.md](REQUIREMENTS.md) F13.4 codifies the sequential constraint.
- **Test setup gotcha (carried).** `session.addEntity("Customer", data)` takes FLAT entity fields (`{ Name: "X", Phone: "Y" }`), NOT `{ CustomerAdd: { Name: "X" } }`. The builder wraps in `<CustomerAdd>` automatically.
- **Vitest setup pattern (carried).** Tests import from `src/` directly using `.js` extensions. Vitest's resolver handles `./manager.js` → `./manager.ts`. fakeServer pattern at [tests/iterator.test.ts:33-50](tests/iterator.test.ts#L33-L50). Use `newSession()` per-test for isolation.
- **Item 27 wire names diverge (carried).** Requests use `iterator` (lowercase, no I) + `iteratorID`; responses use `iteratorRemainingCount` + `iteratorID`. Live mode must surface these correctly.
- **Pre-flight validation blocks (carried).** Tools like [src/tools/invoices.ts:131-142](src/tools/invoices.ts#L131-L142) produce `{ success: false, error: "..." }` (NOT canonical Item 25 `{ statusCode, statusMessage }`). Intentional — cross-field validation, not QB-side errors.
- **Bills use `AmountDue`, NOT `BalanceRemaining` (carried).**
