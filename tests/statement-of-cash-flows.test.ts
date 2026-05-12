// Phase 11 #54 — qb_statement_of_cash_flows.
//
// Coverage layers:
//   1. Sim handler — buildStatementOfCashFlows via session.runReport
//      (Operating section indirect-method math, Investing/Financing walks
//      from JE postings to FA/OA/LongTermLiability/Equity, period date
//      filter, cash totals reconcile).
//   2. Tool surface — qb_statement_of_cash_flows happy paths, empty
//      sections in default seed, error wrapping.
//   3. Live adapter — adaptLiveReportRet handling of the SCF row tree
//      (Operating/Investing/Financing section detection, close-label
//      variants, totals extraction).

import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerReportTools } from "../src/tools/reports.js";
import { adaptLiveReportRet } from "../src/qbxml/parser.js";

type Handler = (args: unknown) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;
const handlers = new Map<string, Handler>();
const schemas = new Map<string, Record<string, z.ZodTypeAny>>();
const fakeServer = {
  tool: (
    name: string,
    _description: string,
    schema: Record<string, z.ZodTypeAny>,
    handler: Handler,
  ) => {
    handlers.set(name, handler);
    schemas.set(name, schema);
  },
};

let session: QBSessionManager;

beforeAll(async () => {
  session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-statement-of-cash-flows",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  registerReportTools(fakeServer as never, () => session);
  await session.openSession();

  // Seed Investing/Financing-capable accounts. Default sim seed has only
  // Bank/AR/AP/Income/COGS/Expense; SCF would have empty Investing and
  // Financing sections without these. Adding them up front rather than per
  // test so the period scope tests can use them too.
  await session.addEntity("Account", {
    Name: "Equipment",
    FullName: "Equipment",
    AccountType: "FixedAsset",
    AccountNumber: "1500",
    Balance: 0,
  });
  await session.addEntity("Account", {
    Name: "Long-Term Loan",
    FullName: "Long-Term Loan",
    AccountType: "LongTermLiability",
    AccountNumber: "2500",
    Balance: 0,
  });
  await session.addEntity("Account", {
    Name: "Owner's Equity",
    FullName: "Owner's Equity",
    AccountType: "Equity",
    AccountNumber: "3000",
    Balance: 0,
  });
});

describe("simulation: buildStatementOfCashFlows", () => {
  it("returns the canonical 3-section shape with the canonical totals keys", async () => {
    const ret = await session.runReport("StatementOfCashFlows", {});

    expect(ret.ReportTitle).toBe("Statement of Cash Flows");
    expect(ret.ReportBasis).toBe("Accrual");

    const sections = ret.Sections as Array<{ Name: string; Accounts: Array<{ Name: string; Total: number }>; Subtotal: number }>;
    expect(sections.map((s) => s.Name)).toEqual([
      "Operating Activities",
      "Investing Activities",
      "Financing Activities",
    ]);

    const totals = ret.Totals as Record<string, number>;
    expect(Object.keys(totals).sort()).toEqual([
      "CashAtBeginningOfPeriod",
      "CashAtEndOfPeriod",
      "NetCashIncrease",
    ]);
  });

  it("Operating section: includes Net Income + AR + AP rows that reconcile to the subtotal", async () => {
    // Run with a wide-open window so seed + ad-hoc additions are captured.
    const ret = await session.runReport("StatementOfCashFlows", {
      fromDate: "2020-01-01",
      toDate: "2099-12-31",
    });
    const operating = (ret.Sections as Array<{ Name: string; Accounts: Array<{ Name: string; Total: number }>; Subtotal: number }>).find(
      (s) => s.Name === "Operating Activities",
    );
    expect(operating).toBeDefined();

    const rowNames = operating!.Accounts.map((a) => a.Name);
    expect(rowNames).toContain("Net Income");
    expect(rowNames).toContain("Accounts Receivable");
    expect(rowNames).toContain("Accounts Payable");

    const sum = operating!.Accounts.reduce((s, a) => s + a.Total, 0);
    expect(Math.abs(sum - operating!.Subtotal)).toBeLessThan(0.01);
  });

  it("Operating ΔAR: invoice posted in period drops AR-row by full invoice amount (use of cash)", async () => {
    // Fresh session + ad-hoc AR-only setup, so other tests' seed entropy
    // doesn't muddy the math.
    const local = new QBSessionManager({
      companyFile: "simulation",
      appName: "vitest-scf-ar",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
    await local.openSession();

    await local.addEntity("Invoice", {
      CustomerRef: { FullName: "Acme Corporation" },
      TxnDate: "2026-04-15",
      InvoiceLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 10, Rate: 150 },
      ],
    });

    const ret = await local.runReport("StatementOfCashFlows", {
      fromDate: "2026-04-01",
      toDate: "2026-04-30",
    });
    const operating = (ret.Sections as Array<{ Name: string; Accounts: Array<{ Name: string; Total: number }>; Subtotal: number }>).find(
      (s) => s.Name === "Operating Activities",
    );
    const ar = operating!.Accounts.find((a) => a.Name === "Accounts Receivable")!;
    // Invoice posts 1500 to AR; AR change = +1500; Operating impact = -1500.
    expect(ar.Total).toBe(-1500);

    // Payment in the same period offsets it.
    await local.addEntity("ReceivePayment", {
      CustomerRef: { FullName: "Acme Corporation" },
      TxnDate: "2026-04-20",
      TotalAmount: 1500,
    });
    const ret2 = await local.runReport("StatementOfCashFlows", {
      fromDate: "2026-04-01",
      toDate: "2026-04-30",
    });
    const ar2 = (ret2.Sections as Array<{ Name: string; Accounts: Array<{ Name: string; Total: number }>; Subtotal: number }>)
      .find((s) => s.Name === "Operating Activities")!
      .Accounts.find((a) => a.Name === "Accounts Receivable")!;
    // Net AR change in window = 0; row total = 0. (Use toBeCloseTo to dodge
    // JS's -0 vs +0 distinction — Math.round(-0 * 100) / 100 stays signed.)
    expect(ar2.Total).toBeCloseTo(0, 6);
  });

  it("Operating ΔAP: bill posted in period lifts AP-row by full bill amount (source of cash)", async () => {
    const local = new QBSessionManager({
      companyFile: "simulation",
      appName: "vitest-scf-ap",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
    await local.openSession();

    await local.addEntity("Bill", {
      VendorRef: { FullName: "Office Supplies Co" },
      TxnDate: "2026-03-10",
      ExpenseLineAdd: [
        { AccountRef: { FullName: "Utilities" }, Amount: 800 },
      ],
    });

    const ret = await local.runReport("StatementOfCashFlows", {
      fromDate: "2026-03-01",
      toDate: "2026-03-31",
    });
    const operating = (ret.Sections as Array<{ Name: string; Accounts: Array<{ Name: string; Total: number }>; Subtotal: number }>).find(
      (s) => s.Name === "Operating Activities",
    );
    const ap = operating!.Accounts.find((a) => a.Name === "Accounts Payable")!;
    // Bill posts 800 to AP; AP change = +800; Operating impact = +800.
    expect(ap.Total).toBe(800);
  });

  it("Investing section: JE debit to a FixedAsset account in period emits a negative row (use of cash)", async () => {
    // "Bought equipment via JE: Debit Equipment 10000 / Credit Bank 10000"
    await session.addEntity("JournalEntry", {
      TxnDate: "2026-06-15",
      JournalDebitLineAdd: [
        { AccountRef: { FullName: "Equipment" }, Amount: 10000 },
      ],
      JournalCreditLineAdd: [
        { AccountRef: { FullName: "Checking" }, Amount: 10000 },
      ],
    });

    const ret = await session.runReport("StatementOfCashFlows", {
      fromDate: "2026-06-01",
      toDate: "2026-06-30",
    });
    const investing = (ret.Sections as Array<{ Name: string; Accounts: Array<{ Name: string; Total: number }>; Subtotal: number }>).find(
      (s) => s.Name === "Investing Activities",
    );
    expect(investing).toBeDefined();
    const eq = investing!.Accounts.find((a) => a.Name === "Equipment");
    expect(eq).toBeDefined();
    // Debit to Equipment = asset balance up = USE of cash. Row total = credit − debit = -10000.
    expect(eq!.Total).toBe(-10000);
    expect(investing!.Subtotal).toBe(-10000);
  });

  it("Financing section: JE credit to LongTermLiability in period emits a positive row (source of cash)", async () => {
    // "Borrowed money: Debit Bank 50000 / Credit Long-Term Loan 50000"
    await session.addEntity("JournalEntry", {
      TxnDate: "2026-07-01",
      JournalDebitLineAdd: [
        { AccountRef: { FullName: "Checking" }, Amount: 50000 },
      ],
      JournalCreditLineAdd: [
        { AccountRef: { FullName: "Long-Term Loan" }, Amount: 50000 },
      ],
    });

    const ret = await session.runReport("StatementOfCashFlows", {
      fromDate: "2026-07-01",
      toDate: "2026-07-31",
    });
    const financing = (ret.Sections as Array<{ Name: string; Accounts: Array<{ Name: string; Total: number }>; Subtotal: number }>).find(
      (s) => s.Name === "Financing Activities",
    );
    const loan = financing!.Accounts.find((a) => a.Name === "Long-Term Loan");
    expect(loan).toBeDefined();
    // Credit to liability = liability balance up = SOURCE of cash. Row total = credit − debit = +50000.
    expect(loan!.Total).toBe(50000);
    expect(financing!.Subtotal).toBe(50000);
  });

  it("Financing section: equity contribution and distribution net correctly", async () => {
    // Local session — clean slate of FixedAsset/LongTermLiability/Equity walks.
    const local = new QBSessionManager({
      companyFile: "simulation",
      appName: "vitest-scf-equity",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
    await local.openSession();
    await local.addEntity("Account", {
      Name: "Owner's Equity",
      FullName: "Owner's Equity",
      AccountType: "Equity",
      AccountNumber: "3000",
      Balance: 0,
    });

    // Contribution: Debit Bank 20000 / Credit Owner's Equity 20000 — source of cash (+20000).
    await local.addEntity("JournalEntry", {
      TxnDate: "2026-02-01",
      JournalDebitLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 20000 }],
      JournalCreditLineAdd: [{ AccountRef: { FullName: "Owner's Equity" }, Amount: 20000 }],
    });
    // Distribution: Debit Owner's Equity 5000 / Credit Bank 5000 — use of cash (-5000).
    await local.addEntity("JournalEntry", {
      TxnDate: "2026-02-15",
      JournalDebitLineAdd: [{ AccountRef: { FullName: "Owner's Equity" }, Amount: 5000 }],
      JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 5000 }],
    });

    const ret = await local.runReport("StatementOfCashFlows", {
      fromDate: "2026-02-01",
      toDate: "2026-02-28",
    });
    const financing = (ret.Sections as Array<{ Name: string; Accounts: Array<{ Name: string; Total: number }>; Subtotal: number }>).find(
      (s) => s.Name === "Financing Activities",
    );
    const eq = financing!.Accounts.find((a) => a.Name === "Owner's Equity");
    expect(eq).toBeDefined();
    expect(eq!.Total).toBe(15000); // +20000 − 5000
    expect(financing!.Subtotal).toBe(15000);
  });

  it("date filter: postings outside the window don't contribute", async () => {
    const local = new QBSessionManager({
      companyFile: "simulation",
      appName: "vitest-scf-window",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
    await local.openSession();
    await local.addEntity("Account", {
      Name: "Equipment",
      FullName: "Equipment",
      AccountType: "FixedAsset",
      AccountNumber: "1500",
      Balance: 0,
    });
    // Posting outside the test window
    await local.addEntity("JournalEntry", {
      TxnDate: "2026-01-15",
      JournalDebitLineAdd: [{ AccountRef: { FullName: "Equipment" }, Amount: 5000 }],
      JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 5000 }],
    });

    const ret = await local.runReport("StatementOfCashFlows", {
      fromDate: "2026-03-01",
      toDate: "2026-03-31",
    });
    const investing = (ret.Sections as Array<{ Name: string; Accounts: Array<{ Name: string; Total: number }>; Subtotal: number }>).find(
      (s) => s.Name === "Investing Activities",
    );
    expect(investing!.Accounts).toEqual([]);
    expect(investing!.Subtotal).toBe(0);
  });

  it("cash totals reconcile: cashAtEnd − netCashIncrease = cashAtBeginning by construction", async () => {
    const ret = await session.runReport("StatementOfCashFlows", {
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
    });
    const totals = ret.Totals as Record<string, number>;
    expect(
      Math.abs((totals.CashAtEndOfPeriod - totals.NetCashIncrease) - totals.CashAtBeginningOfPeriod),
    ).toBeLessThan(0.01);
  });

  it("cashAtEndOfPeriod equals sum of Bank account balances in the seed", async () => {
    // Default sim seed: Checking 45000 + Savings 120000 = 165000.
    const local = new QBSessionManager({
      companyFile: "simulation",
      appName: "vitest-scf-bank-sum",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
    await local.openSession();
    const ret = await local.runReport("StatementOfCashFlows", {});
    const totals = ret.Totals as Record<string, number>;
    expect(totals.CashAtEndOfPeriod).toBe(165000);
  });

  it("section subtotals sum to NetCashIncrease", async () => {
    const ret = await session.runReport("StatementOfCashFlows", {
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
    });
    const sections = ret.Sections as Array<{ Subtotal: number }>;
    const totals = ret.Totals as Record<string, number>;
    const sectionSum = sections.reduce((s, sec) => s + sec.Subtotal, 0);
    expect(Math.abs(sectionSum - totals.NetCashIncrease)).toBeLessThan(0.01);
  });

  it("filters out zero-net accounts from Investing/Financing", async () => {
    // Equal debit and credit to Equipment within window — net 0, should drop.
    const local = new QBSessionManager({
      companyFile: "simulation",
      appName: "vitest-scf-zero",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
    await local.openSession();
    await local.addEntity("Account", {
      Name: "Equipment",
      FullName: "Equipment",
      AccountType: "FixedAsset",
      AccountNumber: "1500",
      Balance: 0,
    });
    await local.addEntity("JournalEntry", {
      TxnDate: "2026-05-01",
      JournalDebitLineAdd: [{ AccountRef: { FullName: "Equipment" }, Amount: 1000 }],
      JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 1000 }],
    });
    await local.addEntity("JournalEntry", {
      TxnDate: "2026-05-15",
      JournalDebitLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 1000 }],
      JournalCreditLineAdd: [{ AccountRef: { FullName: "Equipment" }, Amount: 1000 }],
    });

    const ret = await local.runReport("StatementOfCashFlows", {
      fromDate: "2026-05-01",
      toDate: "2026-05-31",
    });
    const investing = (ret.Sections as Array<{ Name: string; Accounts: Array<{ Name: string; Total: number }>; Subtotal: number }>).find(
      (s) => s.Name === "Investing Activities",
    );
    expect(investing!.Accounts).toEqual([]);
    expect(investing!.Subtotal).toBe(0);
  });
});

describe("tool surface: qb_statement_of_cash_flows", () => {
  it("returns canonical sections + totals for the default-seed sim", async () => {
    const handler = handlers.get("qb_statement_of_cash_flows")!;
    expect(handler).toBeDefined();
    const res = await handler({ fromDate: "2026-01-01", toDate: "2026-12-31" });
    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.reportTitle).toBe("Statement of Cash Flows");
    expect(payload.reportPeriod).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(payload.sections.map((s: { name: string }) => s.name)).toEqual([
      "Operating Activities",
      "Investing Activities",
      "Financing Activities",
    ]);
    expect(payload).toHaveProperty("netCashIncrease");
    expect(payload).toHaveProperty("cashAtBeginningOfPeriod");
    expect(payload).toHaveProperty("cashAtEndOfPeriod");
  });

  it("schema rejects malformed date strings", () => {
    const schema = schemas.get("qb_statement_of_cash_flows")!;
    const parsed = z.object(schema).safeParse({ fromDate: "not-a-date" });
    expect(parsed.success).toBe(false);
  });

  it("error path: surfaces statusCode + humanReadable when runReport throws", async () => {
    const handler = handlers.get("qb_statement_of_cash_flows")!;
    const errSession = new QBSessionManager({
      companyFile: "simulation",
      appName: "vitest-scf-err",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
    await errSession.openSession();
    const origRun = errSession.runReport.bind(errSession);
    (errSession as unknown as { runReport: unknown }).runReport = async () => {
      const e = new Error("simulated failure") as Error & { statusCode: number };
      e.statusCode = 3120;
      throw e;
    };
    // Re-register tools against the broken session.
    const localHandlers = new Map<string, Handler>();
    const localServer = {
      tool: (n: string, _d: string, _s: unknown, h: Handler) => { localHandlers.set(n, h); },
    };
    registerReportTools(localServer as never, () => errSession);
    const res = await localHandlers.get("qb_statement_of_cash_flows")!({});
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.statusCode).toBe(3120);
    expect(payload.humanReadable).toBeDefined();
    (errSession as unknown as { runReport: typeof origRun }).runReport = origRun;
    // Restore real handler for follow-on tests
    handlers.set("qb_statement_of_cash_flows", handler);
  });
});

describe("live adapter: adaptLiveReportRet on SCF row tree", () => {
  // Synthetic fixture mimicking the live QB SCF row shape — three sections
  // with a single DataRow each, closing SubtotalRows, then the cash totals
  // as TotalRows. Captures the label variants the adapter needs to handle.
  const SCF_FIXTURE = {
    ReportTitle: "Statement of Cash Flows",
    ReportSubtitle: "January through December 2026",
    ReportBasis: "Accrual",
    ReportData: {
      TextRow: [
        { "@_rowNumber": 1, "@_value": "OPERATING Activities" },
        { "@_rowNumber": 5, "@_value": "INVESTING Activities" },
        { "@_rowNumber": 8, "@_value": "FINANCING Activities" },
      ],
      DataRow: [
        { "@_rowNumber": 2, ColData: [{ "@_colID": 1, "@_value": "Net Income" }, { "@_colID": 2, "@_value": 14336.5 }] },
        { "@_rowNumber": 3, ColData: [{ "@_colID": 1, "@_value": "Accounts Receivable" }, { "@_colID": 2, "@_value": -5000 }] },
        { "@_rowNumber": 6, ColData: [{ "@_colID": 1, "@_value": "Equipment" }, { "@_colID": 2, "@_value": -10000 }] },
        { "@_rowNumber": 9, ColData: [{ "@_colID": 1, "@_value": "Long-Term Loan" }, { "@_colID": 2, "@_value": 50000 }] },
      ],
      SubtotalRow: [
        // Close labels vary — QB sometimes emits "Net cash provided by..." and
        // sometimes "Total ...". Both must close the section.
        { "@_rowNumber": 4, ColData: [{ "@_colID": 1, "@_value": "Net cash provided by operating activities" }, { "@_colID": 2, "@_value": 9336.5 }] },
        { "@_rowNumber": 7, ColData: [{ "@_colID": 1, "@_value": "Net cash provided by investing activities" }, { "@_colID": 2, "@_value": -10000 }] },
        { "@_rowNumber": 10, ColData: [{ "@_colID": 1, "@_value": "Net cash provided by financing activities" }, { "@_colID": 2, "@_value": 50000 }] },
        { "@_rowNumber": 12, ColData: [{ "@_colID": 1, "@_value": "Cash at beginning of period" }, { "@_colID": 2, "@_value": 165000 }] },
      ],
      TotalRow: [
        { "@_rowNumber": 11, ColData: [{ "@_colID": 1, "@_value": "Net cash increase for period" }, { "@_colID": 2, "@_value": 49336.5 }] },
        { "@_rowNumber": 13, ColData: [{ "@_colID": 1, "@_value": "Cash at end of period" }, { "@_colID": 2, "@_value": 214336.5 }] },
      ],
    },
  };

  it("routes the SCF fixture through the section-based adapter", () => {
    const adapted = adaptLiveReportRet(SCF_FIXTURE);
    expect(adapted.ReportTitle).toBe("Statement of Cash Flows");
    expect(adapted.ReportSubtitle).toBe("January through December 2026");
    const sections = adapted.Sections as Array<{ Name: string; Accounts: Array<{ Name: string; Total: number }>; Subtotal: number }>;
    expect(sections.map((s) => s.Name)).toEqual([
      "Operating Activities",
      "Investing Activities",
      "Financing Activities",
    ]);
  });

  it("accumulates each section's DataRows under the right section + closes on Net-cash-provided-by labels", () => {
    const adapted = adaptLiveReportRet(SCF_FIXTURE);
    const sections = adapted.Sections as Array<{ Name: string; Accounts: Array<{ Name: string; Total: number }>; Subtotal: number }>;

    const op = sections.find((s) => s.Name === "Operating Activities")!;
    expect(op.Accounts).toEqual([
      { Name: "Net Income", Total: 14336.5 },
      { Name: "Accounts Receivable", Total: -5000 },
    ]);
    expect(op.Subtotal).toBe(9336.5);

    const inv = sections.find((s) => s.Name === "Investing Activities")!;
    expect(inv.Accounts).toEqual([{ Name: "Equipment", Total: -10000 }]);
    expect(inv.Subtotal).toBe(-10000);

    const fin = sections.find((s) => s.Name === "Financing Activities")!;
    expect(fin.Accounts).toEqual([{ Name: "Long-Term Loan", Total: 50000 }]);
    expect(fin.Subtotal).toBe(50000);
  });

  it("extracts NetCashIncrease + CashAtBeginning + CashAtEnd from the TotalRow / SubtotalRow tail", () => {
    const adapted = adaptLiveReportRet(SCF_FIXTURE);
    const totals = adapted.Totals as Record<string, number>;
    expect(totals.NetCashIncrease).toBe(49336.5);
    expect(totals.CashAtBeginningOfPeriod).toBe(165000);
    expect(totals.CashAtEndOfPeriod).toBe(214336.5);
  });

  it("handles 'Net cash used in' close-label variant (negative-section idiom)", () => {
    // QB swaps "provided by" → "used in" when the section subtotal is negative.
    const fixture = {
      ReportTitle: "Statement of Cash Flows",
      ReportBasis: "Accrual",
      ReportData: {
        TextRow: [{ "@_rowNumber": 1, "@_value": "OPERATING Activities" }],
        DataRow: [
          { "@_rowNumber": 2, ColData: [{ "@_colID": 1, "@_value": "Net Income" }, { "@_colID": 2, "@_value": -3000 }] },
        ],
        SubtotalRow: [
          { "@_rowNumber": 3, ColData: [{ "@_colID": 1, "@_value": "Net cash used in operating activities" }, { "@_colID": 2, "@_value": -3000 }] },
        ],
      },
    };
    const adapted = adaptLiveReportRet(fixture);
    const sections = adapted.Sections as Array<{ Name: string; Subtotal: number }>;
    expect(sections).toHaveLength(1);
    expect(sections[0].Name).toBe("Operating Activities");
    expect(sections[0].Subtotal).toBe(-3000);
  });

  it("handles 'Cash provided by operating activities' as a section-open TextRow", () => {
    // Older / locale variant: section is opened by the descriptive label
    // rather than the bare "OPERATING Activities".
    const fixture = {
      ReportTitle: "Statement of Cash Flows",
      ReportBasis: "Accrual",
      ReportData: {
        TextRow: [{ "@_rowNumber": 1, "@_value": "Cash from operating activities" }],
        DataRow: [
          { "@_rowNumber": 2, ColData: [{ "@_colID": 1, "@_value": "Net Income" }, { "@_colID": 2, "@_value": 1000 }] },
        ],
        SubtotalRow: [
          { "@_rowNumber": 3, ColData: [{ "@_colID": 1, "@_value": "Total operating activities" }, { "@_colID": 2, "@_value": 1000 }] },
        ],
      },
    };
    const adapted = adaptLiveReportRet(fixture);
    const sections = adapted.Sections as Array<{ Name: string; Subtotal: number }>;
    expect(sections[0].Name).toBe("Operating Activities");
    expect(sections[0].Subtotal).toBe(1000);
  });

  it("falls back to summed section subtotals when no 'Net cash increase' total is emitted", () => {
    // Defensive: some QB versions / locales might omit the bottom-of-report
    // grand-total row entirely. The adapter falls back to summing the three
    // section subtotals.
    const fixture = {
      ReportTitle: "Statement of Cash Flows",
      ReportBasis: "Accrual",
      ReportData: {
        TextRow: [
          { "@_rowNumber": 1, "@_value": "OPERATING Activities" },
          { "@_rowNumber": 4, "@_value": "INVESTING Activities" },
        ],
        DataRow: [
          { "@_rowNumber": 2, ColData: [{ "@_colID": 1, "@_value": "Net Income" }, { "@_colID": 2, "@_value": 100 }] },
          { "@_rowNumber": 5, ColData: [{ "@_colID": 1, "@_value": "Equipment" }, { "@_colID": 2, "@_value": -25 }] },
        ],
        SubtotalRow: [
          { "@_rowNumber": 3, ColData: [{ "@_colID": 1, "@_value": "Net cash provided by operating activities" }, { "@_colID": 2, "@_value": 100 }] },
          { "@_rowNumber": 6, ColData: [{ "@_colID": 1, "@_value": "Net cash used in investing activities" }, { "@_colID": 2, "@_value": -25 }] },
        ],
      },
    };
    const adapted = adaptLiveReportRet(fixture);
    const totals = adapted.Totals as Record<string, number>;
    expect(totals.NetCashIncrease).toBe(75); // 100 + -25
  });
});

describe("sim reportType whitelist: rejects unsupported types", () => {
  it("returns statusCode 3120 with a helpful message for non-whitelisted types", async () => {
    // Defensive — the whitelist message lists all five supported types.
    // Pinning so a future edit to the list updates this test in lockstep.
    await expect(async () => {
      await session.runReport("UnsupportedReportType" as never, {});
    }).rejects.toThrow(/StatementOfCashFlows/);
  });
});
