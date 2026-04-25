# Requirements

Product-level truth. What the system must do for the operator. Distinct from `todo.md` (which is implementation sequence) and `ARCHITECTURE.md` (which is structural rules).

If a requirement here conflicts with what the code does, the code is wrong, not the requirement. If implementation work changes what the operator can do, update this file in the same session.

---

## Operator

Single user. Personal tool. The operator manages QuickBooks Desktop books for one or more clients via an LLM agent (Claude Desktop, Claude Code, or any MCP-capable client). The bar is "works flawlessly for me," not "production SaaS."

---

## Core Promises

These are non-negotiable. If any of them is broken, the system has a bug regardless of what `todo.md` says.

1. **The operator can manage a complete QuickBooks Desktop accounting workflow through tool calls** — create customers/vendors/items/accounts, issue invoices and bills with proper line items, record and apply payments, run aging and summary reports.
2. **Live mode and simulation mode are observationally identical** to the LLM. The agent's behavior should not change based on which mode the server runs in.
3. **No tool call silently corrupts the books.** Every write operation is either confirmed by QuickBooks (live) or visibly reflected in subsequent reads (simulation). Operations that QuickBooks would reject must surface a structured error, not appear successful.
4. **No tool returns wrong data.** Filters that are exposed in a tool's input schema must actually be applied. A list query with a filter must not return records outside that filter.
5. **The simulation faithfully reflects QB's behavior** for every workflow the operator uses regularly. If a workflow can't be exercised in simulation, the operator can't develop against it without a Windows + QB Desktop machine — that's a regression in the simulation contract.

---

## Functional Requirements

### F1 — Customer / Vendor management

- **F1.1** List customers and vendors, filterable by name (partial match), active status, and ListID.
- **F1.2** Create new customers and vendors with at minimum: name, company name, contact info, billing/vendor address.
- **F1.3** Update existing customers and vendors via ListID + EditSequence (optimistic locking).
- **F1.4** Deactivate (soft delete) customers and vendors. Hard delete only where QB allows it.
- **F1.5** Customer/vendor balances reflect all related transactions (invoices, bills, payments).

### F2 — Chart of Accounts

- **F2.1** List accounts, filterable by account type and active status.
- **F2.2** Create new accounts with valid `AccountType` (must be one of QB's allowed types — see `ARCHITECTURE.md` for the list).
- **F2.3** Update existing accounts.
- **F2.4** Deactivate accounts. (Hard delete is not required — QB usually disallows it for accounts with transactions.)

### F3 — Items (Products & Services)

- **F3.1** List items, filterable by name, type (Service / Inventory / NonInventory / OtherCharge / Group), and active status.
- **F3.2** Create new items, with type-appropriate fields (Service: income account; Inventory: COGS + asset accounts + cost; etc.).
- **F3.3** Update existing items.
- **F3.4** Deactivate items.
- **F3.5** Item operations use the correct per-subtype QBXML request types — there is no generic `ItemQueryRq`.

### F4 — Invoices

- **F4.1** List invoices, filterable by customer (name or ListID), date range, paid status, ref number, and TxnID.
- **F4.2** Create invoices with header (customer, dates, ref number, memo, terms) and one or more line items (item, description, quantity, rate, amount).
- **F4.3** Update invoices, including modification of line items (add new lines, modify existing lines via TxnLineID, remove lines).
- **F4.4** Delete invoices (when QB permits — typically only if no payments are applied).
- **F4.5** Invoice creation produces a response with computed `Subtotal`, `BalanceRemaining`, and `IsPaid` matching QB's behavior.

### F5 — Bills (Accounts Payable)

- **F5.1** List bills, filterable by vendor, date range, paid status, ref number, TxnID.
- **F5.2** Create bills with header AND expense lines (`AccountRef` + `Amount`) and/or item lines (`ItemRef` + `Quantity` + `Cost`). A bill with only a header is not a valid bill.
- **F5.3** Update bills, including line modification.
- **F5.4** Pay bills via `BillPaymentCheck` or `BillPaymentCreditCard`, applied to one or more open bills.
- **F5.5** Delete bills (when QB permits).
- **F5.6** Bill creation correctly affects vendor balance and AP aging.

### F6 — Payments

- **F6.1** Record a received payment from a customer.
- **F6.2** Apply a received payment to one or more specific open invoices via `AppliedToTxnAdd` (txnId + amount + optional discount). Payments without applications are recorded but should clearly be flagged as unapplied.
- **F6.3** Apply an existing unapplied payment to invoices later via a separate operation (`qb_payment_apply`).
- **F6.4** Payment recording and application correctly reduce the invoice's `BalanceRemaining` and the customer's `Balance`.
- **F6.5** List received payments, filterable by customer and date range.

### F7 — Estimates

- **F7.1** List estimates, filterable by customer and date range.
- **F7.2** Create estimates with header and line items.
- **F7.3** Update and delete estimates.
- **F7.4** Convert an estimate into an invoice in a single operation, copying line items.

### F8 — Other transactions

- **F8.1** Sales receipts: list, create, delete (cash sales — no AR involvement).
- **F8.2** Credit memos: list, create, delete (negative invoices).
- **F8.3** Purchase orders: list, create, delete.
- **F8.4** Journal entries: list, create, delete (debit/credit pairs to specific accounts).

### F9 — Employees

- **F9.1** List, create, update employees (full payroll is out of scope; basic employee records only).
- **F9.2** Deactivate employees.

### F10 — Supporting lists

For invoice/bill creation to work, the operator must be able to discover available reference values:

- **F10.1** List Classes.
- **F10.2** List Terms (payment terms).
- **F10.3** List Payment Methods.
- **F10.4** List Sales Reps.
- **F10.5** List Customer Types and Vendor Types.

### F11 — Reporting

- **F11.1** Company info: company name, legal name, address, fiscal year start, tax form (via real `CompanyQueryRq`).
- **F11.2** Balance summary: account balances grouped by `AccountType` in canonical QB order.
- **F11.3** AR aging: open invoices bucketed 0–30 / 31–60 / 61–90 / 90+ days, filterable by `asOfDate`.
- **F11.4** AP aging: same shape as AR aging, for vendors.
- **F11.5** Profit & Loss (Standard) report via `GeneralSummaryReportQueryRq`, with date-range support.
- **F11.6** Balance Sheet (Standard) report via `GeneralSummaryReportQueryRq`, with `asOfDate`.
- **F11.7** Raw QBXML query escape hatch for advanced operations not covered by specific tools.

### F12 — Session management

- **F12.1** The operator can explicitly open and close a QuickBooks session.
- **F12.2** The first operation auto-opens a session if one isn't open.
- **F12.3** A session can be safely re-opened after disconnect within the same server process.

---

## Non-Functional Requirements

### NF1 — Mode parity

Live and simulation produce identically-shaped responses. Any divergence is a bug.

### NF2 — Cross-platform development

The simulation path must run on macOS / Linux / Windows. Live path is Windows-only by necessity.

### NF3 — Reproducible dev state

Restarting the simulation server resets to the same seed state. No hidden persistence between runs.

### NF4 — Structured errors

Tool failures return `isError: true` with a JSON payload containing `success: false`, `error: <message>`, and (where applicable) the QB status code. Raw exceptions must not leak through the MCP transport.

### NF5 — Pagination for large queries

Real QuickBooks caps queries at ~500 records and uses `IteratorID` / `IteratorRemainingCount` for pagination. Tools that can return large result sets must support pagination transparently — the operator should not have to re-issue queries to get full results.

### NF6 — Build verification

`npm run build` (TypeScript strict mode) passes for every committed state.

### NF7 — Discoverability

The MCP server's `instructions` block (in [src/index.ts](src/index.ts)) accurately lists every available tool category. The README's tool table accurately lists every tool. Stale instructions cause the LLM to hallucinate or miss tools.

---

## Out of Scope (for now)

- Multi-tenant operation (one server, multiple `.qbw` files concurrently).
- HTTP / WebSocket transport — stdio only.
- Persistent caching of live responses.
- Full QB payroll integration.
- QuickBooks Online (this server is QB Desktop SDK only).
- Web UI / dashboard — the MCP transport is the only interface.
- Authentication / multi-user authorization — single operator on a trusted machine.

---

## Requirements vs. Implementation Status

For the live mapping of which requirements are met by which implementation, see `todo.md`. As of project setup (2026-04-25), the bulk of F4–F11 are partially implemented but have known correctness gaps documented in `todo.md`.
