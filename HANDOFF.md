# Handoff State

_Last updated: 2026-04-26_

## Last Session Summary

- Completed **Phase 4, Item 30** — six reference-list tools in a new [src/tools/lists.ts](src/tools/lists.ts) module. Tool count 44 → 50.
- **`qb_class_list`**, **`qb_payment_method_list`**, **`qb_customer_type_list`**, **`qb_vendor_type_list`** — thin wrappers around `session.queryEntity(<type>, filters)` with the standard `nameFilter` / `activeOnly` / `listId` / `maxReturned` schema (matches `qb_account_list` / `qb_employee_list`).
- **`qb_sales_rep_list`** — same shape but omits `nameFilter` because real QB SalesRep records are keyed by `Initial`, not by `Name` — `nameFilter` would silently no-op against the `e.Name ?? e.FullName` simulation match.
- **`qb_terms_list`** — fans across `StandardTerms` + `DateDrivenTerms` via `Promise.all` and merges, attaching a `TermsType: "StandardTerms" | "DateDrivenTerms"` discriminator to each row (mirrors the `qb_bill_payment_list` pattern from Phase 3 Item 9). Pass `termsType: "Standard" | "DateDriven"` to scope.
- **Parser** — six new `*Ret` entries added to `arrayElements` in [src/qbxml/parser.ts](src/qbxml/parser.ts): `StandardTermsRet`, `DateDrivenTermsRet`, `PaymentMethodRet`, `SalesRepRet`, `CustomerTypeRet`, `VendorTypeRet`. (`ClassRet` was already registered.)
- **Simulation store** — seven seed-data blocks added at the end of `seedData()` in [src/session/simulation-store.ts](src/session/simulation-store.ts). No request-handler changes needed — the generic `handleQuery` + `getStore(entityType)` path works for any list entity, exactly as the prior handoff predicted. Counts: Class=3, StandardTerms=3, DateDrivenTerms=2, PaymentMethod=4, SalesRep=2, CustomerType=3, VendorType=3.
- **Builder** — no changes. `buildQueryRequest` is generic (`${entityType}QueryRq`) so all six new entity types route through the existing path.
- README updated with a new "Reference Lists" section (between Employees and Reports & Queries) explaining the read-only nature, the StandardTerms/DateDrivenTerms split, and a tool table for all six. Tool count bumped 44 → 50. `instructions` block in [src/index.ts](src/index.ts) updated with a new bullet enumerating the six tools and the `qb_terms_list` fan-out. ACCEPTANCE_CRITERIA Item 30 entry written and moved straight to Completed. No new DECISIONS.md entry — fan-out follows the established `qb_bill_payment_list` pattern.
- Verified end-to-end with a 31-check inline script (deleted post-verification): A1–A6 entity-type query routing; B1–B6 seed data presence; C1 graceful-empty filter; D1–D4 `nameFilter` / `activeOnly` (default vs explicit) / `listId` / `maxReturned` filter pass-through; E1–E3 termsType fan-out + discriminator + scoped filtering; F1–F6 regressions for `qb_account_list` / `qb_employee_list` / `qb_customer_list` defaults plus Item 10 / Item 11 / Phase 3 Item 9 smokes. `npm run build` green throughout.

## Verify Before Continuing

- [ ] **Build.** `npm run build` exits 0.
- [ ] **Each list tool returns seed data.** From `npm run dev`, call each new tool and confirm non-empty results: `qb_class_list` → 3 entries (East, West, Overhead); `qb_payment_method_list` → 4 (Check, Cash, Visa, MasterCard); `qb_customer_type_list` → 3 (Commercial, Residential, Government); `qb_vendor_type_list` → 3 (Supplier, Subcontractor, Service Provider); `qb_sales_rep_list` → 2 (Initials JS, AJ).
- [ ] **`qb_terms_list` default fan-out.** Default call returns 5 entries (3 StandardTerms + 2 DateDrivenTerms), each carrying a `TermsType` field set to either `"StandardTerms"` or `"DateDrivenTerms"`.
- [ ] **`qb_terms_list { termsType: "Standard" }`** returns 3 entries, all `TermsType: "StandardTerms"`. `{ termsType: "DateDriven" }` returns 2 entries, all `TermsType: "DateDrivenTerms"`.
- [ ] **`nameFilter` Contains match.** `qb_terms_list { nameFilter: "Net" }` returns 3 entries (Net 15, Net 30, 2% 10 Net 30) — DateDrivenTerms entries are excluded because none contain "Net".
- [ ] **`activeOnly` default.** Default call to any of the six tools excludes inactive entries; `activeOnly: false` includes them. (Verify by adding a Class via `qb_class_list`-adjacent path is not possible since add/update tools aren't exposed for these types — instead verify by inspecting the seed: all 3 seed Classes are active.)
- [ ] **`listId` fetch.** Pass a known `listId` from the seed (e.g. Class `C0000001`) and confirm exactly 1 result with matching ListID.
- [ ] **`maxReturned` cap.** `qb_payment_method_list { maxReturned: 2 }` returns exactly 2 entries.
- [ ] **Regression — `qb_account_list` defaults.** Returns 10 seed accounts.
- [ ] **Regression — `qb_customer_list` defaults.** Returns 3 seed customers.
- [ ] **Regression — `qb_employee_list` defaults.** Returns the seed employee count (currently 0 — see Context Notes; may be intentional). Verifies that the new seed blocks didn't break the existing employee path.
- [ ] **Regression — Item 10 `qb_account_make_inactive`.** Quick smoke: create an account, call `qb_account_make_inactive`, confirm `IsActive === false`.
- [ ] **Regression — Item 11 `qb_employee_make_inactive`.** Quick smoke: create an employee, call `qb_employee_make_inactive`, confirm `IsActive === false`.
- [ ] **Regression — Phase 3 `qb_bill_pay`.** Quick smoke: create a bill, pay it via `qb_bill_pay { paymentMethod: "check" }`, confirm `AmountDue===0` + `IsPaid===true`.

## Next Task

**Phase 4, Item 13** in [todo.md:36](todo.md#L36):

> Add `qb_estimate_update`, `qb_estimate_delete`, `qb_estimate_convert_to_invoice` tools — currently only list/create.

Item 13 is the medium-sized Phase 4 work — three new tools, of which `qb_estimate_convert_to_invoice` is the one that needs real thought (creating an Invoice from an Estimate's line set). The other two (`qb_estimate_update`, `qb_estimate_delete`) are mechanical:

1. **`qb_estimate_update`** — mirror [src/tools/invoices.ts](src/tools/invoices.ts) `qb_invoice_update`. Estimates use `EstimateMod` with `EstimateLineMod` line shape. Same `txnId` + `editSequence` + replace-lines-wholesale semantics. The simulation already supports this generically via `handleMod` + `applyLineMods` (the `^(.+?)Line(s?)Mod$` regex catches `EstimateLineMod`). `computeTotals` already handles `Estimate` (Subtotal recomputation). Acceptance: same shape as Item 6 (`qb_invoice_update`).

2. **`qb_estimate_delete`** — single-arg `txnId`. Wraps `session.deleteEntity("Estimate", txnId)`. Estimate is in the transaction list ([src/qbxml/builder.ts:115-131](src/qbxml/builder.ts#L115-L131) and [src/session/manager.ts:200-203](src/session/manager.ts#L200-L203)) so it routes to `TxnDelRq` correctly. The simulation's `handleTxnDel` path is generic — no changes needed. Acceptance: same shape as `qb_invoice_delete`.

3. **`qb_estimate_convert_to_invoice`** — the meaty one. Real QB has no "convert" RPC: the operator queries the Estimate, builds an `InvoiceAddRq` from the Estimate's line set, then optionally marks the Estimate as `IsAccepted: true`. Implementation options:
   - **Option A** (recommended): Tool layer reads the Estimate via `qb_estimate_list { txnId }`, copies `CustomerRef` + `EstimateLineRet` (mapping each line to an `InvoiceLineAdd`), submits an `InvoiceAddRq`, and returns the new invoice. Simulation gets it for free.
   - **Option B**: Add a server-side handler in the simulation store. Rejected — the operation is just two QBXML calls glued together at the tool layer, mirrors how an operator would do it manually, and works identically against live QB.
   - Mark the source Estimate as accepted (`EstimateMod { IsAccepted: true }`) after the invoice is successfully created. Tool flag `markAccepted: boolean` (default `true`) — operator can opt out for partial conversions.
   - Edge cases to think through: estimate with $0 lines, estimate already converted (no flag in QB to prevent double-conversion — let the operator decide), estimate with terms/PO references (carry them onto the invoice).

Acceptance criteria are NOT pre-written for Item 13 — write them when picking it up. The Item 6 entry in [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md) is the closest template for `qb_estimate_update`. `qb_estimate_convert_to_invoice` will need its own bespoke criteria covering the two-step happy path, the `markAccepted` flag, and what happens if the InvoiceAddRq fails after the EstimateMod (currently: shouldn't matter because we mark accepted AFTER invoice success — so atomic-enough).

Tool count 50 → 53 if all three land.

## Context Notes

- **Item 30 needed zero handler changes.** Just six new tool wrappers + seed data + parser `arrayElements` registration. The simulation store's generic `handleQuery` path with `getStore(entityType)` worked unmodified for all six entity types — same as Items 10 + 11.
- **`qb_terms_list` fan-out pattern**: copies the `qb_bill_payment_list` (Phase 3 Item 9) approach exactly. `Promise.all` over the type array, attach a discriminator field, flatten. Re-use this pattern for any future split-type entity (e.g. there could be a future use case for `qb_check_or_billpayment_list` — same shape).
- **`qb_sales_rep_list` schema omits `nameFilter`** because real QB SalesRep is keyed by `Initial`, not `Name`. A future enhancement could add an `initialFilter` arg, but that's out of scope for Item 30 (the operator-facing complaint was "no way to list these", not "filter granularity is wrong"). Acceptance criteria for Item 30 explicitly note this.
- **Seed employee count is 0**, contradicting an earlier handoff claim of count=1. Verified F2 in this session's verification script. Probably an old-handoff artifact — the current seed code in [simulation-store.ts](src/session/simulation-store.ts) has no employee block at all. Not a bug; just noting so the next agent doesn't chase a false discrepancy. If Item 13 (or a future item) needs richer employee seed data, add 2-3 entries alongside the existing customer/vendor seed.
- **Items 10 / 11 / 30 all confirmed the same insight**: the simulation store's per-entity `Map` + generic `handleQuery` / `handleMod` / `handleListDel` plumbing is solid for any list entity. Trust it for Item 13 too — `Estimate` is a transaction (handled via `handleAdd` + `handleMod` + `handleTxnDel`), all of which are already exercised by `qb_invoice_*` and `qb_bill_*`. No simulation handler work expected for `qb_estimate_update` or `qb_estimate_delete`.
- **Verification-script gotcha** (still applies): manager-level `EntityFilter` / `FullName` filtering does NOT honor lookups by `FullName` reliably for transactions. Use query-all + `.find(x => x.TxnID === id)` for verifying estimate operations. Tool-layer `nameFilter` (with `.NameFilter` wrapping) IS honored.
- **No new dependencies.** Item 30 is pure tool wrappers. Item 13 should also be pure tool wrappers — `qb_estimate_convert_to_invoice` is just chained tool calls.
- **Item 24 dead-code cleanup remains pending** — small mechanical hygiene task that pairs well with any "lots of small wrappers" session if Item 13 has spare cycles. [todo.md:49](todo.md#L49). Targets: `parseQBXMLResponse` import in [session/manager.ts:27](src/session/manager.ts#L27), `buildSingleRequest` export in [qbxml/builder.ts:66](src/qbxml/builder.ts#L66), `QBXMLRequestBody` import in [qbxml/builder.ts:9](src/qbxml/builder.ts#L9), the useless ternary `isTransaction ? id : id` in [simulation-store.ts:330](src/session/simulation-store.ts#L330) (line shifted from 214 since the prior handoff).
- **Project conventions reminder** ([CLAUDE.md](CLAUDE.md) § Stable Code Conventions): TS strict, ESM with `.js` extensions on relative imports, every zod field has `.describe()`, every tool registered in [src/index.ts](src/index.ts) and listed in the README tool table.

## Post-Task Chores

When Item 13 is done: `npm run build` green, [REGRESSION_CHECKLIST.md](REGRESSION_CHECKLIST.md) walked (especially §3 Tool Surface for the three new estimate tools, §4 QBXML Round-Trip for `EstimateMod` / `TxnDelRq` / `InvoiceAddRq` chained-call shape, §5 Simulation Store for the new `Estimate` mod path, §6 Prior Tool Verification for `qb_invoice_update` / `qb_bill_update` / `qb_payment_apply` to make sure shared `applyLineMods` plumbing didn't regress), Item 13 marked `[x]` in `todo.md`, acceptance entry added (then moved to Completed) in [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md), README updated (estimate section bumped from 2-tool to 5-tool, tool count 50 → 53), `instructions` block in [src/index.ts](src/index.ts) updated, fresh `HANDOFF.md` pointing to the next Phase 4 task — Item 12 (the four missing transaction tool families: sales receipt / credit memo / PO / journal entry — biggest remaining Phase 4 work).
