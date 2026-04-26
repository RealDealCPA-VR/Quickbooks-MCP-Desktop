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
