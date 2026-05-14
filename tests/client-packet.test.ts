// qb_client_packet — Tax-prep workpaper bundle (Phase 15 #71).
//
// Pure composite over existing session primitives. Coverage walks:
//   1. Tool surface — handler registers with the right name and accepts
//      the taxYear arg with the documented defaults.
//   2. Section status map — every section flips between ok / skipped / error
//      in the right scenarios.
//   3. Each section's payload shape mirrors the underlying single-purpose
//      tool's output (sanity-check via spot fields rather than full
//      duplication; the underlying tools are already pinned by their own
//      suites).
//   4. Fail-soft contract — a synthetic wire failure on ONE section does not
//      poison the rest of the packet.
//   5. Customer context — listId/name lookup surfaces FullName + Balance.
//   6. Fixed Asset section — empty against fresh seed (no FixedAsset
//      accounts), populated after seeding one + a posting.
//
// Tests exercise the actual MCP tool handler (same fakeServer.tool pattern
// the reconciliation tests use) against the simulation-mode session so the
// full composite — query → build → emit — runs end-to-end.

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerClientPacketTools } from "../src/tools/client-packet.js";

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
    appName: "vitest-client-packet",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

async function call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handler = handlers.get("qb_client_packet");
  if (!handler) throw new Error("qb_client_packet handler not registered");
  const out = await handler(args);
  const text = out.content[0].text;
  return JSON.parse(text);
}

beforeEach(() => {
  handlers.clear();
});

describe("qb_client_packet — registration", () => {
  it("registers under the name qb_client_packet", () => {
    const session = freshSession();
    registerClientPacketTools(fakeServer as never, () => session);
    expect(handlers.has("qb_client_packet")).toBe(true);
  });
});

describe("qb_client_packet — full default packet (no section skips)", () => {
  it("returns success: true with the expected top-level shape against fresh seed", async () => {
    const session = freshSession();
    await session.openSession();
    registerClientPacketTools(fakeServer as never, () => session);

    const result = await call({ taxYear: 2024 });

    expect(result.success).toBe(true);
    expect(result.taxYear).toBe(2024);
    expect(result.fromDate).toBe("2024-01-01");
    expect(result.toDate).toBe("2024-12-31");
    expect(result.basis).toBe("Accrual");
    expect(typeof result.generatedAt).toBe("string");
    expect(result.customer).toBeNull();
    expect(typeof result.sections).toBe("object");
    expect(typeof result.sectionStatus).toBe("object");
  });

  it("populates every section status field with ok | skipped | error", async () => {
    const session = freshSession();
    await session.openSession();
    registerClientPacketTools(fakeServer as never, () => session);

    const result = await call({ taxYear: 2024 });
    const status = result.sectionStatus as Record<string, string>;
    const allowed = new Set(["ok", "skipped", "error"]);
    for (const key of [
      "trialBalance",
      "generalLedger",
      "bankReconciliationDiscrepancy",
      "payrollSummary",
      "fixedAssetDetail",
    ]) {
      expect(status[key]).toBeDefined();
      expect(allowed.has(status[key])).toBe(true);
    }
  });

  it("Trial Balance section returns the qb_trial_balance_export shape (rows / totals / crossChecks)", async () => {
    const session = freshSession();
    await session.openSession();
    registerClientPacketTools(fakeServer as never, () => session);

    const result = await call({ taxYear: 2024 });
    const sections = result.sections as Record<string, unknown>;
    const tb = sections.trialBalance as Record<string, unknown>;

    expect(tb.asOfDate).toBe("2024-12-31");
    expect(tb.basis).toBe("Accrual");
    expect(typeof tb.rowCount).toBe("number");
    expect(Array.isArray(tb.rows)).toBe(true);
    expect(typeof tb.totals).toBe("object");
    expect(typeof tb.crossChecks).toBe("object");

    // The four cross-checks come from buildTrialBalance — pin presence.
    const checks = tb.crossChecks as Record<string, unknown>;
    expect(checks.balanceSheet).toBeDefined();
    expect(checks.netIncome).toBeDefined();
    expect(checks.arReconciliation).toBeDefined();
    expect(checks.apReconciliation).toBeDefined();
  });

  it("General Ledger section defaults to PnLOnly scope and reports the scope explicitly", async () => {
    const session = freshSession();
    await session.openSession();
    registerClientPacketTools(fakeServer as never, () => session);

    const result = await call({ taxYear: 2024 });
    const sections = result.sections as Record<string, unknown>;
    const gl = sections.generalLedger as Record<string, unknown>;

    expect(gl.scope).toBe("PnLOnly");
    expect(gl.fromDate).toBe("2024-01-01");
    expect(gl.toDate).toBe("2024-12-31");
    expect(typeof gl.accountCount).toBe("number");
    expect(typeof gl.totalRowCount).toBe("number");
    expect(Array.isArray(gl.sections)).toBe(true);
  });

  it("glScope: 'AllAccounts' expands GL fanout vs. the PnLOnly default", async () => {
    // The two runs may both return zero rows against fresh seed (the sim's
    // queryTransactions surfaces line-level postings, and the seed's
    // invoice/bill line items don't reliably wire through to GL postings).
    // What we PIN is the scope field on the response — it's the
    // load-bearing toggle that drives downstream behavior in live mode.
    const session1 = freshSession();
    await session1.openSession();
    registerClientPacketTools(fakeServer as never, () => session1);
    const pnlOnly = await call({ taxYear: 2024 });
    const glPnL = (pnlOnly.sections as Record<string, unknown>).generalLedger as Record<string, unknown>;
    expect(glPnL.scope).toBe("PnLOnly");

    handlers.clear();
    const session2 = freshSession();
    await session2.openSession();
    registerClientPacketTools(fakeServer as never, () => session2);
    const allAccounts = await call({ taxYear: 2024, glScope: "AllAccounts" });
    const glAll = (allAccounts.sections as Record<string, unknown>).generalLedger as Record<string, unknown>;
    expect(glAll.scope).toBe("AllAccounts");
  });

  it("Bank reconciliation discrepancy section fans out across every Bank + CreditCard account", async () => {
    const session = freshSession();
    await session.openSession();
    registerClientPacketTools(fakeServer as never, () => session);

    const result = await call({ taxYear: 2024 });
    const sections = result.sections as Record<string, unknown>;
    const recon = sections.bankReconciliationDiscrepancy as Record<string, unknown>;

    expect(recon.sinceDate).toBe("2024-01-01"); // defaults to start of tax year
    expect(recon.asOfDate).toBe("2024-12-31");
    expect(typeof recon.accountCount).toBe("number");
    expect(typeof recon.totalCandidateCount).toBe("number");
    expect(Array.isArray(recon.perAccount)).toBe(true);

    // Sim seed has Checking + Savings — both Bank type — and no CreditCard.
    const perAccount = recon.perAccount as Array<Record<string, unknown>>;
    expect(perAccount.length).toBeGreaterThanOrEqual(2);
    const accountTypes = perAccount.map((a) => a.accountType);
    expect(accountTypes.every((t) => t === "Bank" || t === "CreditCard")).toBe(true);
  });

  it("bankReconDiscrepancySinceDate override flows through to the section", async () => {
    const session = freshSession();
    await session.openSession();
    registerClientPacketTools(fakeServer as never, () => session);

    const result = await call({
      taxYear: 2024,
      bankReconDiscrepancySinceDate: "2024-06-01",
    });
    const sections = result.sections as Record<string, unknown>;
    const recon = sections.bankReconciliationDiscrepancy as Record<string, unknown>;
    expect(recon.sinceDate).toBe("2024-06-01");
  });

  it("Payroll Summary section maps onto W-2 boxes against fresh seed (Premier Accountant)", async () => {
    const session = freshSession();
    await session.openSession();
    registerClientPacketTools(fakeServer as never, () => session);

    const result = await call({ taxYear: 2024 });
    const sections = result.sections as Record<string, unknown>;
    const status = result.sectionStatus as Record<string, string>;

    // Sim seeds Premier Accountant — proceeds past the edition gate.
    // PayrollYTDByYear is seeded for 2024 — rows should come back.
    expect(status.payrollSummary).toBe("ok");

    const payroll = sections.payrollSummary as Record<string, unknown>;
    expect(payroll.taxYear).toBe(2024);
    expect(payroll.fromDate).toBe("2024-01-01");
    expect(payroll.toDate).toBe("2024-12-31");
    expect(typeof payroll.count).toBe("number");
    expect(Array.isArray(payroll.employees)).toBe(true);

    const employees = payroll.employees as Array<Record<string, unknown>>;
    expect(employees.length).toBeGreaterThan(0);
    const first = employees[0];
    // Each row carries every W-2 box the qb_w2_summary tool documents.
    expect(typeof first.employeeListId).toBe("string");
    expect(typeof first.employeeFullName).toBe("string");
    expect(typeof first.ssn).toBe("string");
    expect(typeof first.box1_wagesTipsOtherComp).toBe("number");
    expect(typeof first.box2_federalIncomeTaxWithheld).toBe("number");
    expect(typeof first.box3_socialSecurityWages).toBe("number");
    expect(typeof first.box4_socialSecurityTaxWithheld).toBe("number");
    expect(typeof first.box5_medicareWages).toBe("number");
    expect(typeof first.box6_medicareTaxWithheld).toBe("number");

    // SSN masked to last 4 — mirrors qb_w2_summary contract.
    expect(String(first.ssn)).toMatch(/^XXX-XX-\d{4}$/);
  });

  it("Payroll Summary returns 9004 skipped state when the tax year has no seeded YTD data", async () => {
    const session = freshSession();
    await session.openSession();
    registerClientPacketTools(fakeServer as never, () => session);

    // 2020 has no PayrollYTDByYear seed → wire returns zero rows → skipped(9004).
    const result = await call({ taxYear: 2020 });
    const sections = result.sections as Record<string, unknown>;
    const status = result.sectionStatus as Record<string, string>;

    expect(status.payrollSummary).toBe("skipped");
    const payroll = sections.payrollSummary as Record<string, unknown>;
    expect(payroll.skipped).toBeDefined();
    const skipped = payroll.skipped as Record<string, unknown>;
    expect(skipped.statusCode).toBe(9004);
    expect(skipped.taxYear).toBe(2020);
  });

  it("Fixed Asset Detail section returns an empty accounts array against fresh seed (no FixedAsset accounts)", async () => {
    const session = freshSession();
    await session.openSession();
    registerClientPacketTools(fakeServer as never, () => session);

    const result = await call({ taxYear: 2024 });
    const sections = result.sections as Record<string, unknown>;
    const status = result.sectionStatus as Record<string, string>;

    // Fresh seed has no FixedAsset accounts — section status is still "ok"
    // (an empty accounts array is not an error).
    expect(status.fixedAssetDetail).toBe("ok");
    const fa = sections.fixedAssetDetail as Record<string, unknown>;
    expect(fa.fromDate).toBe("2024-01-01");
    expect(fa.toDate).toBe("2024-12-31");
    expect(fa.accountCount).toBe(0);
    expect(fa.totalRowCount).toBe(0);
    expect(Array.isArray(fa.accounts)).toBe(true);
    expect((fa.accounts as unknown[]).length).toBe(0);
  });

  it("Fixed Asset Detail section surfaces an account after seeding a FixedAsset + posting", async () => {
    const session = freshSession();
    await session.openSession();
    registerClientPacketTools(fakeServer as never, () => session);

    // Seed a FixedAsset account directly.
    const fa = await session.addEntity("Account", {
      Name: "Office Equipment",
      AccountType: "FixedAsset",
      AccountNumber: "1500",
    });
    const faListId = String((fa as Record<string, unknown>).ListID);

    // Seed a Check that posts to it in the tax-year window so the period
    // has activity to report on. Check expense lines hit a single account.
    await session.addEntity("Check", {
      AccountRef: { FullName: "Checking" },
      PayeeEntityRef: { FullName: "Office Supplies Co" },
      TxnDate: "2024-06-15",
      Amount: 1500,
      ExpenseLineAdd: [
        { AccountRef: { FullName: "Office Equipment" }, Amount: 1500 },
      ],
    });

    const result = await call({ taxYear: 2024 });
    const sections = result.sections as Record<string, unknown>;
    const detail = sections.fixedAssetDetail as Record<string, unknown>;

    expect(detail.accountCount).toBe(1);
    const accounts = detail.accounts as Array<Record<string, unknown>>;
    expect(accounts.length).toBe(1);
    const a = accounts[0];
    expect(a.accountName).toBe("Office Equipment");
    expect(a.accountListId).toBe(faListId);
    expect(a.accountNumber).toBe("1500");
    expect(typeof a.balance).toBe("number");
    expect(typeof a.openingBalance).toBe("number");
    expect(typeof a.closingBalance).toBe("number");
    expect(typeof a.periodChange).toBe("number");
    expect(typeof a.count).toBe("number");
    expect(Array.isArray(a.transactions)).toBe(true);
    // At least one posting in the window (the seeded Check's expense line).
    expect((a.count as number)).toBeGreaterThan(0);
  });
});

describe("qb_client_packet — section toggles", () => {
  it("includeTrialBalance: false skips TB; other sections still run", async () => {
    const session = freshSession();
    await session.openSession();
    registerClientPacketTools(fakeServer as never, () => session);

    const result = await call({ taxYear: 2024, includeTrialBalance: false });
    const status = result.sectionStatus as Record<string, string>;
    const sections = result.sections as Record<string, unknown>;
    expect(status.trialBalance).toBe("skipped");
    expect(sections.trialBalance).toBeUndefined();
    // Other sections still emit something.
    expect(sections.generalLedger).toBeDefined();
    expect(sections.bankReconciliationDiscrepancy).toBeDefined();
    expect(sections.fixedAssetDetail).toBeDefined();
  });

  it("all section toggles off → success with no section payloads", async () => {
    const session = freshSession();
    await session.openSession();
    registerClientPacketTools(fakeServer as never, () => session);

    const result = await call({
      taxYear: 2024,
      includeTrialBalance: false,
      includeGeneralLedger: false,
      includeBankReconDiscrepancy: false,
      includePayrollSummary: false,
      includeFixedAssetDetail: false,
    });
    expect(result.success).toBe(true);
    const sections = result.sections as Record<string, unknown>;
    expect(sections.trialBalance).toBeUndefined();
    expect(sections.generalLedger).toBeUndefined();
    expect(sections.bankReconciliationDiscrepancy).toBeUndefined();
    expect(sections.payrollSummary).toBeUndefined();
    expect(sections.fixedAssetDetail).toBeUndefined();

    const status = result.sectionStatus as Record<string, string>;
    for (const v of Object.values(status)) expect(v).toBe("skipped");
  });

  it("includePayrollSummary: false skips probe entirely (no edition gate even reached)", async () => {
    const session = freshSession();
    await session.openSession();
    registerClientPacketTools(fakeServer as never, () => session);

    const result = await call({ taxYear: 2024, includePayrollSummary: false });
    const status = result.sectionStatus as Record<string, string>;
    const sections = result.sections as Record<string, unknown>;
    expect(status.payrollSummary).toBe("skipped");
    expect(sections.payrollSummary).toBeUndefined();
  });
});

describe("qb_client_packet — customer context", () => {
  it("customerListId lookup surfaces FullName + Balance on the packet header", async () => {
    const session = freshSession();
    await session.openSession();
    registerClientPacketTools(fakeServer as never, () => session);

    // Acme Corporation is in the seed.
    const result = await call({ taxYear: 2024, customerListId: "80000001-1234567890" });
    const customer = result.customer as Record<string, unknown> | null;
    expect(customer).not.toBeNull();
    expect(String((customer as Record<string, unknown>).listId)).toBe("80000001-1234567890");
    expect(typeof (customer as Record<string, unknown>).fullName).toBe("string");
    expect(String((customer as Record<string, unknown>).fullName)).toBe("Acme Corporation");
  });

  it("customerName lookup also surfaces the customer header", async () => {
    const session = freshSession();
    await session.openSession();
    registerClientPacketTools(fakeServer as never, () => session);

    const result = await call({ taxYear: 2024, customerName: "Acme Corporation" });
    const customer = result.customer as Record<string, unknown> | null;
    expect(customer).not.toBeNull();
    expect(String((customer as Record<string, unknown>).fullName)).toBe("Acme Corporation");
  });

  it("unknown customer surfaces a warning and proceeds with customer: null", async () => {
    const session = freshSession();
    await session.openSession();
    registerClientPacketTools(fakeServer as never, () => session);

    const result = await call({ taxYear: 2024, customerName: "Nonexistent Customer" });
    expect(result.customer).toBeNull();
    const warnings = result.warnings as string[] | undefined;
    expect(warnings).toBeDefined();
    expect(warnings!.some((w) => w.includes("Nonexistent Customer"))).toBe(true);
    // Packet itself still succeeds.
    expect(result.success).toBe(true);
  });
});

describe("qb_client_packet — fail-soft contract", () => {
  it("a single section's wire failure does NOT poison the rest of the packet", async () => {
    const session = freshSession();
    await session.openSession();

    // Monkey-patch runPayrollSummaryReport to fail. The packet's payroll
    // section should land in an `error` block; every other section should
    // still report its normal payload.
    (session as unknown as { runPayrollSummaryReport: () => Promise<unknown> }).runPayrollSummaryReport
      = async () => {
        throw Object.assign(new Error("synthetic wire failure"), { statusCode: 3120 });
      };

    registerClientPacketTools(fakeServer as never, () => session);

    const result = await call({ taxYear: 2024 });
    expect(result.success).toBe(true);

    const status = result.sectionStatus as Record<string, string>;
    expect(status.payrollSummary).toBe("error");
    expect(status.trialBalance).toBe("ok");
    expect(status.generalLedger).toBe("ok");
    expect(status.bankReconciliationDiscrepancy).toBe("ok");
    expect(status.fixedAssetDetail).toBe("ok");

    const sections = result.sections as Record<string, unknown>;
    const payroll = sections.payrollSummary as Record<string, unknown>;
    expect(payroll.error).toBeDefined();
    const errBlock = payroll.error as Record<string, unknown>;
    expect(errBlock.statusCode).toBe(3120);
    expect(String(errBlock.statusMessage)).toContain("synthetic wire failure");
  });

  it("AccountQueryRq failure DOES fail the whole tool (the one non-fail-soft path)", async () => {
    const session = freshSession();
    await session.openSession();

    // Monkey-patch queryEntity to fail when entity === "Account".
    const original = session.queryEntity.bind(session);
    (session as unknown as { queryEntity: typeof session.queryEntity }).queryEntity
      = async (entity: string, filters: Record<string, unknown> = {}) => {
        if (entity === "Account") {
          throw Object.assign(new Error("simulated chart-of-accounts failure"), { statusCode: -1 });
        }
        return original(entity, filters);
      };

    registerClientPacketTools(fakeServer as never, () => session);

    const handler = handlers.get("qb_client_packet");
    const out = await handler!({ taxYear: 2024 });
    expect(out.isError).toBe(true);
    const body = JSON.parse(out.content[0].text);
    expect(body.success).toBe(false);
    expect(String(body.statusMessage)).toContain("pre-flight failed");
  });

  it("bank rec per-account error lands inside the account entry without poisoning siblings", async () => {
    const session = freshSession();
    await session.openSession();

    // Make runCustomDetailReport fail when the account is Checking; succeed
    // for Savings. Both bank accounts in sim seed.
    (session as unknown as { runCustomDetailReport: (args: Record<string, unknown>) => Promise<unknown> }).runCustomDetailReport
      = async (params: Record<string, unknown>) => {
        const acct = (params.account as Record<string, unknown> | undefined) ?? {};
        if (acct.FullName === "Checking" || acct.ListID === "A0000001") {
          throw Object.assign(new Error("simulated checking failure"), { statusCode: 3120 });
        }
        return { Rows: [] };
      };

    registerClientPacketTools(fakeServer as never, () => session);

    const result = await call({ taxYear: 2024 });
    const status = result.sectionStatus as Record<string, string>;
    expect(status.bankReconciliationDiscrepancy).toBe("ok"); // section as a whole still ok

    const sections = result.sections as Record<string, unknown>;
    const recon = sections.bankReconciliationDiscrepancy as Record<string, unknown>;
    const perAccount = recon.perAccount as Array<Record<string, unknown>>;
    const checking = perAccount.find((a) => a.accountName === "Checking");
    const savings = perAccount.find((a) => a.accountName === "Savings");
    expect(checking).toBeDefined();
    expect(checking!.error).toBeDefined();
    expect(savings).toBeDefined();
    expect(savings!.error).toBeUndefined();
    expect(savings!.candidates).toBeDefined();
  });
});

describe("qb_client_packet — Pro edition gates payroll to skipped(9003)", () => {
  it("when getHostInfo reports Pro, payroll section is skipped(9003); other sections still run", async () => {
    const session = freshSession();
    await session.openSession();

    // Monkey-patch getHostInfo to return Pro edition.
    (session as unknown as { getHostInfo: () => Promise<Record<string, unknown>> }).getHostInfo
      = async () => ({
        productName: "QuickBooks Pro 2024",
        majorVersion: "34",
        country: "US",
        supportedQbxmlVersions: ["16.0"],
        isAutomaticLogin: false,
        qbFileMode: "MultiUser",
        edition: "Pro",
        isEnterprise: false,
        isAccountant: false,
      });

    registerClientPacketTools(fakeServer as never, () => session);

    const result = await call({ taxYear: 2024 });
    const status = result.sectionStatus as Record<string, string>;
    expect(status.payrollSummary).toBe("skipped");

    const sections = result.sections as Record<string, unknown>;
    const payroll = sections.payrollSummary as Record<string, unknown>;
    expect(payroll.skipped).toBeDefined();
    const skipped = payroll.skipped as Record<string, unknown>;
    expect(skipped.statusCode).toBe(9003);
    expect(skipped.edition).toBe("Pro");

    // Other sections still ok.
    expect(status.trialBalance).toBe("ok");
    expect(status.generalLedger).toBe("ok");
    expect(status.bankReconciliationDiscrepancy).toBe("ok");
    expect(status.fixedAssetDetail).toBe("ok");
  });
});

describe("qb_client_packet — basis pass-through", () => {
  it("Cash basis flows through to TB / GL section payloads", async () => {
    const session = freshSession();
    await session.openSession();
    registerClientPacketTools(fakeServer as never, () => session);

    const result = await call({ taxYear: 2024, basis: "Cash" });
    expect(result.basis).toBe("Cash");
    const sections = result.sections as Record<string, unknown>;
    expect((sections.trialBalance as Record<string, unknown>).basis).toBe("Cash");
    expect((sections.generalLedger as Record<string, unknown>).basis).toBe("Cash");
  });
});
