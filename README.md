# QuickBooks Desktop MCP Server

A **Model Context Protocol (MCP)** server that provides comprehensive tools for managing client books in QuickBooks Desktop via the QBXML SDK.

## Overview

This MCP server acts as a bridge between AI agents/LLMs and QuickBooks Desktop, translating tool calls into QBXML messages — the standard XML-based protocol for QuickBooks Desktop SDK communication. It supports two operating modes:

- **Live mode** — Communicates with a real QuickBooks Desktop instance via the QBXMLRP2 request processor (requires Windows + QuickBooks Desktop installed)
- **Simulation mode** — In-memory mock data store for development, testing, and non-Windows environments (default)

## Tools (150 total)

### Customers
| Tool | Description |
|------|-------------|
| `qb_customer_list` | List/search customers with filters. `parentListID` / `jobOnly` POST-FILTERS surface sub-customer hierarchy (matches past the first batch may be missed under `paginate`). Pass `autoExhaust: true` (Phase 16 #73) to drain the iterator server-side and return the merged result in one call — capped by `maxBatches` (default 20 ≈ 10k rows); cap-hit returns the partial result + `iteratorID` for resumption. |
| `qb_customer_jobs` | List the sub-customers (jobs) of a given parent. Pre-flight parent resolution via `parentListId` \| `parentName` (mutually exclusive). `recursive: true` walks descendants by FullName-prefix match. Returns parent context + jobs sorted by Sublevel then FullName. |
| `qb_customer_add` | Create a new customer. Pass `parentListId` to create a SUB-CUSTOMER (job) — sim derives `FullName = Parent:Child` and `Sublevel = parent.Sublevel + 1`. Supports `dryRun: true` (Phase 14 #64) — previews the would-be customer without committing. |
| `qb_customer_update` | Update customer details |
| `qb_customer_delete` | Delete a customer |

### Vendors
| Tool | Description |
|------|-------------|
| `qb_vendor_list` | List/search vendors. Pass `paginate: true` for caller-driven iterator pagination, or `autoExhaust: true` (Phase 16 #73) to drain the iterator server-side and return the merged result in one call — capped by `maxBatches` (default 20 ≈ 10k rows); cap-hit returns the partial result + `iteratorID` for resumption. |
| `qb_vendor_add` | Create a new vendor |
| `qb_vendor_update` | Update vendor details |
| `qb_vendor_delete` | Delete a vendor |

### Chart of Accounts

`qb_account_make_inactive` is the preferred way to retire an account — it flips `IsActive: false` so the account hides from the default `qb_account_list` view but stays referenceable by historical transactions. `qb_account_delete` is a hard delete that real QB rejects (statusCode 3260/3170) for accounts with any transaction history; use it only for empty accounts created in error. Both wrap structured tool errors via `isError: true` + `statusCode` so stale `editSequence` (3170) and unknown `listId` (500) surface cleanly.

| Tool | Description |
|------|-------------|
| `qb_account_list` | List accounts (filterable by type, defaults to active-only). Pass `paginate: true` for caller-driven iterator pagination, or `autoExhaust: true` (Phase 16 #73) to drain the iterator server-side and return the merged result in one call — capped by `maxBatches` (default 20 ≈ 10k rows); cap-hit returns the partial result + `iteratorID` for resumption. |
| `qb_account_add` | Create a new account |
| `qb_account_update` | Update account details (name / number / description / isActive) |
| `qb_account_make_inactive` | Deactivate an account by ListID + EditSequence (sets IsActive: false). Reversible via `qb_account_update { isActive: true }`. |
| `qb_account_delete` | Hard-delete an account by ListID. Fails for accounts with transaction history — use `qb_account_make_inactive` instead. |

### Invoices

`qb_invoice_update` accepts an optional `lines` array with the same shape as `qb_invoice_create` plus an optional `txnLineID` per entry — when provided and matching an existing line, the line is merged in place; otherwise it's added new. Line arrays passed to `qb_invoice_update` REPLACE the existing line set wholesale (any line you don't list is dropped). `Subtotal`, `BalanceRemaining`, and `IsPaid` recompute automatically; `AppliedAmount` is preserved. If a line mod drops `Subtotal` below `AppliedAmount`, `BalanceRemaining` goes negative — that's the over-applied state and matches real QB. Customer balance moves by the change in `BalanceRemaining`. A stale `editSequence` rejects with statusCode 3170.

`qb_invoice_list` (and `qb_bill_list` / `qb_sales_receipt_list` / `qb_credit_memo_list` / `qb_purchase_order_list` / `qb_estimate_list` / `qb_journal_entry_list`) defaults to header-only rows, matching real QB's `*QueryRq` behavior. Pass `includeLineItems: true` to surface the type-specific `*LineRet` array(s) on each row (`InvoiceLineRet`, `ExpenseLineRet` + `ItemLineRet` for bills, `JournalDebitLineRet` + `JournalCreditLineRet` for JEs, etc.). Header-derived totals (`Subtotal`, `AmountDue`, `BalanceRemaining`, `IsPaid`, `TotalDebit`/`TotalCredit`) survive the strip in either mode.

| Tool | Description |
|------|-------------|
| `qb_invoice_list` | List/search invoices with date/status filters. Pass `includeLineItems: true` for per-line breakdown, `includeCustomFields: true` for `DataExtRet`, `includeCustomerContact: true` to attach a `customerContact` sub-object (Email / Phone / CompanyName / FirstName / LastName / etc.) to every invoice via a single follow-up `CustomerQueryRq` — replaces the per-customer `qb_customer_list` lookup the collection-email workflow used to require. Pass `paginate: true` for caller-driven iterator pagination, or `autoExhaust: true` (Phase 16 #73) to drain the iterator server-side and return the merged result in one call — capped by `maxBatches` (default 20 ≈ 10k rows); under `autoExhaust` the `includeCustomerContact` enrichment runs ONCE at the end over the merged result's dedup'd ListIDs (N invoice batches still cost only 1 contact wire call vs. `paginate`'s per-batch enrichment). |
| `qb_invoice_create` | Create an invoice with line items. Supports `dryRun: true` (Phase 14 #64) — previews the entity-after-mutation (incl. computed Subtotal and Customer.Balance side effects) without committing. |
| `qb_invoice_batch_create` | Post 1–100 invoices atomically in one envelope (`onError=stopOnError`). Each entry follows the `qb_invoice_create` shape. Upfront customer-ref validation rejects the whole batch before any wire I/O on a missing `customerName`/`customerListId`; mid-wire failures trigger compensating delete of any prior-posted invoices in REVERSE post order (Customer.Balance reverses via the underlying `handleTxnDel`). Per-entry status: `posted` / `rolled-back` / `orphaned` (rollback delete itself failed — clean up via `qb_invoice_delete` with the surfaced TxnID) / `failed` / `skipped`. Use for monthly retainer billing, recurring subscription invoicing, end-of-month time-and-materials runs. Optional `idempotencyKey` fingerprints the whole entries list. |
| `qb_invoice_update` | Modify an existing invoice. Pass `txnId` + `editSequence` plus any header fields and/or replacement `lines: [{txnLineID?, itemName?, itemListId?, description?, quantity?, rate?, amount?}]`. Header-only mods leave existing lines untouched. Customer balance adjusts by `newBalanceRemaining - oldBalanceRemaining` (or full reverse-then-apply if `customerName` / `customerListId` re-points the invoice). |
| `qb_invoice_delete` | Delete an invoice. Supports `dryRun: true` (Phase 14 #64) — previews the deletion (the *DelRs confirmation block) without committing; the source invoice remains in place after a dry-run call. |
| `qb_invoice_duplicate` | Duplicate an existing invoice. Pass `sourceTxnId`; the tool reads the source's `CustomerRef` + lines (and optional `ClassRef` / `TermsRef` / `SalesRepRef` / `PORefNumber`) and submits a fresh `InvoiceAddRq` with that payload. Defaults: `TxnDate` → today, `DueDate` / `RefNumber` → unset (avoids ref-number collisions on monthly retainer flows), `Memo` → `"Duplicate of <source ref or TxnID>"`. Operator overrides win: `txnDate`, `dueDate`, `refNumber`, `memo`, `customerName` / `customerListId` (retarget at a different customer). Workflow stand-in for QB Desktop's memorized-template "Use" command (which the QBXML SDK doesn't expose). |
| `qb_invoice_write_off` | Close an open invoice in one atomic call without collecting payment. Pass `txnId` + `writeOffAccount` (e.g. "Bad Debt"); the tool reads the source invoice and submits a $0 `ReceivePayment` whose `AppliedToTxnAdd` carries `DiscountAmount` = the invoice's full `BalanceRemaining` (or `amount` for a partial) posting to the named P&L account. The invoice's `BalanceRemaining` drops, `IsPaid` flips on full write-off, and the customer's open AR drops by the written-off amount. Same mechanism as QB Desktop's "Discounts and Credits" dialog on the Receive Payments form, but single-call. Optional `txnDate`, `refNumber`, `memo`, `depositToAccountName` flow through to the underlying `ReceivePayment`. |

### Bills (Accounts Payable)

A bill must post to a GL account, so `qb_bill_create` requires at least one of `expenseLines` or `itemLines`. `AmountDue` is the sum of all line amounts. `qb_bill_update` accepts the same line shapes plus optional `txnLineID` per line — when provided, the line is treated as a modify of the existing line and the simulation merges the mod's fields onto it; otherwise the line is added new. Line arrays passed to `qb_bill_update` REPLACE the existing line set wholesale (any line you don't list is dropped). A stale `editSequence` rejects with statusCode 3170.

`qb_bill_pay` records a bill payment against one or more open bills. Pass `paymentMethod: "check" | "creditcard"` to route to `BillPaymentCheck` or `BillPaymentCreditCard`, plus a non-empty `applyTo: [{txnId, amount, discountAmount?, discountAccountName?}]` array. Each entry reduces the named bill's `AmountDue`, flips `IsPaid` to true when `AmountDue` hits zero, and decrements the vendor's `Balance` by the applied amount. Discount handling mirrors the AR side: `discountAmount` closes part of the bill alongside the payment but does NOT reduce vendor balance (the vendor granted the discount, they didn't receive cash for it). Over-payment leaves `AmountDue` negative + `IsPaid` false (vendor credit). An unknown bill `TxnID` in `applyTo` rejects the whole payment atomically — no partial mutations.

`qb_bill_payment_list` queries bill payments across both BillPaymentCheck and BillPaymentCreditCard stores by default; pass `paymentType: "check" | "creditcard"` to scope to one type.

| Tool | Description |
|------|-------------|
| `qb_bill_list` | List/search bills. Pass `includeLineItems: true` for `ExpenseLineRet` + `ItemLineRet` per row. Pass `paginate: true` for caller-driven iterator pagination, or `autoExhaust: true` (Phase 16 #73) to drain the iterator server-side and return the merged result in one call — capped by `maxBatches` (default 20 ≈ 10k rows); `includeLineItems` threads through every batch unchanged. |
| `qb_bill_create` | Create a new bill. Takes `expenseLines: [{accountName, amount, memo?, className?}]` and/or `itemLines: [{itemName, quantity, cost, memo?}]`. Item line `Amount = quantity * cost`. |
| `qb_bill_update` | Modify an existing bill. Pass `txnId` + `editSequence` plus any header fields and/or replacement `expenseLines` / `itemLines`. Header-only mods leave existing lines untouched. Vendor balance adjusts by `newAmountDue - oldAmountDue` (or full reverse-then-apply if `vendorName` / `vendorListId` re-points the bill). |
| `qb_bill_delete` | Delete a bill |
| `qb_bill_duplicate` | Duplicate an existing bill. Reads source via `sourceTxnId`, carries `VendorRef` + expense lines + item lines onto a fresh `BillAddRq`. Defaults: `TxnDate` → today, `DueDate` / `RefNumber` → unset, `Memo` → `"Duplicate of <source ref or TxnID>"`. Override via `txnDate` / `dueDate` / `refNumber` / `memo` / `vendorName` / `vendorListId`. AP mirror of `qb_invoice_duplicate`. |
| `qb_bill_pay` | Pay one or more bills via check or credit card. `paymentMethod: "check" \| "creditcard"`; `applyTo` required and non-empty; reduces `Bill.AmountDue` and `Vendor.Balance` by the applied sum; `discountAmount` closes alongside the payment without moving vendor balance. |
| `qb_bill_payment_list` | List BillPaymentCheck + BillPaymentCreditCard records. Pass `paymentType` to scope to one. |

### Items (Products & Services)

QuickBooks has no generic "Item" — every item belongs to one of five subtypes. The `itemType` arg selects the subtype: `Service`, `Inventory`, `NonInventory`, `OtherCharge`, or `Group`.

| Tool | Description |
|------|-------------|
| `qb_item_list` | List/search items. `itemType` is optional — omit to query all five subtypes and merge. Pass `paginate: true` for caller-driven iterator pagination, or `autoExhaust: true` (Phase 16 #73) to drain the iterator server-side and return the merged result in one call — both REQUIRE `itemType` (QBXML iterators are scoped to a single `Item*QueryRq`, so neither path can fan across the 5 subtypes); `autoExhaust` is capped by `maxBatches` (default 20 ≈ 10k rows). |
| `qb_item_add` | Create a new item. `itemType` is required. |
| `qb_item_update` | Update item details. `itemType` is required and must match the stored subtype. |
| `qb_item_delete` | Delete an item. `itemType` is required so the correct `ListDelType` is sent. |

### Payments

`qb_payment_receive` accepts an optional `appliedTo: [{txnId, amount, discountAmount?, discountAccountName?}]` array. Each entry closes out part or all of an invoice's `BalanceRemaining` and decrements the customer's `Balance` by the applied amount. The unapplied portion (`UnusedPayment = totalAmount - sum(appliedTo.amount)`) sits on the payment record as a customer credit. Calling without `appliedTo` records the payment as fully unapplied — legitimate for prepayments. Invoice `TxnID`s are validated strictly: an unknown `txnId` rejects the whole payment.

`qb_payment_apply` re-targets an existing `ReceivePayment` against a different set of invoices via `ReceivePaymentMod` + `AppliedToTxnMod`. Pass `txnId` + `editSequence` (from a prior `qb_payment_list`) plus the replacement `applyTo` array. The new array REPLACES the payment's prior application wholesale: previously-applied invoices are reversed (their `BalanceRemaining` / `AppliedAmount` / `IsPaid` restored) and the new invoices receive the new application atomically (validate-first, then mutate). Customer `Balance` moves by the change in applied sum (new applied − old applied). Pass an empty `applyTo: []` to fully unapply the payment (it becomes pure customer credit). `TotalAmount` is immutable on this path. A stale `editSequence` rejects with statusCode 3170.

| Tool | Description |
|------|-------------|
| `qb_payment_receive` | Record a received payment. Optional `appliedTo` closes out specific invoices and reduces customer balance by the applied sum. |
| `qb_payment_apply` | Re-apply an existing payment to a different set of invoices. Reverses the prior application + applies the new one atomically; customer balance moves by the delta. |
| `qb_payment_list` | List received payments |

### Estimates

`qb_estimate_create` accepts a `lines` array (same shape as `qb_invoice_create`) and the simulation derives `Subtotal` from the line set server-side. `qb_estimate_update` mirrors `qb_invoice_update` — pass `txnId` + `editSequence` (from a prior list) plus any header fields and/or replacement `lines`; passing `lines` REPLACES the line set wholesale, lines with a matching `txnLineID` are merged in place, and `Subtotal` recomputes. Estimates aren't posted to AR — there's no customer-balance side effect (unlike `qb_invoice_update`). A stale `editSequence` rejects with statusCode 3170.

`qb_estimate_convert_to_invoice` is the meaty one. Real QB has no single "convert" RPC; this tool reads the source estimate, submits an `InvoiceAddRq` with `CustomerRef` + `EstimateLineRet` carried over (each line mapped to `InvoiceLineAdd`, with optional `ClassRef` / `TermsRef` / `SalesRepRef` / `PORefNumber` carry-over from the estimate header when present), and (default) marks the source estimate `IsAccepted: true`. The mark-accepted step runs AFTER the invoice is successfully created, so the new invoice is preserved even if the flip fails (rare — surfaced via `markAcceptedError` in the response). Pass `markAccepted: false` to leave the estimate unmarked (e.g. for partial conversions). The new invoice posts to AR and bumps the customer's `Balance` by its `BalanceRemaining` exactly like a regular `qb_invoice_create`.

| Tool | Description |
|------|-------------|
| `qb_estimate_list` | List/search estimates with customer/date/refNumber filters. |
| `qb_estimate_create` | Create a new estimate. Takes `lines: [{itemName, quantity, rate, amount?, description?}]`; `Subtotal` derived from the line set. |
| `qb_estimate_update` | Modify an existing estimate. Pass `txnId` + `editSequence` plus any header fields and/or replacement `lines: [{txnLineID?, itemName?, itemListId?, description?, quantity?, rate?, amount?}]`. Header-only mods leave existing lines untouched. `Subtotal` recomputes after line mods. Pass `isAccepted: true` to mark accepted manually. |
| `qb_estimate_delete` | Delete an estimate. Estimates aren't posted to AR so there's no balance to reverse. |
| `qb_estimate_convert_to_invoice` | Convert an estimate to an invoice. Carries `CustomerRef` + lines (and optional `ClassRef` / `TermsRef` / `SalesRepRef` / `PORefNumber`). Operator-supplied `invoiceTxnDate` / `invoiceDueDate` / `invoiceRefNumber` / `invoiceMemo` override the carried values. Default flips the estimate `IsAccepted: true` after the invoice is created — pass `markAccepted: false` to skip. |

### Sales Receipts

A `SalesReceipt` is the cash-sale equivalent of an `Invoice` — same line shape, but the sale settles instantly. There is no AR posting, no `BalanceRemaining`, no `IsPaid`, and no payment-application step: funds land in the account named by `depositToAccountName` (typically "Undeposited Funds" or a bank account) the moment the receipt is created. `paymentMethodName` documents how the customer paid (Check, Cash, Visa, etc.) — discoverable via `qb_payment_method_list`. The simulation derives `Subtotal` from the line set and `TotalAmount = Subtotal + SalesTaxTotal` server-side; sales-receipt mods recompute both automatically. Customer balance is never touched — sales receipts don't post to AR.

`qb_sales_receipt_update` mirrors `qb_invoice_update` / `qb_estimate_update`: pass `txnId` + `editSequence` (from a prior list) plus any header fields and/or replacement `lines`; passing `lines` REPLACES the receipt's existing line set wholesale (matching `txnLineID`s are merged in place, lines you don't list are dropped). Stale `editSequence` rejects with statusCode 3170.

| Tool | Description |
|------|-------------|
| `qb_sales_receipt_list` | List/search sales receipts with customer/date/refNumber filters. |
| `qb_sales_receipt_create` | Create a cash-sale receipt. Takes `lines: [{itemName, quantity, rate, amount?, description?}]` plus optional `paymentMethodName` and `depositToAccountName`. `Subtotal` + `TotalAmount` derive from the line set. |
| `qb_sales_receipt_batch_create` | Post 1–100 cash-sale receipts atomically in one envelope (same shape as `qb_invoice_batch_create`). Cash-sale rollback is structurally simpler than invoice rollback (no AR-balance reversal — cash sales don't post to AR). Use for point-of-sale day-end reconciliation, batch import of online-sale receipts, fundraiser bulk entry. Optional `idempotencyKey` fingerprints the whole entries list. |
| `qb_sales_receipt_update` | Modify an existing receipt. Pass `txnId` + `editSequence` plus any header fields and/or replacement `lines: [{txnLineID?, itemName?, itemListId?, description?, quantity?, rate?, amount?}]`. Header-only mods leave existing lines untouched. `Subtotal` + `TotalAmount` recompute after line mods. |
| `qb_sales_receipt_duplicate` | Duplicate an existing sales receipt. Reads source via `sourceTxnId`, carries `CustomerRef` + `PaymentMethodRef` + `DepositToAccountRef` + lines onto a fresh `SalesReceiptAddRq`. Defaults: `TxnDate` → today, `RefNumber` → unset, `Memo` → `"Duplicate of <source ref or TxnID>"`. Override via `txnDate` / `refNumber` / `memo` / `customerName` / `customerListId` / `paymentMethodName` / `depositToAccountName`. Cash-sale mirror of `qb_invoice_duplicate`. |
| `qb_sales_receipt_delete` | Delete a sales receipt. No AR balance to reverse; the deposit posting against `depositToAccountRef` is rolled back implicitly. |

### Credit Memos

A `CreditMemo` is the AR-negative analog of an `Invoice` — same line shape, but the total credits the customer instead of billing them. On creation `Customer.Balance` moves by `-TotalAmount` (the credit reduces what the customer owes). The credit's open balance is tracked as `RemainingValue = TotalAmount − AppliedAmount`; once `RemainingValue` hits zero the memo is fully consumed (every dollar applied to specific invoices). Pass `appliedTo: [{txnId, amount}]` on create to immediately close part or all of one or more open invoices, or omit it to leave the credit fully unapplied as a customer credit pool.

`qb_credit_memo_apply` re-targets an existing memo against a different set of invoices via `CreditMemoMod` + `AppliedToTxnMod`. Pass `txnId` + `editSequence` (from a prior `qb_credit_memo_list`) plus the replacement `applyTo` array. The new array REPLACES the memo's prior application wholesale: previously-applied invoices are reversed (their `BalanceRemaining` / `AppliedAmount` / `IsPaid` restored) and the new invoices receive the new application atomically (validate-first, then mutate). The customer's overall `Balance` does NOT move on re-apply — the credit pool just shifts between memo `RemainingValue` and invoice `BalanceRemaining`. Pass an empty `applyTo: []` to fully unapply (memo `RemainingValue` returns to `TotalAmount`). `TotalAmount` is immutable on this path. A stale `editSequence` rejects with statusCode 3170.

`qb_credit_memo_update` is for header / line edits, NOT re-application. Passing `lines` REPLACES the memo's `CreditMemoLineRet` wholesale, `Subtotal` + `TotalAmount` + `RemainingValue` all recompute, and customer balance adjusts by `-(newTotalAmount − oldTotalAmount)` so the AR-negative posting stays consistent. Header-only mods leave existing lines untouched. `AppliedAmount` is preserved across updates (it tracks invoice applications, not the line set).

| Tool | Description |
|------|-------------|
| `qb_credit_memo_list` | List/search credit memos with customer/date/refNumber filters. |
| `qb_credit_memo_create` | Create a credit memo. Takes `lines: [{itemName, quantity, rate, amount?, description?}]` plus optional `appliedTo: [{txnId, amount}]` for immediate auto-application. `Subtotal` + `TotalAmount` derive from the line set; customer balance moves by `-TotalAmount`. |
| `qb_credit_memo_update` | Modify an existing memo's header / line set. Pass `txnId` + `editSequence` plus any header fields and/or replacement `lines`. Header-only mods leave existing lines untouched; `Subtotal` / `TotalAmount` / `RemainingValue` recompute after line mods and customer balance adjusts by the delta. |
| `qb_credit_memo_apply` | Re-apply an existing credit memo to a different set of invoices. Reverses the prior application + applies the new one atomically; customer balance does NOT move (the credit pool just shifts to invoice-level). Pass `applyTo: []` to fully unapply. |
| `qb_credit_memo_delete` | Delete a credit memo. Reverses the AR-negative posting (`Customer.Balance += TotalAmount`) and restores any applied invoice balances. |

### Purchase Orders

A `PurchaseOrder` is the vendor-side analog of an `Estimate` — a non-posting commitment to buy from a vendor. It does NOT touch `Vendor.Balance` or AP: the vendor balance only moves when items are received against the PO via a bill (or via ItemReceipt, which this server doesn't expose yet). Lines use `Cost` (not `Rate` — that's the AR side); each line's `Amount = Quantity * Cost` is computed at the tool layer. `TotalAmount` aggregates from the line set directly — POs have no separate `Subtotal` header.

`IsManuallyClosed` is a header flag operators can set to mark a PO closed regardless of receipt activity (typical workflow: cancel a PO that won't be received). Real QB exposes it on both Add and Mod; this server surfaces it on `qb_purchase_order_create` and `qb_purchase_order_update`. The simulation stores it on the entity but doesn't drive automation off it (no auto-close when fully received against — that's a future Bill ↔ PO linkage we don't model yet).

`qb_purchase_order_update` mirrors `qb_invoice_update` / `qb_bill_update` for header/line edits. Passing `lines` REPLACES the line set wholesale (matching `txnLineID`s are merged in place, lines you don't list are dropped); `TotalAmount` recomputes after line mods. POs are non-posting so there is no vendor-balance side effect on either header or line changes. Stale `editSequence` rejects with statusCode 3170.

| Tool | Description |
|------|-------------|
| `qb_purchase_order_list` | List/search purchase orders with vendor/date/refNumber filters. |
| `qb_purchase_order_create` | Create a PO. Takes `lines: [{itemName, quantity, cost, description?, memo?}]` (at least one required). `TotalAmount = sum(quantity * cost)`. Optional `dueDate`, `shipToEntity`, `isManuallyClosed`. |
| `qb_purchase_order_update` | Modify an existing PO. Pass `txnId` + `editSequence` plus any header fields and/or replacement `lines: [{txnLineID?, itemName?, itemListId?, description?, quantity?, cost?, memo?}]`. Header-only mods leave existing lines untouched. `TotalAmount` recomputes after line mods. |
| `qb_purchase_order_delete` | Delete a PO. Non-posting, so no vendor balance to reverse — pure record removal. |

### Sales Orders

A `SalesOrder` is the customer-side analog of a `PurchaseOrder` — a committed-but-not-yet-invoiced order. **Distinct from `Estimate`:** estimates are quotes (the customer hasn't committed yet); sales orders are committed but not yet fulfilled, used for backorder / shipment / scheduled-service workflows. Like POs, sales orders are non-posting — they do NOT touch `Customer.Balance` or AR. The customer balance only moves when an invoice is created against the order (via `qb_sales_order_convert_to_invoice`, or a manual `qb_invoice_create` that mirrors the SO's lines). Lines use `Rate` (sales side, mirrors `qb_invoice_create`); the simulation derives `TotalAmount` from the line set — sales orders have no separate `Subtotal` header in this server's first cut.

`IsManuallyClosed` is a header flag that marks an order closed regardless of invoicing activity (typical workflows: cancel an order that won't ship, or close an order that's been partially invoiced and the remainder won't be billed). Real QB exposes it on both Add and Mod; this server surfaces it on `qb_sales_order_create` and `qb_sales_order_update`. The simulation stores it on the entity but doesn't drive automation off it (no auto-close when fully invoiced against — that would need a deeper Invoice ↔ SalesOrder linkage that this first cut doesn't model).

`qb_sales_order_update` mirrors `qb_invoice_update` / `qb_purchase_order_update` for header/line edits. Passing `lines` REPLACES the line set wholesale (matching `txnLineID`s are merged in place, lines you don't list are dropped); `TotalAmount` recomputes after line mods. Sales orders are non-posting so there is no customer-balance side effect on either header or line changes. Stale `editSequence` rejects with statusCode 3170.

`qb_sales_order_convert_to_invoice` mirrors `qb_estimate_convert_to_invoice`. Real QB has no single "convert" RPC for sales orders either — this tool reads the source order, submits an `InvoiceAddRq` with `CustomerRef` + `SalesOrderLineRet` carried over (each line mapped to `InvoiceLineAdd`, with optional `ClassRef` / `TermsRef` / `SalesRepRef` / `PONumber` carry-over from the order header when present), and (default) marks the source order `IsManuallyClosed: true`. The mark-closed step runs AFTER the invoice is successfully created, so the new invoice is preserved even if the flip fails (rare — surfaced via `markClosedError` in the response). Pass `markClosed: false` for partial conversions where another invoice will be billed against the remaining lines later (leave the SO open so it stays on the outstanding-orders list). The new invoice posts to AR and bumps the customer's `Balance` by its `BalanceRemaining` exactly like a regular `qb_invoice_create`.

| Tool | Description |
|------|-------------|
| `qb_sales_order_list` | List/search sales orders with customer/date/refNumber filters. Set `paginate: true` for iterator-based pagination (auto-defaults `maxReturned` to 500). |
| `qb_sales_order_create` | Create a sales order. Takes `lines: [{itemName, quantity, rate, amount?, description?}]` (at least one required). `TotalAmount = sum(line amounts)`. Optional `dueDate`, `poNumber`, `isManuallyClosed`. |
| `qb_sales_order_update` | Modify an existing sales order. Pass `txnId` + `editSequence` plus any header fields and/or replacement `lines: [{txnLineID?, itemName?, itemListId?, description?, quantity?, rate?, amount?}]`. Header-only mods leave existing lines untouched. `TotalAmount` recomputes after line mods. `isManuallyClosed` flips the order's closed state. |
| `qb_sales_order_delete` | Delete a sales order. Non-posting, so no customer balance to reverse — pure record removal. Invoices already spawned against the SO are NOT touched. |
| `qb_sales_order_convert_to_invoice` | Convert a sales order to an invoice. Carries `CustomerRef` + lines (and optional `ClassRef` / `TermsRef` / `SalesRepRef` / `PONumber`). Operator-supplied `invoiceTxnDate` / `invoiceDueDate` / `invoiceRefNumber` / `invoiceMemo` override the carried values. Default flips the order `IsManuallyClosed: true` after the invoice is created — pass `markClosed: false` for partial conversions. |

### Sales Tax

Monthly sales-tax cycle for any client with taxable sales. Five tools cover discovery (codes, items, agencies), the liability report at month-end, and writing the actual payment check to the agency. Real QB models sales tax through three coordinated entities:

- **`SalesTaxCode`** is a 1-3 character flag (TAX / NON / OUT) stamped on customers and line items to indicate **whether** that party or line is taxable. Codes carry NO rate — they're classifiers; the actual `TaxRate` lives on the `SalesTaxItem` paired with the code on a posted transaction.
- **`ItemSalesTax`** (a.k.a. "sales tax item") carries the actual `TaxRate` (decimal percent) and the `TaxVendorRef` pointing at the agency that collects it. When a transaction posts with an `ItemSalesTaxRef`, real QB applies `TaxRate × taxable-line-subtotal` and posts the result as `SalesTaxTotal` on the txn header.
- **`ItemSalesTaxGroup`** bundles multiple `SalesTaxItem`s so a single line (e.g. "CA-LA Combined") collects state + county at once. Real QB resolves group → component items at posting time; the liability report walks `ItemSalesTax` (not Group), so groups are list-only here.

Sales-tax agencies are **not a separate entity** in real QB — they're regular `Vendor` records that happen to appear as `TaxVendorRef` on `SalesTaxItem` records. `qb_sales_tax_agency_list` derives the agency set from distinct `TaxVendorRef` values across active `SalesTaxItem`s, optionally enriches each row with the full `Vendor` record, and rolls up the list of tax items collected per agency.

`qb_sales_tax_liability_report` wraps `GeneralSummaryReportQueryRq` with `GeneralSummaryReportType=SalesTaxLiability`. Each row carries `TaxCollected` (sum of header `SalesTaxTotal` on `Invoice` + `SalesReceipt` where the txn carried this tax item, minus `CreditMemo` returns), `TaxPaid` (sum of `SalesTaxPaymentCheckLineRet.Amount` in the window), and `TaxPayable = TaxCollected − TaxPaid`. Per-agency rollups + grand totals included. Simulation mode tracks collection at the **header level only** (`txn.ItemSalesTaxRef` + `txn.SalesTaxTotal`); per-line tax flagging is not modeled — real QB tracks both. For the typical month-end question "what do I owe each agency this month?" the header-level model is sufficient.

`qb_sales_tax_payment_create` wraps `SalesTaxPaymentCheckAddRq` — **distinct from `qb_check_create`** because its lines reduce sales-tax-item liability instead of posting to expense GL. Each line names ONE `SalesTaxItem` + an `Amount`; the sum is drawn from the named bank account. A regular `qb_check_create` posted to a sales-tax-liability account would double-count (real QB's payable account is debited automatically by the payment check; a manual debit on top would over-reduce it). The payment is bank-affecting (default `ClearedStatus: NotCleared`; participates in `qb_uncleared_transactions`) and supports idempotency keys.

| Tool | Description |
|------|-------------|
| `qb_sales_tax_code_list` | List sales-tax codes (TAX / NON / OUT etc.). Filters: `nameFilter`, `activeOnly`, `maxReturned`, `listId`. Each row carries `IsTaxable: boolean`. |
| `qb_sales_tax_item_list` | List sales-tax items + groups. Default fans across `ItemSalesTaxQueryRq` + `ItemSalesTaxGroupQueryRq`; pass `taxItemType: 'Item' \| 'Group'` to scope. Each row carries an `ItemType` discriminator ('SalesTaxItem' or 'SalesTaxGroup'). Items expose `TaxRate` + `TaxVendorRef`. |
| `qb_sales_tax_agency_list` | List sales-tax agencies (Vendors referenced as `TaxVendorRef` on any active `SalesTaxItem`). Each row carries `agencyName` / `agencyListId` / `taxItems: [{name, listId, taxRate}]` + (default) full `vendorDetails`. Pass `includeVendorDetails: false` to skip the per-agency Vendor lookup. |
| `qb_sales_tax_liability_report` | Run the Sales Tax Liability report. Returns `rows` (per tax item) + `byAgency` (per agency rollup) + `totals` (grand). Each row: `agencyName / taxItemName / taxRate / taxCollected / taxPaid / taxPayable`. Filters: `fromDate`, `toDate`, `basis`. |
| `qb_sales_tax_payment_create` | Write a sales-tax payment check (`SalesTaxPaymentCheckAddRq`). Required: `bankAccountName` (or `bankAccountListId`), `payeeName` (or `payeeListId`), `lines: [{salesTaxItemName, amount}]` (at least one). `TotalAmount` derives from the line sum. Idempotency key supported. |

### Inventory Adjustments

`qb_inventory_adjustment_*` covers the operational primitive every client carrying inventory needs: shrinkage write-offs after a physical count, periodic count corrections, value write-downs for obsolete or damaged stock, and value write-ups for reappraisal. Each adjustment carries an `AccountRef` header (the offsetting GL account — typically `Inventory Adjustment` expense, `Cost of Goods Sold`, or a dedicated `Shrinkage Expense`) plus one or more lines. Per line, the operator picks one of three shapes:

- **Pure quantity adjustment** via `newQuantity` (absolute) OR `quantityDifference` (signed delta — negative for shrinkage). Value moves at the item's current `AverageCost` server-side: `ValueDifference = quantityDifference × AverageCost`.
- **Pure value adjustment** via `newValue` (absolute total) OR `valueDifference` (signed dollar delta). Used to reprice without changing count — e.g. write down obsolete inventory from $50/each to $20/each. The unit count stays the same; `AverageCost` recomputes.
- **Combined value + quantity adjustment** — both branches in one line. Real QB requires the value side to be explicit when both move (otherwise it derives value at current `AverageCost`).

The simulation mutates `ItemInventory.QuantityOnHand` / `QuantityOnHandValue` / `AverageCost` on every referenced item. **`AverageCost` recomputes from post-adjustment value/qty**, EXCEPT when `QuantityOnHand` falls to zero — then the prior cost is preserved (matches real QB; a future restock keeps its cost-basis history). **Two-phase commit** at the sim layer: every line is validated before any mutation lands, so a malformed line in position 5 won't leave items 1-4 partially adjusted. **On query**, real QB normalizes both input shapes — every line returns `QuantityDifference + ValueDifference` regardless of which input form was used; the sim mirrors. `TotalAmount = Σ ValueDifference` (negative on shrinkage).

`qb_inventory_adjustment_delete` reverses every line's qty/value delta against the still-present `ItemInventory` row. Orphan items (item deleted out from under the adjustment) are silently skipped — a missing item must not block transaction deletion.

There is **no `_update` tool** — `InventoryAdjustmentModRq` exists in the QBXML SDK but the operational pattern in real QB is delete + recreate, and the recompute logic for partial line edits (rewind old deltas, apply new) is meaningfully more complex than a regular `_update`. Operators delete + re-add when an adjustment needs to change.

**Enterprise-only fields** (`SerialNumber`, `LotNumber`, `InventorySiteRef`, `InventorySiteLocationRef`) are intentionally NOT exposed — they require QuickBooks Enterprise with Advanced Inventory enabled. **GL posting** to `AccountRef` is NOT modeled in sim's first cut (matches the deferred JE-line customer-balance behavior — real QB posts the offset automatically). Reports / TB walks see the `InventoryAdjustment` in the transaction-list if scoped to `AccountRef` but won't see implicit balancing entries.

| Tool | Description |
|------|-------------|
| `qb_inventory_adjustment_list` | List inventory adjustments with `txnId` / `refNumber` / `accountName` / `accountListId` / date-range filters. Pass `includeLineItems: true` to surface each row's `InventoryAdjustmentLineRet` (per-line `ItemRef` + `QuantityDifference` + `ValueDifference` + `Amount`). Default false — header totals only. |
| `qb_inventory_adjustment_create` | Create an adjustment. Required: `accountName` (or `accountListId`) + `lines: [{itemName | itemListId, …}]` (at least one). Each line picks one shape: quantity (`newQuantity` XOR `quantityDifference`), value (`newValue` XOR `valueDifference`), or combined (any value field paired with any quantity field). Optional `txnDate` / `refNumber` / `memo` / `customerName` (cost allocation) / `className`. `idempotencyKey` supported. |
| `qb_inventory_adjustment_delete` | Delete an adjustment. Reverses every line's qty/value delta against the still-present `ItemInventory` row (orphan items silently skipped). After delete, each affected item's QuantityOnHand / QuantityOnHandValue / AverageCost return to their pre-adjustment state. |

### Statement Charges

`qb_statement_charge_*` covers service-business **time-and-materials billing without a formal invoice**. A statement charge accumulates on a customer's account and rolls up onto the customer statement at month-end — useful for hourly engagements where every billable session is recorded as a separate line on the customer's running tab, then a single Statement print summarizes them at the end of the period. (QB Desktop's Create Statements UI is what produces the actual customer-facing statement PDF; the qbXML SDK does not expose statement generation, so this tool only manages the underlying charges that feed into it.)

Structurally StatementCharge is **unique** among this server's transaction types — it is **single-row** at the txn header. `ItemRef` / `Quantity` / `Rate` / `Amount` live directly on the transaction body, NOT in a `*LineAdd` array. There is one ItemRef per StatementCharge; for multi-line work-style billing the operator creates one statement charge per line (each gets its own `TxnID` + `RefNumber` and a distinct row on the customer's statement). The simulation's `convertLinesAddToRet` pass is a no-op for StatementCharge (no key matches the `*LineAdd` pattern) and `computeTotals` derives `Amount + Balance` from the header fields directly.

**AR posting:** `Customer.Balance` moves by `+Amount` on create and `-Amount` on delete. Update: signed delta (`newAmount − oldAmount`) if the same customer; full reverse-then-apply if the `CustomerRef` itself changed. Mirrors `qb_invoice_update`'s policy on customer re-target. **Amount derivation:** explicit `amount` wins; otherwise `Amount = quantity × rate` when both are supplied. On update, an explicit `amount` arg wins over the `quantity × rate` re-derivation; passing `quantity` OR `rate` without `amount` drops the stored `Amount` and re-derives from the merged values.

**Limitation:** sim's first cut does NOT walk `ReceivePayment.AppliedToTxnAdd` across the StatementCharge store — a payment referencing a statement charge `TxnID` will reject with "Invoice not found" because `validateTxnApplications` looks up only the Invoice store. Real QB closes statement charges via `ReceivePayment` just like invoices; future work extends `applyTxnApplications` to fan across both stores. For now, when a customer pays a statement charge, record an unapplied `ReceivePayment` (no `appliedTo` arg) — the customer's open AR drops by `TotalAmount` but the underlying `StatementCharge.Balance` field stays unchanged in sim.

| Tool | Description |
|------|-------------|
| `qb_statement_charge_list` | List statement charges with `txnId` / `refNumber` / `customerName` / `customerListId` (server-side EntityFilter) / date-range filters. `paginate: true` auto-defaults `maxReturned` to 500 (QB's per-batch cap). |
| `qb_statement_charge_create` | Create a charge. REQUIRED: `customerName` (or `customerListId`) AND `itemName` (or `itemListId`) AND either explicit `amount` OR both `quantity + rate`. Optional `txnDate` / `dueDate` / `refNumber` / `description` / `className`. `idempotencyKey` supported. Customer.Balance moves by `+Amount`. |
| `qb_statement_charge_update` | Update a charge. Pass `txnId` + `editSequence` (from a prior list) plus any header fields. Changing `quantity` OR `rate` without `amount` re-derives `Amount = newQuantity × newRate`. Customer re-target reverses old amount against old customer, applies new amount to new. Stale editSequence → 3170. |
| `qb_statement_charge_delete` | Delete a charge. Customer.Balance reverses by `-Amount`. Irreversible. |

### Journal Entries

A `JournalEntry` is the structural outlier of the transaction family — every other transaction posts from a single side (invoice → AR, bill → AP, etc.) but a JE is fundamentally two-sided: every entry carries a `debits` array AND a `credits` array, each line naming a GL account by full name. The hard invariant is `sum(debits.amount) === sum(credits.amount)` to the cent (real QB rejects unbalanced entries with statusCode 3030; the simulation matches this and validates **before persist** on both create and update so a doomed entry never lands in the store). The simulation stores `TotalDebit` + `TotalCredit` on the entry for inspection (always equal by invariant); there is no single `TotalAmount` header field on a JE.

Each line accepts an optional `entityName` to attach a Customer / Vendor / Employee / OtherName reference. **The reference is recorded faithfully but does NOT move that entity's open balance in this server's first cut.** Real QB moves AR/AP per-line when a debit/credit on a Customer or Vendor line lands; that bookkeeping is meaningfully more involved than a single `adjustPartyBalanceForTxn` call (each line is its own posting, sign depends on debit-vs-credit + AR-vs-AP, and a single JE can touch many entities) and is deferred. Per-line `className` is similarly recorded but not used for any reporting rollup yet.

`qb_journal_entry_update` mirrors the rest of the transaction-update tools for header / line edits. Pass `txnId` + `editSequence` (from a prior `qb_journal_entry_list`) plus any header fields and/or replacement `debits` / `credits` arrays. Passing `debits` REPLACES the debit-side wholesale (matching `txnLineID`s are merged in place, lines you don't list are dropped); same for `credits`. Either side can be replaced independently — but the **post-mod sums must still balance** or the mod is rejected with statusCode 3030 and nothing is persisted (no partial state). A stale `editSequence` rejects with statusCode 3170.

| Tool | Description |
|------|-------------|
| `qb_journal_entry_list` | List/search journal entries with date / refNumber / modified-date filters. |
| `qb_journal_entry_create` | Create a JE. Takes `debits: [{accountName, amount, memo?, entityName?, className?}]` AND `credits: [...]` (at least one line on each side). `sum(debits) === sum(credits)` enforced; statusCode 3030 on imbalance. |
| `qb_journal_entry_batch_create` | Atomic batch create — `entries: [{txnDate?, refNumber?, memo?, isAdjustment?, debits, credits}]` (1–100 entries). Per-entry balance validated upfront so a single bad entry rejects the whole batch with no wire I/O. The wire envelope uses `onError=stopOnError`; if a later entry fails after earlier ones posted, the tool auto-deletes the prior-posted JEs (`rolled-back`). If a rollback delete itself fails, that JE is surfaced as `orphaned` with the TxnID for manual cleanup via `qb_journal_entry_delete`. |
| `qb_journal_entry_update` | Modify an existing JE. Pass `txnId` + `editSequence` plus any header fields and/or replacement `debits` / `credits`. Either side can be replaced independently; the post-mod sums must still balance or the mod rejects with 3030. |
| `qb_journal_entry_duplicate` | Duplicate an existing journal entry. Reads source via `sourceTxnId`, carries both line sides verbatim (preserving the sum-balance invariant by construction) plus `IsAdjustment`. Per-line `EntityRef` and `ClassRef` carry through. Defaults: `TxnDate` → today, `RefNumber` → unset, `Memo` → `"Duplicate of <source ref or TxnID>"`. Override via `txnDate` / `refNumber` / `memo` / `isAdjustment`. Use for recurring monthly accruals / prepaid amortization / standing entries. |
| `qb_journal_entry_delete` | Delete a JE. No AR/AP balance to reverse (per-line entity-balance moves are deferred) — pure record removal. |

### Employees

`qb_employee_make_inactive` is the preferred way to retire an employee — it flips `IsActive: false` so the employee hides from the default `qb_employee_list` view but stays referenceable by historical paychecks, timesheets, and payroll reports. `qb_employee_delete` is a hard delete that real QB rejects (statusCode 3260/3170) for employees with any transaction history; use it only for empty employee records created in error. Both wrap structured tool errors via `isError: true` + `statusCode` so stale `editSequence` (3170) and unknown `listId` (500) surface cleanly.

| Tool | Description |
|------|-------------|
| `qb_employee_list` | List/search employees. Pass `paginate: true` for caller-driven iterator pagination, or `autoExhaust: true` (Phase 16 #73) to drain the iterator server-side and return the merged result in one call — capped by `maxBatches` (default 20 ≈ 10k rows); cap-hit returns the partial result + `iteratorID` for resumption. |
| `qb_employee_add` | Create an employee record |
| `qb_employee_update` | Update employee details (firstName / lastName / phone / email / isActive) |
| `qb_employee_make_inactive` | Deactivate an employee by ListID + EditSequence (sets IsActive: false). Reversible via `qb_employee_update { isActive: true }`. |
| `qb_employee_delete` | Hard-delete an employee by ListID. Fails for employees with paycheck/timesheet history — use `qb_employee_make_inactive` instead. |

### Time Tracking

`TimeTracking` records ONE work session — a date, a worker (`EntityRef` — Employee / Vendor / OtherName), an optional customer/job (line-level — TimeTracking is the one transaction type that carries BOTH `EntityRef` and `CustomerRef`), an optional service item, and a `Duration` (ISO 8601 PT-H-M-S). The entry is **non-posting** — no GL effect, no AR/AP movement. Downstream consumers are payroll (when `PayrollItemWageRef` is set) and the Time/Costs dialog on the invoice form (when `IsBillable: true`).

QB's `TimeTrackingQueryRq` is the only transaction-type wire request with no `CustomerFilter` at any qbXML version — customer scope on the list tool is applied as a POST-FILTER in the tool layer (documented on the tool description; matters when combined with `paginate: true`, which may miss matches beyond the page). The list tool emits a derived `hours` field (decimal hours parsed from `Duration` via `parseDurationToHours`) on every row for convenience — `qb_engagement_profitability` is the first cross-tool consumer of that helper.

| Tool | Description |
|------|-------------|
| `qb_time_track_list` | List/search TimeTracking entries with filters for `txnId`, worker (`entityName` / `entityListId` — server-side `EntityFilter`), customer (`customerName` / `customerListId` — POST-FILTERED), date range, and `billableOnly` (POST-FILTERED). Each row carries the parent fields plus a derived `hours` decimal. Set `paginate: true` for iterator pagination (auto-defaults `maxReturned` to 500). |
| `qb_time_track_add` | Record a new TimeTracking entry. Requires a worker (`entityName` / `entityListId`) and either `hours` (decimal — converted to ISO `PT-H-M-S`) or `duration` (pre-formatted ISO). Optional `customerName` / `customerListId` attaches the work to a job; optional `itemServiceName` / `itemServiceListId` names what to bill as; `billable: true` flips `IsBillable` / `BillableStatus` for downstream invoice flow via the Time/Costs dialog. Optional `payrollItemWageName` links to payroll (live QB requires a payroll subscription). Read-only sessions reject with `9001`. Optional `idempotencyKey`. |

### Vehicle Mileage

`qb_vehicle_*` and `qb_vehicle_mileage_*` cover the **Schedule C / Form 4562 mileage log** workflow — the IRS-required record of business miles driven on a self-employed return or a corporate Listed Property schedule. Each `VehicleMileage` entry records ONE trip: a vehicle, a `TripStartDate` + `TripEndDate`, a distance source (either `OdometerStart` + `OdometerEnd` — the sim derives `TotalMiles = end − start` — OR an explicit `TotalMiles` for short trips with no odometer reading), an optional `CustomerRef` for billable mileage, an optional `ItemRef` carrying the per-mile rate, and a `BillableStatus`.

VehicleMileage is a **TRANSACTION** in QB (carries `TxnID`, deletes via `TxnDelRq`) but **non-posting** — no GL effect, no AR/AP movement. Sister surface to `qb_time_track_*`: both are write-once payloads consumed by payroll and the Time/Costs dialog on invoice creation. The four runtime transaction-type lists (builder.ts / manager.ts / simulation-store.ts) plus the [CLAUDE.md](CLAUDE.md) doc list at line 58 all carry `VehicleMileage`.

**No `_update` tool.** The qbXML SDK exposes NO `VehicleMileageModRq` at any version through 16.0 — recorded trips are immutable from the SDK's perspective. If a trip needs to change, the operator deletes it in QB Desktop and re-adds via `qb_vehicle_mileage_add`. Delete is also intentionally omitted from this first cut (mileage logs are auditable records that operators rarely delete); the four-list-sync infrastructure is in place so a future `qb_vehicle_mileage_delete` is a thin add.

Vehicle is a **list entity** (ListID + FullName + IsActive + Desc). This server exposes `qb_vehicle_list` as a read-only discovery surface paired with `qb_vehicle_mileage_add` — vehicles are infrequent setup work (a CPA firm adds a new truck once a year) and operators add them through QB Desktop's UI directly. `qb_vehicle_list` defaults to `ActiveOnly`; pass `includeInactive: true` to see retired vehicles (mileage logs against a retired vehicle still surface in `qb_vehicle_mileage_list` — Vehicle.IsActive only affects which rows show up in the vehicle list itself, not history).

`qb_vehicle_mileage_list` filters by `txnId` / `vehicleName` / `vehicleListId` (server-side `VehicleFilter`) / `customerName` / `customerListId` (POST-FILTERED at the tool layer because QB's `VehicleMileageQueryRq` has no `CustomerFilter`) / `fromDate` / `toDate` (TripStartDate-scoped via `TripDateRangeFilter` — VehicleMileage has NO `TxnDate` field; the trip dates ARE the canonical timestamps) / `billableStatus` (`Billable` | `NotBillable` | `HasBeenBilled` — server-side `BillableStatus` filter). Pagination via `paginate: true` (auto-defaults `maxReturned` to 500).

| Tool | Description |
|------|-------------|
| `qb_vehicle_list` | List Vehicles (the discovery surface for `qb_vehicle_mileage_add`). Default `ActiveOnly`; `includeInactive: true` includes retired vehicles. Filter by `nameFilter` (Contains) or `vehicleListId`. Read-only — vehicle CRUD lives in QB Desktop's UI. |
| `qb_vehicle_mileage_list` | List/search vehicle mileage trips. Filter by `txnId` / `vehicleName` / `vehicleListId` (server-side `VehicleFilter`) / `customerName` / `customerListId` (POST-FILTERED — QB has no `CustomerFilter`) / `fromDate` / `toDate` (TripStartDate window — NOT TxnDate) / `billableStatus`. `paginate: true` auto-defaults `maxReturned` to 500. |
| `qb_vehicle_mileage_add` | Log a new trip. REQUIRED: `vehicleName` (or `vehicleListId`) AND `tripStartDate` + `tripEndDate` AND either `totalMiles` directly OR BOTH `odometerStart` + `odometerEnd` (sim derives `TotalMiles = end − start` when totalMiles is omitted; explicit `totalMiles` wins). Optional `customerName` / `customerListId` + `itemName` / `itemListId` + `className` + `notes`; `billable: true` → `BillableStatus='Billable'`. **No `_update` tool** — the qbXML SDK has no `VehicleMileageModRq`; delete + recreate via QB Desktop's UI to correct a trip. Read-only sessions reject with `9001`. Optional `idempotencyKey`. |

### Reference Lists

Read-only lookups for the supporting types that transactions reference by `FullName` or `Name`. Operators need these to discover valid values to pass into invoice/bill/payment creation (the Class on a line, the Terms on an invoice header, the PaymentMethod on a receive-payment, etc.). New entries are defined in QuickBooks itself, not via this server.

`qb_terms_list` is the only one that fans out: real QB splits the underlying type into `StandardTerms` (e.g. "Net 30" — fixed days from invoice date) and `DateDrivenTerms` (e.g. "Due on 15th" — fixed calendar day). The default call queries both stores and merges, attaching a `TermsType: "StandardTerms" | "DateDrivenTerms"` discriminator to each row. Pass `termsType: "Standard" | "DateDriven"` to scope.

| Tool | Description |
|------|-------------|
| `qb_class_list` | List Classes (department / location / cost-center labels). |
| `qb_terms_list` | List payment Terms. Default fans across StandardTerms + DateDrivenTerms; pass `termsType` to scope. |
| `qb_payment_method_list` | List Payment Methods (Check, Cash, Visa, etc.). |
| `qb_sales_rep_list` | List Sales Reps (keyed by Initial). |
| `qb_customer_type_list` | List Customer Types (Commercial, Residential, Government, etc.). |
| `qb_vendor_type_list` | List Vendor Types (Supplier, Subcontractor, etc.). |
| `qb_custom_field_list` | List custom-field (DataExt) DEFINITIONS configured on the company file — one row per `(OwnerID, DataExtName)` pair with `DataExtType` + `AssignToObject` (the entity types each def applies to). Wraps `DataExtDefQueryRq`. Scope to one namespace via `ownerId` (`"0"` = standard company-defined; UUIDs = third-party app namespaces); narrow to defs applicable to a specific entity type via `assignToObject` (Customer / Vendor / Invoice / etc.). Pair with `includeCustomFields: true` on the entity list tools — `qb_customer_list` / `qb_vendor_list` / `qb_invoice_list` / `qb_bill_list` / `qb_item_list` / `qb_account_list` / `qb_employee_list` all accept the flag; when set, every returned row carries a `DataExtRet` array with that entity's custom-field VALUES filtered to the requested OwnerID (default `"0"`). Real QB strips `DataExtRet` from query responses by default, mirrored here — opt-in only, which keeps the default response payloads lean. Read-only — DataExtAdd / DataExtMod / DataExtDel for setting CF VALUES is deferred; operators set CF values in QB Desktop directly. |

### Reports & Queries
| Tool | Description |
|------|-------------|
| `qb_company_info` | Run `CompanyQueryRq` for company name/legal name/address/fiscal year/tax form/EIN, plus session state (connected/simulationMode/sessionTicket/openedAt). Auto-connects on first call. |
| `qb_host_query` | Run `HostQueryRq` for QB Desktop installation metadata — `productName` / `majorVersion` / `minorVersion` / `country` / `supportedQbxmlVersions` (flattened) / `isAutomaticLogin` / `qbFileMode` (`SingleUser` \| `MultiUser`) plus derived `edition` (`Pro` \| `Premier` \| `PremierAccountant` \| `Enterprise` \| `EnterpriseAccountant` \| `Unknown`), `isEnterprise`, `isAccountant`, and `maxQbxmlVersion`. **Cached** at the session manager: first call hits the wire, subsequent calls return the cached value until `qb_company_open` invalidates it. Pass `refresh: true` to force a re-query (rare — for QB Desktop upgraded mid-process). Use `edition` to gate edition-specific tools (Enterprise-only audit log, Accountant-edition reports, etc.) — **never parse `productName` directly**. Payroll subscription is NOT derivable from this response. |
| `qb_balance_summary` | Balance summary across all accounts as of a specified date, grouped by AccountType in canonical QB order (Assets → Liabilities → Equity → Income → Expenses → NonPosting) with category subtotals (assets/liabilities/equity/income/expenses/netIncome). Asset/Liability/Equity figures are sourced from `BalanceSheetStandard` (toDate=asOfDate); Income/Expense figures are sourced from `ProfitAndLossStandard` (lifetime through asOfDate). NonPosting accounts fall back to `Account.Balance`. Optional `asOfDate` (YYYY-MM-DD, defaults to today) and `basis` (`Accrual` \| `Cash`). Note: in simulation mode, `BalanceSheetStandard` reads `Account.Balance` for AS/LI/EQ (a snapshot — `asOfDate` is advisory for those buckets); the P&L walk IS date-bounded in both modes. |
| `qb_trial_balance_export` | Tax-season-workpaper-shaped trial balance. One row per posting account with non-zero balance: `accountListId` / `accountName` / `accountNumber` / `accountType` / `taxLine` (from `Account.TaxLineInfoRet.TaxLineName` — populated by live QB and by sim seed for the mapped accounts; null for unmapped) / `debitBalance` / `creditBalance` / `isActive` / `lastActivityDate`. Debits and credits split by **natural-balance side**: Asset/Expense balances → debit column, Liability/Equity/Income → credit column. A contra-balance (e.g. negative AR = customer credit on file) flips to the OTHER column rather than appearing as a negative number, matching the workpaper convention bookkeepers expect. Sorted by canonical AccountType then `AccountNumber` (numbered accounts first within type) then alphabetical `FullName`. Plus four reconciliation cross-checks: `balanceSheet` (`Assets ≡ Liabilities + Equity`), `netIncome` (`P&L NetIncome ≡ BS NetIncome`), `arReconciliation` (AR account TB balance ≡ AR aging total), `apReconciliation` (AP account TB balance ≡ AP aging total) — each with `delta` and a `matches` / `reconciles` boolean at cent-tolerance. **Any mismatch is an audit signal — surface loudly, do not paper over.** Composite of 5 wire calls in the default path: `AccountQueryRq` + `BalanceSheetStandard` + `ProfitAndLossStandard` + `InvoiceQueryRq` (for AR aging total) + `BillQueryRq` (for AP aging total). NonPosting accounts (estimates / POs / sales orders) are excluded from the TB by convention; for NonPosting balances use `qb_balance_summary`. Defaults: `includeInactive: false` (inactive accounts dropped), `includeZeroBalances: false` (zero-balance rows dropped — TB convention; flip to true to verify chart coverage), `includeLastActivityDate: false` (the opt-in fans out one `TransactionQueryRq` per row to surface the most-recent posting date — N+5 round trips, ~10s for a 200-account chart in live mode; per-account errors land in `warnings` and the row's `lastActivityDate` stays null). Same sim caveat as `qb_balance_summary`: BS reads `Account.Balance` for AS/LI/EQ snapshot in sim (`asOfDate` advisory for those buckets); the P&L walk IS date-bounded in both modes; cross-check arithmetic is correct in both. Bridges the operator's `trial-balance-workup` skill from manual CSV-export-from-QB-Desktop to direct MCP query. |
| `qb_tax_line_mapping` | Tax-line mapping for the chart of accounts — direct bridge from QB books to a tax-prep workpaper. Returns each posting account's tax-line assignment (`Sch C` / `Sch L` / `1120-S` / `1065` / `Sch E` / etc.) from `Account.TaxLineInfoRet.{TaxLineID, TaxLineName}` so the preparer can group accounts by tax-line code without rebuilding the mapping by hand. Same shape `qb_trial_balance_export`'s `taxLine` column reads from. Returns `{ count, mappedCount, unmappedCount, accounts: [{accountListId, accountName, accountNumber, accountType, isActive, taxLineId, taxLineName, isUnmapped}] }` sorted by canonical AccountType → AccountNumber → name (workpaper convention). Defaults: `includeInactive: false` (inactive accounts dropped — workpaper convention), `includeUnmapped: false` (only mapped accounts surface). Pass `includeUnmapped: true` to surface accounts missing a tax-line assignment — a workpaper-prep audit. An account is "mapped" when `TaxLineInfoRet.TaxLineName` is a non-empty string; an account with `TaxLineID` but no `TaxLineName` is treated as unmapped (the name is the workpaper-readable label every consumer keys on, but `taxLineId` is preserved on the row as an audit signal). Optional scope: `accountListId` (single account by ListID), `accountName` (single account by FullName), `accountType` (one of `Bank` / `Income` / `Expense` / `AccountsReceivable` / etc. — same enum as `qb_account_add`). Pure projection over `AccountQueryRq` — same wire request `qb_account_list` uses. Bridges the workpaper-review step from "manually rebuild the mapping" to one tool call. |
| `qb_ar_aging` | Accounts receivable aging — walks open invoices (`IsPaid !== true`, `BalanceRemaining > 0`), ages each by `(asOfDate − DueDate ?? TxnDate)`, buckets into `0-30` / `31-60` / `61-90` / `90+` days. Returns per-customer aging with bucket breakdown plus top-level `bucketTotals`. Optional `asOfDate` (YYYY-MM-DD, defaults to today). Single invoice = single bucket. |
| `qb_ap_aging` | Accounts payable aging — walks open bills (`IsPaid !== true`, `AmountDue > 0`), ages each by `(asOfDate − DueDate ?? TxnDate)`, buckets into `0-30` / `31-60` / `61-90` / `90+` days. Returns per-vendor aging with bucket breakdown plus top-level `bucketTotals`. Optional `asOfDate` (YYYY-MM-DD, defaults to today). Single bill = single bucket. |
| `qb_pnl_report` | Profit & Loss report (`GeneralSummaryReportType=ProfitAndLossStandard`). Walks Invoice / SalesReceipt / CreditMemo (income) and Bill / Check / CreditCardCharge plus JournalEntry (expense) lines filtered by TxnDate ∈ [fromDate, toDate]; aggregates by GL account → AccountType. Returns sections in canonical order (Income → Other Income → Cost of Goods Sold → Expenses → Other Expenses) plus `totalIncome` / `totalCOGS` / `totalExpenses` / `grossProfit` / `netIncome`. Optional `fromDate` / `toDate` (YYYY-MM-DD; omit either for unbounded). Optional `basis` (`Accrual` \| `Cash`, defaults `Accrual` — Cash basis is currently the same as Accrual in simulation; lands with Phase 7 live mode). Lines whose account can't be resolved (e.g. invoice line whose item carries no IncomeAccountRef) land in `Uncategorized Income` / `Uncategorized Expense` so totals reconcile. |
| `qb_balance_sheet_report` | Balance Sheet report (`GeneralSummaryReportType=BalanceSheetStandard`). Returns Assets / Liabilities / Equity sections from `Account.Balance` (snapshot — `asOfDate` is advisory for those sections in simulation; live mode will compute from txn history) plus `totalAssets` / `totalLiabilities` / `totalEquity` / `netIncome`. Lifetime NetIncome up to `asOfDate` (walked from transactions, reconciles with `qb_pnl_report` over the same range) closes into Equity. The accounting identity Assets = Liabilities + Equity is reconciled by closing the simulation seed gap into a 'Balancing Adjustment' row when present. Optional `asOfDate` (YYYY-MM-DD, defaults to today). Optional `basis` (`Accrual` \| `Cash`). |
| `qb_statement_of_cash_flows` | Statement of Cash Flows (`GeneralSummaryReportType=StatementOfCashFlows`, indirect method). Returns `Operating Activities` / `Investing Activities` / `Financing Activities` sections plus `netCashIncrease` / `cashAtBeginningOfPeriod` / `cashAtEndOfPeriod` totals. **Simulation mode uses a narrower model than real QB.** Operating section walks `NetIncome` + ΔAR + ΔAP only (no inventory / prepaid / accrued / depreciation add-back). Investing walks period postings to `FixedAsset` + `OtherAsset` accounts; per-account row total = `(credit − debit)` on the account (asset increase = USE of cash → negative CF). Financing walks period postings to `LongTermLiability` + `Equity` accounts on the same convention (liability/equity increase = SOURCE of cash → positive CF). `cashAtEndOfPeriod` = Σ(Bank.Balance) snapshot; `cashAtBeginningOfPeriod` is derived as `cashAtEnd − netCashIncrease` (sim has no historical `Account.Balance` series). For accurate cash-flow numbers run against live QuickBooks Desktop, which uses QB's own indirect-method engine. Optional `fromDate` / `toDate` (YYYY-MM-DD; omit either for unbounded) and `basis` (`Accrual` \| `Cash`). **Live-mode note:** the live adapter detects QB SCF section labels (`OPERATING/INVESTING/FINANCING Activities` and the `Cash from/provided by` variants) and closes sections on `Net cash provided by` / `Total <activity>` rows — verified-by-construction structurally but not yet live-validated against a real QB Desktop. |
| `qb_transaction_list_by_account` | Cross-type posting list (`TransactionQueryRq`) — every line that hit a specific GL account, optionally bounded by date. Returns rows sorted by `TxnDate` ascending with per-row `RunningBalance` computed in the tool layer (TransactionQueryRq does NOT compute running balance server-side). Algorithm: pulls `Account.Balance` via a separate AccountQueryRq, computes `openingBalance = currentBalance − Σ period postings`, then walks forward — exact when `toDate ≥ now`, approximate (overstated by post-period postings) for historical windows; omit `toDate` to skip the approximation. Sign convention: positive `Amount` = increases the target account's natural balance (e.g. a $500 bill posts +500 to Rent Expense; a customer refund posts -500 to Sales Revenue). Sim emits LINE-LEVEL postings only (Bill/Check expense+item lines, Invoice/SR/CreditMemo income lines via item resolution, JE debit+credit lines); implicit AR/AP/Bank counter-postings are NOT surfaced — live QB returns the full posting tree. Pass `accountName` (FullName) or `accountListId`; optional `fromDate` / `toDate` / `maxReturned` / `includeRunningBalance: false` to skip the AccountQueryRq round trip. |
| `qb_transaction_memo_search` | Search transactions by memo SUBSTRING (Phase 13 #63). QBXML exposes no server-side memo substring filter on any `*QueryRq` at any version — this tool pulls every matching txn in the bounded window (one round trip per included type) and filters by `Memo` content in-process. Each matched row carries a `matchedFields` array naming where the query hit (e.g. `['header.Memo', 'InvoiceLineRet[2].Desc']`) so the caller can see header vs line-level context. Pass `query` (required, substring) plus EITHER customer/vendor scope OR a date range — at least one bound is required (no-bound rejects 3120 to prevent scanning the entire books). Defaults: `caseSensitive: false`, `includeLineMemos: true`. Under a customer scope only customer-side types are searched; under a vendor scope only vendor-side; with no scope, the unscoped types `JournalEntry` / `Deposit` / `Transfer` / `InventoryAdjustment` / `SalesTaxPaymentCheck` are also included (these have no AR/AP entity binding). Narrow with `types` when you know which kind of transaction the memo lives on — saves N-1 round trips. Line-memo walk covers `Memo` and `Desc` on every `*LineRet` (Bill/Check/CreditCardCharge/CreditCardCredit carry both `ExpenseLineRet` + `ItemLineRet`); set `includeLineMemos: false` to skip the `IncludeLineItems` threading entirely (faster, header-only). `maxPerType` default 500; hitting the cap surfaces a warning. Returns `scannedCounts` (rows scanned per type) alongside `typeCounts` (rows matched per type) so the caller can tell whether they're seeing all the matches or were capped. |
| `qb_transaction_list` | Cross-type UNIFIED transaction list (Phase 16 #72). Single call returns invoices + sales receipts + payments + credit memos + statement charges (under a customer scope), OR bills + bill payments + checks + credit-card charges (under a vendor scope), sorted chronologically with a `TxnType` tag on every row. Composite over typed `*QueryRq` calls (one round trip per requested type — same architectural pattern as `qb_customer_balance_detail` / `qb_vendor_balance_detail`; `TransactionQueryRq` requires `AccountFilter` on the wire and returns line-level postings rather than transaction headers, so the single-wire path was rejected). Replaces the 5–6 separate per-type list calls for "show me everything for Customer X in March". Scope direction: pass exactly one of `{customerName, customerListId}` OR `{vendorName, vendorListId}` — both rejects 3120; one of {scope, fromDate, toDate} is required to bound the fanout. Customer-side types: `Invoice` / `SalesReceipt` / `ReceivePayment` / `CreditMemo` / `StatementCharge` / `Estimate` / `SalesOrder`. Vendor-side: `Bill` / `BillPaymentCheck` / `BillPaymentCreditCard` / `Check` / `CreditCardCharge` / `CreditCardCredit` / `PurchaseOrder`. Defaults to AR-affecting (Invoice/SR/RP/CM/StatementCharge) under customer or no scope, AP-affecting (Bill/BillPaymentCheck/BillPaymentCreditCard/Check/CreditCardCharge) under vendor scope. Pass `types` to narrow the fanout — under a customer scope only customer-side types are accepted, under a vendor scope only vendor-side. `JournalEntry` is intentionally NOT exposed — JE entity refs are per-line and not modeled in sim's EntityFilter chain; use `qb_transaction_list_by_account` on the AR/AP account or `qb_journal_entry_list` separately. Each row carries the full `*Ret` shape plus an injected `TxnType` tag; `maxPerType` (default 500) caps per-type fanout — hitting the cap on any type surfaces a warning. `includeLineItems: true` threads through to every underlying query for full line detail. Distinct from `qb_transaction_list_by_account`: that returns line-level postings; this returns transaction headers. |
| `qb_general_ledger` | Multi-account version of `qb_transaction_list_by_account`. For every GL-affecting account (or the subset selected by `accountName` / `accountListId` / `accountType`), returns one section per account with every line-level posting in the window sorted by `TxnDate` ascending, per-row `RunningBalance`, plus `openingBalance` / `closingBalance` / `periodChange`. Composite of `TransactionQueryRq` + `AccountQueryRq` — N round trips for N matching accounts in live mode, so scope via `accountType` (`'Expense'`, `'Income'`, `'Bank'`, etc.) or `accountName` for large charts. `NonPosting` accounts are always excluded from chart-wide fanout (they don't post to GL) — a warning surfaces in the response when any are dropped. Empty sections (zero postings in window) are pruned by default; pass `includeEmpty: true` to keep them. Pass `maxRowsPerAccount` to cap per-section rows (default 500 — section flags `truncated: true` when hit); `maxAccounts` caps the fanout (default 200). Same RunningBalance math + sign convention + LINE-LEVEL sim limitation as `qb_transaction_list_by_account`. Optional `basis` (`Accrual` \| `Cash`, advisory in simulation today). |
| `qb_sales_by_customer_summary` | Sales by Customer Summary (`GeneralSummaryReportType=SalesByCustomerSummary`). Per-customer revenue rollup over a date window — walks Invoice + SalesReceipt lines (positive) and CreditMemo lines (negative), groups by `CustomerRef.FullName` on the parent txn, returns customers sorted by total descending plus a grand `totalSales`. Scope to a single customer via `customerName` (FullName) or `customerListId` (server-side `ReportEntityFilter`). Sums are `line.Amount` sums — sales-tax lines and zero-amount lines drop naturally without inflating the customer's total (matches QB's actual `SalesByCustomerSummary`). A negative customer total means the customer has more credits than billing in the window. Optional `fromDate` / `toDate` (YYYY-MM-DD; omit either for unbounded) and `basis` (`Accrual` \| `Cash`, defaults `Accrual`). |
| `qb_sales_by_customer_detail` | Sales by Customer Detail (`GeneralDetailReportType=SalesByCustomerDetail`). Per-line transaction detail — one row per Invoice / SalesReceipt / CreditMemo line that touches a customer, sorted by Customer (alpha) → TxnDate (asc) → TxnID (stable). Columns: `TxnType` / `Date` / `Num` (refNumber) / `Name` (customer) / `Memo` / `Item` / `Quantity` / `Rate` / `Account` (income account from line resolution) / `Amount` / `TxnID`. CreditMemo rows emit with `Amount` sign-flipped (negative) so the running sum matches QB's actual `SalesByCustomerDetail`. Scope by customer (`customerName` \| `customerListId`) for single-customer drilldown — without scope every customer-bearing sale line in the window is emitted. Aggregate `totalAmount` is computed client-side from the rows. **Live-mode note:** the live adapter for this report uses the same row-tree translator as `CustomDetailReportQueryRq` — verified-by-construction structurally but live-validation against a real QB Desktop hasn't run yet; if QBXMLRP2 surfaces `statusCode -1` the fix is a child-order tweak in `buildGeneralDetailReportRequest`. |
| `qb_sales_by_item_summary` | Sales by Item Summary (`GeneralSummaryReportType=SalesByItemSummary`). Per-item revenue rollup over a date window — same income-side line walk as `qb_sales_by_customer_summary` but groups by `line.ItemRef.FullName` rather than `CustomerRef.FullName`. Returns `items` sorted by total descending plus a grand `totalSales`. Lines without an `ItemRef` (sales-tax, header-only discount lines) drop — there's no item to key under (matches QB's `SalesByItemSummary`). Scope to a single item via `itemName` (FullName) or `itemListId` (resolved across all five Item subtype stores; server-side `ReportItemFilter`). CreditMemo lines reduce sales — a negative item total means more credits than billing in the window. Optional `fromDate` / `toDate` (YYYY-MM-DD; omit either for unbounded) and `basis` (`Accrual` \| `Cash`, defaults `Accrual`). |
| `qb_sales_by_item_detail` | Sales by Item Detail (`GeneralDetailReportType=SalesByItemDetail`). Per-line transaction detail mirroring `qb_sales_by_customer_detail` but sorted by Item (alpha) → TxnDate (asc) → TxnID. Same column shape (`TxnType` / `Date` / `Num` / `Name` (customer) / `Memo` / `Item` / `Quantity` / `Rate` / `Account` / `Amount` / `TxnID`); lines without an ItemRef drop. CreditMemo rows emit with negative `Amount`. Scope by `itemName` \| `itemListId`. **Live-mode note:** same row-tree translator as `qb_sales_by_customer_detail`; verified-by-construction structurally but not yet live-validated against a real QB Desktop. |
| `qb_expense_by_vendor_summary` | Expenses by Vendor Summary (`GeneralSummaryReportType=ExpensesByVendorSummary`). Per-vendor expense rollup over a date window — walks `Bill` (VendorRef) + `Check` (PayeeEntityRef) + `CreditCardCharge` (PayeeEntityRef) `ExpenseLineRet` + `ItemLineRet`, sums `line.Amount` by vendor name. Returns `vendors` sorted by total descending plus a grand `totalExpenses`. Scope to a single vendor via `vendorName` (FullName) or `vendorListId` (server-side `ReportEntityFilter` — vendors are entities). **Caveat:** the simpler walk does NOT filter by underlying account's `AccountType` (matches the `qb_sales_by_customer_summary` simplification — a Check posting to a Fixed Asset account still counts as "expense to vendor X"). Real QB's `ExpensesByVendor` scopes to `Expense` / `COGS` / `OtherExpense` postings; in live mode that filter is applied by QB itself. Optional `fromDate` / `toDate` (YYYY-MM-DD; omit either for unbounded) and `basis` (`Accrual` \| `Cash`). |
| `qb_expense_by_vendor_detail` | Expenses by Vendor Detail (`GeneralDetailReportType=ExpensesByVendorDetail`). Per-line transaction detail — one row per `Bill` / `Check` / `CreditCardCharge` `ExpenseLineRet` or `ItemLineRet`, sorted by Vendor (alpha) → TxnDate (asc) → TxnID. Columns: `TxnType` / `Date` / `Num` / `Name` (vendor) / `Memo` / `Item` (item line only) / `Quantity` / `Rate` (or `Cost` for item lines) / `Account` (expense account from line resolution; `'Uncategorized Expense'` fallback when an item carries no `ExpenseAccountRef`) / `Amount` / `TxnID`. Scope by `vendorName` \| `vendorListId`. Same caveat as the summary: sim doesn't filter by underlying `AccountType`. **Live-mode note:** same row-tree translator as the other detail reports; verified-by-construction structurally but not yet live-validated against a real QB Desktop. |
| `qb_customer_balance_detail` | Customer Balance Detail — AR analog of `qb_general_ledger`. For every customer with AR activity in the date window (or the single customer selected by `customerName` / `customerListId`), lists every `Invoice` / `ReceivePayment` / `CreditMemo` that hit their AR balance, sorted by `TxnDate` ascending, with per-row `RunningBalance` plus per-customer `openingBalance` / `closingBalance` / `periodChange`. Composite of `InvoiceQueryRq` + `ReceivePaymentQueryRq` + `CreditMemoQueryRq` — three round trips regardless of customer count (not a per-customer fanout). Sign convention: positive `Amount` = increases AR (Invoice posts full `Subtotal + SalesTaxTotal`); negative = decreases AR (`ReceivePayment.TotalAmount`, `CreditMemo.TotalAmount`). Running balance: `openingBalance = Customer.Balance − periodSum`, walks forward — exact when `toDate ≥ now`. JournalEntry postings to the AR account are NOT walked (JE lines don't carry customer ref reliably in sim — query the AR account directly via `qb_transaction_list_by_account`). Empty sections (no activity AND zero closing balance) are pruned by default — set `includeZeroBalance: true` to keep them. Optional `maxCustomers` (default 200) and `maxRowsPerCustomer` (default 500; section flags `truncated: true` when hit). |
| `qb_vendor_balance_detail` | Vendor Balance Detail — AP mirror of `qb_customer_balance_detail`. Walks `Bill` + `BillPaymentCheck` + `BillPaymentCreditCard` per vendor with the same running-balance math. **Bill is the outlier on amount extraction:** `Bill.AmountDue` is decremented on every bill payment, so a fully-paid bill reports `AmountDue=0`; this tool walks the line set (`ExpenseLineRet` + `ItemLineRet` sums) for the original face value. `BillPayment*` posts `TotalAmount` (fallback `Amount`). Scope to a single vendor via `vendorName` / `vendorListId`. `VendorCredit` is NOT walked (no `VendorCredit` tool exists in this server's first cut — credits applied through bill payments still surface via `BillPaymentCheck.DiscountAmount` on the underlying bill). Same empty-section pruning, `includeZeroBalance` toggle, `maxVendors` / `maxRowsPerVendor` caps as the customer variant. |
| `qb_1099_summary` | Aggregate Bill + Check payments to 1099-eligible vendors (`IsVendorEligibleFor1099 === true`) for a tax-year window. Defaults to **last completed tax year** (current year − 1) — `qb_1099_summary({})` in January 2026 returns TY2025 totals; pass `taxYear` to override, or explicit `fromDate` / `toDate` (which override taxYear). Classifies each vendor as 1099-NEC (default — nonemployee compensation) or 1099-MISC (vendor record's `Vendor1099Type === 'MISC'` — typically rents/royalties). Compares per-vendor totals against `threshold` (default 600, the IRS general 1099-NEC + 1099-MISC threshold for TY2024+). Returns `{ totalEligibleVendors, vendorsAboveThreshold, vendorsBelowThreshold, totalsByForm: {NEC, MISC}, vendors: [...] }` sorted by `totalPaid` descending. Each vendor row carries `taxId` + `address` + `formType` + `totalPaid` + `transactionCount` + `billCount`/`billTotal`/`checkCount`/`checkTotal` + `meetsThreshold`. Optional `formType: 'NEC' \| 'MISC' \| 'all'` filter. Optional `includeBelowThreshold: true` surfaces sub-threshold vendors (with `meetsThreshold: false`) — useful for review. **Card payments excluded** per IRS rule (the card processor reports those on 1099-K). **Limitation:** does NOT honor QB Preferences' per-account 1099 box mapping — every payment to an eligible vendor counts toward the threshold. Strict box-by-box reporting requires real QB's Form1099 wizard. |
| `qb_1099_detail` | Per-transaction breakdown for 1099 prep — same Bill + Check walk as `qb_1099_summary` but returns each transaction with `txnId` / `txnDate` / `refNumber` / `total` / `memo` / `lines` (per-line `accountName` + `amount` + `memo`). Use to verify the summary, drill into a specific vendor (`vendorListId` or `vendorFullName`), or export to a 1099 prep spreadsheet. No threshold filter (every transaction is surfaced regardless of vendor total). Empty result when the scope filter matches nothing is a structured success (not an error). Defaults to last completed tax year. Card payments excluded per IRS rule. |
| `qb_audit_log` | Read QB Desktop's audit trail — per-field modification events (who changed what, when, from what value to what). Wraps `CustomDetailReportQueryRq` with `CustomDetailReportType=AuditTrail`. **ENTERPRISE-ONLY** — Pro / Premier / Accountant editions reject with **statusCode 9003** (audit trail is gated by QB edition; no SDK workaround). Pass exactly one of `txnId` OR `dateRange` (both → 3120, neither → 3120). `txnId` scope defaults the wire-side period to a 2-year lookback and filters by `TxnID` post-fetch (QB's AuditTrail report has no `TxnIDFilter` at the wire level — server-side scoping is date-only). `dateRange.{fromDate, toDate}` passes through to the wire `ReportPeriod` as-is. Returns `{ count, entries: [{user, timeModified, modifyType, changedField?, oldValue?, newValue?, txnId, txnType}] }` sorted desc by `timeModified` (most-recent-first). `Added` / `Deleted` events omit `changedField` / `oldValue` / `newValue` (whole-entity events have no per-field diff). Use for compliance review, forensic accounting ("when did this invoice's amount change?"), and the standard "show me what changed last week" question. **Live verification deferred** — sim emits canonical column names (`User` / `TimeModified` / `ModifyType` / `ChangedField` / `OldValue` / `NewValue` / `TxnID` / `TxnType`); live QB's exact column titles may differ. If live returns missing data, fix `runAuditTrailReport`'s `IncludeColumn` list (tool layer reads columns by title with `""` defaults). |
| `qb_w2_summary` | Per-employee W-2 summary via `PayrollSummaryReportQueryRq` (`ReportType=EmployeeWagesTaxesAdjustments`). Maps YTD totals onto W-2 box numbers: `box1_wagesTipsOtherComp` / `box2_federalIncomeTaxWithheld` / `box3_socialSecurityWages` / `box4_socialSecurityTaxWithheld` / `box5_medicareWages` / `box6_medicareTaxWithheld` / `box16_stateWages` / `box17_stateIncomeTax` (state boxes optional — surface only when state data is present). Defaults `taxYear` to last completed year (current year − 1). Pre-flight edition probe rejects Pro builds (without Plus) with **statusCode 9003**; empty-result rejects with **9004** (payroll subscription required or not active — distinguishes "subscription off" from "no matching employees"). SSNs masked to last 4 ("XXX-XX-1234") matching real QB's printed payroll-summary behavior. Scope to a single employee via `employeeFullName` / `employeeListId`. Wire-side period is always Jan 1 → Dec 31 of the resolved year — the W-2 box model is inherently annual. **Boxes 7-15 / 18-20 (SS tips, allocated tips, dep care, codes A-W, box 14 other, local taxes) are NOT surfaced** in this first cut — those require per-payroll-item box mapping that the SDK doesn't expose. For strict box-by-box reporting use QB Desktop's W-2 wizard. **Live-mode note:** PayrollSummaryReport's row-tree adapter has not been pinned against a real QB Desktop yet — verified-by-construction structurally; if QBXMLRP2 surfaces `statusCode -1` the fix is a child-order tweak in `buildPayrollSummaryReportRequest` (same class as the 2026-05-09 #37 P&L bug). |
| `qb_raw_query` | Execute raw QBXML queries |

### Workpaper Composites

High-level composites that bundle multiple report + entity primitives into a single tool call — the workflows a CPA fires at the start of a tax return or a monthly job-cost review. Pure composites over existing session primitives (`queryEntity` / `queryTransactions` / `runReport` / `runCustomDetailReport` / `runPayrollSummaryReport` / `getHostInfo`); no new wire types, no parser changes.

All composites use the same **fail-soft section contract**: each section is either `sectionStatus.<name>: 'ok'` (with its payload under `sections.<name>`) or `'error'` (with `sections.<name>.error: {...}`) or `'skipped'` (when a section toggle is off, or — for `qb_client_packet` payroll — when the QB edition / subscription can't surface the data). A single section's failure does NOT poison the rest of the response. The only non-fail-soft path per tool is the lookup that the whole composite depends on (`AccountQueryRq` for `qb_client_packet`; `CustomerQueryRq` for `qb_engagement_profitability`).

Synthetic statusCodes surfaced by the payroll section: `9003` (edition lacks payroll surface — Pro), `9004` (subscription inactive or no employees with YTD activity).

| Tool | Description |
|------|-------------|
| `qb_client_packet` | Tax-prep workpaper bundle for one `.qbw` file over `taxYear` (Jan 1 → Dec 31). Sections: Trial Balance (via `buildTrialBalance` + 5 supporting queries; cross-checks reconcile BS = Liab+Eq, P&L NetIncome ≡ BS NetIncome, AR / AP ≡ aging totals), General Ledger (per-account postings + RunningBalance via `buildGeneralLedgerSection`; defaults to `glScope: 'PnLOnly'` — ~5–15 accounts — pass `'AllAccounts'` for the full chart), Bank Reconciliation Discrepancy (fans out across every Bank + CreditCard account; per-account errors land in that account's entry), Payroll Summary (W-2 box mapping per employee; edition-gated via `9003` / subscription-gated via `9004`), Fixed Asset Detail (per-FixedAsset-account postings + running balance — Form 4562 input; empty `accounts` array against a service-business chart is NOT an error). Optional `customerListId` / `customerName` surfaces a label at the top of the packet but does NOT filter the underlying reports (the `.qbw` file IS the client). Five section toggles all default true; `bankReconDiscrepancySinceDate` defaults to start of `taxYear`. Read-side. |
| `qb_engagement_profitability` | Per-engagement (customer/job) profitability rollup over a date window. Sections: Revenue (Invoice + SalesReceipt − CreditMemo header totals, scoped server-side via `EntityFilter`), Time (TimeTracking entries POST-FILTERED by `CustomerRef`; rolled up `byWorker` + `byServiceItem`, billable vs non-billable split, hours derived from `Duration` via `parseDurationToHours`), Reimbursable Expenses (Bill / Check / CreditCardCharge `ExpenseLineRet` + `ItemLineRet` filtered by LINE-LEVEL `CustomerRef` — headers don't carry job-costing scope; bills can split across multiple jobs and only the matched lines count). Plus a derived `summary` block (`revenue` / `reimbursableExpenseCost` / `grossProfit` / `marginPct` / `billableHours` / `totalHours` / `revenuePerHour` / `billableRate`) emitted ONLY when every queried section is `'ok'` — partial summary would silently misrepresent profitability. `customerListId` or `customerName` REQUIRED (the engagement IS the customer); `fromDate` + `toDate` REQUIRED (engagements have explicit windows; no defaults; date inversion rejects with `3120`). Three section toggles all default true. Read-side. |

### Attachments

QuickBooks Desktop's "Attached Documents" feature lets you attach files (vendor receipts, deposit slips, signed invoices, customer W-9s) to transactions or list entities for audit-trail use. The QBXML SDK surface is three primitives: `AttachableAddRq` / `AttachableQueryRq` / `ListDelRq` (with `ListDelType="Attachable"`).

**File copy semantics (live mode):** QBXMLRP2 doesn't transfer file BYTES — `AttachableAdd` passes a path string and QB Desktop reads the file from disk during `ProcessRequest`. The file must be readable by the QB Desktop process (same machine, appropriate permissions). For the typical localQBD deployment this is a non-issue. QB stores attachments in its "Attached Documents" folder (typically a sibling of the `.qbw`). Attached Documents support is **edition-dependent**: if the operator's edition doesn't support it, `AttachableAdd` fails at the wire with a QB-side error.

**Sim mode** validates the file path exists via `fs.statSync`, derives `FileName` / `FileSize` / `FileExtension` from disk, verifies the `ObjectRef` target exists across stores — but does NOT copy any bytes. Sim is for testing tool wiring, not for testing QB's file storage.

| Tool | Description |
|------|-------------|
| `qb_attachment_add` | Attach a local file to an existing transaction or list entity. Pass exactly one of `txnId` (for transactions) or `listId` (for list entities — Customer / Vendor / Item / Employee / etc.) plus an absolute `filePath`. Relative paths reject with statusCode 3120 (a relative path resolved against the QB process's CWD is rarely what's intended). The file must exist on disk and be readable by the QB Desktop process. Optional `note` (description shown in QB's attachment UI) and `showAsImage: true` (inline preview vs default icon — appropriate for images / PDFs). Optional `attachmentType` (defaults to "Normal"). Returns the new Attachable's `ListID` + the derived metadata. Read-only sessions reject with 9001. Optional `idempotencyKey` — replay with same key + same payload returns the original Attachable; same key + different payload returns 9002. |
| `qb_attachment_list` | List attachments stored in QuickBooks. Three mutually-exclusive filter modes: `txnId` (every attachment whose ObjectRef points at the named transaction), `targetListId` (every attachment whose ObjectRef points at the named list entity), or `attachableListId` (single attachment by its OWN ListID, the ID returned from `qb_attachment_add`). Pass at most one — multiple filters reject with 3120. Optional `maxReturned` caps the result. Returns `{ count, attachments: [...AttachableRet] }`. Each row carries `FileName` / `FileSize` / `FileExtension` / `Note` / `ShowAsImage` / `ObjectRef` / `TimeCreated` / `TimeModified`. **Note:** this lists attachment METADATA only — actual file bytes live in QB's Attached Documents folder and are not surfaced through the SDK. Read-side. |
| `qb_attachment_delete` | Delete an attachment by its own ListID. Wraps `ListDelRq` with `ListDelType='Attachable'`. The file in QB's Attached Documents folder is also removed by real QB (sim just removes the metadata record). Use `qb_attachment_list` to find the `attachableListId` before deleting. Read-only sessions reject with 9001. Unknown `attachableListId` returns statusCode 500. |

### Closing Date / Year-End Lock

The qbXML SDK exposes company preferences as a **read-only** surface — `PreferencesQueryRq` reads the closing date, but no `PreferencesModRq` / `AccountingPreferencesModRq` / `CompanyActivityModRq` exists at any qbXML version through 16.0 (verified against the qbwc/qbxml master schema mirrors — see [DECISIONS.md](DECISIONS.md) `2026-05-12 — Closing date is read-only via QBXML SDK`). The closing date itself must be set in QuickBooks Desktop's UI (Edit → Preferences → Accounting → Company Preferences → Set Date/Password). `ClosingDatePasswordIsSet` is **not exposed** by qbXML at any version — this server can only tell you whether a closing date exists, not whether it's password-protected.

| Tool | Description |
|------|-------------|
| `qb_closing_date_get` | Read the company file's closing date and adjacent accounting-preferences flags via `PreferencesQueryRq`. Returns `closingDate: string \| null` (ISO YYYY-MM-DD, or `null` if no closing date is set) plus `isUsingAuditTrail` / `isUsingClassTracking` / `isUsingAccountNumbers` / `isRequiringAccounts` (from `AccountingPreferences`) and a human-readable `note` summarizing protection state. Cannot surface password-set status — qbXML doesn't expose it. Read-only safe; no read-only-session gate. |
| `qb_closing_date_set` | **Informational stub** — the qbXML SDK has NO write path for company preferences. Always fails with **statusCode 9005** and returns explicit QB Desktop UI navigation steps (Edit → Preferences → Accounting → Company Preferences → Set Date/Password), quoting the operator-supplied `closingDate` and (if provided) `password` in the instructions. Performs no wire I/O — the failure is synchronous. Surfaced as a tool (rather than omitted) so an agent thinking "I should set the closing date" routes the user correctly instead of hallucinating a non-existent mutation. The only programmatic workaround is UI Automation against the running QB Desktop instance — outside the scope of this MCP. |

### Banking (Deposit / Check / Transfer)

The direct-banking transactions QB Desktop tracks on its own — distinct from the AR/AP workflow (`qb_payment_receive` / `qb_bill_pay`) and from the reconciliation primitives below. **`Deposit`** records funds arriving in a bank account; **`Check`** records funds leaving via a written check or direct disbursement; **`Transfer`** moves funds between two balance-sheet accounts. All three are bank-affecting transactions — `ClearedStatus` defaults to `NotCleared` on creation and flips via `qb_cleared_status_update` during reconciliation.

These tools pair with `qb_uncleared_transactions` / `qb_reconciliation_discrepancy` / `qb_cleared_status_update` (Bank Reconciliation section below) for the full month-end-close workflow — the read-side surfaces what needs clearing; the write side here lets the operator post the missing entries (deposit the daily cash drawer, write the rent check, move funds to savings) without leaving the agent.

| Tool | Description |
|------|-------------|
| `qb_deposit_list` | List or search Deposits. Each Deposit names a `DepositToAccountRef` (the bank account where funds land) and N split lines (`DepositLineRet`). Filter by `txnId` / date range; `paginate: true` for iterator-based pagination (auto-defaults `maxReturned` to 500). Lines stripped by default — pass `includeLineItems: true` to surface them. |
| `qb_deposit_create` | Create a new Deposit. Requires `depositToAccountName` (or `depositToAccountListId`) — a Bank account — plus at least one `lines[]` entry. Each line names an income / equity / refund-liability account + amount + optional entity / payment-method / cheque-number. The simulation derives `DepositTotal` from the line sum. Use for batch cash arrivals (recording a day's customer payments after they've been received via `qb_payment_receive` into Undeposited Funds, ad-hoc cash like a tax refund, owner contributions). Accepts `idempotencyKey` for retry safety. |
| `qb_deposit_update` | Modify an existing Deposit by `txnId` + `editSequence`. Passing `lines` REPLACES the line set wholesale (lines with matching `txnLineID` are merged; lines you don't list are dropped). `DepositTotal` recomputes from the post-mod line sum. Stale `editSequence` rejects with 3170. |
| `qb_deposit_delete` | Delete a Deposit. Irreversible. |
| `qb_check_list` | List or search Checks (direct bank disbursements, distinct from `BillPaymentCheck` which pays existing bills). Filter by `txnId` / date range / `refNumber` / `payeeName` (matches `PayeeEntityRef`). `paginate: true` for iterator pagination. Lines stripped by default — pass `includeLineItems: true` to surface `ExpenseLineRet` + `ItemLineRet`. |
| `qb_check_create` | Create a new Check drawn against `accountName` (a Bank account). Optional `payeeName` (Vendor / Customer / Employee / OtherName). Requires at least one expense or item line — a check must post somewhere on the GL side. **Use `qb_bill_pay` instead** for paying an existing bill (`BillPaymentCheckRq` is a different transaction type that closes AP and moves vendor balance). The simulation derives `Check.Amount` from the line sum on create. Accepts `idempotencyKey`. |
| `qb_check_update` | Modify an existing Check by `txnId` + `editSequence`. Line arrays REPLACE wholesale (same merge-by-`txnLineID` semantics as `qb_bill_update`). `Check.Amount` recomputes from the post-mod line sum. Stale `editSequence` rejects with 3170. |
| `qb_check_delete` | Delete a Check. Irreversible. To void instead (preserves the check number in the register), use `qb_check_update` with amount 0 and a "VOID" memo. |
| `qb_transfer_list` | List or search Transfers. Each Transfer moves funds from `TransferFromAccountRef` to `TransferToAccountRef` — no line set, just `Amount`. Filter by `txnId` / date range; `paginate: true` for iterator pagination. |
| `qb_transfer_create` | Create a new Transfer. Requires both `fromAccountName` (or `fromAccountListId`) and `toAccountName` (or `toAccountListId`) — both balance-sheet accounts, must be different (self-transfer rejects with `statusCode 3120`). `amount` must be positive (direction is encoded by the From/To refs, not by amount sign). Use for Bank-to-Bank, Bank-to-CreditCard (paying down a card directly without the bill-payment flow), Equity-to-Bank owner-draw / contribution, etc. Inventory site transfers (Enterprise-only `TransferInventoryAddRq`) are intentionally NOT exposed — they belong under Phase 17 #80 inventory adjustments. Accepts `idempotencyKey`. |
| `qb_transfer_update` | Modify an existing Transfer by `txnId` + `editSequence`. Header-only (no line set). Stale `editSequence` rejects with 3170. |
| `qb_transfer_delete` | Delete a Transfer. Irreversible — both sides of the posting reverse atomically. |

### Bank Reconciliation

The QBXML SDK's actual reconciliation surface is much narrower than the QB Desktop UI suggests: there is **no `ReconcileQueryRq`**, **no `ReconcileDetail` GeneralDetailReportType**, and **no `LastReconciledDate` field on AccountRet** (verified against qbxmlops130/140 schemas — see [DECISIONS.md](DECISIONS.md) `2026-05-10 — bank reconciliation SDK surface`). What IS exposed:

- **Write side**: `ClearedStatusModRq` — flips one transaction (or one split line) between `Cleared` / `NotCleared` / `Pending`. Wrapped by `qb_cleared_status_update`.
- **Read side**: `CustomDetailReportQueryRq` with `IncludeColumn=ClearedStatus` — the **only** QBXML path that returns cleared-status per transaction (it's not a field on any `*Ret` element nor a filter on any `*QueryRq`). Wrapped by `qb_uncleared_transactions` and `qb_reconciliation_discrepancy`.

End-to-end month-end-close workflow through the MCP:

1. `qb_uncleared_transactions({ accountName: "Checking" })` to discover what needs clearing.
2. `qb_cleared_status_update({ txnId, clearedStatus: "Cleared" })` once per row that matches a bank statement line.
3. `qb_reconciliation_discrepancy({ accountName: "Checking", sinceDate: "<last reconciliation date>" })` to verify nothing previously-reconciled has been silently modified.

| Tool | Description |
|------|-------------|
| `qb_cleared_status_update` | Mark a bank/CC transaction `Cleared` / `NotCleared` / `Pending`. Wraps `ClearedStatusModRq`. Targets the seven bank-affecting transaction types only (`Check`, `BillPaymentCheck`, `BillPaymentCreditCard`, `Deposit`, `Transfer`, `CreditCardCharge`, `CreditCardCredit`); calls against `Invoice` / `Bill` / `JournalEntry` / etc. return statusCode 3120 ("transaction type does not support cleared status") because those headers don't carry the field. Pass `txnId` for whole-transaction update (typical for a Check or Deposit); add `txnLineId` to flip a single split line within a multi-line transaction (e.g. one line of a multi-account Deposit). Naturally idempotent — flipping `Cleared` on an already-Cleared txn is a server-side no-op, so this tool does NOT accept an `idempotencyKey` arg (the cache would add no value). Read-only sessions reject with statusCode 9001 before any envelope is built. |
| `qb_uncleared_transactions` | List bank/CC transactions that have NOT been marked `Cleared`, scoped to a single bank or credit-card account. Wraps `CustomDetailReportQueryRq` (`CustomTxnDetail`) with `ReportClearedStatusFilter` set server-side, formats the rows as an operator-friendly transaction list. Pass `accountName` (FullName) OR `accountListId`; one is required. Optional `asOfDate` (YYYY-MM-DD, defaults today) caps the date window. Optional `clearedStatusFilter`: `UnclearedOnly` (default — NotCleared + Pending), `ClearedOnly`, or `All`. Sign convention on the returned `amount`: positive = increases the account's natural balance (Deposit, CreditCardCharge), negative = decreases it (Check, BillPaymentCheck, CreditCardCredit). Returns `{ account, asOfDate, clearedStatusFilter, count, totalAmount, transactions: [{ txnType, txnDate, refNumber, name, memo, amount, clearedStatus, txnId?, timeModified? }] }`. Read-side; does NOT require a writable session. |
| `qb_reconciliation_discrepancy` | Surface bank/CC transactions that were previously marked `Cleared` but have since been MODIFIED — the signal that a prior reconciliation may have been silently broken. Same `CustomDetailReportQueryRq` infrastructure as `qb_uncleared_transactions` but with `ReportClearedStatusFilter='ClearedOnly'` + `ReportModifiedDateRangeFilter` set server-side. Pass `accountName` OR `accountListId`. Optional `sinceDate` (YYYY-MM-DD) is the lower bound on the modification window — defaults to 30 days back; set this to the date of the last completed reconciliation to scope the audit. Optional `asOfDate` caps the txn-date window same as above. Returns `{ account, sinceDate, asOfDate, count, note, candidates: [...] }` in the same row shape as `qb_uncleared_transactions`. SEPARATE SIGNAL not bundled here: postings to the QB-internal "Reconciliation Discrepancies" expense account (the dump-account QB writes off forced-reconcile deltas to) — query that via `qb_transaction_list_by_account({ accountName: "Reconciliation Discrepancies" })` directly. Read-side. |

### Session Management
| Tool | Description |
|------|-------------|
| `qb_session_connect` | Open a QuickBooks session. Optional `readOnly: true` gates every mutation (`*_add` / `*_update` / `*_delete` / `*_apply` / `*_pay` / `*_make_inactive` / `*_convert_to_invoice` / `batch_create`) — those tools fail-fast with `statusCode 9001` BEFORE any QBXML envelope is built. Reads (queries, reports, `qb_raw_query`) and `qb_company_open` / `qb_company_list` are unaffected. The flag toggles immediately on call (safe to flip mid-conversation without disconnecting); a fresh `qb_session_connect()` with no `readOnly` arg defaults to writable. `qb_company_info` surfaces the current `readOnly` state. |
| `qb_session_disconnect` | Close the session |
| `qb_session_status` | Diagnostic snapshot of the current session — `connected`, `mode` (`simulation` \| `live`), `companyFile`, `appName`, `appId`, `qbxmlVersion`, `readOnly`, `ticket`, `openedAt`, `serverVersion`, cached `hostInfo` (`null` when not yet fetched — peek-only, never triggers a fetch), and `retryStats` (`lastTransientRetryAt` / `transientRetryCountLastHour` / `totalTransientRetries` — the rolling-window observability for `#84`'s auto-reconnect on transient QBXMLRP2 failures). **Zero wire I/O by default.** Pass `probe: true` to actively verify the live wire is responsive via a fresh `HostQueryRq` round trip (the lightest available real-wire call); the probe lands under `probe: { ok: true }` on success or `probe: { ok: false, statusCode, statusMessage, humanReadable? }` on failure — **fail-soft** so the snapshot itself never returns `isError`. Pass `includeClosingDate: true` to fold `PreferencesQueryRq` into the response under `closingDate` (same shape as `qb_closing_date_get`, same fail-soft contract). The retry stats are pruned to the last hour on read so the array stays bounded; `switchCompanyFile` resets the observability window (a fresh book starts clean). Use this from orchestration callers retrying brittle workflows: a non-zero `transientRetryCountLastHour` means QB Desktop has been stalling recently and a longer backoff may be warranted. |
| `qb_company_open` | Switch the active QuickBooks Desktop company file mid-session. Closes the current session, swaps the configured `.qbw` path, opens a new session against the new file. Live mode requires QB Desktop to already have the target file open (QBXMLRP2 cannot open a file QB hasn't loaded). Simulation mode resets the in-memory store to fresh seed — real QB persists per-file, sim doesn't (deliberate sim-fidelity tradeoff per [DECISIONS.md](DECISIONS.md#2026-05-09--company-switching-reseeds-the-simulation-store)); the response carries `simulationStoreReset: true` in sim. |
| `qb_company_list` | Enumerate `.qbw` company files under a search root. Search root resolves in priority: `root` arg → `$QB_COMPANY_ROOT` → `dirname($QB_COMPANY_FILE)`. Returns `[{ companyFile, displayName, sizeBytes, modifiedAt }]` sorted by `modifiedAt` desc. Pure filesystem op — identical in live and simulation. Pair with `qb_company_open`: returned `companyFile` paths are valid input. |

### Cache Management
| Tool | Description |
|------|-------------|
| `qb_cache_invalidate` | Manually clear the MCP-side lookup cache (Phase 16 #74). Pass `entity: 'Account' \| 'Customer' \| 'Item' \| 'Terms' \| 'Class'` to clear one domain; omit `entity` to clear all. Use after editing a record in QB Desktop's UI when you want the next `qb_*_list` call to pull fresh from the wire instead of waiting for the 5-minute TTL to expire. `Item` invalidation clears all 5 subtype slots (Service / Inventory / NonInventory / OtherCharge / Group); `Terms` invalidation clears both StandardTerms + DateDrivenTerms. Returns `{ scope, cleared, count }` listing the entity-type slots that were actually cleared (slots that weren't cached are omitted; `cleared: []` is success, just nothing was cached). The cache only stores UNFILTERED list calls (no `nameFilter` / `listId` / `accountType` / `parentListID` / `jobOnly` / `includeCustomFields` / `paginate` / `iteratorID` args) — filtered calls always hit the wire. Per-tool `useCache: false` forces a fresh wire call on a single call without affecting the cache state. Cache is per company file and clears automatically on `qb_company_open`. |

## Workflow Prompts

Beyond tools, the server registers **MCP prompts** (workflow bundles) via the `prompts/list` + `prompts/get` API. MCP hosts (Claude Desktop and others) typically surface these as slash-commands in the chat input. Each prompt seeds the conversation with a structured workflow that references the right `qb_*` tools in order — the agent then drives the workflow to completion.

All prompt arguments are optional with sensible defaults (prior calendar month for month-end, last completed year for W-2 prep, today for trial balance / CC validator). The single user-role message body contains exact `qb_*` tool names so the agent's tool-use loop maps directly to calls.

| Prompt | Description |
|--------|-------------|
| `/month_end_close` | Full month-end-close checklist (bank rec → CC rec → P&L review → AR/AP aging → BS reconcile → SCF). Defaults to the prior calendar month when `fromDate` / `toDate` are unset. Optional `bankAccountName` scopes the bank-rec step. Composes 12+ tools (qb_company_info, qb_host_query, qb_closing_date_get, qb_uncleared_transactions, qb_reconciliation_discrepancy, qb_cleared_status_update, qb_pnl_report, qb_general_ledger, qb_ar_aging, qb_ap_aging, qb_balance_sheet_report, qb_statement_of_cash_flows). Explicitly warns not to call `qb_closing_date_set` (no SDK write path). |
| `/credit_card_qb_batch` | Bulk-categorize a credit-card statement into atomic `qb_journal_entry_batch_create`. Bridges the operator's `credit-card-qb-batch` skill from Excel-intermediate to direct MCP entry. Optional args: `creditCardAccountName` / `statementMonth` (YYYY-MM) / `source` (parsing-source description). Calls out `idempotencyKey` usage + 9002 conflict semantics + refund/credit reversal mechanics. |
| `/trial_balance_workup` | Pulls trial balance + cross-checks (BS Assets = Liab+Equity reconcile, AR/AP totals match aging reports, P&L netIncome plug). Bridges the `trial-balance-workup` skill from manual CSV export to direct MCP query. Optional args: `asOfDate` (default today) / `basis` (default Accrual). Specifies the workpaper output table shape. |
| `/cc_statement_validator` | Three-way reconciliation of a credit-card statement against QB's CC account state — balance match, line-by-line match, discrepancy scan, clear-on-match. Bridges the `cc-statement-validator` skill. Optional args: `creditCardAccountName` / `statementEndingBalance` / `statementEndingDate`. |
| `/w2_prep` | January W-2 prep via `qb_w2_summary` + `qb_employee_list` + reconciliation against P&L wage totals + balance-sheet withholding liability. Optional args: `taxYear` (default last completed year) / `employeeFullName` (single-employee scope). Surfaces a per-employee filing checklist; calls out 9003 / 9004 status codes for edition / subscription rejections. Subject to QB Payroll subscription availability. |

## Architecture

```
┌─────────────┐     MCP/stdio      ┌──────────────────────┐
│  AI Agent /  │◄──────────────────►│  QuickBooks Desktop  │
│  LLM Client  │                    │  MCP Server          │
└─────────────┘                    │                      │
                                    │  ┌────────────────┐  │
                                    │  │ Tool Registry   │  │     QBXML
                                    │  │ (150 tools)     │──│──────────────┐
                                    │  └────────────────┘  │              │
                                    │  ┌────────────────┐  │    ┌─────────▼─────────┐
                                    │  │ QBXML Builder   │  │    │ QuickBooks Desktop │
                                    │  │ & Parser        │  │    │ (via QBXMLRP2)    │
                                    │  └────────────────┘  │    │ — or —             │
                                    │  ┌────────────────┐  │    │ Simulation Store   │
                                    │  │ Session Manager │  │    └───────────────────┘
                                    │  └────────────────┘  │
                                    └──────────────────────┘
```

## Setup

### Install dependencies
```bash
cd quickbooks-mcp
npm install
```

### Build
```bash
npm run build
```

### Run (standalone)
```bash
npm start
```

### Test
```bash
npm test            # vitest run — 178 assertions across 5 files in tests/
node scripts/verify-item23-env-matrix.mjs   # standalone — env-var/platform matrix
```

The Vitest suite imports from `src/` (verifies the source). The five `scripts/verify-*.mjs` harnesses import from `dist/` (verify the built output). Both are kept and complementary — see [DECISIONS.md](DECISIONS.md) `2026-04-27 — Vitest`.

### Configure as MCP server (opencode.jsonc)
```jsonc
{
  "mcpServers": {
    "quickbooks-desktop": {
      "command": "node",
      "args": ["quickbooks-mcp/dist/index.js"],
      "env": {
        "QB_SIMULATION": "true",
        "QB_APP_NAME": "MCP QuickBooks Manager"
      }
    }
  }
}
```

### Configure for Claude Desktop (claude_desktop_config.json)
```json
{
  "mcpServers": {
    "quickbooks-desktop": {
      "command": "node",
      "args": ["/absolute/path/to/quickbooks-mcp/dist/index.js"],
      "env": {
        "QB_COMPANY_FILE": "C:\\Users\\Public\\Documents\\Intuit\\QuickBooks\\MyCompany.qbw",
        "QB_LIVE": "1"
      }
    }
  }
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `QB_COMPANY_FILE` | Path to .qbw company file | Sample file path |
| `QB_COMPANY_ROOT` | Search root for `qb_company_list` — directory to scan for `.qbw` files. Falls back to `dirname($QB_COMPANY_FILE)` if unset. | unset (falls back) |
| `QB_APP_NAME` | App name for QB registration | `MCP QuickBooks Manager` |
| `QB_APP_ID` | Application ID (optional) | — |
| `QB_QBXML_VERSION` | QBXML protocol version | `16.0` |
| `QB_CONNECTION_MODE` | `localOnly`, `remoteOnly`, or `optimistic` | `optimistic` |
| `QB_SIMULATION` | `"true"` forces simulation; `"false"` forces live (and errors if the platform can't do live); unset = default behavior (see matrix). | unset |
| `QB_LIVE` | Set to `"1"` to enable live mode on Windows when `QB_SIMULATION` is unset. | unset |
| `QB_DEBUG_QBXML` | Set to `"1"` to mirror every QBXML envelope + raw response to a rotating per-day file. Diagnoses schema-order parse errors (statusCode -1) and any future wire-level issue. Sensitive fields (`VendorTaxIdent`, `SSN`, `BankAccountNumber`, `CreditCardNumber`) are redacted before write. | unset |
| `QB_DEBUG_LOG_PATH` | Directory the debug log writes into; file name is always `qbxml-YYYYMMDD.log` (date stamp recomputed per write so a long-running process rolls over at midnight). | `./logs` |

### Mode resolution matrix

`QB_SIMULATION` is the explicit override. `QB_LIVE` only matters when `QB_SIMULATION` is unset.

| Platform | `QB_SIMULATION` | `QB_LIVE` | Mode |
|----------|-----------------|-----------|------|
| Windows  | `"true"`        | _any_     | Simulation (forced) |
| Windows  | `"false"`       | _any_     | Live (errors at `openSession` until Phase 7 lands) |
| Windows  | unset           | `"1"`     | Live (errors at `openSession` until Phase 7 lands) |
| Windows  | unset           | unset     | Simulation (default) |
| non-Windows | `"true"`     | _any_     | Simulation (forced) |
| non-Windows | `"false"`    | _any_     | Live → errors at `openSession` ("requires Windows") |
| non-Windows | unset        | _any_     | Simulation (default) |

Any `QB_SIMULATION` value other than `"true"` / `"false"` is treated as unset.

## How It Works

1. **QBXML Protocol**: The server constructs standard QBXML request messages (the XML protocol developed by Intuit for QuickBooks Desktop SDK communication) and parses QBXML response messages.

2. **Session Manager**: Manages the connection lifecycle with QuickBooks Desktop, opening sessions via the QBXMLRP2 request processor and handling the send/receive cycle for QBXML messages.

3. **Simulation Store**: In non-Windows/non-live environments, an in-memory store with realistic seed data (customers, vendors, accounts, items, invoices) processes QBXML requests locally, enabling full development and testing without QuickBooks Desktop installed.

4. **MCP Tools**: Each tool maps to one or more QBXML request types, providing validated input schemas, structured responses, and error handling.

## QBXML Reference

The server targets QBXML version 16.0 and supports the following request types:
- `CustomerQueryRq/AddRq/ModRq` — Customer management
- `VendorQueryRq/AddRq/ModRq` — Vendor management
- `AccountQueryRq/AddRq/ModRq` — Chart of Accounts
- `InvoiceQueryRq/AddRq/ModRq` — Invoices
- `BillQueryRq/AddRq` — Bills
- `ItemQueryRq/AddRq/ModRq` — Items
- `ReceivePaymentAddRq/QueryRq` — Payments
- `EstimateQueryRq/AddRq` — Estimates
- `JournalEntryQueryRq/AddRq/ModRq` — Journal entries (debit/credit balanced GL postings)
- `EmployeeQueryRq/AddRq/ModRq` — Employees
- `ListDelRq / TxnDelRq` — Deletions
