/**
 * The QuickBooks connector's HTTP server (docs/CONNECTOR_DESIGN.md).
 *
 * Runs on a QuickBooks workstation and does only what must happen there:
 * QBXMLRP2 COM (through the out-of-process helper), QuickBooks launch /
 * close / health, login autofill, and file discovery / browse / drives.
 * It serves no MCP and no tools.
 *
 * Who may call: only the hub. A request must come from the hub's address
 * (or loopback, for tests and local diagnostics) AND carry the connector's
 * bearer secret. It listens on 127.0.0.1 and this PC's tailnet address only,
 * never 0.0.0.0.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { localQBHost, type QBHost } from "../session/qb-host.js";
import type { QBRequestProcessor } from "../session/com-worker-client.js";
import {
  protectPassword,
  startLoginAutofill,
  upsertLogin,
  type LoginAutofillHandle,
  type LoginAutofillResult,
  type PasswordProtector,
} from "../util/qb-credentials.js";
import { isLoopback, normalizeIp } from "../util/tailnet.js";
import { makeLoginExporter, type LoginExporter } from "./login-export.js";
import {
  COM_OPS,
  CONNECTOR_PROTOCOL,
  REMOTE_HOST_METHODS,
  toWireError,
  type ComOp,
  type RemoteHostMethod,
} from "./protocol.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024; // qbXML requests (batch JEs) can be large
const MAX_COM_HANDLES = 8;
const AUTOFILL_KEEP_MS = 10 * 60_000;

/** Starts one login autofill with credentials handed over by the hub. */
export type AutofillStarter = (companyFile: string, username: string, password: string) => Promise<LoginAutofillHandle | null>;

/**
 * Default: write a one-entry vault encrypted with this PC's DPAPI to a
 * private temp folder, run the existing autofill script against it, and
 * delete it when the autofill finishes. The plaintext never touches disk.
 */
export function makeDpapiAutofillStarter(protect: PasswordProtector = protectPassword): AutofillStarter {
  return async (companyFile, username, password) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "qbmcp-autofill-"));
    const vaultPath = path.join(dir, "credentials.json");
    const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };
    try {
      await upsertLogin({ companyFile, username, password }, { vaultPath, protect });
      const handle = startLoginAutofill({ companyFile, vaultPath });
      if (!handle) { cleanup(); return null; }
      void handle.result.finally(cleanup);
      return handle;
    } catch (err) {
      cleanup();
      throw err;
    }
  };
}

export interface ConnectorServerOptions {
  port: number;
  secret: string;
  /** Addresses the hub calls from (its tailnet IPs). Loopback is always allowed. */
  hubAddresses: string[];
  listenHosts: string[];
  version: string;
  host?: QBHost;
  autofill?: AutofillStarter;
  /** Saved logins on this PC, decrypted, for a one-time import into the hub. */
  exportLogins?: LoginExporter;
}

export interface ConnectorServerHandle {
  port: number;
  urls: string[];
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new HttpError(413, "Request body too large.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
        resolve(v as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, "Body must be a JSON object."));
      }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

function secretMatches(header: string | undefined, secret: string): boolean {
  const m = /^Bearer\s+(.+)$/.exec(header ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startConnectorServer(opts: ConnectorServerOptions): Promise<ConnectorServerHandle> {
  const host = opts.host ?? localQBHost;
  const autofill = opts.autofill ?? makeDpapiAutofillStarter();
  const exportLogins = opts.exportLogins ?? makeLoginExporter({ listDrives: () => host.listDrives() });
  const hubAddresses = new Set(opts.hubAddresses.map(normalizeIp));

  const com = new Map<string, { rp: QBRequestProcessor; lastUsed: number }>();
  const fills = new Map<string, { done: boolean; result?: LoginAutofillResult; handle: LoginAutofillHandle; waiters: Array<() => void> }>();

  const dropCom = (id: string) => {
    const h = com.get(id);
    if (!h) return false;
    com.delete(id);
    try { h.rp.dispose?.(); } catch { /* ignore */ }
    return true;
  };

  const route = async (pathname: string, body: Record<string, unknown>): Promise<unknown> => {
    if (pathname === "/v1/info") {
      return { protocol: CONNECTOR_PROTOCOL, version: opts.version, hostname: os.hostname(), platform: process.platform, label: host.label };
    }
    if (pathname.startsWith("/v1/host/")) {
      const method = pathname.slice("/v1/host/".length) as RemoteHostMethod;
      if (!(REMOTE_HOST_METHODS as readonly string[]).includes(method)) throw new HttpError(404, "Unknown host method.");
      const args = Array.isArray(body.args) ? body.args : [];
      const fn = host[method] as (...a: unknown[]) => Promise<unknown>;
      return { result: (await fn.apply(host, args)) ?? null };
    }
    switch (pathname) {
      case "/v1/com/open": {
        if (com.size >= MAX_COM_HANDLES) {
          // A hub that restarted may have orphaned handles: release the least recently used.
          const oldest = [...com.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
          if (oldest) dropCom(oldest[0]);
        }
        const id = randomUUID();
        com.set(id, { rp: host.createRequestProcessor(), lastUsed: Date.now() });
        return { id };
      }
      case "/v1/com/call": {
        const h = com.get(String(body.id ?? ""));
        if (!h) throw Object.assign(new Error("QuickBooks COM helper exited (unknown handle; the connector may have restarted)."), { name: "Error" });
        const op = String(body.op ?? "") as ComOp;
        if (!(COM_OPS as readonly string[]).includes(op)) throw new HttpError(400, "Unknown COM operation.");
        h.lastUsed = Date.now();
        const args = Array.isArray(body.args) ? body.args : [];
        const fn = h.rp[op] as (...a: unknown[]) => unknown;
        return { result: (await fn.apply(h.rp, args)) ?? null };
      }
      case "/v1/com/dispose":
        return { ok: dropCom(String(body.id ?? "")) };
      case "/v1/autofill/start": {
        const companyFile = String(body.companyFile ?? "");
        const handle = await autofill(companyFile, String(body.username ?? ""), String(body.password ?? ""));
        if (!handle) return { id: null };
        const id = randomUUID();
        const entry = { done: false, handle, waiters: [] as Array<() => void>, result: undefined as LoginAutofillResult | undefined };
        fills.set(id, entry);
        void handle.result.then((r) => {
          entry.done = true;
          entry.result = r;
          entry.waiters.splice(0).forEach((w) => w());
          setTimeout(() => fills.delete(id), AUTOFILL_KEEP_MS).unref();
        });
        return { id };
      }
      case "/v1/autofill/result": {
        const entry = fills.get(String(body.id ?? ""));
        if (!entry) return { done: true, result: { status: "error", detail: "Unknown autofill (the connector may have restarted)." } };
        if (!entry.done) {
          const waitMs = Math.min(Math.max(Number(body.waitMs) || 0, 0), 25_000);
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, waitMs);
            entry.waiters.push(() => { clearTimeout(t); resolve(); });
          });
        }
        return entry.done ? { done: true, result: entry.result } : { done: false };
      }
      case "/v1/logins/export":
        return { logins: await exportLogins() };
      case "/v1/autofill/cancel": {
        fills.get(String(body.id ?? ""))?.handle.cancel();
        return { ok: true };
      }
      default:
        throw new HttpError(404, "Not found.");
    }
  };

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const ip = normalizeIp(req.socket.remoteAddress ?? "");
      if (!isLoopback(ip) && !hubAddresses.has(ip)) throw new HttpError(403, "Only the QuickBooks MCP hub may call this connector.");
      if (!secretMatches(req.headers.authorization, opts.secret)) throw new HttpError(401, "Missing or wrong connector secret.");
      if (req.method !== "POST") throw new HttpError(405, "Method not allowed.");
      const url = new URL(req.url ?? "/", "http://placeholder");
      const body = await readJson(req);
      send(res, 200, await route(url.pathname, body));
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      const status = err instanceof HttpError ? err.status : 500;
      send(res, status, { error: toWireError(err) });
    }
  };

  const servers: http.Server[] = [];
  let actualPort = opts.port;
  for (const h of opts.listenHosts) {
    const srv = http.createServer((req, res) => { void handler(req, res); });
    // QuickBooks calls can run 10 minutes; don't let Node cut them off.
    srv.requestTimeout = 0;
    srv.headersTimeout = 60_000;
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(actualPort, h, () => {
        const addr = srv.address();
        if (addr && typeof addr === "object") actualPort = addr.port;
        resolve();
      });
    });
    servers.push(srv);
  }

  return {
    port: actualPort,
    urls: opts.listenHosts.map((h) => `http://${h}:${actualPort}/`),
    close: async () => {
      for (const id of [...com.keys()]) dropCom(id);
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    },
  };
}
