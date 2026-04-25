# Acceptance Criteria

Per-task definition of "done." A task is complete only when its criteria are observably satisfied AND `REGRESSION_CHECKLIST.md` passes.

If criteria change during implementation, update them here in the same session — never silently move the goalposts.

Item numbers map to `todo.md`. Add criteria below as you pick up each task. Move completed entries to the bottom under "Completed."

---

## Template

```markdown
## Item N — <Short title> _(Phase X)_

**Status:** pending | in-progress | done | partial

**Behavioral criteria** _(observable, testable, no ambiguity)_:
- [ ] <Criterion 1 — describe what someone calling the tool sees>
- [ ] <Criterion 2>
- [ ] <Edge case>
- [ ] <Error case>

**Regression criteria** _(things that should still work after the change)_:
- [ ] <Adjacent tool / behavior that uses shared code>
- [ ] <Seed-data assumption that should still hold>

**Documentation criteria**:
- [ ] README updated if a tool was added/renamed/removed
- [ ] `instructions` block in src/index.ts updated if a tool surface changed
- [ ] `ARCHITECTURE.md` / `DECISIONS.md` / `REQUIREMENTS.md` updated if applicable

**Verification commands**:
```bash
npm run build
npm run dev   # in another terminal: exercise the tool through an MCP client
```

**Notes**: <gotchas, scope clarifications, follow-ups discovered>
```

---

## Phase 1 — Simulation correctness

### Item 17 — Convert `*LineAdd` to `*LineRet` in simulation responses _(Phase 1)_

**Status:** pending

**Behavioral criteria**:
- [ ] Creating an invoice with 2 lines via `qb_invoice_create` returns a response containing `InvoiceLineRet` (not `InvoiceLineAdd`) with 2 entries.
- [ ] Each `InvoiceLineRet` entry has a generated `TxnLineID`.
- [ ] Each line has `Amount` computed as `Quantity * Rate` if both supplied; otherwise echoes the explicit `Amount` if provided; otherwise `0`.
- [ ] Subsequent `qb_invoice_list` retrieval of the same invoice returns the same `InvoiceLineRet` array (persistence verification).
- [ ] Same conversion happens for `BillExpenseLineRet`, `BillItemLineRet`, `EstimateLineRet`, and any other `*LineAdd` → `*LineRet` pair.

**Regression criteria**:
- [ ] Existing seed invoices (which have no lines) still list correctly.
- [ ] Item 15's filters still work after this change.

**Documentation criteria**:
- [ ] None required — this is internal correctness.

**Notes**:
- The parser's `arrayElements` set already includes `InvoiceLineRet`, `BillLineRet`, `EstimateLineRet` — no parser change needed.
- `TxnLineID` generation can reuse `nextId()` helper.

---

### Item 16 — Compute totals in simulation `handleAdd` _(Phase 1)_

**Status:** pending

**Behavioral criteria**:
- [ ] Created invoices return `Subtotal = sum(InvoiceLineRet.Amount)`.
- [ ] Created invoices return `BalanceRemaining = Subtotal + SalesTaxTotal - AppliedAmount`.
- [ ] Created invoices return `IsPaid = (BalanceRemaining === 0)`.
- [ ] Created bills return `AmountDue = sum(line amounts)` if not explicitly provided.
- [ ] Created estimates return `Subtotal = sum(line amounts)`.
- [ ] No-line invoices/bills/estimates return `Subtotal = 0` (not undefined).

**Regression criteria**:
- [ ] Item 17 still produces correct line arrays.
- [ ] Customer/vendor add still works (no-op for these — non-transactional).

---

### Item 18 — Update entity balances on transaction activity _(Phase 1)_

**Status:** pending

**Behavioral criteria**:
- [ ] Adding an invoice for `Acme Corporation` increases that customer's `Balance` by the invoice `BalanceRemaining`.
- [ ] Adding a bill for a vendor increases that vendor's `Balance` by `AmountDue`.
- [ ] Recording a payment applied to an invoice (Phase 3 item 5) decreases the customer's `Balance` and the invoice's `BalanceRemaining` by the applied amount.
- [ ] Deleting an invoice/bill reverses the balance change.
- [ ] `qb_ar_aging` and `qb_ap_aging` reflect these changes immediately.

**Regression criteria**:
- [ ] Initial seed balances remain at their seeded values until activity touches them.

**Notes**:
- This requires cross-store updates in the simulation. Add a small helper in `SimulationStore` to look up and mutate the related Customer/Vendor entity, rather than scattering balance updates across handlers.

---

### Item 22 — Split Item store by subtype _(Phase 1)_

**Status:** pending

**Behavioral criteria**:
- [ ] Simulation store has separate maps for `ItemService`, `ItemInventory`, `ItemNonInventory`, `ItemOtherCharge`, `ItemGroup`.
- [ ] A query for `ItemServiceQueryRq` returns only service items, wrapped in `ItemServiceRet`.
- [ ] Same for each subtype.
- [ ] Seed data is migrated: existing seed items are placed into the correct subtype map based on their `ItemType` field.

**Regression criteria**:
- [ ] `qb_item_list` (currently uses generic `ItemQueryRq`) still works until Phase 2 item 2 lands. May require a transitional shim.

**Notes**:
- Tightly coupled to Phase 2 items 2 and 3. Consider doing 22 + 2 + 3 together in one session.

---

## Phase 2 — Item subtype fixes

### Item 2 — Per-subtype Item request types _(Phase 2)_

**Status:** pending

**Behavioral criteria**:
- [ ] `qb_item_list` accepts an optional `itemType` arg. When provided, only that subtype is queried.
- [ ] When `itemType` is omitted, the tool issues queries for all subtypes and merges results.
- [ ] `qb_item_add` routes to the correct `Item<Subtype>AddRq` based on the required `itemType` arg.
- [ ] `qb_item_update` routes to the correct `Item<Subtype>ModRq`.
- [ ] Subtype-specific fields are accepted: e.g. inventory items accept `assetAccountName`, `cost`; service items don't.

**Regression criteria**:
- [ ] All seed items still appear on a no-filter list.
- [ ] Invoice creation referencing items by name (e.g. "Consulting Services") still resolves correctly regardless of which subtype the item belongs to.

**Documentation criteria**:
- [ ] README item table updated with new `itemType` arg.
- [ ] `ARCHITECTURE.md` Invariant #7 marked resolved.

---

### Item 3 — Item delete uses correct subtype _(Phase 2)_

**Status:** pending

**Behavioral criteria**:
- [ ] `qb_item_delete` accepts `itemType` arg and sends `ListDelType: "ItemService"` (etc.) instead of `"Item"`.
- [ ] Deletion succeeds for each subtype.

**Regression criteria**:
- [ ] Customer/Vendor/Account delete (which use the same `ListDelRq` machinery with their own types) still works.

---

## Phase 3 — Transaction completeness

### Item 4 — Bill expense + item lines _(Phase 3)_

**Status:** pending

**Behavioral criteria**:
- [ ] `qb_bill_create` accepts `expenseLines: [{accountName, amount, memo?, classRef?}]` array.
- [ ] `qb_bill_create` accepts `itemLines: [{itemName, quantity, cost, memo?}]` array.
- [ ] At least one of `expenseLines` or `itemLines` is required (header-only bills are rejected with a clear error).
- [ ] Created bill's `AmountDue` equals sum of all expense + item line amounts.
- [ ] Vendor `Balance` increases accordingly (depends on Phase 1 item 18).
- [ ] AP aging reflects the new bill.

**Regression criteria**:
- [ ] Seed bills (if any) still list.

**Notes**:
- Real QBXML uses `ExpenseLineAdd` and `ItemLineAdd` as siblings inside `BillAdd`.
- Each expense line needs `AccountRef` (FullName or ListID) + `Amount`. Each item line needs `ItemRef` + `Quantity` + `Cost`.

---

### Item 5 — Payment applied to invoices _(Phase 3)_

**Status:** pending

**Behavioral criteria**:
- [ ] `qb_payment_receive` accepts `appliedTo: [{txnId, amount, discountAmount?, discountAccountName?}]` array.
- [ ] Each applied invoice's `BalanceRemaining` decreases by the applied amount.
- [ ] When `BalanceRemaining` reaches 0, the invoice's `IsPaid` flips to true.
- [ ] Customer `Balance` decreases by the total applied amount (not the gross payment).
- [ ] Unapplied amount (if `TotalAmount > sum(appliedTo.amount)`) remains as customer credit — clearly returned in the response payload.
- [ ] Calling `qb_payment_receive` without `appliedTo` records the payment as fully unapplied (legitimate for prepayments).

**Regression criteria**:
- [ ] `qb_payment_list` shows the new payment.
- [ ] `qb_invoice_list` reflects updated `BalanceRemaining` and `IsPaid` on the affected invoices.
- [ ] AR aging recomputes correctly.

**Notes**:
- Real QBXML structure: `ReceivePaymentAdd` contains zero or more `AppliedToTxnAdd` blocks, each with `TxnID`, `PaymentAmount`, optional `DiscountAmount` + `DiscountAccountRef`.

---

_(Add criteria for items 6, 7, 8, 9, etc. as they are picked up. Don't pre-write criteria for distant tasks — they tend to drift before implementation, and writing them up-front wastes effort if priorities shift.)_

---

## Completed

_(Move entries here when criteria are satisfied. Keep the criteria list intact — it's the historical record of what "done" meant for that task.)_

### Item 15 — Transaction filters in simulation store _(Phase 1)_ — done 2026-04-25

**Status:** done

**Behavioral criteria**:
- [x] `qb_invoice_list` with `customerName: "Acme Corporation"` returns only invoices where `CustomerRef.FullName === "Acme Corporation"`.
- [x] `qb_invoice_list` with `customerListId: "80000001-1234567890"` returns only invoices for that customer.
- [x] `qb_invoice_list` with `fromDate: "2024-11-01"`, `toDate: "2024-11-10"` returns only invoices with `TxnDate` lexicographically between (inclusive).
- [x] `qb_invoice_list` with `fromDate` only (no `toDate`) returns invoices on or after `fromDate`. Same for `toDate` only.
- [x] `qb_invoice_list` with `paidStatus: "PaidOnly"` returns only invoices where `IsPaid === true`. With `"NotPaidOnly"`, only `IsPaid !== true`. With `"All"` (or unset), no filter.
- [x] `qb_invoice_list` with `refNumber: "INV-1001"` returns only the invoice with that exact `RefNumber`.
- [x] `qb_bill_list` vendor variant of EntityFilter verified (matches via `VendorRef`).
- [x] Combining filters narrows results (AND semantics).
- [x] Empty result set returns 0 results (handled by existing zero-result branch returning statusCode 1).

**Regression criteria**:
- [x] `qb_customer_list` with existing filters (`nameFilter`, `activeOnly`, `maxReturned`, `listId`) still works unchanged.
- [x] `qb_invoice_list` with `txnId` (existing filter) still returns the single matching invoice.
- [x] Seed data still loads — 2 invoices appear on a no-filter `qb_invoice_list` call.
- [x] No regression in non-transaction list tools — verified via `Customer.NameFilter` / `Customer.ActiveStatus` / `Account.MaxReturned` checks.

**Documentation criteria**:
- [x] No README change required.
- [x] No architecture change.
- [x] No `DECISIONS.md` entry — implementation followed advertised filter shapes; no surprises.

**Implementation notes**:
- All filter handlers added to [src/session/simulation-store.ts](src/session/simulation-store.ts#L139-L227) immediately after the existing `FullName` filter and before `NameFilter` (so transaction-only filters are grouped together, list-only filters stay where they were).
- `EntityFilter` matches `CustomerRef.ListID/FullName` or `VendorRef.ListID/FullName` — entities only carry one ref, so a single check covers both invoice and bill cases without needing entity-type dispatch.
- All date comparisons are lexicographic on ISO strings, including `ModifiedDateRangeFilter` against full ISO `TimeModified`. If a future caller passes a `YYYY-MM-DD` string for `ToModifiedDate`, same-day modifications could be excluded — flag for future work if it bites.
- `PaidStatus`: relies on the stored `IsPaid` boolean. Item 16 will compute `IsPaid` from `BalanceRemaining === 0` — at that point the filter still works, so no follow-up needed here.
- `RefNumber`: exact match only. `RefNumberFilter` (partial / case-sensitive) deferred — record decision if/when added.
- Verified end-to-end with a 28-check standalone script that round-tripped through `buildQueryRequest` → `SimulationStore.processRequest` → `extractResponseData` (script deleted post-verification per "no test infra yet" project state).

---
