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
import type { WorkstationRegistry } from "./workstations.js";

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

  /** What each workstation's session has open, for the page (no secrets). */
  describe(id: string): { connected: boolean; companyFile: string } | null {
    const m = this.managers.get(id);
    if (!m) return null;
    return { connected: m.getSession() !== null, companyFile: m.getCompanyFile() };
  }
}
