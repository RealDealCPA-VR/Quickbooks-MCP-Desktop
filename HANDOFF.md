# Handoff State

_Last updated: 2026-04-25_

## Last Session Summary

- Completed **Phase 1, Item 15** — transaction filters in simulation store. Added `EntityFilter`, `TxnDateRangeFilter`, `ModifiedDateRangeFilter`, `PaidStatus`, and `RefNumber` handling to [src/session/simulation-store.ts:139-223](src/session/simulation-store.ts#L139-L223). Verified end-to-end with a 28-check round-trip script (deleted post-verification per "no test infra yet" project state). All criteria in [ACCEPTANCE_CRITERIA.md § Item 15](ACCEPTANCE_CRITERIA.md) satisfied; entry moved to Completed.
- Cleared baseline blockers: ran `npm install` (130 packages), did `git init` + `.gitignore` (`node_modules/`, `dist/`, `*.log`, `.env*`, `.DS_Store`).
- No tool surface changes — `qb_invoice_list` / `qb_bill_list` / `qb_payment_list` already advertised these filters; this session made them actually work.
- Build green, dist/index.js produced.

## Verify Before Continuing

- [ ] **Working tree status.** `git status --short` should show only the untracked project files (markdowns, `.gitignore`, `package.json`, `package-lock.json`, `src/`, `tsconfig.json`) — and `node_modules/` + `dist/` should NOT appear (they're in `.gitignore`).
- [ ] **Build still passes.** `npm run build` exits with code 0.
- [ ] **Item 15 didn't silently regress.** Spot-check any one filter: e.g. through an MCP client, `qb_invoice_list { customerName: "Acme Corporation" }` should return exactly 1 invoice (`INV-1001`); `qb_invoice_list { fromDate: "2024-11-15" }` should return exactly 1 (`INV-1002`).

## Next Task

**Phase 1, Item 17** in [todo.md](todo.md):

> Convert input `*LineAdd` arrays to `*LineRet` arrays in simulation responses (with `TxnLineID`, computed `Amount = Quantity * Rate`) so downstream tools see proper line breakdown.

Acceptance criteria pre-written at [ACCEPTANCE_CRITERIA.md § Item 17](ACCEPTANCE_CRITERIA.md). Implementation lives in `simulation-store.handleAdd` at [src/session/simulation-store.ts:185-224](src/session/simulation-store.ts#L185-L224) — currently the entity is stored verbatim with `*LineAdd` keys, never converted.

After this, the next three Phase 1 tasks (in order): **16 → 18 → 22**.

## Context Notes

- **Three line-array shapes to handle in Item 17:**
  - `InvoiceLineAdd` → `InvoiceLineRet` (parser already declares `InvoiceLineRet` in `arrayElements` at [src/qbxml/parser.ts:27-61](src/qbxml/parser.ts#L27-L61) — no parser change).
  - `BillExpenseLineAdd` → `BillExpenseLineRet`, `BillItemLineAdd` → `BillItemLineRet` (Bill has two parallel line types; check the parser's `arrayElements` includes both — register if missing).
  - `EstimateLineAdd` → `EstimateLineRet`.
  - Plus: `SalesReceiptLineAdd`, `CreditMemoLineAdd`, `PurchaseOrderLineAdd`, `SalesOrderLineAdd`, `JournalLineAdd` for Phase 4 readiness — handle them now if the conversion is generic.
- **`TxnLineID` generation** can reuse the existing `nextId()` helper at [simulation-store.ts:355-357](src/session/simulation-store.ts#L355-L357).
- **`Amount` computation rules** (per Item 17 acceptance criteria):
  - If `Quantity` and `Rate` both supplied → `Amount = Quantity * Rate`.
  - Else if explicit `Amount` supplied → use it.
  - Else `0`.
- **The conversion happens in `handleAdd`**, but if you want list-after-add to also show `*LineRet`, the converted array needs to be persisted on the stored entity (i.e. swap the `*LineAdd` key for `*LineRet` before `store.set(...)`). That way subsequent `qb_invoice_list` returns the same shape the create call returned.
- **Item 16 sits right behind Item 17** — it'll compute `Subtotal = sum(*LineRet.Amount)` once Item 17 produces those line arrays. So keep the Item 17 implementation friendly to that follow-up (e.g. expose the converted lines in a way the new totals helper can read).
- **Generic helper opportunity**: a single `convertLinesAddToRet(entity)` helper that scans for any key matching `*LineAdd` / `*ExpenseLineAdd` / `*ItemLineAdd` and rewrites it as the `*LineRet` variant would handle every transaction type in one pass. Only hardcode subtype-by-subtype if that helper has too many edge cases.

## Repo State

- `git init` done; on branch `master` (or whatever your local default is). No commits yet — recommend committing the OS scaffold + Item 15 fix as the first commit when you have a moment, but not blocking.
- `node_modules/` installed; `dist/` exists and is gitignored.
- No tests yet — Phase 8 item 31 will add Vitest.

## Post-Task Chores Reminder

When Item 17 is done:
1. Run `npm run build` (must pass).
2. Spot-check at least one created invoice has `InvoiceLineRet` (not `InvoiceLineAdd`) with computed `Amount` and a generated `TxnLineID`.
3. Run the [REGRESSION_CHECKLIST.md](REGRESSION_CHECKLIST.md) (~3-5 min).
4. Mark Item 17 `[x]` in `todo.md`, move its acceptance entry to Completed in `ACCEPTANCE_CRITERIA.md`.
5. Write a fresh `HANDOFF.md` pointing to Item 16.
