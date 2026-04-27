// Error shape (Item 25/26/28) — structured-error sweep across all CRUD tool
// families plus humanReadable attachment + accountType enum validation.
//
// Ported from scripts/verify-item25-error-shape.mjs. Confirms every changed
// tool's error path returns the canonical shape:
//   { success: false, statusCode: number, statusMessage: string,
//     humanReadable?: string }
// with `isError: true`. The wrapper sets statusCode = -1 when the underlying
// error has none, and statusMessage to a per-op fallback. Tests assert both:
// real QBXMLResponseError status codes propagate, and the structured shape
// is consistent across every tool family.

import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { qbStatusCodeMessage } from "../src/util/qb-status-codes.js";
import { registerCustomerTools } from "../src/tools/customers.js";
import { registerVendorTools } from "../src/tools/vendors.js";
import { registerAccountTools } from "../src/tools/accounts.js";
import { registerInvoiceTools } from "../src/tools/invoices.js";
import { registerBillTools } from "../src/tools/bills.js";
import { registerItemTools } from "../src/tools/items.js";
import { registerPaymentTools } from "../src/tools/payments.js";
import { registerEstimateTools } from "../src/tools/estimates.js";
import { registerSalesReceiptTools } from "../src/tools/sales-receipts.js";
import { registerCreditMemoTools } from "../src/tools/credit-memos.js";
import { registerPurchaseOrderTools } from "../src/tools/purchase-orders.js";
import { registerJournalEntryTools } from "../src/tools/journal-entries.js";
import { registerEmployeeTools } from "../src/tools/employees.js";
import { registerListTools } from "../src/tools/lists.js";
import { registerReportTools } from "../src/tools/reports.js";

type Handler = (args: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
const handlers = new Map<string, Handler>();
const schemas = new Map<string, Record<string, z.ZodTypeAny>>();
const fakeServer = {
  tool: (name: string, _description: string, schema: Record<string, z.ZodTypeAny>, handler: Handler) => {
    handlers.set(name, handler);
    schemas.set(name, schema);
  },
};

let session: QBSessionManager;

beforeAll(async () => {
  session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-error-shape",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  const getSession = () => session;
  registerCustomerTools(fakeServer as never, getSession);
  registerVendorTools(fakeServer as never, getSession);
  registerAccountTools(fakeServer as never, getSession);
  registerInvoiceTools(fakeServer as never, getSession);
  registerBillTools(fakeServer as never, getSession);
  registerItemTools(fakeServer as never, getSession);
  registerPaymentTools(fakeServer as never, getSession);
  registerEstimateTools(fakeServer as never, getSession);
  registerSalesReceiptTools(fakeServer as never, getSession);
  registerCreditMemoTools(fakeServer as never, getSession);
  registerPurchaseOrderTools(fakeServer as never, getSession);
  registerJournalEntryTools(fakeServer as never, getSession);
  registerEmployeeTools(fakeServer as never, getSession);
  registerListTools(fakeServer as never, getSession);
  registerReportTools(fakeServer as never, getSession);
  await session.openSession();
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const h = handlers.get(name);
  if (!h) throw new Error(`tool not registered: ${name}`);
  const result = await h(args);
  const text = result.content[0].text;
  return { isError: !!result.isError, body: JSON.parse(text) };
};

// Canonical Item 25 error shape assertion. Every wrapper must produce this
// exact form: isError + success:false + numeric statusCode + non-empty
// statusMessage. Inline rather than helper-extracted so the failure
// message names exactly which assertion didn't hold.
const expectCanonicalError = (r: { isError: boolean; body: Record<string, unknown> }) => {
  expect(r.isError).toBe(true);
  expect(r.body.success).toBe(false);
  expect(typeof r.body.statusCode).toBe("number");
  expect(typeof r.body.statusMessage).toBe("string");
  expect((r.body.statusMessage as string).length).toBeGreaterThan(0);
};

describe("Item 25 — list-entity not-found returns canonical error", () => {
  it("customer_update not-found", async () => {
    const r = await call("qb_customer_update", { listId: "NOPE", editSequence: "X", name: "x" });
    expectCanonicalError(r);
  });
  it("vendor_update not-found", async () => {
    const r = await call("qb_vendor_update", { listId: "NOPE", editSequence: "X", name: "x" });
    expectCanonicalError(r);
  });
  it("account_update not-found", async () => {
    const r = await call("qb_account_update", { listId: "NOPE", editSequence: "X", name: "x" });
    expectCanonicalError(r);
  });
  it("employee_update not-found", async () => {
    const r = await call("qb_employee_update", { listId: "NOPE", editSequence: "X", firstName: "x" });
    expectCanonicalError(r);
  });
  it("item_update not-found", async () => {
    const r = await call("qb_item_update", { itemType: "Service", listId: "NOPE", editSequence: "X", name: "x" });
    expectCanonicalError(r);
  });
});

describe("Item 25 — transaction delete not-found returns canonical error", () => {
  it("invoice_delete not-found", async () => {
    const r = await call("qb_invoice_delete", { txnId: "NOPE" });
    expectCanonicalError(r);
  });
  it("bill_delete not-found", async () => {
    const r = await call("qb_bill_delete", { txnId: "NOPE" });
    expectCanonicalError(r);
  });
  it("estimate_delete not-found", async () => {
    const r = await call("qb_estimate_delete", { txnId: "NOPE" });
    expectCanonicalError(r);
  });
  it("sales_receipt_delete not-found", async () => {
    const r = await call("qb_sales_receipt_delete", { txnId: "NOPE" });
    expectCanonicalError(r);
  });
  it("credit_memo_delete not-found", async () => {
    const r = await call("qb_credit_memo_delete", { txnId: "NOPE" });
    expectCanonicalError(r);
  });
  it("purchase_order_delete not-found", async () => {
    const r = await call("qb_purchase_order_delete", { txnId: "NOPE" });
    expectCanonicalError(r);
  });
  it("journal_entry_delete not-found", async () => {
    const r = await call("qb_journal_entry_delete", { txnId: "NOPE" });
    expectCanonicalError(r);
  });
});

describe("Item 25 — transaction modify not-found returns canonical error", () => {
  it("invoice_update not-found", async () => {
    const r = await call("qb_invoice_update", { txnId: "NOPE", editSequence: "X" });
    expectCanonicalError(r);
  });
  it("bill_update not-found", async () => {
    const r = await call("qb_bill_update", { txnId: "NOPE", editSequence: "X" });
    expectCanonicalError(r);
  });
  it("payment_apply not-found", async () => {
    const r = await call("qb_payment_apply", { txnId: "NOPE", editSequence: "X", applyTo: [] });
    expectCanonicalError(r);
  });
});

describe("Item 25 — list-delete not-found returns canonical error", () => {
  it("customer_delete not-found", async () => {
    const r = await call("qb_customer_delete", { listId: "NOPE" });
    expectCanonicalError(r);
  });
  it("account_delete not-found", async () => {
    const r = await call("qb_account_delete", { listId: "NOPE" });
    expectCanonicalError(r);
  });
});

describe("Item 25 — bill payment with unknown bill returns canonical error", () => {
  it("bill_pay unknown-bill in applyTo", async () => {
    const r = await call("qb_bill_pay", {
      vendorName: "Acme Office Supplies",
      paymentMethod: "check",
      applyTo: [{ txnId: "NOPE-BILL", amount: 100 }],
    });
    expectCanonicalError(r);
  });
});

describe("Item 25 — journal entry imbalance returns canonical error (3030)", () => {
  it("debits != credits", async () => {
    const r = await call("qb_journal_entry_create", {
      debits: [{ accountName: "Bank Account", amount: 100 }],
      credits: [{ accountName: "Sales Income", amount: 50 }],
    });
    expectCanonicalError(r);
  });
});

describe("Item 25 — happy path smokes (regression: success shape preserved)", () => {
  // One smoke per list tool. The wrapper must not have swallowed the
  // result on any happy path while adding error handling.
  const cases: Array<[string, string]> = [
    ["qb_customer_list", "customers"],
    ["qb_vendor_list", "vendors"],
    ["qb_account_list", "accounts"],
    ["qb_invoice_list", "invoices"],
    ["qb_bill_list", "bills"],
    ["qb_item_list", "items"],
    ["qb_payment_list", "payments"],
    ["qb_estimate_list", "estimates"],
    ["qb_sales_receipt_list", "salesReceipts"],
    ["qb_credit_memo_list", "creditMemos"],
    ["qb_purchase_order_list", "purchaseOrders"],
    ["qb_journal_entry_list", "journalEntries"],
    ["qb_employee_list", "employees"],
    ["qb_class_list", "classes"],
    ["qb_terms_list", "terms"],
    ["qb_payment_method_list", "paymentMethods"],
    ["qb_sales_rep_list", "salesReps"],
    ["qb_customer_type_list", "customerTypes"],
    ["qb_vendor_type_list", "vendorTypes"],
    ["qb_bill_payment_list", "billPayments"],
  ];
  for (const [tool, arrayKey] of cases) {
    it(`${tool} happy-path shape`, async () => {
      const r = await call(tool, {});
      expect(r.isError).toBe(false);
      expect(typeof r.body.count).toBe("number");
      expect(Array.isArray(r.body[arrayKey])).toBe(true);
    });
  }
});

describe("Item 26 — qbStatusCodeMessage lookup table", () => {
  it("covers known QB status codes (500, 3030, 3120, 3170, 3260)", () => {
    expect(typeof qbStatusCodeMessage(500)).toBe("string");
    expect(typeof qbStatusCodeMessage(3030)).toBe("string");
    expect(typeof qbStatusCodeMessage(3120)).toBe("string");
    expect(typeof qbStatusCodeMessage(3170)).toBe("string");
    expect(typeof qbStatusCodeMessage(3260)).toBe("string");
  });
  it("returns undefined for unknown codes (-1, 0, 1, 9999)", () => {
    expect(qbStatusCodeMessage(-1)).toBeUndefined();
    expect(qbStatusCodeMessage(0)).toBeUndefined();
    expect(qbStatusCodeMessage(1)).toBeUndefined();
    expect(qbStatusCodeMessage(9999)).toBeUndefined();
  });
});

describe("Item 26 — wrapper attaches humanReadable on known codes", () => {
  it("customer_update not-found (500) → humanReadable attached", async () => {
    const r = await call("qb_customer_update", { listId: "NOPE", editSequence: "X", name: "x" });
    expectCanonicalError(r);
    expect(r.body.humanReadable).toBe(qbStatusCodeMessage(500));
  });
  it("journal_entry_create imbalance (3030) → humanReadable attached", async () => {
    const r = await call("qb_journal_entry_create", {
      debits: [{ accountName: "Bank Account", amount: 100 }],
      credits: [{ accountName: "Sales Income", amount: 50 }],
    });
    expectCanonicalError(r);
    expect(r.body.humanReadable).toBe(qbStatusCodeMessage(3030));
  });

  it("non-QBXML throw (statusCode=-1) → humanReadable absent", async () => {
    // Force a non-QBXMLResponseError throw by stubbing modifyEntity directly
    // on the live session — we expect statusCode=-1 (the fallback) and no
    // humanReadable field. Restore in finally so other tests aren't affected.
    const realModify = session.modifyEntity.bind(session);
    session.modifyEntity = async () => { throw new Error("synthetic non-QBXML error"); };
    try {
      const r = await call("qb_customer_update", { listId: "test-customer-1", editSequence: "1", name: "x" });
      expectCanonicalError(r);
      expect(r.body.statusCode).toBe(-1);
      expect("humanReadable" in r.body).toBe(false);
    } finally {
      session.modifyEntity = realModify;
    }
  });
});

describe("Item 28 — accountType enum validation", () => {
  // Per Item 28, qb_account_add validates accountType against the canonical
  // 16-entry list. Rejection at zod produces invalid_enum_value (NOT
  // invalid_string — Item 29's regex code), and the issue exposes the
  // canonical list in both `options` (machine-readable) and `message`
  // (LLM-readable).
  const CANONICAL_ACCOUNT_TYPES = [
    "Bank", "AccountsReceivable", "OtherCurrentAsset", "FixedAsset",
    "OtherAsset", "AccountsPayable", "CreditCard", "OtherCurrentLiability",
    "LongTermLiability", "Equity", "Income", "CostOfGoodsSold",
    "Expense", "OtherIncome", "OtherExpense", "NonPosting",
  ];

  it("rejects unknown accountType at zod with canonical list", () => {
    const shape = schemas.get("qb_account_add");
    if (!shape) throw new Error("qb_account_add not registered");
    const result = z.object(shape).safeParse({ name: "X", accountType: "Garbage" });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues[0];
    expect(issue.code).toBe("invalid_enum_value");
    expect(issue.path[0]).toBe("accountType");
    const issueWithOptions = issue as typeof issue & { options: string[] };
    expect(Array.isArray(issueWithOptions.options)).toBe(true);
    expect(issueWithOptions.options.length).toBe(CANONICAL_ACCOUNT_TYPES.length);
    for (const t of CANONICAL_ACCOUNT_TYPES) {
      expect(issueWithOptions.options).toContain(t);
    }
    expect(issue.message).toContain("'Bank'");
    expect(issue.message).toContain("'NonPosting'");
  });

  it("accepts every canonical accountType", () => {
    const shape = schemas.get("qb_account_add");
    if (!shape) throw new Error("qb_account_add not registered");
    for (const accountType of CANONICAL_ACCOUNT_TYPES) {
      const result = z.object(shape).safeParse({ name: "X", accountType });
      expect(result.success).toBe(true);
    }
  });

  it("end-to-end add with valid type still works (no regression)", async () => {
    const r = await call("qb_account_add", {
      name: "Item 28 Smoke Account",
      accountType: "Bank",
    });
    expect(r.isError).toBe(false);
    expect(r.body.success).toBe(true);
    expect(r.body.account).toBeDefined();
  });
});
