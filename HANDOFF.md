# Handoff State

_Last updated: 2026-04-25_

## Last Session Summary

- Completed **Phase 3, Item 5** — `qb_payment_receive` now accepts `appliedTo: [{txnId, amount, discountAmount?, discountAccountName?}]` and closes out invoices end-to-end.
- **Side-effect bookkeeping** centralized in a new `applyReceivePayment` helper at [src/session/simulation-store.ts:332-432](src/session/simulation-store.ts#L332-L432). Two-pass design (validate every TxnID first, then apply) guarantees atomicity — an orphan ref in line 5 of 5 leaves lines 1-4 untouched.
- **Per-application mutations:** invoice `BalanceRemaining -= (PaymentAmount + DiscountAmount)`, `AppliedAmount += PaymentAmount`, `IsPaid = (BalanceRemaining === 0)`. Customer `Balance -= sum(PaymentAmount)` (NOT `TotalAmount` — discount is not deducted from customer balance, and unapplied amount stays as a credit on the payment record via `UnusedPayment = TotalAmount - sum(PaymentAmount)`).
- **Strict TxnID validation:** unknown `txnId` rejects the whole payment with statusCode 500 and the bad TxnID in the message. Logged as a deliberate behavior call at the top of [DECISIONS.md](DECISIONS.md) — the asymmetry with Item 18's silent no-op for orphan refs is intentional (operator explicitly named a target).
- **Tool-layer overapplication check** at [src/tools/payments.ts:50-63](src/tools/payments.ts#L50-L63): `sum(appliedTo.amount) > totalAmount` rejects with `+1e-9` floating-point slack. Returns a structured tool error before any QBXML is built so live mode also gets the friendly message.
- **Tool-layer try/catch** wraps `session.addEntity` so the strict-TxnID 500 surfaces as `isError: true` instead of a raw exception. Pattern is candidate for replication when Phase 6 item 25 lands.
- Parser's `arrayElements` set now includes `AppliedToTxnRet` and `ReceivePaymentRet` so live mode parses single-application responses as a 1-element array (matches multi-application shape).
- Verified with a 51-check inline script (deleted post-verification): all 6 acceptance bullets, prepayment-without-appliedTo path, partial application + full closeout + IsPaid flip, unapplied-as-credit case, multi-invoice application, discount handling with proper customer-balance + AppliedAmount semantics, strict-TxnID rejection, overapplication rejection, missing-customer regression, persistence via `qb_payment_list`, and AR aging smoke. `npm run build` green.

## Verify Before Continuing

- [ ] **Build.** `npm run build` exits 0.
- [ ] **Prepayment without `appliedTo` succeeds.** `qb_payment_receive { customerName: "Acme Corporation", totalAmount: 500 }` returns `payment.AppliedAmount === 0`, `payment.UnusedPayment === 500`, and `Acme.Balance` is unchanged from its current value.
- [ ] **Partial application moves both balances.** `qb_payment_receive { customerName: "Acme Corporation", totalAmount: 3000, appliedTo: [{ txnId: "T0000001-INV", amount: 3000 }] }` decrements `INV-1001.BalanceRemaining` by 3000 and `Acme.Balance` by 3000. Note the seed `INV-1001` is the only invoice with that TxnID — only run this once per session, or it'll move the balance further on each repeat.
- [ ] **Closeout flips `IsPaid`.** A second payment that drains the remaining `BalanceRemaining` returns the invoice with `BalanceRemaining === 0` and `IsPaid === true`.
- [ ] **Strict TxnID rejection.** `qb_payment_receive { customerName: "Acme Corporation", totalAmount: 100, appliedTo: [{ txnId: "DOES-NOT-EXIST", amount: 100 }] }` returns `isError: true` with the bad TxnID named in the message.
- [ ] **Overapplication rejection.** `qb_payment_receive { customerName: "Acme Corporation", totalAmount: 100, appliedTo: [{ txnId: "T0000001-INV", amount: 200 }] }` returns `isError: true` with a message that mentions `exceeds`.
- [ ] **Persistence.** Subsequent `qb_payment_list { customerName: "Acme Corporation" }` returns the partial payment with `AppliedAmount` and `AppliedToTxnRet` intact.
- [ ] **Bill regression.** `qb_bill_create { vendorName: "Office Supplies Co", expenseLines: [{ accountName: "Rent Expense", amount: 50 }] }` still posts with `AmountDue === 50` (Item 4 still works).

## Next Task

**Phase 3, Item 7** in [todo.md:26](todo.md#L26):

> Implement `qb_bill_update` tool (`BillModRq`) — header fields plus `ExpenseLineMod` / `ItemLineMod` support, register in `index.ts`.

Item 7 is recommended over Item 6 (`qb_invoice_update` line mod) because Item 7 reuses Item 4's exact `expenseLineSchema` / `itemLineSchema` patterns from [src/tools/bills.ts:9-31](src/tools/bills.ts#L9-L31) — same field names, same `accountName | accountListId` / `itemName | itemListId` refinement. Item 6 introduces a different beast: `InvoiceLineMod` blocks need the `txnLineID` (existing line) or `'-1'` (new line) sentinel, which is its own design problem worth tackling separately.

Acceptance criteria are NOT pre-written for Item 7 — write them when picking it up, per the `(Don't pre-write criteria for distant tasks)` policy in [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md).

## Context Notes

- **Where bill modification differs from creation.** `qb_bill_create` is in [src/tools/bills.ts:76-172](src/tools/bills.ts#L76-L172). The shape for `qb_bill_update` will be similar but takes `txnId` + `editSequence` (mandatory for any QB Mod), and the line schemas will need a `txnLineID` field — present means "modify existing line," absent (or `'-1'`) means "add new line." Use `BillMod` request type at the QBXML level; the manager's `modifyEntity("Bill", ...)` already wires `BillModRq` ↔ `BillModRs`.
- **Stale `editSequence` is a real failure mode.** Real QB rejects with statusCode 3170. The simulation's `handleMod` at [src/session/simulation-store.ts:489-545](src/session/simulation-store.ts#L489-L545) currently does NOT validate `editSequence` — it just `...spreads` the mod data over the existing entity. Decision call: do you tighten `handleMod` to validate `EditSequence` to match live, or document the gap and defer? Tightening it is one branch (`if (modData.EditSequence && modData.EditSequence !== existing.EditSequence) return 3170`). Recommended to tighten it — three lines of code prevents a class of "the simulation says it worked but live would reject" bugs that bite operators when they cut over to a Windows box. Log in DECISIONS.md if you go strict.
- **`AmountDue` recompute on line mod.** When lines change on a Mod, the bill's `AmountDue` must recompute (otherwise the header total drifts from the line ledger). The `computeTotals` helper at [src/session/simulation-store.ts:379-415](src/session/simulation-store.ts#L379-L415) already does this for Adds — call it from `handleMod` AFTER applying the mod's line replacements. The line-mod path replaces lines wholesale rather than diffing (real QB's `*LineMod` actually supports both add-new and modify-existing semantics; the simulation can take a simpler "the mod's line array is the new line array" stance and document the gap).
- **Vendor balance recompute on line mod.** If `AmountDue` changes via a line mod, the vendor's `Balance` is now stale. Approach: in `handleMod` for a Bill, capture `oldAmount = existing.AmountDue` BEFORE the mutation, recompute totals AFTER, then call `adjustEntityBalance("Vendor", ref, newAmount - oldAmount)`. The signed delta machinery is already there from Item 18.
- **Schema reuse for lines.** Don't duplicate the schemas — export `expenseLineSchema` and `itemLineSchema` from [src/tools/bills.ts](src/tools/bills.ts) (or move them up to module scope as already-named consts and add a `txnLineID?: string` optional field — same schema works for both `Add` and `Mod`). Cleanest is probably a separate `expenseLineModSchema` that extends the create schema with `txnLineID?: string`, since refinement requirements differ slightly (Mod with a `txnLineID` doesn't need to require `accountName` — the existing line already has one).
- **Where to register.** Add `server.tool("qb_bill_update", ...)` to `registerBillTools` in [src/tools/bills.ts](src/tools/bills.ts), update the README bill table (3rd entry between `qb_bill_create` and `qb_bill_delete`), update the `instructions` block in [src/index.ts:86](src/index.ts#L86) (the bill bullet) to mention `qb_bill_update`, and add to the `qb_bill_*` line in `instructions`.
- **Don't accidentally mutate Item 5's invoice closeout.** A future `qb_bill_update` test creates bills against `Office Supplies Co`. Don't touch invoices in the verification — Item 5 left `INV-1001` fully paid and seed `INV-1002` (Global Industries, BalanceRemaining 8500) untouched; either is fine to use as a "shouldn't move" regression check.
- **Project conventions reminder** ([CLAUDE.md](CLAUDE.md) § Stable Code Conventions): TS strict, ESM with `.js` extensions on relative imports, every zod field has `.describe()`. The `txnLineID` arg should NOT use `.refine()` for "either txnLineID or accountName" — it's a clean optional field that means "modify this line if present, otherwise add a new line."
- **No new dependencies.** Item 7 doesn't need any.

## Post-Task Chores

When Item 7 is done: `npm run build` green, [REGRESSION_CHECKLIST.md](REGRESSION_CHECKLIST.md) walked (especially §3 Tool Surface for `qb_bill_update` and §5 Simulation Store CRUD for Bill `handleMod`), Item 7 marked `[x]` in `todo.md`, acceptance entry added (then moved to Completed) in [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md), README bill table updated, `instructions` block in [src/index.ts](src/index.ts) updated, fresh `HANDOFF.md` pointing to Item 6 (`qb_invoice_update` line mod — the natural next step since Items 7 + 6 share the line-mod design problem and 7 establishes the baseline).
