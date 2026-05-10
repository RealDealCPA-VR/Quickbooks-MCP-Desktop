// Pickup verification for handoff dated 2026-04-27.
// Runs the seven Verify Before Continuing checks against simulation handlers
// captured via a fake MCP server.

import { QBSessionManager } from "../dist/session/manager.js";
import { registerBillTools } from "../dist/tools/bills.js";
import { registerReportTools } from "../dist/tools/reports.js";

const handlers = new Map();
const fakeServer = {
  tool: (name, _description, _schema, handler) => {
    handlers.set(name, handler);
  },
};

const session = new QBSessionManager({
  companyFile: "simulation",
  appName: "verify",
  qbxmlVersion: "16.0",
  connectionMode: "optimistic",
});
const getSession = () => session;

registerBillTools(fakeServer, getSession);
registerReportTools(fakeServer, getSession);

await session.openSession();

const call = async (name, args = {}) => {
  const h = handlers.get(name);
  if (!h) throw new Error(`tool not registered: ${name}`);
  const result = await h(args);
  const text = result.content[0].text;
  return { isError: !!result.isError, body: JSON.parse(text) };
};

const results = [];
const log = (label, pass, detail = "") => {
  results.push({ label, pass, detail });
  const tag = pass ? "PASS" : "FAIL";
  console.log(`[${tag}] ${label}${detail ? " — " + detail : ""}`);
};

// 1. qb_pnl_report empty period
{
  const r = await call("qb_pnl_report", { fromDate: "2030-01-01", toDate: "2030-12-31" });
  const b = r.body;
  const ok =
    !r.isError &&
    Array.isArray(b.sections) &&
    b.sections.length === 0 &&
    b.totalIncome === 0 &&
    b.totalExpenses === 0 &&
    b.totalCOGS === 0 &&
    b.grossProfit === 0 &&
    b.netIncome === 0;
  log(
    "qb_pnl_report empty period",
    ok,
    `sections.len=${b.sections?.length} totalIncome=${b.totalIncome} totalExpenses=${b.totalExpenses} netIncome=${b.netIncome}`
  );
}

// 2. qb_pnl_report populated path — create a bill, then run P&L
{
  const billRes = await call("qb_bill_create", {
    vendorName: "Acme Office Supplies",
    txnDate: "2026-03-15",
    expenseLines: [{ accountName: "Rent Expense", amount: 1200 }],
  });
  if (billRes.isError) {
    log("qb_pnl_report populated path (bill creation)", false, `bill_create error: ${billRes.body.statusMessage}`);
  } else {
    const r = await call("qb_pnl_report", { fromDate: "2026-01-01", toDate: "2026-12-31" });
    const b = r.body;
    const expensesSection = b.sections?.find((s) => s.name === "Expenses");
    const rentRow = expensesSection?.accounts?.find((a) => a.name === "Rent Expense");
    const ok =
      !r.isError &&
      expensesSection &&
      expensesSection.subtotal === 1200 &&
      rentRow &&
      rentRow.total === 1200;
    log(
      "qb_pnl_report populated path",
      !!ok,
      `Expenses.subtotal=${expensesSection?.subtotal} Rent.total=${rentRow?.total}`
    );
  }
}

// 3. qb_balance_sheet_report identity
{
  const r = await call("qb_balance_sheet_report", { asOfDate: "2026-12-31" });
  const b = r.body;
  const lhs = Math.round(b.totalAssets * 100);
  const rhs = Math.round((b.totalLiabilities + b.totalEquity) * 100);
  const ok = !r.isError && lhs === rhs;
  log(
    "qb_balance_sheet_report identity",
    ok,
    `totalAssets=${b.totalAssets} totalLiabilities=${b.totalLiabilities} totalEquity=${b.totalEquity}`
  );
}

// 4. qb_balance_summary regression — Bank first @ 165000, asOfDate honored
//    Pre-Phase-9-#38 (2026-05-09) this asserted netIncome === -22800 read
//    from seeded Account.Balance fields. Post-#38 the tool sources INC/EXP
//    from a P&L walk (the seeded invoices carry no line arrays, so the
//    walk yields 0). The new contract: Bank is first, totals to 165000,
//    and the response carries asOfDate (defaulted to today) instead of
//    the old asOfNote/asOfDateRange.
{
  const r = await call("qb_balance_summary", {});
  const b = r.body;
  const groups = Array.isArray(b.balanceSummary) ? b.balanceSummary.map((g) => g.accountType) : [];
  const bank = b.balanceSummary?.find?.((g) => g.accountType === "Bank");
  const ok =
    !r.isError &&
    bank?.total === 165000 &&
    groups[0] === "Bank" &&
    typeof b.asOfDate === "string";
  log(
    "qb_balance_summary regression",
    ok,
    `bankTotal=${bank?.total} firstGroup=${groups[0]} asOfDate=${b.asOfDate}`
  );
}

// 5. qb_ar_aging / qb_ap_aging regression
{
  const ar = await call("qb_ar_aging", {});
  const arBody = ar.body;
  const arTotal = arBody.totalAccountsReceivable;
  const arOk = !ar.isError && arTotal === 16000;
  log("qb_ar_aging regression", arOk, `totalAccountsReceivable=${arTotal}`);

  // qb_ap_aging now reflects the bill we just created ($1200), not 0.
  const ap = await call("qb_ap_aging", {});
  const apBody = ap.body;
  const apTotal = apBody.totalAccountsPayable;
  const apOk = !ap.isError && apTotal === 1200;
  log(
    "qb_ap_aging regression (post-bill)",
    apOk,
    `totalAccountsPayable=${apTotal} (expected 1200 — pickup bill in §2 inflates this from 0)`
  );
}

// 6. qb_company_info regression — Demo Co
{
  const r = await call("qb_company_info", {});
  const b = r.body;
  const name = b.companyInfo?.CompanyName ?? null;
  const ok = !r.isError && typeof name === "string" && /Demo Co/i.test(name);
  log("qb_company_info regression", ok, `CompanyName=${name}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
