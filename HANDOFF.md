# Handoff State

_Last updated: 2026-04-26_

## Last Session Summary

- Completed **Phase 4, Item 10** — `qb_account_make_inactive` + `qb_account_delete`. Two separate tools (rather than discriminated) since the semantics meaningfully differ. Tool count 40 → 42.
- **`qb_account_make_inactive`** at [src/tools/accounts.ts:117-149](src/tools/accounts.ts#L117-L149) — bare-minimum schema (`listId` + `editSequence` only). Wraps `session.modifyEntity("Account", { ListID, EditSequence, IsActive: false })`. Reversible via the existing `qb_account_update { listId, editSequence, isActive: true }` (verified A8/A9). Stale `editSequence` rejects with `statusCode: 3170`; unknown `listId` rejects with `statusCode: 500`.
- **`qb_account_delete`** at [src/tools/accounts.ts:151-180](src/tools/accounts.ts#L151-L180) — single-arg `listId`. Wraps `session.deleteEntity("Account", listId)`. Tool description explicitly warns about the inactive-vs-delete tradeoff (real QB rejects deletion of accounts with transaction history with statusCode 3260/3170). Returns `{ success: true, deleted: { ListDelType: "Account", ListID } }` on success.
- **No simulation changes needed** — `handleMod`'s generic `{...modData}` spread already supports `IsActive` mutation, and `handleListDel` already routes to the per-entity store generically (the entityType comes from `ListDelType` in the request).
- Both tools use the established try/catch pattern from Items 5/7/8/9 — simulation errors surface as `isError: true` + structured `{ error, statusCode }`, not raw exceptions.
- README chart-of-accounts section updated with the inactive-vs-delete tradeoff explanation; tool table rows added for both new tools; tool count bumped 40 → 42; `instructions` block in [src/index.ts](src/index.ts) updated with the new semantics. ACCEPTANCE_CRITERIA.md Item 10 entry written and moved to Completed. No new DECISIONS.md entry — two-separate-tools (vs discriminated) is the recommended choice and matches the existing pattern (e.g. `qb_invoice_delete` is its own tool, not a mode of `qb_invoice_update`).
- Verified with a 30-check inline script (deleted post-verification): A1–A9 make_inactive happy path including reversibility via `qb_account_update`; B1–B5 stale-EditSequence (3170) and unknown-listId (500) error paths with no side effects on the rejected mod; C1–C4 delete happy path; D1/D2 delete error path; E1–E7 regressions for `qb_account_list` defaults, `qb_account_add` IsActive, `qb_account_update` non-IsActive fields, and shared `handleListDel` plumbing via Customer; F1–F3 Phase 3 Item 9 smoke (bill_pay closure + IsPaid flip). `npm run build` green throughout.

## Verify Before Continuing

- [ ] **Build.** `npm run build` exits 0.
- [ ] **`make_inactive` happy path.** `qb_account_add { name: "Test Acct", accountType: "Expense" }` — capture `listId` + `editSequence`. Snapshot `qb_account_list { activeOnly: true }` (default). Call `qb_account_make_inactive { listId, editSequence }`. Confirm: (a) response `account.IsActive === false`; (b) response carries a fresh `EditSequence`; (c) `qb_account_list { activeOnly: true }` no longer contains the account; (d) `qb_account_list { activeOnly: false }` DOES contain it (record preserved).
- [ ] **Reversibility.** With the now-inactive account, call `qb_account_update { listId, editSequence: <fresh>, isActive: true }`. Confirm the account is back in `qb_account_list { activeOnly: true }`.
- [ ] **Stale `editSequence` rejected.** Call `qb_account_make_inactive` with the ORIGINAL (now-stale) `editSequence`. Confirm `isError: true` + `statusCode: 3170`. Then verify the account is still in its current state (not deactivated by the rejected call).
- [ ] **Unknown `listId` on `make_inactive`.** Call `qb_account_make_inactive { listId: "BOGUS", editSequence: "any" }`. Confirm `isError: true` + `statusCode: 500`.
- [ ] **`delete` happy path.** Create another account; call `qb_account_delete { listId }`. Confirm: (a) response `success: true` with `deleted.ListDelType === "Account"` and `deleted.ListID` matching; (b) `qb_account_list { activeOnly: false }` no longer contains the account.
- [ ] **Unknown `listId` on `delete`.** `qb_account_delete { listId: "BOGUS" }` returns `isError: true` + `statusCode: 500`.
- [ ] **Regression — `qb_account_list` defaults.** Default call returns the seed accounts (Checking, Utilities, Sales Revenue, etc.). `activeOnly: false` returns the same set (since seed accounts are all active).
- [ ] **Regression — `qb_account_add` produces active accounts.** Newly-added accounts appear in the default `activeOnly: true` list view.
- [ ] **Regression — `qb_account_update` non-IsActive path.** Update an account's `description` only; confirm `Name` is preserved and `Description` updated. (The new `IsActive` flow goes through the same `session.modifyEntity` plumbing — no change to the existing path.)
- [ ] **Regression — Phase 3 `qb_bill_pay`.** Quick smoke: create a bill, pay it via `qb_bill_pay { paymentMethod: "check" }`, confirm `AmountDue===0` + `IsPaid===true`. (Item 9 smoke — proves we didn't damage the AP flow.)

## Next Task

**Phase 4, Item 11** in [todo.md:34](todo.md#L34):

> Add `qb_employee_delete` / `make_inactive` (currently only list/add/update).

This is structurally identical to Item 10 — same shape, same simulation pathway, same testing surface. Tool count 42 → 44 if you go with two separate tools (recommended for consistency with Item 10).

The work splits into:

1. **Two new tools in [src/tools/employees.ts](src/tools/employees.ts)** — copy the Item 10 pattern almost verbatim:
   - `qb_employee_make_inactive(listId, editSequence)` → `session.modifyEntity("Employee", { ListID, EditSequence, IsActive: false })`. Bare-minimum schema. Wrap with try/catch.
   - `qb_employee_delete(listId)` → `session.deleteEntity("Employee", listId)`. Tool description should warn about real QB rejecting deletion of employees with paycheck history (3260/3170).

2. **Simulation handles this generically** — `handleMod` already supports `IsActive` mutation, `handleListDel` already routes to the Employee store. Same as Item 10 — zero simulation work.

3. **Documentation**:
   - README employees section: add the inactive-vs-delete tradeoff paragraph (mirror the accounts section).
   - Tool table rows for both new tools.
   - Tool count 42 → 44.
   - `instructions` block in [src/index.ts](src/index.ts) — update employee bullet.
   - Move ACCEPTANCE_CRITERIA Item 11 entry to Completed when done.

4. **Acceptance considerations**:
   - At minimum, deactivating an employee should hide them from `qb_employee_list { activeOnly: true }` but keep them in `activeOnly: false` queries.
   - Stale editSequence → 3170; unknown listId → 500; same as Item 10.
   - Both tools use the structured-error pattern from Items 5/7/8/9.

5. **If Item 11 feels too small as a session-bounded task, bundle it with Item 13** (`qb_estimate_update` / `qb_estimate_delete` / `qb_estimate_convert_to_invoice`). Item 13 is meatier — `qb_estimate_convert_to_invoice` requires creating an Invoice from an Estimate's line set (different shape, different store) and is a real piece of work, not just a list-tool addition. Or pair Item 11 with **Item 30** (`Class`, `Terms`, `PaymentMethod`, `SalesRep`, `CustomerType`, `VendorType` list tools) — each one is a thin wrapper around `session.queryEntity(<type>, filters)` and they're all structurally similar, so 6 tools could land in one focused session.

Acceptance criteria are NOT pre-written for Item 11 — write them when picking it up. The Item 10 entry in [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md) is a good template to copy.

## Context Notes

- **Item 10 didn't need any simulation work**, which is why it was a fast bundle. Item 11 should be similarly fast — same generic `handleMod` + `handleListDel` plumbing already supports Employee. If you find yourself needing to extend the simulation, double-check the assumption — most likely you're reaching for a path that already works.
- **`qb_account_update` already supports `isActive: true|false`.** That field has been there since before Item 10 — `qb_account_make_inactive` is a sugar tool that exists because (a) operators shouldn't have to remember `isActive: false` is the right shape, and (b) the dedicated tool can carry a description that warns about the inactive-vs-delete tradeoff at discovery time. Same logic applies to `qb_employee_make_inactive` if `qb_employee_update` already supports an `isActive` field — verify before adding.
- **Two-separate-tools (vs discriminated mode arg) was the right call for Item 10** for two reasons: (1) the descriptions are different — `make_inactive` has the reversibility note, `delete` has the warning about transaction history; (2) `delete` doesn't need an `editSequence`, but `make_inactive` does, so a discriminated tool would have a confusing optional-field-depending-on-mode schema. Same applies to Item 11.
- **Project conventions reminder** ([CLAUDE.md](CLAUDE.md) § Stable Code Conventions): TS strict, ESM with `.js` extensions on relative imports, every zod field has `.describe()`, every tool registered in [src/index.ts](src/index.ts) and listed in the README tool table.
- **No new dependencies.** Item 10 didn't need any.
- **No `DECISIONS.md` entry for Item 10** — the inactive-vs-delete split is an established QuickBooks SDK convention, not a project-specific tradeoff. If Item 11 follows the same pattern, no entry needed there either.
- **Phase 4 progression**: Items 10 ✅, 11 (employees), 12 (sales receipt / credit memo / PO / journal entry — much bigger), 13 (estimate update/delete/convert — meaty), 30 (supporting list tools — fast). The remaining Phase 4 work skews toward "lots of small tools" once you get past Item 12. After Item 11, consider whether Item 12 or a bundle of 13+30 is the better next session.
- **Verification-script gotcha** (still applies, surfaced in two prior sessions): manager-level `EntityFilter`/`FullName` filtering does NOT honor lookups by `FullName` reliably. Use query-all + `.find(x => x.FullName === name)` in verification scripts. Tool-layer `nameFilter` (with `.NameFilter` wrapping in the request) IS honored.

## Post-Task Chores

When Item 11 is done: `npm run build` green, [REGRESSION_CHECKLIST.md](REGRESSION_CHECKLIST.md) walked (especially §3 Tool Surface for the new employee tools, §5 Simulation Store CRUD for `IsActive` flip + hard delete on Employee, §6 Prior Tool Verification for `qb_employee_list { activeOnly: true }` filtering and `qb_employee_update` to make sure shared mod plumbing didn't regress), Item 11 marked `[x]` in `todo.md`, acceptance entry added (then moved to Completed) in [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md), README employee section updated, tool count bumped (42 → 44), `instructions` block in [src/index.ts](src/index.ts) updated, fresh `HANDOFF.md` pointing to the next Phase 4 task — likely Item 13 (estimate update/delete/convert — meatier) or Item 30 (supporting list tools — fast).
