/**
 * Hub ↔ connector wire protocol (docs/CONNECTOR_DESIGN.md).
 *
 * Plain JSON over HTTP on the tailnet (WireGuard encrypts it). Every call is
 * a POST; the hub authenticates with `Authorization: Bearer <secret>` and the
 * connector also checks the source address is the hub's. Errors come back
 * as HTTP 4xx/5xx with `{ error: { message, name?, statusCode?, reason? } }`
 * so the hub can rebuild an error the session manager's classifiers
 * understand (QB-gone text, 9007 reasons, BrowseError).
 *
 * node:http rather than fetch: QuickBooks calls can legitimately run 10
 * minutes, past undici's fixed 5-minute headers timeout.
 */

import http from "node:http";

export const CONNECTOR_PROTOCOL = 1;
export const DEFAULT_CONNECTOR_PORT = 8766;
/** How often a connector re-registers with the hub (its heartbeat). */
export const CONNECTOR_HEARTBEAT_MS = 30_000;

/** The host methods a connector serves at POST /v1/host/<name>. */
export const REMOTE_HOST_METHODS = [
  "isQuickBooksRunning",
  "resolveExe",
  "launch",
  "closeGracefully",
  "forceClose",
  "health",
  "fileExists",
  "findCompanyFiles",
  "listDrives",
  "browse",
] as const;
export type RemoteHostMethod = (typeof REMOTE_HOST_METHODS)[number];

export const COM_OPS = ["OpenConnection2", "BeginSession", "ProcessRequest", "EndSession", "CloseConnection"] as const;
export type ComOp = (typeof COM_OPS)[number];

export interface WireError {
  message: string;
  name?: string;
  statusCode?: number;
  reason?: string;
}

/** The connector could not be reached at all (PC off, connector stopped, network). */
export class WorkstationOfflineError extends Error {
  readonly statusCode = 9012;
  readonly reason = "workstation-offline";
  constructor(readonly workstation: string, detail: string) {
    super(`QuickBooks workstation "${workstation}" is offline (connector not reachable: ${detail}).`);
    this.name = "WorkstationOfflineError";
  }
  get recommendedAction(): string {
    return `Turn on ${this.workstation} and start its QuickBooks connector, or pick another workstation on the control page.`;
  }
}

/** An error the connector reported, carrying its original name/code fields. */
export class ConnectorReportedError extends Error {
  statusCode?: number;
  reason?: string;
  constructor(err: WireError) {
    super(err.message);
    this.name = err.name ?? "Error";
    if (err.statusCode !== undefined) this.statusCode = err.statusCode;
    if (err.reason !== undefined) this.reason = err.reason;
  }
}

export function toWireError(err: unknown): WireError {
  const e = err as { message?: unknown; name?: unknown; statusCode?: unknown; reason?: unknown };
  return {
    message: typeof e?.message === "string" ? e.message : String(err),
    ...(typeof e?.name === "string" ? { name: e.name } : {}),
    ...(typeof e?.statusCode === "number" ? { statusCode: e.statusCode } : {}),
    ...(typeof e?.reason === "string" ? { reason: e.reason } : {}),
  };
}

export interface PostJsonOptions {
  /** Abort after this long with no complete response. */
  timeoutMs: number;
  bearer?: string;
}

/**
 * POST JSON and parse the JSON reply. Network failures reject with
 * `{ network: true }` set on the error so callers can tell "unreachable"
 * from "the other side answered with an error".
 */
export function postJson<T>(url: string, body: unknown, opts: PostJsonOptions): Promise<T> {
  const data = JSON.stringify(body ?? {});
  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(data)),
          ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          clearTimeout(timer);
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = text ? JSON.parse(text) : {};
          } catch {
            reject(Object.assign(new Error(`Bad reply (${res.statusCode}): ${text.slice(0, 200)}`), { network: false }));
            return;
          }
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve(json as T);
            return;
          }
          const err = (json as { error?: WireError | string }).error;
          const wire: WireError = typeof err === "string" ? { message: err } : err ?? { message: `HTTP ${status}` };
          reject(Object.assign(new ConnectorReportedError(wire), { httpStatus: status }));
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error(`did not answer within ${Math.round(opts.timeoutMs / 1000)}s`), { network: true }));
    }, opts.timeoutMs);
    req.on("error", (e) => {
      clearTimeout(timer);
      const ne = e as Error & { network?: boolean };
      if (ne.network === undefined) ne.network = true;
      reject(ne);
    });
    req.end(data);
  });
}
