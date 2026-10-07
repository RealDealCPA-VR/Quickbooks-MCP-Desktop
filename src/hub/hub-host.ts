/**
 * HubHost: the QBHost the hub's session manager uses (docs/CONNECTOR_DESIGN.md).
 *
 * It forwards every call to the active workstation's connector (a
 * RemoteQBHost), picked from the WorkstationRegistry at call time, so
 * choosing another workstation on the control page takes effect on the
 * next request. Saved logins live on the hub (hub-vault.ts) and are handed
 * to a connector only for one autofill.
 *
 * With no workstation available, every QuickBooks call fails with a clear
 * 9012 message, and health reports "no workstation" instead of throwing.
 */

import type { QBRequestProcessor } from "../session/com-worker-client.js";
import type { QBHost } from "../session/qb-host.js";
import { RemoteQBHost } from "../session/remote-host.js";
import { WorkstationOfflineError } from "../connector/protocol.js";
import { getCredentialsFilePath, normalizeCompanyPath, readStore } from "../util/qb-credentials.js";
import { getHubKeyPath, hubDecrypt, loadOrCreateHubKey } from "../util/hub-vault.js";
import type { QBHealth } from "../util/qb-health.js";
import type { WorkstationRecord, WorkstationRegistry } from "./workstations.js";

export class NoWorkstationError extends Error {
  readonly statusCode = 9012;
  readonly reason = "no-workstation";
  readonly recommendedAction =
    "Enable the QuickBooks connector on a workstation (control page → Workstations), or pick one there if several are online.";
  constructor() {
    super("No QuickBooks workstation is available to the hub.");
    this.name = "NoWorkstationError";
  }
}

export interface HubHostOptions {
  vaultPath?: () => string;
  keyPath?: () => string;
  /**
   * Bind this host to one workstation (one QuickBooks session per
   * workstation, see hub/sessions.ts). Undefined = follow the registry's
   * active workstation; null = no workstation (every call is 9012).
   */
  pin?: string | null;
}

export class HubHost implements QBHost {
  private cache = new Map<string, { key: string; host: RemoteQBHost }>();

  constructor(private readonly registry: WorkstationRegistry, private readonly opts: HubHostOptions = {}) {}

  private target(): WorkstationRecord | null {
    if (this.opts.pin === undefined) return this.registry.active();
    return this.opts.pin === null ? null : this.registry.get(this.opts.pin);
  }

  get label(): string {
    return this.target()?.name ?? "no workstation";
  }

  private vaultPath(): string {
    return this.opts.vaultPath?.() ?? getCredentialsFilePath();
  }

  private entryFor(companyFile: string) {
    const key = normalizeCompanyPath(companyFile);
    try {
      return readStore(this.vaultPath()).entries.find((e) => normalizeCompanyPath(e.companyFile) === key) ?? null;
    } catch {
      return null;
    }
  }

  private remoteFor(ws: WorkstationRecord): RemoteQBHost {
    const key = `${ws.address}|${ws.port}|${ws.secret}`;
    const hit = this.cache.get(ws.id);
    if (hit && hit.key === key) return hit.host;
    const host = new RemoteQBHost(
      ws,
      async (companyFile) => {
        const e = this.entryFor(companyFile);
        if (!e || !e.username) return null;
        const password = e.password ? hubDecrypt(e.password, loadOrCreateHubKey(this.opts.keyPath?.() ?? getHubKeyPath())) : "";
        return { username: e.username, password };
      },
      async (companyFile) => this.hasSavedLogin(companyFile),
    );
    this.cache.set(ws.id, { key, host });
    return host;
  }

  /** The active workstation's host, or NoWorkstationError. */
  current(): RemoteQBHost {
    const ws = this.target();
    if (!ws) throw new NoWorkstationError();
    return this.remoteFor(ws);
  }

  createRequestProcessor(): QBRequestProcessor {
    return this.current().createRequestProcessor();
  }
  // async so "no workstation" is a rejected promise, never a synchronous throw.
  async isQuickBooksRunning() { return this.current().isQuickBooksRunning(); }
  async resolveExe() { return this.current().resolveExe(); }
  async launch(exe: string, companyFile: string) { return this.current().launch(exe, companyFile); }
  async closeGracefully() { return this.current().closeGracefully(); }
  async forceClose() { return this.current().forceClose(); }
  async fileExists(p: string) { return this.current().fileExists(p); }
  async findCompanyFiles(root: string, depth: number) { return this.current().findCompanyFiles(root, depth); }
  async listDrives() { return this.current().listDrives(); }
  async browse(dir: string) { return this.current().browse(dir); }
  async startLoginAutofill(companyFile: string) { return this.current().startLoginAutofill(companyFile); }

  async hasSavedLogin(companyFile: string): Promise<boolean> {
    return !!this.entryFor(companyFile)?.username;
  }

  async health(opts?: { fresh?: boolean }): Promise<QBHealth> {
    const base = { checkedAt: new Date().toISOString(), dialogs: [] as string[] };
    let host: RemoteQBHost;
    try {
      host = this.current();
    } catch (err) {
      const e = err as NoWorkstationError;
      return { ...base, state: "unsupported", summary: e.message, recommendedAction: e.recommendedAction, raw: { ok: false, error: e.message, quickbooks: [], fileDoctor: [], crashReporter: [] } };
    }
    try {
      return await host.health(opts);
    } catch (err) {
      const msg = (err as Error).message;
      const action = err instanceof WorkstationOfflineError ? err.recommendedAction : "Check the workstation's QuickBooks connector.";
      return { ...base, state: "unsupported", summary: msg, recommendedAction: action, raw: { ok: false, error: msg, quickbooks: [], fileDoctor: [], crashReporter: [] } };
    }
  }
}
