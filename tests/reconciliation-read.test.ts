// Phase 11 #56 + #56a — bank-rec read side.
//
// Coverage layers (mirrors tests/reconciliation.test.ts's layout for the
// write side):
//   1. Builder — buildCustomDetailReportRequest emits the right shape.
//      (Schema-order pin lives in tests/builder-emit-order.test.ts.)
//   2. Parser adapter — adaptLiveCustomDetailReportRet translates a live
//      row-tree response into the simplified {Columns, Rows} shape;
//      extractCustomDetailReportData routes correctly; sim shape passes
//      through unchanged.
//   3. Simulation handler — handleCustomDetailReportQuery walks the seven
//      bank-affecting stores filtered by account / date / cleared-status /
//      modified-date, applies natural-balance sign convention, distinguishes
//      missing-required-filter (3120) from no-match (empty rows).
//   4. Manager method — runCustomDetailReport returns the {Columns, Rows}
//      shape uniformly; read-only sessions do NOT gate (it's a query).
//   5. Tool surface — qb_uncleared_transactions + qb_reconciliation_discrepancy
//      propagate args, default asOfDate / sinceDate / clearedStatusFilter,
//      surface structured errors, compute totals.

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { buildCustomDetailReportRequest } from "../src/qbxml/builder.js";
import {
  extractCustomDetailReportData,
  adaptLiveCustomDetailReportRet,
} from "../src/qbxml/parser.js";
import { registerReconciliationTools } from "../src/tools/reconciliation.js";

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
    appName: "vitest-reconciliation-read",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

async function seedCheck(
  session: QBSessionManager,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return session.addEntity("Check", {
    PayeeEntityRef: { FullName: "Office Supplies Co" },
    AccountRef: { FullName: "Checking" },
    TxnDate: "2026-05-01",
    RefNumber: "CHK-1001",
    Amount: 250.0,
    Memo: "Monthly supplies",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Utilities" }, Amount: 250.0 },
    ],
    ...overrides,
  });
}

async function seedDeposit(
  session: QBSessionManager,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return session.addEntity("Deposit", {
    DepositToAccountRef: { FullName: "Checking" },
    TxnDate: "2026-05-02",
    Memo: "May 2 batch",
    DepositLineAdd: [
      {
        EntityRef: { FullName: "Acme Corporation" },
        AccountRef: { FullName: "Sales Revenue" },
        Amount: 500.0,
      },
      {
        EntityRef: { FullName: "Global Industries" },
        AccountRef: { FullName: "Sales Revenue" },
        Amount: 300.0,
      },
    ],
    ...overrides,
  });
}

async function seedTransfer(
  session: QBSessionManager,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return session.addEntity("Transfer", {
    TransferFromAccountRef: { FullName: "Checking" },
    TransferToAccountRef: { FullName: "Savings" },
    Amount: 1000.0,
    TxnDate: "2026-05-03",
    ...overrides,
  });
}

async function seedCreditCardCharge(
  session: QBSessionManager,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return session.addEntity("CreditCardCharge", {
    AccountRef: { FullName: "Visa Card" },
    PayeeEntityRef: { FullName: "Office Supplies Co" },
    TxnDate: "2026-05-04",
    Amount: 150.0,
    Memo: "Online purchase",
    ExpenseLineAdd: [{ AccountRef: { FullName: "Utilities" }, Amount: 150.0 }],
    ...overrides,
  });
}

beforeEach(() => {
  handlers.clear();
});

// ---------------------------------------------------------------------------
// Layer 1 — builder shape (schema-order pin lives in builder-emit-order.test.ts)
// ---------------------------------------------------------------------------

describe("buildCustomDetailReportRequest", () => {
  it("wraps body in CustomDetailReportQueryRq with default reportType=CustomTxnDetail", () => {
    const xml = buildCustomDetailReportRequest({
      account: { FullName: "Checking" },
      clearedStatusFilter: "UnclearedOnly",
    });
    expect(xml).toContain("<CustomDetailReportQueryRq");
    expect(xml).toContain("<CustomDetailReportType>CustomTxnDetail</CustomDetailReportType>");
    expect(xml).toContain("<ReportAccountFilter>");
    expect(xml).toContain("<FullName>Checking</FullName>");
    expect(xml).toContain("<ReportClearedStatusFilter>UnclearedOnly</ReportClearedStatusFilter>");
    expect(xml).toContain("<ReportBasis>Accrual</ReportBasis>");
  });

  it("ListID-form account selector takes precedence over FullName", () => {
    const xml = buildCustomDetailReportRequest({
      account: { ListID: "ABC-123", FullName: "Checking" },
    });
    expect(xml).toContain("<ListID>ABC-123</ListID>");
    expect(xml).not.toContain("<FullName>Checking</FullName>");
  });

  it("emits ReportPeriod only when at least one of fromDate/toDate is supplied", () => {
    const empty = buildCustomDetailReportRequest({
      account: { FullName: "Checking" },
    });
    expect(empty).not.toContain("<ReportPeriod>");

    const withDates = buildCustomDetailReportRequest({
      account: { FullName: "Checking" },
      fromDate: "2026-05-01",
      toDate: "2026-05-31",
    });
    expect(withDates).toContain("<ReportPeriod>");
    expect(withDates).toContain("<FromReportDate>2026-05-01</FromReportDate>");
    expect(withDates).toContain("<ToReportDate>2026-05-31</ToReportDate>");
  });

  it("emits ReportModifiedDateRangeFilter only when modified-date bounds are supplied", () => {
    const xml = buildCustomDetailReportRequest({
      account: { FullName: "Checking" },
      fromModifiedDate: "2026-05-01",
    });
    expect(xml).toContain("<ReportModifiedDateRangeFilter>");
    expect(xml).toContain("<FromModifiedDate>2026-05-01</FromModifiedDate>");
    expect(xml).not.toContain("<ToModifiedDate>");
  });

  it("emits one <IncludeColumn> per requested column (no wrapper)", () => {
    const xml = buildCustomDetailReportRequest({
      account: { FullName: "Checking" },
      includeColumns: ["TxnType", "Date", "Amount"],
    });
    expect(xml.match(/<IncludeColumn>/g) ?? []).toHaveLength(3);
    expect(xml).toContain("<IncludeColumn>TxnType</IncludeColumn>");
    expect(xml).toContain("<IncludeColumn>Date</IncludeColumn>");
    expect(xml).toContain("<IncludeColumn>Amount</IncludeColumn>");
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — parser adapter
// ---------------------------------------------------------------------------

describe("adaptLiveCustomDetailReportRet", () => {
  it("translates a live row-tree into {Columns, Rows} keyed by ColDesc title", () => {
    // Synthetic live ReportRet — what fast-xml-parser would produce after
    // parsing a real QB CustomDetailReportRs envelope. ColDesc[] declares
    // the column titles + types; ColData inside each DataRow joins by colID.
    const ret = {
      ReportTitle: "Custom Transaction Detail Report",
      ReportBasis: "Accrual",
      ColDesc: [
        { "@_colID": 1, ColType: "Text", ColTitle: "Type" },
        { "@_colID": 2, ColType: "Date", ColTitle: "Date" },
        { "@_colID": 3, ColType: "Text", ColTitle: "Num" },
        { "@_colID": 4, ColType: "Text", ColTitle: "Name" },
        { "@_colID": 5, ColType: "Amount", ColTitle: "Amount" },
        { "@_colID": 6, ColType: "Text", ColTitle: "ClearedStatus" },
      ],
      ReportData: {
        DataRow: [
          {
            "@_rowNumber": 1,
            "@_rowType": "Check",
            ColData: [
              { "@_colID": 1, "@_value": "Check" },
              { "@_colID": 2, "@_value": "2026-05-01" },
              { "@_colID": 3, "@_value": "1001" },
              { "@_colID": 4, "@_value": "Office Supplies Co" },
              { "@_colID": 5, "@_value": "-250.00" },
              { "@_colID": 6, "@_value": "NotCleared" },
            ],
          },
          {
            "@_rowNumber": 2,
            "@_rowType": "Deposit",
            ColData: [
              { "@_colID": 1, "@_value": "Deposit" },
              { "@_colID": 2, "@_value": "2026-05-02" },
              { "@_colID": 4, "@_value": "" }, // empty cells dropped
              { "@_colID": 5, "@_value": "800.00" },
              { "@_colID": 6, "@_value": "Cleared" },
            ],
          },
        ],
      },
    };

    const out = adaptLiveCustomDetailReportRet(ret);
    expect(out.Columns).toHaveLength(6);
    expect((out.Columns as { Title: string }[])[5].Title).toBe("ClearedStatus");

    const rows = out.Rows as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0].Type).toBe("Check");
    expect(rows[0].Amount).toBe(-250); // numeric coercion via ColType=Amount
    expect(rows[0].ClearedStatus).toBe("NotCleared");
    expect(rows[0]._rowType).toBe("Check");
    expect(rows[1].Amount).toBe(800);
    // Empty Name cell is dropped, not surfaced as ""
    expect(rows[1].Name).toBeUndefined();
  });

  it("decodes numeric character references in ColData values (the &#183; case)", () => {
    const ret = {
      ColDesc: [
        { "@_colID": 1, ColType: "Text", ColTitle: "Account" },
      ],
      ReportData: {
        DataRow: [
          {
            "@_rowNumber": 1,
            ColData: [
              { "@_colID": 1, "@_value": "60200 &#183; Automobile Expense" },
            ],
          },
        ],
      },
    };
    const out = adaptLiveCustomDetailReportRet(ret);
    const rows = out.Rows as Record<string, unknown>[];
    expect(rows[0].Account).toBe("60200 · Automobile Expense");
  });

  it("falls back to raw string when numeric coercion would produce NaN", () => {
    const ret = {
      ColDesc: [
        { "@_colID": 1, ColType: "Amount", ColTitle: "Amount" },
      ],
      ReportData: {
        DataRow: [
          { "@_rowNumber": 1, ColData: [{ "@_colID": 1, "@_value": "n/a" }] },
        ],
      },
    };
    const out = adaptLiveCustomDetailReportRet(ret);
    const rows = out.Rows as Record<string, unknown>[];
    expect(rows[0].Amount).toBe("n/a");
  });

  it("returns empty Rows when ReportData.DataRow is missing entirely", () => {
    const ret = { ColDesc: [], ReportData: {} };
    const out = adaptLiveCustomDetailReportRet(ret);
    expect(out.Rows).toEqual([]);
    expect(out.Columns).toEqual([]);
  });

  it("supports ColDescList.ColDesc nesting (older QBXML variants)", () => {
    const ret = {
      ColDescList: {
        ColDesc: [{ "@_colID": 1, ColType: "Text", ColTitle: "Type" }],
      },
      ReportData: {
        DataRow: [
          { "@_rowNumber": 1, ColData: [{ "@_colID": 1, "@_value": "Check" }] },
        ],
      },
    };
    const out = adaptLiveCustomDetailReportRet(ret);
    const rows = out.Rows as Record<string, unknown>[];
    expect(rows[0].Type).toBe("Check");
  });
});

describe("extractCustomDetailReportData", () => {
  it("routes a live response through adaptLiveCustomDetailReportRet", () => {
    const response = {
      responses: [
        {
          type: "CustomDetailReportQueryRs",
          statusCode: 0,
          statusSeverity: "Info",
          statusMessage: "Status OK",
          data: {
            ReportRet: {
              ReportTitle: "X",
              ColDesc: [{ "@_colID": 1, ColType: "Text", ColTitle: "Type" }],
              ReportData: {
                DataRow: [
                  { "@_rowNumber": 1, ColData: [{ "@_colID": 1, "@_value": "Check" }] },
                ],
              },
            },
          },
        },
      ],
    };
    const out = extractCustomDetailReportData(response, "CustomDetailReportQueryRs");
    const rows = out.Rows as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].Type).toBe("Check");
  });

  it("passes through sim shape unchanged (no ReportData → no adapter)", () => {
    const response = {
      responses: [
        {
          type: "CustomDetailReportQueryRs",
          statusCode: 0,
          statusSeverity: "Info",
          statusMessage: "Status OK",
          data: {
            ReportRet: {
              ReportTitle: "X",
              Columns: [{ Title: "TxnType", Type: "Text" }],
              Rows: [{ TxnType: "Check", Amount: -250 }],
            },
          },
        },
      ],
    };
    const out = extractCustomDetailReportData(response, "CustomDetailReportQueryRs");
    expect(out.Columns).toEqual([{ Title: "TxnType", Type: "Text" }]);
    expect(out.Rows).toEqual([{ TxnType: "Check", Amount: -250 }]);
  });

  it("returns {} on the no-data status (1)", () => {
    const response = {
      responses: [
        {
          type: "CustomDetailReportQueryRs",
          statusCode: 1,
          statusSeverity: "Info",
          statusMessage: "no match",
          data: {},
        },
      ],
    };
    const out = extractCustomDetailReportData(response, "CustomDetailReportQueryRs");
    expect(out).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — simulation handler
// ---------------------------------------------------------------------------

describe("SimulationStore — handleCustomDetailReportQuery", () => {
  it("returns Check posting with NEGATIVE amount (Check decreases bank)", async () => {
    const session = freshSession();
    await seedCheck(session);

    const ret = await session.runCustomDetailReport({
      account: { FullName: "Checking" },
    });
    const rows = ret.Rows as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].TxnType).toBe("Check");
    expect(rows[0].Amount).toBe(-250);
    expect(rows[0].ClearedStatus).toBe("NotCleared");
  });

  it("returns Deposit posting with POSITIVE amount (Deposit increases bank)", async () => {
    const session = freshSession();
    await seedDeposit(session);

    const ret = await session.runCustomDetailReport({
      account: { FullName: "Checking" },
    });
    const rows = ret.Rows as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].TxnType).toBe("Deposit");
    // Sum of DepositLine amounts (500 + 300).
    expect(rows[0].Amount).toBe(800);
  });

  it("Transfer hits BOTH from and to accounts when filtering by either", async () => {
    const session = freshSession();
    await seedTransfer(session);

    // Filter by Checking (the from account) — emits negative.
    const fromRet = await session.runCustomDetailReport({
      account: { FullName: "Checking" },
    });
    const fromRows = fromRet.Rows as Record<string, unknown>[];
    expect(fromRows).toHaveLength(1);
    expect(fromRows[0].TxnType).toBe("Transfer");
    expect(fromRows[0].Amount).toBe(-1000);
    expect(fromRows[0].Memo).toBe("Transfer out");

    // Filter by Savings (the to account) — emits positive.
    const toRet = await session.runCustomDetailReport({
      account: { FullName: "Savings" },
    });
    const toRows = toRet.Rows as Record<string, unknown>[];
    expect(toRows).toHaveLength(1);
    expect(toRows[0].Amount).toBe(1000);
    expect(toRows[0].Memo).toBe("Transfer in");
  });

  it("CreditCardCharge posts POSITIVELY (increases CC liability)", async () => {
    const session = freshSession();
    await seedCreditCardCharge(session);

    const ret = await session.runCustomDetailReport({
      account: { FullName: "Visa Card" },
    });
    const rows = ret.Rows as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].TxnType).toBe("CreditCardCharge");
    expect(rows[0].Amount).toBe(150);
  });

  it("BillPaymentCheck posts NEGATIVELY against the bank account", async () => {
    const session = freshSession();
    const bill = await session.addEntity("Bill", {
      VendorRef: { FullName: "Office Supplies Co" },
      TxnDate: "2026-05-01",
      ExpenseLineAdd: [{ AccountRef: { FullName: "Utilities" }, Amount: 100.0 }],
    });
    await session.addEntity("BillPaymentCheck", {
      PayeeEntityRef: { FullName: "Office Supplies Co" },
      BankAccountRef: { FullName: "Checking" },
      TxnDate: "2026-05-05",
      AppliedToTxnAdd: [{ TxnID: String(bill.TxnID), PaymentAmount: 100.0 }],
    });

    const ret = await session.runCustomDetailReport({
      account: { FullName: "Checking" },
    });
    const rows = ret.Rows as Record<string, unknown>[];
    const bp = rows.find((r) => r.TxnType === "BillPaymentCheck");
    expect(bp).toBeDefined();
    expect(bp!.Amount).toBe(-100);
  });

  it("filters by ClearedStatus=UnclearedOnly", async () => {
    const session = freshSession();
    const checkA = await seedCheck(session, { RefNumber: "CHK-A" });
    const checkB = await seedCheck(session, { RefNumber: "CHK-B" });

    // Mark check A cleared; check B stays NotCleared.
    await session.updateClearedStatus({
      txnId: String(checkA.TxnID),
      clearedStatus: "Cleared",
    });

    const uncleared = await session.runCustomDetailReport({
      account: { FullName: "Checking" },
      clearedStatusFilter: "UnclearedOnly",
    });
    const rows = uncleared.Rows as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].TxnID).toBe(String(checkB.TxnID));
  });

  it("filters by ClearedStatus=ClearedOnly", async () => {
    const session = freshSession();
    const checkA = await seedCheck(session, { RefNumber: "CHK-A" });
    await seedCheck(session, { RefNumber: "CHK-B" });
    await session.updateClearedStatus({
      txnId: String(checkA.TxnID),
      clearedStatus: "Cleared",
    });

    const cleared = await session.runCustomDetailReport({
      account: { FullName: "Checking" },
      clearedStatusFilter: "ClearedOnly",
    });
    const rows = cleared.Rows as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].TxnID).toBe(String(checkA.TxnID));
  });

  it("filters by ClearedStatus=All (default)", async () => {
    const session = freshSession();
    await seedCheck(session, { RefNumber: "CHK-A" });
    await seedCheck(session, { RefNumber: "CHK-B" });

    const all = await session.runCustomDetailReport({
      account: { FullName: "Checking" },
      clearedStatusFilter: "All",
    });
    expect((all.Rows as unknown[]).length).toBe(2);
  });

  it("respects toDate (asOfDate) — txns dated after are excluded", async () => {
    const session = freshSession();
    await seedCheck(session, { TxnDate: "2026-05-01", RefNumber: "EARLY" });
    await seedCheck(session, { TxnDate: "2026-06-01", RefNumber: "LATE" });

    const ret = await session.runCustomDetailReport({
      account: { FullName: "Checking" },
      toDate: "2026-05-15",
    });
    const rows = ret.Rows as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].Num).toBe("EARLY");
  });

  it("respects ReportModifiedDateRangeFilter — modified outside window excluded", async () => {
    const session = freshSession();
    const c = await seedCheck(session);
    // Touch TimeModified to a known earlier date (bypassing the manager so
    // we can plant a fixture timestamp directly into the store).
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<?qbxml version="16.0"?>
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
    <CustomDetailReportQueryRq requestID="1">
      <CustomDetailReportType>CustomTxnDetail</CustomDetailReportType>
      <ReportAccountFilter><FullName>Checking</FullName></ReportAccountFilter>
      <ReportModifiedDateRangeFilter>
        <FromModifiedDate>2099-01-01</FromModifiedDate>
      </ReportModifiedDateRangeFilter>
    </CustomDetailReportQueryRq>
  </QBXMLMsgsRq>
</QBXML>`;
    const response = await session.sendRequest(xml);
    const ret = (response.responses[0].data as { ReportRet: { Rows: unknown[] } }).ReportRet;
    expect(ret.Rows).toEqual([]);
    void c;
  });

  it("returns 3120 when ReportAccountFilter is missing", async () => {
    const session = freshSession();
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<?qbxml version="16.0"?>
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
    <CustomDetailReportQueryRq requestID="1">
      <CustomDetailReportType>CustomTxnDetail</CustomDetailReportType>
    </CustomDetailReportQueryRq>
  </QBXMLMsgsRq>
</QBXML>`;
    const response = await session.sendRequest(xml);
    expect(response.responses[0].statusCode).toBe(3120);
    expect(response.responses[0].statusMessage).toMatch(/ReportAccountFilter/);
  });

  it("returns 3120 for an unsupported CustomDetailReportType", async () => {
    const session = freshSession();
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<?qbxml version="16.0"?>
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
    <CustomDetailReportQueryRq requestID="1">
      <CustomDetailReportType>CustomSummary</CustomDetailReportType>
      <ReportAccountFilter><FullName>Checking</FullName></ReportAccountFilter>
    </CustomDetailReportQueryRq>
  </QBXMLMsgsRq>
</QBXML>`;
    const response = await session.sendRequest(xml);
    expect(response.responses[0].statusCode).toBe(3120);
    expect(response.responses[0].statusMessage).toMatch(/CustomSummary/);
  });

  it("returns empty Rows for an account that exists but has no bank-affecting txns", async () => {
    const session = freshSession();
    // No bank-affecting txns seeded. Sales Revenue exists in the seed but
    // doesn't post to any of the seven bank-affecting types.
    const ret = await session.runCustomDetailReport({
      account: { FullName: "Sales Revenue" },
    });
    expect(ret.Rows).toEqual([]);
  });

  it("returns empty Rows for an unknown account name (no error)", async () => {
    const session = freshSession();
    const ret = await session.runCustomDetailReport({
      account: { FullName: "Account That Does Not Exist" },
    });
    expect(ret.Rows).toEqual([]);
  });

  it("ListID-form ReportAccountFilter resolves to the account's FullName", async () => {
    const session = freshSession();
    await seedCheck(session);
    const accounts = await session.queryEntity("Account", {
      FullName: "Checking",
    });
    const checkingListId = String(accounts[0].ListID);

    const ret = await session.runCustomDetailReport({
      account: { ListID: checkingListId },
    });
    expect((ret.Rows as unknown[]).length).toBe(1);
  });

  it("rows sorted by Date ascending, then by TxnID for stability", async () => {
    const session = freshSession();
    await seedCheck(session, { TxnDate: "2026-05-10", RefNumber: "C" });
    await seedCheck(session, { TxnDate: "2026-05-01", RefNumber: "A" });
    await seedCheck(session, { TxnDate: "2026-05-05", RefNumber: "B" });

    const ret = await session.runCustomDetailReport({
      account: { FullName: "Checking" },
    });
    const rows = ret.Rows as Record<string, unknown>[];
    expect(rows.map((r) => r.Num)).toEqual(["A", "B", "C"]);
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — manager method (read-only behavior)
// ---------------------------------------------------------------------------

describe("QBSessionManager.runCustomDetailReport", () => {
  it("does NOT gate on read-only sessions (it's a query)", async () => {
    const session = freshSession();
    await seedCheck(session);
    session.setReadOnly(true);

    // Should NOT throw — reads are unaffected by the read-only gate.
    const ret = await session.runCustomDetailReport({
      account: { FullName: "Checking" },
    });
    expect((ret.Rows as unknown[]).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Layer 5 — qb_uncleared_transactions tool
// ---------------------------------------------------------------------------

describe("qb_uncleared_transactions tool", () => {
  it("happy path: lists uncleared bank transactions with totalAmount", async () => {
    const session = freshSession();
    const checkA = await seedCheck(session, { RefNumber: "CHK-A", Amount: 100 });
    await seedCheck(session, { RefNumber: "CHK-B", Amount: 250 });
    await session.updateClearedStatus({
      txnId: String(checkA.TxnID),
      clearedStatus: "Cleared",
    });

    registerReconciliationTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_uncleared_transactions")!;

    const result = await handler({ accountName: "Checking" });
    expect(result.isError).toBeFalsy();

    const payload = JSON.parse(result.content[0].text);
    expect(payload.account).toBe("Checking");
    expect(payload.clearedStatusFilter).toBe("UnclearedOnly");
    expect(payload.count).toBe(1);
    expect(payload.transactions[0].refNumber).toBe("CHK-B");
    expect(payload.transactions[0].clearedStatus).toBe("NotCleared");
    expect(payload.transactions[0].amount).toBe(-250);
    expect(payload.totalAmount).toBe(-250);
  });

  it("error: missing account args surfaces 3120 + humanReadable", async () => {
    const session = freshSession();
    registerReconciliationTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_uncleared_transactions")!;

    const result = await handler({});
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(3120);
    expect(payload.statusMessage).toMatch(/account/i);
    expect(payload.humanReadable).toBeDefined();
  });

  it("clearedStatusFilter='All' returns both cleared and uncleared txns", async () => {
    const session = freshSession();
    const checkA = await seedCheck(session, { RefNumber: "CHK-A" });
    await seedCheck(session, { RefNumber: "CHK-B" });
    await session.updateClearedStatus({
      txnId: String(checkA.TxnID),
      clearedStatus: "Cleared",
    });

    registerReconciliationTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_uncleared_transactions")!;

    const result = await handler({
      accountName: "Checking",
      clearedStatusFilter: "All",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(2);
  });

  it("clearedStatusFilter='ClearedOnly' surfaces only Cleared txns", async () => {
    const session = freshSession();
    const checkA = await seedCheck(session, { RefNumber: "CHK-A" });
    await seedCheck(session, { RefNumber: "CHK-B" });
    await session.updateClearedStatus({
      txnId: String(checkA.TxnID),
      clearedStatus: "Cleared",
    });

    registerReconciliationTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_uncleared_transactions")!;

    const result = await handler({
      accountName: "Checking",
      clearedStatusFilter: "ClearedOnly",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.transactions[0].refNumber).toBe("CHK-A");
    expect(payload.transactions[0].clearedStatus).toBe("Cleared");
  });

  it("Pending status counts as uncleared (UnclearedOnly default)", async () => {
    const session = freshSession();
    const checkA = await seedCheck(session, { RefNumber: "CHK-A" });
    await session.updateClearedStatus({
      txnId: String(checkA.TxnID),
      clearedStatus: "Pending",
    });

    registerReconciliationTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_uncleared_transactions")!;

    const result = await handler({ accountName: "Checking" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.transactions[0].clearedStatus).toBe("Pending");
  });

  it("asOfDate caps the date window — later txns excluded", async () => {
    const session = freshSession();
    await seedCheck(session, { TxnDate: "2026-04-15", RefNumber: "APR" });
    await seedCheck(session, { TxnDate: "2026-05-15", RefNumber: "MAY" });

    registerReconciliationTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_uncleared_transactions")!;

    const result = await handler({
      accountName: "Checking",
      asOfDate: "2026-04-30",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.transactions[0].refNumber).toBe("APR");
  });

  it("totalAmount sums signed posting amounts (deposits + checks)", async () => {
    const session = freshSession();
    await seedCheck(session, { Amount: 100 }); // -100
    await seedCheck(session, { Amount: 50 }); // -50
    await seedDeposit(session); // +800

    registerReconciliationTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_uncleared_transactions")!;

    const result = await handler({
      accountName: "Checking",
      clearedStatusFilter: "All",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.totalAmount).toBe(650); // -100 + -50 + 800
  });

  it("accountListId variant resolves the account by ListID", async () => {
    const session = freshSession();
    await seedCheck(session);
    const accounts = await session.queryEntity("Account", { FullName: "Checking" });
    const checkingListId = String(accounts[0].ListID);

    registerReconciliationTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_uncleared_transactions")!;

    const result = await handler({ accountListId: checkingListId });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.account).toBe(checkingListId);
  });

  it("read-only session does NOT block (read-side tool)", async () => {
    const session = freshSession();
    await seedCheck(session);
    session.setReadOnly(true);

    registerReconciliationTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_uncleared_transactions")!;

    const result = await handler({ accountName: "Checking" });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Layer 6 — qb_reconciliation_discrepancy tool
// ---------------------------------------------------------------------------

describe("qb_reconciliation_discrepancy tool", () => {
  it("happy path: surfaces a Cleared txn modified within the window", async () => {
    const session = freshSession();
    const check = await seedCheck(session);
    // Mark cleared, then "modify" by flipping status again — TimeModified
    // gets bumped on the second call.
    await session.updateClearedStatus({
      txnId: String(check.TxnID),
      clearedStatus: "Cleared",
    });

    registerReconciliationTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_reconciliation_discrepancy")!;

    const result = await handler({
      accountName: "Checking",
      sinceDate: "2026-01-01",
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.account).toBe("Checking");
    expect(payload.sinceDate).toBe("2026-01-01");
    expect(payload.count).toBe(1);
    expect(payload.candidates[0].clearedStatus).toBe("Cleared");
  });

  it("excludes uncleared txns even when modified in the window", async () => {
    const session = freshSession();
    await seedCheck(session); // NotCleared by default
    // No status flip — stays NotCleared.

    registerReconciliationTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_reconciliation_discrepancy")!;

    const result = await handler({
      accountName: "Checking",
      sinceDate: "2026-01-01",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(0);
    expect(payload.note).toMatch(/no.*modified-after-cleared/i);
  });

  it("defaults sinceDate to ~30 days back when omitted", async () => {
    const session = freshSession();
    const check = await seedCheck(session);
    await session.updateClearedStatus({
      txnId: String(check.TxnID),
      clearedStatus: "Cleared",
    });

    registerReconciliationTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_reconciliation_discrepancy")!;

    const result = await handler({ accountName: "Checking" });
    const payload = JSON.parse(result.content[0].text);
    // The default sinceDate string should be present and ISO-shaped.
    expect(payload.sinceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The check we just modified has a fresh TimeModified, so it should
    // surface within any default 30-day window.
    expect(payload.count).toBe(1);
  });

  it("error: missing account args surfaces 3120", async () => {
    const session = freshSession();
    registerReconciliationTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_reconciliation_discrepancy")!;

    const result = await handler({});
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(3120);
  });

  it("read-only session does NOT block (read-side tool)", async () => {
    const session = freshSession();
    const check = await seedCheck(session);
    await session.updateClearedStatus({
      txnId: String(check.TxnID),
      clearedStatus: "Cleared",
    });
    session.setReadOnly(true);

    registerReconciliationTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_reconciliation_discrepancy")!;

    const result = await handler({
      accountName: "Checking",
      sinceDate: "2026-01-01",
    });
    expect(result.isError).toBeFalsy();
  });
});
