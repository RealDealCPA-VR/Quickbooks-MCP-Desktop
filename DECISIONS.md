# Decisions Log

Record meaningful technical decisions here. Append new entries at the top. Each entry answers: **what was chosen**, **why**, **alternatives rejected**, **tradeoffs**.

Skip trivial choices. Log when a future session would otherwise re-debate the same point, when a structural pattern was rejected, or when a constraint forced an unusual approach.

---

## Template

```markdown
## YYYY-MM-DD — <Short title>

**Chosen:** <what was decided>

**Why:** <reasoning, including the constraint or evidence that drove it>

**Alternatives rejected:**
- <option> — <why not>
- <option> — <why not>

**Tradeoffs / consequences:**
- <what we now have to live with>
- <what becomes harder>
- <what becomes easier>

**Revisit when:** <condition that should trigger reconsidering, or "no scheduled revisit">
```

---

## 2026-05-09 — Company switching reseeds the simulation store

**Chosen:** `QBSessionManager.switchCompanyFile(path)` (driving `qb_company_open`) ALWAYS instantiates a fresh `SimulationStore` when running in simulation mode, even when the new path matches a previously-opened path. Mutations made against company A while the sim was active are unrecoverable once the session switches to B and back to A.

**Why:** Real QuickBooks Desktop persists each company's books to its own `.qbw` file on disk — switching between files preserves whatever state was last saved. The simulation has no persistence layer; it's a single in-memory `Map<entityType, Map<id, entity>>` per `SimulationStore` instance. The only behaviorally honest option is to scope the store to "the conversation since last open" and accept that switching loses the prior content. The alternative — keeping a per-path Map of stores in memory — would diverge from real QB in a different way (real QB doesn't keep two files open; sim would). Both are tradeoffs; the reseed is the simpler one and the closer match to "open a different book, see that book's state."

The observational contract holds across modes: in live the operator sees the new file's actual saved state; in sim they see a fresh seed. Different specifics, same shape.

**Alternatives rejected:**
- *Per-path simulation stores cached in a Map.* Closer to "you can switch back and pick up where you left off," but creates two divergences from real QB: (a) two files appear simultaneously open in memory which QBXMLRP2 forbids, (b) the operator's mental model "I switched away — the prior session is over" is broken silently. Also leaks memory across long-lived sessions.
- *Persist the simulation store to disk per path.* Would mirror real QB more faithfully but introduces a data-format we'd have to migrate over time. Not worth it for a dev tool.
- *Refuse to switch in simulation.* Throws away the discovery workflow that Item 35 (`qb_company_list`) is designed for. The agent needs to be able to demonstrate switching even without a Windows box.

**Tradeoffs / consequences:**
- The `qb_company_open` response carries `simulationStoreReset: true` in sim mode so the LLM can observe the discontinuity and re-list entities rather than carrying stale references across the boundary.
- Tests in [tests/company-switching.test.ts](tests/company-switching.test.ts) pin the reseed contract: A → mutate → B → A returns A's fresh seed, NOT the prior mutations. Any future change toward per-path persistence would need to update that test deliberately.
- Live mode is unaffected — live always reads real QB state.

**Revisit when:** Adding any persistence layer to the simulation (e.g. snapshot-and-restore for fixture-driven tests). At that point the per-path cache could carry mutations across switches without diverging from real QB further than the persistence layer already does.

---

## 2026-05-09 — Insert filter children in QBXML schema-sequence order

**Chosen:** Every `*QueryRq` filter dict must be populated in the order Intuit's `qbxmlops*.xml` schema declares its children. The canonical order for the standard list-tool filter group is `ListID/FullName → MaxReturned → ActiveStatus → FromModifiedDate → ToModifiedDate → NameFilter → (type-specific tail e.g. AccountType / TotalBalanceFilter / ClassFilter)`. Each affected tool now opens with a comment pointing back at this rule.

**Why:** [src/qbxml/builder.ts](src/qbxml/builder.ts)'s `serializeBody` walks `Object.entries(body)`, which preserves JS string-key insertion order. QB's QBXML parser strictly enforces XSD `<xs:sequence>` ordering — out-of-order children produce the cryptic, untyped error `QuickBooks found an error when parsing the provided XML text stream` (no statusCode, no field hint). Live exercise on 2026-05-09 caught `qb_customer_list`, `qb_vendor_list`, `qb_item_list` failing with that error when called with `maxReturned: 5`; once we re-ordered insertion the exact same payload returned real records. The same wrong-order pattern was latent in `qb_employee_list`, `qb_account_list`, and the six `qb_*_list` tools in [src/tools/lists.ts](src/tools/lists.ts) — all now corrected defensively.

**Why simulation didn't catch it:** [src/session/simulation-store.ts](src/session/simulation-store.ts)'s `handleQuery` reads the filter dict directly (`filters.NameFilter`, `filters.MaxReturned`, etc.) and never re-serializes through the QBXML builder, so insertion order has no observable effect in sim. This is why all 178 simulation tests pass against the broken code. A regression test that exercises the *XML* (`buildQueryRequest("Customer", filters)` then asserts the order of children in the emitted string) would have caught this — worth adding as future test coverage.

**Alternatives rejected:**
- *Sort filters into schema order inside the builder.* Would centralize the rule, but each request type has a different schema sequence (CustomerQueryRq differs from InvoiceQueryRq differs from AccountQueryRq) and the builder is currently entity-agnostic. Encoding per-type ordering tables in the builder would push schema knowledge into the wrong layer and be brittle as we add new request types. Cheaper to keep the rule at the tool layer where the filter dict is constructed.
- *Switch to a Map-based filter object.* Same insertion-order semantics as objects in modern V8 (objects already preserve string-key order). No improvement.

**Tradeoffs / consequences:**
- Tool authors must remember to follow XSD order when adding filters. The opening comment in each `*_list` tool documents the canonical order.
- The transaction list tools were fixed in the same session under the same rule — `qb_invoice_list`, `qb_bill_list`, `qb_estimate_list`, `qb_sales_receipt_list`, `qb_credit_memo_list`, `qb_purchase_order_list`, `qb_journal_entry_list`, `qb_payment_list`, `qb_bill_payment_list`. Canonical sequence for transaction queries: `TxnID/RefNumber selectors → MaxReturned → ModifiedDateRangeFilter → TxnDateRangeFilter → EntityFilter → AccountFilter → RefNumberFilter → CurrencyFilter → PaidStatus`. Verified against live QB via [scripts/exercise-mcp-live.mjs](scripts/exercise-mcp-live.mjs) with multi-filter probes — 20/20 green, including `DateRange + PaidStatus + MaxReturned` combos.

**Revisit when:** Adding a new `*_list` tool, or once we add a builder-level XSD-order assertion that surfaces the rule statically.

---

## 2026-05-05 — Pin Node 20 LTS for live mode (winax prebuild gap on Node 22+)

**Chosen:** Live-mode environments must run Node **20 LTS**, not the current Node LTS that `winget install OpenJS.NodeJS.LTS` returns. [scripts/setup-qb-pc.ps1](scripts/setup-qb-pc.ps1) installs nvm-windows + Node 20 if any other major version is detected, and a [.nvmrc](.nvmrc) at the repo root pins the project to Node 20.

**Why:** `winax` ships prebuilt `.node` binaries for `{node-v115-win32-x64}` (Node 20 ABI). It does **not** ship prebuilds for Node 22+, so `npm install` falls through to `node-gyp rebuild`, which compiles the bridge's C++ against the host's V8 headers. winax 3.4.x–3.6.9 use V8 API symbols (`PropertyCallbackInfo<void>::HolderV2`) that exist in V8's main-line but are not yet present in Node 22.17.0's V8 12.x — every recent winax version fails compile with `'HolderV2' : is not a member of any direct or indirect base class of 'v8::PropertyCallbackInfo<void>'`. On Node 20 `npm install` skips the compile entirely and uses the prebuilt; on Node 22+ there's no path to a working build today.

The original setup script asked winget for "the LTS" without pinning a major version. When the office PC was provisioned, that resolved to Node 20; when the dev PC was provisioned later, it resolved to Node 22 — silent regression, identical script run, different outcome. Pinning Node 20 explicitly closes that gap.

**Alternatives rejected:**
- **Stay on Node 22; replace `winax` with a PowerShell child-process bridge.** Version-agnostic, no native deps. Rejected as the default because it adds 20–50ms latency per QBXML round-trip (long-running PS host with stdin/stdout, not per-request spawn) and a second failure-mode surface (PS host crash recovery, JSON-over-stdio framing). Worth revisiting if `winax` development stalls long-term — the bridge is the durable answer to "what if winax stops keeping up with V8."
- **Stay on Node 22; pin a specific older `winax` version that built historically.** Tried 3.4.2 (and 3.6.9, the current); both fail with the same V8 ABI error against Node 22.17.0. winax never had a Node-22-ABI-compatible release on npm.
- **Stay on Node 22; fork `winax` and patch the V8 calls.** Brittle — V8 is moving; we'd own the maintenance load. Not worth it for one COM call surface.
- **Allow both Node 20 and Node 22; let users pick.** Tested simulation works on either, but live mode silently breaks on 22. Operators don't read errors carefully enough — the failure mode (`Cannot find package 'winax'` from a lazy import after `npm install` silently skipped extraction via `ideallyInert`) is too easy to misread as a code bug. Better to enforce one supported version.

**Tradeoffs / consequences:**
- Setup script grows a Node-version-check + nvm-windows install path. Runtime: ~30s extra on a fresh box, idempotent on re-runs (it skips both if Node 20 is already active).
- Operators must `nvm use 20` in any new shell where they want to run this project. Mitigated by `nvm alias default 20` (which the script does after install) and by [.nvmrc](.nvmrc) for tooling that honors it.
- Downstream: anyone who pulls this repo on a fresh Windows PC and has Node 18 or 22+ already installed for other projects will get an nvm install on top. nvm-windows is non-destructive (it doesn't remove existing Node), so other projects keep working — the user just has to remember to switch.
- Node 20 LTS is supported until **April 2026**. Plenty of runway; we'll need to revisit before then unless winax catches up.

**Revisit when:**
- `winax` publishes prebuilt binaries for Node 22 win-x64 (`{node-v127-win32-x64}` or higher). At that point the Node 20 pin can drop.
- OR Node 20 reaches end-of-life (April 2026). At that point we either move to whatever Node version winax supports, or replace winax with the PS-bridge alternative.

---

## 2026-05-05 — `winax` for QBXMLRP2 COM bindings (over `node-activex`)

**Chosen:** Add `winax` (^3.x) as a runtime dependency. Live mode in [session/manager.ts](src/session/manager.ts) uses `new (await import("winax")).Object("QBXMLRP2.RequestProcessor")` to instantiate the COM object, then drives `OpenConnection2` / `BeginSession` / `ProcessRequest` / `EndSession` / `CloseConnection`. The import is lazy (only invoked in the live `openSession` branch) so simulation mode and non-Windows platforms never load it.

**Why:** `winax` is the actively-maintained Node ↔ Windows COM bridge in 2025-2026. It supports modern Node (22+), 64-bit ActiveX, native ESM, and ships TypeScript-compatible builds. The QuickBooks SDK exposes `QBXMLRP2.RequestProcessor` as an in-proc COM server; any Node-side bridge must call into it via `new ActiveXObject(...)` and dispatch member calls — which is exactly what `winax`'s `Object` helper does. Lazy `await import()` keeps the dependency a runtime concern only on Windows + live mode; the simulation path and macOS/Linux dev paths never resolve it. A small `src/types/winax.d.ts` shim declares the module so `tsc` can compile before `npm install` has compiled the native binding (the user's first `npm install` after pulling fresh and the setup script's bootstrap both need this).

**Alternatives rejected:**
- **`node-activex`.** Functionally equivalent API but stale: last meaningful release in early 2017, no Node 18+ binaries published, GitHub issues open for 4+ years on x64 / ESM / electron compatibility. Even if it worked today, every future Node upgrade would be a coin flip.
- **`edge-js` + an inline C# host.** Would let us call the QB SDK's higher-level QBFC library, which is friendlier than raw QBXML. But it pulls in a CLR runtime, complicates the install (Mono/.NET dep on the user's box), and the project has already committed to QBXML strings as the wire format. Invariant #2 in [ARCHITECTURE.md](ARCHITECTURE.md) ("simulation and live must be observationally identical") wants the same QBXML round-tripping the simulation already does — moving to QBFC objects breaks that.
- **Spawn a PowerShell/`cscript` child process per request.** Avoids the native dep entirely. Rejected: per-request process spawn cost (50-150ms each), no way to hold a persistent `BeginSession` ticket across calls without keeping the child alive (which just reinvents the COM-bridge problem in a slower, harder-to-debug shape), and each spawn risks tripping QB's per-app session limits.
- **Run a separate Windows-only `qb-bridge` service over a local socket.** Cleanest in theory (decouples the MCP server from native deps; the bridge could be C# / VB6 / anything Intuit's docs use). Rejected for this single-user personal tool — adds an installer, a service to manage, and a second failure-mode surface for what amounts to one COM call wrapped in error handling.

**Tradeoffs / consequences:**
- `npm install` on Windows now requires Python 3 + VS 2022 Build Tools (C++ workload) to compile `winax`'s native binding. [scripts/setup-qb-pc.ps1](scripts/setup-qb-pc.ps1) installs both before running `npm install`, so first-time setup is one-shot.
- macOS/Linux `npm install` is fine because `winax` is OS-skipped at install (it ships a no-op binary stub for non-win32). The simulation-mode dev story stays cross-platform — that's verified by the lazy `await import()` pattern: `import` only happens inside the live branch of `openSession`.
- `tsc` needs the type shim at [src/types/winax.d.ts](src/types/winax.d.ts) because `winax`'s own typings don't ship in a way TypeScript's `Node16` resolver picks up cleanly. The shim declares only the surface we use (`Object` constructor that returns a dispatch-style object).
- `winax`'s upstream is small but active. If it goes unmaintained, the migration target is most likely a `qb-bridge` sidecar — a roughly day-long swap that touches only `manager.ts`'s live branch.
- Dropping the `Sample Company.qbw` default in [src/index.ts:65](src/index.ts#L65) — empty `QB_COMPANY_FILE` now means "use whatever company file QuickBooks Desktop currently has open." The QB SDK accepts `""` for `BeginSession`'s file argument and treats it as "current open file." That's the better UX for a tool that's most often used while the operator is already in QB; the prior fallback was a phantom default that pointed at a path that may not exist.

**Revisit when:** `winax` releases stop or a Node major version (24+) breaks the binding. Or when a non-Windows live path becomes interesting (QuickBooks Online MCP would be a separate server, not a re-platform of this one).

---

## 2026-04-27 — Vitest for the test harness; keep env-matrix as a standalone `.mjs` script

**Chosen:** `vitest@^4` is the test framework. Tests live in `tests/*.test.ts`, import directly from `src/*.ts` (Vitest's Vite-based resolver handles the `.js`-extension imports the project uses for Node16 ESM), and run via `npm test` → `vitest run`. The five new Vitest files port four of the five existing `scripts/verify-*.mjs` harnesses (`item25-error-shape`, `item27-iterator`, `item29-input-validation`, plus two new `qbxml-roundtrip` and `simulation-store` files). The fifth harness — `verify-item23-env-matrix.mjs` — stays as a standalone `node` script invoked from CI / the regression checklist, NOT inside Vitest.

**Why:** Phase 8 Item 31 in `todo.md` requires a Vitest test directory covering builder→parser round-trips, simulation-store CRUD, filter handling, and tool integration. Vitest is the de-facto modern Node test runner for ESM TypeScript projects; it has zero-config TypeScript transform, native ESM, snapshot support, and `--coverage`. The `verify-item23-env-matrix.mjs` script tests environment-variable behavior across `process.platform` values, which it does by spawning child Node processes with mocked `platform` argv — porting that to Vitest would require either `vi.mock("node:os")` / `vi.stubGlobal("process")` patterns that don't reach the CommonJS-imported `os.platform()` call, or extracting the platform check into an injectable interface (which would be a refactor, not a port). Running it as a standalone subprocess driver is the same shape it already has.

**Alternatives rejected:**
- **Jest.** Heavier ESM story (still requires `node --experimental-vm-modules` or a Babel transform), slower cold start, and no native `.ts` execution without `ts-jest` or `@swc/jest`. Vitest does it natively.
- **`node --test` (the built-in runner).** Works for plain `.mjs` and is dependency-free, but doesn't transform TypeScript without a separate `--loader` (e.g. `tsx`). Mixing `tsx` + `node --test` reproduces what Vitest gives us out of the box, with worse error messages and no watch mode.
- **Mocha + Chai.** Mature but requires picking a TS executor (ts-node, tsx, swc) and an assertion library — adds two-to-three deps where Vitest is one. No tangible benefit for this project's scale.
- **Port `verify-item23-env-matrix.mjs` into Vitest with `vi.stubEnv` + `vi.spyOn(process, "platform")`.** Considered but rejected: the platform check happens during module evaluation in `session/manager.ts` (env-driven branch picked at construction time), so a clean port would require either re-importing the module per test (using `vi.resetModules()` plus dynamic `import()`) or refactoring the check into an injectable. The standalone subprocess script already does this correctly via real child processes — no behavioral fidelity is gained by porting.

**Tradeoffs / consequences:**
- One new dev dep (`vitest`) and its 73 transitive deps. `package.json` `devDependencies` only — never reaches production install.
- Tests now run in two places: `npm test` for the main suite, plus `node scripts/verify-item23-env-matrix.mjs` separately. Both must pass for a session to claim "all green." The handoff verification checklist already lists both.
- Existing `scripts/verify-*.mjs` files are kept after the port (they import from `dist/` and verify the built output, while Vitest imports from `src/` and verifies the source). When a future change breaks the build but leaves source consistent, the `.mjs` harnesses catch it; when source drifts but the dist hasn't been rebuilt, Vitest catches it. They're complementary, not redundant.
- Vitest config is intentionally minimal — no `vitest.config.ts` file. The default `test/` glob and Node ESM behavior are sufficient. Add a config file only if we need to set up `coverage`, `setupFiles`, or non-default test pools.

**Revisit when:** A workflow emerges that the standalone `.mjs` harnesses can't cover (e.g. coverage reporting, parallel test sharding, snapshot testing of XML output) — at that point, drop the `.mjs` files and centralize in Vitest. Or when the test suite grows past ~5 files and a `vitest.config.ts` becomes necessary for organization.

---

## 2026-04-26 — `EditSequence` carries a monotonic counter, not a pure ISO timestamp

**Chosen:** The simulation generates `EditSequence` via a new `nextEditSequence()` helper that returns `${new Date().toISOString()}-${counter++}`. The counter is the same `idCounter` field used by `nextId()`, so `EditSequence` is guaranteed to rotate to a unique value on every `handleAdd` and `handleMod`, even when calls land in the same millisecond.

**Why:** The previous implementation set `EditSequence: new Date().toISOString()` directly. On fast hardware (or in inline verification scripts), an entity created at T0 and modified at T0 + <1ms produced two ISO strings that compared equal. The strict-EditSequence check added on 2026-04-25 then accepted the "old" sequence as still-current and the stale-sequence rejection (statusCode 3170) silently broke. Caught by the HANDOFF.md verification script for Phase 3 Item 7 — checks 2b / 3a / 3b / 3c failed because both sides of the comparison were the same millisecond stamp.

**Alternatives rejected:**
- **Use `process.hrtime.bigint()` for sub-ms resolution.** Works but produces opaque numbers that don't help debugging. The ISO+counter form keeps human-readable timestamps in the data while guaranteeing uniqueness.
- **Sleep 1ms in tests / verification scripts.** Pushes the workaround into every caller, doesn't fix the underlying simulation bug, and would re-surface the moment two tools chain mods server-side.
- **Hash of (timestamp + entity contents).** Overkill — the only invariant we need is "every successful mod yields a sequence value that does not equal any prior one for that entity." A monotonic counter delivers that with one shared field.

**Tradeoffs / consequences:**
- `EditSequence` is no longer a pure ISO timestamp. Any future code that pattern-matches on the format (e.g. tries to parse it back to a `Date`) will break. None exists today; all tools round-trip it as an opaque string.
- Sequence is still sortable lexically because the ISO timestamp prefix dominates ordering and the counter is monotonically increasing within a single process. Cross-process ordering is meaningless either way (simulation has no persistence).
- Live mode (Phase 7) will inherit whatever real QB returns — no impact, since the simulation's format is internal.

**Revisit when:** No scheduled revisit. If the seed-data fields (lines 1059-1118 of simulation-store.ts) ever participate in mod paths and need rotating sequences, route them through `nextEditSequence()` too — currently they use a fixed `now` snapshot which is fine because seed records are query-only.

---

## 2026-04-25 — Strict EditSequence validation in simulation `handleMod`

**Chosen:** When any `*ModRq` request includes `EditSequence` and the value does not match the entity's currently-stored `EditSequence`, the simulation rejects with statusCode 3170 ("the given object's EditSequence does not match"). The check is global to `handleMod` and applies to every `*_update` tool, not just `qb_bill_update`.

**Why:** Real QB enforces optimistic-concurrency control via `EditSequence`. Stale-sequence requests fail with 3170. The simulation previously accepted any value (or no value), spread `modData` over the existing entity, and bumped `EditSequence` to a fresh timestamp. That meant "passes in dev, rejects in live" was a guaranteed class of bug for any tool that fetched an entity, sat on it, and then submitted a mod against a now-stale sequence.

The fix is three lines in `handleMod` and applies globally because every existing update tool already requires `editSequence` in its zod schema and passes it on the request. There are no callers that rely on the old lax behavior.

**Alternatives rejected:**
- **Per-tool opt-in (e.g. only Bill checks it).** Inconsistent — every tool would eventually need it as Phase 7 lands. Centralizing in `handleMod` is cheaper and avoids drift.
- **Document the gap, defer to Phase 7.** Defensible, but the risk is that a Phase 3+ tool quietly relies on stale-sequence permissiveness without anyone noticing until live mode breaks it. Catching it now in dev is cheaper than catching it later in live.
- **Validate but warn instead of reject.** Adds a "warnings" channel that doesn't exist anywhere else in the codebase, and doesn't match real QB.

**Tradeoffs / consequences:**
- Any existing test or workflow that re-uses an old `EditSequence` across multiple mods will now fail. Update flows must read the freshest `EditSequence` from the previous response (or a fresh query). Every tool today already returns the entity post-mod with the new `EditSequence`, so the migration is mechanical.
- Mod responses from the simulation now match live more closely — a 3170 path is exercisable in dev.
- Phase 7 (live mode) inherits the same invariant on the live path automatically — the simulation isn't pretending anymore.

**Revisit when:** Live mode lands and the real-QB error code or message text differs noticeably from the simulation's stub. At that point the simulation's status message should be updated to match what live actually returns.

---

## 2026-04-25 — Bill line-mod uses wholesale replacement with merge-by-TxnLineID

**Chosen:** `qb_bill_update` accepts `expenseLines` / `itemLines` arrays. When provided, each array REPLACES the bill's existing `ExpenseLineRet` / `ItemLineRet` wholesale — lines not present in the mod array are dropped. Each entry can optionally carry `txnLineID`: if it matches an existing line, the mod's fields are merged over that line and the original `TxnLineID` is preserved; otherwise (or with `'-1'`) the entry is treated as a brand-new line and gets a freshly-generated `TxnLineID`. After lines change, `AmountDue` recomputes via `computeTotals` and the vendor's `Balance` is adjusted by the signed delta.

**Why:** Real QB's `*LineMod` blocks support per-line modify-or-add semantics: each block carries a `TxnLineID` (or `'-1'` for new), and lines NOT in the request are deleted. Mirroring this exactly with a true diff (modify only the named fields, preserve everything else, support standalone "delete this line" blocks) would significantly complicate the simulation's `handleMod` and require a new `*LineDel` shape. The wholesale-replace-with-merge approach captures the practical operator workflow ("here's what the bill should look like after my edit") with simpler code: `{...existingLine, ...modLine}` per matched line, generate a fresh ID for the rest.

The merge-by-TxnLineID part (rather than pure wholesale replace with no merge) is what gives the operator a usable "change just one field" UX. Without it, a memo edit on one line of a 10-line bill would force the operator to reconstruct all 10 lines. With it, they pass `[{txnLineID: 'L1', memo: 'new'}]` and every other line on the bill is dropped — but the modified line preserves its account, amount, and other fields from the existing record.

**Alternatives rejected:**
- **Pure wholesale replace, no merge.** Forces the operator to re-supply every field on every modified line. Ugly UX for the most common workflow (small partial mods). The simpler simulation isn't worth the operator-side cost.
- **True per-line diff with `*LineDel` blocks.** Faithful to real QB but adds a third request shape (`*LineDel`) and more dispatch logic. Overkill for a personal tool. Document the gap and revisit if a workflow surfaces that genuinely needs to keep N-1 lines while explicitly deleting only one.
- **Tool-side pre-compute of `Amount` for item lines (matching `qb_bill_create`).** Considered but rejected for the Mod path because a partial mod ("change just qty on existing line L1") doesn't have `cost` available without a query round-trip; letting the simulation re-derive `Amount = Quantity * Cost` from the merged line is cleaner. The Add path keeps its tool-side computation since the create schema already requires both fields.

**Tradeoffs / consequences:**
- "Drop all lines but keep one" requires the operator to send `expenseLines: [{txnLineID: 'L_keep'}]`. They cannot say "delete line L_drop" in isolation. Acceptable because (a) bills typically have few lines and (b) the operator usually has the full line list in context anyway from a prior `qb_bill_list`.
- Operator-supplied `TxnLineID` values that don't match any existing line are treated as new lines (the simulation falls back to a fresh ID). Real QB would likely reject. Recording as a known fidelity gap.
- A line whose `TxnLineID` is `'-1'` is always treated as new. Operators must NOT pass `'-1'` for an existing line — that would lose the original `TxnLineID` and create a duplicate.
- The same `applyLineMods` helper is generic across `*LineMod` keys, so Phase 3 item 6 (`qb_invoice_update` line mod) inherits the same semantics for free. The only Item-6-specific work is recomputing `Subtotal` / `BalanceRemaining` and adjusting the customer's `Balance` by the signed delta — both already have machinery from prior items.
- Vendor-change support: if a Bill mod re-points the bill at a different vendor (`vendorName` or `vendorListId` differs from the existing ref), the old vendor's balance is reversed by the OLD `AmountDue` and the new vendor's balance is bumped by the NEW `AmountDue`. Same vendor → signed delta only. Mirrors real QB behavior.

**Revisit when:** A workflow surfaces where the operator needs to delete a single line by ID without re-listing all the lines they want to keep. At that point, add `*LineDel` block support to the schema and a delete-then-merge pass to `applyLineMods`.

---

## 2026-04-25 — Strict TxnID validation in `qb_payment_receive` AppliedToTxnAdd

**Chosen:** When `qb_payment_receive` is called with `appliedTo: [{txnId, ...}]` and any `txnId` does not match an existing invoice in the simulation store, the entire payment is rejected with `isError: true` and statusCode 500. No invoice is mutated, no payment record is stored, and the error message names the bad `txnId`.

**Why:** The previous `adjustEntityBalance` helper from Item 18 silently no-ops on orphan refs — that's correct for invoice creation (a missing customer ref shouldn't block the invoice; it just means the AR side isn't tracked). But payment application is a different shape: the operator is *explicitly identifying* a target invoice. A silent no-op would record the payment as fully unapplied without any signal that the application failed, which is exactly the kind of silent-data-loss failure mode the project's "single user, must work flawlessly" standard wants to avoid. Real QB also rejects unknown `TxnID`s in `AppliedToTxnAdd` with an error.

**Alternatives rejected:**
- **Silent no-op (mirror `adjustEntityBalance` behavior).** Already covered above — rejected because the operator's intent is explicit and a silent failure leaves the books wrong without any hint why the invoice didn't close out. This is the option Item 18 *explicitly preserved* for invoice creation; the asymmetry here is intentional.
- **Apply what you can, drop orphan refs, return a warning in the payload.** Would require introducing a "warnings" channel separate from `isError`, and the payment would still post with a partial-applied state that doesn't match the operator's request. Rejected because it's both more complex and less predictable.
- **Two-pass with rollback only on error.** Same as the chosen option in terms of operator-visible behavior; the chosen option already does a validate-first / apply-second two-pass to guarantee atomicity within the simulation. No rollback path needed because mutation never starts until validation passes.

**Tradeoffs / consequences:**
- Operators get a clear error if they paste a stale or wrong `txnId` — easy to recover from.
- Phase 3 item 8 (`qb_payment_apply` via `ReceivePaymentMod`) will inherit the same strict semantics; its `handleMod` path will share the same helper. Document this when item 8 is picked up so the convention stays consistent.
- The two-pass validate-first design is slightly more verbose than a single loop with an inline early-return, but the atomicity guarantee (no half-applied payments on partial-failure) is worth the duplication. Keep this pattern for any future bulk-mutation tool (e.g. JournalEntry lines that touch multiple accounts).
- The tool-layer also rejects `sum(appliedTo.amount) > totalAmount` with `+1e-9` floating-point slack BEFORE the simulation runs, so two distinct error classes are surfaced to the operator with different statusCodes (the overapply rejection has no statusCode — it's a tool-layer validation; the orphan-TxnID rejection has statusCode 500 from the simulation).

**Revisit when:** A live-mode test reveals that real QB returns a different status code (likely 3170 "specified object not found in QuickBooks" or similar) — at which point the simulation should match the live code rather than picking a generic 500. Defer until live mode lands in Phase 7.

---

## 2026-04-25 — Drop `amountDue` arg from `qb_bill_create` (lines are the only source of total truth)

**Chosen:** Removed the optional top-level `amountDue` arg from `qb_bill_create`. After Phase 3 Item 4, `AmountDue` is computed exclusively as `sum(expenseLines.amount) + sum(itemLines.quantity * cost)` by the simulation's `computeTotals` helper. There is now no way to override it from the tool layer.

**Why:** Once `expenseLines` and `itemLines` became required (at least one), there are two candidates for "what is this bill's AmountDue":
1. The header `amountDue` arg the operator passed.
2. The sum of all line amounts.

Real QB derives AmountDue from the lines server-side and rejects mismatched header totals. Allowing both invites "which wins?" confusion and a class of subtle bugs where a sloppy override leaves AR/AP aging out of sync with the line ledger. The acceptance criterion explicitly says `AmountDue = sum(lines)` — keeping a header override would have meant either silently ignoring it, silently overriding it, or rejecting mismatches with custom logic. All three are worse than just removing the arg.

**Alternatives rejected:**
- **Keep `amountDue` as an override; document precedence.** Documented precedence still leaves the simulation diverging from real QB (which always derives from lines). Operators eventually trip on it.
- **Keep `amountDue`; reject if it doesn't match line sum.** Adds a third validation layer for no win — if the operator computed the sum themselves, why pass it? If they didn't, the lines tell us the right answer already.

**Tradeoffs / consequences:**
- **Breaking schema change.** Any prior caller passing `amountDue` will fail (zod will reject the unknown key — actually no, zod's default is `strip`, so unknown keys are silently dropped, not rejected; the bill will still be created, but the operator's intended override is silently ignored). Acceptable for a single-user personal tool with no external callers.
- **Edge case lost.** If a future workflow legitimately needs to record a bill with a header total that intentionally differs from line totals (e.g. importing legacy bills with rounding artifacts), this would have to be re-added — the use case doesn't exist today and is documented here so a future agent doesn't silently re-add the arg.
- **Simulation now matches real QB more closely.** Both derive AmountDue from lines.

**Revisit when:** A real QB workflow surfaces where header total must differ from line sum (e.g. rounding artifacts on imported legacy data) — at which point the override is reintroduced with explicit precedence docs and a `force` flag.

---

## 2026-04-25 — Light-touch single-schema for `qb_item_add` / `qb_item_update` across all five subtypes

**Chosen:** All five item subtypes (`Service`, `Inventory`, `NonInventory`, `OtherCharge`, `Group`) share one zod schema per tool. The `itemType` arg routes the request to the correct `Item<Subtype>AddRq` / `Item<Subtype>ModRq`. Subtype-inapplicable fields (e.g. `assetAccountName` on a `Service` item) are accepted by the schema and silently ignored when not relevant.

**Why:** The acceptance criterion (`ACCEPTANCE_CRITERIA.md` Item 2 bullet 5) phrases the requirement as "subtype-specific fields are accepted" — it doesn't require strict rejection of inapplicable fields. The five subtypes share most fields (`Name`, `Description`, `Price`, `IsActive`); a unified schema keeps the operator-facing surface compact and discoverable. Live mode would reject inapplicable fields anyway via QB's own validation, so the simulation's permissiveness is a dev-ergonomics choice, not a correctness gap.

**Alternatives rejected:**
- **Five separate `qb_item_<subtype>_add` tools** — explodes the tool count from 4 to 12, fragments the items domain, and forces the operator to know the subtype taxonomy before they can find the right tool. Real QB users think "add an item" first, "what kind" second.
- **Zod `discriminatedUnion` on `itemType`** — gives strict per-subtype field validation (e.g. reject `assetAccountName` on Service), but requires five branches in the schema and complicates the handler with five field-extraction blocks. Worth doing later if a class of bugs emerges from operators passing inapplicable fields; not worth the complexity today when the simulation just stores whatever arrives.

**Tradeoffs / consequences:**
- An operator can pass `assetAccountName` on a Service item and the simulation will store it without complaint. Real QB would reject. This is a known fidelity gap — not a correctness gap, since the item still ends up in the right per-subtype store with the right routing.
- If we later want strict validation, switching to `discriminatedUnion` is a localized change in `src/tools/items.ts` — no schema changes elsewhere.

**Revisit when:** A live-mode session reveals operators routinely passing inapplicable fields and getting cryptic QB errors. Or when the Phase 7 live-mode work begins and surfaces real validation requirements.

---

## 2026-04-25 — Establish project operating system before implementation

**Chosen:** Write `CLAUDE.md`, `HANDOFF.md`, `todo.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `REQUIREMENTS.md`, `REGRESSION_CHECKLIST.md`, `ACCEPTANCE_CRITERIA.md` before fixing any of the 33 identified issues.

**Why:** A 33-item fix list across 8 phases will span many sessions. Without externalized continuity, the second session re-discovers the audit, the third session starts inventing patterns that conflict with the first, and the simulation store accumulates contradictory partial fixes. Cost of writing the operating system upfront (~one session) is small relative to the cost of three sessions of drift.

**Alternatives rejected:**
- Start fixing immediately, document later — historically produces inconsistent fixes and forgotten context.
- Use only `todo.md` — captures sequence but not architecture, decisions, or acceptance.

**Tradeoffs / consequences:**
- One full session spent on docs before any code moves.
- Future sessions inherit a mandatory pickup ritual (read HANDOFF, todo, etc.).
- Drift becomes detectable instead of silent.

**Revisit when:** No scheduled revisit. Operating system itself is the meta-protocol.

---

## 2026-04-25 — Tackle simulation correctness before transaction completeness

**Chosen:** Phase 1 of `todo.md` (simulation filters, line-Ret conversion, computed totals, balance updates, item-store split) executes before Phase 2 (item subtype fixes) and Phase 3 (transaction line items, payment application, bill update).

**Why:** The simulation store currently silently ignores transaction filters and doesn't compute Subtotal/BalanceRemaining. Any tool work in Phase 2+ that touches invoices/bills/payments cannot be verified in dev because the responses are wrong. Fixing the lens before fixing what's seen through it.

**Alternatives rejected:**
- Tackle critical-blocker order (live mode → item subtypes → bills → payments) — would require all verification on a Windows + QB box from day one, which is impractical for iteration speed.
- Skip simulation fidelity and rely on live testing — defeats the purpose of having a simulation at all.

**Tradeoffs / consequences:**
- Phase 1 work appears infrastructural and may feel like "not making progress" — but it's what makes Phase 2-6 verifiable.
- Live mode (Phase 7) is intentionally last because it can only be verified on Windows + QB Desktop, and we want the simulation rock-solid before that constraint kicks in.

**Revisit when:** Phase 1 complete, before starting Phase 2.

---

## 2026-04-25 — Two-mode session (live + simulation) instead of mocks-in-tests

**Chosen:** Production code carries both a live path and a simulation path inside `QBSessionManager`. Mode is selected at construction by env vars. Both paths return identically-shaped `QBXMLResponse` objects.

**Why (inferred from existing code):** The MCP server runs on the operator's machine, not in a CI environment. The operator wants to develop, test, and demonstrate it on macOS/Linux without a QuickBooks license. The simulation path is also useful for letting the LLM exercise tools safely before pointing it at real books. Embedding simulation in production avoids needing a separate mock layer in tests and lets the same code run in dev and prod.

**Alternatives rejected:**
- Mock at the test boundary only — would force every dev to install QuickBooks Desktop on Windows just to run the server, killing the cross-platform development story.
- Separate `simulator/` binary — duplicates the QBXML envelope handling and risks drifting from the live path.

**Tradeoffs / consequences:**
- Production binary carries simulation code (small — `simulation-store.ts` is ~550 lines).
- Risk of behavioral drift between modes — mitigated by Invariant #2 in `ARCHITECTURE.md` ("simulation and live must be observationally identical").
- Mode-detection bug currently exists (`QB_SIMULATION=false` on Windows without `QB_LIVE=1` still simulates) — captured as Phase 6 item 23.

**Revisit when:** If we ever ship the server to non-developer operators who never need simulation, consider stripping it out. Not before.

---

## 2026-04-25 — In-memory `Map`-based simulation store, no persistence

**Chosen:** `SimulationStore` uses `Map<string, EntityStore>` with no disk persistence. Seed data is hardcoded in the constructor.

**Why (inferred from existing code):** Simulation is for development and demos. Resetting on process restart is a feature, not a bug — every session starts from the same known seed state, making behavior reproducible.

**Alternatives rejected:**
- SQLite — adds a dependency, complicates the cross-platform story (better-sqlite3 native build), and offers no real benefit for ephemeral simulation data.
- JSON file persistence — risks stale state across sessions and creates a new "what's in this file?" question for every developer.

**Tradeoffs / consequences:**
- Cannot survive a restart in dev. Workflow: start server → exercise tools → trust seed data is back next time.
- Tests will need to construct fresh `SimulationStore` instances for isolation (relevant when Phase 8 item 31 lands).
- If we ever want a "load from real export" feature, we'd add it as a separate mode, not by changing the store backing.

**Revisit when:** If a workflow emerges where mid-session simulation state needs to be inspected after a crash, reconsider.

---

## 2026-04-25 — One file per entity domain in `src/tools/`

**Chosen:** Tools are organized by entity domain — `customers.ts`, `vendors.ts`, `invoices.ts`, etc. — each exporting a single `register<Domain>Tools(server, getSession)` function.

**Why (inferred from existing code):** Matches QBXML's own taxonomy. Keeps related CRUD operations together so the next agent can find all customer-related code in one file. Avoids a single mega-file or a hyper-fragmented one-tool-per-file layout.

**Alternatives rejected:**
- Single `tools.ts` — unwieldy at 36+ tools, hard to navigate.
- One file per tool — too much ceremony, and forces shared zod schemas to live in awkward shared modules.
- Group by verb (all `*_list.ts`, all `*_add.ts`) — splits cohesive entity logic across files.

**Tradeoffs / consequences:**
- `payments.ts` currently also contains estimate tools (probably should be split when estimates grow per Phase 4 item 13).
- Reports/session/raw-query tools all live in `reports.ts` because they didn't fit a single entity — fine for now, may want a `meta.ts` later.

**Revisit when:** If a domain grows past ~500 lines or a domain spans multiple QBXML entity types (like `payments.ts` does today).

---

## 2026-04-25 — Defer extraction of transaction-vs-list classification constant

**Chosen:** Leave the `isTransaction` array duplicated across [builder.ts:115-131](src/qbxml/builder.ts#L115-L131), [manager.ts:200-203](src/session/manager.ts#L200-L203), and [simulation-store.ts:359-366](src/session/simulation-store.ts#L359-L366) for now. Document in `ARCHITECTURE.md` that all three must be updated together.

**Why:** Extracting the constant is a separate refactor that touches three files. The audit identified more critical fixes; doing the refactor now mixes concerns and risks an unrelated regression. Ship the documentation cost (Invariant #5) and revisit when one of those files is being touched anyway.

**Alternatives rejected:**
- Extract immediately to `src/qbxml/entity-types.ts` — pure win architecturally, but adds churn to a session focused on operating-system setup.

**Tradeoffs / consequences:**
- Risk that a future session adds a new transaction type to one location and not the others. Mitigated by the architecture invariant and by the regression checklist's "QBXML round-trip" section.

**Revisit when:** Phase 4 item 12 (sales receipts / credit memos / POs / journal entries) — those add multiple new transaction types and will touch all three files anyway. Do the extraction in that session.
