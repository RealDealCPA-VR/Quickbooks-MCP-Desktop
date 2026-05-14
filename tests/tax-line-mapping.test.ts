// qb_tax_line_mapping tests (Phase 15 #69).
//
// The tool projects AccountQueryRq → tax-line bridge rows (the TaxLineInfoRet
// surface every tax-prep workpaper rebuilds by hand otherwise). All projection
// + sort + mapped/unmapped split lives in `buildTaxLineMapping` so the math
// is pinned at the unit layer; end-to-end tests then prove the wire orchestration
// produces the same shape against fresh sim seed.
//
// Layers:
//   1. buildTaxLineMapping — pure-function tests covering projection, sort
//      (canonical AccountType → AccountNumber → name), mapped/unmapped split,
//      defensive cases (empty TaxLineName treated as unmapped, missing
//      AccountNumber, unknown AccountType sorts last).
//   2. End-to-end via QBSessionManager — proves the tool's wire path against
//      fresh seed (8 mapped + 2 unmapped accounts after the Phase 15 #69 seed
//      update).
//   3. Tool surface — happy path + error wrapping via a fake McpServer harness.
//   4. Integration — qb_trial_balance_export's `taxLine` column now surfaces
//      non-null values for the seeded mapped accounts in sim (was always null
//      pre-#69).

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import {
  buildTaxLineMapping,
  buildTrialBalance,
  registerReportTools,
  type TaxLineMappingAccountInput,
  type TrialBalanceAccount,
  type TrialBalanceReportInput,
} from "../src/tools/reports.js";

// ---------------------------------------------------------------------------
// Test harness — wire the tool into a fake McpServer that captures handlers
// ---------------------------------------------------------------------------

type Handler = (args: unknown) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function makeHarness() {
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
  const session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-tax-line-mapping",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  registerReportTools(fakeServer as never, () => session);
  return { handlers, session };
}

async function call(handlers: Map<string, Handler>, name: string, args: unknown = {}) {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`Handler not registered: ${name}`);
  const result = await handler(args);
  const text = result.content[0].text;
  return { result, body: JSON.parse(text) };
}

const newSimSession = async () => {
  const session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-tax-line-mapping",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  await session.openSession();
  return session;
};

// ---------------------------------------------------------------------------
// Layer 1 — buildTaxLineMapping unit tests
// ---------------------------------------------------------------------------

describe("buildTaxLineMapping — unit", () => {
  // Synthetic chart covering every shape the projector cares about: mapped vs
  // unmapped, missing AccountNumber, inactive, unknown AccountType (must sort
  // last alphabetically), TaxLineID without TaxLineName (treated as unmapped
  // — the name is the workpaper-readable label every consumer keys on).
  const accounts: TaxLineMappingAccountInput[] = [
    { ListID: "A1", FullName: "Checking", AccountType: "Bank", AccountNumber: "1000", IsActive: true,
      TaxLineInfoRet: { TaxLineID: 28, TaxLineName: "B/S-Assets: Cash" } },
    { ListID: "A2", FullName: "Savings", AccountType: "Bank", AccountNumber: "1010", IsActive: true },
    { ListID: "A3", FullName: "Sales Revenue", AccountType: "Income", AccountNumber: "4000", IsActive: true,
      TaxLineInfoRet: { TaxLineID: 100, TaxLineName: "Income: Gross receipts or sales" } },
    { ListID: "A4", FullName: "Consulting Revenue", AccountType: "Income", AccountNumber: "4100", IsActive: true },
    { ListID: "A5", FullName: "Rent Expense", AccountType: "Expense", AccountNumber: "6000", IsActive: true,
      TaxLineInfoRet: { TaxLineID: 50, TaxLineName: "Deductions: Rents" } },
    { ListID: "A6", FullName: "Old Account", AccountType: "Expense", AccountNumber: "6900", IsActive: false,
      TaxLineInfoRet: { TaxLineID: 99, TaxLineName: "Deductions: Other" } },
    // Edge: TaxLineID present but TaxLineName missing → unmapped.
    { ListID: "A7", FullName: "ID Only", AccountType: "Expense", AccountNumber: "6800", IsActive: true,
      TaxLineInfoRet: { TaxLineID: 77 } },
    // Edge: empty TaxLineName string → unmapped.
    { ListID: "A8", FullName: "Empty Name", AccountType: "Expense", AccountNumber: "6850", IsActive: true,
      TaxLineInfoRet: { TaxLineID: 78, TaxLineName: "" } },
    // Edge: missing AccountNumber — must still sort within type by name.
    { ListID: "A9", FullName: "Unnumbered Income", AccountType: "Income", IsActive: true,
      TaxLineInfoRet: { TaxLineID: 102, TaxLineName: "Income: Other" } },
    // Edge: unknown AccountType (NonPosting in this case) — sorts last.
    { ListID: "A10", FullName: "Estimates", AccountType: "NonPosting", AccountNumber: "9000", IsActive: true,
      TaxLineInfoRet: { TaxLineID: 200, TaxLineName: "Memo: Tracked only" } },
  ];

  it("returns only mapped accounts by default", () => {
    const out = buildTaxLineMapping(accounts);
    const names = out.accounts.map((a) => a.accountName);
    // Mapped: Checking, Sales Revenue, Rent Expense, Old Account, Unnumbered Income, Estimates
    // (Old Account stays — includeInactive is at the FILTER layer (sim/wire), not the projector.)
    expect(names).toContain("Checking");
    expect(names).toContain("Sales Revenue");
    expect(names).toContain("Rent Expense");
    expect(names).toContain("Unnumbered Income");
    // Unmapped: Savings, Consulting Revenue, ID Only, Empty Name
    expect(names).not.toContain("Savings");
    expect(names).not.toContain("Consulting Revenue");
    expect(names).not.toContain("ID Only");
    expect(names).not.toContain("Empty Name");
  });

  it("includeUnmapped:true returns mapped AND unmapped", () => {
    const out = buildTaxLineMapping(accounts, { includeUnmapped: true });
    const names = out.accounts.map((a) => a.accountName);
    expect(names).toContain("Savings");
    expect(names).toContain("Consulting Revenue");
    expect(names).toContain("ID Only");
    expect(names).toContain("Empty Name");
  });

  it("surfaces taxLineId + taxLineName from TaxLineInfoRet on mapped rows", () => {
    const out = buildTaxLineMapping(accounts);
    const checking = out.accounts.find((a) => a.accountName === "Checking")!;
    expect(checking.taxLineId).toBe(28);
    expect(checking.taxLineName).toBe("B/S-Assets: Cash");
    expect(checking.isUnmapped).toBe(false);
  });

  it("unmapped rows surface taxLineId/taxLineName as null and isUnmapped:true", () => {
    const out = buildTaxLineMapping(accounts, { includeUnmapped: true });
    const savings = out.accounts.find((a) => a.accountName === "Savings")!;
    expect(savings.taxLineId).toBeNull();
    expect(savings.taxLineName).toBeNull();
    expect(savings.isUnmapped).toBe(true);
  });

  it("treats TaxLineID-only (no name) as unmapped", () => {
    const out = buildTaxLineMapping(accounts, { includeUnmapped: true });
    const idOnly = out.accounts.find((a) => a.accountName === "ID Only")!;
    expect(idOnly.isUnmapped).toBe(true);
    expect(idOnly.taxLineName).toBeNull();
    // TaxLineID alone is preserved on the row even when the row is unmapped —
    // useful audit signal (an account that has a TaxLineID assignment but no
    // resolved name suggests a custom or stale tax-line code).
    expect(idOnly.taxLineId).toBe(77);
  });

  it("treats empty TaxLineName string as unmapped", () => {
    const out = buildTaxLineMapping(accounts, { includeUnmapped: true });
    const empty = out.accounts.find((a) => a.accountName === "Empty Name")!;
    expect(empty.isUnmapped).toBe(true);
    expect(empty.taxLineName).toBeNull();
  });

  it("counts mapped vs unmapped correctly", () => {
    const out = buildTaxLineMapping(accounts, { includeUnmapped: true });
    expect(out.count).toBe(out.accounts.length);
    expect(out.mappedCount + out.unmappedCount).toBe(out.count);
    // 6 mapped (Checking, Sales Revenue, Rent Expense, Old Account, Unnumbered Income, Estimates)
    // 4 unmapped (Savings, Consulting Revenue, ID Only, Empty Name)
    expect(out.mappedCount).toBe(6);
    expect(out.unmappedCount).toBe(4);
  });

  it("count + mappedCount + unmappedCount agree under default (mapped-only) too", () => {
    const out = buildTaxLineMapping(accounts);
    expect(out.unmappedCount).toBe(0);
    expect(out.mappedCount).toBe(out.count);
    expect(out.count).toBe(6);
  });

  it("sorts by canonical AccountType → AccountNumber → name", () => {
    const out = buildTaxLineMapping(accounts, { includeUnmapped: true });
    const names = out.accounts.map((a) => a.accountName);
    // Canonical: Bank → Income → Expense → NonPosting (last; not in TB_ACCOUNT_TYPES).
    // Within Bank: 1000 → 1010 (Checking, Savings).
    // Within Income: 4000 → 4100 (Sales Revenue, Consulting Revenue), then unnumbered
    //   (Unnumbered Income) sorts AFTER numbered.
    // Within Expense: 6000 → 6800 → 6850 → 6900 (Rent, ID Only, Empty Name, Old Account).
    expect(names).toEqual([
      "Checking",
      "Savings",
      "Sales Revenue",
      "Consulting Revenue",
      "Unnumbered Income",
      "Rent Expense",
      "ID Only",
      "Empty Name",
      "Old Account",
      "Estimates",
    ]);
  });

  it("preserves IsActive flag on each row", () => {
    const out = buildTaxLineMapping(accounts);
    expect(out.accounts.find((a) => a.accountName === "Old Account")?.isActive).toBe(false);
    expect(out.accounts.find((a) => a.accountName === "Checking")?.isActive).toBe(true);
  });

  it("returns empty for empty input", () => {
    const out = buildTaxLineMapping([]);
    expect(out.count).toBe(0);
    expect(out.mappedCount).toBe(0);
    expect(out.unmappedCount).toBe(0);
    expect(out.accounts).toEqual([]);
  });

  it("skips rows with no FullName/Name", () => {
    const accountsWithBlank: TaxLineMappingAccountInput[] = [
      { ListID: "X1", AccountType: "Bank", IsActive: true,
        TaxLineInfoRet: { TaxLineID: 1, TaxLineName: "Skipped" } },
    ];
    const out = buildTaxLineMapping(accountsWithBlank);
    expect(out.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — End-to-end via QBSessionManager (sim seed)
// ---------------------------------------------------------------------------

describe("qb_tax_line_mapping — end-to-end via QBSessionManager (sim)", () => {
  const runViaSession = async (filters: Record<string, unknown> = {}) => {
    const session = await newSimSession();
    return await session.queryEntity("Account", filters);
  };

  it("returns the 8 seeded mapped accounts by default (Savings + Consulting Revenue excluded)", async () => {
    // The Phase 15 #69 seed update gave 8 of the 10 seeded accounts a
    // TaxLineInfoRet; Savings + Consulting Revenue are intentionally unmapped
    // so the includeUnmapped path has something to exercise.
    const accounts = await runViaSession({ ActiveStatus: "ActiveOnly" });
    const out = buildTaxLineMapping(accounts as TaxLineMappingAccountInput[]);
    expect(out.mappedCount).toBe(8);
    expect(out.unmappedCount).toBe(0); // default drops them
    const names = out.accounts.map((a) => a.accountName);
    expect(names).toContain("Checking");
    expect(names).toContain("Accounts Receivable");
    expect(names).toContain("Accounts Payable");
    expect(names).toContain("Sales Revenue");
    expect(names).toContain("Cost of Goods Sold");
    expect(names).toContain("Rent Expense");
    expect(names).toContain("Utilities");
    expect(names).toContain("Payroll Expense");
    expect(names).not.toContain("Savings");
    expect(names).not.toContain("Consulting Revenue");
  });

  it("includeUnmapped:true surfaces all 10 seeded active accounts", async () => {
    const accounts = await runViaSession({ ActiveStatus: "ActiveOnly" });
    const out = buildTaxLineMapping(accounts as TaxLineMappingAccountInput[], { includeUnmapped: true });
    expect(out.count).toBe(10);
    expect(out.mappedCount).toBe(8);
    expect(out.unmappedCount).toBe(2);
    const unmapped = out.accounts.filter((a) => a.isUnmapped).map((a) => a.accountName).sort();
    expect(unmapped).toEqual(["Consulting Revenue", "Savings"]);
  });

  it("Checking row carries the seeded TaxLineInfoRet from sim", async () => {
    const accounts = await runViaSession({ ActiveStatus: "ActiveOnly" });
    const out = buildTaxLineMapping(accounts as TaxLineMappingAccountInput[]);
    const checking = out.accounts.find((a) => a.accountName === "Checking")!;
    expect(checking.taxLineId).toBe(28);
    expect(checking.taxLineName).toBe("B/S-Assets: Cash");
    expect(checking.accountType).toBe("Bank");
    expect(checking.accountNumber).toBe("1000");
    expect(checking.accountListId).toBe("A0000001");
  });

  it("AccountType filter scopes the wire query (sim handleQuery #69 strict-improvement)", async () => {
    const incomeAccounts = await runViaSession({
      ActiveStatus: "ActiveOnly",
      AccountType: "Income",
    });
    // Only the 2 seeded Income accounts return — handleQuery now applies the
    // AccountType filter (pre-#69 it ignored AccountType silently).
    expect(incomeAccounts.length).toBe(2);
    const names = incomeAccounts.map((a) => String(a.FullName ?? a.Name ?? "")).sort();
    expect(names).toEqual(["Consulting Revenue", "Sales Revenue"]);
  });

  it("scope by Income returns mapped Sales Revenue + (with includeUnmapped) Consulting Revenue", async () => {
    const accounts = await runViaSession({
      ActiveStatus: "ActiveOnly",
      AccountType: "Income",
    });
    const mappedOnly = buildTaxLineMapping(accounts as TaxLineMappingAccountInput[]);
    expect(mappedOnly.count).toBe(1);
    expect(mappedOnly.accounts[0].accountName).toBe("Sales Revenue");

    const withUnmapped = buildTaxLineMapping(accounts as TaxLineMappingAccountInput[], { includeUnmapped: true });
    expect(withUnmapped.count).toBe(2);
    expect(withUnmapped.unmappedCount).toBe(1);
    expect(withUnmapped.accounts.find((a) => a.accountName === "Consulting Revenue")?.isUnmapped).toBe(true);
  });

  it("scope by ListID returns the single named account", async () => {
    const accounts = await runViaSession({ ListID: "A0000008" }); // Rent Expense
    const out = buildTaxLineMapping(accounts as TaxLineMappingAccountInput[]);
    expect(out.count).toBe(1);
    expect(out.accounts[0].accountName).toBe("Rent Expense");
    expect(out.accounts[0].taxLineName).toBe("Deductions: Rents");
  });

  it("scope by FullName returns the single named account", async () => {
    const accounts = await runViaSession({ FullName: "Utilities" });
    const out = buildTaxLineMapping(accounts as TaxLineMappingAccountInput[]);
    expect(out.count).toBe(1);
    expect(out.accounts[0].accountName).toBe("Utilities");
    expect(out.accounts[0].taxLineName).toBe("Deductions: Utilities");
  });

  it("sort order against the seed: Bank → AR → AP → Income → COGS → Expense", async () => {
    const accounts = await runViaSession({ ActiveStatus: "ActiveOnly" });
    const out = buildTaxLineMapping(accounts as TaxLineMappingAccountInput[]);
    const names = out.accounts.map((a) => a.accountName);
    expect(names).toEqual([
      "Checking",
      // Savings dropped (unmapped)
      "Accounts Receivable",
      "Accounts Payable",
      "Sales Revenue",
      // Consulting Revenue dropped (unmapped)
      "Cost of Goods Sold",
      "Rent Expense",
      "Utilities",
      "Payroll Expense",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — Tool surface tests
// ---------------------------------------------------------------------------

describe("qb_tax_line_mapping — tool surface", () => {
  it("returns mapped accounts in the canonical envelope", async () => {
    const { handlers, session } = makeHarness();
    await session.openSession();
    const { result, body } = await call(handlers, "qb_tax_line_mapping");
    expect(result.isError).toBeFalsy();
    expect(body.count).toBe(8);
    expect(body.mappedCount).toBe(8);
    expect(body.unmappedCount).toBe(0);
    expect(body.accounts).toBeInstanceOf(Array);
    // First row is Bank/1000/Checking by canonical sort.
    expect(body.accounts[0].accountName).toBe("Checking");
    expect(body.accounts[0].taxLineName).toBe("B/S-Assets: Cash");
  });

  it("includeUnmapped:true surfaces all 10 seeded accounts with the split", async () => {
    const { handlers, session } = makeHarness();
    await session.openSession();
    const { body } = await call(handlers, "qb_tax_line_mapping", { includeUnmapped: true });
    expect(body.count).toBe(10);
    expect(body.mappedCount).toBe(8);
    expect(body.unmappedCount).toBe(2);
  });

  it("accountType filter scopes to a single type", async () => {
    const { handlers, session } = makeHarness();
    await session.openSession();
    const { body } = await call(handlers, "qb_tax_line_mapping", {
      accountType: "Expense",
      includeUnmapped: true,
    });
    expect(body.accounts.every((a: { accountType: string }) => a.accountType === "Expense")).toBe(true);
    // Three seeded Expense accounts (Rent / Utilities / Payroll) all mapped.
    expect(body.count).toBe(3);
    expect(body.unmappedCount).toBe(0);
  });

  it("accountListId scopes to a single account", async () => {
    const { handlers, session } = makeHarness();
    await session.openSession();
    const { body } = await call(handlers, "qb_tax_line_mapping", {
      accountListId: "A0000007", // Cost of Goods Sold
    });
    expect(body.count).toBe(1);
    expect(body.accounts[0].accountName).toBe("Cost of Goods Sold");
    expect(body.accounts[0].taxLineName).toBe("COGS: Other costs");
  });

  it("accountName scopes to a single account by FullName", async () => {
    const { handlers, session } = makeHarness();
    await session.openSession();
    const { body } = await call(handlers, "qb_tax_line_mapping", {
      accountName: "Accounts Payable",
    });
    expect(body.count).toBe(1);
    expect(body.accounts[0].accountName).toBe("Accounts Payable");
    expect(body.accounts[0].taxLineName).toBe("B/S-Liabs/Eq.: Accounts payable");
  });

  it("returns success with empty accounts when scope matches nothing mapped", async () => {
    const { handlers, session } = makeHarness();
    await session.openSession();
    const { result, body } = await call(handlers, "qb_tax_line_mapping", {
      accountName: "Savings", // unmapped → without includeUnmapped, nothing surfaces
    });
    expect(result.isError).toBeFalsy();
    expect(body.count).toBe(0);
    expect(body.accounts).toEqual([]);
  });

  it("wraps wire failures into the standard error envelope with humanReadable", async () => {
    const { handlers, session } = makeHarness();
    await session.openSession();
    // Force an underlying wire failure by patching queryEntity to throw a
    // structured QB error.
    (session as unknown as { queryEntity: () => Promise<never> }).queryEntity = async () => {
      const err = new Error("simulated AccountQueryRq failure") as Error & { statusCode: number };
      err.statusCode = 3120;
      throw err;
    };
    const { result, body } = await call(handlers, "qb_tax_line_mapping");
    expect(result.isError).toBe(true);
    expect(body.success).toBe(false);
    expect(body.statusCode).toBe(3120);
    expect(body.statusMessage).toContain("simulated AccountQueryRq failure");
    expect(body.humanReadable).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — Integration: qb_trial_balance_export taxLine column now populates
// from the seeded TaxLineInfoRet (was always null pre-#69)
// ---------------------------------------------------------------------------

describe("qb_trial_balance_export taxLine column — integration with #69 seed update", () => {
  it("seeded mapped accounts surface taxLine in the TB row set (sim)", async () => {
    const session = await newSimSession();
    const effectiveAsOf = new Date().toISOString().split("T")[0];
    const accounts = await session.queryEntity("Account", {});
    const bsRet = await session.runReport("BalanceSheetStandard", { toDate: effectiveAsOf, basis: "Accrual" });
    const pnlRet = await session.runReport("ProfitAndLossStandard", { toDate: effectiveAsOf, basis: "Accrual" });
    const tb = buildTrialBalance(
      accounts as TrialBalanceAccount[],
      bsRet as TrialBalanceReportInput,
      pnlRet as TrialBalanceReportInput,
      0,
      0,
    );
    // Pre-#69, this expectation was `.toBeNull()` because the sim seed didn't
    // carry TaxLineInfoRet. The seed update populates 8 of the 10 accounts.
    const checking = tb.rows.find((r) => r.accountName === "Checking");
    expect(checking?.taxLine).toBe("B/S-Assets: Cash");
    const ap = tb.rows.find((r) => r.accountName === "Accounts Payable");
    expect(ap?.taxLine).toBe("B/S-Liabs/Eq.: Accounts payable");
    // Unmapped seed account stays null even with the seed update.
    const savings = tb.rows.find((r) => r.accountName === "Savings");
    if (savings) expect(savings.taxLine).toBeNull();
  });
});
