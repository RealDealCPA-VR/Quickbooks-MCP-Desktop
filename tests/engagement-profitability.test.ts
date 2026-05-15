// qb_engagement_profitability — Per-engagement profitability rollup (Phase 15 #70).
//
// Pure composite over existing session primitives. Coverage walks:
//   1. Tool surface — handler registers under the right name, surfaces the
//      required arg gating (customer + date range).
//   2. Customer lookup — listId/name resolves; missing → 3120; failure path.
//   3. Each of the three sections — revenue / time / reimbursableExpenses —
//      produces the expected payload shape and totals against seeded data
//      plus tool-test additions (Bills with line-level CustomerRef).
//   4. Section toggles + fail-soft + summary gating (summary omitted when
//      any section is error OR any toggled off).
//   5. Multi-customer isolation — lines tagged to a different customer must
//      NOT leak in.

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerEngagementProfitabilityTools } from "../src/tools/engagement-profitability.js";

type Handler = (args: unknown) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

const handlers = new Map<string, Handler>();
const fakeServer = {
  tool: (
    name: string,
    _description: string,
    _schema: Record<string, z.ZodTypeAny>,
    handler: Handler,
  ) => {
    handlers.set(name, handler);
  },
};

function freshSession(): QBSessionManager {
  return new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-engagement-profitability",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

async function call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handler = handlers.get("qb_engagement_profitability");
  if (!handler) throw new Error("qb_engagement_profitability handler not registered");
  const out = await handler(args);
  const text = out.content[0].text;
  return JSON.parse(text);
}

async function callRaw(args: Record<string, unknown>): Promise<{
  isError?: boolean;
  body: Record<string, unknown>;
}> {
  const handler = handlers.get("qb_engagement_profitability");
  if (!handler) throw new Error("qb_engagement_profitability handler not registered");
  const out = await handler(args);
  return { isError: out.isError, body: JSON.parse(out.content[0].text) };
}

// Acme Corporation is in the seed (80000001-1234567890). Sim seeds two of
// Alice's billable hours against Acme + one of Alice's billable hours against
// Global. Acme's seeded invoice T0000001-INV is $7500 on 2024-11-01. We add
// a Bill expense line tagged to Acme to exercise the reimbursable expenses
// path and a non-Acme Bill to test isolation.
const ACME_LIST_ID = "80000001-1234567890";
const ACME_NAME = "Acme Corporation";
const GLOBAL_LIST_ID = "80000002-1234567890";

async function setupSession(): Promise<QBSessionManager> {
  const session = freshSession();
  await session.openSession();
  registerEngagementProfitabilityTools(fakeServer as never, () => session);
  return session;
}

beforeEach(() => {
  handlers.clear();
});

describe("qb_engagement_profitability — registration", () => {
  it("registers under the name qb_engagement_profitability", () => {
    const session = freshSession();
    registerEngagementProfitabilityTools(fakeServer as never, () => session);
    expect(handlers.has("qb_engagement_profitability")).toBe(true);
  });
});

describe("qb_engagement_profitability — required args", () => {
  it("returns 3120 when neither customerListId nor customerName is supplied", async () => {
    await setupSession();
    const { isError, body } = await callRaw({ fromDate: "2024-01-01", toDate: "2024-12-31" });
    expect(isError).toBe(true);
    expect(body.success).toBe(false);
    expect(body.statusCode).toBe(3120);
    expect(String(body.statusMessage)).toMatch(/customerListId or customerName/i);
  });

  it("rejects when fromDate > toDate", async () => {
    await setupSession();
    const { isError, body } = await callRaw({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-12-31",
      toDate: "2024-01-01",
    });
    expect(isError).toBe(true);
    expect(body.statusCode).toBe(3120);
    expect(String(body.statusMessage)).toMatch(/on or before/);
  });

  it("returns 3120 for a customer that does not resolve", async () => {
    await setupSession();
    const { isError, body } = await callRaw({
      customerName: "Nonexistent Customer Co",
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
    });
    expect(isError).toBe(true);
    expect(body.statusCode).toBe(3120);
    expect(String(body.statusMessage)).toMatch(/not found/);
  });

  it("CustomerQueryRq pre-flight failure bubbles up as the whole-tool error", async () => {
    const session = freshSession();
    await session.openSession();
    const original = session.queryEntity.bind(session);
    (session as unknown as { queryEntity: typeof session.queryEntity }).queryEntity
      = async (entity: string, filters: Record<string, unknown> = {}) => {
        if (entity === "Customer") {
          throw Object.assign(new Error("simulated customer lookup failure"), { statusCode: -1 });
        }
        return original(entity, filters);
      };
    registerEngagementProfitabilityTools(fakeServer as never, () => session);
    const { isError, body } = await callRaw({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
    });
    expect(isError).toBe(true);
    expect(body.success).toBe(false);
    expect(String(body.statusMessage)).toContain("pre-flight failed");
  });
});

describe("qb_engagement_profitability — happy path against fresh seed", () => {
  it("resolves customer + returns success with expected top-level shape", async () => {
    await setupSession();
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
    });
    expect(result.success).toBe(true);
    expect(result.fromDate).toBe("2024-01-01");
    expect(result.toDate).toBe("2024-12-31");
    expect(result.basis).toBe("Accrual");
    expect(typeof result.generatedAt).toBe("string");

    const customer = result.customer as Record<string, unknown>;
    expect(customer.listId).toBe(ACME_LIST_ID);
    expect(customer.fullName).toBe(ACME_NAME);
    expect(typeof customer.balance).toBe("number");
  });

  it("customerName lookup resolves to the same customer record", async () => {
    await setupSession();
    const result = await call({
      customerName: ACME_NAME,
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
    });
    const customer = result.customer as Record<string, unknown>;
    expect(customer.listId).toBe(ACME_LIST_ID);
    expect(customer.fullName).toBe(ACME_NAME);
  });

  it("populates sectionStatus with one of ok | skipped | error for every section", async () => {
    await setupSession();
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
    });
    const status = result.sectionStatus as Record<string, string>;
    const allowed = new Set(["ok", "skipped", "error"]);
    for (const key of ["revenue", "time", "reimbursableExpenses"]) {
      expect(status[key]).toBeDefined();
      expect(allowed.has(status[key])).toBe(true);
    }
  });
});

describe("qb_engagement_profitability — revenue section", () => {
  it("captures the seeded $7500 Acme invoice (T0000001-INV)", async () => {
    await setupSession();
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-11-01",
      toDate: "2024-11-30",
    });
    const sections = result.sections as Record<string, Record<string, unknown>>;
    const revenue = sections.revenue;
    expect(revenue.invoiceCount).toBe(1);
    expect(revenue.invoiceTotal).toBe(7500);
    expect(revenue.netRevenue).toBe(7500);
    expect(revenue.salesReceiptCount).toBe(0);
    expect(revenue.creditMemoCount).toBe(0);
    const txns = revenue.transactions as Array<Record<string, unknown>>;
    expect(txns).toHaveLength(1);
    expect(txns[0].txnType).toBe("Invoice");
    expect(txns[0].refNumber).toBe("INV-1001");
    expect(txns[0].amount).toBe(7500);
  });

  it("Global Industries (a different customer) returns its own invoice, not Acme's", async () => {
    await setupSession();
    const result = await call({
      customerListId: GLOBAL_LIST_ID,
      fromDate: "2024-11-01",
      toDate: "2024-11-30",
    });
    const sections = result.sections as Record<string, Record<string, unknown>>;
    const revenue = sections.revenue;
    expect(revenue.invoiceCount).toBe(1);
    expect(revenue.invoiceTotal).toBe(8500);
    const txns = revenue.transactions as Array<Record<string, unknown>>;
    expect(txns[0].refNumber).toBe("INV-1002");
  });

  it("returns empty section when date range excludes all invoices", async () => {
    await setupSession();
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2023-01-01",
      toDate: "2023-12-31",
    });
    const sections = result.sections as Record<string, Record<string, unknown>>;
    const revenue = sections.revenue;
    expect(revenue.invoiceCount).toBe(0);
    expect(revenue.netRevenue).toBe(0);
    expect((revenue.transactions as unknown[]).length).toBe(0);
  });

  it("CreditMemo subtracts from netRevenue and is reported as positive amount", async () => {
    const session = await setupSession();
    await session.addEntity("CreditMemo", {
      CustomerRef: { ListID: ACME_LIST_ID, FullName: ACME_NAME },
      TxnDate: "2024-11-20",
      RefNumber: "CM-001",
      Memo: "Goodwill credit",
      CreditMemoLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 500, Amount: 500 },
      ],
    });
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-11-01",
      toDate: "2024-11-30",
    });
    const sections = result.sections as Record<string, Record<string, unknown>>;
    const revenue = sections.revenue;
    expect(revenue.creditMemoCount).toBe(1);
    expect(revenue.creditMemoTotal).toBe(500);
    expect(revenue.invoiceTotal).toBe(7500);
    expect(revenue.netRevenue).toBe(7000);
    const txns = revenue.transactions as Array<Record<string, unknown>>;
    const cmRow = txns.find((t) => t.txnType === "CreditMemo");
    expect(cmRow).toBeDefined();
    expect(cmRow!.amount).toBe(500); // positive amount; netting happens at the section level
  });

  it("includes SalesReceipt totals", async () => {
    const session = await setupSession();
    await session.addEntity("SalesReceipt", {
      CustomerRef: { ListID: ACME_LIST_ID, FullName: ACME_NAME },
      TxnDate: "2024-11-10",
      RefNumber: "SR-001",
      DepositToAccountRef: { FullName: "Checking" },
      PaymentMethodRef: { FullName: "Check" },
      SalesReceiptLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 2, Rate: 150, Amount: 300 },
      ],
    });
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-11-01",
      toDate: "2024-11-30",
    });
    const revenue = (result.sections as Record<string, Record<string, unknown>>).revenue;
    expect(revenue.salesReceiptCount).toBe(1);
    expect(revenue.salesReceiptTotal).toBe(300);
    expect(revenue.netRevenue).toBe(7800);
  });
});

describe("qb_engagement_profitability — time section", () => {
  it("picks up the two seeded Acme TimeTracking entries (8h + 6.5h = 14.5h, all billable)", async () => {
    await setupSession();
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-11-01",
      toDate: "2024-11-30",
    });
    const time = (result.sections as Record<string, Record<string, unknown>>).time;
    expect(time.entryCount).toBe(2);
    expect(time.totalHours).toBe(14.5);
    expect(time.billableHours).toBe(14.5);
    expect(time.nonBillableHours).toBe(0);
  });

  it("groups by worker (Alice gets both Acme entries totaling 14.5 hours)", async () => {
    await setupSession();
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-11-01",
      toDate: "2024-11-30",
    });
    const time = (result.sections as Record<string, Record<string, unknown>>).time;
    const byWorker = time.byWorker as Array<Record<string, unknown>>;
    expect(byWorker).toHaveLength(1);
    expect(byWorker[0].entityName).toBe("Alice Johnson");
    expect(byWorker[0].hours).toBe(14.5);
    expect(byWorker[0].billableHours).toBe(14.5);
    expect(byWorker[0].entryCount).toBe(2);
  });

  it("groups by service item (Consulting Services collects all 14.5 hours)", async () => {
    await setupSession();
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-11-01",
      toDate: "2024-11-30",
    });
    const time = (result.sections as Record<string, Record<string, unknown>>).time;
    const byItem = time.byServiceItem as Array<Record<string, unknown>>;
    expect(byItem).toHaveLength(1);
    expect(byItem[0].itemServiceName).toBe("Consulting Services");
    expect(byItem[0].hours).toBe(14.5);
  });

  it("Bob's non-billable entry (no customer) does NOT leak in even though it's in the date window", async () => {
    await setupSession();
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-11-01",
      toDate: "2024-11-30",
    });
    const time = (result.sections as Record<string, Record<string, unknown>>).time;
    const entries = time.entries as Array<Record<string, unknown>>;
    // Bob's TxnID is T0000004-TT — must not appear.
    expect(entries.find((e) => e.txnId === "T0000004-TT")).toBeUndefined();
    // Carla's TxnID T0000005-TT (no customer either) — must not appear.
    expect(entries.find((e) => e.txnId === "T0000005-TT")).toBeUndefined();
  });

  it("Global Industries time picks up Alice's PT4H15M entry against Global", async () => {
    await setupSession();
    const result = await call({
      customerListId: GLOBAL_LIST_ID,
      fromDate: "2024-11-01",
      toDate: "2024-11-30",
    });
    const time = (result.sections as Record<string, Record<string, unknown>>).time;
    expect(time.entryCount).toBe(1);
    expect(time.totalHours).toBe(4.25);
    expect(time.billableHours).toBe(4.25);
  });

  it("non-billable customer-tagged entry contributes to totalHours but not billableHours", async () => {
    const session = await setupSession();
    await session.addEntity("TimeTracking", {
      TxnDate: "2024-11-15",
      EntityRef: { ListID: "80000020-1234567890", FullName: "Alice Johnson" },
      CustomerRef: { ListID: ACME_LIST_ID, FullName: ACME_NAME },
      Duration: "PT2H",
      IsBillable: false,
      BillableStatus: "NotBillable",
      Notes: "Non-billable rework",
    });
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-11-01",
      toDate: "2024-11-30",
    });
    const time = (result.sections as Record<string, Record<string, unknown>>).time;
    expect(time.totalHours).toBe(16.5);
    expect(time.billableHours).toBe(14.5);
    expect(time.nonBillableHours).toBe(2);
  });
});

describe("qb_engagement_profitability — reimbursable expenses section", () => {
  it("zero-line section against fresh seed (no Bill/Check/CCC has CustomerRef tagged to Acme)", async () => {
    await setupSession();
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-11-01",
      toDate: "2024-11-30",
    });
    const re = (result.sections as Record<string, Record<string, unknown>>).reimbursableExpenses;
    expect(re.lineCount).toBe(0);
    expect(re.total).toBe(0);
    expect((re.lines as unknown[]).length).toBe(0);
  });

  it("picks up a Bill expense line tagged with CustomerRef = Acme", async () => {
    const session = await setupSession();
    await session.addEntity("Bill", {
      VendorRef: { FullName: "Cloud Hosting Services" },
      TxnDate: "2024-11-10",
      RefNumber: "BILL-CH-NOV",
      ExpenseLineAdd: [
        {
          AccountRef: { FullName: "Utilities" },
          Amount: 250,
          Memo: "Acme staging environment hosting",
          CustomerRef: { ListID: ACME_LIST_ID, FullName: ACME_NAME },
          BillableStatus: "Billable",
        },
      ],
    });
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-11-01",
      toDate: "2024-11-30",
    });
    const re = (result.sections as Record<string, Record<string, unknown>>).reimbursableExpenses;
    expect(re.lineCount).toBe(1);
    expect(re.billCount).toBe(1);
    expect(re.total).toBe(250);
    expect(re.billableTotal).toBe(250);
    expect(re.nonBillableTotal).toBe(0);
    const lines = re.lines as Array<Record<string, unknown>>;
    expect(lines[0].txnType).toBe("Bill");
    expect(lines[0].vendorName).toBe("Cloud Hosting Services");
    expect(lines[0].accountName).toBe("Utilities");
    expect(lines[0].amount).toBe(250);
    expect(lines[0].isBillable).toBe(true);
    expect(lines[0].billableStatus).toBe("Billable");
  });

  it("splits a multi-line Bill — only lines tagged to Acme contribute", async () => {
    const session = await setupSession();
    await session.addEntity("Bill", {
      VendorRef: { FullName: "Cloud Hosting Services" },
      TxnDate: "2024-11-12",
      RefNumber: "BILL-CH-NOV-MULTI",
      ExpenseLineAdd: [
        {
          AccountRef: { FullName: "Utilities" },
          Amount: 100,
          CustomerRef: { ListID: ACME_LIST_ID, FullName: ACME_NAME },
          BillableStatus: "Billable",
        },
        {
          AccountRef: { FullName: "Utilities" },
          Amount: 200,
          CustomerRef: { ListID: GLOBAL_LIST_ID, FullName: "Global Industries" },
          BillableStatus: "Billable",
        },
        {
          AccountRef: { FullName: "Utilities" },
          Amount: 50,
          // Untagged — internal overhead, not job-costed.
        },
      ],
    });
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-11-01",
      toDate: "2024-11-30",
    });
    const re = (result.sections as Record<string, Record<string, unknown>>).reimbursableExpenses;
    expect(re.lineCount).toBe(1);
    expect(re.total).toBe(100);
    expect(re.billCount).toBe(1);
  });

  it("Check expense line tagged to Acme contributes via PayeeEntityRef path", async () => {
    const session = await setupSession();
    await session.addEntity("Check", {
      AccountRef: { FullName: "Checking" },
      PayeeEntityRef: { FullName: "Joe Contractor" },
      TxnDate: "2024-11-15",
      RefNumber: "CHK-2001",
      ExpenseLineAdd: [
        {
          AccountRef: { FullName: "Payroll Expense" },
          Amount: 1500,
          Memo: "1099 subcontractor for Acme work",
          CustomerRef: { ListID: ACME_LIST_ID, FullName: ACME_NAME },
          BillableStatus: "Billable",
        },
      ],
    });
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-11-01",
      toDate: "2024-11-30",
    });
    const re = (result.sections as Record<string, Record<string, unknown>>).reimbursableExpenses;
    const lines = re.lines as Array<Record<string, unknown>>;
    const check = lines.find((l) => l.txnType === "Check");
    expect(check).toBeDefined();
    expect(check!.vendorName).toBe("Joe Contractor");
    expect(check!.amount).toBe(1500);
    expect(re.checkCount).toBe(1);
  });

  it("non-billable customer-tagged line still counts toward total but bucketed as nonBillableTotal", async () => {
    const session = await setupSession();
    await session.addEntity("Bill", {
      VendorRef: { FullName: "Cloud Hosting Services" },
      TxnDate: "2024-11-18",
      RefNumber: "BILL-NB",
      ExpenseLineAdd: [
        {
          AccountRef: { FullName: "Utilities" },
          Amount: 80,
          CustomerRef: { ListID: ACME_LIST_ID, FullName: ACME_NAME },
          BillableStatus: "NotBillable",
        },
      ],
    });
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-11-01",
      toDate: "2024-11-30",
    });
    const re = (result.sections as Record<string, Record<string, unknown>>).reimbursableExpenses;
    expect(re.total).toBe(80);
    expect(re.billableTotal).toBe(0);
    expect(re.nonBillableTotal).toBe(80);
  });
});

describe("qb_engagement_profitability — summary block", () => {
  it("emits summary with revenue / cost / margin / billableRate when all three sections succeed", async () => {
    const session = await setupSession();
    await session.addEntity("Bill", {
      VendorRef: { FullName: "Cloud Hosting Services" },
      TxnDate: "2024-11-10",
      RefNumber: "BILL-SUMM",
      ExpenseLineAdd: [
        {
          AccountRef: { FullName: "Utilities" },
          Amount: 500,
          CustomerRef: { ListID: ACME_LIST_ID, FullName: ACME_NAME },
          BillableStatus: "Billable",
        },
      ],
    });
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-11-01",
      toDate: "2024-11-30",
    });
    const summary = result.summary as Record<string, number>;
    expect(summary).toBeDefined();
    expect(summary.revenue).toBe(7500);
    expect(summary.reimbursableExpenseCost).toBe(500);
    expect(summary.grossProfit).toBe(7000);
    expect(summary.marginPct).toBeCloseTo(93.33, 1);
    expect(summary.billableHours).toBe(14.5);
    expect(summary.totalHours).toBe(14.5);
    expect(summary.revenuePerHour).toBeCloseTo(517.24, 1);
    expect(summary.billableRate).toBeCloseTo(517.24, 1);
  });

  it("revenuePerHour and billableRate are null when zero hours logged", async () => {
    await setupSession();
    const result = await call({
      customerListId: "80000003-1234567890", // TechStart — no time or invoices
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
    });
    const summary = result.summary as Record<string, number | null>;
    expect(summary.totalHours).toBe(0);
    expect(summary.revenuePerHour).toBeNull();
    expect(summary.billableRate).toBeNull();
  });

  it("marginPct is null when revenue is zero", async () => {
    await setupSession();
    const result = await call({
      customerListId: "80000003-1234567890",
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
    });
    const summary = result.summary as Record<string, number | null>;
    expect(summary.revenue).toBe(0);
    expect(summary.marginPct).toBeNull();
  });

  it("summary is OMITTED when one of the three sections is toggled off", async () => {
    await setupSession();
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-11-01",
      toDate: "2024-11-30",
      includeReimbursableExpenses: false,
    });
    expect(result.summary).toBeUndefined();
    const status = result.sectionStatus as Record<string, string>;
    expect(status.reimbursableExpenses).toBe("skipped");
    expect(status.revenue).toBe("ok");
    expect(status.time).toBe("ok");
  });
});

describe("qb_engagement_profitability — section toggles", () => {
  it("includeRevenue: false skips the revenue section", async () => {
    await setupSession();
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-11-01",
      toDate: "2024-11-30",
      includeRevenue: false,
    });
    const sections = result.sections as Record<string, unknown>;
    expect(sections.revenue).toBeUndefined();
    expect((result.sectionStatus as Record<string, string>).revenue).toBe("skipped");
    expect(sections.time).toBeDefined();
    expect(sections.reimbursableExpenses).toBeDefined();
  });

  it("includeTime: false skips the time section", async () => {
    await setupSession();
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-11-01",
      toDate: "2024-11-30",
      includeTime: false,
    });
    const sections = result.sections as Record<string, unknown>;
    expect(sections.time).toBeUndefined();
    expect((result.sectionStatus as Record<string, string>).time).toBe("skipped");
  });

  it("all three toggles off → empty sections + sectionStatus all skipped + no summary", async () => {
    await setupSession();
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-11-01",
      toDate: "2024-11-30",
      includeRevenue: false,
      includeTime: false,
      includeReimbursableExpenses: false,
    });
    expect(result.success).toBe(true);
    expect(result.summary).toBeUndefined();
    const status = result.sectionStatus as Record<string, string>;
    for (const v of Object.values(status)) expect(v).toBe("skipped");
  });
});

describe("qb_engagement_profitability — fail-soft contract", () => {
  it("a single section's wire failure lands in sections.<name>.error and the rest still return", async () => {
    const session = freshSession();
    await session.openSession();
    const original = session.queryEntity.bind(session);
    (session as unknown as { queryEntity: typeof session.queryEntity }).queryEntity
      = async (entity: string, filters: Record<string, unknown> = {}) => {
        if (entity === "TimeTracking") {
          throw Object.assign(new Error("synthetic timetracking failure"), { statusCode: 3120 });
        }
        return original(entity, filters);
      };
    registerEngagementProfitabilityTools(fakeServer as never, () => session);
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-11-01",
      toDate: "2024-11-30",
    });
    expect(result.success).toBe(true);
    const status = result.sectionStatus as Record<string, string>;
    expect(status.time).toBe("error");
    expect(status.revenue).toBe("ok");
    expect(status.reimbursableExpenses).toBe("ok");
    const sections = result.sections as Record<string, Record<string, unknown>>;
    const timeBlock = sections.time;
    expect(timeBlock.error).toBeDefined();
    const errBlock = timeBlock.error as Record<string, unknown>;
    expect(errBlock.statusCode).toBe(3120);
    expect(String(errBlock.statusMessage)).toContain("synthetic timetracking failure");
  });

  it("summary is OMITTED when any section is in error", async () => {
    const session = freshSession();
    await session.openSession();
    const original = session.queryEntity.bind(session);
    (session as unknown as { queryEntity: typeof session.queryEntity }).queryEntity
      = async (entity: string, filters: Record<string, unknown> = {}) => {
        if (entity === "TimeTracking") {
          throw Object.assign(new Error("synthetic failure"), { statusCode: 3120 });
        }
        return original(entity, filters);
      };
    registerEngagementProfitabilityTools(fakeServer as never, () => session);
    const result = await call({
      customerListId: ACME_LIST_ID,
      fromDate: "2024-11-01",
      toDate: "2024-11-30",
    });
    expect(result.summary).toBeUndefined();
  });
});
