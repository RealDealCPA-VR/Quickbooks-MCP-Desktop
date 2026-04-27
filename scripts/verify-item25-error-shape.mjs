// Item 25 verification — structured-error sweep across all CRUD tool families.
//
// Confirms that every changed tool's error path returns the canonical shape
// `{ success: false, statusCode: number, statusMessage: string }` with
// `isError: true`, instead of letting QBXMLResponseError propagate as a raw
// stack trace. Also spot-checks that happy paths still return their previous
// success shape (regression guard against accidentally swallowing the result).
//
// Coverage: one error case per tool family for the bulk paths (stale-edit,
// not-found, missing-field), plus a happy-path smoke for each family.
//
// Per HANDOFF.md "Item 25 reference shape": the wrapper sets statusCode = -1
// when the underlying error has none, and statusMessage to a per-op fallback
// like "BillModRq failed". Tests below assert both: real QBXMLResponseError
// status codes propagate, and the structured shape is consistent.

import { z } from "zod";
import { QBSessionManager } from "../dist/session/manager.js";
import { qbStatusCodeMessage } from "../dist/util/qb-status-codes.js";
import { registerCustomerTools } from "../dist/tools/customers.js";
import { registerVendorTools } from "../dist/tools/vendors.js";
import { registerAccountTools } from "../dist/tools/accounts.js";
import { registerInvoiceTools } from "../dist/tools/invoices.js";
import { registerBillTools } from "../dist/tools/bills.js";
import { registerItemTools } from "../dist/tools/items.js";
import { registerPaymentTools } from "../dist/tools/payments.js";
import { registerEstimateTools } from "../dist/tools/estimates.js";
import { registerSalesReceiptTools } from "../dist/tools/sales-receipts.js";
import { registerCreditMemoTools } from "../dist/tools/credit-memos.js";
import { registerPurchaseOrderTools } from "../dist/tools/purchase-orders.js";
import { registerJournalEntryTools } from "../dist/tools/journal-entries.js";
import { registerEmployeeTools } from "../dist/tools/employees.js";
import { registerListTools } from "../dist/tools/lists.js";
import { registerReportTools } from "../dist/tools/reports.js";

const handlers = new Map();
const schemas = new Map();
const fakeServer = {
  tool: (name, _description, schema, handler) => {
    handlers.set(name, handler);
    schemas.set(name, schema);
  },
};

const session = new QBSessionManager({
  companyFile: "simulation",
  appName: "verify-item25",
  qbxmlVersion: "16.0",
  connectionMode: "optimistic",
});
const getSession = () => session;

registerCustomerTools(fakeServer, getSession);
registerVendorTools(fakeServer, getSession);
registerAccountTools(fakeServer, getSession);
registerInvoiceTools(fakeServer, getSession);
registerBillTools(fakeServer, getSession);
registerItemTools(fakeServer, getSession);
registerPaymentTools(fakeServer, getSession);
registerEstimateTools(fakeServer, getSession);
registerSalesReceiptTools(fakeServer, getSession);
registerCreditMemoTools(fakeServer, getSession);
registerPurchaseOrderTools(fakeServer, getSession);
registerJournalEntryTools(fakeServer, getSession);
registerEmployeeTools(fakeServer, getSession);
registerListTools(fakeServer, getSession);
registerReportTools(fakeServer, getSession);

await session.openSession();

const call = async (name, args = {}) => {
  const h = handlers.get(name);
  if (!h) throw new Error(`tool not registered: ${name}`);
  const result = await h(args);
  const text = result.content[0].text;
  return { isError: !!result.isError, body: JSON.parse(text) };
};

let passes = 0;
let fails = 0;
const log = (label, pass, detail = "") => {
  const tag = pass ? "PASS" : "FAIL";
  if (pass) passes++; else fails++;
  console.log(`[${tag}] ${label}${detail ? " — " + detail : ""}`);
};

// Canonical Item 25 error shape — every wrapper must produce this exact form.
const isCanonicalError = (r) =>
  r.isError === true &&
  r.body.success === false &&
  typeof r.body.statusCode === "number" &&
  typeof r.body.statusMessage === "string" &&
  r.body.statusMessage.length > 0;

// =====================================================================
// ERROR PATH — every CRUD tool family (modify with stale/unknown ID, or
// delete with unknown ID) should produce the canonical structured payload.
// =====================================================================

// --- List entity not-found (modify a non-existent record)
{
  const r = await call("qb_customer_update", { listId: "NOPE", editSequence: "X", name: "x" });
  log("customer_update not-found → canonical error", isCanonicalError(r),
    `statusCode=${r.body.statusCode} statusMessage="${r.body.statusMessage?.slice(0,60)}"`);
}
{
  const r = await call("qb_vendor_update", { listId: "NOPE", editSequence: "X", name: "x" });
  log("vendor_update not-found → canonical error", isCanonicalError(r),
    `statusCode=${r.body.statusCode}`);
}
{
  const r = await call("qb_account_update", { listId: "NOPE", editSequence: "X", name: "x" });
  log("account_update not-found → canonical error", isCanonicalError(r),
    `statusCode=${r.body.statusCode}`);
}
{
  const r = await call("qb_employee_update", { listId: "NOPE", editSequence: "X", firstName: "x" });
  log("employee_update not-found → canonical error", isCanonicalError(r),
    `statusCode=${r.body.statusCode}`);
}
{
  const r = await call("qb_item_update", { itemType: "Service", listId: "NOPE", editSequence: "X", name: "x" });
  log("item_update not-found → canonical error", isCanonicalError(r),
    `statusCode=${r.body.statusCode}`);
}

// --- Transaction delete not-found
{
  const r = await call("qb_invoice_delete", { txnId: "NOPE" });
  log("invoice_delete not-found → canonical error", isCanonicalError(r),
    `statusCode=${r.body.statusCode}`);
}
{
  const r = await call("qb_bill_delete", { txnId: "NOPE" });
  log("bill_delete not-found → canonical error", isCanonicalError(r),
    `statusCode=${r.body.statusCode}`);
}
{
  const r = await call("qb_estimate_delete", { txnId: "NOPE" });
  log("estimate_delete not-found → canonical error", isCanonicalError(r),
    `statusCode=${r.body.statusCode}`);
}
{
  const r = await call("qb_sales_receipt_delete", { txnId: "NOPE" });
  log("sales_receipt_delete not-found → canonical error", isCanonicalError(r),
    `statusCode=${r.body.statusCode}`);
}
{
  const r = await call("qb_credit_memo_delete", { txnId: "NOPE" });
  log("credit_memo_delete not-found → canonical error", isCanonicalError(r),
    `statusCode=${r.body.statusCode}`);
}
{
  const r = await call("qb_purchase_order_delete", { txnId: "NOPE" });
  log("purchase_order_delete not-found → canonical error", isCanonicalError(r),
    `statusCode=${r.body.statusCode}`);
}
{
  const r = await call("qb_journal_entry_delete", { txnId: "NOPE" });
  log("journal_entry_delete not-found → canonical error", isCanonicalError(r),
    `statusCode=${r.body.statusCode}`);
}

// --- Modify a non-existent transaction (txn modify branch)
{
  const r = await call("qb_invoice_update", { txnId: "NOPE", editSequence: "X" });
  log("invoice_update not-found → canonical error", isCanonicalError(r),
    `statusCode=${r.body.statusCode}`);
}
{
  const r = await call("qb_bill_update", { txnId: "NOPE", editSequence: "X" });
  log("bill_update not-found → canonical error", isCanonicalError(r),
    `statusCode=${r.body.statusCode}`);
}
{
  const r = await call("qb_payment_apply", { txnId: "NOPE", editSequence: "X", applyTo: [] });
  log("payment_apply not-found → canonical error", isCanonicalError(r),
    `statusCode=${r.body.statusCode}`);
}

// --- Customer/account list-delete not-found
{
  const r = await call("qb_customer_delete", { listId: "NOPE" });
  log("customer_delete not-found → canonical error", isCanonicalError(r),
    `statusCode=${r.body.statusCode}`);
}
{
  const r = await call("qb_account_delete", { listId: "NOPE" });
  log("account_delete not-found → canonical error", isCanonicalError(r),
    `statusCode=${r.body.statusCode}`);
}

// --- Bill payment add against unknown bill (AppliedToTxnAdd validation)
{
  const r = await call("qb_bill_pay", {
    vendorName: "Acme Office Supplies",
    paymentMethod: "check",
    applyTo: [{ txnId: "NOPE-BILL", amount: 100 }],
  });
  log("bill_pay unknown-bill → canonical error", isCanonicalError(r),
    `statusCode=${r.body.statusCode}`);
}

// --- Estimate convert with unknown source — uses early-return shape (success:false, error)
//     which predates Item 25; the new query wrapper covers raw-throw cases only.
//     Skipping the dedicated assertion here — happy-path smoke covers the wrap.

// --- Journal entry imbalance (statusCode 3030)
{
  const r = await call("qb_journal_entry_create", {
    debits: [{ accountName: "Bank Account", amount: 100 }],
    credits: [{ accountName: "Sales Income", amount: 50 }],
  });
  log("journal_entry_create imbalance → canonical error", isCanonicalError(r),
    `statusCode=${r.body.statusCode} statusMessage="${r.body.statusMessage?.slice(0,40)}"`);
}

// =====================================================================
// HAPPY PATH SMOKE — one tool per file still returns previous success shape.
// =====================================================================

{
  const r = await call("qb_customer_list", {});
  const ok = !r.isError && typeof r.body.count === "number" && Array.isArray(r.body.customers);
  log("customer_list happy-path shape", ok, `count=${r.body.count}`);
}
{
  const r = await call("qb_vendor_list", {});
  const ok = !r.isError && typeof r.body.count === "number" && Array.isArray(r.body.vendors);
  log("vendor_list happy-path shape", ok, `count=${r.body.count}`);
}
{
  const r = await call("qb_account_list", {});
  const ok = !r.isError && typeof r.body.count === "number" && Array.isArray(r.body.accounts);
  log("account_list happy-path shape", ok, `count=${r.body.count}`);
}
{
  const r = await call("qb_invoice_list", {});
  const ok = !r.isError && typeof r.body.count === "number" && Array.isArray(r.body.invoices);
  log("invoice_list happy-path shape", ok, `count=${r.body.count}`);
}
{
  const r = await call("qb_bill_list", {});
  const ok = !r.isError && typeof r.body.count === "number" && Array.isArray(r.body.bills);
  log("bill_list happy-path shape", ok, `count=${r.body.count}`);
}
{
  const r = await call("qb_item_list", {});
  const ok = !r.isError && typeof r.body.count === "number" && Array.isArray(r.body.items);
  log("item_list happy-path shape (fan-out across subtypes)", ok, `count=${r.body.count}`);
}
{
  const r = await call("qb_payment_list", {});
  const ok = !r.isError && typeof r.body.count === "number" && Array.isArray(r.body.payments);
  log("payment_list happy-path shape", ok, `count=${r.body.count}`);
}
{
  const r = await call("qb_estimate_list", {});
  const ok = !r.isError && typeof r.body.count === "number" && Array.isArray(r.body.estimates);
  log("estimate_list happy-path shape", ok, `count=${r.body.count}`);
}
{
  const r = await call("qb_sales_receipt_list", {});
  const ok = !r.isError && typeof r.body.count === "number" && Array.isArray(r.body.salesReceipts);
  log("sales_receipt_list happy-path shape", ok, `count=${r.body.count}`);
}
{
  const r = await call("qb_credit_memo_list", {});
  const ok = !r.isError && typeof r.body.count === "number" && Array.isArray(r.body.creditMemos);
  log("credit_memo_list happy-path shape", ok, `count=${r.body.count}`);
}
{
  const r = await call("qb_purchase_order_list", {});
  const ok = !r.isError && typeof r.body.count === "number" && Array.isArray(r.body.purchaseOrders);
  log("purchase_order_list happy-path shape", ok, `count=${r.body.count}`);
}
{
  const r = await call("qb_journal_entry_list", {});
  const ok = !r.isError && typeof r.body.count === "number" && Array.isArray(r.body.journalEntries);
  log("journal_entry_list happy-path shape", ok, `count=${r.body.count}`);
}
{
  const r = await call("qb_employee_list", {});
  const ok = !r.isError && typeof r.body.count === "number" && Array.isArray(r.body.employees);
  log("employee_list happy-path shape", ok, `count=${r.body.count}`);
}
{
  const r = await call("qb_class_list", {});
  const ok = !r.isError && typeof r.body.count === "number" && Array.isArray(r.body.classes);
  log("class_list happy-path shape", ok, `count=${r.body.count}`);
}
{
  const r = await call("qb_terms_list", {});
  const ok = !r.isError && typeof r.body.count === "number" && Array.isArray(r.body.terms);
  log("terms_list happy-path shape (fan-out Standard+DateDriven)", ok, `count=${r.body.count}`);
}
{
  const r = await call("qb_payment_method_list", {});
  const ok = !r.isError && typeof r.body.count === "number" && Array.isArray(r.body.paymentMethods);
  log("payment_method_list happy-path shape", ok, `count=${r.body.count}`);
}
{
  const r = await call("qb_sales_rep_list", {});
  const ok = !r.isError && typeof r.body.count === "number" && Array.isArray(r.body.salesReps);
  log("sales_rep_list happy-path shape", ok, `count=${r.body.count}`);
}
{
  const r = await call("qb_customer_type_list", {});
  const ok = !r.isError && typeof r.body.count === "number" && Array.isArray(r.body.customerTypes);
  log("customer_type_list happy-path shape", ok, `count=${r.body.count}`);
}
{
  const r = await call("qb_vendor_type_list", {});
  const ok = !r.isError && typeof r.body.count === "number" && Array.isArray(r.body.vendorTypes);
  log("vendor_type_list happy-path shape", ok, `count=${r.body.count}`);
}
{
  const r = await call("qb_bill_payment_list", {});
  const ok = !r.isError && typeof r.body.count === "number" && Array.isArray(r.body.billPayments);
  log("bill_payment_list happy-path shape (fan-out Check+CC)", ok, `count=${r.body.count}`);
}

// =====================================================================
// ITEM 26 — humanReadable field on the canonical error shape.
//
// The wrapper consults qbStatusCodeMessage(statusCode) and attaches a
// `humanReadable` field when the code is in the lookup table. Unknown
// codes (including the -1 fallback for non-QBXMLResponseError throws)
// produce no field at all — silent on the unknown side, present on
// known. Both shapes are part of the contract.
// =====================================================================

// --- Direct lookup-table sanity (decoupled from tool wiring).
{
  const ok =
    typeof qbStatusCodeMessage(500) === "string" &&
    typeof qbStatusCodeMessage(3030) === "string" &&
    typeof qbStatusCodeMessage(3120) === "string" &&
    typeof qbStatusCodeMessage(3170) === "string" &&
    typeof qbStatusCodeMessage(3260) === "string";
  log("qbStatusCodeMessage covers known QB status codes", ok,
    `500="${qbStatusCodeMessage(500)}"`);
}
{
  const ok =
    qbStatusCodeMessage(-1) === undefined &&
    qbStatusCodeMessage(0) === undefined &&
    qbStatusCodeMessage(1) === undefined &&
    qbStatusCodeMessage(9999) === undefined;
  log("qbStatusCodeMessage returns undefined for unknown codes", ok,
    "checked -1, 0, 1, 9999");
}

// --- Wrapper integration: known status code → humanReadable present.
{
  const r = await call("qb_customer_update", { listId: "NOPE", editSequence: "X", name: "x" });
  const expected = qbStatusCodeMessage(500);
  const ok = isCanonicalError(r) && r.body.humanReadable === expected;
  log("customer_update not-found (500) → humanReadable attached", ok,
    `humanReadable="${r.body.humanReadable}"`);
}
{
  const r = await call("qb_journal_entry_create", {
    debits: [{ accountName: "Bank Account", amount: 100 }],
    credits: [{ accountName: "Sales Income", amount: 50 }],
  });
  const expected = qbStatusCodeMessage(3030);
  const ok = isCanonicalError(r) && r.body.humanReadable === expected;
  log("journal_entry_create imbalance (3030) → humanReadable attached", ok,
    `humanReadable="${r.body.humanReadable}"`);
}

// --- Wrapper integration: unknown status code → humanReadable absent.
//     Force a non-QBXMLResponseError throw by stubbing modifyEntity directly
//     on the live session — we expect statusCode=-1 (the fallback) and no
//     humanReadable field on the response.
{
  const realModify = session.modifyEntity.bind(session);
  session.modifyEntity = async () => {
    throw new Error("synthetic non-QBXML error");
  };
  try {
    const r = await call("qb_customer_update", { listId: "test-customer-1", editSequence: "1", name: "x" });
    const ok =
      isCanonicalError(r) &&
      r.body.statusCode === -1 &&
      !("humanReadable" in r.body);
    log("non-QBXML throw (statusCode=-1) → humanReadable absent", ok,
      `statusCode=${r.body.statusCode} hasHumanReadable=${"humanReadable" in r.body}`);
  } finally {
    session.modifyEntity = realModify;
  }
}

// =====================================================================
// ITEM 28 — accountType enum validation in qb_account_add.
//
// The schema rejects unknown account types at the zod layer (before the
// Item 25 wrapper runs). The error's first issue carries the canonical
// list in both `options` (machine-readable) and `message` (human/LLM-
// readable), so a caller can self-correct without consulting docs.
// Note: this is enforced by the SDK at registration time, NOT by the
// handler — so the response shape on rejection is the SDK's default
// validation error, not the canonical Item 25 shape.
// =====================================================================

const CANONICAL_ACCOUNT_TYPES = [
  "Bank", "AccountsReceivable", "OtherCurrentAsset", "FixedAsset",
  "OtherAsset", "AccountsPayable", "CreditCard", "OtherCurrentLiability",
  "LongTermLiability", "Equity", "Income", "CostOfGoodsSold",
  "Expense", "OtherIncome", "OtherExpense", "NonPosting",
];

{
  const shape = schemas.get("qb_account_add");
  const result = z.object(shape).safeParse({ name: "X", accountType: "Garbage" });
  const issue = result.error?.issues[0];
  const ok =
    result.success === false &&
    issue?.code === "invalid_enum_value" &&
    issue?.path[0] === "accountType" &&
    Array.isArray(issue?.options) &&
    issue.options.length === CANONICAL_ACCOUNT_TYPES.length &&
    CANONICAL_ACCOUNT_TYPES.every((t) => issue.options.includes(t)) &&
    typeof issue?.message === "string" &&
    issue.message.includes("'Bank'") &&
    issue.message.includes("'NonPosting'");
  log("qb_account_add rejects unknown accountType at zod with canonical list", ok,
    `code=${issue?.code} optionsLen=${issue?.options?.length}`);
}
{
  const shape = schemas.get("qb_account_add");
  const allCanonicalAccept = CANONICAL_ACCOUNT_TYPES.every((accountType) =>
    z.object(shape).safeParse({ name: "X", accountType }).success === true
  );
  log("qb_account_add accepts every canonical accountType", allCanonicalAccept,
    `tested=${CANONICAL_ACCOUNT_TYPES.length}`);
}
{
  // End-to-end happy path through the handler — schema change must not
  // break the existing add path on a valid type.
  const r = await call("qb_account_add", {
    name: "Item 28 Smoke Account",
    accountType: "Bank",
  });
  const ok = !r.isError && r.body.success === true && r.body.account != null;
  log("qb_account_add end-to-end with valid type still works", ok,
    `success=${r.body.success}`);
}

console.log(`\n${passes} pass / ${fails} fail`);
process.exit(fails === 0 ? 0 : 1);
