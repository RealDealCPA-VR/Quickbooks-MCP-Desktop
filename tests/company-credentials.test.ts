// Company-file logins + tailnet authorization (2026-10-05):
//   - the credential store (DPAPI ciphertext only, atomic overwrite, kept
//     authorizations), real DPAPI round-trip on Windows
//   - tailnet identity parsing (`tailscale whois` / `status`)
//   - per-caller, per-company-file authorization guard on the tool surface
//   - the local web server: logins page, admin API hardening, remote MCP
//     over Streamable HTTP
//   - the qbXML element-name guard that closed the qb_raw_query injection
//   - recursive .qbw discovery
//
// The autofill test opens an off-screen stand-in dialog titled "AUTOFILL
// TEST - DO NOT TYPE HERE", so it is gated behind QB_UI_TESTS=1.

import { execFileSync, spawn } from "node:child_process";
import { promises as fs, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { QBSessionManager } from "../src/session/manager.js";
import { buildQBXMLRequest, buildQueryRequest, QBXMLNameError } from "../src/qbxml/builder.js";
import { registerReportTools } from "../src/tools/reports.js";
import { registerCompanyCredentialTools } from "../src/tools/company-credentials.js";
import { findCompanyFiles, resolveCompanyRoot } from "../src/util/company-files.js";
import {
  addAuthorizedPeer,
  findCredentialSummary,
  getCredentialsFilePath,
  normalizeCompanyPath,
  protectPassword,
  readCredentialSummaries,
  readStore,
  removeAuthorizedPeer,
  removeEntry,
  resolveScriptPath,
  startLoginAutofill,
  upsertLogin,
} from "../src/util/qb-credentials.js";
import {
  authorizeToolCall,
  installAuthorizationGuard,
  isCompanyFileAuthorized,
  type CallerIdentity,
} from "../src/util/caller-authorization.js";
import {
  clearWhoisCache,
  isTailnetAddress,
  normalizeIp,
  tailnetPeers,
  tailnetWhois,
  type TailscaleRunner,
} from "../src/util/tailnet.js";
import { startWebServer, type WebServerHandle } from "../src/web/server.js";

type Handler = (args: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

const isWin = process.platform === "win32";
const fakeProtect = async (plain: string) => `FAKECIPHER${Buffer.from(plain).toString("base64").length}`;

let tmp: string;
let vault: string;
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "qb-creds-"));
  vault = path.join(tmp, "credentials.json");
  for (const k of ["QB_CREDENTIALS_FILE", "QB_COMPANY_ROOT", "QB_COMPANY_FILE"]) savedEnv[k] = process.env[k];
  process.env.QB_CREDENTIALS_FILE = vault;
  delete process.env.QB_COMPANY_ROOT;
  delete process.env.QB_COMPANY_FILE;
  clearWhoisCache();
});
afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------------------------------------------------------------------------
// Fake tailnet
// ---------------------------------------------------------------------------

const SELF = { ip: "100.114.0.1", id: "nodeSELF", name: "vr", login: "owner@example.com" };
const LAPTOP = { ip: "100.100.1.2", id: "nodeLAPTOP", name: "laptop", login: "owner@example.com" };
const OTHER = { ip: "100.100.9.9", id: "nodeOTHER", name: "contractor-pc", login: "contractor@example.com" };
const NODES = [SELF, LAPTOP, OTHER];

const fakeTailscale: TailscaleRunner = async (args) => {
  if (args[0] === "ip") return `${SELF.ip}\nfd7a:115c:a1e0::1\n`;
  if (args[0] === "whois") {
    const n = NODES.find((x) => x.ip === args[2]);
    if (!n) throw new Error("no such peer");
    return JSON.stringify({
      Node: { StableID: n.id, Name: `${n.name}.tail.ts.net.`, ComputedName: n.name, Addresses: [`${n.ip}/32`], Hostinfo: { OS: "windows" } },
      UserProfile: { LoginName: n.login, DisplayName: n.name.toUpperCase() },
    });
  }
  if (args[0] === "status") {
    const toPeer = (n: typeof SELF, uid: number) => ({ ID: n.id, HostName: n.name, DNSName: `${n.name}.tail.ts.net.`, TailscaleIPs: [n.ip, "fd7a:115c:a1e0::9"], UserID: uid, OS: "windows", Online: n !== OTHER });
    return JSON.stringify({
      Self: toPeer(SELF, 1),
      Peer: { a: toPeer(LAPTOP, 1), b: toPeer(OTHER, 2) },
      User: { "1": { LoginName: SELF.login }, "2": { LoginName: OTHER.login } },
    });
  }
  throw new Error(`unexpected tailscale ${args.join(" ")}`);
};

const remote = (n: typeof SELF): CallerIdentity => ({ kind: "tailnet", address: n.ip, nodeId: n.id, nodeName: n.name, loginName: n.login });

// ---------------------------------------------------------------------------
// qbXML element-name guard (qb_raw_query injection)
// ---------------------------------------------------------------------------

describe("builder rejects non-identifier element names", () => {
  it("entityType carrying markup throws QBXMLNameError", () => {
    expect(() => buildQueryRequest('CustomerAddRq requestID="9"><CustomerAdd><Name>X</Name></CustomerAdd></CustomerAddRq><Customer', {}))
      .toThrow(QBXMLNameError);
  });
  it("filter KEY carrying markup throws", () => {
    expect(() => buildQueryRequest("Customer", { "MaxReturned><x": 1 })).toThrow(QBXMLNameError);
  });
  it("attribute name carrying markup throws", () => {
    expect(() => buildQBXMLRequest({ requests: [{ type: "CustomerQueryRq", body: {}, attributes: { 'a="1" b': "x" } }] }))
      .toThrow(QBXMLNameError);
  });
  it("strips XML-illegal control characters from values but keeps TAB/LF/CR", () => {
    const xml = buildQueryRequest("Customer", { NameFilter: { MatchCriterion: "Contains", Name: "A\u0001B\u000BC\tD" } });
    expect(xml).toContain("<Name>ABC\tD</Name>");
  });
  it("normal requests are unchanged", () => {
    const xml = buildQueryRequest("Customer", { MaxReturned: 5 });
    expect(xml).toContain("<MaxReturned>5</MaxReturned>");
  });
});

describe("qb_raw_query cannot smuggle a write past read-only", () => {
  const harness = () => {
    const handlers = new Map<string, Handler>();
    const fakeServer = { tool: (n: string, _d: string, _s: Record<string, z.ZodTypeAny>, h: Handler) => { handlers.set(n, h); } };
    const session = new QBSessionManager({ companyFile: "simulation", appName: "vitest-raw", qbxmlVersion: "16.0" });
    registerReportTools(fakeServer as never, () => session);
    return { session, handlers };
  };
  it("injected entityType returns isError and creates nothing", async () => {
    const { session, handlers } = harness();
    await session.openSession();
    session.setReadOnly(true);
    const before = (await session.queryEntity("Customer", {})).length;
    const res = await handlers.get("qb_raw_query")!({
      entityType: 'CustomerAddRq requestID="9"><CustomerAdd><Name>INJECTED</Name></CustomerAdd></CustomerAddRq><Customer',
    });
    expect(res.isError).toBe(true);
    const after = await session.queryEntity("Customer", {});
    expect(after.length).toBe(before);
  });
  it("injected filter key returns isError (handler no longer throws)", async () => {
    const { session, handlers } = harness();
    await session.openSession();
    const res = await handlers.get("qb_raw_query")!({ entityType: "Customer", filters: '{"MaxReturned><x":1}' });
    expect(res.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Credential store
// ---------------------------------------------------------------------------

describe("credential store", () => {
  it("path: QB_CREDENTIALS_FILE wins, else %APPDATA%\\quickbooks-desktop-mcp\\credentials.json", () => {
    expect(getCredentialsFilePath({ QB_CREDENTIALS_FILE: "X:\\v.json" })).toBe("X:\\v.json");
    expect(getCredentialsFilePath({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }))
      .toBe(path.join("C:\\Users\\u\\AppData\\Roaming", "quickbooks-desktop-mcp", "credentials.json"));
  });

  it("missing store → empty; malformed store throws instead of silently dropping logins", () => {
    expect(readCredentialSummaries(vault)).toEqual([]);
    writeFileSync(vault, "{not json");
    expect(() => readCredentialSummaries(vault)).toThrow();
  });

  it("loads version-1 files (the retired popup's format) unchanged, BOM tolerated", () => {
    writeFileSync(vault, "\uFEFF" + JSON.stringify({ version: 1, entries: [{ companyFile: "C:\\A.qbw", username: "Admin", password: "BLOB", updatedAt: "2026-10-05T00:00:00Z" }] }));
    expect(readCredentialSummaries(vault)).toEqual([
      { companyFile: "C:\\A.qbw", username: "Admin", hasPassword: true, updatedAt: "2026-10-05T00:00:00Z", authorizedPeers: [] },
    ]);
  });

  it("first save creates; a second save for the same file (any case/slashes) overwrites in place", async () => {
    const a = await upsertLogin({ companyFile: "C:\\Clients\\Acme.qbw", username: "Admin", password: "pw1" }, { vaultPath: vault, protect: fakeProtect });
    expect(a).toMatchObject({ created: true, passwordChanged: true });
    const b = await upsertLogin({ companyFile: "c:/clients/ACME.QBW", username: "Bookkeeper", password: "longer-pw-2" }, { vaultPath: vault, protect: fakeProtect });
    expect(b).toMatchObject({ created: false, passwordChanged: true, usernameChanged: true });
    const store = readStore(vault);
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]).toMatchObject({ companyFile: "C:\\Clients\\Acme.qbw", username: "Bookkeeper" });
    expect(readFileSync(vault, "utf8")).not.toMatch(/pw1|longer-pw-2/);
  });

  it("blank password keeps the saved one; clearPassword removes it", async () => {
    await upsertLogin({ companyFile: "C:\\A.qbw", username: "Admin", password: "secret" }, { vaultPath: vault, protect: fakeProtect });
    const cipher = readStore(vault).entries[0].password;
    const kept = await upsertLogin({ companyFile: "C:\\A.qbw", username: "Admin", password: "" }, { vaultPath: vault, protect: fakeProtect });
    expect(kept.passwordChanged).toBe(false);
    expect(readStore(vault).entries[0].password).toBe(cipher);
    const cleared = await upsertLogin({ companyFile: "C:\\A.qbw", username: "Admin", clearPassword: true }, { vaultPath: vault, protect: fakeProtect });
    expect(cleared.passwordChanged).toBe(true);
    expect(findCredentialSummary("C:\\A.qbw", vault)?.hasPassword).toBe(false);
  });

  it("validates input: absolute .qbw path and a user name are required", async () => {
    const save = (companyFile: string, username = "Admin") => upsertLogin({ companyFile, username }, { vaultPath: vault, protect: fakeProtect });
    await expect(save("Acme.qbw")).rejects.toThrow(/full path/);
    await expect(save("C:\\Acme.txt")).rejects.toThrow(/\.qbw/);
    await expect(save("C:\\Acme.qbw", "  ")).rejects.toThrow(/user name/);
    await expect(save("\\\\server\\share\\Acme.qbw")).resolves.toMatchObject({ created: true });
  });

  it("authorizations: add pins node details, survive login changes, re-add refreshes, remove works", async () => {
    await upsertLogin({ companyFile: "C:\\A.qbw", username: "Admin", password: "x" }, { vaultPath: vault, protect: fakeProtect });
    await addAuthorizedPeer("C:\\A.qbw", { address: LAPTOP.ip, nodeId: LAPTOP.id, nodeName: LAPTOP.name, loginName: LAPTOP.login }, { vaultPath: vault });
    await addAuthorizedPeer("c:\\a.qbw", { address: LAPTOP.ip, nodeId: LAPTOP.id, nodeName: "renamed" }, { vaultPath: vault });
    await upsertLogin({ companyFile: "C:\\A.qbw", username: "Clerk", password: "y" }, { vaultPath: vault, protect: fakeProtect });
    const e = findCredentialSummary("C:\\A.qbw", vault)!;
    expect(e.username).toBe("Clerk");
    expect(e.authorizedPeers).toHaveLength(1);
    expect(e.authorizedPeers[0]).toMatchObject({ address: LAPTOP.ip, nodeId: LAPTOP.id, nodeName: "renamed" });
    expect(await removeAuthorizedPeer("C:\\A.qbw", LAPTOP.ip, { vaultPath: vault })).toBe(true);
    expect(await removeAuthorizedPeer("C:\\A.qbw", LAPTOP.ip, { vaultPath: vault })).toBe(false);
  });

  it("authorizing a file with no login creates an authorization-only entry; removeEntry deletes it", async () => {
    await addAuthorizedPeer("C:\\NoLogin.qbw", { address: OTHER.ip, nodeId: OTHER.id }, { vaultPath: vault });
    expect(findCredentialSummary("C:\\NoLogin.qbw", vault)).toMatchObject({ username: "", hasPassword: false });
    expect(startLoginAutofill({ companyFile: "C:\\NoLogin.qbw", vaultPath: vault })).toBeNull();
    expect(await removeEntry("C:\\NoLogin.qbw", { vaultPath: vault })).toBe(true);
    expect(readCredentialSummaries(vault)).toEqual([]);
  });

  it("concurrent saves from one process are serialized (no lost update)", async () => {
    await Promise.all(["A", "B", "C", "D", "E"].map((n) =>
      upsertLogin({ companyFile: `C:\\${n}.qbw`, username: n, password: n }, { vaultPath: vault, protect: fakeProtect })));
    expect(readStore(vault).entries.map((e) => e.username).sort()).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("helper scripts exist and are pure ASCII (Windows PowerShell 5.1 misreads BOM-less UTF-8)", async () => {
    for (const s of ["qb-dpapi-protect.ps1", "qb-login-autofill.ps1", "qb-close-desktop.ps1"]) {
      await expect(fs.access(resolveScriptPath(s))).resolves.toBeUndefined();
      expect(readFileSync(resolveScriptPath(s)).some((b) => b > 127)).toBe(false);
    }
  });
});

describe.runIf(isWin)("DPAPI round trip (real Windows)", () => {
  it("protectPassword output decrypts (same entropy as the autofill script) to the exact password, incl. non-ASCII", async () => {
    const secret = "Pä$$wörd {1}+%~(x) ✓";
    const cipher = await protectPassword(secret);
    expect(cipher).toMatch(/^[A-Za-z0-9+/=]{40,}$/);
    const script = [
      "Add-Type -AssemblyName System.Security",
      `$b = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${cipher}'), [Text.Encoding]::UTF8.GetBytes('quickbooks-desktop-mcp/credentials/v1'), 'CurrentUser')`,
      "[Convert]::ToBase64String($b)",
    ].join("; ");
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
    expect(Buffer.from(out, "base64").toString("utf8")).toBe(secret);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Tailnet identity
// ---------------------------------------------------------------------------

describe("tailnet identity", () => {
  it("recognizes tailnet address ranges", () => {
    expect(isTailnetAddress("100.64.0.1")).toBe(true);
    expect(isTailnetAddress("100.127.255.255")).toBe(true);
    expect(isTailnetAddress("100.128.0.1")).toBe(false);
    expect(isTailnetAddress("192.168.1.5")).toBe(false);
    expect(isTailnetAddress("::ffff:100.100.1.2")).toBe(true);
    expect(isTailnetAddress("fd7a:115c:a1e0::9c35:5c21")).toBe(true);
    expect(normalizeIp("::ffff:100.100.1.2")).toBe("100.100.1.2");
  });

  it("whois maps an address to node StableID, name and owner; unknown → null; non-tailnet → null without shelling out", async () => {
    expect(await tailnetWhois(LAPTOP.ip, fakeTailscale)).toMatchObject({ address: LAPTOP.ip, nodeId: LAPTOP.id, nodeName: "laptop", loginName: LAPTOP.login, dnsName: "laptop.tail.ts.net" });
    expect(await tailnetWhois("100.99.99.99", fakeTailscale)).toBeNull();
    let called = false;
    expect(await tailnetWhois("8.8.8.8", async () => { called = true; return ""; })).toBeNull();
    expect(called).toBe(false);
  });

  it("peers: self first, IPv4 preferred, owner login resolved, online flag", async () => {
    const peers = await tailnetPeers(fakeTailscale);
    expect(peers.map((p) => [p.nodeName, p.address, p.loginName, p.online])).toEqual([
      ["vr", SELF.ip, SELF.login, true],
      ["laptop", LAPTOP.ip, LAPTOP.login, true],
      ["contractor-pc", OTHER.ip, OTHER.login, false],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Authorization rules
// ---------------------------------------------------------------------------

describe("per-file authorization", () => {
  beforeEach(async () => {
    await addAuthorizedPeer("C:\\Clients\\A.qbw", { address: LAPTOP.ip, nodeId: LAPTOP.id }, { vaultPath: vault });
  });

  it("local callers may use everything", () => {
    expect(isCompanyFileAuthorized({ kind: "local", via: "stdio" }, "C:\\Anything.qbw", vault)).toBe(true);
    expect(authorizeToolCall("qb_customer_list", {}, { kind: "local", via: "stdio" }, "", vault)).toEqual({ ok: true });
  });

  it("a remote device may use only the files it is authorized for (path match is case-insensitive)", () => {
    expect(isCompanyFileAuthorized(remote(LAPTOP), "c:\\clients\\a.QBW", vault)).toBe(true);
    expect(isCompanyFileAuthorized(remote(LAPTOP), "C:\\Clients\\B.qbw", vault)).toBe(false);
    expect(isCompanyFileAuthorized(remote(OTHER), "C:\\Clients\\A.qbw", vault)).toBe(false);
  });

  it("pinned node: same address but a different node is refused", () => {
    expect(isCompanyFileAuthorized({ ...remote(LAPTOP), nodeId: "nodeIMPOSTER" } as CallerIdentity, "C:\\Clients\\A.qbw", vault)).toBe(false);
  });

  it("tool rules: open checks the target; data tools check the ACTIVE file; listing tools always allowed", () => {
    const L = remote(LAPTOP);
    expect(authorizeToolCall("qb_company_open", { companyFile: "C:\\Clients\\A.qbw" }, L, "C:\\Other.qbw", vault).ok).toBe(true);
    expect(authorizeToolCall("qb_company_open", { companyFile: "C:\\Clients\\B.qbw" }, L, "C:\\Clients\\A.qbw", vault).ok).toBe(false);
    expect(authorizeToolCall("qb_invoice_list", {}, L, "C:\\Clients\\A.qbw", vault).ok).toBe(true);
    expect(authorizeToolCall("qb_invoice_list", {}, L, "C:\\Clients\\B.qbw", vault).ok).toBe(false);
    expect(authorizeToolCall("qb_invoice_list", {}, L, "", vault)).toMatchObject({ ok: false, reason: expect.stringMatching(/qb_company_open/) });
    for (const t of ["qb_company_list", "qb_company_credentials_list", "qb_session_status", "qb_company_credentials_edit"]) {
      expect(authorizeToolCall(t, {}, remote(OTHER), "C:\\Clients\\A.qbw", vault).ok).toBe(true);
    }
  });

  it("a change in the store applies to the very next call (no restart)", async () => {
    expect(isCompanyFileAuthorized(remote(OTHER), "C:\\Clients\\A.qbw", vault)).toBe(false);
    await addAuthorizedPeer("C:\\Clients\\A.qbw", { address: OTHER.ip, nodeId: OTHER.id }, { vaultPath: vault });
    expect(isCompanyFileAuthorized(remote(OTHER), "C:\\Clients\\A.qbw", vault)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Web server: page, admin API, remote MCP
// ---------------------------------------------------------------------------

describe("local web server", () => {
  let web: WebServerHandle;
  let session: QBSessionManager;
  let root: string;

  const createServer = (identity: CallerIdentity) => {
    const s = new McpServer({ name: "test", version: "1.0.0" });
    installAuthorizationGuard(s, identity, () => session, { vaultPath: () => vault });
    registerReportTools(s, () => session);
    registerCompanyCredentialTools(s, () => session, identity);
    return s;
  };
  const callerFor = (req: http.IncomingMessage): CallerIdentity => {
    const h = req.headers["x-test-caller"];
    if (h === "laptop") return remote(LAPTOP);
    if (h === "other") return remote(OTHER);
    return { kind: "local", via: "loopback" };
  };

  beforeEach(async () => {
    root = path.join(tmp, "clients");
    await fs.mkdir(path.join(root, "A"), { recursive: true });
    await fs.mkdir(path.join(root, "B"), { recursive: true });
    await fs.writeFile(path.join(root, "A", "A.qbw"), "");
    await fs.writeFile(path.join(root, "B", "B.qbw"), "");
    process.env.QB_COMPANY_ROOT = root;
    session = new QBSessionManager({ companyFile: path.join(root, "A", "A.qbw"), appName: "vitest-web", qbxmlVersion: "16.0" });
    web = await startWebServer({
      port: 0,
      listenHosts: ["127.0.0.1"],
      createMcpServer: createServer,
      getSession: () => session,
      vaultPath: () => vault,
      tailscale: fakeTailscale,
      protect: fakeProtect,
      identifyCaller: async (req) => callerFor(req),
      healthProbe: async () => ({ ok: true, quickbooks: [], fileDoctor: [], crashReporter: [] }),
      forceCloseQuickBooks: async () => true,
      listDrives: async () => [{ path: "C:\\", label: "Windows", kind: "fixed", ready: true }],
      stdioConnected: true,
    });
  });
  afterEach(async () => { await web.close(); });

  const base = () => `http://127.0.0.1:${web.port}`;
  const req = (method: string, p: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) =>
    new Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
      const r = http.request(`${base()}${p}`, {
        method,
        headers: {
          ...(data ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(data)) } : {}),
          ...opts.headers,
        },
      }, (res) => {
        let text = "";
        res.on("data", (c) => { text += c; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
      });
      r.on("error", reject);
      if (data) r.write(data);
      r.end();
    });
  const admin = { "X-QB-Admin": "1" };

  it("serves the logins page to this computer, with a strict CSP", async () => {
    const r = await req("GET", "/");
    expect(r.status).toBe(200);
    expect(r.text).toContain("QuickBooks MCP control");
    expect(String(r.headers["content-security-policy"])).toContain("default-src 'none'");
    expect(r.headers["x-frame-options"]).toBe("DENY");
  });

  it("rejects unknown Host headers (DNS rebinding), cross-origin posts, and API calls without X-QB-Admin", async () => {
    expect((await req("GET", "/", { headers: { Host: "evil.example:80" } })).status).toBe(421);
    expect((await req("GET", "/api/state")).status).toBe(403);
    const xo = await req("POST", "/api/logins", { body: { companyFile: "C:\\A.qbw", username: "x" }, headers: { ...admin, Origin: "http://evil.example" } });
    expect(xo.status).toBe(403);
    const form = await req("POST", "/api/logins", { headers: { ...admin, "Content-Type": "text/plain" } });
    expect(form.status).toBe(415);
    // No CORS preflight is ever answered, so browsers never let another site write here.
    const pre = await req("OPTIONS", "/api/logins", { headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "POST" } });
    expect(pre.status).toBeGreaterThanOrEqual(400);
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("save → state shows it already saved (no secrets); change → overwrites the old login", async () => {
    const file = path.join(root, "A", "A.qbw");
    const s1 = await req("POST", "/api/logins", { body: { companyFile: file, username: "Admin", password: "first-secret" }, headers: admin });
    expect(s1.status).toBe(200);
    expect(JSON.parse(s1.text)).toMatchObject({ ok: true, created: true, passwordChanged: true });

    const st = await req("GET", "/api/state", { headers: admin });
    expect(st.status).toBe(200);
    const state = JSON.parse(st.text);
    expect(state.entries).toEqual([expect.objectContaining({ companyFile: file, username: "Admin", hasPassword: true })]);
    expect(st.text).not.toMatch(/first-secret|FAKECIPHER/);
    expect(state.discovered.map((d: { displayName: string }) => d.displayName).sort()).toEqual(["A", "B"]);
    expect(state.peers.map((p: { nodeName: string }) => p.nodeName)).toEqual(["vr", "laptop", "contractor-pc"]);
    expect(state.me).toEqual({ kind: "local" });

    const s2 = await req("POST", "/api/logins", { body: { companyFile: file.toUpperCase(), username: "Clerk", password: "" }, headers: admin });
    expect(JSON.parse(s2.text)).toMatchObject({ created: false, passwordChanged: false, usernameChanged: true });
    const s3 = await req("POST", "/api/logins", { body: { companyFile: file, username: "Clerk", password: "second-secret-longer" }, headers: admin });
    expect(JSON.parse(s3.text)).toMatchObject({ created: false, passwordChanged: true });
    expect(readStore(vault).entries).toHaveLength(1);
    expect(readStore(vault).entries[0].username).toBe("Clerk");
  });

  it("company-file picker: drives, then folders + .qbw only; bad paths 400; admin header required", async () => {
    const drives = await req("POST", "/api/browse", { body: { path: "" }, headers: admin });
    expect(drives.status).toBe(200);
    expect(JSON.parse(drives.text)).toEqual({ drives: [{ path: "C:\\", label: "Windows", kind: "fixed", ready: true }] });

    await fs.writeFile(path.join(root, "A", "readme.txt"), "");
    const a = JSON.parse((await req("POST", "/api/browse", { body: { path: path.join(root, "A") }, headers: admin })).text);
    expect(a.files.map((f: { name: string }) => f.name)).toEqual(["A.qbw"]);
    const top = JSON.parse((await req("POST", "/api/browse", { body: { path: root }, headers: admin })).text);
    expect(top.folders.map((f: { name: string }) => f.name)).toEqual(["A", "B"]);

    const missing = await req("POST", "/api/browse", { body: { path: path.join(root, "missing") }, headers: admin });
    expect(missing.status).toBe(400);
    expect(JSON.parse(missing.text).error).toMatch(/Folder not found/);
    expect((await req("POST", "/api/browse", { body: { path: root } })).status).toBe(403);
    expect((await req("POST", "/api/browse", { body: { path: root }, headers: { ...admin, "x-test-caller": "other" } })).status).toBe(403);
  });

  it("bad input → 400 with a readable message", async () => {
    const r = await req("POST", "/api/logins", { body: { companyFile: "Acme.qbw", username: "Admin" }, headers: admin });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).error).toMatch(/full path/);
  });

  it("authorize a tailnet device: whois-verified and node-pinned; this PC / non-tailnet / unknown refused", async () => {
    const file = path.join(root, "A", "A.qbw");
    const ok = await req("POST", "/api/authorizations", { body: { companyFile: file, address: LAPTOP.ip }, headers: admin });
    expect(ok.status).toBe(200);
    expect(findCredentialSummary(file, vault)?.authorizedPeers[0]).toMatchObject({ address: LAPTOP.ip, nodeId: LAPTOP.id, nodeName: "laptop", loginName: LAPTOP.login });
    expect((await req("POST", "/api/authorizations", { body: { companyFile: file, address: "192.168.1.9" }, headers: admin })).status).toBe(400);
    expect((await req("POST", "/api/authorizations", { body: { companyFile: file, address: "100.99.99.99" }, headers: admin })).status).toBe(400);
    expect((await req("POST", "/api/authorizations", { body: { companyFile: file, address: SELF.ip }, headers: admin })).status).toBe(400);
    expect((await req("POST", "/api/authorizations/delete", { body: { companyFile: file, address: LAPTOP.ip }, headers: admin })).status).toBe(200);
    expect((await req("POST", "/api/logins/delete", { body: { companyFile: file }, headers: admin })).status).toBe(200);
  });

  it("page/API admin: the owner's other devices yes, another user's device no", async () => {
    expect((await req("GET", "/api/state", { headers: { ...admin, "x-test-caller": "laptop" } })).status).toBe(200);
    const page = await req("GET", "/", { headers: { "x-test-caller": "other" } });
    expect(page.status).toBe(403);
    expect(page.text).toContain("can't manage QuickBooks logins");
    expect((await req("POST", "/api/logins", { body: { companyFile: "C:\\X.qbw", username: "a" }, headers: { ...admin, "x-test-caller": "other" } })).status).toBe(403);
  });

  const connect = async (caller: string) => {
    const client = new Client({ name: "remote-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base()}/mcp`), { requestInit: { headers: { "x-test-caller": caller } } });
    await client.connect(transport);
    return { client, transport };
  };
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean };
    return { isError: !!r.isError, body: JSON.parse(r.content[0].text) };
  };

  it("remote MCP: unauthorized device is refused (9009); after the operator authorizes it, it works", async () => {
    const { client } = await connect("laptop");
    try {
      const tools = await client.listTools();
      expect(tools.tools.some((t) => t.name === "qb_company_open")).toBe(true);

      const denied = await call(client, "qb_company_info");
      expect(denied.isError).toBe(true);
      expect(denied.body).toMatchObject({ statusCode: 9009, caller: { address: LAPTOP.ip, nodeName: "laptop" } });
      expect(denied.body.howToFix).toMatch(/authorize this device/);

      await addAuthorizedPeer(path.join(root, "A", "A.qbw"), { address: LAPTOP.ip, nodeId: LAPTOP.id }, { vaultPath: vault });
      const ok = await call(client, "qb_company_info");
      expect(ok.isError).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("remote MCP: qb_company_list / credentials_list show only the device's files; opening an unauthorized file is refused", async () => {
    await addAuthorizedPeer(path.join(root, "A", "A.qbw"), { address: LAPTOP.ip, nodeId: LAPTOP.id }, { vaultPath: vault });
    await addAuthorizedPeer(path.join(root, "B", "B.qbw"), { address: OTHER.ip, nodeId: OTHER.id }, { vaultPath: vault });
    const { client } = await connect("laptop");
    try {
      const list = await call(client, "qb_company_list", { depth: 2 });
      expect(list.body.companies.map((c: { displayName: string }) => c.displayName)).toEqual(["A"]);
      expect(list.body.filteredToAuthorizedFiles).toBe(true);
      const creds = await call(client, "qb_company_credentials_list");
      expect(creds.body.savedLogins.map((c: { companyFile: string }) => path.basename(c.companyFile))).toEqual(["A.qbw"]);
      expect(creds.body.vaultPath).toBeUndefined();
      const openB = await call(client, "qb_company_open", { companyFile: path.join(root, "B", "B.qbw") });
      expect(openB).toMatchObject({ isError: true, body: { statusCode: 9009 } });
      const openA = await call(client, "qb_company_open", { companyFile: path.join(root, "A", "A.qbw") });
      expect(openA.isError).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("remote MCP: a session can't be reused from a different device", async () => {
    const { client, transport } = await connect("laptop");
    try {
      const sid = transport.sessionId;
      expect(sid).toBeTruthy();
      const hijack = await req("POST", "/mcp", {
        body: { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} },
        headers: { "x-test-caller": "other", "mcp-session-id": sid!, Accept: "application/json, text/event-stream" },
      });
      expect(hijack.status).toBe(403);
    } finally {
      await client.close();
    }
  });

  const waitForJob = async () => {
    for (let i = 0; i < 50; i++) {
      const st = JSON.parse((await req("GET", "/api/state", { headers: admin })).text);
      if (st.job && st.job.status !== "running") return st;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("job did not finish");
  };

  it("state carries health, session, activity, storage, agents and the admin rules", async () => {
    const file = path.join(root, "A", "A.qbw");
    await req("POST", "/api/logins", { body: { companyFile: file, username: "Admin", password: "x" }, headers: admin });
    const st = JSON.parse((await req("GET", "/api/state", { headers: admin })).text);
    expect(st.health).toMatchObject({ state: "not-running", summary: expect.any(String), recommendedAction: expect.any(String) });
    expect(st.session).toMatchObject({ companyFile: file, autoRecover: expect.any(Boolean), recoveryCount: 0 });
    expect(st.activity[0]).toMatchObject({ category: "logins", message: expect.stringMatching(/Saved a login for A\.qbw \(user Admin\)/) });
    expect(st.storage.credentials).toMatchObject({ path: vault, exists: true });
    expect(st.agents).toEqual({ stdio: true, http: [] });
    expect(st.admins).toEqual({ ownerLogin: SELF.login, extra: [] });
    expect(JSON.stringify(st)).not.toMatch(/FAKECIPHER/);
  });

  it("Reconnect and Open run as background jobs and report their outcome", async () => {
    const r1 = await req("POST", "/api/session/reconnect", { body: {}, headers: admin });
    expect(r1.status).toBe(202);
    let st = await waitForJob();
    expect(st.job).toMatchObject({ kind: "reconnect", status: "succeeded" });
    const b = path.join(root, "B", "B.qbw");
    expect((await req("POST", "/api/session/open", { body: { companyFile: b }, headers: admin })).status).toBe(202);
    st = await waitForJob();
    expect(st.job).toMatchObject({ kind: "open", status: "succeeded" });
    expect(st.activeCompanyFile).toBe(b);
    expect(st.session.connected).toBe(true);
    expect((await req("POST", "/api/session/disconnect", { body: {}, headers: admin })).status).toBe(200);
  });

  it("Force close requires the typed confirmation and refuses when QuickBooks isn't frozen", async () => {
    expect((await req("POST", "/api/quickbooks/force-close", { body: {}, headers: admin })).status).toBe(400);
    const r = await req("POST", "/api/quickbooks/force-close", { body: { confirm: "FORCE CLOSE" }, headers: admin });
    expect(r.status).toBe(409);
    expect(JSON.parse(r.text).error).toMatch(/not frozen/);
  });

  it("access changes and refused remote calls show up in the activity log", async () => {
    const file = path.join(root, "A", "A.qbw");
    await req("POST", "/api/authorizations", { body: { companyFile: file, address: LAPTOP.ip }, headers: admin });
    const { client } = await connect("other");
    try { await call(client, "qb_company_info"); } finally { await client.close(); }
    const st = JSON.parse((await req("GET", "/api/state", { headers: admin })).text);
    const msgs = st.activity.map((e: { message: string }) => e.message).join("\n");
    expect(msgs).toMatch(/Gave laptop \(100\.100\.1\.2\) access to A\.qbw/);
    expect(msgs).toMatch(/Refused qb_company_info from contractor-pc/);
  });

  it("connected HTTP agents are listed while connected", async () => {
    const { client } = await connect("laptop");
    try {
      const st = JSON.parse((await req("GET", "/api/state", { headers: admin })).text);
      expect(st.agents.http).toEqual([expect.objectContaining({ caller: "laptop 100.100.1.2", kind: "tailnet" })]);
    } finally {
      await client.close();
    }
  });

  it("local MCP over HTTP is unrestricted (same trust as stdio)", async () => {
    const { client } = await connect("local");
    try {
      const r = await call(client, "qb_company_info");
      expect(r.isError).toBe(false);
    } finally {
      await client.close();
    }
  });
});

// ---------------------------------------------------------------------------
// .qbw discovery
// ---------------------------------------------------------------------------

describe("findCompanyFiles", () => {
  it("depth 0 = root only; depth N descends; case-insensitive .QBW", async () => {
    await fs.mkdir(path.join(tmp, "ClientA", "Perm"), { recursive: true });
    await fs.writeFile(path.join(tmp, "Top.qbw"), "");
    await fs.writeFile(path.join(tmp, "ClientA", "A.QBW"), "");
    await fs.writeFile(path.join(tmp, "ClientA", "Perm", "Deep.qbw"), "");
    const names = async (d: number) => (await findCompanyFiles(tmp, d)).map((f) => f.displayName).sort();
    expect(await names(0)).toEqual(["Top"]);
    expect(await names(1)).toEqual(["A", "Top"]);
    expect(await names(2)).toEqual(["A", "Deep", "Top"]);
  });

  it("unreadable root throws; resolveCompanyRoot fallback chain", async () => {
    await expect(findCompanyFiles(path.join(tmp, "missing"))).rejects.toThrow();
    expect(resolveCompanyRoot(undefined, { QB_COMPANY_ROOT: "R" })).toBe("R");
    expect(resolveCompanyRoot("O", { QB_COMPANY_ROOT: "R" })).toBe("O");
    expect(resolveCompanyRoot(undefined, {})).toBeNull();
    expect(normalizeCompanyPath("C:\\a\\..\\B.qbw")).toBe("c:\\b.qbw");
  });
});

// ---------------------------------------------------------------------------
// Login autofill (Windows)
// ---------------------------------------------------------------------------

const runPs = (script: string, args: string[]): string =>
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolveScriptPath(script), ...args], {
    encoding: "utf8", windowsHide: true, timeout: 60_000,
  });

describe.runIf(isWin)("qb-login-autofill.ps1 without UI", () => {
  it("reports no-credentials / no-login-window", async () => {
    await upsertLogin({ companyFile: "C:\\Fake\\Beta.qbw", username: "Admin" }, { vaultPath: vault, protect: fakeProtect });
    expect(JSON.parse(runPs("qb-login-autofill.ps1", ["-VaultPath", vault, "-CompanyFile", "C:\\Fake\\Other.qbw", "-TimeoutSeconds", "5"]).trim()).status).toBe("no-credentials");
    expect(JSON.parse(runPs("qb-login-autofill.ps1", ["-VaultPath", vault, "-CompanyFile", "C:\\Fake\\Beta.qbw", "-TimeoutSeconds", "2", "-ProcessIds", "999999"]).trim()).status).toBe("no-login-window");
  }, 60_000);
});


describe.runIf(isWin && process.env.QB_UI_TESTS === "1")("qb-login-autofill.ps1 against an off-screen stand-in login dialog", () => {
  // Stand-in for QuickBooks' login window. `stubborn` makes the OK button
  // ignore BM_CLICK, like QuickBooks 24's custom "MauiPushButton" (observed
  // live 2026-10-05). On a wrong password it shows a message box, as
  // QuickBooks does. Every submit is appended to outFile.
  const standIn = (expected: string, outFile: string, stubborn: boolean) => `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
public class StubbornButton : System.Windows.Forms.Button {
  public bool IgnoreBmClick;
  protected override void WndProc(ref System.Windows.Forms.Message m) {
    if (IgnoreBmClick && m.Msg == 0x00F5) return;
    base.WndProc(ref m);
  }
}
"@
$f = New-Object System.Windows.Forms.Form
$f.Text = 'AUTOFILL TEST - DO NOT TYPE HERE'; $f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point(-20000, -20000); $f.ShowInTaskbar = $false
$u = New-Object System.Windows.Forms.TextBox; $u.Location = '120,20'; $u.Text = 'Admin'
$p = New-Object System.Windows.Forms.TextBox; $p.Location = '120,60'; $p.UseSystemPasswordChar = $true
$ok = New-Object StubbornButton; $ok.IgnoreBmClick = $${stubborn ? "true" : "false"}; $ok.Text = 'OK'; $ok.Location = '120,100'
$ok.add_Click({
  [IO.File]::AppendAllText('${outFile}', "user=[$($u.Text)] pw=[$($p.Text)]\`n")
  if ($p.Text -eq '${expected}') { $f.Close() }
  else {
    $m = New-Object System.Windows.Forms.Form; $m.Text = 'AUTOFILL TEST - wrong password'; $m.StartPosition = 'Manual'
    $m.Location = New-Object System.Drawing.Point(-20000, -19000); $m.ShowInTaskbar = $false; $m.Show()
  }
})
$f.Controls.AddRange([System.Windows.Forms.Control[]]@($u, $p, $ok))
$t = New-Object System.Windows.Forms.Timer; $t.Interval = 30000; $t.add_Tick({ $f.Close() }); $t.Start()
[void]$f.ShowDialog()`;

  const cases = [
    { name: "standard OK button → filled via bm-click", expected: "S3cr{e}t+P%w~(1)", stubborn: false, status: "filled", detail: /bm-click/, submits: 1 },
    { name: "OK ignores BM_CLICK (like QuickBooks) → falls back, filled via mouse-click", expected: "S3cr{e}t+P%w~(1)", stubborn: true, status: "filled", detail: /mouse-click/, submits: 1 },
    { name: "wrong password → QuickBooks-style message → rejected after ONE submit", expected: "different", stubborn: true, status: "rejected", detail: /wrong/, submits: 1 },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const secret = "S3cr{e}t+P%w~(1)";
      await upsertLogin({ companyFile: "C:\\Fake\\Alpha.qbw", username: "Bookkeeper", password: secret }, { vaultPath: vault });
      const out = path.join(tmp, "submits.txt");
      const ps1 = path.join(tmp, "standin.ps1");
      writeFileSync(ps1, standIn(c.expected, out, c.stubborn));
      const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], { windowsHide: false });
      try {
        const res = JSON.parse(runPs("qb-login-autofill.ps1", [
          "-VaultPath", vault, "-CompanyFile", "c:\\fake\\ALPHA.qbw", "-TimeoutSeconds", "30", "-ProcessIds", String(child.pid),
        ]).trim());
        expect(res.status).toBe(c.status);
        expect(String(res.detail ?? "")).toMatch(c.detail);
        const submits = readFileSync(out, "utf8").trim().split(/\r?\n/);
        expect(submits).toHaveLength(c.submits);
        expect(submits[0]).toBe(`user=[Bookkeeper] pw=[${secret}]`);
      } finally {
        child.kill();
      }
    }, 120_000);
  }
});
