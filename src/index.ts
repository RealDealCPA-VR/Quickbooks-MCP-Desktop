#!/usr/bin/env node

/**
 * QuickBooks Desktop MCP Server
 *
 * A Model Context Protocol (MCP) server that provides comprehensive tools
 * for managing client books in QuickBooks Desktop. Communicates with
 * QuickBooks via the QBXML SDK protocol over the session manager.
 *
 * Capabilities:
 * - Customer management (CRUD)
 * - Vendor management (CRUD)
 * - Chart of Accounts management
 * - Invoice management (create, query, update, delete)
 * - Bill / Accounts Payable management
 * - Item / Product & Service management
 * - Payment recording
 * - Estimate / Quote management
 * - Purchase Order management (vendor-side, non-posting)
 * - Journal Entry management (debit/credit balanced GL postings)
 * - Employee management
 * - Financial reporting (AR/AP aging, balance summaries, P&L, Balance Sheet)
 * - Raw QBXML query access for advanced operations
 * - Session lifecycle management
 *
 * Connection modes:
 * - Live: Communicates with QuickBooks Desktop via QBXMLRP2 (Windows only)
 * - Simulation: In-memory mock data for development/testing (any platform)
 *
 * Environment variables:
 *   QB_COMPANY_FILE  - Path to the .qbw company file (default: simulation)
 *   QB_APP_NAME      - Application name for QB registration (default: "MCP QuickBooks Manager")
 *   QB_APP_ID        - Application ID (optional)
 *   QB_SIMULATION    - Force simulation mode (default: true on non-Windows)
 *   QB_LIVE          - Set to "1" to attempt live connection on Windows
 *   QB_DEBUG_QBXML   - Set to "1" to mirror every QBXML envelope + raw response
 *                      to a rotating per-day file. Diagnoses schema-order
 *                      parse errors (statusCode -1) and any future wire-level
 *                      issue without rebuild + console.error.
 *   QB_DEBUG_LOG_PATH - Directory the debug log writes into. Default `./logs`.
 *                       File name is always `qbxml-YYYYMMDD.log`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { QBSessionManager } from "./session/manager.js";
import type { QBConnectionConfig } from "./types/qbxml.js";

import { registerCustomerTools } from "./tools/customers.js";
import { registerVendorTools } from "./tools/vendors.js";
import { registerAccountTools } from "./tools/accounts.js";
import { registerInvoiceTools } from "./tools/invoices.js";
import { registerBillTools } from "./tools/bills.js";
import { registerItemTools } from "./tools/items.js";
import { registerPaymentTools } from "./tools/payments.js";
import { registerEstimateTools } from "./tools/estimates.js";
import { registerSalesReceiptTools } from "./tools/sales-receipts.js";
import { registerCreditMemoTools } from "./tools/credit-memos.js";
import { registerPurchaseOrderTools } from "./tools/purchase-orders.js";
import { registerJournalEntryTools } from "./tools/journal-entries.js";
import { registerEmployeeTools } from "./tools/employees.js";
import { registerListTools } from "./tools/lists.js";
import { registerReportTools } from "./tools/reports.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { registerForm1099Tools } from "./tools/form-1099.js";
import { registerReconciliationTools } from "./tools/reconciliation.js";
import { registerAttachmentTools } from "./tools/attachments.js";
import { registerPreferenceTools } from "./tools/preferences.js";
import { registerDepositTools } from "./tools/deposits.js";
import { registerCheckTools } from "./tools/checks.js";
import { registerTransferTools } from "./tools/transfers.js";
import { registerClientPacketTools } from "./tools/client-packet.js";
import { registerWorkflowPrompts } from "./prompts/workflows.js";
import { getQbxmlLogger } from "./util/qbxml-logger.js";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const config: QBConnectionConfig = {
  // Empty string means "use whatever company file is currently open in QB
  // Desktop" (QBXMLRP2.BeginSession contract). Better default for an
  // interactive tool than a phantom Sample Company.qbw path that may not
  // exist on this machine.
  companyFile: process.env.QB_COMPANY_FILE ?? "",
  appName: process.env.QB_APP_NAME ?? "MCP QuickBooks Manager",
  appId: process.env.QB_APP_ID,
  qbxmlVersion: process.env.QB_QBXML_VERSION ?? "16.0",
  connectionMode: (process.env.QB_CONNECTION_MODE as "localOnly" | "remoteOnly" | "optimistic") ?? "optimistic",
};

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer(
  {
    name: "quickbooks-desktop",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
      logging: {},
    },
    instructions: [
      "QuickBooks Desktop MCP Server — manages client books via the QBXML SDK.",
      "",
      "Available tool categories:",
      "  • qb_customer_*    — Customer CRUD (list, add, update, delete)",
      "  • qb_vendor_*      — Vendor CRUD (list, add, update, delete)",
      "  • qb_account_*     — Chart of Accounts (list, add, update, make_inactive, delete) — qb_account_make_inactive flips IsActive to false (preferred — preserves history; account hides from the default list view but stays referenceable). qb_account_delete is a hard delete that real QB rejects (statusCode 3260/3170) for accounts with transaction history; use only for empty accounts created in error.",
      "  • qb_invoice_*     — Invoice management (list, create, batch_create, update, delete, duplicate, write_off) — qb_invoice_update takes txnId + editSequence (from a prior list); passing `lines` REPLACES the invoice's line set wholesale (lines with a matching txnLineID are merged; lines you don't list are dropped). Subtotal / BalanceRemaining / IsPaid recompute automatically; AppliedAmount is preserved (so dropping a line below the applied amount produces a negative BalanceRemaining = over-application). Customer balance moves by the change in BalanceRemaining. A stale editSequence rejects with statusCode 3170. qb_invoice_batch_create posts up to 100 invoices atomically in one envelope (onError=stopOnError) — each entry takes the same shape as qb_invoice_create. Upfront customer-ref validation rejects the whole batch before any wire I/O on a missing customerName/customerListId; mid-wire failures trigger automatic compensating delete of any prior-posted invoices (rolled-back), with Customer.Balance reversals handled by the underlying handleTxnDel. Per-entry status: 'posted' / 'rolled-back' / 'orphaned' (rollback delete itself failed — operator cleans up via qb_invoice_delete) / 'failed' / 'skipped'. Use for monthly retainer billing, recurring subscription invoicing, end-of-month time-and-materials runs. qb_invoice_duplicate reads a source invoice via sourceTxnId, carries CustomerRef + lines (and optional ClassRef / TermsRef / SalesRepRef / PORefNumber) onto a fresh InvoiceAddRq, and applies operator-supplied txnDate / dueDate / refNumber / memo / customerName / customerListId overrides — workflow stand-in for QB Desktop's memorized-template 'Use' command (which the QBXML SDK doesn't expose). Default carry policy: TxnDate → today, DueDate / RefNumber → unset (avoids ref-number collisions on monthly retainer flows), Memo → 'Duplicate of <source ref or TxnID>'. Composite tool — uses existing invoice query + add primitives, no new wire types. qb_invoice_write_off closes an open invoice in one atomic call without collecting payment — submits a $0 ReceivePayment whose AppliedToTxnAdd carries DiscountAmount = the write-off amount (default = the invoice's full BalanceRemaining; pass `amount` for a partial) posting to writeOffAccount (e.g. 'Bad Debt'). The invoice's BalanceRemaining drops, IsPaid flips on full write-off, the customer's open AR drops by the written-off amount, and the write-off posts to the named P&L account. Same mechanism as QB Desktop's 'Discounts and Credits' dialog on Receive Payments.",
      "  • qb_bill_*        — Bill/AP management (list, create, update, delete, duplicate, pay, payment_list) — qb_bill_create requires at least one of expenseLines or itemLines; AmountDue = sum of all line amounts. qb_bill_update takes txnId + editSequence (from a prior list); passing expenseLines / itemLines REPLACES the bill's line set wholesale (lines with a matching txnLineID are merged; lines you don't list are dropped). A stale editSequence rejects with statusCode 3170. qb_bill_duplicate is the AP mirror of qb_invoice_duplicate — reads a source bill via sourceTxnId (with IncludeLineItems opt-in), carries VendorRef + ExpenseLineRet + ItemLineRet onto a fresh BillAddRq, and applies operator-supplied txnDate / dueDate / refNumber / memo / vendorName / vendorListId overrides. Default carry policy: TxnDate → today, DueDate / RefNumber → unset, Memo → 'Duplicate of <source ref or TxnID>'. qb_bill_pay records a BillPaymentCheck or BillPaymentCreditCard (paymentMethod: 'check' | 'creditcard') against one or more open bills via applyTo: [{txnId, amount, discountAmount?, discountAccountName?}]; each entry reduces the named bill's AmountDue, flips IsPaid when AmountDue hits zero, and decrements vendor Balance by the applied sum. applyTo is required and non-empty; unknown bill TxnID rejects atomically (no partial mutations). qb_bill_payment_list fans across both BillPaymentCheck and BillPaymentCreditCard stores by default — pass paymentType to scope.",
      "  • qb_item_*        — Product & Service items (list, add, update, delete) — itemType is one of Service / Inventory / NonInventory / OtherCharge / Group; required on add/update/delete, optional on list",
      "  • qb_payment_*     — Payment recording, application, queries — qb_payment_receive accepts optional appliedTo: [{txnId, amount, discountAmount?, discountAccountName?}] to close out invoices on creation (without appliedTo the payment is recorded as a customer credit). qb_payment_apply re-targets an EXISTING payment to a different invoice set via txnId + editSequence (from a prior qb_payment_list) plus a replacement applyTo array — the prior application is reversed and the new one applied atomically, customer balance moves by the delta. Pass applyTo: [] to fully unapply. TotalAmount is immutable on this path; stale editSequence rejects with 3170.",
      "  • qb_estimate_*    — Estimate/quote management (list, create, update, delete, convert_to_invoice). qb_estimate_create accepts a `lines` array (same shape as qb_invoice_create) and the simulation derives Subtotal from the line set. qb_estimate_update mirrors qb_invoice_update — pass txnId + editSequence (from a prior list) plus any header fields and/or replacement `lines`; passing `lines` REPLACES the line set wholesale and Subtotal recomputes (estimates have no AR balance side-effect). qb_estimate_convert_to_invoice reads the source estimate, submits an InvoiceAddRq with CustomerRef + carried lines, and (default) marks the estimate IsAccepted=true; pass markAccepted: false to leave it unmarked. The mark-accepted step runs after the invoice is created, so the new invoice is preserved even if the flip fails (rare — surfaced via markAcceptedError in the response).",
      "  • qb_sales_receipt_*— Sales receipt (cash sale) management (list, create, batch_create, update, delete, duplicate). Cash-sale equivalent of an invoice — sale settles instantly, no AR balance, no payment application. Funds post to depositToAccountName (typically 'Undeposited Funds' or a bank account); paymentMethodName documents how the customer paid. qb_sales_receipt_create accepts a `lines` array (same shape as qb_invoice_create); Subtotal derives from the line set and TotalAmount = Subtotal + SalesTaxTotal. qb_sales_receipt_batch_create posts up to 100 cash-sale receipts atomically in one envelope (same shape as qb_invoice_batch_create — upfront customer-ref validation, stopOnError envelope, compensating delete on mid-batch failure, per-entry status enum). Cash-sale rollback is structurally simpler than invoice rollback (no AR-balance reversal — cash sales don't post to AR). Use for point-of-sale day-end reconciliation, batch import of online-sale receipts, fundraiser bulk entry. qb_sales_receipt_update takes txnId + editSequence (from a prior list); passing `lines` REPLACES the line set wholesale and Subtotal/TotalAmount recompute. There is no BalanceRemaining or IsPaid (the receipt is closed on creation) and no customer-balance side effect (cash sales don't post to AR). Stale editSequence rejects with 3170. qb_sales_receipt_duplicate mirrors qb_invoice_duplicate — reads a source receipt via sourceTxnId (with IncludeLineItems opt-in), carries CustomerRef + PaymentMethodRef + DepositToAccountRef + lines onto a fresh SalesReceiptAddRq, and applies operator overrides (txnDate / refNumber / memo / customerName / customerListId / paymentMethodName / depositToAccountName). Default carry policy: TxnDate → today, RefNumber → unset, Memo → 'Duplicate of <source ref or TxnID>'.",
      "  • qb_credit_memo_* — Credit memo management (list, create, update, apply, delete). AR-negative analog of an invoice — same line shape, but TotalAmount credits the customer instead of billing them. On creation customer.Balance moves by -TotalAmount; RemainingValue = TotalAmount − AppliedAmount tracks the unapplied credit pool. qb_credit_memo_create accepts `lines` (Subtotal + TotalAmount derive from the set) and an optional `appliedTo: [{txnId, amount}]` to immediately close out part or all of one or more open invoices on creation; sum(amount) ≤ TotalAmount, unknown invoice TxnID rejects atomically. qb_credit_memo_update mirrors qb_invoice_update for header/line edits — passing `lines` REPLACES the line set wholesale, Subtotal/TotalAmount recompute, and customer balance moves by -(newTotal − oldTotal) (memo grew → customer balance drops further). qb_credit_memo_apply re-targets an EXISTING memo to a different invoice set via txnId + editSequence + replacement applyTo array; the prior application is reversed and the new one applied atomically without further customer-balance movement (the credit pool just shifts to invoice-level). Pass applyTo: [] to fully unapply. TotalAmount is immutable on this path; stale editSequence rejects with 3170.",
      "  • qb_purchase_order_* — Purchase order management (list, create, update, delete). Vendor-side analog of Estimate — a non-posting commitment to buy from a vendor. Does NOT touch Vendor.Balance / AP (that only moves when items are received against the PO via a bill). Lines use Cost (not Rate); each line's Amount = Quantity * Cost is computed at the tool layer. qb_purchase_order_create requires at least one line; TotalAmount = sum(line amounts) — POs have no separate Subtotal header. qb_purchase_order_update mirrors qb_invoice_update for header/line edits — passing `lines` REPLACES the line set wholesale and TotalAmount recomputes; no vendor-balance side effect on either header or line changes. isManuallyClosed: true on create or update marks the PO closed regardless of receipt activity (typical workflow: cancel a PO that won't be received). Stale editSequence rejects with 3170.",
      "  • qb_journal_entry_* — Journal entry management (list, create, batch_create, update, delete, duplicate). Two-sided GL posting — every entry carries a `debits` array AND a `credits` array, each line naming a GL account by full name. The hard invariant is sum(debits.amount) === sum(credits.amount) to the cent — unbalanced entries reject with statusCode 3030 (validated before persist on both create and update). qb_journal_entry_create requires at least one line on each side. qb_journal_entry_batch_create posts up to 100 entries atomically in one envelope (onError=stopOnError) — upfront balance validation rejects the whole batch on any unbalanced entry before any wire I/O; mid-wire failures trigger automatic compensating delete of any prior-posted JEs (rolled-back), surfaced explicitly as 'orphaned' if a rollback delete itself fails so the operator can clean up via qb_journal_entry_delete. qb_journal_entry_update takes txnId + editSequence; passing `debits` or `credits` REPLACES that side wholesale (lines with a matching txnLineID are merged, lines you don't list are dropped) and the post-mod sums must still balance. Each line accepts an optional entityName (Customer/Vendor/Employee/OtherName) — recorded faithfully but does NOT move that entity's open balance in this server's first cut (real QB moves AR/AP per-line; that bookkeeping is deferred). Stale editSequence rejects with 3170. qb_journal_entry_duplicate mirrors qb_invoice_duplicate for recurring monthly accruals / prepaid amortization / standing entries — reads source JE via sourceTxnId (with IncludeLineItems opt-in), carries both line sides verbatim (preserving the sum-balance invariant by construction) plus IsAdjustment, applies operator overrides (txnDate / refNumber / memo / isAdjustment). Per-line EntityRef and ClassRef carry through. Default carry policy: TxnDate → today, RefNumber → unset, Memo → 'Duplicate of <source ref or TxnID>'.",
      "  • qb_employee_*    — Employee management (list, add, update, make_inactive, delete) — qb_employee_make_inactive flips IsActive to false (preferred — preserves history; employee hides from the default list view but stays referenceable by historical paychecks/timesheets). qb_employee_delete is a hard delete that real QB rejects (statusCode 3260/3170) for employees with any transaction history; use only for empty employee records created in error.",
      "  • qb_class_list / qb_terms_list / qb_payment_method_list / qb_sales_rep_list / qb_customer_type_list / qb_vendor_type_list — Reference lists (read-only). Used to discover valid FullName values that transactions reference (Class on lines, Terms on invoice/bill headers, PaymentMethod on receive-payments, SalesRep/CustomerType/VendorType for segmentation). qb_terms_list fans across both StandardTerms and DateDrivenTerms by default — pass termsType to scope.",
      "  • qb_transaction_list_by_account — Cross-type posting list (TransactionQueryRq) — every line that hit a specific GL account, optionally bounded by date, sorted by TxnDate ascending with RunningBalance computed in the tool layer (current = opening + Σ period postings; opening = Account.Balance − periodSum, exact when toDate ≥ now). Sign convention: positive = increases the target account's natural balance. Sim emits LINE-LEVEL postings only (Bill/Check expense+item lines, Invoice/SR/CreditMemo income lines via item resolution, JE debit+credit lines); implicit AR/AP/Bank counter-postings are not surfaced — live QB returns full posting detail.",
      "  • qb_deposit_* / qb_check_* / qb_transfer_* — Banking primitives (Phase 17 #75). qb_deposit_create records funds arriving in a bank account from one or more sources (DepositLineAdd lines, each naming an EntityRef + AccountRef + Amount); pair with qb_payment_receive when closing AR via Undeposited Funds, or post directly to an income/equity account for ad-hoc cash. qb_check_create writes a check drawn against AccountRef (a Bank account) optionally to a PayeeEntityRef (Vendor/Customer/Employee/OtherName); posts against GL via expense or item lines. For paying an EXISTING bill use qb_bill_pay instead — that's BillPaymentCheckRq, different transaction type that reduces AmountDue and vendor balance. qb_transfer_create moves funds between two balance-sheet accounts (Bank-to-Bank, Bank-to-CC, Equity-to-Bank, etc.) — both refs required and must be different (self-transfer rejects with 3120). All three default to ClearedStatus: NotCleared (flip via qb_cleared_status_update). All three support: txnId/date-range/refNumber list filters with paginate (maxReturned defaults to 500 on paginate:true); txnId + editSequence update with line REPLACEMENT for check/deposit (mirrors qb_bill_update / qb_invoice_update — stale editSequence → 3170, Check.Amount and Deposit.DepositTotal re-derive from line sums on mod); idempotencyKey on create (replay → idempotentReplay:true, key+different-payload → 9002). Read-only sessions reject create/update/delete with 9001. Inventory site transfers (Enterprise-only TransferInventoryAddRq) are intentionally NOT exposed by qb_transfer_create — they belong under Phase 17 #80 inventory adjustments.",
      "  • qb_cleared_status_update / qb_uncleared_transactions / qb_reconciliation_discrepancy — Bank reconciliation. qb_cleared_status_update wraps ClearedStatusModRq — marks one bank/CC transaction Cleared / NotCleared / Pending. Targets the seven bank-affecting types only (Check, BillPaymentCheck, BillPaymentCreditCard, Deposit, Transfer, CreditCardCharge, CreditCardCredit); calls against Invoice/Bill/JE/etc. return 3120. Pass txnId for whole-transaction update; add txnLineId for a single split line. Naturally idempotent — no idempotencyKey arg. Read-only sessions reject with 9001. qb_uncleared_transactions wraps CustomDetailReportQueryRq — lists txns with ClearedStatus !== Cleared scoped to one bank/CC account (accountName | accountListId), with optional asOfDate (default today) and clearedStatusFilter (UnclearedOnly | ClearedOnly | All; default UnclearedOnly = NotCleared+Pending). Sign convention on amount: positive = increases account natural balance (Deposit, CreditCardCharge), negative = decreases (Check, BillPaymentCheck). qb_reconciliation_discrepancy uses the same infrastructure with ClearedStatusFilter=ClearedOnly + ReportModifiedDateRangeFilter to surface currently-Cleared txns modified since sinceDate (default 30 days back) — the classic 'someone broke a prior reconciliation' signal. Workflow: at month-end, list uncleared → mark each Cleared as it matches the statement → run the discrepancy check before signing off. Postings to QB's auto-created 'Reconciliation Discrepancies' expense account are NOT bundled into qb_reconciliation_discrepancy — query that via qb_transaction_list_by_account directly. All three tools are read+write composable.",
      "  • qb_1099_summary / qb_1099_detail — January 1099 prep. qb_1099_summary aggregates Bill + Check payments to vendors flagged IsVendorEligibleFor1099=true across a tax-year window (default = last completed year), classifies by 1099-NEC (default — nonemployee compensation) or 1099-MISC (Vendor1099Type='MISC'), compares per-vendor totals against the IRS general $600 threshold (override via threshold arg), and returns sorted-desc vendor rows with taxId / address / totalPaid / transactionCount / meetsThreshold. qb_1099_detail returns the same scope as a per-transaction breakdown (each Bill / Check with txnId / txnDate / refNumber / total / memo / lines) — use to verify the summary, drill into a specific vendor (vendorListId / vendorFullName), or export to a 1099 prep spreadsheet. Card payments are excluded per IRS Form 1099 instructions (the processor reports those on 1099-K). Aggregation does NOT honor QB Preferences' per-account 1099 box mapping (every payment to an eligible vendor counts) — for strict box-by-box reporting use real QB's Form1099 wizard.",
      "  • qb_balance_summary / qb_trial_balance_export / qb_tax_line_mapping / qb_ar_aging / qb_ap_aging / qb_pnl_report / qb_balance_sheet_report / qb_statement_of_cash_flows / qb_general_ledger / qb_sales_by_customer_summary / qb_sales_by_customer_detail / qb_sales_by_item_summary / qb_sales_by_item_detail / qb_expense_by_vendor_summary / qb_expense_by_vendor_detail / qb_customer_balance_detail / qb_vendor_balance_detail — Financial reports. qb_tax_line_mapping is the bridge from QB's chart of accounts to a tax-prep workpaper — returns each posting account's tax-line assignment (Sch C / Sch L / 1120-S / 1065 / etc.) from Account.TaxLineInfoRet so the preparer can group accounts by tax-line code without rebuilding the mapping by hand. Same shape qb_trial_balance_export's `taxLine` column reads from. Defaults to active mapped accounts only; pass includeUnmapped:true to surface accounts missing a tax-line assignment (a workpaper-prep audit). Scope by accountListId / accountName / accountType. qb_trial_balance_export returns a tax-season-workpaper-shaped TB — one row per posting account with non-zero balance, debits/credits split by natural-balance side (Asset/Expense → debit column; Liability/Equity/Income → credit column; contra-balances flip column rather than going negative), sorted by canonical AccountType → AccountNumber → name. Each row: accountListId / accountName / accountNumber / accountType / taxLine (from Account.TaxLineInfoRet.TaxLineName, populated by live QB and by sim seed for the mapped accounts) / debitBalance / creditBalance / isActive / lastActivityDate (null unless includeLastActivityDate:true). Four cross-checks: balanceSheet (Assets ≡ Liab+Equity), netIncome (P&L NetIncome ≡ BS NetIncome), arReconciliation (AR account balance ≡ AR aging total), apReconciliation (AP account balance ≡ AP aging total) — cent-tolerance; any mismatch is an audit signal. NonPosting accounts excluded (use qb_balance_summary). includeInactive / includeZeroBalances default false (workpaper convention). includeLastActivityDate:true triggers a per-account TransactionQueryRq fanout (N+5 round trips); default false keeps the bare call cheap (5 wire calls). qb_pnl_report walks Invoice/SalesReceipt/CreditMemo (income) and Bill/Check/CreditCardCharge plus JournalEntry (expense) lines filtered by TxnDate ∈ [fromDate, toDate], aggregates by GL account → AccountType, returns canonical-ordered sections (Income → Other Income → COGS → Expenses → Other Expenses) plus TotalIncome / TotalCOGS / TotalExpenses / GrossProfit / NetIncome. qb_balance_sheet_report returns Assets / Liabilities / Equity sections from Account.Balance (snapshot — asOfDate is advisory for those sections in simulation), with current-period NetIncome (lifetime → asOfDate) closed into Equity; the accounting identity Assets = Liabilities + Equity is reconciled by closing the simulation seed gap into a 'Balancing Adjustment' row when present. qb_balance_summary is a flattened view of both: AS/LI/EQ figures are sourced from BalanceSheetStandard (toDate=asOfDate), INC/EXP from ProfitAndLossStandard (lifetime through asOfDate), then bucketed back into the 16-way canonical AccountType order via a name→type lookup. NonPosting accounts (estimates/POs) fall back to Account.Balance (they don't post to GL). qb_general_ledger is the multi-account version of qb_transaction_list_by_account — for every GL-affecting account (or the subset selected by accountName / accountListId / accountType), returns one section per account with every line-level posting in the window sorted by TxnDate ascending, per-row RunningBalance, plus opening/closing balance and periodChange. Composite of TransactionQueryRq — N round trips for N matching accounts in live mode, so scope via accountType ('Expense', 'Income', 'Bank') for large charts. NonPosting accounts are always excluded unless explicitly named. Empty sections (zero postings in window) are pruned by default; pass includeEmpty:true to keep them. qb_sales_by_customer_summary wraps GeneralSummaryReportQueryRq with ReportType=SalesByCustomerSummary — per-customer revenue rollup over a date window (Invoice + SalesReceipt − CreditMemo line totals grouped by CustomerRef.FullName), returns customers sorted desc by total plus grand TotalSales. Scope to one customer via customerName / customerListId (server-side ReportEntityFilter). qb_sales_by_customer_detail wraps GeneralDetailReportQueryRq with ReportType=SalesByCustomerDetail — per-line transaction detail sorted by Customer → TxnDate → TxnID with columns TxnType / Date / Num / Name / Memo / Item / Quantity / Rate / Account / Amount / TxnID. CreditMemo rows emit with negative Amount so the running sum matches QB. qb_sales_by_item_summary mirrors qb_sales_by_customer_summary but groups by line.ItemRef.FullName — lines without an ItemRef drop (no item to key under). Scope via itemName / itemListId (server-side ReportItemFilter). qb_sales_by_item_detail mirrors qb_sales_by_customer_detail with rows sorted by Item → TxnDate → TxnID. qb_expense_by_vendor_summary walks Bill (VendorRef) + Check (PayeeEntityRef) + CreditCardCharge (PayeeEntityRef) ExpenseLineRet + ItemLineRet, sums line.Amount by vendor name, returns vendors sorted desc by total plus grand TotalExpenses. Caveat: sim doesn't filter by underlying account's AccountType (matches the #49 simplification — a Check posting to a Fixed Asset account still counts here). Real QB's report scopes to Expense/COGS/OtherExpense; in live mode that filter is applied by QB. qb_expense_by_vendor_detail returns the per-line breakdown sorted by Vendor → TxnDate → TxnID (Account fallback 'Uncategorized Expense' when an item carries no ExpenseAccountRef). qb_customer_balance_detail is the AR analog of qb_general_ledger — for every customer with AR activity in the date window (or the single customer selected by customerName / customerListId), lists every Invoice / ReceivePayment / CreditMemo that hit their AR balance, sorted by TxnDate ascending, with per-row RunningBalance plus per-customer OpeningBalance / ClosingBalance / periodChange. Composite of InvoiceQueryRq + ReceivePaymentQueryRq + CreditMemoQueryRq (three round trips regardless of customer count) — not a per-customer fanout. Sign convention: positive Amount = increases AR (Invoice posts the full Subtotal + SalesTaxTotal); negative = decreases AR (ReceivePayment.TotalAmount, CreditMemo.TotalAmount). JournalEntry postings to the AR account are not walked (JE lines don't carry customer ref reliably in sim — query the AR account directly via qb_transaction_list_by_account). qb_statement_of_cash_flows wraps GeneralSummaryReportQueryRq with ReportType=StatementOfCashFlows (indirect method) — returns Operating Activities / Investing Activities / Financing Activities sections plus NetCashIncrease / CashAtBeginningOfPeriod / CashAtEndOfPeriod totals. Sim mode uses a narrower indirect-method model than real QB: Operating section walks NetIncome + ΔAR + ΔAP only; Investing walks period postings to FixedAsset + OtherAsset; Financing walks period postings to LongTermLiability + Equity. CashAtBeginningOfPeriod is derived (CashAtEnd − NetCashIncrease) in sim. For accurate cash-flow numbers run live. qb_vendor_balance_detail is the AP mirror — walks Bill + BillPaymentCheck + BillPaymentCreditCard per vendor. Bill posts its ORIGINAL face value via ExpenseLineRet + ItemLineRet sum (Bill.AmountDue is decremented on payment so a fully-paid bill still shows full face); BillPayment* posts TotalAmount. Empty sections (no activity AND zero closing balance) are pruned by default — set includeZeroBalance:true to keep them. Live adapter for all detail reports uses the same row-tree translator as CustomDetailReport — verified-by-construction structurally but not yet live-validated against a real QB Desktop. All report tools accept basis: 'Accrual' | 'Cash' (currently identical in simulation).",
      "  • qb_w2_summary    — Per-employee W-2 prep via PayrollSummaryReportQueryRq. Maps YTD payroll totals onto W-2 box numbers (box 1 wages tips other comp, box 2 federal income tax withheld, box 3-6 SS/Medicare, box 16-17 state when present). Defaults taxYear to last completed year; scope via employeeFullName / employeeListId. Pre-flight edition probe rejects Pro builds (without Plus) with statusCode 9003; empty-result rejects with 9004 (payroll subscription required or not active — distinguishes 'subscription off' from 'no matching employees'). SSN masked to last 4 ('XXX-XX-1234'). Subject to payroll-subscription availability; the SDK exposes payroll data only when the operator's QB has an active subscription.",
      "  • qb_attachment_*  — File attachments (AttachableAdd / AttachableQuery / AttachableDel). qb_attachment_add attaches a local file (vendor receipt, deposit slip, signed invoice, customer W-9) to an existing transaction (txnId) or list entity (listId — Customer / Vendor / Item / etc.). Absolute path required; file must exist on the QB Desktop host. Optional note + showAsImage flag. Returns the new Attachable's ListID + derived FileName / FileSize / FileExtension. qb_attachment_list filters by txnId (every attachment on the txn), targetListId (every attachment on the list entity), or attachableListId (single attachment by own ListID) — pass at most one. qb_attachment_delete removes the metadata record (real QB also removes the underlying file from its Attached Documents folder); inputs the attachableListId from add/list. Read-only sessions gate add/delete (9001). Subject to QB edition support for Attached Documents — wire failures surface with humanReadable.",
      "  • qb_company_info  — Connection & company info",
      "  • qb_host_query    — QB Desktop installation metadata (HostQueryRq) — productName / majorVersion / supportedQbxmlVersions / isAutomaticLogin / qbFileMode plus derived `edition` (Pro | Premier | PremierAccountant | Enterprise | EnterpriseAccountant | Unknown) + `isEnterprise` / `isAccountant` flags. Use `edition` to gate edition-specific features; payroll subscription is NOT derivable here. Cached at the session manager — pass refresh:true to force a re-query.",
      "  • qb_closing_date_get / qb_closing_date_set — Year-end-lock / closing-date state. qb_closing_date_get wraps PreferencesQueryRq — returns the company file's closing date (ISO YYYY-MM-DD, or null when unset) plus adjacent AccountingPreferences flags (isUsingAuditTrail, isUsingClassTracking, isUsingAccountNumbers, isRequiringAccounts). The qbXML SDK does NOT surface the closing-date password status at any version — this tool can only tell you whether a closing date exists, not whether it's password-protected. qb_closing_date_set is an INFORMATIONAL stub — the qbXML SDK has no write path for company preferences (PreferencesModRq / AccountingPreferencesModRq do not exist in the schema at any version through 16.0). It always fails with statusCode 9005 and returns explicit QB Desktop UI navigation steps (Edit → Preferences → Accounting → Company Preferences → Set Date/Password) so an agent thinking 'set the closing date' routes the user correctly instead of hallucinating a non-existent mutation.",
      "  • qb_client_packet — Tax-prep workpaper bundle (Phase 15 #71). Single composite call that rolls up Trial Balance + General Ledger + bank reconciliation drift + Payroll Summary (W-2 boxes) + Fixed Asset detail across one tax year (Jan 1 → Dec 31 of `taxYear`). Replaces the 5-7 separate tool calls a CPA fires at the start of every client return — the workflow run ~2,000 times per tax season. Pure composite over existing session primitives (queryEntity / queryTransactions / runReport / runCustomDetailReport / runPayrollSummaryReport / getHostInfo) — no new wire types. Each section is FAIL-SOFT: a single section's failure lands in `sections.<name>.error` with the `sectionStatus.<name>` flipping to 'error' or 'skipped', and the rest of the packet still returns. Only the initial AccountQueryRq failure fails the whole tool. GL fanout defaults to P&L-only scope (Income / Expense / COGS / OtherIncome / OtherExpense — the typical tax-prep ask); pass `glScope: 'AllAccounts'` for every GL-eligible account. Bank rec discrepancy fans out across every Bank + CreditCard account; per-account errors land in that account's entry without poisoning the others. Payroll has three skip states: edition === Pro → 9003, wire returns zero rows → 9004 (subscription likely inactive or no YTD activity), probe itself fails → error block. Fixed Asset detail returns per-account current Balance + opening/closing + every posting in the tax year (Form 4562 input). Optional `customerListId` / `customerName` surfaces the customer as a label header — does NOT filter the underlying reports (the .qbw file IS the client). Section toggles (`includeTrialBalance` / `includeGeneralLedger` / `includeBankReconDiscrepancy` / `includePayrollSummary` / `includeFixedAssetDetail`) all default true.",
      "  • qb_company_open  — Switch the active QuickBooks company file mid-session. Closes the current session, swaps the configured `.qbw` path, and opens a new session against the new file. Live mode requires QB Desktop to have the target file open (QBXMLRP2 cannot open a file QB hasn't loaded). Simulation mode resets the in-memory store to fresh seed — real QB persists per-file, sim doesn't, so without the reseed the operator would see entities from the prior company on the 'new' one (deliberate sim-fidelity tradeoff per DECISIONS.md 2026-05-09). Use qb_company_list first to discover available `.qbw` paths.",
      "  • qb_company_list  — List `.qbw` company files under $QB_COMPANY_ROOT (fallback: dirname($QB_COMPANY_FILE), or pass `root` arg). Pure filesystem op — identical in live and simulation. Returns [{companyFile, displayName, sizeBytes, modifiedAt}] sorted by modifiedAt desc. Pair with qb_company_open: the returned `companyFile` paths are valid input.",
      "  • qb_raw_query     — Direct QBXML queries for advanced use",
      "  • qb_session_*     — Session connect/disconnect/status. qb_session_connect accepts an optional readOnly:true flag that gates every mutation (*_add / *_update / *_delete / *_apply / *_pay / *_make_inactive / *_convert_to_invoice / batch_create) — those tools fail-fast with statusCode 9001 BEFORE any QBXML envelope is built. Reads (queries, reports, qb_raw_query) and qb_company_open / qb_company_list are unaffected. The flag toggles immediately on call (safe to flip mid-conversation without disconnecting); a fresh qb_session_connect() with no readOnly arg defaults to writable. qb_company_info surfaces the current readOnly state. qb_session_status returns a diagnostic snapshot — connection state, configured app identity (appName, appId, qbxmlVersion), readOnly gate, cached HostInfo (null when not yet fetched — never triggers a fetch), rolling transient-retry observability (lastTransientRetryAt / transientRetryCountLastHour / totalTransientRetries from #84's auto-reconnect path), and server version. Zero wire I/O by default. Pass probe:true to actively verify the live wire via a fresh HostQueryRq round trip (lightest available real call); probe result lands under `probe: {ok}` — fail-soft so the snapshot itself never returns isError. Pass includeClosingDate:true to fold PreferencesQueryRq into the snapshot under `closingDate`. Use this from orchestration callers retrying brittle workflows: a non-zero transientRetryCountLastHour means QB Desktop has been stalling recently and a longer backoff may be warranted.",
      "",
      "Idempotency keys: every *_create / *_add tool (qb_customer_add, qb_vendor_add, qb_account_add, qb_employee_add, qb_item_add, qb_invoice_create, qb_invoice_batch_create, qb_invoice_duplicate, qb_invoice_write_off, qb_bill_create, qb_bill_duplicate, qb_bill_pay, qb_payment_receive, qb_estimate_create, qb_estimate_convert_to_invoice, qb_sales_receipt_create, qb_sales_receipt_batch_create, qb_sales_receipt_duplicate, qb_credit_memo_create, qb_purchase_order_create, qb_journal_entry_create, qb_journal_entry_duplicate, qb_journal_entry_batch_create, qb_attachment_add, qb_deposit_create, qb_check_create, qb_transfer_create) accepts an optional idempotencyKey:string arg. Retrying with the same key + same payload returns the original result instead of duplicating the QB record (the response carries idempotentReplay:true). Same key + different payload returns statusCode 9002 — use a fresh key for new requests. The cache is in-memory, scoped per company file, and resets on qb_company_open. Failed creates are NOT cached (next retry can fix the underlying problem). For batch tools (qb_invoice_batch_create / qb_sales_receipt_batch_create / qb_journal_entry_batch_create) the key fingerprints the entire entries list and only fully-successful batches are cached.",
      "",
      "Workflow prompts (MCP prompts API, surfaced as slash-commands in the host app):",
      "  • /month_end_close           — full month-end-close checklist (bank/CC rec → P&L review → AR/AP aging → BS reconcile → SCF). Defaults to prior calendar month.",
      "  • /credit_card_qb_batch      — bulk-categorize a CC statement into atomic qb_journal_entry_batch_create. Bridges the operator's `credit-card-qb-batch` skill.",
      "  • /trial_balance_workup      — pulls TB + cross-checks (BS reconcile, AR/AP totals, P&L netIncome plug). Bridges the `trial-balance-workup` skill.",
      "  • /cc_statement_validator    — three-way CC reconciliation (balance match, line-by-line match, discrepancy scan, clear-on-match). Bridges the `cc-statement-validator` skill.",
      "  • /w2_prep                   — January W-2 prep via qb_w2_summary + qb_employee_list + reconciliation. Requires QB Payroll subscription.",
      "",
      "Workflow tips:",
      "  1. Start with qb_company_info to verify connection status.",
      "  2. Use qb_customer_list / qb_vendor_list to find existing records.",
      "  3. When updating records, always include ListID + EditSequence from a prior query.",
      "  4. Use qb_balance_summary for a quick financial overview.",
      "  5. For operations not covered by specific tools, use qb_raw_query.",
    ].join("\n"),
  }
);

// ---------------------------------------------------------------------------
// Session manager (lazy-initialized, shared across all tools)
// ---------------------------------------------------------------------------

let sessionManager: QBSessionManager | null = null;

function getSessionManager(): QBSessionManager {
  if (!sessionManager) {
    sessionManager = new QBSessionManager(config);
  }
  return sessionManager;
}

// ---------------------------------------------------------------------------
// Register all tool modules
// ---------------------------------------------------------------------------

registerCustomerTools(server, getSessionManager);
registerVendorTools(server, getSessionManager);
registerAccountTools(server, getSessionManager);
registerInvoiceTools(server, getSessionManager);
registerBillTools(server, getSessionManager);
registerItemTools(server, getSessionManager);
registerPaymentTools(server, getSessionManager);
registerEstimateTools(server, getSessionManager);
registerSalesReceiptTools(server, getSessionManager);
registerCreditMemoTools(server, getSessionManager);
registerPurchaseOrderTools(server, getSessionManager);
registerJournalEntryTools(server, getSessionManager);
registerEmployeeTools(server, getSessionManager);
registerListTools(server, getSessionManager);
registerReportTools(server, getSessionManager);
registerTransactionTools(server, getSessionManager);
registerForm1099Tools(server, getSessionManager);
registerReconciliationTools(server, getSessionManager);
registerAttachmentTools(server, getSessionManager);
registerPreferenceTools(server, getSessionManager);
registerDepositTools(server, getSessionManager);
registerCheckTools(server, getSessionManager);
registerTransferTools(server, getSessionManager);
registerClientPacketTools(server, getSessionManager);

// Phase 18 #86 — workflow-bundle prompts surfaced via the MCP prompts/list +
// prompts/get API. Bridges the operator's existing skill workflows
// (credit-card-qb-batch / trial-balance-workup / cc-statement-validator)
// to the post-Phase-11/12 tool surface, plus month-end-close + w2-prep.
registerWorkflowPrompts(server);

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Graceful shutdown — close any open QuickBooks session before exiting so the
// QBXMLRP2 ticket isn't stranded. A stranded ticket means the next process
// connecting with the same appName has to wait for QB to time it out (~5
// minutes) or for the operator to restart QB.
// ---------------------------------------------------------------------------

let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`\n[QB Session] Received ${signal}, closing QuickBooks session...`);
  if (sessionManager) {
    try {
      await sessionManager.closeSession();
    } catch (err) {
      console.error(`[QB Session] Shutdown error (continuing exit): ${(err as Error).message}`);
    }
  }
  process.exit(0);
}

process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Eagerly construct the session manager so the Mode banner reports the
  // actual resolved mode (which honors QB_SIMULATION overrides) rather than
  // duplicating the env-resolution logic here. Construction is cheap — it
  // reads env, picks a mode, and creates an empty SimulationStore. No QB
  // session opens until the first tool call.
  const sm = getSessionManager();
  console.error("QuickBooks Desktop MCP Server running on stdio");
  console.error(`  Company file: ${config.companyFile || "(use currently open QB file)"}`);
  console.error(`  App name: ${config.appName}`);
  console.error(`  QBXML version: ${config.qbxmlVersion}`);
  console.error(`  Mode: ${sm.isSimulation() ? "simulation" : "live"}`);
  const debugLogger = getQbxmlLogger();
  if (debugLogger) {
    console.error(`  QBXML debug log: enabled (${join(debugLogger.getLogDir(), "qbxml-YYYYMMDD.log")})`);
  }
}

main().catch((error) => {
  console.error("Fatal error starting QuickBooks MCP Server:", error);
  process.exit(1);
});
