# Handoff State

_Last updated: 2026-04-25_

## Last Session Summary

- Completed **Phase 1, Item 17** — `simulation-store.handleAdd` now converts every `*LineAdd` array on transaction entities into a `*LineRet` array, with a generated `TxnLineID` per line and `Amount` resolved as `Quantity * Rate` → explicit `Amount` → `0`. Generic helper `convertLinesAddToRet` at [src/session/simulation-store.ts:312-359](src/session/simulation-store.ts#L312-L359) scans for any key matching `/^(.+?)Line(s?)Add$/`, so Bill's parallel `ExpenseLineAdd` + `ItemLineAdd` and every Phase 3 transaction tool get correct conversion in one pass without per-subtype dispatch.
- Adopted real QBXML element names (`ExpenseLineRet` / `ItemLineRet` for Bill — no Bill prefix) instead of the handoff's draft `BillExpenseLineRet` / `BillItemLineRet`, because live mode returns the standard names. Same conversion fires for `EstimateLineAdd → EstimateLineRet`, `SalesReceiptLineAdd → SalesReceiptLineRet`, etc.
- Extended parser `arrayElements` at [src/qbxml/parser.ts:39-55](src/qbxml/parser.ts#L39-L55) with `ExpenseLineRet`, `ItemLineRet`, `SalesReceiptLineRet`, `CreditMemoLineRet`, `PurchaseOrderLineRet`, `SalesOrderLineRet`, `DepositLineRet` so single-line live responses come back as 1-element arrays.
- Verified end-to-end: 30-check inline script across invoice (2-line, single-line, no-line), all three Amount fallback paths, Bill with parallel expense + item lines, Estimate, Customer non-transaction (no conversion attempted), persistence via subsequent list, Item 15 filter regression. Build green; server boot banner correct.

## Verify Before Continuing

- [ ] **Build.** `npm run build` exits with code 0.
- [ ] **Item 17 round-trip.** Through any MCP client: `qb_invoice_create { customerName: "Acme Corporation", lines: [{ itemName: "Consulting Services", quantity: 4, rate: 150 }, { itemName: "Widget A", quantity: 10, rate: 25 }] }` returns `invoice.InvoiceLineRet` with 2 entries, Amounts `600` and `250`, each with a `TxnLineID`. Then `qb_invoice_list { txnId: <returned TxnID> }` returns the same `InvoiceLineRet` array.
- [ ] **No-line invoice still clean.** Seed invoice `INV-1001` listed via `qb_invoice_list { refNumber: "INV-1001" }` has neither `InvoiceLineAdd` nor `InvoiceLineRet` (the seed never had lines — must not be invented).

## Next Task

**Phase 1, Item 16** in [todo.md:13](todo.md#L13):

> Compute `Subtotal`, `SalesTaxTotal`, `BalanceRemaining`, `AppliedAmount`, `IsPaid` in `simulation-store.handleAdd` for invoices/bills/estimates so simulated responses match real QB shape.

Acceptance criteria pre-written at [ACCEPTANCE_CRITERIA.md § Item 16](ACCEPTANCE_CRITERIA.md). After this: **18 → 22**.

## Context Notes

- **Item 16 piggybacks on Item 17.** The `*LineRet` arrays are now produced before `store.set(...)` — totals computation should run on `finalEntity` (after `convertLinesAddToRet`) so `Subtotal` can sum `*LineRet[].Amount`. See the order of operations at [src/session/simulation-store.ts:295-309](src/session/simulation-store.ts#L295-L309).
- **Iterate all `*LineRet` keys**, not just `InvoiceLineRet`. Bill carries both `ExpenseLineRet` and `ItemLineRet` — `Subtotal` (or `AmountDue` for Bill) needs to sum across both. Reuse the same regex idea from `convertLinesAddToRet` (`/Line(s?)Ret$/`).
- **Per-entity formula matrix** from [ACCEPTANCE_CRITERIA.md § Item 16](ACCEPTANCE_CRITERIA.md):
  - Invoice: `Subtotal = sum(InvoiceLineRet.Amount)`, `BalanceRemaining = Subtotal + SalesTaxTotal - AppliedAmount`, `IsPaid = (BalanceRemaining === 0)`.
  - Bill: `AmountDue = sum(line amounts across ExpenseLineRet + ItemLineRet)` if not explicitly provided.
  - Estimate: `Subtotal = sum(EstimateLineRet.Amount)`.
  - No-line transactions return `Subtotal = 0` (NOT undefined).
- **`SalesTaxTotal` defaults to 0** if not provided — don't try to compute tax from a tax line type unless the input explicitly includes `SalesTaxLineAdd` (which Phase 1 isn't introducing).
- **`AppliedAmount` defaults to 0** at create time — payment application (Item 5, Phase 3) is what increases it. Item 18 will mutate this on existing invoices when payments land.
- **Seed invoice protection.** The two seed invoices (`INV-1001`, `INV-1002`) already have hardcoded `Subtotal` / `BalanceRemaining` / `IsPaid` — Item 16's compute path runs only in `handleAdd`, so seeds remain untouched. Verify the regression test (no-line invoice has no `InvoiceLineRet`) still passes after Item 16.
- **Don't touch `handleMod` for Item 16.** Modify-time recomputation is out of scope — line modification belongs to Phase 3 items 6 and 7.
- **Project conventions reminder** ([CLAUDE.md](CLAUDE.md) § Stable Code Conventions): TS strict, ESM with `.js` extensions on relative imports, no comments explaining WHAT, tools never construct QBXML directly.

## Post-Task Chores

When Item 16 is done: `npm run build` green, [REGRESSION_CHECKLIST.md](REGRESSION_CHECKLIST.md) walked, Item 16 marked `[x]` in `todo.md`, acceptance entry moved to Completed, fresh `HANDOFF.md` pointing to Item 18.
