#!/usr/bin/env node
/**
 * Run the control page with made-up demo data (simulation mode, fake
 * tailnet, fake QuickBooks health) for screenshots and walkthroughs. Real
 * logins, devices and company files are never touched or shown.
 *
 *   npm run build && node scripts/demo-control-page.mjs [port] [--root <folder>] [--exit-after <seconds>]
 *   → open http://127.0.0.1:8799/  (Ctrl+C to stop)
 *
 * Everything lives in a temp folder (or --root, for tidy screenshot paths)
 * that is deleted on exit.
 */
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (p) => pathToFileURL(path.join(here, "..", "dist", p)).href;
const argv = process.argv.slice(2);
const rootArg = argv.indexOf("--root") >= 0 ? argv[argv.indexOf("--root") + 1] : null;
const port = Number(argv.find((a) => /^\d+$/.test(a)) ?? 8799);

const tmp = mkdtempSync(path.join(os.tmpdir(), "qbmcp-demo-"));
process.env.QB_ACTIVITY_LOG = "0";

process.env.QB_SIMULATION = "true";
const root = rootArg ?? path.join(tmp, "Client Files");
const appDataDir = rootArg ? path.join(path.dirname(rootArg), "quickbooks-desktop-mcp") : tmp;
process.env.QB_CREDENTIALS_FILE = path.join(appDataDir, "credentials.json");
process.env.QB_COMPANY_ROOT = root;
const files = {
  acme: path.join(root, "Acme Bakery", "Acme Bakery LLC.qbw"),
  harbor: path.join(root, "Blue Harbor Dental", "Blue Harbor Dental PC.qbw"),
  north: path.join(root, "Northside Electric", "Northside Electric Inc.qbw"),
  willow: path.join(root, "Willow Creek Farms", "Willow Creek Farms.qbw"),
};
for (const f of Object.values(files)) { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, ""); }

const { McpServer } = await import(pathToFileURL(path.join(here, "..", "node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href);
const { Client } = await import(pathToFileURL(path.join(here, "..", "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js")).href);
const { StreamableHTTPClientTransport } = await import(pathToFileURL(path.join(here, "..", "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js")).href);
const { QBSessionManager } = await import(dist("session/manager.js"));
const { upsertLogin, addAuthorizedPeer } = await import(dist("util/qb-credentials.js"));
const { installAuthorizationGuard } = await import(dist("util/caller-authorization.js"));
const { registerReportTools } = await import(dist("tools/reports.js"));
const { recordActivity } = await import(dist("util/activity-log.js"));
const { startWebServer } = await import(dist("web/server.js"));

const fakeProtect = async () => "DEMO-ENCRYPTED";
const vaultPath = process.env.QB_CREDENTIALS_FILE;
await upsertLogin({ companyFile: files.acme, username: "Admin", password: "x" }, { vaultPath, protect: fakeProtect });
await upsertLogin({ companyFile: files.harbor, username: "Bookkeeper", password: "x" }, { vaultPath, protect: fakeProtect });
await upsertLogin({ companyFile: files.north, username: "Admin" }, { vaultPath, protect: fakeProtect });

const NODES = [
  { ip: "100.64.10.1", id: "nDEMOSELF", name: "office-pc", login: "owner@example.com", os: "windows", online: true },
  { ip: "100.64.10.2", id: "nDEMOLAP", name: "partner-laptop", login: "owner@example.com", os: "macOS", online: true },
  { ip: "100.64.10.3", id: "nDEMOWS", name: "staff-workstation", login: "owner@example.com", os: "windows", online: true },
  { ip: "100.64.10.4", id: "nDEMOAI", name: "ai-agent-server", login: "owner@example.com", os: "linux", online: true },
  { ip: "100.64.10.5", id: "nDEMOREM", name: "remote-accountant", login: "accountant@example.com", os: "windows", online: false },
];
await addAuthorizedPeer(files.acme, { address: "100.64.10.2", nodeId: "nDEMOLAP", nodeName: "partner-laptop", loginName: "owner@example.com" }, { vaultPath });
await addAuthorizedPeer(files.acme, { address: "100.64.10.4", nodeId: "nDEMOAI", nodeName: "ai-agent-server", loginName: "owner@example.com" }, { vaultPath });
await addAuthorizedPeer(files.harbor, { address: "100.64.10.4", nodeId: "nDEMOAI", nodeName: "ai-agent-server", loginName: "owner@example.com" }, { vaultPath });
await addAuthorizedPeer(files.harbor, { address: "100.64.10.5", nodeId: "nDEMOREM", nodeName: "remote-accountant", loginName: "accountant@example.com" }, { vaultPath });

const tailscale = async (args) => {
  if (args[0] === "ip") return "100.64.10.1\n";
  if (args[0] === "whois") {
    const n = NODES.find((x) => x.ip === args[2]);
    if (!n) throw new Error("unknown");
    return JSON.stringify({ Node: { StableID: n.id, ComputedName: n.name, Name: `${n.name}.demo.ts.net.` }, UserProfile: { LoginName: n.login } });
  }
  const peer = (n) => ({ ID: n.id, HostName: n.name, DNSName: `${n.name}.demo.ts.net.`, TailscaleIPs: [n.ip], UserID: n.login === "owner@example.com" ? 1 : 2, OS: n.os, Online: n.online });
  return JSON.stringify({ Self: peer(NODES[0]), Peer: Object.fromEntries(NODES.slice(1).map((n, i) => [String(i), peer(n)])), User: { 1: { LoginName: "owner@example.com" }, 2: { LoginName: "accountant@example.com" } } });
};

const session = new QBSessionManager({ companyFile: files.acme, appName: "MCP QuickBooks Manager", qbxmlVersion: "16.0" });
await session.queryEntity("Customer", {});
await session.recover({ trigger: "demo" });

const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
[
  [190, "info", "logins", "Saved a login for Acme Bakery LLC.qbw (user Admin)", "by this computer"],
  [185, "info", "access", "Gave partner-laptop (100.64.10.2) access to Acme Bakery LLC.qbw", "by this computer"],
  [184, "info", "access", "Gave ai-agent-server (100.64.10.4) access to Blue Harbor Dental PC.qbw", "by this computer"],
  [120, "info", "switch", "Opening Blue Harbor Dental PC.qbw (closing Acme Bakery LLC.qbw first)", ""],
  [119, "success", "switch", "Connected to Blue Harbor Dental PC.qbw", "closed the previous company; started QuickBooks; login: filled"],
  [64, "warn", "agent", "Refused qb_invoice_list from remote-accountant 100.64.10.5: not authorized for Acme Bakery LLC.qbw", ""],
  [41, "info", "switch", "Opening Acme Bakery LLC.qbw (closing Blue Harbor Dental PC.qbw first)", ""],
  [40, "success", "switch", "Connected to Acme Bakery LLC.qbw", "closed the previous company; started QuickBooks; login: filled"],
  [12, "error", "health", "QuickBooks stopped answering during a read", "The RPC server is unavailable."],
  [12, "warn", "recovery", "Reconnecting to Acme Bakery LLC.qbw after: The RPC server is unavailable.", ""],
  [11, "success", "recovery", "Reconnected to Acme Bakery LLC.qbw", ""],
  [2, "info", "agent", "Agent connected over HTTP from ai-agent-server 100.64.10.4", ""],
].forEach(([min, level, category, message, detail]) => recordActivity({ at: ago(min), level, category, message, ...(detail ? { detail } : {}) }));

const createMcpServer = (identity) => {
  const s = new McpServer({ name: "demo", version: "1.0.0" });
  installAuthorizationGuard(s, identity, () => session, { vaultPath: () => vaultPath });
  registerReportTools(s, () => session);
  return s;
};

const web = await startWebServer({
  port,
  listenHosts: ["127.0.0.1"],
  createMcpServer,
  getSession: () => session,
  vaultPath: () => vaultPath,
  tailscale,
  protect: fakeProtect,
  stdioConnected: true,
  identifyCaller: async (req) => {
    const ip = String(req.headers["x-demo-device"] ?? "");
    const n = NODES.find((x) => x.ip === ip);
    return n ? { kind: "tailnet", address: n.ip, nodeId: n.id, nodeName: n.name, loginName: n.login } : { kind: "local", via: "loopback" };
  },
  healthProbe: async () => ({
    ok: true,
    fileDoctor: [],
    crashReporter: [],
    quickbooks: [{ pid: 4120, responding: true, startedAt: ago(11), windows: [{ title: "Acme Bakery LLC  - Intuit QuickBooks Enterprise Solutions 24.0", className: "MauiFrame", isMain: true }] }],
  }),
});

const agent = new Client({ name: "demo-agent", version: "1.0.0" });
await agent.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${web.port}/mcp`), { requestInit: { headers: { "x-demo-device": "100.64.10.4" } } }));

console.log(`Demo control page: http://127.0.0.1:${web.port}/  (made-up data; Ctrl+C to stop)`);
const stop = async () => { await agent.close().catch(() => {}); await web.close(); rmSync(tmp, { recursive: true, force: true }); if (rootArg) {
  rmSync(rootArg, { recursive: true, force: true });
  rmSync(appDataDir, { recursive: true, force: true });
  try { rmdirSync(path.dirname(rootArg)); } catch { /* not empty or not ours: leave it */ }
} process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// --exit-after <seconds>: stop (and delete the demo folders) on a timer, for scripted screenshots.
const exitAfter = argv.indexOf("--exit-after") >= 0 ? Number(argv[argv.indexOf("--exit-after") + 1]) : 0;
if (exitAfter > 0) setTimeout(stop, exitAfter * 1000);
