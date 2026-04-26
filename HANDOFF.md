# Handoff State

_Last updated: 2026-04-26_

## Last Session Summary

- Completed **Phase 4, Item 12 — PurchaseOrder family** (3 of 4 in Item 12). Tool count 62 → 66. Item 12 itself is still **partial** in [todo.md:35](todo.md#L35) — JournalEntry remains as the last family.
- **`qb_purchase_order_list` / `_create` / `_update` / `_delete`** in new module [src/tools/purchase-orders.ts](src/tools/purchase-orders.ts). Four tools (vendor-side analog of Estimate — non-posting; no `_apply` path because POs don't post to AP until received against). Modeled after [src/tools/bills.ts](src/tools/bills.ts) for the Cost-based itemLines shape and [src/tools/estimates.ts](src/tools/estimates.ts) for the non-posting CRUD shape. All tools wrap structured tool errors (`isError: true` + `statusCode`) via try/catch.
- **PurchaseOrder semantics — non-posting; `TotalAmount` aggregates straight from line set, no `Subtotal` header.** This is the structural difference from Invoice/Estimate/SalesReceipt/CreditMemo (all of which derive Subtotal first, then TotalAmount = Subtotal + SalesTaxTotal):
  - Real QB POs don't expose Subtotal as a separate header field. The line set's Amount sum becomes TotalAmount directly.
  - Lines use `Cost` (not `Rate` — that's the AR side). Each line's `Amount = Quantity * Cost` is computed at the tool layer (mirroring how `qb_bill_create` handles `ItemLineAdd` at [src/tools/bills.ts:217-223](src/tools/bills.ts#L217-L223)).
  - Vendor.Balance is **never** moved on PO add/mod/delete. POs don't post to AP — only bills entered against received items move the vendor balance.
  - `IsManuallyClosed` is a header flag exposed on create + update (write-once-style — operators set it true to mark a PO closed regardless of receipt activity, e.g. canceled POs).
- **`computeTotals` extension** in [src/session/simulation-store.ts](src/session/simulation-store.ts) (new PurchaseOrder branch after the CreditMemo branch). Just `result.TotalAmount = lineSum` — no Subtotal split, no SalesTaxTotal, no Applied/Remaining bookkeeping. Importantly NOT added to the Subtotal-set entity list above (only Invoice/Estimate/SalesReceipt/CreditMemo set Subtotal).
- **Post-mod recompute branch extension** in [src/session/simulation-store.ts](src/session/simulation-store.ts) — added `entityType === "PurchaseOrder"` to the line-mod-recompute conjunction. Computed always overwrites TotalAmount, so no pre-delete needed (only Bill needs `delete updated.AmountDue`).
- **No `handleAdd` / `handleTxnDel` / `adjustPartyBalanceForTxnMod` changes needed** — PO is non-posting, so it stays out of the Invoice/Bill/CreditMemo balance-bookkeeping branches.
- **Existing infrastructure already wired for free**: `convertLinesAddToRet` regex `/^(.+?)Line(s?)Add$/` matches `PurchaseOrderLineAdd`; `applyLineMods` regex `/^(.+?)Line(s?)Mod$/` matches `PurchaseOrderLineMod`; existing Quantity * Cost re-derivation in `applyLineMods` ([simulation-store.ts:1495-1500](src/session/simulation-store.ts#L1495-L1500)) handles PO line mods unchanged. PurchaseOrder was already in `arrayElements` ([parser.ts:62-63](src/qbxml/parser.ts#L62-L63)), `isTransactionType` ([simulation-store.ts:1695](src/session/simulation-store.ts#L1695)), `buildDeleteRequest` transaction list ([builder.ts:122](src/qbxml/builder.ts#L122)), and `deleteEntity` transaction list ([manager.ts:202](src/session/manager.ts#L202)).
- README updated: tool count 62 → 66; new "Purchase Orders" section between "Credit Memos" and "Employees" with intro paragraphs (vendor-side analog, Cost-based lines, IsManuallyClosed flag) and 4-row tool table. `instructions` block in [src/index.ts](src/index.ts) updated — `qb_purchase_order_*` bullet documents the non-posting nature, Cost-based line shape, TotalAmount derivation (no Subtotal split), and `isManuallyClosed` flag. Header doc-comment got a new "Purchase Order management" line. ACCEPTANCE_CRITERIA Item 12 (PurchaseOrder) entry written and moved straight to Completed; the in-progress Item 12 block now points to JournalEntry only. No new DECISIONS.md entry — PO follows established CRUD patterns; the Cost vs. Rate choice is a direct mirror of Bill's itemLines.
- Verified end-to-end with a 46-check inline script (deleted post-verification): P-series (TotalAmount aggregation, no Subtotal header, vendor balance unchanged on create, IsManuallyClosed flag), J-series (filters: TxnID + EntityFilter on VendorRef), B-series (header-only mod preserves lines/totals; EditSequence rotates), D-series (line replace recomputes TotalAmount, Cost carried via merge-by-TxnLineID, Amount re-derived, vendor balance unchanged across grow + shrink), M-series (IsManuallyClosed toggle on/off), C-series (stale editSequence 3170 + non-mutation), G-series (delete happy path + vendor balance untouched), H-series (unknown TxnID delete 500). Plus N-series regressions across `qb_invoice_update` / `qb_estimate_update` / `qb_bill_update` / `qb_sales_receipt_update` / `qb_credit_memo_update` / `qb_credit_memo_apply` / `qb_payment_apply` to confirm the shared post-mod recompute path didn't regress. Server startup smoke-tested via `node dist/index.js` (boots clean, simulation banner prints). `npm run build` green throughout.

## Verify Before Continuing

- [ ] **Build.** `npm run build` exits 0.
- [ ] **`qb_purchase_order_create` standalone returns TotalAmount + PurchaseOrderLineRet, no Subtotal.** Create a PO with `lines: [{itemName: "Widget A", quantity: 10, cost: 12}, {itemName: "Widget A", quantity: 5, cost: 12}]` — response carries `TotalAmount: 180` (10*12 + 5*12), no `Subtotal` field, and a `PurchaseOrderLineRet` array with two entries each carrying TxnLineID + Cost + Amount. Vendor `Balance` is **unchanged** (non-posting).
- [ ] **`qb_purchase_order_create` minimum-1-line guard.** Calling with `lines: []` is rejected by zod (`.min(1)`); the simulation never receives the request.
- [ ] **`qb_purchase_order_create` with `isManuallyClosed: true` stores the flag.** Default omits the flag.
- [ ] **`qb_purchase_order_update` line replace recomputes TotalAmount + cost merges.** Pass `lines: [{txnLineID: <existing>, quantity: 15}]` on a 120-total PO (qty=10, cost=12) → TotalAmount=180 (Cost carried from existing via merge-by-TxnLineID, Amount re-derived). Vendor balance **unchanged**. Shrink to qty=7 → TotalAmount=84, vendor balance still unchanged.
- [ ] **`qb_purchase_order_update` toggles `isManuallyClosed`.** false → true → false in successive mods, each EditSequence rotated.
- [ ] **`qb_purchase_order_update` stale editSequence rejects with 3170; no mutation.** Memo / line / IsManuallyClosed unchanged after the rejected call.
- [ ] **`qb_purchase_order_delete` happy path.** Subsequent `qb_purchase_order_list { txnId }` returns `count: 0`. Vendor balance **unchanged**.
- [ ] **`qb_purchase_order_delete` unknown TxnID.** Returns `isError: true` with `statusCode: 500`.
- [ ] **Regression — `qb_bill_update` itemLines still recompute AmountDue.** Cost-based line mods on bills still work after the PurchaseOrder branch was added to the post-mod recompute conjunction.
- [ ] **Regression — `qb_credit_memo_update` line mod still recomputes Subtotal/TotalAmount/RemainingValue + moves customer balance by delta.** The CreditMemo path (added in the prior session) still works after the PurchaseOrder extension to the same conjunction.
- [ ] **Regression — `qb_credit_memo_apply` re-applies atomically + customer balance unchanged.** The apply path (separate `handleCreditMemoApplyMod` short-circuit) is unaffected by the PurchaseOrder branch.

## Next Task

**Phase 4, Item 12 — JournalEntry family** (4 of 4 in Item 12). [todo.md:35](todo.md#L35).

JournalEntry is the structural outlier of Item 12. Likely 4 tools (`qb_journal_entry_list / _create / _update / _delete`), tool count 66 → ~70.

### Recommended approach

1. **Debit/credit balance invariant** — JE lines are the only entity where `sum(debits) === sum(credits)` is a hard invariant. Every JE line is either a debit OR a credit on a specific account, and the two sides must balance to a cent. Reject unbalanced entries at the simulation layer with statusCode `3030` (the QB error code for "request data is invalid"). The validation is a separate pass in `handleAdd` (and `handleMod` after line mods are applied) — NOT inside `computeTotals` (which is for derived header totals, not invariants). Validate-first ordering — return 3030 BEFORE persisting.

2. **Two line shapes** — `JournalDebitLine` and `JournalCreditLine`. The QBXML schema is:
   ```
   <JournalEntryAdd>
     <TxnDate>...</TxnDate>
     <RefNumber>...</RefNumber>
     <JournalDebitLine>
       <AccountRef><FullName>...</FullName></AccountRef>
       <Amount>...</Amount>
       <Memo>...</Memo>
       <EntityRef>...</EntityRef>     <!-- optional, on Customer/Vendor lines -->
       <ClassRef>...</ClassRef>       <!-- optional -->
     </JournalDebitLine>
     <JournalCreditLine>...</JournalCreditLine>
     <!-- alternating debit/credit blocks, any number -->
   </JournalEntryAdd>
   ```
   Tool API: `debits: [{accountName, amount, memo?, entityName?, className?}]` and `credits: [{accountName, amount, memo?, entityName?, className?}]`. Each side is a separate array (cleaner than mixing debits/credits in one array with a discriminator field).

3. **No line-derived TotalAmount** — JEs don't have a TotalAmount header in the same sense. The "amount" of the entry is the matched debit-side total = credit-side total. The simulation can store both as `TotalDebit` / `TotalCredit` for inspection, but `computeTotals` for JournalEntry is essentially a no-op (or just preserves the invariant). Don't add JournalEntry to the Subtotal-set list or the existing TotalAmount derivation.

4. **Per-line entity-balance moves — DEFER**. JE lines can carry `EntityRef` to a Customer or Vendor, in which case the line moves that entity's balance (debit on a Customer line increases AR; credit on a Vendor line increases AP; etc.). This is much more involved than a single `adjustPartyBalanceForTxn` call. Recommendation: ship the basic CRUD + balance-validation shape first, leave the per-line entity-balance bookkeeping for a follow-up. Surface this clearly in the JE tool descriptions ("EntityRef on a line is recorded but does NOT move that entity's balance in this server's first cut").

5. **`*LineAdd` regex**: the `applyLineMods` regex `/^(.+?)Line(s?)Mod$/` captures `JournalDebitLineMod` and `JournalCreditLineMod` correctly (prefix = `JournalDebit` / `JournalCredit`, plural = ""). Ret keys become `JournalDebitLineRet` / `JournalCreditLineRet` — both already in `arrayElements` at [parser.ts](src/qbxml/parser.ts) (verify before starting).

6. **Files to touch**:
   - New: [src/tools/journal-entries.ts](src/tools/journal-entries.ts) (4 tools)
   - [src/index.ts](src/index.ts) — import + register + instructions block bullet + tool count
   - [src/session/simulation-store.ts](src/session/simulation-store.ts) — `handleAdd` JE balance validation (returns 500 with statusCode 3030 if `sum(debits) !== sum(credits)`); `handleMod` re-validation after line mods; possibly a tiny `computeTotals` JE branch storing TotalDebit / TotalCredit for inspection (or skip if it adds noise). NO post-mod recompute conjunction entry needed unless TotalDebit/TotalCredit are tracked.
   - [README.md](README.md) — tool count 66 → ~70; new "Journal Entries" section
   - [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md) — Item 12 (JournalEntry) entry, written when picking up; move to Completed when verified. Item 12 itself moves to Completed once JE lands (final family in Item 12).
   - [HANDOFF.md](HANDOFF.md) — this file, updated when JE lands. After JE: Item 12 closes; the next big block is Phase 4 dead-code cleanup (Item 24) or Phase 5 reporting.

## Context Notes

- **PurchaseOrder plumbing is now in [src/tools/purchase-orders.ts](src/tools/purchase-orders.ts)** + a `computeTotals` PO branch and a post-mod recompute branch entry in [src/session/simulation-store.ts](src/session/simulation-store.ts). Registered between credit-memos and employees in [src/index.ts](src/index.ts) (matches the AR → AR-adjacent → AP → list/HR tool-registration order — credit-memo is last AR, PO is first non-posting AP-adjacent, employee is HR).
- **`computeTotals` at [simulation-store.ts:912](src/session/simulation-store.ts#L912)** now handles `Invoice | Estimate | SalesReceipt | Bill | CreditMemo | PurchaseOrder`. The Subtotal-set list (lines 929-936) is still `Invoice | Estimate | SalesReceipt | CreditMemo` (unchanged) — PO does NOT set Subtotal. JournalEntry won't fit this pattern at all (debit/credit lines don't aggregate to a single TotalAmount in the same way).
- **The post-mod recompute conjunction** is now `Bill | Invoice | Estimate | SalesReceipt | CreditMemo | PurchaseOrder`. JournalEntry probably doesn't need to be added (since computeTotals JE branch is a no-op or just stores invariant totals for inspection) — but the line-mod path WILL need to re-run the debit/credit balance validation after mods, before persisting.
- **`adjustPartyBalanceForTxnMod` and `adjustPartyBalanceForTxn` are unchanged** — PO doesn't call either (non-posting). JournalEntry per-line entity-balance bookkeeping is the deferred work.
- **`convertLineAddToRet` at [simulation-store.ts:882](src/session/simulation-store.ts#L882)** only handles Quantity * Rate or explicit Amount — it does NOT auto-derive Amount from Quantity * Cost. Bill and PO both compensate by pre-computing Amount at the tool layer (`lineData.Amount = quantity * cost`). If JournalEntry has lines with their own Amount semantic, follow the same pattern.
- **`applyLineMods` at [simulation-store.ts:1449](src/session/simulation-store.ts#L1449)** DOES handle Quantity * Cost re-derivation on mod — see [simulation-store.ts:1495-1500](src/session/simulation-store.ts#L1495-L1500). PO line mods rely on this. JE debit/credit lines have a flat `Amount` (no quantity/rate/cost), so this branch is a no-op for them; that's fine.
- **PurchaseOrder verification gotcha** — the tool's zod schema enforces `lines.min(1)`, so the empty-lines case is rejected at the MCP layer before it reaches the simulation. The verify script bypasses that by calling `session.addEntity` directly; the simulation handles a no-lines PO by setting `TotalAmount = 0` and returning success. This is fine — the simulation is a lower layer than the tool surface, and the tool surface is the contract for actual users.
- **Item 24 dead-code cleanup remains pending** — small mechanical hygiene task. [todo.md:49](todo.md#L49). Targets unchanged: `parseQBXMLResponse` import in [session/manager.ts:27](src/session/manager.ts#L27), `buildSingleRequest` export in [qbxml/builder.ts:66](src/qbxml/builder.ts#L66), `QBXMLRequestBody` import in [qbxml/builder.ts:9](src/qbxml/builder.ts#L9), the useless ternary `isTransaction ? id : id` in `simulation-store.ts` (the line number drifts after each Phase 4 family — re-grep before editing). Worth running before Item 12 fully closes (i.e. between JE landing and the Item 12 ✓).
- **Project conventions reminder** ([CLAUDE.md](CLAUDE.md) § Stable Code Conventions): TS strict, ESM with `.js` extensions on relative imports, every zod field has `.describe()`, every tool registered in [src/index.ts](src/index.ts) and listed in the README tool table, structured tool errors via try/catch + `isError: true` + `statusCode`.
- **Verification gotcha (carried from prior handoffs)** — `handleQuery` filters require **uppercase** `TxnID` / `RefNumber` / `FullName` in the filter object. Tools translate from lowercase correctly, but if you write a verification script that calls `session.queryEntity` directly, use uppercase or the filter is silently ignored.

## Post-Task Chores

When JournalEntry lands: `npm run build` green, [REGRESSION_CHECKLIST.md](REGRESSION_CHECKLIST.md) walked (especially §3 Tool Surface for the new JE tools, §4 QBXML Round-Trip for `JournalEntryMod` + `JournalDebitLineMod` / `JournalCreditLineMod` round-trip, §5 Simulation Store for the new debit/credit balance validator, §6 Prior Tool Verification across all the existing transaction-update tools to make sure the shared `handleMod` plumbing didn't regress), Item 12 moves from partial → complete in `todo.md` (all four families struck through), Item 12 (JournalEntry) acceptance entry written then moved to Completed in [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md), the in-progress Item 12 block is removed entirely (or noted as fully complete), README updated (new Journal Entries section, tool count bumped to ~70), `instructions` block in [src/index.ts](src/index.ts) updated, fresh `HANDOFF.md` pointing to whatever's next (likely Phase 4 dead-code cleanup Item 24, or Phase 5 reports).
