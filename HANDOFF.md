# Handoff State

_Last updated: 2026-04-26_

## Last Session Summary

- Completed **Phase 3, Item 8** — `qb_payment_apply` re-targets an existing `ReceivePayment` to a different set of invoices via `ReceivePaymentMod` + `AppliedToTxnMod`. Atomic reverse-then-apply: the prior application is fully reversed (each invoice's `BalanceRemaining` / `AppliedAmount` / `IsPaid` restored, customer balance restored by the previously-applied sum), then the new application is run. Customer balance moves by the *change* in applied sum (new applied − old applied). Pass `applyTo: []` to fully unapply (payment becomes pure customer credit).
- **Validate → reverse → apply ordering** at [src/session/simulation-store.ts:766-820](src/session/simulation-store.ts#L766-L820). The new `validateTxnApplications` helper is called BEFORE `reverseReceivePaymentApplication`, so a doomed mod (orphan TxnID, overapplication > TotalAmount) returns 500 with payment + invoices completely untouched. This avoids the rollback-on-orphan edge case where a failed mod would leave the payment in a "fully reversed but not re-applied" state.
- **Engine refactor at [src/session/simulation-store.ts:336-505](src/session/simulation-store.ts#L336-L505)** — `applyReceivePayment` is now a thin shim that reads `AppliedToTxnAdd` off the payment and hands the line array to a shared `applyTxnApplications(payment, lines)` engine. The engine accepts both `Add`-shape and `Mod`-shape lines because it only reads `TxnID` / `PaymentAmount` / `DiscountAmount` / `DiscountAccountRef`. New `validateTxnApplications` is called inline by `applyTxnApplications` AND by `handleReceivePaymentMod` for early-exit validation. New `reverseReceivePaymentApplication` undoes a payment's existing application (tolerates orphan TxnIDs — moves customer balance by the named applied sum regardless of whether the target invoices still exist).
- **`handleReceivePaymentMod` at [src/session/simulation-store.ts:756-861](src/session/simulation-store.ts#L756-L861)** — new branch in `handleMod` that short-circuits before the Bill/Invoice line-mod plumbing (AppliedToTxnMod doesn't match `/^(.+?)Line(s?)Mod$/`). Reserved keys (`AppliedToTxnMod`, `AppliedToTxnRet`, `AppliedAmount`, `UnusedPayment`, `TotalAmount`, `TxnID`, `EditSequence`) stripped from the header merge — the engine owns those.
- **Tool layer** at [src/tools/payments.ts:130-194](src/tools/payments.ts#L130-L194). Reused the existing `appliedToSchema` (Item 5 shape: `txnId`, `amount`, optional `discountAmount` + `discountAccountName`). `applyTo` is required but accepts `applyTo: []` to fully unapply — forces explicit intent. Optional header fields (`memo`, `refNumber`, `txnDate`, `paymentMethodName`) propagate. try/catch wraps `session.modifyEntity` so 500s and 3170s surface as structured tool errors.
- README payment section + tool table updated; tool count 37 → 38; `instructions` block in [src/index.ts](src/index.ts) updated. ACCEPTANCE_CRITERIA.md Item 8 entry written and moved to Completed. No new DECISIONS.md entry — the validate-then-reverse-then-apply ordering falls naturally out of the existing two-pass pattern, and "TotalAmount is immutable on this path" matches real QB.
- Verified with an 84-check inline script (deleted post-verification): A1–A12 single-invoice apply, B1–B13 re-target with delta-zero balance, C1–C9 increase applied with positive delta, D1–D7 decrease applied with negative delta, E1–E8 full unapply via empty AppliedToTxnMod, F1–F7 discount preservation (DiscountAmount NOT counted toward AppliedAmount, doesn't move customer balance), G1–G4 stale-EditSequence rejection without rollback, H1–H6 orphan TxnID rejection with NO side effects (proves the validate-first ordering works), I1–I5 overapplication rejection, J1–J6 multi-invoice split, K1–K4 header field propagation through round-trip, L1 `qb_payment_receive` Item 5 regression, M1 `qb_invoice_update` Item 6 regression, N1 `qb_bill_update` Item 7 regression. `npm run build` green throughout.

## Verify Before Continuing

- [ ] **Build.** `npm run build` exits 0.
- [ ] **Apply unapplied payment.** Create an invoice via `qb_invoice_create { customerName: "Acme Corporation", lines: [{itemName: "Consulting Services", quantity: 1, rate: 1000}] }`. Capture `TxnID`. Create an unapplied payment via `qb_payment_receive { customerName: "Acme Corporation", totalAmount: 1000 }` (no `appliedTo`). Capture payment `TxnID` + `EditSequence`. Snapshot Acme balance via `qb_customer_list { nameFilter: "Acme" }`. Call `qb_payment_apply { txnId: <pay>, editSequence: <fresh>, applyTo: [{txnId: <inv>, amount: 1000}] }`. Confirm: (a) invoice `BalanceRemaining===0`, `IsPaid===true`, `AppliedAmount===1000`; (b) Acme balance dropped by 1000; (c) payment `AppliedAmount===1000`, `UnusedPayment===0`, payment carries 1 `AppliedToTxnRet` entry.
- [ ] **Re-target (delta-zero balance move).** Setup: two invoices on Acme each for $500; payment $500 applied to invoice A. Snapshot Acme balance. Call `qb_payment_apply` with `applyTo: [{txnId: <invB>, amount: 500}]` and a fresh editSequence. Confirm: (a) invA fully restored (`BalanceRemaining===500`, `AppliedAmount===0`, `IsPaid===false`); (b) invB closed; (c) Acme balance UNCHANGED (delta=0); (d) payment `AppliedToTxnRet` now points at invB only.
- [ ] **Fully unapply via empty array.** Setup: invoice $750, payment $750 applied to it. Snapshot Acme balance. Call `qb_payment_apply { txnId, editSequence: <fresh>, applyTo: [] }`. Confirm: (a) invoice `BalanceRemaining===750`, `AppliedAmount===0`, `IsPaid===false`; (b) Acme balance went UP by 750 (full restore); (c) payment `AppliedAmount===0`, `UnusedPayment===750`, `AppliedToTxnRet=[]`.
- [ ] **Orphan TxnID rejection — NO side effects.** Setup: invoice $1000, payment $1000 fully applied. Snapshot Acme balance + invoice state. Call `qb_payment_apply { txnId, editSequence: <fresh>, applyTo: [{txnId: "BOGUS-NOT-AN-INVOICE", amount: 500}] }`. Confirm: (a) tool returns `isError: true` with `statusCode: 500`; (b) the original invoice is STILL fully paid (`BR===0`, `IsPaid===true`); (c) Acme balance UNCHANGED from snapshot; (d) payment `AppliedAmount` STILL 1000. This is the critical validate-first invariant.
- [ ] **Overapplication rejection.** Setup: invoice $2000, unapplied payment $500. Call `qb_payment_apply { txnId, editSequence: <fresh>, applyTo: [{txnId: <inv>, amount: 700}] }`. Confirm: `isError: true`, `statusCode: 500`, invoice + payment untouched.
- [ ] **Stale EditSequence.** Apply a payment, then replay the same call with the OLD `editSequence`. Confirm `isError: true`, `statusCode: 3170`, no state change.
- [ ] **`qb_payment_receive` regression.** `qb_payment_receive { customerName: "Acme Corporation", totalAmount: 100, appliedTo: [{txnId: <fresh inv>, amount: 100}] }` still closes the invoice (Item 5 still works).
- [ ] **`qb_invoice_update` regression.** Header-only mod on a fresh invoice (`memo: "test"`) still propagates.
- [ ] **`qb_bill_update` regression.** Bill expense-line mod still recomputes `AmountDue` and moves vendor balance.

## Next Task

**Phase 3, Item 9** in [todo.md:29](todo.md#L29):

> Add `qb_bill_pay` tool — record `BillPaymentCheck` or `BillPaymentCreditCard` against existing bills (currently no way to mark a bill as paid).

This is the AP-side analog to Item 5's `qb_payment_receive`. Same conceptual shape (close out open transactions, move party balance, optional discount handling) but on the vendor/Bill side instead of customer/Invoice. The work splits into a tool-layer addition + a `handleAdd` branch:

1. **Two new tools in [src/tools/bills.ts](src/tools/bills.ts)** (or a new [src/tools/bill-payments.ts](src/tools/bill-payments.ts)) — `qb_bill_pay_check` (BillPaymentCheck) and `qb_bill_pay_credit_card` (BillPaymentCreditCard). Or a single `qb_bill_pay` with a `paymentMethod: "check" | "creditcard"` discriminator that routes between the two. **Decision needed at pickup**: real QB uses two separate request types (`BillPaymentCheckAddRq` vs `BillPaymentCreditCardAddRq`) and two separate Ret element names — splitting the tools matches QB more cleanly, but a single tool with a discriminator is friendlier for AI callers. Item 5's `qb_payment_receive` precedent uses one tool because there's only one ReceivePayment type; here we have two, so the choice is genuinely open. Recommend single-tool-with-discriminator for ergonomics, route to the right entity type in the handler.

2. **`AppliedToTxnAdd` shape on bill payments** — same shape as Item 5's payment side, but the named entity is a `Bill` (not an `Invoice`) and `PaymentAmount` reduces `Bill.AmountDue` and `Vendor.Balance`. Reuse the `appliedToSchema` shape from [src/tools/payments.ts:9-16](src/tools/payments.ts#L9-L16) (the field names match: `txnId`, `amount`, optional `discountAmount` / `discountAccountName`).

3. **New `handleAdd` branch in simulation-store** — analog to `applyReceivePayment`:
   - Validate every bill TxnID exists (atomicity — orphan in line N must NOT mutate lines 1..N-1).
   - Walk the lines: `bill.AmountDue -= paymentAmount + discountAmount`, mark bill paid when `AmountDue <= 0` (real QB has `IsPaid` on bills too — check the type definitions).
   - Move `Vendor.Balance` by `-appliedSum` (vendor side analog to customer-balance move).
   - Bill `IsPaid` flip when `AmountDue === 0` — verify the field exists on existing bills; if not, add it via `computeTotals` for parity.
   - Build `AppliedToTxnRet` array on the bill payment entity.

4. **Parser arrayElements** — add `BillPaymentCheckRet`, `BillPaymentCreditCardRet` to [src/qbxml/parser.ts:28-70](src/qbxml/parser.ts#L28-L70) if not already there (check first). `AppliedToTxnRet` is already there from Item 5.

5. **Builder** — `buildAddRequest("BillPaymentCheck", data)` should work without changes; the builder is entity-agnostic.

6. **`isTransactionType`** — `BillPaymentCheck` and `BillPaymentCreditCard` are already in the list at [src/session/simulation-store.ts:982-986](src/session/simulation-store.ts#L982-L986). No change needed.

7. **Companion `qb_bill_payment_list` tool** — operators need to query existing bill payments. Same shape as `qb_payment_list`: `vendorName`, `fromDate`, `toDate`, `maxReturned`. Decide at pickup whether one tool that fans out across both BillPaymentCheck + BillPaymentCreditCard stores, or two separate tools. Recommend one tool with a `paymentType?` filter for symmetry with `qb_item_list`'s fan-out approach.

8. Update README bill section, `instructions` block in [src/index.ts](src/index.ts), tool count, ACCEPTANCE_CRITERIA.md.

Acceptance criteria are NOT pre-written for Item 9 — write them when picking it up.

## Context Notes

- **Item 5's `applyReceivePayment` and Item 8's `applyTxnApplications` are the model.** Item 9 is structurally identical on the AP side: validate first, mutate second, atomic on failure. Consider extracting a generic `applyTxnPayments` helper that takes `(targetEntityType, balanceField, partyType, refField)` so both ReceivePayment and BillPayment* can call it. Or keep them parallel (less abstraction, more duplication) — judgement call at pickup.
- **`Bill.IsPaid` field check needed.** [computeTotals at src/session/simulation-store.ts:497-533](src/session/simulation-store.ts#L497-L533) only sets `IsPaid` on Invoice today (`AmountDue` for bills doesn't get the corresponding `IsPaid` flip). Item 9 should extend `computeTotals` to set `Bill.IsPaid = (AmountDue === 0)` symmetrically with the invoice path. May need to check existing bill-create / bill-update behavior post-change to make sure nothing breaks.
- **Discount handling parity.** Mirror Item 5/8: `DiscountAmount` reduces `AmountDue` alongside the payment but does NOT count toward the applied sum and does NOT move `Vendor.Balance`. Discount posts to the named expense/income account (DiscountAccountRef) — but the simulation doesn't track GL postings yet (Phase 5 territory), so just preserve the field on the response.
- **`isTransactionType` covers BillPaymentCheck + BillPaymentCreditCard already** — confirmed in the existing list. The simulation will route `BillPaymentCheckAddRq` → `BillPaymentCheck` store automatically.
- **Vendor.Balance reduction on bill payment.** Use `adjustEntityBalance("Vendor", refKey, -appliedSum)` — same helper Item 18 + Item 5 use. Vendor doesn't have `TotalBalance` (only Customer does); the helper already handles that distinction.
- **No `qb_bill_payment_apply` analog needed for Item 9.** Item 8 was about re-targeting an existing payment. Item 9 is just the Add path. The mod-path (re-target a bill payment) is implicitly Phase 4 work if anyone wants it — leave a note in the handoff if it seems pressing.
- **Parser arrayElements check.** Currently [src/qbxml/parser.ts:28-70](src/qbxml/parser.ts#L28-L70) has `PaymentRet` and `ReceivePaymentRet`. `BillPaymentCheckRet` and `BillPaymentCreditCardRet` are NOT in the set yet — add them when wiring Item 9. Also confirm `BillPayment*` exist in real QB SDK as those exact names (they do — verified against Intuit docs).
- **`appliedToSchema` reuse.** It's currently exported only via the closure in `registerPaymentTools`. If Item 9 lives in `bills.ts`, either duplicate the schema (cheap, 8 lines) or hoist it to a shared location like [src/tools/_shared.ts](src/tools/_shared.ts). Recommend duplication — not enough share-pressure yet to justify a new file.
- **Project conventions reminder** ([CLAUDE.md](CLAUDE.md) § Stable Code Conventions): TS strict, ESM with `.js` extensions on relative imports, every zod field has `.describe()`. `.refine()` for cross-field validation when needed.
- **No new dependencies.** Item 9 doesn't need any.
- **Verification-script gotcha** still applies (see Item 6/7 handoffs): `queryEntity` returns references INTO the simulation store — read `.Balance` later returns the latest mutated value, not a snapshot. Use a helper like `async function getVendorBalance(name) { ... return Number(r[0]?.Balance ?? 0); }` to capture as a Number at query time.
- **TotalAmount immutability convention from Item 8.** When Item 9's Add path lands, the BillPayment's `TotalAmount` should also be treated as immutable on any future Mod path. Document the precedent if it comes up.

## Post-Task Chores

When Item 9 is done: `npm run build` green, [REGRESSION_CHECKLIST.md](REGRESSION_CHECKLIST.md) walked (especially §3 Tool Surface for the new `qb_bill_pay*` tool(s); §5 Simulation Store CRUD for BillPaymentCheck + BillPaymentCreditCard `handleAdd`; §6 Prior Tool Verification for `qb_bill_create` / `qb_bill_update` / `qb_payment_receive` to make sure shared plumbing didn't regress), Item 9 marked `[x]` in `todo.md`, acceptance entry added (then moved to Completed) in [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md), README bill section updated with the new tool(s), tool count bumped (38 → 39 or 40 depending on one-tool-vs-two split), `instructions` block in [src/index.ts](src/index.ts) updated with `qb_bill_pay*` semantics, fresh `HANDOFF.md` pointing to the next Phase 4 task — likely Item 10 (`qb_account_delete` / `qb_account_make_inactive`) since Phase 3 is complete after Item 9.
