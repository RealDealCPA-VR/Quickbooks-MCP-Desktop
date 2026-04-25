# Regression Checklist

Run before marking any task complete. Catches silent breakage in adjacent code.

This is the floor, not the ceiling. Task-specific verification lives in `ACCEPTANCE_CRITERIA.md` per task — those run *in addition to* this checklist.

If a check is genuinely irrelevant to the change you made (e.g. you only edited a markdown file), you may skip it — but state which checks you skipped and why in the handoff.

---

## How to Run

For a typical implementation task touching `src/`:

1. Work top-to-bottom through the sections.
2. Stop at the first failure, fix it, then restart from the top.
3. When all relevant sections pass, the task is verified at the regression layer.
4. Then run that task's specific acceptance criteria from `ACCEPTANCE_CRITERIA.md`.

Estimated total time when nothing is broken: 3–5 minutes.

---

## 1. Build / Compile

- [ ] `npm run build` exits with code 0.
- [ ] No new TypeScript errors in the output (warnings allowed but should be deliberate).
- [ ] No missing `.js` extensions on relative imports (Node16 ESM enforces this — TS will error if you forget).
- [ ] `dist/index.js` exists and is non-empty after the build.

## 2. Server Startup

- [ ] `npm run dev` boots without throwing.
- [ ] The simulation banner prints to stderr in the expected mode:
  - On non-Windows or without `QB_LIVE=1`: `[QB Session] Running in simulation mode`
  - On Windows with `QB_LIVE=1`: live-mode banner (or known-stub error until Phase 7 lands).
- [ ] `console.error` startup lines print: company file, app name, QBXML version, mode.
- [ ] Server stays running until Ctrl+C (does not exit immediately).

## 3. Tool Surface

For each tool changed in this task:

- [ ] Tool appears in the MCP server's tool list (verify by listing tools through any MCP client, or by issuing a `tools/list` JSON-RPC call directly to stdio).
- [ ] Tool's input schema matches its handler signature (zod fields exposed, all `.describe()` set).
- [ ] Happy path: tool returns a structured success response (`content[0].text` parses as JSON, no `isError: true`).
- [ ] Error path: at least one invalid input returns `isError: true` with a useful `error` message (not a raw stack trace).
- [ ] If the tool was renamed or added: [src/index.ts](src/index.ts) `instructions` block updated AND README tool table updated.

For tools NOT changed in this task (regression sample):

- [ ] `qb_company_info` returns a sensible response.
- [ ] `qb_customer_list` returns at least the seeded customers.
- [ ] `qb_account_list` returns the seeded chart of accounts.
- [ ] One transaction tool (`qb_invoice_list` or `qb_bill_list`) returns the seeded transactions.

## 4. QBXML Round-Trip

If you touched [src/qbxml/builder.ts](src/qbxml/builder.ts) or [src/qbxml/parser.ts](src/qbxml/parser.ts):

- [ ] Requests built by `buildQueryRequest` / `buildAddRequest` / `buildModRequest` / `buildDeleteRequest` are valid XML (well-formed).
- [ ] A response containing a single `*Ret` element comes back from the parser as a single-element array, NOT a bare object — for every `*Ret` registered in `arrayElements`.
- [ ] A response containing multiple `*Ret` elements comes back as an array of equal length.
- [ ] Status codes 0 (success), 1 (no matches), 3xxx (validation errors), 5xx (not found) are all surfaced correctly via `extractResponseData`.

If you added a new entity type:

- [ ] Its `*Ret` element name is registered in `arrayElements` in [src/qbxml/parser.ts:27-61](src/qbxml/parser.ts#L27-L61).
- [ ] If it's a transaction, it's added to all three `isTransaction` arrays (builder, manager, simulation-store) — see Invariant #5 in `ARCHITECTURE.md`.

## 5. Simulation Store

- [ ] Seed data still loads on store construction (3 customers, 2 vendors, 10 accounts, 3 items, 2 invoices at minimum).
- [ ] CRUD on every entity touched by this task works end-to-end:
  - Create → response includes a generated `ListID` or `TxnID`.
  - List → newly created entity appears in results.
  - Update (if applicable) → `EditSequence` changes, `TimeModified` updates.
  - Delete → entity disappears from subsequent list calls.
- [ ] **Filters that were supposed to apply, apply.** No silent return-everything. Specifically:
  - `ListID` / `TxnID` filter returns only the matching record.
  - `NameFilter.Contains` returns only matching names.
  - `ActiveStatus: "ActiveOnly"` excludes inactive records.
  - For transactions: `EntityFilter` (customer/vendor), `TxnDateRangeFilter`, `PaidStatus`, `RefNumber` all narrow results correctly. _(Note: until Phase 1 item 15 lands, these last four are knowingly broken — flag in handoff if so.)_
- [ ] No mutation leaks across stores (e.g. adding a Customer does not appear in the Vendor list).

## 6. Mode Boundary

- [ ] You did not call `simulationStore` directly from a tool. Tools go through `session.queryEntity` / `addEntity` / etc.
- [ ] You did not put live-mode logic inside `simulationStore` or vice versa.
- [ ] The mode boolean is read once in the session manager constructor, not re-read inside request handling.

## 7. Convention Compliance

- [ ] New tool files live in `src/tools/<domain>.ts` with a single `register<Domain>Tools(server, getSession)` export.
- [ ] New zod schema fields all have `.describe()`.
- [ ] Tool handler return shape matches existing tools — `{ content: [{ type: "text" as const, text: JSON.stringify(...) }] }`, with `isError: true` on failure.
- [ ] No emojis added to code, comments, or markdown unless explicitly requested.
- [ ] No comments explaining WHAT the code does — only WHY where non-obvious.
- [ ] No backwards-compat shims, removed-code comments, or "for backwards compatibility" hacks added.

## 8. Documentation Sync

- [ ] If a tool was added/renamed/removed: README tool table updated.
- [ ] If a tool was added/renamed/removed: `instructions` block in [src/index.ts](src/index.ts) updated.
- [ ] If a structural rule changed: `ARCHITECTURE.md` updated.
- [ ] If a meaningful tradeoff was made: new entry in `DECISIONS.md`.
- [ ] If product behavior changed: `REQUIREMENTS.md` updated.

## 9. Handoff Readiness

- [ ] `todo.md` reflects current state truthfully — checked items are FULLY working, partial work is left unchecked.
- [ ] `HANDOFF.md` is updated with: Last Session Summary, Verify Before Continuing, Next Task, Context Notes.
- [ ] Anything broken or partial is explicitly called out in `HANDOFF.md` so the next session does not assume it works.

---

## When Live Mode Is Involved (Phase 7)

Once Phase 7 (live COM connection) is in progress, add these checks:

- [ ] On a Windows + QB Desktop machine, `QB_LIVE=1 npm start` connects without throwing.
- [ ] `qb_session_connect` returns a real ticket (not a `SIM-` prefix).
- [ ] `qb_company_info` returns the actual company file's metadata.
- [ ] At least one read tool (`qb_customer_list`) returns real data from the company file.
- [ ] At least one write tool (`qb_customer_add`) creates a record visible in the QuickBooks Desktop UI.
- [ ] Session disconnect cleanly releases the QB connection (no zombie processes, QB UI remains responsive).
- [ ] On non-Windows machines, the same code still simulates correctly — no regression in the cross-platform story.

---

## When Tests Exist (Phase 8 item 31)

Once Vitest is set up, add at the top:

- [ ] `npm test` passes.
- [ ] Coverage on changed files is non-zero (we don't enforce a percentage, but every changed file should have at least one test exercising it).
