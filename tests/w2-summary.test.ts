// Phase 11 #55 — qb_w2_summary (W-2 prep via PayrollSummaryReportQueryRq).
//
// Coverage layers:
//   1. Builder — buildPayrollSummaryReportRequest emits the conservative
//      schema-order subset (PayrollSummaryReportType → ReportPeriod →
//      SummarizeColumnsBy → ReportEntityFilter). Pinned in
//      tests/builder-emit-order.test.ts (separate file — convention).
//   2. Sim handler — handlePayrollSummaryReportQuery walks seeded employees,
//      synthesizes per-employee YTD totals, masks SSN to last 4, surfaces
//      optional state fields, picks the right tax year from ReportPeriod,
//      scopes via ReportEntityFilter, returns statusCode 1 for empty result.
//   3. Manager — runPayrollSummaryReport extracts ReportRet via the existing
//      extractReportData path.
//   4. Tool surface — qb_w2_summary edition gate (Pro rejects), happy path
//      maps EmployeeWagesTaxesRet onto W-2 box numbers, scope + tax-year
//      defaulting, empty-result 9004 path, error surfacing on wire failure.

import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerReportTools } from "../src/tools/reports.js";
import { buildPayrollSummaryReportRequest } from "../src/qbxml/builder.js";

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

let session: QBSessionManager;

beforeAll(async () => {
  session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-w2-summary",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  registerReportTools(fakeServer as never, () => session);
  await session.openSession();
});

// ---------------------------------------------------------------------------
// Layer 1 — Builder
// ---------------------------------------------------------------------------

describe("buildPayrollSummaryReportRequest", () => {
  it("emits the conservative schema-order subset (no ReportBasis — payroll is cash)", () => {
    const xml = buildPayrollSummaryReportRequest({
      reportType: "EmployeeWagesTaxesAdjustments",
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
      entityFilter: { FullName: "Alice Johnson" },
    });

    // Required children present
    expect(xml).toContain("<PayrollSummaryReportType>EmployeeWagesTaxesAdjustments</PayrollSummaryReportType>");
    expect(xml).toContain("<FromReportDate>2024-01-01</FromReportDate>");
    expect(xml).toContain("<ToReportDate>2024-12-31</ToReportDate>");
    expect(xml).toContain("<SummarizeColumnsBy>TotalOnly</SummarizeColumnsBy>");
    expect(xml).toContain("<ReportEntityFilter>");
    expect(xml).toContain("<FullName>Alice Johnson</FullName>");

    // No ReportBasis — payroll reports are inherently cash-basis
    expect(xml).not.toContain("<ReportBasis>");

    // Schema order: PayrollSummaryReportType → ReportPeriod → SummarizeColumnsBy → ReportEntityFilter
    const idxType = xml.indexOf("<PayrollSummaryReportType>");
    const idxPeriod = xml.indexOf("<ReportPeriod>");
    const idxSumBy = xml.indexOf("<SummarizeColumnsBy>");
    const idxEntFilter = xml.indexOf("<ReportEntityFilter>");
    expect(idxType).toBeLessThan(idxPeriod);
    expect(idxPeriod).toBeLessThan(idxSumBy);
    expect(idxSumBy).toBeLessThan(idxEntFilter);
  });

  it("ListID-form entityFilter takes precedence over FullName", () => {
    const xml = buildPayrollSummaryReportRequest({
      reportType: "EmployeeWagesTaxesAdjustments",
      entityFilter: { ListID: "EMP-1", FullName: "Should Not Appear" },
    });
    expect(xml).toContain("<ListID>EMP-1</ListID>");
    expect(xml).not.toContain("Should Not Appear");
  });

  it("omits ReportPeriod when no dates supplied", () => {
    const xml = buildPayrollSummaryReportRequest({
      reportType: "EmployeeWagesTaxesAdjustments",
    });
    expect(xml).not.toContain("<ReportPeriod>");
    expect(xml).not.toContain("<ReportEntityFilter>");
    expect(xml).toContain("<PayrollSummaryReportType>EmployeeWagesTaxesAdjustments</PayrollSummaryReportType>");
    expect(xml).toContain("<SummarizeColumnsBy>TotalOnly</SummarizeColumnsBy>");
  });

  it("omits ReportEntityFilter when both ListID and FullName empty", () => {
    const xml = buildPayrollSummaryReportRequest({
      reportType: "EmployeeWagesTaxesAdjustments",
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
      entityFilter: {},
    });
    expect(xml).not.toContain("<ReportEntityFilter>");
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — Sim handler via session.runPayrollSummaryReport
// ---------------------------------------------------------------------------

describe("simulation: handlePayrollSummaryReportQuery", () => {
  it("returns three seeded employees for the 2024 tax year with masked SSNs", async () => {
    const ret = await session.runPayrollSummaryReport({
      reportType: "EmployeeWagesTaxesAdjustments",
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
    });

    expect(ret.ReportTitle).toBe("Employee Wages, Taxes and Adjustments");
    expect(ret.ReportBasis).toBe("Cash");
    expect(ret.ReportYear).toBe(2024);

    const rows = ret.EmployeeWagesTaxesRet as Array<Record<string, unknown>>;
    expect(rows.length).toBe(3);

    const alice = rows.find((r) => {
      const ref = r.EmployeeRef as Record<string, unknown>;
      return ref.FullName === "Alice Johnson";
    });
    expect(alice).toBeDefined();
    expect(alice!.SSN).toBe("XXX-XX-6789"); // masked: last 4 of 123-45-6789
    expect(alice!.GrossWages).toBe(65000.00);
    expect(alice!.FederalIncomeTaxWithheld).toBe(8125.00);
    expect(alice!.SocialSecurityWages).toBe(65000.00);
    expect(alice!.SocialSecurityTaxWithheld).toBe(4030.00);
    expect(alice!.MedicareWages).toBe(65000.00);
    expect(alice!.MedicareTaxWithheld).toBe(942.50);
    expect(alice!.StateAbbreviation).toBe("IL");
    expect(alice!.StateWages).toBe(65000.00);
    expect(alice!.StateIncomeTaxWithheld).toBe(3217.50);
  });

  it("Carla (TX) surfaces StateAbbreviation but no StateWages / StateIncomeTaxWithheld", async () => {
    const ret = await session.runPayrollSummaryReport({
      reportType: "EmployeeWagesTaxesAdjustments",
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
    });

    const rows = ret.EmployeeWagesTaxesRet as Array<Record<string, unknown>>;
    const carla = rows.find((r) => {
      const ref = r.EmployeeRef as Record<string, unknown>;
      return ref.FullName === "Carla Nguyen";
    });
    expect(carla).toBeDefined();
    expect(carla!.StateAbbreviation).toBe("TX");
    expect(carla!.StateWages).toBeUndefined();
    expect(carla!.StateIncomeTaxWithheld).toBeUndefined();
  });

  it("filters to a single employee via ReportEntityFilter.FullName", async () => {
    const ret = await session.runPayrollSummaryReport({
      reportType: "EmployeeWagesTaxesAdjustments",
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
      entityFilter: { FullName: "Bob Martinez" },
    });

    const rows = ret.EmployeeWagesTaxesRet as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    const ref = rows[0].EmployeeRef as Record<string, unknown>;
    expect(ref.FullName).toBe("Bob Martinez");
    expect(rows[0].GrossWages).toBe(95000.00);
  });

  it("filters to a single employee via ReportEntityFilter.ListID (resolves through Employee store)", async () => {
    const ret = await session.runPayrollSummaryReport({
      reportType: "EmployeeWagesTaxesAdjustments",
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
      entityFilter: { ListID: "80000020-1234567890" },
    });

    const rows = ret.EmployeeWagesTaxesRet as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    const ref = rows[0].EmployeeRef as Record<string, unknown>;
    expect(ref.FullName).toBe("Alice Johnson");
  });

  it("picks the 2025 tax-year block when ReportPeriod is in 2025", async () => {
    const ret = await session.runPayrollSummaryReport({
      reportType: "EmployeeWagesTaxesAdjustments",
      fromDate: "2025-01-01",
      toDate: "2025-12-31",
      entityFilter: { FullName: "Alice Johnson" },
    });

    const rows = ret.EmployeeWagesTaxesRet as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0].GrossWages).toBe(68000.00); // 2025 figure, not 65000
    expect(rows[0].FederalIncomeTaxWithheld).toBe(8500.00);
  });

  it("computes correct grand totals across all employees", async () => {
    const ret = await session.runPayrollSummaryReport({
      reportType: "EmployeeWagesTaxesAdjustments",
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
    });

    const totals = ret.Totals as Record<string, number>;
    // Alice (65k) + Bob (95k) + Carla (52k) = 212k
    expect(totals.TotalGrossWages).toBe(212000.00);
    expect(totals.TotalFederalIncomeTaxWithheld).toBe(8125 + 14250 + 5720);
    expect(totals.TotalSocialSecurityTaxWithheld).toBe(4030 + 5890 + 3224);
    expect(totals.TotalMedicareTaxWithheld).toBe(942.50 + 1377.50 + 754);
  });

  it("returns statusCode 1 (no matching object) when entity filter matches nothing", async () => {
    // Direct sim probe — runPayrollSummaryReport extracts ReportRet via
    // extractReportData which converts statusCode 1 to {} (empty object).
    // The tool layer translates {} → 9004 (subscription required); here we
    // verify the underlying call returns the empty shape rather than
    // throwing.
    const ret = await session.runPayrollSummaryReport({
      reportType: "EmployeeWagesTaxesAdjustments",
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
      entityFilter: { FullName: "Nobody Exists Here" },
    });

    // Empty {} from extractReportData. EmployeeWagesTaxesRet absent.
    expect(ret.EmployeeWagesTaxesRet).toBeUndefined();
  });

  it("rejects cross-year ReportPeriod with statusCode 3120", async () => {
    await expect(
      session.runPayrollSummaryReport({
        reportType: "EmployeeWagesTaxesAdjustments",
        fromDate: "2024-06-01",
        toDate: "2025-05-31",
      })
    ).rejects.toMatchObject({
      statusCode: 3120,
      message: expect.stringContaining("spans multiple calendar years"),
    });
  });

  it("rejects unsupported PayrollSummaryReportType with statusCode 3120", async () => {
    await expect(
      session.runPayrollSummaryReport({
        reportType: "PayrollLiability",
      })
    ).rejects.toMatchObject({
      statusCode: 3120,
      message: expect.stringContaining("Unsupported PayrollSummaryReportType"),
    });
  });

  it("statusCode 1 (no rows) is the right contract for an unscoped no-employee year", async () => {
    // With both bounds in a year that has no seeded data (e.g. 2030),
    // every employee's PayrollYTDByYear lookup misses → no rows.
    await expect(
      session.runPayrollSummaryReport({
        reportType: "EmployeeWagesTaxesAdjustments",
        fromDate: "2030-01-01",
        toDate: "2030-12-31",
      })
    ).resolves.toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — Tool surface: qb_w2_summary
// ---------------------------------------------------------------------------

describe("qb_w2_summary tool surface", () => {
  it("happy path — defaults to last completed year, returns W-2 box-mapped employees", async () => {
    // Seeded YTD covers 2024 + 2025. Today is 2026-05-12, so default is 2025.
    const handler = handlers.get("qb_w2_summary")!;
    const result = await handler({});
    const body = JSON.parse(result.content[0].text);

    expect(result.isError).toBeFalsy();
    expect(body.success).toBe(true);
    expect(body.taxYear).toBe(new Date().getUTCFullYear() - 1);
    expect(body.fromDate).toBe(`${body.taxYear}-01-01`);
    expect(body.toDate).toBe(`${body.taxYear}-12-31`);
    expect(body.count).toBe(3);

    const alice = body.employees.find((e: { employeeFullName: string }) => e.employeeFullName === "Alice Johnson");
    expect(alice).toBeDefined();
    expect(alice.ssn).toBe("XXX-XX-6789");
    // 2025 figures (default = last completed year)
    expect(alice.box1_wagesTipsOtherComp).toBe(68000.00);
    expect(alice.box2_federalIncomeTaxWithheld).toBe(8500.00);
    expect(alice.box3_socialSecurityWages).toBe(68000.00);
    expect(alice.box4_socialSecurityTaxWithheld).toBe(4216.00);
    expect(alice.box5_medicareWages).toBe(68000.00);
    expect(alice.box6_medicareTaxWithheld).toBe(986.00);
    expect(alice.stateAbbreviation).toBe("IL");
    expect(alice.box16_stateWages).toBe(68000.00);
    expect(alice.box17_stateIncomeTax).toBe(3366.00);
  });

  it("Carla: TX state surfaces stateAbbreviation but no box16/box17 (no state income tax)", async () => {
    const handler = handlers.get("qb_w2_summary")!;
    const result = await handler({ taxYear: 2024 });
    const body = JSON.parse(result.content[0].text);
    const carla = body.employees.find((e: { employeeFullName: string }) => e.employeeFullName === "Carla Nguyen");
    expect(carla).toBeDefined();
    expect(carla.stateAbbreviation).toBe("TX");
    expect(carla.box16_stateWages).toBeUndefined();
    expect(carla.box17_stateIncomeTax).toBeUndefined();
  });

  it("explicit taxYear override overrides default", async () => {
    const handler = handlers.get("qb_w2_summary")!;
    const result = await handler({ taxYear: 2024 });
    const body = JSON.parse(result.content[0].text);
    expect(body.taxYear).toBe(2024);
    expect(body.fromDate).toBe("2024-01-01");
    expect(body.toDate).toBe("2024-12-31");

    const alice = body.employees.find((e: { employeeFullName: string }) => e.employeeFullName === "Alice Johnson");
    expect(alice.box1_wagesTipsOtherComp).toBe(65000.00); // 2024, not 2025
  });

  it("scope via employeeFullName surfaces a single employee", async () => {
    const handler = handlers.get("qb_w2_summary")!;
    const result = await handler({ taxYear: 2024, employeeFullName: "Bob Martinez" });
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.count).toBe(1);
    expect(body.employees[0].employeeFullName).toBe("Bob Martinez");
    expect(body.employees[0].box1_wagesTipsOtherComp).toBe(95000.00);
  });

  it("scope via employeeListId surfaces a single employee", async () => {
    const handler = handlers.get("qb_w2_summary")!;
    const result = await handler({ taxYear: 2024, employeeListId: "80000022-1234567890" });
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.count).toBe(1);
    expect(body.employees[0].employeeFullName).toBe("Carla Nguyen");
  });

  it("9004 path: empty result (no matching employees) returns subscription-required error", async () => {
    const handler = handlers.get("qb_w2_summary")!;
    const result = await handler({ taxYear: 2024, employeeFullName: "Nobody Exists" });
    const body = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(body.statusCode).toBe(9004);
    expect(body.statusMessage).toContain("PayrollSummaryReportQueryRq returned no data");
    expect(body.statusMessage).toContain("Nobody Exists");
    expect(body.humanReadable).toContain("QB Payroll subscription required");
  });

  it("9004 path: empty result for a year with no seeded data", async () => {
    const handler = handlers.get("qb_w2_summary")!;
    const result = await handler({ taxYear: 2030 });
    const body = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(body.statusCode).toBe(9004);
    expect(body.taxYear).toBe(2030);
  });

  it("9003 path: Pro edition rejects with edition-unsupported error", async () => {
    // Patch session.getHostInfo to return Pro edition for this test only.
    // The instance method is per-instance, so we can rebind it on a fresh
    // session without polluting the shared test session.
    const proSession = new QBSessionManager({
      companyFile: "simulation",
      appName: "vitest-w2-pro",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
    await proSession.openSession();
    const proHandlers = new Map<string, Handler>();
    const proServer = {
      tool: (
        name: string,
        _description: string,
        _schema: Record<string, z.ZodTypeAny>,
        handler: Handler,
      ) => {
        proHandlers.set(name, handler);
      },
    };
    registerReportTools(proServer as never, () => proSession);

    // Override getHostInfo to return Pro
    const originalGetHostInfo = proSession.getHostInfo.bind(proSession);
    proSession.getHostInfo = async () => ({
      productName: "QuickBooks Pro 2024",
      majorVersion: "34",
      minorVersion: "0",
      country: "US",
      supportedQbxmlVersions: ["16.0"],
      maxQbxmlVersion: "16.0",
      isAutomaticLogin: false,
      qbFileMode: "SingleUser",
      edition: "Pro",
      isEnterprise: false,
      isAccountant: false,
    });

    const handler = proHandlers.get("qb_w2_summary")!;
    const result = await handler({ taxYear: 2024 });
    const body = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(body.statusCode).toBe(9003);
    expect(body.edition).toBe("Pro");
    expect(body.productName).toBe("QuickBooks Pro 2024");
    expect(body.humanReadable).toContain("Edition does not support QB Payroll");

    // Restore so the test session isn't poisoned for subsequent runs (defensive
    // — proSession is a fresh instance, but the linter likes the cleanup).
    proSession.getHostInfo = originalGetHostInfo;
  });

  it("Premier and PremierAccountant editions pass the gate", async () => {
    // Default sim seed is PremierAccountant. The happy-path tests above
    // already exercise this implicitly; this is an explicit pin so a future
    // edition-gate change can't silently break the Accountant-edition path
    // (which is the default for the operator's CPA practice).
    const handler = handlers.get("qb_w2_summary")!;
    const hostInfo = await session.getHostInfo();
    expect(hostInfo.edition).toBe("PremierAccountant");

    const result = await handler({ taxYear: 2024 });
    const body = JSON.parse(result.content[0].text);
    expect(result.isError).toBeFalsy();
    expect(body.success).toBe(true);
  });

  it("error wrapper surfaces wire failures with humanReadable (when known status code)", async () => {
    // Patch runPayrollSummaryReport to throw a synthetic 3120 to exercise the
    // catch path at the tool layer.
    const errSession = new QBSessionManager({
      companyFile: "simulation",
      appName: "vitest-w2-error",
      qbxmlVersion: "16.0",
      connectionMode: "optimistic",
    });
    await errSession.openSession();
    const errHandlers = new Map<string, Handler>();
    const errServer = {
      tool: (
        name: string,
        _description: string,
        _schema: Record<string, z.ZodTypeAny>,
        handler: Handler,
      ) => {
        errHandlers.set(name, handler);
      },
    };
    registerReportTools(errServer as never, () => errSession);

    errSession.runPayrollSummaryReport = async () => {
      const e = new Error("simulated wire failure") as Error & { statusCode: number };
      e.statusCode = 3120;
      throw e;
    };

    const handler = errHandlers.get("qb_w2_summary")!;
    const result = await handler({ taxYear: 2024 });
    const body = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(body.statusCode).toBe(3120);
    expect(body.statusMessage).toBe("simulated wire failure");
    expect(body.humanReadable).toBe("Required field missing or invalid value");
  });
});
