// Hub + connector, end to end on one machine (docs/CONNECTOR_DESIGN.md):
// a real connector HTTP server (QuickBooks faked behind a QBHost), a real hub
// web server + session manager driving it through HubHost/RemoteQBHost.

import { promises as fs, mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { QBSessionManager } from "../src/session/manager.js";
import type { QBHost } from "../src/session/qb-host.js";
import type { QBRequestProcessor } from "../src/session/com-worker-client.js";
import { startConnectorServer, type ConnectorServerHandle } from "../src/connector/server.js";
import { WorkstationOfflineError, postJson } from "../src/connector/protocol.js";
import { HubHost, NoWorkstationError } from "../src/hub/hub-host.js";
import { WorkstationRegistry, WORKSTATION_ONLINE_MS } from "../src/hub/workstations.js";
import { hubDecrypt, hubEncrypt, hubPasswordProtector, loadOrCreateHubKey } from "../src/util/hub-vault.js";
import { startWebServer, type WebServerHandle } from "../src/web/server.js";
import type { LoginAutofillResult } from "../src/util/qb-credentials.js";

const SECRET = "s".repeat(43);
const CUSTOMER_XML = `<?xml version="1.0" ?>
<?qbxml version="16.0"?>
<QBXML><QBXMLMsgsRs>
  <CustomerQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="Status OK">
    <CustomerRet><ListID>80000001-1</ListID><Name>Remote Bakery</Name><FullName>Remote Bakery</FullName><IsActive>true</IsActive></CustomerRet>
  </CustomerQueryRs>
</QBXMLMsgsRs></QBXML>`;

function fakeWorkstation() {
  const calls: string[] = [];
  const rp: QBRequestProcessor = {
    OpenConnection2: async () => { calls.push("OpenConnection2"); },
    BeginSession: async (file: string) => { calls.push(`BeginSession ${file}`); return "TICKET-REMOTE"; },
    ProcessRequest: async (_t: string, xml: string) => { calls.push(`ProcessRequest ${/<(\w+Query)Rq\b/.exec(xml)?.[1]}`); return CUSTOMER_XML; },
    EndSession: async () => { calls.push("EndSession"); },
    CloseConnection: async () => { calls.push("CloseConnection"); },
    dispose: () => { calls.push("dispose"); },
  };
  const host: QBHost = {
    label: "fake QB PC",
    createRequestProcessor: () => rp,
    isQuickBooksRunning: async () => true,
    resolveExe: async () => null,
    launch: async () => undefined,
    closeGracefully: async () => ({ closed: true, outcome: "closed" as const }),
    forceClose: async () => true,
    health: async () => ({ checkedAt: new Date().toISOString(), state: "ready" as const, summary: "QuickBooks is ready.", recommendedAction: "None.", dialogs: [], raw: { ok: true, quickbooks: [], fileDoctor: [], crashReporter: [] } }),
    fileExists: async (p) => { calls.push(`fileExists ${p}`); return p.endsWith("Real.qbw"); },
    findCompanyFiles: async () => [],
    listDrives: async () => [{ path: "Q:\\", label: "Books", kind: "network" as const, ready: true }],
    browse: async (dir) => {
      if (dir.includes("missing")) { const e = new Error(`Folder not found: ${dir}`); e.name = "BrowseError"; throw e; }
      return { path: dir, parent: null, folders: [{ name: "Acme", path: `${dir}\\Acme` }], files: [], truncated: false };
    },
    hasSavedLogin: async () => false,
    startLoginAutofill: async () => null,
  };
  const autofills: Array<{ companyFile: string; username: string; password: string }> = [];
  const autofill = async (companyFile: string, username: string, password: string) => {
    autofills.push({ companyFile, username, password });
    return { result: Promise.resolve<LoginAutofillResult>({ status: "filled" }), cancel: () => undefined };
  };
  return { host, calls, autofills, autofill };
}

let tmp: string;
let connector: ConnectorServerHandle | null;
let web: WebServerHandle | null;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "qb-hub-"));
  process.env.QB_CREDENTIALS_FILE = path.join(tmp, "credentials.json");
  process.env.QB_HUB_KEY_FILE = path.join(tmp, "hub-vault.key");
  connector = null;
  web = null;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  await connector?.close();
  await web?.close();
  vi.restoreAllMocks();
  delete process.env.QB_CREDENTIALS_FILE;
  delete process.env.QB_HUB_KEY_FILE;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function startPair() {
  const ws = fakeWorkstation();
  connector = await startConnectorServer({
    port: 0, secret: SECRET, hubAddresses: [], listenHosts: ["127.0.0.1"], version: "test", host: ws.host, autofill: ws.autofill,
  });
  const registry = new WorkstationRegistry(path.join(tmp, "workstations.json"));
  const mgr = new QBSessionManager({ companyFile: "", appName: "vitest-hub", qbxmlVersion: "16.0" }, new HubHost(registry));
  (mgr as unknown as { simulationMode: boolean }).simulationMode = false;
  (mgr as unknown as { sleepImpl: (ms: number) => Promise<void> }).sleepImpl = async () => {};
  web = await startWebServer({
    port: 0,
    listenHosts: ["127.0.0.1"],
    bindTailnet: false,
    createMcpServer: () => new McpServer({ name: "t", version: "1" }),
    getSession: () => mgr,
    tailscale: async () => "",
    identifyCaller: async () => ({ kind: "local", via: "loopback" }),
    workstations: registry,
    protect: hubPasswordProtector(),
  });
  const hub = `http://127.0.0.1:${web.port}`;
  const register = () => postJson<{ ok: boolean; name: string }>(`${hub}/connector/register`,
    { name: "QB-PC-1", port: connector!.port, secret: SECRET, version: "test", platform: "win32", protocol: 1 }, { timeoutMs: 5000 });
  const api = (p: string, body?: unknown) =>
    new Promise<{ status: number; json: Record<string, any> }>((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const r = http.request(`${hub}${p}`, {
        method: data ? "POST" : "GET",
        headers: { "X-QB-Admin": "1", ...(data ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(data)) } : {}) },
      }, (res) => { let t = ""; res.on("data", (c) => { t += c; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(t) })); });
      r.on("error", reject);
      r.end(data);
    });
  return { ws, registry, mgr, register, api };
}

describe("hub vault", () => {
  it("AES-GCM round trip; the stored value never contains the password; DPAPI values are refused with advice", () => {
    const key = loadOrCreateHubKey(path.join(tmp, "k"));
    const c = hubEncrypt("pässwörd-123", key);
    expect(c.startsWith("hub1:")).toBe(true);
    expect(c).not.toContain("pässwörd");
    expect(hubDecrypt(c, key)).toBe("pässwörd-123");
    expect(hubEncrypt("x", key)).not.toBe(hubEncrypt("x", key)); // fresh IV each time
    expect(() => hubDecrypt("AQAAANCMnd8BFdERjHoAwE", key)).toThrow(/Save it again/);
    expect(loadOrCreateHubKey(path.join(tmp, "k")).equals(key)).toBe(true);
  });
});

describe("workstation registry", () => {
  it("register → online + auto-active when it's the only one; stale check-in → offline; choice persists", () => {
    let now = Date.parse("2026-10-06T12:00:00Z");
    const file = path.join(tmp, "ws.json");
    const reg = new WorkstationRegistry(file, () => now);
    expect(reg.register({ id: "n1", name: "vr", address: "100.1.1.1", port: 8766, secret: SECRET, version: "1", platform: "win32" })).toBe(true);
    expect(reg.active()?.id).toBe("n1");
    reg.register({ id: "n2", name: "books-pc", address: "100.1.1.2", port: 8766, secret: SECRET, version: "1", platform: "win32" });
    expect(reg.active()).toBeNull(); // two online, none chosen
    reg.setActive("n2");
    expect(new WorkstationRegistry(file, () => now).active()?.name).toBe("books-pc");
    now += WORKSTATION_ONLINE_MS + 1;
    expect(reg.list().map((w) => [w.name, w.online, w.active])).toEqual([["books-pc", false, true], ["vr", false, false]]);
    expect(JSON.stringify(reg.list())).not.toContain(SECRET);
    expect((readFileSync(file).length)).toBeGreaterThan(0);
  });
});

describe("hub ↔ connector", () => {
  it("no workstation: QuickBooks calls fail with 9012, health explains", async () => {
    const reg = new WorkstationRegistry(path.join(tmp, "none.json"));
    const host = new HubHost(reg);
    await expect(host.isQuickBooksRunning()).rejects.toBeInstanceOf(NoWorkstationError);
    await expect(host.isQuickBooksRunning()).rejects.toMatchObject({ statusCode: 9012 });
    expect((await host.health()).summary).toMatch(/No QuickBooks workstation/);
  });

  it("a connector checks in, appears available and in use; page state hides its secret", async () => {
    const { register, api } = await startPair();
    expect((await register()).name).toBe("QB-PC-1");
    const st = await api("/api/state");
    expect(st.json.hub.workstations).toEqual([expect.objectContaining({ name: "QB-PC-1", online: true, active: true, version: "test" })]);
    expect(st.json.hub.hostLabel).toBe("QB-PC-1");
    expect(JSON.stringify(st.json)).not.toContain(SECRET);
  });

  it("registration is validated: short secret / wrong protocol refused", async () => {
    const { api } = await startPair();
    const hub = `http://127.0.0.1:${web!.port}`;
    await expect(postJson(`${hub}/connector/register`, { port: 1, secret: "short", protocol: 1 }, { timeoutMs: 5000 })).rejects.toThrow(/secret/);
    await expect(postJson(`${hub}/connector/register`, { port: 1, secret: SECRET, protocol: 99 }, { timeoutMs: 5000 })).rejects.toThrow(/protocol/);
    expect((await api("/api/state")).json.hub.workstations).toEqual([]);
  });

  it("live session + query run on the workstation over the network", async () => {
    const { ws, mgr, register } = await startPair();
    await register();
    const customers = await mgr.queryEntity("Customer");
    expect(customers).toEqual([expect.objectContaining({ Name: "Remote Bakery" })]);
    expect(ws.calls.slice(0, 3)).toEqual(["OpenConnection2", "BeginSession ", "ProcessRequest CustomerQuery"]);
    await mgr.closeSession();
    expect(ws.calls).toEqual(expect.arrayContaining(["EndSession", "CloseConnection"]));
  });

  it("file pre-check, drives and browse (incl. BrowseError → 400) go through the connector", async () => {
    const { mgr, register, api } = await startPair();
    await register();
    await expect(mgr.switchCompanyFile("\\\\files\\books\\Gone.qbw", { closeCurrentCompany: true }))
      .rejects.toMatchObject({ statusCode: 9007, reason: "file-not-found" });
    expect((await api("/api/browse", { path: "" })).json.drives[0]).toMatchObject({ path: "Q:\\", kind: "network" });
    expect((await api("/api/browse", { path: "\\\\files\\books" })).json.folders[0].name).toBe("Acme");
    const bad = await api("/api/browse", { path: "\\\\files\\missing" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/Folder not found/);
  });

  it("a login saved on the hub is encrypted there and handed to the connector only for autofill", async () => {
    const { ws, mgr, register, api } = await startPair();
    await register();
    const file = "\\\\files\\books\\Acme\\Acme.qbw";
    expect((await api("/api/logins", { companyFile: file, username: "Admin", password: "hunter2-secret" })).status).toBe(200);
    const vault = readFileSync(process.env.QB_CREDENTIALS_FILE!, "utf8");
    expect(vault).toContain("hub1:");
    expect(vault).not.toContain("hunter2-secret");
    const handle = await mgr.getHost().startLoginAutofill(file);
    expect(await handle!.result).toEqual({ status: "filled" });
    expect(ws.autofills).toEqual([{ companyFile: file, username: "Admin", password: "hunter2-secret" }]);
    expect(await mgr.getHost().hasSavedLogin(file)).toBe(true);
    expect(await mgr.getHost().startLoginAutofill("\\\\files\\books\\Other.qbw")).toBeNull();
  });

  it("the connector refuses a wrong secret; a stopped connector is 9012 workstation-offline", async () => {
    const { mgr, register } = await startPair();
    await register();
    await expect(postJson(`http://127.0.0.1:${connector!.port}/v1/info`, {}, { timeoutMs: 5000, bearer: "wrong" })).rejects.toThrow(/secret/);
    await connector!.close();
    connector = null;
    await expect(mgr.getHost().isQuickBooksRunning()).rejects.toBeInstanceOf(WorkstationOfflineError);
    await expect(mgr.getHost().listDrives()).rejects.toMatchObject({ statusCode: 9012, reason: "workstation-offline" });
    expect((await mgr.getHost().health()).summary).toMatch(/offline/);
  });

  it("choosing and forgetting workstations on the page", async () => {
    const { registry, register, api } = await startPair();
    await register();
    registry.register({ id: "n-books", name: "books-pc", address: "127.0.0.1", port: 1, secret: SECRET, version: "t", platform: "win32" });
    expect((await api("/api/state")).json.hub.workstations.filter((w: any) => w.active)).toEqual([]);
    expect((await api("/api/workstations/select", { id: "n-books" })).status).toBe(200);
    expect(registry.active()?.name).toBe("books-pc");
    expect((await api("/api/workstations/select", { id: "nope" })).status).toBe(404);
    expect((await api("/api/workstations/forget", { id: "n-books" })).status).toBe(200);
    expect(registry.list().map((w) => w.name)).toEqual(["QB-PC-1"]);
  });
});
