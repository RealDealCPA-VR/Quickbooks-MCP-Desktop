# Handoff State

_Last updated: 2026-04-26_

## Last Session Summary

- Completed **Phase 4, Item 11** — `qb_employee_make_inactive` + `qb_employee_delete`. Two separate tools (matching the Item 10 split) since the schemas/descriptions diverge meaningfully. Tool count 42 → 44.
- **`qb_employee_make_inactive`** at [src/tools/employees.ts:111-144](src/tools/employees.ts#L111-L144) — bare-minimum schema (`listId` + `editSequence` only). Wraps `session.modifyEntity("Employee", { ListID, EditSequence, IsActive: false })`. Reversible via the existing `qb_employee_update { listId, editSequence, isActive: true }` (verified A7/A8). Stale `editSequence` rejects with `statusCode: 3170`; unknown `listId` rejects with `statusCode: 500`.
- **`qb_employee_delete`** at [src/tools/employees.ts:146-175](src/tools/employees.ts#L146-L175) — single-arg `listId`. Wraps `session.deleteEntity("Employee", listId)`. Tool description warns about real QB rejecting deletion of employees with paycheck/timesheet history (3260/3170). Returns `{ success: true, deleted: { ListDelType: "Employee", ListID } }` on success.
- **No simulation changes needed** — exactly as Item 10 predicted. `handleMod`'s generic `{...modData}` spread already supports `IsActive` mutation, and `handleListDel` already routes `Employee` to its per-entity store generically (the entityType is read from `ListDelType`).
- Both tools use the established try/catch pattern from Items 5/7/8/9/10 — simulation errors surface as `isError: true` + structured `{ error, statusCode }`, not raw exceptions.
- README employees section updated with the inactive-vs-delete tradeoff explanation (mirrors the accounts section); tool table rows added for both new tools; tool count bumped 42 → 44; `instructions` block in [src/index.ts](src/index.ts) updated with the new semantics. ACCEPTANCE_CRITERIA.md Item 11 entry written and moved to Completed. No new DECISIONS.md entry — two-separate-tools (vs discriminated) is the established pattern from Item 10.
- Verified with a 20-check inline script (deleted post-verification): A1–A8 make_inactive happy path including reversibility via `qb_employee_update`; B1–B3 stale-EditSequence (3170) and unknown-listId (500) error paths with no side effects on the rejected mod; C1–C2 delete happy path; D1 delete error path; E1–E6 regressions for `qb_employee_list` defaults, `qb_employee_add` IsActive default, `qb_employee_update` non-IsActive fields (Phone), shared `handleListDel` via Account, Item 10 `qb_account_make_inactive` smoke, and Phase 3 Item 9 `qb_bill_pay` smoke. `npm run build` green throughout.

## Verify Before Continuing

- [ ] **Build.** `npm run build` exits 0.
- [ ] **`make_inactive` happy path.** `qb_employee_add { firstName: "Test", lastName: "Emp" }` — capture `listId` + `editSequence`. Snapshot `qb_employee_list { activeOnly: true }` (default). Call `qb_employee_make_inactive { listId, editSequence }`. Confirm: (a) response `employee.IsActive === false`; (b) response carries a fresh `EditSequence`; (c) `qb_employee_list { activeOnly: true }` no longer contains the employee; (d) `qb_employee_list { activeOnly: false }` DOES contain it (record preserved).
- [ ] **Reversibility.** With the now-inactive employee, call `qb_employee_update { listId, editSequence: <fresh>, isActive: true }`. Confirm the employee is back in `qb_employee_list { activeOnly: true }`.
- [ ] **Stale `editSequence` rejected.** Call `qb_employee_make_inactive` with the ORIGINAL (now-stale) `editSequence`. Confirm `isError: true` + `statusCode: 3170`. Then verify the employee is still in its current state (not deactivated by the rejected call).
- [ ] **Unknown `listId` on `make_inactive`.** Call `qb_employee_make_inactive { listId: "BOGUS", editSequence: "any" }`. Confirm `isError: true` + `statusCode: 500`.
- [ ] **`delete` happy path.** Create another employee; call `qb_employee_delete { listId }`. Confirm: (a) response `success: true` with `deleted.ListDelType === "Employee"` and `deleted.ListID` matching; (b) `qb_employee_list { activeOnly: false }` no longer contains the employee.
- [ ] **Unknown `listId` on `delete`.** `qb_employee_delete { listId: "BOGUS" }` returns `isError: true` + `statusCode: 500`.
- [ ] **Regression — `qb_employee_list` defaults.** Default call returns the seed employee(s).
- [ ] **Regression — `qb_employee_add` produces active employees.** Newly-added employees appear in the default `activeOnly: true` list view.
- [ ] **Regression — `qb_employee_update` non-IsActive path.** Update an employee's `phone` only; confirm `Name` is preserved and `Phone` updated.
- [ ] **Regression — Item 10 `qb_account_make_inactive`.** Quick smoke: create an account, call `qb_account_make_inactive`, confirm `IsActive === false`. (Proves the shared mod plumbing wasn't damaged.)
- [ ] **Regression — Phase 3 `qb_bill_pay`.** Quick smoke: create a bill, pay it via `qb_bill_pay { paymentMethod: "check" }`, confirm `AmountDue===0` + `IsPaid===true`.

## Next Task

**Phase 4, Item 30** in [todo.md:37](todo.md#L37):

> Add `Class`, `Terms`, `PaymentMethod`, `SalesRep`, `CustomerType`, `VendorType` list tools — needed because invoice/bill creation references these by `FullName` but there's no way to list/discover them.

This is a "lots of small thin wrappers" session — six tools, each a thin wrapper around `session.queryEntity(<type>, filters)`. Fast and structurally similar; well-suited to one focused session. Tool count 44 → 50 if all six land.

The work splits into:

1. **One new tools module — [src/tools/lists.ts](src/tools/lists.ts)** (new file). Each tool follows the pattern of `qb_account_list` / `qb_employee_list`: optional `nameFilter`, `activeOnly`, `listId`, `maxReturned`. Six tools:
   - `qb_class_list` — Classes (e.g. departments / locations / cost centers)
   - `qb_terms_list` — Standard payment terms (Net 30, 2% 10 Net 30, etc.). Note QB has TWO underlying types: `StandardTerms` and `DateDrivenTerms`. Default to fanning across both and merging (similar pattern to `qb_bill_payment_list`); pass `termsType` to scope.
   - `qb_payment_method_list` — Payment methods (Check, Cash, Visa, etc.)
   - `qb_sales_rep_list` — Sales reps
   - `qb_customer_type_list` — Customer types
   - `qb_vendor_type_list` — Vendor types

2. **Verify the simulation store handles each entity type generically** — these are list-type entities, so `handleQuery` should work via the generic per-entity store path. Spot-check by invoking `mgr.queryEntity("Class", {})` etc. before adding tool wrappers; if any of the six aren't seeded with sample data, add 2-3 seed entries to [src/session/simulation-store.ts](src/session/simulation-store.ts) (mirror the Customer/Vendor seed pattern). Likely needs seeding — `Class`, `Terms`, `PaymentMethod` definitely useful for downstream invoice/bill testing.

3. **Verify QBXML builder handles these entity types** — [src/qbxml/builder.ts](src/qbxml/builder.ts)'s `buildQueryRequest` needs to know to send `ClassQueryRq` etc. If it builds `<EntityType>QueryRq` generically by appending "QueryRq" to the entity type name, then `Class` / `Terms` / `PaymentMethod` / `SalesRep` / `CustomerType` / `VendorType` should all just work. **Caveat**: Terms is special — needs to fan across `StandardTermsQueryRq` and `DateDrivenTermsQueryRq` and the parser needs `StandardTermsRet` and `DateDrivenTermsRet` registered in `arrayElements` (check first). Spot-check before assuming.

4. **Parser `arrayElements`** — verify [src/qbxml/parser.ts](src/qbxml/parser.ts) registers `ClassRet`, `StandardTermsRet`, `DateDrivenTermsRet`, `PaymentMethodRet`, `SalesRepRet`, `CustomerTypeRet`, `VendorTypeRet`. If any are missing, add them.

5. **Documentation**:
   - README: add a new "### Supporting Lists" or "### Reference Lists" section between Employees and Reports. One short paragraph + tool table rows for all six.
   - Tool count 44 → 50.
   - `instructions` block in [src/index.ts](src/index.ts) — add a bullet for `qb_*_list` reference lists.
   - Move ACCEPTANCE_CRITERIA Item 30 entry to Completed when done.

6. **Acceptance considerations**:
   - At minimum, each tool must return a non-empty array when seed data exists, and an empty array when no entities of that type are stored.
   - Pass-through of `nameFilter`, `activeOnly`, `listId`, `maxReturned` should match the `qb_account_list` / `qb_employee_list` semantics.
   - For `qb_terms_list`: `termsType: "Standard" | "DateDriven"` should scope; default fans across both.

7. **If Item 30 feels too small as a session, consider bundling with Item 24** (dead-code cleanup — small mechanical hygiene that pairs well with a "lots of small wrappers" session). Item 24 is at [todo.md:49](todo.md#L49). Pure-positive cleanup with no behavioral risk.

Acceptance criteria are NOT pre-written for Item 30 — write them when picking it up. The Item 11 entry in [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md) is a good template to copy (same structure, smaller scope per tool).

## Context Notes

- **Item 11 didn't need any simulation work**, exactly as the prior handoff predicted. The generic `handleMod` + `handleListDel` plumbing is solid for any List entity. Trust it for Item 30 too — `handleQuery` with no special filters should work generically across `Class`, `PaymentMethod`, `SalesRep`, `CustomerType`, `VendorType`. **Terms is the one to verify** since it's split across StandardTerms and DateDrivenTerms in real QB.
- **Two-separate-tools (vs discriminated) was right for Items 10 + 11.** Same logic applies to any future delete/make_inactive pair (Item 12 transactions etc. — though delete-only for transactions, since IsActive is a list-entity concept).
- **Project conventions reminder** ([CLAUDE.md](CLAUDE.md) § Stable Code Conventions): TS strict, ESM with `.js` extensions on relative imports, every zod field has `.describe()`, every tool registered in [src/index.ts](src/index.ts) and listed in the README tool table. New tool files go under [src/tools/](src/tools/) and export a `register<Domain>Tools(server, getSession)` function — Item 30 should add `registerListTools` and call it from index.ts.
- **No new dependencies.** Items 10+11 didn't need any. Item 30 is pure tool wrappers — same.
- **No `DECISIONS.md` entry** for Item 11 — same reasoning as Item 10. The make_inactive/delete split is a QB SDK convention, not a project tradeoff.
- **Phase 4 progression**: Items 10 ✅, 11 ✅, 12 (sales receipt / credit memo / PO / journal entry — **biggest** remaining Phase 4 work, four new transaction tool families), 13 (estimate update/delete/convert — meaty; convert_to_invoice requires creating an Invoice from an Estimate's line set), 30 (six list tools — fastest). After Item 30, the natural next step is either Item 12 (the meatiest) or Item 13 (medium).
- **Verification-script gotcha** (still applies — surfaced in three prior sessions now): manager-level `EntityFilter`/`FullName` filtering does NOT honor lookups by `FullName` reliably. Use query-all + `.find(x => x.FullName === name)` in verification scripts. Tool-layer `nameFilter` (with `.NameFilter` wrapping in the request) IS honored.
- **Simulation seeded employees**: only 1 employee in the seed data (verified E1, count=1). If Item 30 needs richer seed data for `qb_class_list` etc. to be non-trivially testable, add 2-3 entries per type at the same time as the simulation handlers.

## Post-Task Chores

When Item 30 is done: `npm run build` green, [REGRESSION_CHECKLIST.md](REGRESSION_CHECKLIST.md) walked (especially §3 Tool Surface for the six new list tools, §4 QBXML Round-Trip for any newly-registered `*Ret` parser entries, §5 Simulation Store for any seed data added, §6 Prior Tool Verification for `qb_account_list` / `qb_employee_list` / `qb_customer_list` to make sure shared query plumbing didn't regress), Item 30 marked `[x]` in `todo.md`, acceptance entry added (then moved to Completed) in [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md), README updated with the new Reference Lists section, tool count bumped (44 → 50), `instructions` block in [src/index.ts](src/index.ts) updated, fresh `HANDOFF.md` pointing to the next Phase 4 task — likely Item 13 (estimate update/delete/convert — medium) or Item 12 (the four missing transaction tool families — biggest).
