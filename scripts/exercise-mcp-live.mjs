#!/usr/bin/env node
/**
 * Drives the MCP server (dist/index.js) over stdio in live mode and exercises
 * a set of read-only tools against the currently open QB company file. Prints
 * a compact pass/fail line per tool plus a sample of the returned payload.
 *
 * Run from the repo root:
 *   node scripts/exercise-mcp-live.mjs
 *
 * Exit codes:
 *   0  every tool returned a structured response (isError=false)
 *   1  config / env wrong (manager resolved to simulation, missing dist, etc.)
 *   2  one or more tools returned isError=true or threw at the transport layer
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const envPath = resolve(repoRoot, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

if (process.env.QB_LIVE !== "1") {
  console.error("ERROR: QB_LIVE must be 1 in .env. Aborting (this is a LIVE-mode exerciser).");
  process.exit(1);
}

const distEntry = resolve(repoRoot, "dist/index.js");
if (!existsSync(distEntry)) {
  console.error(`ERROR: ${distEntry} not found. Run 'npm run build' first.`);
  process.exit(1);
}

const child = spawn(process.execPath, [distEntry], {
  cwd: repoRoot,
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve: r } = pending.get(msg.id);
      pending.delete(msg.id);
      r(msg);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(payload);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function preview(text, max = 240) {
  if (typeof text !== "string") text = JSON.stringify(text);
  text = text.replace(/\s+/g, " ");
  return text.length > max ? text.slice(0, max) + "..." : text;
}

async function callTool(name, args = {}, label = "") {
  const res = await rpc("tools/call", { name, arguments: args });
  const labelPart = label ? ` [${label}]` : "";
  if (res.error) {
    console.log(`  FAIL  ${name}${labelPart}: ${res.error.message}`);
    return { ok: false, body: null };
  }
  const isErr = res.result?.isError === true;
  const text = res.result?.content?.[0]?.text ?? "";
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  const tag = isErr ? "FAIL" : "OK  ";
  console.log(`  ${tag}  ${name}${labelPart}: ${preview(text)}`);
  return { ok: !isErr, body };
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "exercise-mcp-live", version: "0.1.0" },
  });
  console.log(`Server: ${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}`);
  notify("notifications/initialized");

  const list = await rpc("tools/list", {});
  const tools = list.result?.tools ?? [];
  console.log(`Tools registered: ${tools.length}\n`);

  console.log("Read-only tool checks:");
  // Each tuple is [toolName, args, label?]. The label disambiguates multiple
  // calls to the same tool. Multi-filter combos are present specifically to
  // exercise QBXML schema-sequence ordering — see DECISIONS.md 2026-05-09.
  // A single bad insertion order in any *_list tool will manifest as the
  // cryptic "QuickBooks found an error when parsing the provided XML text
  // stream" once two or more filters are present.
  const checks = [
    ["qb_company_info", {}],

    // List-tool multi-filter probes.
    ["qb_account_list", { activeOnly: true }],
    ["qb_account_list", { accountType: "Bank", activeOnly: true }, "AccountType+ActiveStatus"],
    ["qb_customer_list", { activeOnly: true, maxReturned: 5 }, "ActiveStatus+MaxReturned"],
    ["qb_vendor_list", { activeOnly: true, maxReturned: 5 }, "ActiveStatus+MaxReturned"],
    ["qb_item_list", { itemType: "Service", activeOnly: true, maxReturned: 5 }, "ActiveStatus+MaxReturned"],
    ["qb_employee_list", { activeOnly: true, maxReturned: 5 }, "ActiveStatus+MaxReturned"],
    ["qb_terms_list", { activeOnly: true, maxReturned: 5 }, "ActiveStatus+MaxReturned"],
    ["qb_class_list", { activeOnly: true, maxReturned: 5 }, "ActiveStatus+MaxReturned"],

    // Transaction-tool multi-filter probes — these are the ones that were
    // latently broken before the 2026-05-09 fix.
    ["qb_invoice_list", { maxReturned: 5 }, "MaxReturned only"],
    ["qb_invoice_list", { fromDate: "2019-01-01", toDate: "2026-12-31", maxReturned: 5 }, "DateRange+MaxReturned"],
    ["qb_invoice_list", { fromDate: "2019-01-01", toDate: "2026-12-31", paidStatus: "All", maxReturned: 5 }, "DateRange+PaidStatus+MaxReturned"],
    ["qb_bill_list", { fromDate: "2019-01-01", toDate: "2026-12-31", paidStatus: "All", maxReturned: 5 }, "DateRange+PaidStatus+MaxReturned"],
    ["qb_estimate_list", { fromDate: "2019-01-01", toDate: "2026-12-31", maxReturned: 5 }, "DateRange+MaxReturned"],
    ["qb_sales_receipt_list", { fromDate: "2019-01-01", toDate: "2026-12-31", maxReturned: 5 }, "DateRange+MaxReturned"],
    ["qb_credit_memo_list", { fromDate: "2019-01-01", toDate: "2026-12-31", maxReturned: 5 }, "DateRange+MaxReturned"],
    ["qb_purchase_order_list", { fromDate: "2019-01-01", toDate: "2026-12-31", maxReturned: 5 }, "DateRange+MaxReturned"],
    ["qb_journal_entry_list", { fromDate: "2019-01-01", toDate: "2026-12-31", maxReturned: 5 }, "TxnDateRange+MaxReturned"],
    ["qb_payment_list", { fromDate: "2019-01-01", toDate: "2026-12-31", maxReturned: 5 }, "DateRange+MaxReturned"],
    ["qb_bill_payment_list", { fromDate: "2019-01-01", toDate: "2026-12-31", maxReturned: 5 }, "DateRange+MaxReturned"],
  ];
  let failures = 0;
  for (const [name, args, label] of checks) {
    const { ok } = await callTool(name, args, label);
    if (!ok) failures++;
  }

  console.log("");
  if (failures === 0) {
    console.log(`OK: ${checks.length}/${checks.length} read-only tools returned structured responses.`);
  } else {
    console.log(`FAIL: ${failures}/${checks.length} tools returned isError=true.`);
  }
  child.stdin.end();
  child.kill();
  process.exit(failures === 0 ? 0 : 2);
} catch (err) {
  console.error(`Transport error: ${err.message}`);
  child.kill();
  process.exit(2);
}
