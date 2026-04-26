# QuickBooks Desktop MCP — Fix List

Comprehensive list of fixes required to make the server work flawlessly for personal use. Ordered by recommended execution sequence (simulation correctness first so later changes can be tested in dev, live COM last because it requires a Windows + QB Desktop box to verify).

---

## Phase 1 — Simulation correctness (fix dev environment first)

So that everything below can actually be verified without a Windows box.

- [x] **15.** Add `EntityFilter`, `TxnDateRangeFilter`, `PaidStatus`, `RefNumber`, `ModifiedDateRangeFilter` handling to `simulation-store.handleQuery` — currently silently ignored, so transaction list queries return ALL records regardless of filter.
- [x] **17.** Convert input `*LineAdd` arrays to `*LineRet` arrays in simulation responses (with `TxnLineID`, computed `Amount = Quantity * Rate`) so downstream tools see proper line breakdown.
- [x] **16.** Compute `Subtotal`, `SalesTaxTotal`, `BalanceRemaining`, `AppliedAmount`, `IsPaid` in `simulation-store.handleAdd` for invoices/bills/estimates so simulated responses match real QB shape.
- [x] **18.** Update customer/vendor balances in simulation store when invoices/bills/payments are added/applied/deleted, so AR/AP aging reports reflect activity in dev.
- [x] **22.** Multi-store Item simulation: split the single `Item` store into `ItemService` / `ItemInventory` / `ItemNonInventory` / `ItemOtherCharge` / `ItemGroup` stores keyed by `ItemType`, return correct `*Ret` element name (`ItemServiceRet` etc.) so parser's `arrayElements` set actually matches.

## Phase 2 — Item request types (touches schema everywhere)

- [x] **2.** Fix Item request types: replace generic `ItemQueryRq` / `AddRq` / `ModRq` with per-type variants (`ItemServiceQueryRq`, `ItemInventoryQueryRq`, `ItemNonInventoryQueryRq`, `ItemOtherChargeQueryRq`, `ItemGroupQueryRq`) in [tools/items.ts](src/tools/items.ts) and route through manager based on `itemType` arg.
- [x] **3.** Fix Item delete to use correct `ListDelType` subtype (`ItemService`, `ItemInventory`, etc.) — currently sends `'Item'` which QB rejects.

## Phase 3 — Transaction completeness (the workflows that matter)

- [x] **4.** Add `ExpenseLineAdd` and `ItemLineAdd` support to `qb_bill_create` — accept `lines: [{accountName, amount, memo}]` and `lines: [{itemName, quantity, cost}]`, so bills actually post to GL accounts.
- [x] **5.** Add `AppliedToTxnAdd` support to `qb_payment_receive` — accept `appliedTo: [{txnId, amount, discountAmount?}]` so payments actually close out invoices and reduce customer balances.
- [x] **7.** Implement `qb_bill_update` tool (`BillModRq`) — header fields plus `ExpenseLineMod` / `ItemLineMod` support, register in [index.ts](src/index.ts).
- [x] **6.** Add `InvoiceLineMod` support to `qb_invoice_update` — accept `lines` arg with optional `txnLineID` (existing line) or `'-1'` (new line) and build `InvoiceLineMod` blocks.
- [x] **8.** Add `qb_payment_apply` tool — apply an existing unapplied `ReceivePayment` to specific invoices via `ReceivePaymentMod` + `AppliedToTxnMod`.
- [x] **9.** Add `qb_bill_pay` tool — record `BillPaymentCheck` or `BillPaymentCreditCard` against existing bills (currently no way to mark a bill as paid).

## Phase 4 — Missing tools / coverage gaps

- [x] **10.** Add `qb_account_delete` / `qb_account_make_inactive` — currently only list/add/update; needed to deactivate unused accounts (QB usually disallows hard delete if transactions exist, so `make_inactive` is the correct primary).
- [x] **11.** Add `qb_employee_delete` / `make_inactive` (currently only list/add/update).
- [x] **12.** Add missing transaction tools: ~~`qb_sales_receipt_*`~~ (done 2026-04-26), ~~`qb_credit_memo_*`~~ (done 2026-04-26), ~~`qb_purchase_order_*`~~ (done 2026-04-26), ~~`qb_journal_entry_*`~~ (done 2026-04-26).
- [x] **13.** Add `qb_estimate_update`, `qb_estimate_delete`, `qb_estimate_convert_to_invoice` tools — currently only list/create.
- [x] **30.** Add `Class`, `Terms`, `PaymentMethod`, `SalesRep`, `CustomerType`, `VendorType` list tools — needed because invoice/bill creation references these by `FullName` but there's no way to list/discover them.

## Phase 5 — Reporting (currently mostly fake)

- [x] **14.** Implement real `CompanyQueryRq` in `qb_company_info` — return company name, legal name, address, fiscal year start, tax form, etc., not just session state.
- [ ] **19.** Implement `asOfDate` filtering in `qb_ar_aging` and `qb_ap_aging` — currently the param is decorative; should filter open transactions by date and bucket by 0-30 / 31-60 / 61-90 / 90+ days.
- [ ] **20.** Add proper P&L and Balance Sheet report tools (`GeneralSummaryReportQueryRq` with `ReportType=ProfitAndLossStandard` / `BalanceSheetStandard`) — current "reports" are just account-balance rollups.
- [ ] **21.** Add date-range support to `qb_balance_summary`, and group by `AccountType` in canonical QB order (Bank, AccountsReceivable, OtherCurrentAsset, ... Equity, Income, COGS, Expense).

## Phase 6 — Plumbing, validation, ergonomics

- [ ] **23.** Fix `QB_SIMULATION` env semantics in [session/manager.ts:51-53](src/session/manager.ts#L51-L53) — currently `QB_SIMULATION=false` on Windows still simulates unless `QB_LIVE=1` is also set; either honor `QB_SIMULATION=false` alone or document the actual rule and align README.
- [x] **24.** Remove dead code: `parseQBXMLResponse` import in [session/manager.ts:27](src/session/manager.ts#L27), `buildSingleRequest` export in [qbxml/builder.ts:66](src/qbxml/builder.ts#L66), `QBXMLRequestBody` import in [qbxml/builder.ts:9](src/qbxml/builder.ts#L9), and the useless ternary `isTransaction ? id : id` at [simulation-store.ts:214](src/session/simulation-store.ts#L214).
- [ ] **25.** Wrap `session.queryEntity` / `addEntity` / `modifyEntity` / `deleteEntity` calls in tool handlers with try/catch — translate `QBXMLResponseError` into structured tool error responses (`isError: true` with `statusCode` + `statusMessage`) instead of letting them propagate as raw exceptions.
- [ ] **26.** Add status code mapping table for common QB errors (3120 missing field, 3170 modify failed, 3260 insufficient permission, 500 not found, etc.) so tool errors are user-readable.
- [ ] **27.** Add `IteratorID` / `IteratorRemainingCount` support to large queries (Customer, Invoice, Item) — real QB caps at ~500 rows and returns an iterator handle for pagination.
- [ ] **28.** Validate `AccountType` enum in `qb_account_add` against QB's allowed values (`Bank`, `AccountsReceivable`, `OtherCurrentAsset`, `FixedAsset`, `OtherAsset`, `AccountsPayable`, `CreditCard`, `OtherCurrentLiability`, `LongTermLiability`, `Equity`, `Income`, `CostOfGoodsSold`, `Expense`, `OtherIncome`, `OtherExpense`, `NonPosting`).
- [ ] **29.** Add minimal input validation: email format, phone, postal code, ISO date strings (`YYYY-MM-DD`) on date fields — currently any string passes through to QB which then rejects with cryptic errors.

## Phase 7 — Live mode (last, requires Windows + QB Desktop to verify)

- [ ] **1.** Implement live `QBXMLRP2` COM connection in [session/manager.ts](src/session/manager.ts) (add `winax` / `node-activex` dep, replace throws in `openSession` / `sendRequest` with real `OpenConnection2` / `BeginSession` / `ProcessRequest` / `EndSession` / `CloseConnection` calls, wire `parseQBXMLResponse` for live responses).

## Phase 8 — Project hygiene

- [ ] **31.** Add `tests/` directory with Vitest: round-trip tests for builder→parser, simulation-store CRUD per entity, filter handling, and tool integration tests through the MCP server transport.
- [ ] **32.** Add `.gitignore` (`node_modules/`, `dist/`, `*.log`, `.env`), `.env.example` documenting all `QB_*` vars, and run `npm run build` to verify `dist/` produces working node entry.
- [x] **33.** Update README tool count and tables once new tools (~~bill_update~~, ~~payment_apply~~, ~~bill_pay~~, ~~account_delete~~, ~~sales_receipt~~/~~credit_memo~~/~~PO~~/~~JE~~, ~~estimate_update/delete/convert~~, ~~supporting list tools~~) are added. _(Closed 2026-04-26 when JE README work landed.)_
