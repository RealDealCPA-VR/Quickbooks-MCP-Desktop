# Handoff State

_Last updated: 2026-04-25_

## Last Session Summary

- Completed **Phase 3, Item 4** — `qb_bill_create` now accepts `expenseLines` and `itemLines`. Header-only bills are rejected with `isError: true`. `AmountDue` is the sum of all line amounts (computed by the simulation's existing `computeTotals` helper, no simulation-store changes needed).
- **Schema shape** at [src/tools/bills.ts](src/tools/bills.ts):
  - `expenseLines: [{accountName | accountListId, amount, memo?, className?}]` — each line carries `AccountRef` + `Amount`. Optional `className` flows to `ClassRef.FullName` for class tracking.
  - `itemLines: [{itemName | itemListId, quantity, cost, memo?}]` — each line carries `ItemRef` + `Quantity` + `Cost`, with `Amount = quantity * cost` computed in the tool layer (the simulation's line-converter only does `Quantity * Rate`, so the math has to happen here).
  - Per-line `.refine()` rejects expense lines without `accountName`/`accountListId` and item lines without `itemName`/`itemListId` — fires at the schema boundary, not in the handler.
- **Schema break: dropped the `amountDue` arg.** Lines are now the only source of bill total truth — matches real QB which derives `AmountDue` server-side. Logged at the top of [DECISIONS.md](DECISIONS.md) including a note about zod's default `unknownKeys: "strip"` (callers passing `amountDue` will silently lose it, not get a clear rejection — flag for whoever next debugs a "why is my bill total wrong" issue).
- Vendor balance auto-bumps via Item 18's `adjustPartyBalanceForTxn`; AP aging reflects new bills. No code changes to the simulation store — the existing integration just needed line-driven bills to start exercising it.
- README bill table updated with the line schemas and the `quantity * cost` math note. `instructions` block in [src/index.ts](src/index.ts) updated to flag that `qb_bill_create` requires lines.
- Verified end-to-end with a 35-check inline script (deleted post-verification): header-only rejection (incl. empty-arrays variant), expense-only with `Memo` preservation, item-only with `qty * cost` (12.5 → 62.5 line, 100 → 200 line), mixed bills, per-line ref validation, `accountListId` variant, vendor balance integration, AP aging integration, persistence via `qb_bill_list`, invoice regression (`INV-1001` BalanceRemaining still 7500), and `ClassRef` on expense lines. `npm run build` green.

## Verify Before Continuing

- [ ] **Build.** `npm run build` exits 0.
- [ ] **Header-only bill rejected.** `qb_bill_create { vendorName: "Office Supplies Co" }` (no lines) → `isError: true` with a message that names both `expenseLines` and `itemLines`.
- [ ] **Expense-only bill posts correctly.** `qb_bill_create { vendorName: "Office Supplies Co", expenseLines: [{ accountName: "Rent Expense", amount: 200 }, { accountName: "Rent Expense", amount: 150 }] }` succeeds with `AmountDue = 350` and `ExpenseLineRet` array of 2.
- [ ] **Item-only bill computes `qty * cost`.** `qb_bill_create { vendorName: "Office Supplies Co", itemLines: [{ itemName: "Widget A", quantity: 5, cost: 12.5 }] }` returns a bill with `ItemLineRet[0].Amount = 62.5` and `AmountDue = 62.5`.
- [ ] **Vendor balance moved.** After a bill posts, `qb_vendor_list` shows `Office Supplies Co` with a `Balance` increased by the bill's `AmountDue`. (Seed balance = 2500.)
- [ ] **Persistence.** Subsequent `qb_bill_list { refNumber: "BILL-EXP-1" }` (or whatever ref you used) returns the same `AmountDue` and `ExpenseLineRet` array — totals and lines survive a query round-trip.
- [ ] **Invoice regression.** `qb_invoice_list { refNumber: "INV-1001" }` still returns `BalanceRemaining: 7500` — the seed invoice is untouched by bill work.

## Next Task

**Phase 3, Item 5** in [todo.md:25](todo.md#L25):

> Add `AppliedToTxnAdd` support to `qb_payment_receive` — accept `appliedTo: [{txnId, amount, discountAmount?}]` so payments actually close out invoices and reduce customer balances.

Acceptance criteria pre-written at [ACCEPTANCE_CRITERIA.md § Item 5](ACCEPTANCE_CRITERIA.md#item-5--payment-applied-to-invoices-phase-3). Item 5 is the natural follow-on per `todo.md` ordering — bills now post to GL, so AR/AP work needs the matching payment-application piece to actually close out invoices and reduce customer balances.

## Context Notes

- **What `qb_payment_receive` looks like today** ([src/tools/payments.ts:16-72](src/tools/payments.ts#L16-L72)): accepts `customerName` / `customerListId`, `totalAmount`, optional `txnDate` / `refNumber` / `memo` / `paymentMethodName` / `depositToAccountName`. There's no way to apply the payment to specific invoices today — it lands as fully unapplied. The acceptance criterion adds an optional `appliedTo: [{txnId, amount, discountAmount?, discountAccountName?}]` array; calling without `appliedTo` should still work (legitimate prepayment / customer credit case).
- **Shape to build.** Real QBXML's `ReceivePaymentAdd` carries zero or more `AppliedToTxnAdd` blocks, each with `TxnID` (the invoice), `PaymentAmount`, optional `DiscountAmount` + `DiscountAccountRef`. The simulation's existing seed data has invoices that can be applied against — `INV-1001` for `Acme Corporation` (BalanceRemaining 7500) is a good target.
- **Side effects per applied invoice (acceptance criteria § Item 5).** For each applied invoice:
  1. Decrement `Invoice.BalanceRemaining` by the applied `amount`.
  2. Increment `Invoice.AppliedAmount` by the applied `amount`.
  3. If `BalanceRemaining` reaches 0, set `IsPaid = true`.
  4. Decrement `Customer.Balance` by the **applied** amount (NOT the gross payment) — unapplied amount stays on the customer as a credit.
- **Where to put the side-effect logic.** Two options:
  - **(a) In the simulation store's `handleAdd` for `ReceivePayment`.** Centralizes balance bookkeeping, keeps the tool layer thin, and means AR aging is correct regardless of whether the operator drove `qb_payment_receive` or future tools (Phase 3 items 8 + 9 — `qb_payment_apply` and `qb_bill_pay` — will both need similar logic).
  - **(b) In the tool handler.** Faster to implement but you'll re-implement it for `qb_payment_apply` later.
  - **Recommended: (a).** Item 18's `adjustEntityBalance` helper at [src/session/simulation-store.ts:432-459](src/session/simulation-store.ts#L432-L459) already takes a signed delta — pass a negative number for the applied amount per invoice. The invoice mutation (Balance/Applied/IsPaid) can be a small helper next to it. Phase 3 item 8 (`qb_payment_apply`, which mods an existing payment) will reuse the same helpers in `handleMod`, so writing them at the simulation-store level is the leverage path.
- **Don't double-charge customer balance.** When `qb_payment_receive` is called WITHOUT `appliedTo`, NO customer balance change happens (the payment is a customer credit, not a closing transaction — real QB only moves the customer balance once the credit is applied to an invoice). When called WITH `appliedTo`, customer balance moves by `sum(appliedTo.amount)`. Be careful: a previous instinct might have been to always move customer balance by `totalAmount` — that's wrong for this entity type.
- **`adjustPartyBalanceForTxn` won't help directly** ([src/session/simulation-store.ts:464-483](src/session/simulation-store.ts#L464-L483)). It assumes a fixed-direction add/delete delta for an Invoice/Bill, not a per-line application of an arbitrary amount. Use `adjustEntityBalance` directly with a negative delta and the customer ref off the payment header.
- **TxnID lookup gotcha.** `appliedTo[i].txnId` is the invoice's `TxnID`. The simulation's invoice store keys by `TxnID` directly (transaction store), so `this.getStore("Invoice").get(txnId)` works. If the lookup misses, the acceptance criterion is silent — use the same pattern as `adjustEntityBalance` (silent no-op for orphan refs) to avoid blocking payment creation, but consider: is "payment applied to nonexistent invoice" actually OK to silently swallow? Probably better to return statusCode 500 for an invalid `txnId` since the operator is explicitly identifying the target. Decision call — log it in `DECISIONS.md` if you go strict.
- **Discount handling.** `discountAmount` reduces `BalanceRemaining` *in addition to* the applied `amount`, and posts the discount to a P&L account (`DiscountAccountRef`). Acceptance criterion mentions it but doesn't prescribe behavior — recommend treating it as part of the close-out math (`BalanceRemaining -= amount + discountAmount`) but NOT counting it toward customer balance reduction (the customer didn't pay the discount, they got it). If unsure, defer the discount path to a follow-up — the simpler path of `discountAmount: 0` first proves the core flow works.
- **Unapplied amount in the response.** Acceptance says the unapplied amount must be "clearly returned in the response payload." The simulation should compute `UnusedPayment = TotalAmount - sum(appliedTo.amount)` and put it on the stored entity so `qb_payment_list` reflects it. The tool's response shape (`{ success: true, payment: result }`) already round-trips whatever the simulation returns, so adding the field at the simulation level is enough.
- **Project conventions reminder** ([CLAUDE.md](CLAUDE.md) § Stable Code Conventions): TS strict, ESM with `.js` extensions on relative imports, every zod field has `.describe()`. Per-line refinement pattern from Item 4's `expenseLineSchema` / `itemLineSchema` in [src/tools/bills.ts](src/tools/bills.ts) is the cleanest model to copy for the `appliedTo` line schema (require `txnId` + `amount`, optional `discountAmount` / `discountAccountName`).
- **No new dependencies.** Item 5 doesn't need any.

## Post-Task Chores

When Item 5 is done: `npm run build` green, [REGRESSION_CHECKLIST.md](REGRESSION_CHECKLIST.md) walked (especially §3 Tool Surface for `qb_payment_receive` and §5 Simulation Store CRUD for ReceivePayment + Invoice), Item 5 marked `[x]` in `todo.md`, acceptance entry moved to Completed in [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md), README payment table updated to mention `appliedTo`, fresh `HANDOFF.md` pointing to whatever's next (Phase 3 item 7 — `qb_bill_update` — is the natural follow-on per `todo.md` ordering since it stays in the transaction-completeness phase and reuses Item 4's `ExpenseLine*` / `ItemLine*` shape, just on the Mod side).
