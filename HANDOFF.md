# Handoff State

_Last updated: 2026-04-26_

## Last Session Summary

- Completed **Phase 3, Item 6** — `qb_invoice_update` now accepts a `lines` array with optional `txnLineID` per entry. The same wholesale-replacement-with-merge-by-TxnLineID semantic as Item 7 applies: lines listed by `TxnLineID` are merged in place; lines without `TxnLineID` (or `'-1'`) are added new; lines NOT listed are dropped. After a line mod, `Subtotal`, `BalanceRemaining`, and `IsPaid` recompute via `computeTotals`. `AppliedAmount` is preserved. Customer `Balance` adjusts by `newBalanceRemaining - oldBalanceRemaining` (signed delta on same customer; full reverse-then-apply on customer change).
- **Negative `BalanceRemaining` policy** — when a line mod drops `Subtotal` below `AppliedAmount`, `BalanceRemaining` goes negative (over-application state) and `IsPaid` becomes `false`. No clamping. Verified at G5/G6/G7 in the inline script: `Subtotal: 1000 → 300, AppliedAmount: 600` produces `BalanceRemaining = -300`, customer balance moves by `(-300) - 400 = -700`.
- **Generalized `adjustVendorBalanceForBillMod` → `adjustPartyBalanceForTxnMod`** at [src/session/simulation-store.ts:798-867](src/session/simulation-store.ts#L798-L867). Takes `partyType` ("Customer" | "Vendor"), `refField` ("CustomerRef" | "VendorRef"), and `amountField` ("AmountDue" | "BalanceRemaining"). Same machinery covers Bill mods (vendor side) and Invoice mods (customer side). Bill behavior unchanged.
- **Pre-mod amount capture branches on entityType** at [src/session/simulation-store.ts:672-677](src/session/simulation-store.ts#L672-L677): Bill captures `existing.AmountDue`, Invoice captures `existing.BalanceRemaining`, both BEFORE `applyLineMods` runs.
- **Recompute branch in handleMod** at [src/session/simulation-store.ts:702-710](src/session/simulation-store.ts#L702-L710) now fires for both Bill and Invoice. Bill needs `delete updated.AmountDue` first (computeTotals only sets it when undefined); Invoice doesn't (computeTotals always overwrites Subtotal/BalanceRemaining/IsPaid).
- **Tool layer** in [src/tools/invoices.ts:18-46](src/tools/invoices.ts#L18-L46): new `invoiceLineModSchema` mirrors Item 7's pattern — every field optional, refine requires `itemName`/`itemListId` AND a way to derive Amount (`amount` OR `quantity + rate`) ONLY when `txnLineID` is absent or `'-1'`. `qb_invoice_update` at [src/tools/invoices.ts:166-237](src/tools/invoices.ts#L166-L237) builds `InvoiceLineMod` blocks when `args.lines` is provided and wraps `session.modifyEntity` in try/catch so 3170/500 surface as structured tool errors.
- README invoice section + tool table updated; `instructions` block in [src/index.ts](src/index.ts) updated. ACCEPTANCE_CRITERIA.md Item 6 entry written and moved to Completed. No new DECISIONS.md entry — Item 7's "Bill line-mod uses wholesale replacement" already documents the generic line-mod approach.
- **Bonus fix** — found and fixed an `EditSequence` collision bug introduced during the pickup verification: `new Date().toISOString()` returned identical strings when create + mod landed in the same millisecond, silently breaking stale-sequence rejection. New `nextEditSequence()` helper at [src/session/simulation-store.ts:933-940](src/session/simulation-store.ts#L933-L940) appends the existing monotonic `idCounter` to the ISO stamp. Logged in DECISIONS.md (top entry).
- Verified with a 61-check inline script (deleted post-verification): A1–A7 setup with line totals + customer balance bump, B1–B9 header-only mod with full preservation, C1–C3 stale-EditSequence rejection with no mutation, D1–D10 wholesale line drop with field merge + balance delta, E1–E6 new-line addition with fresh TxnLineID, F1–F6 quantity-only mod re-deriving Amount via existing rate, G1–G7 over-application with negative BalanceRemaining + customer balance delta, H1–H4 customer-change reverse-then-apply, I1/I2 unknown-TxnID rejection, K1–K3 `qb_bill_update` regression, L1 `qb_customer_update` regression, M1/M2 `qb_invoice_create` regression, N1 `qb_invoice_delete` regression. `npm run build` green.

## Verify Before Continuing

- [ ] **Build.** `npm run build` exits 0.
- [ ] **Header-only memo mod.** Create an invoice via `qb_invoice_create { customerName: "Acme Corporation", lines: [{itemName: "Consulting Services", quantity: 2, rate: 100}] }`. Capture `TxnID` and `EditSequence`. Call `qb_invoice_update { txnId, editSequence, memo: "header-only inv mod" }` and confirm: (a) `invoice.Memo === "header-only inv mod"`, (b) `EditSequence` differs, (c) `Subtotal === 200`, (d) `BalanceRemaining === 200`, (e) `InvoiceLineRet.length === 1`, (f) `AppliedAmount === 0`.
- [ ] **Wholesale line replacement.** Create a 2-line invoice on Acme (lines: `{Consulting, qty 2, rate 100}` and `{Consulting, qty 1, rate 50}`). Capture `txnId` + `editSequence` + the first line's `TxnLineID`. Call `qb_invoice_update { txnId, editSequence, lines: [{txnLineID: line1Id, description: "kept"}] }`. Confirm: (a) `InvoiceLineRet.length === 1`, (b) survivor preserves `TxnLineID` AND `Rate=100`, (c) `Subtotal === 200` AND `BalanceRemaining === 200`, (d) Acme `Balance` decreased by 50 from before this mod.
- [ ] **Stale-EditSequence rejection.** Replay the same line mod with the OLD `EditSequence`. Confirm `isError: true`, `statusCode === 3170`, and the invoice's lines are unchanged.
- [ ] **Negative BalanceRemaining (over-apply).** Create an invoice for $1000 on Acme. Apply a $600 payment via `qb_payment_receive`. Confirm `AppliedAmount === 600`, `BalanceRemaining === 400`. Then call `qb_invoice_update { txnId, editSequence: <fresh>, lines: [{txnLineID: <line>, quantity: 1, rate: 300}] }`. Confirm `Subtotal === 300`, `AppliedAmount === 600` (preserved), `BalanceRemaining === -300`, `IsPaid === false`. Acme `Balance` should move by `(newBR - oldBR) = -300 - 400 = -700`.
- [ ] **`qb_bill_update` regression.** `qb_bill_create` on `Office Supplies Co` with `expenseLines: [{accountName: "Rent Expense", amount: 100}]`. Then `qb_bill_update { txnId, editSequence, expenseLines: [{accountName: "Rent Expense", amount: 250}] }`. Confirm `AmountDue === 250` and vendor `Balance` moved by `+150`.
- [ ] **`qb_payment_receive` regression.** `qb_payment_receive { customerName: "Acme Corporation", totalAmount: 100, appliedTo: [{txnId: <invoice>, amount: 100}] }` against a fresh invoice still closes the invoice (`IsPaid=true`, `BalanceRemaining=0`).

## Next Task

**Phase 3, Item 8** in [todo.md:28](todo.md#L28):

> Add `qb_payment_apply` tool — apply an existing unapplied `ReceivePayment` to specific invoices via `ReceivePaymentMod` + `AppliedToTxnMod`.

This is the natural follow-on to Item 5 (which records payments) and Item 6/7 (which exercise the `*Mod` line-mod plumbing). The work splits cleanly into a tool-layer addition + a `handleMod` branch:

1. **New tool in [src/tools/payments.ts](src/tools/payments.ts)** — `qb_payment_apply { txnId, editSequence, applyTo: [{txnId, amount, discountAmount?, discountAccountName?}] }`. Same `appliedToSchema` already exists in payments.ts — reuse it. Build a `ReceivePaymentMod` request with `AppliedToTxnMod` blocks and pass through `session.modifyEntity("ReceivePayment", data)`. Wrap in try/catch like Item 5/7.

2. **`handleMod` branch for ReceivePayment** — add a new branch alongside the existing Bill/Invoice branches. Read the existing payment, validate it (EditSequence check is already global), then call a NEW helper `applyReceivePaymentMod(payment, modData)` that:
   - Validates each `AppliedToTxnMod.TxnID` exists in the invoice store (atomic — pass 1 validates all, pass 2 mutates).
   - Reverses any existing application from the payment (read `payment.AppliedToTxnRet`, walk each entry, undo the prior bumps to `Invoice.BalanceRemaining` / `Invoice.AppliedAmount` / `Invoice.IsPaid`, undo the `Customer.Balance` move).
   - Applies the new application set (same logic as `applyReceivePayment` from Item 5).
   - Recomputes `payment.AppliedAmount` + `payment.UnusedPayment` from the new `AppliedToTxnRet` array.

3. **Customer balance bookkeeping** — moves by the *change* in applied sum: if old applied was 600 and new applied is 1000, customer Balance drops by 400 (new applied - old applied).

4. Update README payment section, `instructions` block, ACCEPTANCE_CRITERIA.md.

Acceptance criteria are NOT pre-written for Item 8 — write them when picking it up, per the `(Don't pre-write criteria for distant tasks)` policy in [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md).

## Context Notes

- **Item 5's `applyReceivePayment` helper at [src/session/simulation-store.ts:353-437](src/session/simulation-store.ts#L353-L437) is the model.** Two-pass design (validate-first, mutate-second) for atomicity. The Item 8 path needs a *third* pre-pass: reverse the existing application before applying the new one, OR compute the per-invoice delta and apply only the delta. The reverse-then-apply approach is cleaner because it reuses the existing helper unchanged for the apply pass.
- **Reversal mechanics.** For each entry in `payment.AppliedToTxnRet`, look up the named invoice and: `invoice.AppliedAmount -= entry.PaymentAmount`, `invoice.BalanceRemaining += entry.PaymentAmount + (entry.DiscountAmount ?? 0)`, `invoice.IsPaid = (invoice.BalanceRemaining === 0)`. Customer balance: `+= sum(payment.AppliedToTxnRet[].PaymentAmount)` (reverses the Item 5 negative delta). This handles the case where the operator changes which invoices a payment closes.
- **Discount handling.** Same as Item 5 — `DiscountAmount` reduces `BalanceRemaining` but does NOT count toward `AppliedAmount` or move customer balance. Mirror the comment at [src/session/simulation-store.ts:395-397](src/session/simulation-store.ts#L395-L397).
- **`UnusedPayment` recompute.** `payment.UnusedPayment = payment.TotalAmount - sum(new applied amounts)`. If the operator increases applied amounts beyond `TotalAmount`, reject (statusCode 500 or similar) — same overapplication rejection that Item 5's tool layer enforces. Worth pulling into the simulation as well since `qb_payment_apply` is a different code path.
- **`payment.TotalAmount` is immutable in this path.** `qb_payment_apply` only changes the application; if the operator wants to change the payment amount itself, that's a different mod (and `qb_payment_receive` doesn't support `update` today). Don't accept `totalAmount` as an arg.
- **EditSequence is now strict** (Item 7's invariant). Operators must read a FRESH `EditSequence` from `qb_payment_list` before calling `qb_payment_apply`. Mention this in the tool description.
- **`AppliedToTxnRet` array preservation through round-trip.** The parser's `arrayElements` already includes `AppliedToTxnRet` (added by Item 5 at [src/qbxml/parser.ts:46](src/qbxml/parser.ts#L46)). When the simulation rebuilds the array post-mod, fast-xml-parser's normalization will keep it as an array even with a single entry.
- **Shared helper opportunity.** If Item 8's reversal logic is clean, extract `reverseReceivePaymentApplication(payment)` as a private helper. It can then be called from `handleTxnDel` for ReceivePayment too — currently `qb_payment_delete` doesn't exist as a tool but if it lands in Phase 4, the same reversal applies.
- **Don't break Item 5's `qb_payment_receive`.** It still works as-is. Item 8 is purely additive: a new tool + a new branch in `handleMod`. The Add-time `applyReceivePayment` helper stays.
- **Project conventions reminder** ([CLAUDE.md](CLAUDE.md) § Stable Code Conventions): TS strict, ESM with `.js` extensions on relative imports, every zod field has `.describe()`. `.refine()` for cross-field validation.
- **No new dependencies.** Item 8 doesn't need any.
- **Verification-script gotcha** discovered this session: `queryEntity` returns references INTO the simulation store, so reading `.Balance` later returns the latest mutated value rather than a snapshot. Use a helper like `async function getCustomerBalance(name) { ... return Number(r[0]?.Balance ?? 0); }` to capture the value as a Number at query time. Otherwise checks like "balance unchanged after header-only mod" can pass spuriously when a later mod has already moved the balance.

## Post-Task Chores

When Item 8 is done: `npm run build` green, [REGRESSION_CHECKLIST.md](REGRESSION_CHECKLIST.md) walked (especially §3 Tool Surface for `qb_payment_apply` with reversal + new application; §5 Simulation Store CRUD for ReceivePayment `handleMod`; §6 Prior Tool Verification for `qb_payment_receive`/`qb_invoice_update`/`qb_bill_update` to make sure the `handleMod` shared plumbing didn't regress), Item 8 marked `[x]` in `todo.md`, acceptance entry added (then moved to Completed) in [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md), README payment table updated, `instructions` block in [src/index.ts](src/index.ts) updated, fresh `HANDOFF.md` pointing to Item 9 (`qb_bill_pay` — `BillPaymentCheck` / `BillPaymentCreditCard` against existing bills, AP-side analog to Item 5's `qb_payment_receive`).
