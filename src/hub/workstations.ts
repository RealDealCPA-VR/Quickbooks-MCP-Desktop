/**
 * Hub-side registry of QuickBooks workstations (docs/CONNECTOR_DESIGN.md).
 *
 * A workstation appears here when its connector registers with the hub
 * (POST /connector/register, repeated as a heartbeat). The hub only accepts
 * registrations from tailnet devices of its own Tailscale account; the
 * record is pinned to the device's node StableID. Each record carries the
 * secret the hub must present when it calls that connector, so the file is
 * written with mode 600.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getCredentialsFilePath } from "../util/qb-credentials.js";

/** A workstation counts as online if it checked in within this window. */
export const WORKSTATION_ONLINE_MS = 75_000;

export interface WorkstationRecord {
  /** Tailscale node StableID: the stable identity of the device. */
  id: string;
  name: string;
  address: string;
  port: number;
  /** Bearer secret the hub presents to this connector. Never sent to the page. */
  secret: string;
  version: string;
  platform: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface WorkstationSummary extends Omit<WorkstationRecord, "secret"> {
  online: boolean;
  active: boolean;
}

interface RegistryFile {
  version: 1;
  activeId: string | null;
  workstations: WorkstationRecord[];
}

/** $QB_WORKSTATIONS_FILE, else `workstations.json` beside the credential store. */
export function getWorkstationsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.QB_WORKSTATIONS_FILE && env.QB_WORKSTATIONS_FILE.trim()) return env.QB_WORKSTATIONS_FILE;
  return path.join(path.dirname(getCredentialsFilePath(env)), "workstations.json");
}

export class WorkstationRegistry {
  private data: RegistryFile;

  constructor(private readonly filePath: string = getWorkstationsPath(), private readonly now: () => number = Date.now) {
    this.data = this.load();
  }

  private load(): RegistryFile {
    if (!existsSync(this.filePath)) return { version: 1, activeId: null, workstations: [] };
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<RegistryFile>;
    return {
      version: 1,
      activeId: typeof parsed.activeId === "string" ? parsed.activeId : null,
      workstations: Array.isArray(parsed.workstations) ? parsed.workstations : [],
    };
  }

  private save(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.filePath);
    try { chmodSync(this.filePath, 0o600); } catch { /* best effort */ }
  }

  isOnline(w: WorkstationRecord): boolean {
    return this.now() - Date.parse(w.lastSeenAt) < WORKSTATION_ONLINE_MS;
  }

  /** Insert or refresh a workstation from a connector heartbeat. Returns true when it is new. */
  register(rec: Omit<WorkstationRecord, "firstSeenAt" | "lastSeenAt">): boolean {
    const at = new Date(this.now()).toISOString();
    const existing = this.data.workstations.find((w) => w.id === rec.id);
    if (existing) {
      Object.assign(existing, rec, { lastSeenAt: at });
    } else {
      this.data.workstations.push({ ...rec, firstSeenAt: at, lastSeenAt: at });
    }
    this.save();
    return !existing;
  }

  get(id: string): WorkstationRecord | null {
    return this.data.workstations.find((w) => w.id === id) ?? null;
  }

  /**
   * The workstation QuickBooks requests go to: the one chosen on the page,
   * else the only online one. Null when nothing is chosen and zero or
   * several are online (the operator must pick).
   */
  active(): WorkstationRecord | null {
    const chosen = this.data.activeId ? this.get(this.data.activeId) : null;
    if (chosen) return chosen;
    const online = this.data.workstations.filter((w) => this.isOnline(w));
    return online.length === 1 ? online[0] : null;
  }

  setActive(id: string | null): void {
    if (id !== null && !this.get(id)) throw new Error("Unknown workstation.");
    this.data.activeId = id;
    this.save();
  }

  remove(id: string): boolean {
    const before = this.data.workstations.length;
    this.data.workstations = this.data.workstations.filter((w) => w.id !== id);
    if (this.data.activeId === id) this.data.activeId = null;
    this.save();
    return this.data.workstations.length !== before;
  }

  list(): WorkstationSummary[] {
    const activeId = this.active()?.id ?? null;
    return this.data.workstations
      .map(({ secret: _secret, ...w }) => ({ ...w, online: this.isOnline({ ...w, secret: "" }), active: w.id === activeId }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
