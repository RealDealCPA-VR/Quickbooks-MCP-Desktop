# Handoff State

_Last updated: 2026-04-25_

## Last Session Summary

- Completed **Phase 3, Item 7** — `qb_bill_update` is registered, accepts `txnId` + `editSequence` + any header fields plus optional `expenseLines` / `itemLines` arrays. Lines use a **wholesale replacement with merge-by-TxnLineID** semantic: each entry's `txnLineID` (when present and matching) merges the mod's fields onto the existing line and preserves the original `TxnLineID`; absent or `'-1'` means new line. Lines NOT in the mod array are dropped from the bill.
- **Strict `EditSequence` validation** added globally to `handleMod` at [src/session/simulation-store.ts:646-661](src/session/simulation-store.ts#L646-L661) — any `*ModRq` whose `EditSequence` doesn't match the stored value rejects with statusCode 3170 and the message "EditSequence does not match." Affects every `*_update` tool in the project, not just Bill. Logged in [DECISIONS.md](DECISIONS.md).
- **Generic `applyLineMods` helper** at [src/session/simulation-store.ts:692-758](src/session/simulation-store.ts#L692-L758) handles `*LineMod` arrays for any entity. Item 6 (`qb_invoice_update` line mod) inherits this for free — only invoice-specific recompute (`Subtotal` / `BalanceRemaining` / `IsPaid`) and customer-balance adjustment remain to be wired.
- **`computeTotals` recompute** triggered for Bill mods that touched lines: at [src/session/simulation-store.ts:631-634](src/session/simulation-store.ts#L631-L634) the existing `AmountDue` is deleted and re-derived from the new line ledger.
- **Vendor balance bookkeeping** at [src/session/simulation-store.ts:781-836](src/session/simulation-store.ts#L781-L836) — same vendor: signed delta `(newAmountDue - oldAmountDue)`. Vendor change: full reverse-then-apply (old vendor `-= oldAmountDue`, new vendor `+= newAmountDue`). Vendor identity check uses `ListID` first, falls back to `FullName`.
- **Tool-layer try/catch** at [src/tools/bills.ts:280-291](src/tools/bills.ts#L280-L291) — wraps `session.modifyEntity` so 3170 / 500 surface as `isError: true` with `statusCode` instead of raw exceptions. Same pattern as Item 5's `qb_payment_receive`.
- **Two new zod schemas** in [src/tools/bills.ts:33-78](src/tools/bills.ts#L33-L78): `expenseLineModSchema` and `itemLineModSchema`. Each makes nearly every field optional and uses `.refine()` to require the create-shape fields only when `txnLineID` is absent or `'-1'` (i.e. the line is new).
- README + `instructions` block updated; tool count bumped 36 → 37; two new entries in `DECISIONS.md`.
- Verified with a 17-check inline script (deleted post-verification): bill setup, header-only mod, stale-sequence + non-mutation, unknown-TxnID, line merge with drop delta, new-line fresh ID + existing-line preservation, item lines alongside expense lines, item qty re-derivation, vendor change reverse-apply, customer/invoice update regressions, and bill create/delete regressions. `npm run build` green.

## Verify Before Continuing

- [ ] **Build.** `npm run build` exits 0.
- [ ] **Header-only memo mod.** Create a bill on `Office Supplies Co` via `qb_bill_create { vendorName: "Office Supplies Co", expenseLines: [{accountName: "Rent Expense", amount: 100}] }`. Capture the returned `TxnID` and `EditSequence`. Call `qb_bill_update { txnId, editSequence, memo: "header-only mod" }` and confirm: (a) `bill.Memo === "header-only mod"`, (b) `bill.EditSequence` differs from the create's, (c) `bill.AmountDue === 100`, (d) `bill.ExpenseLineRet.length === 1`.
- [ ] **Stale-EditSequence rejection.** Replay the SAME mod with the OLD `EditSequence` from the create call. Confirm `isError: true`, `statusCode === 3170`, and the bill's memo is unchanged from step 2 (failed mod must not mutate state).
- [ ] **Wholesale line replacement.** Create a 2-line bill on `Office Supplies Co` (rent 100, utilities 50). Capture `txnId` + `editSequence` + the rent line's `TxnLineID`. Call `qb_bill_update { txnId, editSequence, expenseLines: [{txnLineID: rentTxnLineID, memo: "kept"}] }`. Confirm: (a) `bill.ExpenseLineRet.length === 1`, (b) the surviving line preserves the original `TxnLineID`, (c) `bill.AmountDue === 100`, (d) vendor `Balance` decreased by 50 from before this mod.
- [ ] **Unknown TxnID rejection.** `qb_bill_update { txnId: "BILL-DOES-NOT-EXIST", editSequence: "anything", memo: "ghost" }` returns `isError: true` with statusCode 500.
- [ ] **Bill regression.** `qb_bill_create { vendorName: "Office Supplies Co", expenseLines: [{accountName: "Rent Expense", amount: 25}] }` still posts with `AmountDue === 25`.
- [ ] **Customer-update regression.** `qb_customer_update` with a fresh `editSequence` from `qb_customer_list` still succeeds (proves the global EditSequence check accepts a freshly-queried sequence).

## Next Task

**Phase 3, Item 6** in [todo.md:27](todo.md#L27):

> Add `InvoiceLineMod` support to `qb_invoice_update` — accept `lines` arg with optional `txnLineID` (existing line) or `'-1'` (new line) and build `InvoiceLineMod` blocks.

Item 6 is now significantly de-risked because Item 7 already established the line-mod plumbing in `applyLineMods`. The remaining Item 6 work is:

1. Extend [src/tools/invoices.ts](src/tools/invoices.ts) with an `invoiceLineModSchema` (mirror Item 7's `itemLineModSchema` shape — `txnLineID?` + `itemName?` / `itemListId?` + `quantity?` + `rate?` + `amount?` + `description?`).
2. Wire the `lines` arg in `qb_invoice_update` to build `InvoiceLineMod` blocks (the existing tool currently only takes header fields — see [src/tools/invoices.ts:135-172](src/tools/invoices.ts#L135-L172)).
3. Wrap `session.modifyEntity` in try/catch like Item 5/7 so 3170/500s surface cleanly.
4. Extend the `entityType === "Bill"` branch in `handleMod` ([src/session/simulation-store.ts:629-634](src/session/simulation-store.ts#L629-L634)) to also fire for `"Invoice"`. Invoice's `computeTotals` already recomputes `Subtotal` + `BalanceRemaining` + `IsPaid` — but note that `BalanceRemaining = Subtotal + SalesTaxTotal - AppliedAmount`, so a mod that drops a line on a fully-paid invoice would push `BalanceRemaining` negative. Decide: do we cap at 0 (with a warning), or accept the negative as a credit-balance signal? Pre-pickup recommendation: accept negative — that's how real QB represents over-applied invoices, and it lines up with `IsPaid = (BalanceRemaining === 0)` becoming `false`, signaling something is now wrong.
5. Add a `Customer`-equivalent of `adjustVendorBalanceForBillMod`. The signature is identical (different ref field, different store name) — strong candidate for extracting a generic `adjustPartyBalanceForTxnMod` helper that takes `partyType: "Customer" | "Vendor"`, the old/new entity, and the field to read (`AmountDue` for Bill, `BalanceRemaining` for Invoice). Worth doing as the same edit so Item 6 doesn't fork the helper.
6. Update README invoice table, `instructions` block, and `ACCEPTANCE_CRITERIA.md`.

Acceptance criteria are NOT pre-written for Item 6 — write them when picking it up, per the `(Don't pre-write criteria for distant tasks)` policy in [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md).

## Context Notes

- **`applyLineMods` is generic.** It walks `modData` for any key matching `/^(.+?)Line(s?)Mod$/` and produces the corresponding `*LineRet` replacement. So Item 6's `InvoiceLineMod` will work with no changes to that helper. Just wire the tool to send the right key.
- **Watch the customer-balance ref field.** Bills' `adjustVendorBalanceForBillMod` reads `VendorRef`. For Invoice, you want `CustomerRef` and the dollar field is `BalanceRemaining` (not `AmountDue`). Same machinery, different field names — extract a generic helper that takes both as parameters when you write the Invoice branch.
- **`AppliedAmount` interaction.** A line mod on a partially-paid invoice changes `Subtotal`. `BalanceRemaining = Subtotal + SalesTaxTotal - AppliedAmount`. If `Subtotal` shrinks below `AppliedAmount`, `BalanceRemaining` goes negative. Item 5's payment-application machinery already moved `AppliedAmount` and adjusted `Customer.Balance` accordingly. The Invoice line-mod path needs to recompute `BalanceRemaining` from the fresh `Subtotal` AND adjust `Customer.Balance` by the change in `BalanceRemaining` (NOT the change in `Subtotal` — the customer doesn't owe the discount or the applied portion). Concretely: if `Subtotal: 1000 → 800` and `AppliedAmount: 600`, then `BalanceRemaining: 400 → 200`, and `Customer.Balance` should drop by 200.
- **Verify existing payment-application bookkeeping survives.** Item 5 stores `AppliedToTxnRet` on the payment record and bumps `Invoice.AppliedAmount`. If a line mod reduces an invoice's Subtotal to zero, what happens to the persisted payment? In real QB the payment would still exist and would now be over-applied. The simulation does NOT cascade — the `ReceivePayment.AppliedToTxnRet` stays as recorded. Document the gap (or revisit Item 5's bookkeeping if it bites).
- **Optional `quantity` / `rate` / `amount` on Invoice line mod.** Mirror Item 7: optional in the schema, refine to require quantity+rate (or amount) only when `txnLineID` is absent. The existing `convertLineAddToRet` already handles both `quantity*rate` and explicit `amount` — the same logic in `applyLineMods` re-derives Amount from the merged line, so a mod that changes only quantity will get the new `Amount = newQty * existingRate` for free.
- **`IsPaid` flips automatically.** `computeTotals` sets `IsPaid = (BalanceRemaining === 0)` for Invoice. A line mod that recomputes Subtotal + BalanceRemaining will automatically flip IsPaid in either direction. No special handling needed.
- **Don't break the existing `qb_invoice_update` header path.** The tool currently takes `customerName?`, `customerListId?`, `txnDate?`, `dueDate?`, `refNumber?`, `memo?`. Keep all of those — just add `lines?`.
- **EditSequence is now strict.** Item 7 made `handleMod` reject mismatched `EditSequence` with 3170. So the Item 6 happy path must read a FRESH `EditSequence` from a prior `qb_invoice_list` (or from the previous mod's response) — chained mods using the same stale value will now fail. This is correct behavior; just be aware when writing the verification script.
- **Project conventions reminder** ([CLAUDE.md](CLAUDE.md) § Stable Code Conventions): TS strict, ESM with `.js` extensions on relative imports, every zod field has `.describe()`. Don't introduce a new `applyLineMods` — use the existing one.
- **No new dependencies.** Item 6 doesn't need any.

## Post-Task Chores

When Item 6 is done: `npm run build` green, [REGRESSION_CHECKLIST.md](REGRESSION_CHECKLIST.md) walked (especially §3 Tool Surface for `qb_invoice_update` with `lines`, §5 Simulation Store CRUD for Invoice `handleMod`, §6 Prior Tool Verification for `qb_bill_update`/`qb_payment_receive` to make sure the shared `handleMod` + `applyLineMods` + `EditSequence` plumbing didn't regress), Item 6 marked `[x]` in `todo.md`, acceptance entry added (then moved to Completed) in [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md), README invoice table updated, `instructions` block in [src/index.ts](src/index.ts) updated, fresh `HANDOFF.md` pointing to Item 8 (`qb_payment_apply` via `ReceivePaymentMod` — uses Item 5's `applyReceivePayment` helper from `handleMod` so the work is mostly tool-layer plus a small `handleMod` branch).
