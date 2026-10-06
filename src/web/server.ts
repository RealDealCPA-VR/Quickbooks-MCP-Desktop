/**
 * Local web server started alongside the MCP server (stdio). It serves:
 *
 *   GET  /                          the "Company file logins" page
 *   GET  /api/state                 saved logins (never passwords), discovered
 *                                   .qbw files, tailnet devices, endpoint URLs
 *   POST /api/logins                create / overwrite a file's login
 *   POST /api/logins/delete         delete a file's entry
 *   POST /api/authorizations        authorize a tailnet device for a file
 *   POST /api/authorizations/delete revoke it
 *   POST|GET|DELETE /mcp            MCP Streamable HTTP for remote agents
 *
 * Listens on 127.0.0.1 and on this machine's tailnet address(es) only, never
 * 0.0.0.0, so it is unreachable from the LAN or internet.
 *
 * Who may do what:
 *   - The page and /api are for administrators: loopback, this machine's own
 *     tailnet address, any tailnet device owned by the same Tailscale login
 *     as this machine (not tagged devices), or a login/address listed in
 *     QB_WEB_ADMINS.
 *   - /mcp accepts loopback (local, unrestricted) and tailnet callers.
 *     Tailnet callers are identified by `tailscale whois` and may use only
 *     the company files they are authorized for (caller-authorization.ts).
 *
 * Browser hardening: the Host header must be one of our own names (blocks
 * DNS rebinding). API writes need a JSON body plus an X-QB-Admin header, and
 * the Origin must match when sent; we never answer CORS preflights, so a
 * hostile web page can't post here. Bodies are capped at 64 KB.
 */

import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type { QBSessionManager } from "../session/manager.js";
import type { CallerIdentity } from "../util/caller-authorization.js";
import { findCompanyFiles, resolveCompanyRoot } from "../util/company-files.js";
import { BrowseError, browseDirectory, defaultDriveLister, type DriveLister } from "../util/fs-browse.js";
import {
  addAuthorizedPeer,
  CredentialInputError,
  getCredentialsFilePath,
  readCredentialSummaries,
  removeAuthorizedPeer,
  removeEntry,
  upsertLogin,
  validateCompanyFilePath,
  type PasswordProtector,
} from "../util/qb-credentials.js";
import {
  defaultTailscaleRunner,
  isLoopback,
  isTailnetAddress,
  normalizeIp,
  tailnetPeers,
  tailnetSelfAddresses,
  tailnetWhois,
  type TailnetIdentity,
  type TailscaleRunner,
} from "../util/tailnet.js";
import { ADMIN_PAGE_HTML, FORBIDDEN_PAGE_HTML } from "./admin-page.js";
import { fileLabel } from "../session/manager.js";
import { getActivity, getActivityLogPath, recordActivity } from "../util/activity-log.js";
import { getQuickBooksHealth, type HealthProbe } from "../util/qb-health.js";
import { defaultForceCloseQBDesktop } from "../util/qb-desktop-launch.js";
import { existsSync, statSync } from "node:fs";

export const DEFAULT_WEB_PORT = 8765;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MCP_SESSIONS = 32;

export interface WebServerOptions {
  port?: number;
  /** Also listen on this machine's tailnet address(es). Default true. */
  bindTailnet?: boolean;
  /** Builds a fresh MCP server (tools guarded for `identity`) per HTTP session. */
  createMcpServer: (identity: CallerIdentity) => McpServer;
  getSession: () => QBSessionManager;
  vaultPath?: () => string;
  tailscale?: TailscaleRunner;
  protect?: PasswordProtector;
  /** Extra admins: Tailscale login names or tailnet addresses. */
  admins?: string[];
  /** Overrides for tests. */
  listenHosts?: string[];
  /** True when this process also serves an MCP host over stdio (shown on the page). */
  stdioConnected?: boolean;
  /** Test seams for QuickBooks health and the force-close action. */
  healthProbe?: HealthProbe;
  forceCloseQuickBooks?: () => Promise<boolean>;
  /** Test seam: the drive list behind the company-file picker. */
  listDrives?: DriveLister;
  /** Test seam: decide the caller identity instead of using the socket address + tailscale whois. */
  identifyCaller?: (req: http.IncomingMessage) => Promise<CallerIdentity | null>;
}

export interface WebServerHandle {
  /** e.g. http://127.0.0.1:8765/ and http://100.x.y.z:8765/ */
  pageUrls: string[];
  mcpUrls: string[];
  port: number;
  close(): Promise<void>;
}

let current: { pageUrls: string[]; mcpUrls: string[]; port: number } | null = null;

/** URLs of the running page (or where it would be), for tools to hand out. */
export function getWebServerInfo(): { pageUrls: string[]; mcpUrls: string[]; port: number } {
  if (current) return current;
  const port = Number(process.env.QB_WEB_PORT) || DEFAULT_WEB_PORT;
  return { pageUrls: [`http://127.0.0.1:${port}/`], mcpUrls: [`http://127.0.0.1:${port}/mcp`], port };
}

/** Open a URL in the default browser of THIS machine (Windows/macOS/Linux). */
export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => { /* no browser available — the URL is still returned */ });
    child.unref();
  } catch { /* ignore */ }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(html);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const ct = String(req.headers["content-type"] ?? "");
  if (!ct.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Expected application/json.");
  const text = await readBody(req);
  try {
    const v = JSON.parse(text || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Body must be a JSON object.");
  }
}

function describeCallerShort(id: CallerIdentity): string {
  return id.kind === "local" ? "this computer" : `${id.nodeName} ${id.address}`;
}

export async function startWebServer(opts: WebServerOptions): Promise<WebServerHandle> {
  const port = opts.port ?? (Number(process.env.QB_WEB_PORT) || DEFAULT_WEB_PORT);
  const run = opts.tailscale ?? defaultTailscaleRunner;
  const vaultPath = opts.vaultPath ?? (() => getCredentialsFilePath());
  const admins = (opts.admins ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean);

  const selfAddresses = opts.bindTailnet === false ? [] : await tailnetSelfAddresses(run);
  const selfIdentity: TailnetIdentity | null = selfAddresses.length ? await tailnetWhois(selfAddresses[0], run) : null;
  const listenHosts = opts.listenHosts ?? ["127.0.0.1", ...selfAddresses.filter((a) => a.includes("."))];

  // Host-header allowlist (DNS-rebinding defense).
  const hostNames = new Set<string>(["127.0.0.1", "localhost", "[::1]", ...listenHosts]);
  if (selfIdentity?.dnsName) hostNames.add(selfIdentity.dnsName.toLowerCase());
  if (selfIdentity?.nodeName) hostNames.add(selfIdentity.nodeName.toLowerCase());

  const identify = async (req: http.IncomingMessage): Promise<CallerIdentity | null> => {
    const ip = normalizeIp(req.socket.remoteAddress ?? "");
    if (isLoopback(ip)) return { kind: "local", via: "loopback" };
    if (selfAddresses.includes(ip)) return { kind: "local", via: "self-tailnet" };
    if (!isTailnetAddress(ip)) return null;
    const who = await tailnetWhois(ip, run);
    return who ? { kind: "tailnet", ...who } : null;
  };

  const isAdmin = (id: CallerIdentity): boolean => {
    if (id.kind === "local") return true;
    const login = id.loginName.toLowerCase();
    if (admins.includes(login) || admins.includes(id.address)) return true;
    return !!selfIdentity && !!login && login !== "tagged-devices" && login === selfIdentity.loginName.toLowerCase();
  };

  const hostAllowed = (req: http.IncomingMessage, boundPort: number): boolean => {
    const host = String(req.headers.host ?? "").toLowerCase();
    if (!host) return false;
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host);
    if (!m) return false;
    if (m[2] && Number(m[2]) !== boundPort) return false;
    return hostNames.has(m[1]);
  };

  // ---- MCP sessions ------------------------------------------------------
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; callerKey: string; caller: CallerIdentity; connectedAt: string; lastSeenAt: string }>();
  const callerKey = (id: CallerIdentity) => (id.kind === "local" ? "local" : `${id.address}|${id.nodeId}`);

  const handleMcp = async (req: http.IncomingMessage, res: http.ServerResponse, id: CallerIdentity) => {
    const sid = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;
    let body: unknown;
    if (req.method === "POST") {
      const text = await readBody(req);
      try {
        body = JSON.parse(text);
      } catch {
        throw new HttpError(400, "Invalid JSON-RPC body.");
      }
    }
    if (sessionId) {
      const s = sessions.get(sessionId);
      if (!s) throw new HttpError(404, "Unknown MCP session.");
      if (s.callerKey !== callerKey(id)) throw new HttpError(403, "This MCP session belongs to a different device.");
      s.lastSeenAt = new Date().toISOString();
      await s.transport.handleRequest(req, res, body);
      return;
    }
    if (req.method !== "POST" || !isInitializeRequest(body)) {
      throw new HttpError(400, "Missing mcp-session-id (send initialize first).");
    }
    if (sessions.size >= MAX_MCP_SESSIONS) throw new HttpError(503, "Too many MCP sessions.");
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newId) => {
        const now = new Date().toISOString();
        sessions.set(newId, { transport, callerKey: callerKey(id), caller: id, connectedAt: now, lastSeenAt: now });
        recordActivity({ level: "info", category: "agent", message: `Agent connected over HTTP from ${describeCallerShort(id)}` });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId && sessions.delete(transport.sessionId)) {
        recordActivity({ level: "info", category: "agent", message: `Agent disconnected (${describeCallerShort(id)})` });
      }
    };
    const server = opts.createMcpServer(id);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  // ---- background jobs (reconnect / open / force close) ----------------
  type Job = { id: string; kind: string; label: string; startedAt: string; finishedAt?: string; status: "running" | "succeeded" | "failed"; message?: string };
  let job: Job | null = null;
  const startJob = (kind: string, label: string, fn: () => Promise<string>): Job => {
    if (job?.status === "running") throw new HttpError(409, `Already working on: ${job.label}. Wait for it to finish.`);
    const j: Job = { id: randomUUID(), kind, label, startedAt: new Date().toISOString(), status: "running" };
    job = j;
    void fn().then(
      (message) => { j.status = "succeeded"; j.message = message; j.finishedAt = new Date().toISOString(); },
      (err: unknown) => {
        const e = err as { message?: string; reason?: string; recommendedAction?: string };
        j.status = "failed";
        j.message = [e.message ?? String(err), e.recommendedAction].filter(Boolean).join(" ");
        j.finishedAt = new Date().toISOString();
      },
    );
    return j;
  };

  const storageInfo = (vp: string) => {
    const info = (f: string) => {
      try {
        if (!existsSync(f)) return { path: f, exists: false };
        const st = statSync(f);
        return { path: f, exists: true, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() };
      } catch {
        return { path: f, exists: false };
      }
    };
    const activityLog = process.env.QB_ACTIVITY_LOG === "0"
      ? { path: "(kept in memory only: QB_ACTIVITY_LOG=0)", exists: false }
      : info(getActivityLogPath());
    return { credentials: info(vp), activityLog };
  };

  // ---- admin API -------------------------------------------------------
  const stateFor = async (id: CallerIdentity, mcpUrls: string[]) => {
    const vp = vaultPath();
    const entries = readCredentialSummaries(vp);
    const root = resolveCompanyRoot();
    let discovered: Array<{ companyFile: string; displayName: string }> = [];
    if (root) {
      try {
        discovered = (await findCompanyFiles(root, 3)).map((f) => ({ companyFile: f.companyFile, displayName: f.displayName }));
      } catch { /* unreadable root → none */ }
    }
    const peers = (await tailnetPeers(run)).map((p) => ({ ...p, isSelf: selfAddresses.includes(p.address) }));
    let session: QBSessionManager | null = null;
    try { session = opts.getSession(); } catch { session = null; }
    return {
      me: id.kind === "local" ? { kind: "local" } : { kind: "tailnet", address: id.address, nodeName: id.nodeName, loginName: id.loginName },
      vaultPath: vp,
      entries,
      discoveryRoot: root,
      discovered,
      peers,
      mcpUrls: mcpUrls.filter((u) => !u.includes("127.0.0.1")),
      activeCompanyFile: session?.getCompanyFile() ?? "",
      simulationMode: session?.isSimulation() ?? true,
      session: session ? session.getDiagnostics() : null,
      health: await getQuickBooksHealth(opts.healthProbe ? { probe: opts.healthProbe } : {}),
      activity: getActivity(150),
      storage: storageInfo(vp),
      agents: {
        stdio: !!opts.stdioConnected,
        http: [...sessions.values()].map((x) => ({
          caller: x.caller.kind === "local" ? "this computer" : `${x.caller.nodeName} ${x.caller.address}`,
          kind: x.caller.kind,
          connectedAt: x.connectedAt,
          lastSeenAt: x.lastSeenAt,
        })),
      },
      job,
      admins: { ownerLogin: selfIdentity?.loginName ?? null, extra: admins },
    };
  };

  const handleApi = async (req: http.IncomingMessage, res: http.ServerResponse, pathname: string, id: CallerIdentity, mcpUrls: string[]) => {
    if (req.headers["x-qb-admin"] !== "1") throw new HttpError(403, "Missing X-QB-Admin header.");
    if (req.method === "GET" && pathname === "/api/state") {
      sendJson(res, 200, await stateFor(id, mcpUrls));
      return;
    }
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed.");
    const body = await readJson(req);
    const file = String(body.companyFile ?? "");
    switch (pathname) {
      case "/api/logins": {
        const r = await upsertLogin(
          {
            companyFile: file,
            username: String(body.username ?? ""),
            password: typeof body.password === "string" ? body.password : undefined,
            clearPassword: body.clearPassword === true,
          },
          { vaultPath: vaultPath(), ...(opts.protect ? { protect: opts.protect } : {}) },
        );
        recordActivity({
          level: "info",
          category: "logins",
          message: r.created
            ? `Saved a login for ${fileLabel(file)} (user ${r.entry.username})`
            : `Changed the login for ${fileLabel(file)}${r.usernameChanged ? ` (user now ${r.entry.username})` : ""}${r.passwordChanged ? "; new password" : ""}`,
          companyFile: r.entry.companyFile,
          detail: `by ${describeCallerShort(id)}`,
        });
        sendJson(res, 200, { ok: true, created: r.created, passwordChanged: r.passwordChanged, usernameChanged: r.usernameChanged, entry: r.entry });
        return;
      }
      case "/api/browse": {
        // Company-file picker: no path → this computer's drives; a path → its folders + .qbw files.
        const dir = String(body.path ?? "").trim();
        if (!dir) {
          sendJson(res, 200, { drives: await (opts.listDrives ?? defaultDriveLister)() });
          return;
        }
        try {
          sendJson(res, 200, await browseDirectory(dir));
        } catch (err) {
          if (err instanceof BrowseError) throw new HttpError(400, err.message);
          throw err;
        }
        return;
      }
      case "/api/logins/delete": {
        const removed = await removeEntry(file, { vaultPath: vaultPath() });
        if (removed) recordActivity({ level: "warn", category: "logins", message: `Deleted the saved login and access for ${fileLabel(file)}`, companyFile: file, detail: `by ${describeCallerShort(id)}` });
        sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: "No saved entry for that company file." });
        return;
      }
      case "/api/authorizations": {
        validateCompanyFilePath(file);
        const address = normalizeIp(String(body.address ?? ""));
        if (!isTailnetAddress(address)) throw new HttpError(400, "That is not a tailnet address (expected 100.x.y.z).");
        if (selfAddresses.includes(address)) throw new HttpError(400, "That is this computer. Local agents can already use every file.");
        const who = await tailnetWhois(address, run);
        if (!who) throw new HttpError(400, `No tailnet device answers to ${address}. Is it online and on this tailnet?`);
        const entry = await addAuthorizedPeer(
          file,
          { address: who.address, nodeId: who.nodeId, nodeName: who.nodeName, loginName: who.loginName },
          { vaultPath: vaultPath() },
        );
        recordActivity({ level: "info", category: "access", message: `Gave ${who.nodeName} (${who.address}) access to ${fileLabel(file)}`, companyFile: file, detail: `by ${describeCallerShort(id)}` });
        sendJson(res, 200, { ok: true, entry });
        return;
      }
      case "/api/authorizations/delete": {
        const address = String(body.address ?? "");
        const removed = await removeAuthorizedPeer(file, address, { vaultPath: vaultPath() });
        if (removed) recordActivity({ level: "warn", category: "access", message: `Removed ${address}'s access to ${fileLabel(file)}`, companyFile: file, detail: `by ${describeCallerShort(id)}` });
        sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: "That device was not authorized for the file." });
        return;
      }
      case "/api/session/reconnect": {
        const session = opts.getSession();
        const j = startJob("reconnect", `Reconnecting to ${fileLabel(session.getCompanyFile())}`, async () => {
          const s = await session.recover({ trigger: `Reconnect pressed on the logins page (${describeCallerShort(id)})` });
          return `Connected to ${fileLabel(s.companyFile)}.`;
        });
        sendJson(res, 202, { ok: true, job: j });
        return;
      }
      case "/api/session/open": {
        validateCompanyFilePath(file);
        const session = opts.getSession();
        const j = startJob("open", `Opening ${fileLabel(file)}`, async () => {
          const s = await session.switchCompanyFile(file, { closeCurrentCompany: true });
          const info = session.getLastSwitchLaunchInfo();
          return `Connected to ${fileLabel(s.companyFile)}${info.loginAutofill ? ` (login: ${info.loginAutofill})` : ""}.`;
        });
        sendJson(res, 202, { ok: true, job: j });
        return;
      }
      case "/api/session/disconnect": {
        await opts.getSession().closeSession();
        sendJson(res, 200, { ok: true });
        return;
      }
      case "/api/quickbooks/force-close": {
        if (body.confirm !== "FORCE CLOSE") throw new HttpError(400, 'Type FORCE CLOSE to confirm.');
        const health = await getQuickBooksHealth(opts.healthProbe ? { probe: opts.healthProbe } : { fresh: true });
        if (health.state !== "not-responding" && health.state !== "crashed" && body.evenIfResponding !== true) {
          throw new HttpError(409, `QuickBooks is not frozen (${health.summary}). Close it normally instead.`);
        }
        const j = startJob("force-close", "Force-closing QuickBooks", async () => {
          recordActivity({ level: "warn", category: "recovery", message: "Force-closed QuickBooks from the logins page", detail: `by ${describeCallerShort(id)}; state was ${health.state}` });
          try { await opts.getSession().closeSession(); } catch { /* QB is gone anyway */ }
          const ok = await (opts.forceCloseQuickBooks ?? defaultForceCloseQBDesktop)();
          if (!ok) throw new Error("QuickBooks is still running. Close it in Task Manager.");
          return "QuickBooks was force-closed. Press Reconnect (or let the next agent request) to reopen the company file.";
        });
        sendJson(res, 202, { ok: true, job: j });
        return;
      }
      default:
        throw new HttpError(404, "Not found.");
    }
  };

  // ---- request router --------------------------------------------------
  const makeHandler = (boundPort: () => number, mcpUrls: () => string[]) =>
    async (req: http.IncomingMessage, res: http.ServerResponse) => {
      try {
        if (!hostAllowed(req, boundPort())) throw new HttpError(421, "Unrecognized Host header.");
        const id = await (opts.identifyCaller ?? identify)(req);
        if (!id) throw new HttpError(403, "Only this computer and devices on its tailnet may connect.");
        const url = new URL(req.url ?? "/", "http://placeholder");
        const pathname = url.pathname;

        if (pathname === "/mcp") {
          await handleMcp(req, res, id);
          return;
        }
        if (req.method === "OPTIONS") throw new HttpError(405, "Method not allowed.");
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}`) throw new HttpError(403, "Cross-origin requests are not allowed.");
        if (!isAdmin(id)) {
          if (pathname.startsWith("/api/")) throw new HttpError(403, "This device may not manage QuickBooks logins.");
          sendHtml(res, 403, FORBIDDEN_PAGE_HTML);
          return;
        }
        if (pathname.startsWith("/api/")) {
          await handleApi(req, res, pathname, id, mcpUrls());
          return;
        }
        if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
          sendHtml(res, 200, ADMIN_PAGE_HTML);
          return;
        }
        throw new HttpError(404, "Not found.");
      } catch (err) {
        if (res.headersSent) {
          res.end();
          return;
        }
        const status = err instanceof HttpError ? err.status : err instanceof CredentialInputError ? 400 : 500;
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, status, { error: status === 500 ? `Server error: ${message}` : message });
      }
    };

  // ---- listen ----------------------------------------------------------
  const servers: http.Server[] = [];
  let actualPort = port;
  const urlsFor = (p: number) => {
    const hosts = listenHosts.filter((h) => servers.some((s) => (s.address() as AddressInfo | null)?.address === h));
    return {
      pageUrls: hosts.map((h) => `http://${h}:${p}/`),
      mcpUrls: hosts.map((h) => `http://${h}:${p}/mcp`),
    };
  };
  const handler = makeHandler(() => actualPort, () => urlsFor(actualPort).mcpUrls);
  for (const host of listenHosts) {
    const srv = http.createServer((req, res) => { void handler(req, res); });
    try {
      await new Promise<void>((resolve, reject) => {
        srv.once("error", reject);
        srv.listen(actualPort, host, () => {
          srv.off("error", reject);
          resolve();
        });
      });
      actualPort = (srv.address() as AddressInfo).port; // port 0 in tests → share the chosen port
      servers.push(srv);
    } catch (err) {
      if (host === listenHosts[0]) {
        for (const s of servers) s.close();
        throw err;
      }
      console.error(`[QB Web] Could not listen on ${host}:${actualPort}: ${(err as Error).message}`);
    }
  }

  const urls = urlsFor(actualPort);
  current = { ...urls, port: actualPort };
  return {
    ...urls,
    port: actualPort,
    close: async () => {
      for (const s of sessions.values()) await s.transport.close().catch(() => undefined);
      sessions.clear();
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
      current = null;
    },
  };
}

