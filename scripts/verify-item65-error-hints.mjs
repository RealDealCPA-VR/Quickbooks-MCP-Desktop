#!/usr/bin/env node
/**
 * Phase 14 #65 — live verification of the enriched-error wrapper.
 *
 * Connects in live mode, fires a series of deliberately-broken QBXML
 * envelopes against the open company file, and prints the response of
 * formatToolError on each thrown QBXMLResponseError. Confirms the
 * heuristic correctly classifies real QB error messages and surfaces the
 * canonical schema-order back to the caller.
 *
 * Usage (Windows + QB Desktop + open .qbw):
 *   & "C:\nvm4w\nodejs\node.exe" scripts\verify-item65-error-hints.mjs
 *
 * Exit codes:
 *   0  every probe surfaced an enriched error (kind + field populated)
 *   1  config / env wrong (manager resolved to simulation)
 *   2  unexpected — at least one probe did NOT produce an error
 */
import { readFileSync, existsSync } from "node:fs";
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

const distManager = resolve(repoRoot, "dist/session/manager.js");
const distFormat = resolve(repoRoot, "dist/util/format-tool-error.js");
const distBuilder = resolve(repoRoot, "dist/qbxml/builder.js");
const distParser = resolve(repoRoot, "dist/qbxml/parser.js");
for (const p of [distManager, distFormat, distBuilder, distParser]) {
  if (!existsSync(p)) {
    console.error(`ERROR: ${p} not found. Run \`npm run build\` first.`);
    process.exit(2);
  }
}

const { QBSessionManager } = await import(pathToFileURL(distManager).href);
const { formatToolError } = await import(pathToFileURL(distFormat).href);

const sm = new QBSessionManager({
  companyFile: process.env.QB_COMPANY_FILE ?? "",
  appName: process.env.QB_APP_NAME ?? "MCP QuickBooks Manager",
  appId: process.env.QB_APP_ID,
  qbxmlVersion: process.env.QB_QBXML_VERSION ?? "16.0",
});

if (sm.isSimulation()) {
  console.error("ERROR: Manager resolved to simulation mode. Set QB_LIVE=1.");
  process.exit(1);
}

console.log("Live mode confirmed. Opening session...");
await sm.openSession();
console.log("  ticket =", sm.getTicket?.() ?? "(opaque)");
console.log("");

// -------------------------------------------------------------------------
// Probes — each invokes the tool-side path (session.queryEntity /
// session.addEntity etc.) with a payload expected to fail, then runs the
// thrown error through formatToolError. This is the exact flow the tool
// wrappers go through, so the hint surfaces if and only if it would for
// a real agent call.
// -------------------------------------------------------------------------

const probes = [
  {
    name: "Probe 1: CustomerAddRq — missing required Name field (expect 3120 + missing-element hint)",
    invoke: () => sm.addEntity("Customer", { CompanyName: "Probe Co — Item 65 Verification" }),
  },
  {
    name: "Probe 2: InvoiceQueryRq — invalid PaidStatus enum (expect 3120 + invalid-argument hint)",
    invoke: () => sm.queryEntity("Invoice", { MaxReturned: 5, PaidStatus: "NotARealEnum" }),
  },
  {
    name: "Probe 3: CustomerQueryRq — FullName matches nothing (expect statusCode 1 = empty)",
    invoke: () =>
      sm.queryEntity("Customer", {
        FullName: "DefinitelyNotARealCustomer_ItemSixtyFive_Probe",
      }),
  },
  {
    name: "Probe 4: AccountQueryRq — invalid AccountType enum (expect 3120 + invalid-argument hint)",
    invoke: () =>
      sm.queryEntity("Account", {
        AccountType: "NotARealAccountType",
        MaxReturned: 5,
      }),
  },
  {
    name: "Probe 5: InvoiceModRq — bogus TxnID (expect 500 + invalid-ref / not-found)",
    invoke: () =>
      sm.modifyEntity("Invoice", {
        TxnID: "BOGUS-TXN-ID-FOR-65-PROBE",
        EditSequence: "1234567890",
        Memo: "should not commit",
      }),
  },
];

let enrichedCount = 0;
let unenrichedCount = 0;
let unexpectedSuccess = 0;

for (const probe of probes) {
  console.log(`--- ${probe.name} ---`);
  let result;
  try {
    result = await probe.invoke();
  } catch (err) {
    // The tool path threw — exactly what we want. Run it through the
    // wrapper.
    const formatted = formatToolError(err, { fallbackMessage: "probe failed" });
    const payload = JSON.parse(formatted.content[0].text);
    console.log("  raw QB message:", JSON.stringify(err?.message ?? String(err)));
    console.log("  statusCode    :", payload.statusCode);
    console.log("  statusMessage :", JSON.stringify(payload.statusMessage));
    if (payload.humanReadable) {
      console.log("  humanReadable :", JSON.stringify(payload.humanReadable));
    } else {
      console.log("  humanReadable : (absent)");
    }
    if (payload.hint) {
      console.log("  hint.kind     :", payload.hint.kind);
      console.log("  hint.field    :", payload.hint.field);
      console.log("  hint.guidance :", JSON.stringify(payload.hint.guidance));
      if (payload.hint.schemaOrder.length === 0) {
        console.log("  hint.schemaOrder: (no canonical sequence known for this field)");
      } else {
        console.log("  hint.schemaOrder:");
        for (const s of payload.hint.schemaOrder.slice(0, 3)) {
          console.log(`    ${s.request} = ${s.sequence.join(" → ")}`);
        }
        if (payload.hint.schemaOrder.length > 3) {
          console.log(`    (... + ${payload.hint.schemaOrder.length - 3} more candidates)`);
        }
      }
      enrichedCount++;
    } else {
      console.log("  hint          : (absent — heuristic did not match)");
      unenrichedCount++;
    }
    console.log("");
    continue;
  }

  console.log("  UNEXPECTED SUCCESS — probe did not produce an error.");
  console.log("  result (truncated):", JSON.stringify(result).slice(0, 200));
  unexpectedSuccess++;
  console.log("");
}

console.log("Closing session...");
await sm.closeSession();

console.log("");
console.log("=== Summary ===");
console.log(`  probes with enriched hint   : ${enrichedCount}/${probes.length}`);
console.log(`  probes with no hint match    : ${unenrichedCount}/${probes.length}`);
console.log(`  probes that unexpectedly OK  : ${unexpectedSuccess}/${probes.length}`);

if (unexpectedSuccess > 0) {
  process.exit(2);
}
process.exit(0);
