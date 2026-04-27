// Input validation (Item 29) — TxnDate / DueDate / fromDate / toDate /
// asOfDate / hiredDate / email / phone / postalCode regex enforcement at
// the zod layer.
//
// Ported from scripts/verify-item29-input-validation.mjs. Schema rejection
// produces zod's `invalid_string` issue code (regex mismatch), distinct from
// the Item 28 enum's `invalid_enum_value`. Rejection happens BEFORE the
// Item 25 wrapper runs — different layer, different contract.

import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import {
  ISO_DATE_RE,
  EMAIL_RE,
  PHONE_RE,
  POSTAL_RE,
} from "../src/util/validators.js";
import { registerCustomerTools } from "../src/tools/customers.js";
import { registerVendorTools } from "../src/tools/vendors.js";
import { registerInvoiceTools } from "../src/tools/invoices.js";
import { registerBillTools } from "../src/tools/bills.js";
import { registerEmployeeTools } from "../src/tools/employees.js";
import { registerEstimateTools } from "../src/tools/estimates.js";
import { registerSalesReceiptTools } from "../src/tools/sales-receipts.js";
import { registerCreditMemoTools } from "../src/tools/credit-memos.js";
import { registerPurchaseOrderTools } from "../src/tools/purchase-orders.js";
import { registerJournalEntryTools } from "../src/tools/journal-entries.js";
import { registerPaymentTools } from "../src/tools/payments.js";
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

beforeAll(async () => {
  const session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-input-validation",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  const getSession = () => session;
  registerCustomerTools(fakeServer as never, getSession);
  registerVendorTools(fakeServer as never, getSession);
  registerInvoiceTools(fakeServer as never, getSession);
  registerBillTools(fakeServer as never, getSession);
  registerEmployeeTools(fakeServer as never, getSession);
  registerEstimateTools(fakeServer as never, getSession);
  registerSalesReceiptTools(fakeServer as never, getSession);
  registerCreditMemoTools(fakeServer as never, getSession);
  registerPurchaseOrderTools(fakeServer as never, getSession);
  registerJournalEntryTools(fakeServer as never, getSession);
  registerPaymentTools(fakeServer as never, getSession);
  registerReportTools(fakeServer as never, getSession);
  await session.openSession();
});

// expectRegexReject runs the tool's schema through safeParse and asserts the
// error contains an `invalid_string` issue on the named path. Multiple issues
// are tolerated (other fields may also be invalid in the test arg) — we only
// require AT LEAST ONE matches the expected regex rejection.
const expectRegexReject = (toolName: string, args: Record<string, unknown>, expectedPath: string) => {
  const shape = schemas.get(toolName);
  if (!shape) throw new Error(`Tool not registered: ${toolName}`);
  const result = z.object(shape).safeParse(args);
  expect(result.success).toBe(false);
  if (result.success) return;
  const issue = result.error.issues.find(
    (i) => i.code === "invalid_string" && i.path[0] === expectedPath
  );
  expect(issue).toBeDefined();
  expect(issue?.code).toBe("invalid_string");
  expect(issue?.path[0]).toBe(expectedPath);
};

const expectAccepts = (toolName: string, args: Record<string, unknown>) => {
  const shape = schemas.get(toolName);
  if (!shape) throw new Error(`Tool not registered: ${toolName}`);
  const result = z.object(shape).safeParse(args);
  expect(result.success).toBe(true);
};

describe("Part A — regex constants in isolation", () => {
  describe("ISO_DATE_RE", () => {
    it("accepts '2026-04-27'", () => expect(ISO_DATE_RE.test("2026-04-27")).toBe(true));
    it("rejects 'April 27, 2026'", () => expect(ISO_DATE_RE.test("April 27, 2026")).toBe(false));
    it("rejects '2026-4-27' (unpadded)", () => expect(ISO_DATE_RE.test("2026-4-27")).toBe(false));
  });

  describe("EMAIL_RE", () => {
    it("accepts 'jane@example.com'", () => expect(EMAIL_RE.test("jane@example.com")).toBe(true));
    it("rejects 'not-an-email'", () => expect(EMAIL_RE.test("not-an-email")).toBe(false));
    it("rejects 'jane@.com' (no domain)", () => expect(EMAIL_RE.test("jane@.com")).toBe(false));
  });

  describe("PHONE_RE", () => {
    it("accepts '(555) 123-4567'", () => expect(PHONE_RE.test("(555) 123-4567")).toBe(true));
    it("accepts '+1.555.123.4567'", () => expect(PHONE_RE.test("+1.555.123.4567")).toBe(true));
    it("rejects 'abc-def-ghij' (letters)", () => expect(PHONE_RE.test("abc-def-ghij")).toBe(false));
    it("rejects '12345' (too short)", () => expect(PHONE_RE.test("12345")).toBe(false));
  });

  describe("POSTAL_RE", () => {
    it("accepts '94110' (US ZIP)", () => expect(POSTAL_RE.test("94110")).toBe(true));
    it("accepts '94110-1234' (ZIP+4)", () => expect(POSTAL_RE.test("94110-1234")).toBe(true));
    it("accepts 'K1A 0B1' (Canadian)", () => expect(POSTAL_RE.test("K1A 0B1")).toBe(true));
    it("rejects 'ab' (too short)", () => expect(POSTAL_RE.test("ab")).toBe(false));
    it("rejects '!@#$%' (junk symbols)", () => expect(POSTAL_RE.test("!@#$%")).toBe(false));
  });
});

describe("Part B — schema enforcement on date fields (ISO_DATE_RE)", () => {
  it("qb_invoice_create rejects malformed txnDate", () => {
    expectRegexReject("qb_invoice_create", { txnDate: "April 27" }, "txnDate");
  });
  it("qb_invoice_create rejects malformed dueDate (slashes)", () => {
    expectRegexReject("qb_invoice_create", { dueDate: "2026/04/27" }, "dueDate");
  });
  it("qb_invoice_list rejects malformed fromDate filter", () => {
    expectRegexReject("qb_invoice_list", { fromDate: "yesterday" }, "fromDate");
  });
  it("qb_bill_create rejects malformed dueDate", () => {
    expectRegexReject("qb_bill_create", { dueDate: "in two weeks" }, "dueDate");
  });
  it("qb_estimate_create rejects malformed txnDate", () => {
    expectRegexReject("qb_estimate_create", { txnDate: "Q2-2026" }, "txnDate");
  });
  it("qb_sales_receipt_create rejects malformed txnDate", () => {
    expectRegexReject("qb_sales_receipt_create", { txnDate: "today" }, "txnDate");
  });
  it("qb_credit_memo_create rejects malformed txnDate (year only)", () => {
    expectRegexReject("qb_credit_memo_create", { txnDate: "2026" }, "txnDate");
  });
  it("qb_purchase_order_create rejects malformed dueDate", () => {
    expectRegexReject("qb_purchase_order_create", { dueDate: "next month" }, "dueDate");
  });
  it("qb_journal_entry_create rejects malformed txnDate", () => {
    expectRegexReject("qb_journal_entry_create", { txnDate: "Apr 27 2026" }, "txnDate");
  });
  it("qb_payment_receive rejects malformed txnDate", () => {
    // Note: the regex is shape-only, so '2026-13-01' would actually PASS
    // (matches \d{4}-\d{2}-\d{2}). Use a clearly malformed value.
    expectRegexReject("qb_payment_receive", { txnDate: "not-a-date" }, "txnDate");
  });
  it("qb_employee_add rejects malformed hiredDate (US slash)", () => {
    expectRegexReject(
      "qb_employee_add",
      { firstName: "X", lastName: "Y", hiredDate: "1/1/2026" },
      "hiredDate"
    );
  });

  // Reports (Item 19/21 regression — local ISO_DATE_RE was promoted to
  // util/validators.ts, must still enforce on the report tools).
  it("qb_pnl_report rejects malformed fromDate (post-refactor)", () => {
    expectRegexReject("qb_pnl_report", { fromDate: "garbage" }, "fromDate");
  });
  it("qb_balance_sheet_report rejects malformed asOfDate", () => {
    expectRegexReject("qb_balance_sheet_report", { asOfDate: "yesterday" }, "asOfDate");
  });
  it("qb_ar_aging rejects malformed asOfDate", () => {
    expectRegexReject("qb_ar_aging", { asOfDate: "Q2" }, "asOfDate");
  });
});

describe("Part B — schema enforcement on email fields (EMAIL_RE)", () => {
  it("qb_customer_add rejects malformed email", () => {
    expectRegexReject("qb_customer_add", { name: "X", email: "not-an-email" }, "email");
  });
  it("qb_customer_update rejects malformed email", () => {
    expectRegexReject("qb_customer_update", { listId: "X", editSequence: "1", email: "bad" }, "email");
  });
  it("qb_vendor_add rejects malformed email", () => {
    expectRegexReject("qb_vendor_add", { name: "V", email: "missing-at-sign.com" }, "email");
  });
  it("qb_vendor_update rejects malformed email (trailing @)", () => {
    expectRegexReject("qb_vendor_update", { listId: "V", editSequence: "1", email: "user@" }, "email");
  });
  it("qb_employee_add rejects malformed email", () => {
    expectRegexReject("qb_employee_add", { firstName: "X", lastName: "Y", email: "x" }, "email");
  });
  it("qb_employee_update rejects malformed email (leading @)", () => {
    expectRegexReject("qb_employee_update", { listId: "E", editSequence: "1", email: "@example.com" }, "email");
  });
});

describe("Part B — schema enforcement on phone + postal fields", () => {
  it("qb_customer_add rejects letters-only phone", () => {
    expectRegexReject("qb_customer_add", { name: "X", phone: "abc-def-ghij" }, "phone");
  });
  it("qb_vendor_add rejects too-short phone", () => {
    expectRegexReject("qb_vendor_add", { name: "V", phone: "12345" }, "phone");
  });
  it("qb_employee_add rejects letters phone", () => {
    expectRegexReject("qb_employee_add", { firstName: "X", lastName: "Y", phone: "call me" }, "phone");
  });
  it("qb_customer_add rejects too-short billPostalCode", () => {
    expectRegexReject("qb_customer_add", { name: "X", billPostalCode: "ab" }, "billPostalCode");
  });
  it("qb_vendor_add rejects junk postalCode", () => {
    expectRegexReject("qb_vendor_add", { name: "V", postalCode: "!!" }, "postalCode");
  });
});

describe("Part C — happy paths (regression: valid input still passes)", () => {
  it("qb_invoice_create accepts valid YYYY-MM-DD dates", () => {
    expectAccepts("qb_invoice_create", {
      customerName: "Acme",
      txnDate: "2026-04-27",
      dueDate: "2026-05-27",
    });
  });

  it("qb_customer_add accepts valid email + phone + postal", () => {
    expectAccepts("qb_customer_add", {
      name: "Test",
      email: "test@example.com",
      phone: "(555) 123-4567",
      billPostalCode: "94110-1234",
    });
  });

  it("qb_employee_add accepts valid email + phone + hiredDate", () => {
    expectAccepts("qb_employee_add", {
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      phone: "+1 555 123 4567",
      hiredDate: "2026-04-27",
    });
  });

  it("qb_invoice_create end-to-end with valid date reaches handler", async () => {
    // The handler may still fail at runtime (e.g. customer not in seed),
    // but the regex sweep must not be the cause. Accept either:
    //   (a) success === true, OR
    //   (b) a canonical wrapper error (statusCode + statusMessage), which
    //       proves we got past zod into the wrapper.
    const handler = handlers.get("qb_invoice_create");
    if (!handler) throw new Error("qb_invoice_create not registered");
    const result = await handler({
      customerName: "Acme Corp",
      txnDate: "2026-04-27",
      dueDate: "2026-05-27",
      lines: [{ itemName: "Consulting", quantity: 2, rate: 100 }],
    });
    const body = JSON.parse(result.content[0].text);
    const reachedHandler =
      body.success === true ||
      (body.success === false && typeof body.statusCode === "number");
    expect(reachedHandler).toBe(true);
  });
});
