# QuickBooks Desktop MCP — Fix List

Comprehensive list of fixes required to make the server work flawlessly for personal use. Ordered by recommended execution sequence (simulation correctness first so later changes can be tested in dev, live COM last because it requires a Windows + QB Desktop box to verify).

Each closed item is a one-line summary; the deep implementation context lives in [DECISIONS.md](DECISIONS.md) (dated entries), [HANDOFF.md](HANDOFF.md) (latest session state), and inline in the relevant `src/` files. Tests are in [tests/](tests/).

---

## Phase 1 — Simulation correctness (fix dev environment first)

So that everything below can actually be verified without a Windows box.

- [x] **15.** Add `EntityFilter`, `TxnDateRangeFilter`, `PaidStatus`, `RefNumber`, `ModifiedDateRangeFilter` handling to `simulation-store.handleQuery` — currently silently ignored, so transaction list queries return ALL records regardless of filter.
- [x] **17.** Convert input `*LineAdd` arrays to `*LineRet` arrays in simulation responses (with `TxnLineID`, computed `Amount = Quantity * Rate`) so downstream tools see proper line breakdown.
- [x] **16.** Compute `Subtotal`, `SalesTaxTotal`, `BalanceRemaining`, `AppliedAmount`, `IsPaid` in `simulation-store.handleAdd` for invoices/bills/estimates so simulated responses match real QB shape.
- [x] **18.** Update customer/vendor balances in simulation store when invoices/bills/payments are added/applied/deleted, so AR/AP aging reports reflect activity in dev.
- [x] **22.** Multi-store Item simulation: split the single `Item` store into `ItemService` / `ItemInventory` / `ItemNonInventory` / `ItemOtherCharge` / `ItemGroup` stores keyed by `ItemType`, return correct `*Ret` element name so parser's `arrayElements` set actually matches.

## Phase 2 — Item request types (touches schema everywhere)

- [x] **2.** Fix Item request types: replace generic `ItemQueryRq` / `AddRq` / `ModRq` with per-type variants (`ItemServiceQueryRq`, `ItemInventoryQueryRq`, `ItemNonInventoryQueryRq`, `ItemOtherChargeQueryRq`, `ItemGroupQueryRq`) in [tools/items.ts](src/tools/items.ts) and route through manager based on `itemType` arg.
- [x] **3.** Fix Item delete to use correct `ListDelType` subtype (`ItemService`, `ItemInventory`, etc.) — currently sends `'Item'` which QB rejects.

## Phase 3 — Transaction completeness (the workflows that matter)

- [x] **4.** Add `ExpenseLineAdd` and `ItemLineAdd` support to `qb_bill_create` — accept `lines: [{accountName, amount, memo}]` and `lines: [{itemName, quantity, cost}]`, so bills actually post to GL accounts.
- [x] **5.** Add `AppliedToTxnAdd` support to `qb_payment_receive` — accept `appliedTo: [{txnId, amount, discountAmount?}]` so payments actually close out invoices and reduce customer balances.
- [x] **7.** Implement `qb_bill_update` tool (`BillModRq`) — header fields plus `ExpenseLineMod` / `ItemLineMod` support, register in [index.ts](src/index.ts).
- [x] **6.** Add `InvoiceLineMod` support to `qb_invoice_update` — accept `lines` arg with optional `txnLineID` (existing line) or `'-1'` (new line) and build `InvoiceLineMod` blocks.
- [x] **8.** Add `qb_payment_apply` tool — apply an existing unapplied `ReceivePayment` to specific invoices via `ReceivePaymentMod` + `AppliedToTxnMod`.
- [x] **9.** Add `qb_bill_pay` tool — record `BillPaymentCheck` or `BillPaymentCreditCard` against existing bills.

## Phase 4 — Missing tools / coverage gaps

- [x] **10.** Add `qb_account_delete` / `qb_account_make_inactive` — `make_inactive` is the correct primary (QB usually disallows hard delete if transactions exist).
- [x] **11.** Add `qb_employee_delete` / `make_inactive`.
- [x] **12.** Add missing transaction tools: `qb_sales_receipt_*`, `qb_credit_memo_*`, `qb_purchase_order_*`, `qb_journal_entry_*`.
- [x] **13.** Add `qb_estimate_update`, `qb_estimate_delete`, `qb_estimate_convert_to_invoice` tools.
- [x] **30.** Add `Class`, `Terms`, `PaymentMethod`, `SalesRep`, `CustomerType`, `VendorType` list tools — needed because invoice/bill creation references these by `FullName`.

## Phase 5 — Reporting (currently mostly fake)

- [x] **14.** Implement real `CompanyQueryRq` in `qb_company_info` — return company name, legal name, address, fiscal year start, tax form, etc.
- [x] **19.** Implement `asOfDate` filtering in `qb_ar_aging` and `qb_ap_aging` — filter open transactions by date and bucket by 0-30 / 31-60 / 61-90 / 90+ days.
- [x] **20.** Add proper P&L and Balance Sheet report tools (`GeneralSummaryReportQueryRq` with `ReportType=ProfitAndLossStandard` / `BalanceSheetStandard`).
- [x] **21.** Add date-range support to `qb_balance_summary`, group by `AccountType` in canonical QB order.

## Phase 6 — Plumbing, validation, ergonomics

- [x] **23.** Fix `QB_SIMULATION` env semantics — `QB_SIMULATION=false` on Windows still simulated unless `QB_LIVE=1`; honor the cleaner rule and document.
- [x] **24.** Remove dead code: stale imports and a useless ternary in `simulation-store.ts:214`.
- [x] **25.** Wrap `session.queryEntity` / `addEntity` / `modifyEntity` / `deleteEntity` calls in tool handlers with try/catch — translate `QBXMLResponseError` into structured tool error responses.
- [x] **26.** Add status code mapping table for common QB errors (3120, 3170, 3260, 500, etc.) so tool errors are user-readable.
- [x] **27.** Add `IteratorID` / `IteratorRemainingCount` support to large queries (Customer, Invoice, Bill, Item).
- [x] **28.** Validate `AccountType` enum in `qb_account_add` against QB's allowed values.
- [x] **29.** Add minimal input validation: email format, phone, postal code, ISO date strings.

## Phase 7 — Live mode (last, requires Windows + QB Desktop to verify)

- [x] **1.** Implement live `QBXMLRP2` COM connection in [session/manager.ts](src/session/manager.ts) — `winax` 3.4.2 dep, `OpenConnection2` / `BeginSession` / `ProcessRequest` / `EndSession` / `CloseConnection`. _(Closed 2026-05-09. Live verified end-to-end against `VR Tax & Consulting Inc..qbw`.)_
- [x] **34.** Add `qb_company_open` tool — accept `companyFile` arg, close active session, swap config, open against new file. Reseeds sim store on switch. _(Closed 2026-05-09. `switchCompanyFile` in [src/session/manager.ts](src/session/manager.ts); tool in [src/tools/reports.ts](src/tools/reports.ts). Sim-fidelity tradeoff logged in DECISIONS.md 2026-05-09.)_
- [x] **35.** Add `qb_company_list` tool — enumerate `.qbw` files under `$QB_COMPANY_ROOT` (default: dirname of `$QB_COMPANY_FILE`). _(Closed 2026-05-09.)_
- [x] **36.** Add `tests/company-switching.test.ts` covering switch/reseed/round-trip + `qb_company_list`. _(Closed 2026-05-09.)_

## Phase 8 — Project hygiene

- [x] **31.** Add `tests/` directory with Vitest — round-trip tests for builder→parser, simulation-store CRUD per entity, filter handling. _(Closed 2026-04-27.)_
- [x] **32.** Add `.gitignore`, `.env.example` documenting all `QB_*` vars, verify `dist/` produces a working node entry. _(Closed 2026-04-27.)_
- [x] **33.** Update README tool count and tables as new tools land.

---

## Phase 9 — Critical bug fixes (operator-blocking, P0)

- [x] **37.** Fix `qb_pnl_report` — schema-order error caused `statusCode -1` regardless of params. _(Closed 2026-05-09. Two halves: schema-order fix in `buildReportRequest` (ReportBasis moved to position 15), plus new `adaptLiveReportRet` in [src/qbxml/parser.ts](src/qbxml/parser.ts) for the live row-tree → Sections/Totals shape. Live verified FY2024 against `VR Tax & Consulting Inc..qbw`. DECISIONS.md 2026-05-09 logs the parser-layer adapter choice.)_
- [x] **38.** Fix `qb_balance_summary` `asOfDate` filter — silently ignored. _(Closed 2026-05-09. Replaced fromDate/toDate with `asOfDate + basis`; AS/LI/EQ sourced from BalanceSheetStandard, INC/EXP from P&L through asOfDate. New `buildBalanceSummary` helper. DECISIONS.md 2026-05-09.)_
- [x] **39.** Pagination DX — default `maxReturned` to 500 when `paginate: true`, surface iterator semantics. _(Closed 2026-05-09. Coalesce in the 4 paginated list tools.)_

## Phase 10 — High-priority features (operator's top-10 list)

- [x] **40.** `qb_transaction_list_by_account` — GL account, date range, running balance. _(Closed 2026-05-09. Wraps `TransactionQueryRq` via new `session.queryTransactions`; sim `handleTransactionQuery` walks line-level postings.)_
- [x] **41.** Line-level detail in list responses — `includeLineItems: boolean` on 7 list tools. _(Closed 2026-05-09. Sim strips `*LineRet` by default; preserves when flag truthy.)_
- [x] **42.** Read-only session flag — single chokepoint via `assertWritable` + synthetic statusCode **9001**. _(Closed 2026-05-10. `qb_session_connect({readOnly: true})` gates all 47 mutation call sites automatically. DECISIONS.md 2026-05-10.)_
- [x] **43.** `qb_journal_entry_batch_create` — atomic batch with compensating-delete rollback. _(Closed 2026-05-10. Single envelope with `onError="stopOnError"`; per-entry status: posted/rolled-back/orphaned/failed/skipped. Generalized `session.executeBatchAdd`.)_
- [x] **44.** `qb_1099_summary` + `qb_1099_detail` — composite over `Bill` + `Check` queries; vendor classification via `IsVendorEligibleFor1099`. _(Closed 2026-05-10.)_
- [x] **45.** ~~Memorized / recurring transaction CRUD~~ — **CLOSED 2026-05-10 SDK-BLOCKED.** Not exposed by QBXML at any version. Workflow stand-in: `qb_invoice_duplicate` (see #57a).
- [x] **46.** Bank reconciliation primitives — narrowed scope after SDK research. `qb_cleared_status_update` wraps `ClearedStatusModRq`. _(Closed 2026-05-10. DECISIONS.md 2026-05-10.)_
- [x] **47.** Idempotency keys on creates — synthetic statusCode **9002** on conflict; cache per companyFile cleared on `switchCompanyFile`. _(Closed 2026-05-10. 16 `*_create` / `*_add` handlers; SHA-256 fingerprint. DECISIONS.md 2026-05-10.)_

## Phase 11 — Remaining missing reports

- [x] **48.** `qb_customer_balance_detail` — composite over Invoice + ReceivePayment + CreditMemo with running balance. _(Closed 2026-05-11. DECISIONS.md 2026-05-11.)_
- [x] **49.** `qb_sales_by_customer_summary` + `_detail` — paired delivery shipping new `GeneralDetailReportQueryRq` wire infrastructure. _(Closed 2026-05-10. DECISIONS.md 2026-05-10.)_
- [x] **50.** `qb_sales_by_item_summary` + `_detail` — mirrors #49 with new `ReportItemFilter`. _(Closed 2026-05-11.)_
- [x] **51.** `qb_vendor_balance_detail` — AP mirror of #48. _(Closed 2026-05-11.)_
- [x] **52.** `qb_expense_by_vendor_summary` + `_detail` — paired delivery; adjacent strict-fix added `CreditCardCharge` + `CreditCardCredit` to transaction-type lists. _(Closed 2026-05-11.)_
- [x] **53.** `qb_general_ledger` — composite over `TransactionQueryRq` + `AccountQueryRq` (not `GeneralDetailReportQueryRq` which doesn't expose GL). Pure `buildGeneralLedgerSection` helper. _(Closed 2026-05-10. DECISIONS.md 2026-05-10.)_
- [x] **54.** `qb_statement_of_cash_flows` — `GeneralSummaryReportQueryRq` with indirect method. _(Closed 2026-05-12. Sim implementation + live adapter `CASH_FLOWS_SECTION_NAMES` map. DECISIONS.md 2026-05-12. Live adapter verified-by-construction; first live SCF run may need section-name extensions.)_
- [x] **55.** `qb_w2_summary` — `PayrollSummaryReportQueryRq` end-to-end with edition gate (Pro → **9003**) + empty-result gate (**9004**). _(Closed 2026-05-12. DECISIONS.md 2026-05-12. Live verification deferred.)_
- [x] **56.** `qb_reconciliation_discrepancy` — surfaces bank/CC txns marked Cleared but modified since. Shares new `CustomDetailReportQueryRq` infra with #56a. _(Closed 2026-05-10. DECISIONS.md 2026-05-10.)_
- [x] **56a.** `qb_uncleared_transactions` — read-side companion to #46. Same infra. Signed amount sign convention; Transfer emits two rows. _(Closed 2026-05-10.)_

## Phase 12 — Remaining missing workflows

- [x] **57.** `qb_invoice_write_off` — single-call close via ReceivePayment + DiscountAmount + DiscountAccountRef (not CreditMemo). Adjacent AR-side `Customer.Balance` discount-math fix in sim. _(Closed 2026-05-11. DECISIONS.md 2026-05-11. AP-side parallel fix carried as a note for a future `qb_bill_write_off`.)_
- [x] **57a.** `qb_invoice_duplicate` + `qb_bill_duplicate` + `qb_sales_receipt_duplicate` + `qb_journal_entry_duplicate` — composites over query + add primitives. Workflow stand-in for #45's memorized-transaction gap. _(Closed 2026-05-10/11.)_
- [x] **58.** `qb_invoice_batch_create` + `qb_sales_receipt_batch_create` — atomic, mirrors #43. Per-entry status enum. _(Closed 2026-05-11.)_
- [x] **59.** Attachments — `qb_attachment_add` / `_list` / `_delete` via `AttachableAddRq`. File-path validation at sim handler + tool layer. _(Closed 2026-05-12. DECISIONS.md 2026-05-12. Live verification deferred — feature is edition-dependent in real QB.)_

## Phase 13 — Data model gaps in returned objects

- [x] **60.** Customer email/phone in invoice list payload — `includeCustomerContact: boolean` on `qb_invoice_list`; ONE follow-up `CustomerQueryRq` scoped to dedup'd ListIDs. Fail-soft. _(Closed 2026-05-17.)_
- [x] **61.** Custom-field (DataExt) support across all entities — `includeCustomFields: true` + new `qb_custom_field_list`. Read-only V1; write surface deferred. _(Closed 2026-05-17. New OwnerID branch in `handleQuery` with strip-by-default semantics.)_
- [x] **62.** Sub-customer / job hierarchy helpers — `qb_customer_jobs`, plus `parentListID` / `jobOnly` on `qb_customer_list`, plus `parentListId` on `qb_customer_add`. Sim derives `Parent:Child` FullName + `Sublevel`. _(Closed 2026-05-18.)_
- [x] **63.** Memo / note full-text search — `qb_transaction_memo_search` fans across typed `*QueryRq`. `matchedFields` array-index notation. _(Closed 2026-05-20. Bounding rule: scope OR date required.)_

## Phase 14 — Safety and DX

- [x] **64.** Dry-run mode — `dryRun: true` on every `*_create` / `*_update` / `*_delete`. V1 ships manager primitives (`addEntityDryRun` / `modifyEntityDryRun` / `deleteEntityDryRun` / `executeBatchAddDryRun` / `updateClearedStatusDryRun`) + sim store `snapshot()` / `restore()` + 3 pilot tools. _(Closed 2026-05-20. Composition matrix locked in DECISIONS.md 2026-05-20: read-only ALLOW × dry-run, idempotency PEEK + 9002 surface, live mode Option (b) envelope-only.)_
- [x] **64a.** Dry-run mechanical rollout to ~50 mutation tools. _(Closed 2026-05-20. Hand-threaded 62 dryRun-bearing handlers across 24 tool files.)_
- [x] **64b.** Dry-run V2 for the 11 composite outliers — bespoke for all 11 (no 9006 emissions). New `compositePreviewDryRun` primitive for 2-envelope convert tools. _(Closed 2026-05-21. 3 batch tools use existing `executeBatchAddDryRun`; write-off + bill_pay + 4 duplicates use existing `addEntityDryRun` after source-read pre-flight; 2 convert tools use new primitive. **Status code 9006 stays reserved but zero-emit** — defensive for future genuinely-unpreviewable tools. DECISIONS.md 2026-05-21.)_
- [x] **65.** Better error surfaces — `format-tool-error.ts` wrapper with 14 regex patterns surfacing schemaOrder hints + `SCHEMA_ORDER` table for 50+ request types. _(Closed 2026-05-17. Mechanical sweep migrated 137/151 catch-block boilerplates.)_
- [x] **66.** `qb_audit_log` — `CustomDetailReportQueryRq` with `CustomDetailReportType=AuditTrail` (NOT `TxnReportType`). Enterprise-only gate (Pro/Premier → 9003). _(Closed 2026-05-20. DECISIONS.md 2026-05-20 pins wire shape. Live verification deferred to an Enterprise install.)_
- [x] **67.** `qb_session_status` — health check / probe; zero wire I/O default, opt-in `probe: true` runs `HostQueryRq`. Surfaces retry stats + cached hostInfo. _(Closed 2026-05-13.)_

## Phase 15 — Practice-specific wins (operator's firm + skills)

- [x] **68.** `qb_trial_balance_export(asOfDate, basis)` — exact column shape for the operator's `trial-balance-workup` skill. Composite of 5 wire calls + 4 reconciliation cross-checks (BS / NetIncome / AR / AP). Pure `buildTrialBalance` helper. _(Closed 2026-05-13.)_
- [x] **69.** `qb_tax_line_mapping` — exposes `Account.TaxLineInfoRet`; bridges books-to-tax-software prep. Sim seed extended with representative TaxLineInfoRet on 8/10 accounts. _(Closed 2026-05-14.)_
- [x] **70.** `qb_engagement_profitability(customerListId, dateRange)` — revenue + time + reimbursable expenses for a job. Three fail-soft sections; summary omitted when any section errored or toggled off. _(Closed 2026-05-15. Wire-gotcha pinned: `IncludeLineItems: true` REQUIRED on Bill/Check/CCC queries.)_
- [x] **71.** `qb_client_packet(customerListId, taxYear)` — bundles TB + GL + bank rec + payroll summary + fixed asset detail. Fail-soft per section; Pro edition skips payroll with 9003. _(Closed 2026-05-14.)_

## Phase 16 — Architectural improvements

- [x] **72.** Generic `qb_transaction_list({types, filters})` — composite over typed `*QueryRq` (NOT `TransactionQueryRq` which requires AccountFilter + emits line-level postings). Customer-side / vendor-side scope mutex. _(Closed 2026-05-16.)_
- [x] **73.** Server-side iterator exhaustion — `autoExhaust: boolean` on 7 paginated list tools; `maxBatches` default 20 (~10k rows). Streaming via SDK rejected after research (DECISIONS.md 2026-05-20). _(Closed 2026-05-20.)_
- [x] **74.** MCP-side caching of stable lookups — `QBLookupCache` in [src/session/lookup-cache.ts](src/session/lookup-cache.ts), 5-min TTL, scoped per companyFile, cleared on `qb_company_open`. `useCache: boolean` on 5 list tools + new `qb_cache_invalidate`. Read-vs-write split is load-bearing. _(Closed 2026-05-20.)_

## Phase 17 — Domain coverage gaps (entire areas missing today)

- [x] **75.** Banking primitives — `qb_deposit_*` / `qb_transfer_*` / `qb_check_*` (12 tools across 3 new files). Sim `computeTotals` extends Check.Amount + Deposit.DepositTotal derivation; `handleQuery` EntityFilter now matches `PayeeEntityRef`. _(Closed 2026-05-14.)_
- [x] **76.** Sales orders — `qb_sales_order_*` (5 tools) including `_convert_to_invoice` mirroring estimate convert. _(Closed 2026-05-15.)_
- [x] **77.** Sales tax workflows — `qb_sales_tax_code_list` / `_item_list` / `_agency_list` / `_liability_report` / `_payment_create` (5 tools). New `SalesTaxLiability` report branch + `SalesTaxPaymentCheck` wire type. _(Closed 2026-05-15. Sim simplification: header-level tax tracking only.)_
- [x] **78.** Time tracking — `qb_time_track_add` / `_list`. TimeTracking is transaction + non-posting; new `EntityRef`-first EntityFilter chain. `parseDurationToHours` exported helper. _(Closed 2026-05-14.)_
- [x] **79.** Vehicle mileage — `qb_vehicle_list` / `qb_vehicle_mileage_list` / `_add` (no _update — SDK has no `VehicleMileageModRq`). _(Closed 2026-05-16.)_
- [x] **80.** Inventory adjustments — `qb_inventory_adjustment_add` / `_list` / `_delete`. New `applyInventoryAdjustment` two-phase commit; AverageCost preserved when QuantityOnHand → 0. _(Closed 2026-05-15.)_
- [x] **81.** Statement charges — `qb_statement_charge_*` (4 tools). Structurally unique: no `*LineAdd` array — single-row at header. _(Closed 2026-05-16. Limitation: `ReceivePayment.AppliedToTxnAdd` doesn't walk StatementCharge store yet.)_

## Phase 18 — Engineering robustness

- [x] **82.** QB edition / version detection — `qb_host_query` over `HostQueryRq`. Lazy cached at manager; cleared on switchCompanyFile. Derived `edition` enum + `isEnterprise` / `isAccountant` flags. _(Closed 2026-05-12.)_
- [x] **83.** Persistent debug logging — `QB_DEBUG_QBXML=1` writes wire envelopes to `./logs/qbxml-YYYYMMDD.log` (configurable via `QB_DEBUG_LOG_PATH`). Hooks at `manager.sendRequest` chokepoint. Redacts VendorTaxIdent / SSN / BankAccountNumber / CreditCardNumber. _(Closed 2026-05-12.)_
- [x] **84.** Connection robustness — auto-reconnect on transient `QBXMLRP2` failures (`0x80040408` "QBSession not open"). Exponential backoff [250, 500, 1000ms] capped at 3 retries. SIGTERM/SIGINT graceful shutdown landed earlier with #1. _(Closed 2026-05-12. `isTransientLiveError` exported helper.)_
- [x] **85.** Closing date / year-end lock — `qb_closing_date_get` (read path) + `qb_closing_date_set` (informational stub). _(Closed 2026-05-12. SDK verification: write path doesn't exist at any qbXML version through 16.0. Read path wraps `PreferencesQueryRq` → `AccountingPreferences.ClosingDate`. Stub fails with synthetic statusCode **9005** plus 9-step QB Desktop UI navigation guide.)_
- [x] **86.** MCP prompts (workflow bundles) — register pre-canned workflow guides via the MCP `prompts` API alongside `tools`. _(Closed 2026-05-12. [src/prompts/workflows.ts](src/prompts/workflows.ts) — `/trial_balance_workup`, `/client_packet`, etc. Discoverable via MCP `prompts/list`.)_

---

## Phase 19 — Delivery and ease of use

The server is feature-complete; this phase makes it installable + usable by any operator, not just the original developer. Items are roughly ordered by cost-to-value.

- [x] **87.** Add `bin` entry to package.json so users can `npx quickbooks-desktop-mcp` once published. _(Closed 2026-05-23. Both binaries wired in one `package.json` touch — `quickbooks-desktop-mcp` → `dist/index.js`, `quickbooks-desktop-mcp-doctor` → `dist/cli/doctor.js`. `prepare: npm run build` script added so git-dep installs auto-build. Doctor binary lands as a stub that exits 2 with a "not yet implemented" message; full probes tracked under #91. Pre-req for #88 satisfied.)_

- [ ] **88.** Publish to npm. Decide scope (`@valentino/quickbooks-desktop-mcp` vs unscoped `quickbooks-desktop-mcp`); verify name availability; configure GitHub Actions for `npm publish` on tag. Enables MCP host config blocks like `"command": "npx", "args": ["-y", "quickbooks-desktop-mcp"]` rather than requiring `git clone` + `npm install` + absolute path to `dist/index.js`. Decision needed: public or private package?

- [x] **89.** One-page "5-minute install" section in README — config-block templates for Claude Desktop / Cursor / opencode / Windsurf / generic MCP host, with the full env-var matrix (`QB_COMPANY_FILE`, `QB_COMPANY_ROOT`, `QB_LIVE`, `QB_SIMULATION`, `QB_DEBUG_QBXML`, `QB_DEBUG_LOG_PATH`, `QB_APP_NAME`, `QB_APP_ID`). Include Windows vs non-Windows variants — non-Windows users get simulation mode out of the box. _(Closed 2026-05-23. New `## 5-minute install` section ([README.md](README.md) lines 25-145) — 6 subsections: prereqs, install paths, 5 host blocks (npx-first), live-mode env swap, env-var quick-ref table, smoke test. Setup section's duplicated host blocks collapsed to a pointer to keep the developer-mode local-clone variant. All blocks use `npx -y github:RealDealCPA-VR/Quickbooks-MCP-Desktop` so they work today on git-deps; updates to `npx -y quickbooks-desktop-mcp` once #88 publishes.)_

- [ ] **90.** Auto-launch QB Desktop on `qb_company_open` — extend the tool with `launchIfClosed: boolean` (default false; explicit opt-in). When true: if the wire layer reports the target file isn't open (currently observed as `BeginSession` failure with "file not loaded" message), spawn QB Desktop with the `.qbw` as a process arg (`"C:\Program Files (x86)\Intuit\QuickBooks Desktop\qbw32.exe" "<path-to-.qbw>"`), poll for QBXMLRP2 attach success (up to ~30s with exponential backoff), then retry `BeginSession`. Closes the operator's "ask about a different client's books" loop end-to-end without QB Desktop UI clicks. **Design questions before implementing:** (a) detect QB Desktop's actual executable path across editions/versions — registry lookup (`HKLM\SOFTWARE\Intuit\QuickBooks`) vs an env var override (`QB_DESKTOP_EXE`) vs a configurable fallback chain; (b) behavior when QB Desktop already has a DIFFERENT file open — QB serializes (one file per process), so the tool must close the current via UI automation or fail with a clear "close X first" message; (c) multi-user QB (the file is on a server and another user has it open) — surface the lock state; (d) what does sim mode do with `launchIfClosed: true` — no-op, the existing reseed path already covers the "open a new book" UX. Live-only feature; sim mode no-ops the launch step.

- [ ] **91.** CLI doctor command — `quickbooks-desktop-mcp-doctor` exits 0/1 after probing: Node version compatibility (winax requires v20.x; v22+ breaks), platform (Windows + WOW64 if 64-bit Node), QuickBooks Desktop installed (registry/Program Files lookup), QBXMLRP2 COM registration check (`regsvr32` query), `QB_COMPANY_FILE` set and exists, `QB_COMPANY_ROOT` set and exists, optional `winax` install status (npm rebuilt against current Node?). Each check emits `✓` / `✗` with remediation hint. Diagnoses ~80% of setup failures without the operator opening a debugger. Same exit-code contract `linter` / `test` use — CI-friendly. _(Bin entry + stub already shipped under #87 on 2026-05-23. Stub at [src/cli/doctor.ts](src/cli/doctor.ts) currently exits 2 with a "not yet implemented" message. Remaining work: flesh out probes + remediation hints + 0/1/2 exit codes.)_

- [ ] **92.** (Lower priority) Windows installer — bundle Node runtime + the built CLI into a signed `.exe` via `pkg` or `oclif`. Reach non-CLI users (accountants who would never type `npx`) without npm. Out of scope for first cut; revisit if there's actual non-developer demand. Signing certificate cost ($200-400/yr) is the gating non-technical decision, not the packaging itself.
