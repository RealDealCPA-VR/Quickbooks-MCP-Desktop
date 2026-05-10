#!/usr/bin/env node
// Run via the v20 Node that has winax built. Confirms qb_pnl_report's
// adapter math for FY2024 against QB's labelled totals.
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const line of readFileSync(resolve(repoRoot, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const distURL = (rel) => pathToFileURL(resolve(repoRoot, rel)).href;
const { QBSessionManager } = await import(distURL("dist/session/manager.js"));

const manager = new QBSessionManager({
  companyFile: process.env.QB_COMPANY_FILE ?? "",
  appName: "MCP QuickBooks Manager",
  appId: "",
  qbxmlVersion: "16.0",
});
await manager.openSession();

const pnl = await manager.runReport("ProfitAndLossStandard", { fromDate: "2024-01-01", toDate: "2024-12-31", basis: "Accrual" });
console.log("P&L 2024 totals (adapted):");
console.log("  Title:    ", pnl.ReportTitle);
console.log("  Subtitle: ", pnl.ReportSubtitle);
console.log("  Basis:    ", pnl.ReportBasis);
console.log("  Sections: ", pnl.Sections.map((s) => `${s.Name}=${s.Subtotal} (${s.Accounts.length} accts)`).join(" | "));
console.log("  Totals:   ", JSON.stringify(pnl.Totals));

const bs = await manager.runReport("BalanceSheetStandard", { toDate: "2024-12-31", basis: "Accrual" });
console.log("\nBS 2024-12-31 totals (adapted):");
console.log("  Title:    ", bs.ReportTitle);
console.log("  Subtitle: ", bs.ReportSubtitle);
console.log("  Sections: ", bs.Sections.map((s) => `${s.Name}=${s.Subtotal} (${s.Accounts.length} accts)`).join(" | "));
console.log("  Totals:   ", JSON.stringify(bs.Totals));

await manager.closeSession();
