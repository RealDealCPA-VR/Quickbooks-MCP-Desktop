# QuickBooks Desktop MCP Server

A **Model Context Protocol (MCP)** server that provides comprehensive tools for managing client books in QuickBooks Desktop via the QBXML SDK.

## Overview

This MCP server acts as a bridge between AI agents/LLMs and QuickBooks Desktop, translating tool calls into QBXML messages — the standard XML-based protocol for QuickBooks Desktop SDK communication. It supports two operating modes:

- **Live mode** — Communicates with a real QuickBooks Desktop instance via the QBXMLRP2 request processor (requires Windows + QuickBooks Desktop installed)
- **Simulation mode** — In-memory mock data store for development, testing, and non-Windows environments (default)

## Tools (66 total)

### Customers
| Tool | Description |
|------|-------------|
| `qb_customer_list` | List/search customers with filters |
| `qb_customer_add` | Create a new customer |
| `qb_customer_update` | Update customer details |
| `qb_customer_delete` | Delete a customer |

### Vendors
| Tool | Description |
|------|-------------|
| `qb_vendor_list` | List/search vendors |
| `qb_vendor_add` | Create a new vendor |
| `qb_vendor_update` | Update vendor details |
| `qb_vendor_delete` | Delete a vendor |

### Chart of Accounts

`qb_account_make_inactive` is the preferred way to retire an account — it flips `IsActive: false` so the account hides from the default `qb_account_list` view but stays referenceable by historical transactions. `qb_account_delete` is a hard delete that real QB rejects (statusCode 3260/3170) for accounts with any transaction history; use it only for empty accounts created in error. Both wrap structured tool errors via `isError: true` + `statusCode` so stale `editSequence` (3170) and unknown `listId` (500) surface cleanly.

| Tool | Description |
|------|-------------|
| `qb_account_list` | List accounts (filterable by type, defaults to active-only) |
| `qb_account_add` | Create a new account |
| `qb_account_update` | Update account details (name / number / description / isActive) |
| `qb_account_make_inactive` | Deactivate an account by ListID + EditSequence (sets IsActive: false). Reversible via `qb_account_update { isActive: true }`. |
| `qb_account_delete` | Hard-delete an account by ListID. Fails for accounts with transaction history — use `qb_account_make_inactive` instead. |

### Invoices

`qb_invoice_update` accepts an optional `lines` array with the same shape as `qb_invoice_create` plus an optional `txnLineID` per entry — when provided and matching an existing line, the line is merged in place; otherwise it's added new. Line arrays passed to `qb_invoice_update` REPLACE the existing line set wholesale (any line you don't list is dropped). `Subtotal`, `BalanceRemaining`, and `IsPaid` recompute automatically; `AppliedAmount` is preserved. If a line mod drops `Subtotal` below `AppliedAmount`, `BalanceRemaining` goes negative — that's the over-applied state and matches real QB. Customer balance moves by the change in `BalanceRemaining`. A stale `editSequence` rejects with statusCode 3170.

| Tool | Description |
|------|-------------|
| `qb_invoice_list` | List/search invoices with date/status filters |
| `qb_invoice_create` | Create an invoice with line items |
| `qb_invoice_update` | Modify an existing invoice. Pass `txnId` + `editSequence` plus any header fields and/or replacement `lines: [{txnLineID?, itemName?, itemListId?, description?, quantity?, rate?, amount?}]`. Header-only mods leave existing lines untouched. Customer balance adjusts by `newBalanceRemaining - oldBalanceRemaining` (or full reverse-then-apply if `customerName` / `customerListId` re-points the invoice). |
| `qb_invoice_delete` | Delete an invoice |

### Bills (Accounts Payable)

A bill must post to a GL account, so `qb_bill_create` requires at least one of `expenseLines` or `itemLines`. `AmountDue` is the sum of all line amounts. `qb_bill_update` accepts the same line shapes plus optional `txnLineID` per line — when provided, the line is treated as a modify of the existing line and the simulation merges the mod's fields onto it; otherwise the line is added new. Line arrays passed to `qb_bill_update` REPLACE the existing line set wholesale (any line you don't list is dropped). A stale `editSequence` rejects with statusCode 3170.

`qb_bill_pay` records a bill payment against one or more open bills. Pass `paymentMethod: "check" | "creditcard"` to route to `BillPaymentCheck` or `BillPaymentCreditCard`, plus a non-empty `applyTo: [{txnId, amount, discountAmount?, discountAccountName?}]` array. Each entry reduces the named bill's `AmountDue`, flips `IsPaid` to true when `AmountDue` hits zero, and decrements the vendor's `Balance` by the applied amount. Discount handling mirrors the AR side: `discountAmount` closes part of the bill alongside the payment but does NOT reduce vendor balance (the vendor granted the discount, they didn't receive cash for it). Over-payment leaves `AmountDue` negative + `IsPaid` false (vendor credit). An unknown bill `TxnID` in `applyTo` rejects the whole payment atomically — no partial mutations.

`qb_bill_payment_list` queries bill payments across both BillPaymentCheck and BillPaymentCreditCard stores by default; pass `paymentType: "check" | "creditcard"` to scope to one type.

| Tool | Description |
|------|-------------|
| `qb_bill_list` | List/search bills |
| `qb_bill_create` | Create a new bill. Takes `expenseLines: [{accountName, amount, memo?, className?}]` and/or `itemLines: [{itemName, quantity, cost, memo?}]`. Item line `Amount = quantity * cost`. |
| `qb_bill_update` | Modify an existing bill. Pass `txnId` + `editSequence` plus any header fields and/or replacement `expenseLines` / `itemLines`. Header-only mods leave existing lines untouched. Vendor balance adjusts by `newAmountDue - oldAmountDue` (or full reverse-then-apply if `vendorName` / `vendorListId` re-points the bill). |
| `qb_bill_delete` | Delete a bill |
| `qb_bill_pay` | Pay one or more bills via check or credit card. `paymentMethod: "check" \| "creditcard"`; `applyTo` required and non-empty; reduces `Bill.AmountDue` and `Vendor.Balance` by the applied sum; `discountAmount` closes alongside the payment without moving vendor balance. |
| `qb_bill_payment_list` | List BillPaymentCheck + BillPaymentCreditCard records. Pass `paymentType` to scope to one. |

### Items (Products & Services)

QuickBooks has no generic "Item" — every item belongs to one of five subtypes. The `itemType` arg selects the subtype: `Service`, `Inventory`, `NonInventory`, `OtherCharge`, or `Group`.

| Tool | Description |
|------|-------------|
| `qb_item_list` | List/search items. `itemType` is optional — omit to query all five subtypes and merge. |
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
| `qb_sales_receipt_update` | Modify an existing receipt. Pass `txnId` + `editSequence` plus any header fields and/or replacement `lines: [{txnLineID?, itemName?, itemListId?, description?, quantity?, rate?, amount?}]`. Header-only mods leave existing lines untouched. `Subtotal` + `TotalAmount` recompute after line mods. |
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

### Employees

`qb_employee_make_inactive` is the preferred way to retire an employee — it flips `IsActive: false` so the employee hides from the default `qb_employee_list` view but stays referenceable by historical paychecks, timesheets, and payroll reports. `qb_employee_delete` is a hard delete that real QB rejects (statusCode 3260/3170) for employees with any transaction history; use it only for empty employee records created in error. Both wrap structured tool errors via `isError: true` + `statusCode` so stale `editSequence` (3170) and unknown `listId` (500) surface cleanly.

| Tool | Description |
|------|-------------|
| `qb_employee_list` | List/search employees |
| `qb_employee_add` | Create an employee record |
| `qb_employee_update` | Update employee details (firstName / lastName / phone / email / isActive) |
| `qb_employee_make_inactive` | Deactivate an employee by ListID + EditSequence (sets IsActive: false). Reversible via `qb_employee_update { isActive: true }`. |
| `qb_employee_delete` | Hard-delete an employee by ListID. Fails for employees with paycheck/timesheet history — use `qb_employee_make_inactive` instead. |

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

### Reports & Queries
| Tool | Description |
|------|-------------|
| `qb_company_info` | Get company/connection info |
| `qb_balance_summary` | Account balance overview |
| `qb_ar_aging` | Accounts receivable aging |
| `qb_ap_aging` | Accounts payable aging |
| `qb_raw_query` | Execute raw QBXML queries |

### Session Management
| Tool | Description |
|------|-------------|
| `qb_session_connect` | Open a QuickBooks session |
| `qb_session_disconnect` | Close the session |

## Architecture

```
┌─────────────┐     MCP/stdio      ┌──────────────────────┐
│  AI Agent /  │◄──────────────────►│  QuickBooks Desktop  │
│  LLM Client  │                    │  MCP Server          │
└─────────────┘                    │                      │
                                    │  ┌────────────────┐  │
                                    │  │ Tool Registry   │  │     QBXML
                                    │  │ (36 tools)      │──│──────────────┐
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
| `QB_APP_NAME` | App name for QB registration | `MCP QuickBooks Manager` |
| `QB_APP_ID` | Application ID (optional) | — |
| `QB_QBXML_VERSION` | QBXML protocol version | `16.0` |
| `QB_CONNECTION_MODE` | `localOnly`, `remoteOnly`, or `optimistic` | `optimistic` |
| `QB_SIMULATION` | Force simulation mode | `true` on non-Windows |
| `QB_LIVE` | Set to `1` for live QB connection | — |

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
- `EmployeeQueryRq/AddRq/ModRq` — Employees
- `ListDelRq / TxnDelRq` — Deletions
