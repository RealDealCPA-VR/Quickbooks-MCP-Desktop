#!/usr/bin/env node
/**
 * Live-mode smoke test for the QBSessionManager. Exercises the full path
 * the MCP tools use: openSession -> queryEntity("Company") -> closeSession.
 *
 * Requires Windows + QuickBooks Desktop running with a company file open,
 * the QB SDK 16.0 registered, and `winax` compiled in node_modules. Reads
 * QB_* env vars from .env (if present) without pulling in a dotenv dep.
 *
 * Run from the repo root:
 *   node scripts/verify-live-connection.mjs
 *
 * Exit codes:
 *   0  success — live ticket received, company info parsed
 *   1  config / env wrong (manager resolved to simulation, or missing vars)
 *   2  COM-side failure (winax not installed, openSession threw, etc.)
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env loader -- six lines of parsing instead of a runtime dep.
const envPath = resolve(repoRoot, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

console.log("Resolved env:");
console.log(`  QB_LIVE         = ${process.env.QB_LIVE ?? "(unset)"}`);
console.log(`  QB_SIMULATION   = ${process.env.QB_SIMULATION ?? "(unset)"}`);
console.log(`  QB_COMPANY_FILE = ${process.env.QB_COMPANY_FILE || "(empty -- use currently open file)"}`);
console.log(`  QB_APP_NAME     = ${process.env.QB_APP_NAME ?? "(unset)"}`);
console.log("");

const distManager = resolve(repoRoot, "dist/session/manager.js");
if (!existsSync(distManager)) {
  console.error(`ERROR: ${distManager} not found. Run \`npm run build\` first.`);
  process.exit(2);
}
const { QBSessionManager } = await import(pathToFileURL(distManager).href);

const sm = new QBSessionManager({
  companyFile: process.env.QB_COMPANY_FILE ?? "",
  appName: process.env.QB_APP_NAME ?? "MCP QuickBooks Manager",
  appId: process.env.QB_APP_ID,
  qbxmlVersion: process.env.QB_QBXML_VERSION ?? "16.0",
});

if (sm.isSimulation()) {
  console.error("ERROR: Manager resolved to simulation mode.");
  console.error("  Set QB_LIVE=1 in .env (and QB_SIMULATION=false), then re-run.");
  process.exit(1);
}

console.log("Mode: live. Opening session...");
let session;
try {
  session = await sm.openSession();
} catch (err) {
  console.error(`openSession() failed: ${err.message}`);
  process.exit(2);
}
console.log(`  ticket:      ${session.ticket}`);
console.log(`  companyFile: ${session.companyFile || "(QB's currently open file)"}`);
console.log("");

console.log("Querying CompanyQueryRq via session.queryEntity('Company')...");
let companies;
try {
  companies = await sm.queryEntity("Company");
} catch (err) {
  console.error(`queryEntity('Company') failed: ${err.message}`);
  await sm.closeSession();
  process.exit(2);
}

const co = Array.isArray(companies) ? companies[0] : companies;
if (!co || !co.CompanyName) {
  console.error("Query returned no CompanyName -- response shape unexpected.");
  console.error(JSON.stringify(companies, null, 2).slice(0, 1000));
  await sm.closeSession();
  process.exit(2);
}

console.log(`  CompanyName:        ${co.CompanyName}`);
console.log(`  LegalCompanyName:   ${co.LegalCompanyName ?? "(none)"}`);
console.log(`  TaxForm:            ${co.TaxForm ?? "(none)"}`);
console.log(`  EIN:                ${co.EIN ?? "(none)"}`);
console.log(`  FirstMonthFiscalYr: ${co.FirstMonthFiscalYear ?? "(none)"}`);
console.log("");

console.log("Closing session...");
await sm.closeSession();

console.log("");
console.log("OK: live smoke test passed.");
console.log("    Phase 7 Item 1's MCP code path is verified end-to-end on this PC.");
