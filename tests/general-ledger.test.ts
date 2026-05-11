// Phase 11 #53 — qb_general_ledger.
//
// Coverage layers:
//   1. Pure helper (buildGeneralLedgerSection) — opening/closing/running-balance
//      math, empty-row handling, account-name + ListID surfacing.
//   2. Tool surface — single-account scope (accountName / accountListId),
//      multi-account fanout, accountType filter, date filter, NonPosting drop,
//      includeEmpty toggle, maxRows truncation, error shapes.
//
// The tool is a composite over TransactionQueryRq + AccountQueryRq — no new
// wire types — so the bulk of the wire-level guarantees ride on the existing
// transaction-list.test.ts coverage. These tests pin the multi-account
// aggregation, section pruning, and warning-surfacing behavior that's unique
// to GL.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import {
  buildGeneralLedgerSection,
  registerReportTools,
} from "../src/tools/reports.js";

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
    appName: "vitest-gl",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  registerReportTools(fakeServer as never, () => session);
  await session.openSession();

  // Mirror transaction-list.test.ts seed — three Rent Expense postings (two
  // Bills + one JE) and two Sales Revenue JEs. The sim's seed Account.Balance
  // is the pre-period snapshot the running-balance math uses; handleAdd on
  // expense lines does NOT mutate Account.Balance so the seed stays intact.
  await session.addEntity("Bill", {
    VendorRef: { FullName: "Office Supplies Co" },
    TxnDate: "2026-02-15",
    RefNumber: "B-1",
    Memo: "Feb rent",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Rent Expense" }, Amount: 2000 },
    ],
  });
  await session.addEntity("Bill", {
    VendorRef: { FullName: "Office Supplies Co" },
    TxnDate: "2026-03-15",
    RefNumber: "B-2",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Rent Expense" }, Amount: 2100 },
    ],
  });
  await session.addEntity("JournalEntry", {
    TxnDate: "2026-04-01",
    RefNumber: "JE-100",
    JournalDebitLineAdd: [
      { AccountRef: { FullName: "Rent Expense" }, Amount: 500 },
    ],
    JournalCreditLineAdd: [
      { AccountRef: { FullName: "Checking" }, Amount: 500 },
    ],
  });
  await session.addEntity("JournalEntry", {
    TxnDate: "2026-05-01",
    RefNumber: "JE-200",
    JournalDebitLineAdd: [
      { AccountRef: { FullName: "Checking" }, Amount: 700 },
    ],
    JournalCreditLineAdd: [
      { AccountRef: { FullName: "Sales Revenue" }, Amount: 700 },
    ],
  });
  await session.addEntity("JournalEntry", {
    TxnDate: "2026-05-15",
    RefNumber: "JE-201",
    JournalDebitLineAdd: [
      { AccountRef: { FullName: "Sales Revenue" }, Amount: 150 },
    ],
    JournalCreditLineAdd: [
      { AccountRef: { FullName: "Checking" }, Amount: 150 },
    ],
  });
});

const callTool = async (toolName: string, args: Record<string, unknown>) => {
  const schema = schemas.get(toolName);
  const handler = handlers.get(toolName);
  if (!schema || !handler) throw new Error(`Tool not registered: ${toolName}`);
  const parsed = z.object(schema).safeParse(args);
  if (!parsed.success) return { schemaError: parsed.error };
  const result = await handler(parsed.data);
  const payload = JSON.parse(result.content[0].text);
  return { result, payload };
};

// ---------------------------------------------------------------------------
// Layer 1 — pure helper math
// ---------------------------------------------------------------------------

describe("Layer 1 — buildGeneralLedgerSection (pure helper)", () => {
  it("opening = currentBalance − periodSum, closing = running after last row", () => {
    const rows = [
      { TxnDate: "2026-02-15", Amount: 2000, RefNumber: "B-1" },
      { TxnDate: "2026-03-15", Amount: 2100, RefNumber: "B-2" },
      { TxnDate: "2026-04-01", Amount: 500, RefNumber: "JE-100" },
    ];
    const section = buildGeneralLedgerSection(
      { ListID: "A0000008", FullName: "Rent Expense", AccountType: "Expense", Balance: 24000 },
      rows,
    );

    expect(section.accountName).toBe("Rent Expense");
    expect(section.accountListId).toBe("A0000008");
    expect(section.accountType).toBe("Expense");
    expect(section.openingBalance).toBe(19400); // 24000 - 4600
    expect(section.closingBalance).toBe(24000); // closes back to seed
    expect(section.periodChange).toBe(4600);
    expect(section.count).toBe(3);

    const tx = section.transactions;
    expect(Number(tx[0].RunningBalance)).toBe(21400); // 19400 + 2000
    expect(Number(tx[1].RunningBalance)).toBe(23500); // 21400 + 2100
    expect(Number(tx[2].RunningBalance)).toBe(24000); // 23500 + 500
  });

  it("empty rows → opening = closing = currentBalance, periodChange = 0", () => {
    const section = buildGeneralLedgerSection(
      { FullName: "Rent Expense", AccountType: "Expense", Balance: 24000 },
      [],
    );
    expect(section.count).toBe(0);
    expect(section.transactions).toEqual([]);
    expect(section.openingBalance).toBe(24000);
    expect(section.closingBalance).toBe(24000);
    expect(section.periodChange).toBe(0);
  });

  it("mixed-sign rows (natural-credit account) compute correctly", () => {
    // Sales Revenue (natural-credit, Balance=185000): credit JE +700, debit JE -150.
    const rows = [
      { TxnDate: "2026-05-01", Amount: 700, RefNumber: "JE-200" },
      { TxnDate: "2026-05-15", Amount: -150, RefNumber: "JE-201" },
    ];
    const section = buildGeneralLedgerSection(
      { FullName: "Sales Revenue", AccountType: "Income", Balance: 185000 },
      rows,
    );
    expect(section.openingBalance).toBe(184450); // 185000 - 550
    expect(section.closingBalance).toBe(185000);
    expect(section.periodChange).toBe(550);
    expect(Number(section.transactions[0].RunningBalance)).toBe(185150);
    expect(Number(section.transactions[1].RunningBalance)).toBe(185000);
  });

  it("preserves row fields beyond Amount on each transaction", () => {
    const rows = [
      {
        TxnID: "TX-9",
        TxnType: "Bill",
        TxnDate: "2026-02-15",
        RefNumber: "B-1",
        Memo: "Feb rent",
        Amount: 2000,
      },
    ];
    const section = buildGeneralLedgerSection(
      { FullName: "Rent Expense", AccountType: "Expense", Balance: 24000 },
      rows,
    );
    expect(section.transactions[0]).toMatchObject({
      TxnID: "TX-9",
      TxnType: "Bill",
      RefNumber: "B-1",
      Memo: "Feb rent",
      Amount: 2000,
      RunningBalance: 24000,
    });
  });

  it("falls back to Name when FullName absent, omits accountListId when no ListID", () => {
    const section = buildGeneralLedgerSection(
      { Name: "Some Account", AccountType: "Bank", Balance: 100 },
      [],
    );
    expect(section.accountName).toBe("Some Account");
    expect(section).not.toHaveProperty("accountListId");
  });

  it("rounds opening/closing/running to 2 decimals (float-safe)", () => {
    const rows = [
      { TxnDate: "2026-02-15", Amount: 0.1 },
      { TxnDate: "2026-02-16", Amount: 0.2 }, // 0.1 + 0.2 = 0.30000000000000004 in IEEE 754
    ];
    const section = buildGeneralLedgerSection(
      { FullName: "Test", AccountType: "Expense", Balance: 10 },
      rows,
    );
    expect(section.openingBalance).toBe(9.7); // 10 - 0.3
    expect(section.closingBalance).toBe(10);
    // No 0.30000000000000004 sneak-through:
    expect(String(section.closingBalance)).not.toContain("0000");
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — single-account scope
// ---------------------------------------------------------------------------

describe("Layer 2 — qb_general_ledger single-account scope", () => {
  it("accountName scope returns one section matching qb_transaction_list_by_account math", async () => {
    const { payload } = (await callTool("qb_general_ledger", {
      accountName: "Rent Expense",
    })) as { payload: Record<string, unknown> };

    const sections = payload.sections as Record<string, unknown>[];
    expect(payload.accountCount).toBe(1);
    expect(sections.length).toBe(1);
    expect(sections[0].accountName).toBe("Rent Expense");
    expect(sections[0].accountType).toBe("Expense");
    expect(sections[0].openingBalance).toBe(19400);
    expect(sections[0].closingBalance).toBe(24000);
    expect(sections[0].count).toBe(3);
    expect(payload.totalRowCount).toBe(3);
  });

  it("accountListId scope resolves the same way", async () => {
    const { payload } = (await callTool("qb_general_ledger", {
      accountListId: "A0000008", // Rent Expense per simulation-store seed
    })) as { payload: Record<string, unknown> };

    const sections = payload.sections as Record<string, unknown>[];
    expect(sections.length).toBe(1);
    expect(sections[0].accountName).toBe("Rent Expense");
    expect(sections[0].accountListId).toBe("A0000008");
    expect(sections[0].count).toBe(3);
  });

  it("unknown accountName returns isError with statusCode 500", async () => {
    const { result, payload } = (await callTool("qb_general_ledger", {
      accountName: "Definitely Not An Account",
    })) as { result: { isError?: boolean }; payload: Record<string, unknown> };
    expect(result.isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(payload.statusCode).toBe(500);
    expect(String(payload.statusMessage)).toMatch(/Definitely Not An Account/);
  });

  it("unknown accountListId returns isError with statusCode 500", async () => {
    const { result, payload } = (await callTool("qb_general_ledger", {
      accountListId: "A9999999",
    })) as { result: { isError?: boolean }; payload: Record<string, unknown> };
    expect(result.isError).toBe(true);
    expect(payload.statusCode).toBe(500);
  });

  it("accountListId wins over accountName when both supplied (single-account resolution)", async () => {
    // Pass an accountName that exists AND an accountListId pointing elsewhere.
    // The ListID resolution path runs first (matches the code's branch order).
    const { payload } = (await callTool("qb_general_ledger", {
      accountName: "Rent Expense", // ignored
      accountListId: "A0000005", // Sales Revenue
    })) as { payload: Record<string, unknown> };
    const sections = payload.sections as Record<string, unknown>[];
    expect(sections[0].accountName).toBe("Sales Revenue");
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — accountType filter + multi-account fanout
// ---------------------------------------------------------------------------

describe("Layer 3 — accountType filter & multi-account fanout", () => {
  it("accountType:'Expense' scopes to expense accounts; non-empty sections only", async () => {
    const { payload } = (await callTool("qb_general_ledger", {
      accountType: "Expense",
    })) as { payload: Record<string, unknown> };

    const sections = payload.sections as Record<string, unknown>[];
    // Of the seed expense accounts (Rent Expense / Utilities / Payroll
    // Expense / ...), only Rent Expense has period activity. Empty sections
    // are pruned by default → exactly one section.
    expect(sections.length).toBe(1);
    expect(sections[0].accountName).toBe("Rent Expense");
    expect(sections[0].accountType).toBe("Expense");
  });

  it("accountType:'Income' scopes to income accounts", async () => {
    const { payload } = (await callTool("qb_general_ledger", {
      accountType: "Income",
    })) as { payload: Record<string, unknown> };

    const sections = payload.sections as Record<string, unknown>[];
    // Seed income accounts (Sales Revenue / Consulting Revenue) — Sales
    // Revenue has 2 JE postings, Consulting Revenue is dormant.
    expect(sections.length).toBe(1);
    expect(sections[0].accountName).toBe("Sales Revenue");
    expect(sections[0].count).toBe(2);
  });

  it("includeEmpty:true keeps zero-activity sections", async () => {
    const { payload } = (await callTool("qb_general_ledger", {
      accountType: "Income",
      includeEmpty: true,
    })) as { payload: Record<string, unknown> };

    const sections = payload.sections as Record<string, unknown>[];
    const names = sections.map((s) => s.accountName).sort();
    // Both income accounts present, dormant one has count 0 and
    // opening=closing=currentBalance.
    expect(names).toContain("Sales Revenue");
    expect(names).toContain("Consulting Revenue");
    const consulting = sections.find((s) => s.accountName === "Consulting Revenue");
    expect(consulting?.count).toBe(0);
    expect(consulting?.openingBalance).toBe(consulting?.closingBalance);
    expect(consulting?.periodChange).toBe(0);
  });

  it("no filter at all fans out across every GL-affecting account (NonPosting dropped)", async () => {
    const { payload } = (await callTool("qb_general_ledger", {})) as {
      payload: Record<string, unknown>;
    };

    const sections = payload.sections as Record<string, unknown>[];
    // At minimum, Rent Expense and Sales Revenue have activity.
    const names = sections.map((s) => s.accountName);
    expect(names).toContain("Rent Expense");
    expect(names).toContain("Sales Revenue");
    // NonPosting account types must not appear unless explicitly named.
    for (const s of sections) {
      expect(s.accountType).not.toBe("NonPosting");
    }
  });

  it("warns when NonPosting accounts are dropped from the chart-wide fanout", async () => {
    // Seed an explicit NonPosting account so the warning path is exercised.
    await session.addEntity("Account", {
      Name: "Estimates Sink",
      AccountType: "NonPosting",
    });

    const { payload } = (await callTool("qb_general_ledger", {})) as {
      payload: Record<string, unknown>;
    };
    expect(payload.warnings).toBeDefined();
    const w = payload.warnings as string[];
    expect(w.some((m) => /NonPosting/.test(m))).toBe(true);
    expect(w.some((m) => /Estimates Sink/.test(m))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — date filter + truncation
// ---------------------------------------------------------------------------

describe("Layer 4 — date filter & truncation", () => {
  it("fromDate/toDate narrows per-section row set", async () => {
    const { payload } = (await callTool("qb_general_ledger", {
      accountName: "Rent Expense",
      fromDate: "2026-03-01",
      toDate: "2026-04-30",
    })) as { payload: Record<string, unknown> };

    const sections = payload.sections as Record<string, unknown>[];
    expect(sections[0].count).toBe(2); // B-2 (Mar) + JE-100 (Apr)
    expect(sections[0].openingBalance).toBe(21400); // 24000 - 2600
    const tx = sections[0].transactions as Record<string, unknown>[];
    expect(tx[0].RefNumber).toBe("B-2");
    expect(tx[1].RefNumber).toBe("JE-100");
  });

  it("emits filters in TransactionQueryRq schema order via session.queryTransactions", async () => {
    // Schema order: MaxReturned → TxnDateRangeFilter → AccountFilter.
    // (Pinned at wire level by tests/builder-emit-order.test.ts; here we
    // assert the tool layer populates the filter dict in that exact order
    // since buildQueryRequest preserves insertion order.)
    const spy = vi.spyOn(session, "queryTransactions");
    spy.mockClear();

    await callTool("qb_general_ledger", {
      accountName: "Rent Expense",
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      maxRowsPerAccount: 100,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const filters = spy.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(filters)).toEqual([
      "MaxReturned",
      "TxnDateRangeFilter",
      "AccountFilter",
    ]);
    expect(filters.MaxReturned).toBe(100);
    spy.mockRestore();
  });

  it("maxRowsPerAccount cap flags truncated:true on the section", async () => {
    const { payload } = (await callTool("qb_general_ledger", {
      accountName: "Rent Expense",
      maxRowsPerAccount: 2, // 3 rows exist; cap forces truncation
    })) as { payload: Record<string, unknown> };

    const sections = payload.sections as Record<string, unknown>[];
    expect(sections[0].count).toBe(2);
    expect(sections[0].truncated).toBe(true);
  });

  it("maxAccounts cap truncates the fanout + surfaces a warning", async () => {
    const { payload } = (await callTool("qb_general_ledger", {
      maxAccounts: 1,
    })) as { payload: Record<string, unknown> };

    expect(payload.accountCount).toBeLessThanOrEqual(1);
    const w = (payload.warnings as string[] | undefined) ?? [];
    expect(w.some((m) => /maxAccounts/.test(m))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 5 — defensive section-level error handling
// ---------------------------------------------------------------------------

describe("Layer 5 — section-level error isolation", () => {
  it("a single account's query failure surfaces as section.error without poisoning the rest", async () => {
    // Stub queryTransactions: throw on the first call, succeed on the second.
    // We use accountType="Income" so only the two income accounts get fanned
    // out (Sales Revenue + Consulting Revenue). Both go through the spy.
    const spy = vi.spyOn(session, "queryTransactions");
    let callIdx = 0;
    spy.mockImplementation(async () => {
      callIdx += 1;
      if (callIdx === 1) throw new Error("simulated wire failure");
      return [];
    });

    const { payload } = (await callTool("qb_general_ledger", {
      accountType: "Income",
      includeEmpty: true, // so the empty (mocked) sections survive the prune
    })) as { payload: Record<string, unknown> };

    const sections = payload.sections as Record<string, unknown>[];
    expect(sections.length).toBe(2);
    const errored = sections.find((s) => s.error !== undefined);
    const ok = sections.find((s) => s.error === undefined);
    expect(errored).toBeDefined();
    expect(String(errored!.error)).toMatch(/simulated wire failure/);
    expect(ok).toBeDefined();
    spy.mockRestore();
  });
});
