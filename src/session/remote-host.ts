/**
 * RemoteQBHost: a QuickBooks workstation reached through its connector
 * (docs/CONNECTOR_DESIGN.md). Same QBHost shape as localQBHost; every call
 * goes over the tailnet to the connector, which runs it on the workstation.
 *
 * Unreachable connector → WorkstationOfflineError (9012). An error the
 * connector reports keeps its message/name/statusCode/reason, so the session
 * manager's classifiers (QB-gone text, 9007 reasons) behave as they do
 * locally.
 */

import { COM_TIMEOUTS, type QBRequestProcessor } from "./com-worker-client.js";
import type { QBHost } from "./qb-host.js";
import {
  postJson,
  WorkstationOfflineError,
  type ComOp,
  type RemoteHostMethod,
} from "../connector/protocol.js";
import { BrowseError } from "../util/fs-browse.js";
import type { LoginAutofillHandle, LoginAutofillResult } from "../util/qb-credentials.js";

export interface RemoteWorkstation {
  name: string;
  address: string;
  port: number;
  secret: string;
}

/** Hub-side lookup of a saved login, decrypted for one autofill. Null when none is saved. */
export type LoginLookup = (companyFile: string) => Promise<{ username: string; password: string } | null>;

/** Generous margins on top of the connector's own COM limits, so the connector times out first. */
const MARGIN_MS = 30_000;
const COM_CALL_TIMEOUTS: Record<ComOp, number> = {
  OpenConnection2: COM_TIMEOUTS.openMs + MARGIN_MS,
  BeginSession: COM_TIMEOUTS.beginMs + MARGIN_MS,
  ProcessRequest: COM_TIMEOUTS.processMs + MARGIN_MS,
  EndSession: COM_TIMEOUTS.endMs + MARGIN_MS,
  CloseConnection: COM_TIMEOUTS.endMs + MARGIN_MS,
};
/** Health, discovery and launch/close can take a while on a busy workstation. */
const HOST_CALL_TIMEOUT_MS: Partial<Record<RemoteHostMethod, number>> = {
  closeGracefully: 90_000,
  forceClose: 60_000,
  findCompanyFiles: 120_000,
  browse: 60_000,
};
const DEFAULT_HOST_TIMEOUT_MS = 30_000;
const AUTOFILL_POLL_WAIT_MS = 20_000;

export class RemoteQBHost implements QBHost {
  readonly label: string;

  constructor(
    private readonly ws: RemoteWorkstation,
    private readonly loginFor: LoginLookup,
    /** Saved-login check on the hub (the vault lives there). */
    private readonly hasLogin: (companyFile: string) => Promise<boolean>,
  ) {
    this.label = ws.name;
  }

  private base(): string {
    return `http://${this.ws.address.includes(":") ? `[${this.ws.address}]` : this.ws.address}:${this.ws.port}`;
  }

  /** POST to the connector; turns "couldn't reach it" into WorkstationOfflineError. */
  async call<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    try {
      return await postJson<T>(`${this.base()}${path}`, body, { timeoutMs, bearer: this.ws.secret });
    } catch (err) {
      const e = err as Error & { network?: boolean; httpStatus?: number };
      if (e.network) throw new WorkstationOfflineError(this.ws.name, e.message);
      if (e.httpStatus === 401 || e.httpStatus === 403) {
        throw new WorkstationOfflineError(this.ws.name, `the connector refused the hub (${e.message}). Re-enable the connector on that PC so it registers again`);
      }
      if (e.name === "BrowseError") throw new BrowseError(e.message);
      throw e;
    }
  }

  private host<T>(method: RemoteHostMethod, ...args: unknown[]): Promise<T> {
    return this.call<{ result: T }>(`/v1/host/${method}`, { args }, HOST_CALL_TIMEOUT_MS[method] ?? DEFAULT_HOST_TIMEOUT_MS).then((r) => r.result);
  }

  createRequestProcessor(): QBRequestProcessor {
    return new RemoteRequestProcessor(this);
  }

  isQuickBooksRunning = () => this.host<boolean>("isQuickBooksRunning");
  resolveExe = () => this.host<Awaited<ReturnType<QBHost["resolveExe"]>>>("resolveExe");
  launch = (exe: string, companyFile: string) => this.host<void>("launch", exe, companyFile);
  closeGracefully = () => this.host<Awaited<ReturnType<QBHost["closeGracefully"]>>>("closeGracefully");
  forceClose = () => this.host<boolean>("forceClose");
  health = (opts?: { fresh?: boolean }) => this.host<Awaited<ReturnType<QBHost["health"]>>>("health", opts ?? {});
  fileExists = (p: string) => this.host<boolean>("fileExists", p);
  findCompanyFiles = (root: string, depth: number) => this.host<Awaited<ReturnType<QBHost["findCompanyFiles"]>>>("findCompanyFiles", root, depth);
  listDrives = () => this.host<Awaited<ReturnType<QBHost["listDrives"]>>>("listDrives");
  browse = (dir: string) => this.host<Awaited<ReturnType<QBHost["browse"]>>>("browse", dir);
  hasSavedLogin = (companyFile: string) => this.hasLogin(companyFile);

  async startLoginAutofill(companyFile: string): Promise<LoginAutofillHandle | null> {
    const login = await this.loginFor(companyFile);
    if (!login || !login.username) return null;
    const { id } = await this.call<{ id: string | null }>(
      "/v1/autofill/start",
      { companyFile, username: login.username, password: login.password },
      DEFAULT_HOST_TIMEOUT_MS,
    );
    if (!id) return null;
    let cancelled = false;
    const result = (async (): Promise<LoginAutofillResult> => {
      for (;;) {
        if (cancelled) return { status: "cancelled" };
        try {
          const r = await this.call<{ done: boolean; result?: LoginAutofillResult }>(
            "/v1/autofill/result", { id, waitMs: AUTOFILL_POLL_WAIT_MS }, AUTOFILL_POLL_WAIT_MS + MARGIN_MS,
          );
          if (r.done && r.result) return r.result;
        } catch (err) {
          return { status: "error", detail: (err as Error).message };
        }
      }
    })();
    return {
      result,
      cancel: () => {
        cancelled = true;
        void this.call("/v1/autofill/cancel", { id }, DEFAULT_HOST_TIMEOUT_MS).catch(() => undefined);
      },
    };
  }
}

/**
 * QBXMLRP2 on the workstation, one COM helper per live session. The handle
 * is opened on the connector at the first OpenConnection2 and released on
 * dispose(), mirroring WorkerRequestProcessor.
 */
class RemoteRequestProcessor implements QBRequestProcessor {
  private id: string | null = null;

  constructor(private readonly host: RemoteQBHost) {}

  private async op(op: ComOp, args: unknown[]): Promise<unknown> {
    if (!this.id) {
      const r = await this.host.call<{ id: string }>("/v1/com/open", {}, DEFAULT_HOST_TIMEOUT_MS);
      this.id = r.id;
    }
    const r = await this.host.call<{ result: unknown }>("/v1/com/call", { id: this.id, op, args }, COM_CALL_TIMEOUTS[op]);
    return r.result;
  }

  OpenConnection2(appId: string, appName: string, connectionType: number) { return this.op("OpenConnection2", [appId, appName, connectionType]); }
  BeginSession(companyFile: string, fileMode: number) { return this.op("BeginSession", [companyFile, fileMode]); }
  ProcessRequest(ticket: string, xml: string) { return this.op("ProcessRequest", [ticket, xml]); }
  EndSession(ticket: string) { return this.op("EndSession", [ticket]); }
  CloseConnection() { return this.op("CloseConnection", []); }

  dispose(): void {
    const id = this.id;
    this.id = null;
    if (id) void this.host.call("/v1/com/dispose", { id }, DEFAULT_HOST_TIMEOUT_MS).catch(() => undefined);
  }
}
