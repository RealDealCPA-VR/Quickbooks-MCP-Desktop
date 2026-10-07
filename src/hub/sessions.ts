/**
 * One QuickBooks session per workstation, and which one a caller uses
 * (docs/CONNECTOR_DESIGN.md, Phase 4 / #112).
 *
 * Each workstation runs its own QuickBooks, so the hub keeps a separate
 * QBSessionManager (open file, idempotency keys, lookup cache) per
 * workstation. Routing:
 *   - an agent on a workstation that is online uses that workstation's
 *     QuickBooks (its own PC);
 *   - everyone else (other devices, this hub, the control page) uses the
 *     default workstation: the one chosen on the page, else the only one
 *     online.
 */

import { QBSessionManager } from "../session/manager.js";
import type { QBConnectionConfig } from "../types/qbxml.js";
import type { CallerIdentity } from "../util/caller-authorization.js";
import { HubHost, type HubHostOptions } from "./hub-host.js";
import type { WorkstationRecord, WorkstationRegistry } from "./workstations.js";
import { normalizeCompanyPath } from "../util/qb-credentials.js";

/** Where a company file is (probably) open, to explain a 9008 lock. */
export interface FileHolder {
  workstation: string;
  /** "session": a hub session on that workstation has exactly this file open. "title": QuickBooks there shows a matching company. */
  evidence: "session" | "title";
}

/**
 * One agent connection's view of the workstations: which one it uses, and
 * an explicit choice that sticks for that connection (qb_company_open's
 * `workstation`, qb_workstation_use). Other agents are unaffected.
 */
export interface WorkstationContext {
  /** Pin this connection to a workstation by name or id; "default"/"auto" clears the pin. */
  use(nameOrId: string): { id: string | null; name: string | null; pinned: boolean };
  current(): { id: string | null; name: string | null; pinned: boolean; online: boolean };
  list(): Array<{ id: string; name: string; online: boolean; isDefault: boolean; usedByYou: boolean; ownPc: boolean; openCompanyFile: string | null }>;
  findHolder(companyFile: string): Promise<FileHolder | null>;
  /** The session this connection's tools use. */
  session(): QBSessionManager;
}

export class WorkstationChoiceError extends Error {
  readonly statusCode = 9012;
  readonly reason = "unknown-workstation";
  constructor(message: string) {
    super(message);
    this.name = "WorkstationChoiceError";
  }
}

/** Loose company-name match for QuickBooks' title bar vs a file name ("Acme Bakery LLC" ~ "Acme Bakery LLC.qbw"). */
function looseName(s: string): string {
  return s.toLowerCase().replace(/\.qbw$/, "").replace(/[^a-z0-9]+/g, "");
}

export class HubSessions {
  private managers = new Map<string, QBSessionManager>();

  constructor(
    private readonly registry: WorkstationRegistry,
    private readonly config: QBConnectionConfig,
    private readonly hostOptions: Omit<HubHostOptions, "pin"> = {},
  ) {}

  /** The session manager for one workstation (null = none available: every call is 9012). */
  forWorkstation(id: string | null): QBSessionManager {
    const key = id ?? "";
    let m = this.managers.get(key);
    if (!m) {
      // Copy the config: a manager rewrites companyFile when it switches files.
      m = new QBSessionManager({ ...this.config }, new HubHost(this.registry, { ...this.hostOptions, pin: id }));
      this.managers.set(key, m);
    }
    return m;
  }

  /** Which workstation a caller's QuickBooks requests go to. */
  routeFor(identity: CallerIdentity): string | null {
    if (identity.kind === "tailnet") {
      const own = this.registry.get(identity.nodeId);
      if (own && this.registry.isOnline(own)) return own.id;
    }
    return this.registry.active()?.id ?? null;
  }

  /** Resolved on every call, so a workstation coming online is picked up immediately. */
  forCaller(identity: CallerIdentity): QBSessionManager {
    return this.forWorkstation(this.routeFor(identity));
  }

  /** The control page acts on the default workstation. */
  forPage(): QBSessionManager {
    return this.forWorkstation(this.registry.active()?.id ?? null);
  }

  private resolve(nameOrId: string): WorkstationRecord {
    const q = nameOrId.trim().toLowerCase();
    const all = this.registry.list();
    const hit = all.find((w) => w.id.toLowerCase() === q) ?? all.find((w) => w.name.toLowerCase() === q);
    if (!hit) {
      const names = all.map((w) => `${w.name}${w.online ? "" : " (offline)"}`).join(", ") || "none";
      throw new WorkstationChoiceError(`No workstation named "${nameOrId}". Workstations: ${names}. Use qb_workstation_list.`);
    }
    return this.registry.get(hit.id)!;
  }

  /**
   * Find where a company file is open, to tell an agent who holds a 9008
   * lock: first the hub's own sessions (exact path), then QuickBooks' title
   * bar on each other online workstation (company name ~ file name).
   */
  async findHolder(companyFile: string, exceptId: string | null): Promise<FileHolder | null> {
    const key = normalizeCompanyPath(companyFile);
    for (const [id, m] of this.managers) {
      if (!id || id === exceptId || !m.getSession()) continue;
      if (normalizeCompanyPath(m.getCompanyFile()) === key) {
        const ws = this.registry.get(id);
        if (ws) return { workstation: ws.name, evidence: "session" };
      }
    }
    const fileName = looseName(companyFile.split(/[\\/]/).pop() ?? "");
    if (!fileName) return null;
    const others = this.registry.list().filter((w) => w.online && w.id !== exceptId);
    const titles = await Promise.all(others.map(async (w) => {
      try {
        const h = await this.forWorkstation(w.id).getHost().health({ fresh: true });
        return { name: w.name, title: h.openCompanyTitle ?? "" };
      } catch {
        return { name: w.name, title: "" };
      }
    }));
    const hit = titles.find((t) => {
      const title = looseName(t.title);
      return !!title && (title.includes(fileName) || fileName.includes(title));
    });
    return hit ? { workstation: hit.name, evidence: "title" } : null;
  }

  /** A per-connection view; `pinned` lives as long as the agent's MCP connection. */
  contextFor(identity: CallerIdentity): WorkstationContext {
    let pinned: string | null = null;
    const routed = () => pinned ?? this.routeFor(identity);
    const ctx: WorkstationContext = {
      use: (nameOrId) => {
        const q = nameOrId.trim().toLowerCase();
        if (q === "default" || q === "auto" || q === "") {
          pinned = null;
          const id = routed();
          return { id, name: id ? this.registry.get(id)?.name ?? null : null, pinned: false };
        }
        const ws = this.resolve(nameOrId);
        pinned = ws.id;
        return { id: ws.id, name: ws.name, pinned: true };
      },
      current: () => {
        const id = routed();
        const ws = id ? this.registry.get(id) : null;
        return { id, name: ws?.name ?? null, pinned: pinned !== null, online: !!ws && this.registry.isOnline(ws) };
      },
      list: () => {
        const usedId = routed();
        const ownId = identity.kind === "tailnet" ? identity.nodeId : null;
        return this.registry.list().map((w) => ({
          id: w.id,
          name: w.name,
          online: w.online,
          isDefault: w.active,
          usedByYou: w.id === usedId,
          ownPc: w.id === ownId,
          openCompanyFile: this.describe(w.id)?.connected ? this.describe(w.id)!.companyFile || null : null,
        }));
      },
      findHolder: (companyFile) => this.findHolder(companyFile, routed()),
      session: () => this.forWorkstation(routed()),
    };
    return ctx;
  }

  /** What each workstation's session has open, for the page (no secrets). */
  describe(id: string): { connected: boolean; companyFile: string } | null {
    const m = this.managers.get(id);
    if (!m) return null;
    return { connected: m.getSession() !== null, companyFile: m.getCompanyFile() };
  }
}
