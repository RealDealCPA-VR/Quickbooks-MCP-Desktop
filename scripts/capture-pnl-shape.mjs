#!/usr/bin/env node
/**
 * Captures the raw ReportRet shape from a live qb_pnl_report call so the
 * row-tree → simplified-shape adapter (for extractReportData live path) can
 * be designed against actual data, not guessed at from the SDK docs.
 *
 * Run with the v20 Node that has winax built:
 *   "C:/nvm4w/nodejs/node.exe" scripts/capture-pnl-shape.mjs
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const envPath = resolve(repoRoot, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const distURL = (rel) => pathToFileURL(resolve(repoRoot, rel)).href;
const { QBSessionManager } = await import(distURL("dist/session/manager.js"));
const { buildReportRequest } = await import(distURL("dist/qbxml/builder.js"));

const manager = new QBSessionManager({
  companyFile: process.env.QB_COMPANY_FILE ?? "",
  appName: "MCP QuickBooks Manager",
  appId: "",
  qbxmlVersion: "16.0",
});
await manager.openSession();

// Capture raw XML by tapping sendRequest indirectly — we run the same builder
// flow but call sendRequest manually so we can dump the wire response.
async function dump(name, xml) {
  console.log(`=== ${name} REQUEST ===`);
  console.log(xml);
  const response = await manager.sendRequest(xml);
  const out = JSON.stringify(response, null, 2);
  const file = resolve(repoRoot, `scripts/.${name.toLowerCase()}-shape-dump.json`);
  writeFileSync(file, out);
  console.log(`(${out.length} chars written to ${file})\n`);
}

await dump("PNL", buildReportRequest(
  { reportType: "ProfitAndLossStandard", fromDate: "2024-01-01", toDate: "2024-12-31", basis: "Accrual" },
  "16.0",
));
await dump("BS", buildReportRequest(
  { reportType: "BalanceSheetStandard", toDate: "2024-12-31", basis: "Accrual" },
  "16.0",
));

await manager.closeSession();
