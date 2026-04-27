// Item 29 verification — input format validation across the tool surface.
//
// Confirms that every TxnDate / DueDate / fromDate / toDate / asOfDate /
// hiredDate / email / phone / postalCode field rejects malformed input at
// the zod layer, before the Item 25 wrapper runs. Per HANDOFF.md "Item 29
// implementation shape", the four regex constants live in
// src/util/validators.ts and are imported by every src/tools/*.ts file
// that owns the corresponding fields.
//
// Schema rejection produces zod's default validation error (an
// `INVALID_PARAMS` JSON-RPC error from the SDK on the live wire), NOT the
// canonical Item 25 shape — different layer, different contract. The
// `code` on a regex mismatch is `"invalid_string"`. See the Item 28
// harness section for the parallel `"invalid_enum_value"` case.
//
// Coverage strategy: the regexes are shared, so if one tool's date field
// enforces it, they all do. We test representative tools per regex type
// (date / email / phone / postal) plus the regex constants themselves
// in isolation, plus the reports.ts dates (Item 19/21 regression guard
// after the local ISO_DATE_RE was promoted to validators.ts).

import { z } from "zod";
import { QBSessionManager } from "../dist/session/manager.js";
import {
  ISO_DATE_RE,
  EMAIL_RE,
  PHONE_RE,
  POSTAL_RE,
} from "../dist/util/validators.js";
import { registerCustomerTools } from "../dist/tools/customers.js";
import { registerVendorTools } from "../dist/tools/vendors.js";
import { registerInvoiceTools } from "../dist/tools/invoices.js";
import { registerBillTools } from "../dist/tools/bills.js";
import { registerEmployeeTools } from "../dist/tools/employees.js";
import { registerEstimateTools } from "../dist/tools/estimates.js";
import { registerSalesReceiptTools } from "../dist/tools/sales-receipts.js";
import { registerCreditMemoTools } from "../dist/tools/credit-memos.js";
import { registerPurchaseOrderTools } from "../dist/tools/purchase-orders.js";
import { registerJournalEntryTools } from "../dist/tools/journal-entries.js";
import { registerPaymentTools } from "../dist/tools/payments.js";
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
  appName: "verify-item29",
  qbxmlVersion: "16.0",
  connectionMode: "optimistic",
});
const getSession = () => session;

registerCustomerTools(fakeServer, getSession);
registerVendorTools(fakeServer, getSession);
registerInvoiceTools(fakeServer, getSession);
registerBillTools(fakeServer, getSession);
registerEmployeeTools(fakeServer, getSession);
registerEstimateTools(fakeServer, getSession);
registerSalesReceiptTools(fakeServer, getSession);
registerCreditMemoTools(fakeServer, getSession);
registerPurchaseOrderTools(fakeServer, getSession);
registerJournalEntryTools(fakeServer, getSession);
registerPaymentTools(fakeServer, getSession);
registerReportTools(fakeServer, getSession);

await session.openSession();

let passes = 0;
let fails = 0;
const log = (label, pass, detail = "") => {
  const tag = pass ? "PASS" : "FAIL";
  if (pass) passes++; else fails++;
  console.log(`[${tag}] ${label}${detail ? " — " + detail : ""}`);
};

// =====================================================================
// PART A — Regex constants in isolation. The four exported constants
// must accept canonical good shapes and reject obvious garbage.
// =====================================================================

log("ISO_DATE_RE accepts '2026-04-27'", ISO_DATE_RE.test("2026-04-27"));
log("ISO_DATE_RE rejects 'April 27, 2026'", !ISO_DATE_RE.test("April 27, 2026"));
log("ISO_DATE_RE rejects '2026-4-27' (unpadded)", !ISO_DATE_RE.test("2026-4-27"));

log("EMAIL_RE accepts 'jane@example.com'", EMAIL_RE.test("jane@example.com"));
log("EMAIL_RE rejects 'not-an-email'", !EMAIL_RE.test("not-an-email"));
log("EMAIL_RE rejects 'jane@.com' (no domain)", !EMAIL_RE.test("jane@.com"));

log("PHONE_RE accepts '(555) 123-4567'", PHONE_RE.test("(555) 123-4567"));
log("PHONE_RE accepts '+1.555.123.4567'", PHONE_RE.test("+1.555.123.4567"));
log("PHONE_RE rejects 'abc-def-ghij' (letters)", !PHONE_RE.test("abc-def-ghij"));
log("PHONE_RE rejects '12345' (too short)", !PHONE_RE.test("12345"));

log("POSTAL_RE accepts '94110' (US ZIP)", POSTAL_RE.test("94110"));
log("POSTAL_RE accepts '94110-1234' (ZIP+4)", POSTAL_RE.test("94110-1234"));
log("POSTAL_RE accepts 'K1A 0B1' (Canadian)", POSTAL_RE.test("K1A 0B1"));
log("POSTAL_RE rejects 'ab' (too short)", !POSTAL_RE.test("ab"));
log("POSTAL_RE rejects '!@#$%' (junk symbols)", !POSTAL_RE.test("!@#$%"));

// =====================================================================
// PART B — Schema-level enforcement. Every regex must be wired into the
// owning tool schema so safeParse rejects bad input at zod, BEFORE the
// handler runs. Per HANDOFF.md "Item 28 wrap-up", the rejection shape
// is `code: "invalid_string"` (zod's regex-mismatch code), distinct
// from the Item 28 enum's `"invalid_enum_value"`.
// =====================================================================

const expectRegexReject = (toolName, args, expectedPath) => {
  const shape = schemas.get(toolName);
  const result = z.object(shape).safeParse(args);
  if (result.success) return { ok: false, detail: "safeParse unexpectedly succeeded" };
  // The schema may surface multiple issues if other fields are also invalid.
  // We only care that AT LEAST ONE issue is the expected regex rejection.
  const issue = result.error.issues.find(
    (i) => i.code === "invalid_string" && i.path[0] === expectedPath
  );
  if (!issue) {
    return {
      ok: false,
      detail: `no invalid_string issue on path "${expectedPath}" — got ${JSON.stringify(result.error.issues)}`,
    };
  }
  return { ok: true, detail: `code=${issue.code} path=${issue.path[0]}` };
};

const expectAccepts = (toolName, args) => {
  const shape = schemas.get(toolName);
  const result = z.object(shape).safeParse(args);
  return { ok: result.success, detail: result.success ? "parsed" : JSON.stringify(result.error.issues) };
};

// --- Date fields (ISO_DATE_RE) — one representative tool per file the sweep touched.
{
  const r = expectRegexReject("qb_invoice_create", { txnDate: "April 27" }, "txnDate");
  log("qb_invoice_create rejects malformed txnDate", r.ok, r.detail);
}
{
  const r = expectRegexReject("qb_invoice_create", { dueDate: "2026/04/27" }, "dueDate");
  log("qb_invoice_create rejects malformed dueDate (slashes)", r.ok, r.detail);
}
{
  const r = expectRegexReject("qb_invoice_list", { fromDate: "yesterday" }, "fromDate");
  log("qb_invoice_list rejects malformed fromDate filter", r.ok, r.detail);
}
{
  const r = expectRegexReject("qb_bill_create", { dueDate: "in two weeks" }, "dueDate");
  log("qb_bill_create rejects malformed dueDate", r.ok, r.detail);
}
{
  const r = expectRegexReject("qb_estimate_create", { txnDate: "Q2-2026" }, "txnDate");
  log("qb_estimate_create rejects malformed txnDate", r.ok, r.detail);
}
{
  const r = expectRegexReject("qb_sales_receipt_create", { txnDate: "today" }, "txnDate");
  log("qb_sales_receipt_create rejects malformed txnDate", r.ok, r.detail);
}
{
  const r = expectRegexReject("qb_credit_memo_create", { txnDate: "2026" }, "txnDate");
  log("qb_credit_memo_create rejects malformed txnDate (year only)", r.ok, r.detail);
}
{
  const r = expectRegexReject("qb_purchase_order_create", { dueDate: "next month" }, "dueDate");
  log("qb_purchase_order_create rejects malformed dueDate", r.ok, r.detail);
}
{
  const r = expectRegexReject("qb_journal_entry_create", { txnDate: "Apr 27 2026" }, "txnDate");
  log("qb_journal_entry_create rejects malformed txnDate", r.ok, r.detail);
}
{
  const r = expectRegexReject("qb_payment_receive", { txnDate: "2026-13-01" }, "txnDate");
  // Note: the regex is shape-only, so "2026-13-01" actually PASSES (it matches \d{4}-\d{2}-\d{2}).
  // Use a clearly malformed value instead.
  const r2 = expectRegexReject("qb_payment_receive", { txnDate: "not-a-date" }, "txnDate");
  log("qb_payment_receive rejects malformed txnDate", r2.ok, r2.detail);
}
{
  const r = expectRegexReject("qb_employee_add", { firstName: "X", lastName: "Y", hiredDate: "1/1/2026" }, "hiredDate");
  log("qb_employee_add rejects malformed hiredDate (US slash)", r.ok, r.detail);
}

// --- Reports (Item 19/21 regression — local regex was promoted, must still enforce).
{
  const r = expectRegexReject("qb_pnl_report", { fromDate: "garbage" }, "fromDate");
  log("qb_pnl_report rejects malformed fromDate (post-refactor)", r.ok, r.detail);
}
{
  const r = expectRegexReject("qb_balance_sheet_report", { asOfDate: "yesterday" }, "asOfDate");
  log("qb_balance_sheet_report rejects malformed asOfDate", r.ok, r.detail);
}
{
  const r = expectRegexReject("qb_ar_aging", { asOfDate: "Q2" }, "asOfDate");
  log("qb_ar_aging rejects malformed asOfDate", r.ok, r.detail);
}

// --- Email fields — every contact-bearing tool surface.
{
  const r = expectRegexReject("qb_customer_add", { name: "X", email: "not-an-email" }, "email");
  log("qb_customer_add rejects malformed email", r.ok, r.detail);
}
{
  const r = expectRegexReject("qb_customer_update", { listId: "X", editSequence: "1", email: "bad" }, "email");
  log("qb_customer_update rejects malformed email", r.ok, r.detail);
}
{
  const r = expectRegexReject("qb_vendor_add", { name: "V", email: "missing-at-sign.com" }, "email");
  log("qb_vendor_add rejects malformed email", r.ok, r.detail);
}
{
  const r = expectRegexReject("qb_vendor_update", { listId: "V", editSequence: "1", email: "user@" }, "email");
  log("qb_vendor_update rejects malformed email (trailing @)", r.ok, r.detail);
}
{
  const r = expectRegexReject("qb_employee_add", { firstName: "X", lastName: "Y", email: "x" }, "email");
  log("qb_employee_add rejects malformed email", r.ok, r.detail);
}
{
  const r = expectRegexReject("qb_employee_update", { listId: "E", editSequence: "1", email: "@example.com" }, "email");
  log("qb_employee_update rejects malformed email (leading @)", r.ok, r.detail);
}

// --- Phone fields.
{
  const r = expectRegexReject("qb_customer_add", { name: "X", phone: "abc-def-ghij" }, "phone");
  log("qb_customer_add rejects letters-only phone", r.ok, r.detail);
}
{
  const r = expectRegexReject("qb_vendor_add", { name: "V", phone: "12345" }, "phone");
  log("qb_vendor_add rejects too-short phone", r.ok, r.detail);
}
{
  const r = expectRegexReject("qb_employee_add", { firstName: "X", lastName: "Y", phone: "call me" }, "phone");
  log("qb_employee_add rejects letters phone", r.ok, r.detail);
}

// --- Postal codes.
{
  const r = expectRegexReject("qb_customer_add", { name: "X", billPostalCode: "ab" }, "billPostalCode");
  log("qb_customer_add rejects too-short billPostalCode", r.ok, r.detail);
}
{
  const r = expectRegexReject("qb_vendor_add", { name: "V", postalCode: "!!" }, "postalCode");
  log("qb_vendor_add rejects junk postalCode", r.ok, r.detail);
}

// =====================================================================
// PART C — Happy paths. Valid input passes through every regex and the
// handler still runs. Confirms the sweep didn't break the existing
// success path.
// =====================================================================

{
  const r = expectAccepts("qb_invoice_create", { customerName: "Acme", txnDate: "2026-04-27", dueDate: "2026-05-27" });
  log("qb_invoice_create accepts valid YYYY-MM-DD dates", r.ok, r.detail);
}
{
  const r = expectAccepts("qb_customer_add", {
    name: "Test",
    email: "test@example.com",
    phone: "(555) 123-4567",
    billPostalCode: "94110-1234",
  });
  log("qb_customer_add accepts valid email + phone + postal", r.ok, r.detail);
}
{
  const r = expectAccepts("qb_employee_add", {
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@example.com",
    phone: "+1 555 123 4567",
    hiredDate: "2026-04-27",
  });
  log("qb_employee_add accepts valid email + phone + hiredDate", r.ok, r.detail);
}

// --- End-to-end through the handler — schema sweep must not break the add path.
{
  const handler = handlers.get("qb_invoice_create");
  const result = await handler({
    customerName: "Acme Corp",
    txnDate: "2026-04-27",
    dueDate: "2026-05-27",
    lines: [{ itemName: "Consulting", quantity: 2, rate: 100 }],
  });
  const body = JSON.parse(result.content[0].text);
  // The handler may still fail at runtime (e.g. customer not in seed data),
  // but the regex sweep must not be the cause. Accept either:
  //   (a) success === true, OR
  //   (b) a canonical wrapper error (statusCode + statusMessage), which
  //       proves we got past zod into the wrapper.
  const reachedHandler =
    body.success === true ||
    (body.success === false && typeof body.statusCode === "number");
  log("qb_invoice_create end-to-end with valid date reaches handler", reachedHandler,
    `success=${body.success} statusCode=${body.statusCode ?? "n/a"}`);
}

console.log(`\n${passes} pass / ${fails} fail`);
process.exit(fails === 0 ? 0 : 1);
