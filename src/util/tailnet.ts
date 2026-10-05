/**
 * Tailscale identity lookups for the local web page + remote MCP endpoint.
 *
 * A remote caller is identified by the tailnet address its TCP connection
 * comes from, confirmed with `tailscale whois`. On a tailnet the source
 * address cannot be spoofed by another node (WireGuard binds each node's
 * key to its addresses), and whois also returns the node's StableID, so a
 * stored authorization can be pinned to "this address AND this node".
 * Then a reassigned address can't inherit another device's access.
 *
 * Everything shells out to the `tailscale` CLI (no new dependency). The
 * runner is injectable so tests never touch a real tailnet.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export interface TailnetIdentity {
  /** The caller's tailnet IP (IPv4 100.x.y.z or fd7a:115c:a1e0::/48). */
  address: string;
  /** Tailscale StableID of the node (e.g. "nXXXXXXXXXXCNTRL"). */
  nodeId: string;
  /** Short machine name (Tailscale ComputedName, e.g. "vr"). */
  nodeName: string;
  /** Owning user's login (e.g. "vr@example.com"); "tagged-devices" for tagged nodes. */
  loginName: string;
  displayName?: string;
  /** MagicDNS name without the trailing dot, when known. */
  dnsName?: string;
  os?: string;
  online?: boolean;
}

/** Runs the tailscale CLI with `args` and resolves its stdout. */
export type TailscaleRunner = (args: string[]) => Promise<string>;

const WINDOWS_TAILSCALE_EXE = "C:\\Program Files\\Tailscale\\tailscale.exe";

export function defaultTailscaleRunner(args: string[]): Promise<string> {
  const candidates = [
    process.env.QB_TAILSCALE_EXE,
    "tailscale",
    process.platform === "win32" && existsSync(WINDOWS_TAILSCALE_EXE) ? WINDOWS_TAILSCALE_EXE : undefined,
  ].filter((c): c is string => !!c && c.trim().length > 0);
  const attempt = (i: number): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(candidates[i], args, { timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (!err) return resolve(String(stdout));
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" && i + 1 < candidates.length) return resolve(attempt(i + 1));
        reject(err);
      });
    });
  return candidates.length ? attempt(0) : Promise.reject(new Error("tailscale CLI not found"));
}

/** Strip an IPv4-mapped IPv6 prefix and any zone id; lower-case. */
export function normalizeIp(ip: string): string {
  let v = ip.trim().toLowerCase();
  if (v.startsWith("::ffff:") && v.includes(".")) v = v.slice(7);
  const pct = v.indexOf("%");
  if (pct >= 0) v = v.slice(0, pct);
  return v;
}

export function isLoopback(ip: string): boolean {
  const v = normalizeIp(ip);
  return v === "::1" || v.startsWith("127.");
}

/** Tailscale's CGNAT range 100.64.0.0/10, or its IPv6 ULA fd7a:115c:a1e0::/48. */
export function isTailnetAddress(ip: string): boolean {
  const v = normalizeIp(ip);
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 100 && b >= 64 && b <= 127;
  }
  return v.startsWith("fd7a:115c:a1e0:");
}

/** This machine's tailnet addresses (`tailscale ip`). [] when Tailscale is absent or down. */
export async function tailnetSelfAddresses(run: TailscaleRunner = defaultTailscaleRunner): Promise<string[]> {
  try {
    const out = await run(["ip"]);
    return out.split(/\s+/).map((s) => s.trim()).filter((s) => s && isTailnetAddress(s)).map(normalizeIp);
  } catch {
    return [];
  }
}

interface WhoisJson {
  Node?: {
    StableID?: string;
    Name?: string;
    ComputedName?: string;
    Addresses?: string[];
    Hostinfo?: { OS?: string; Hostname?: string };
  };
  UserProfile?: { LoginName?: string; DisplayName?: string };
}

const WHOIS_TTL_MS = 60_000;
const whoisCache = new Map<string, { at: number; value: TailnetIdentity | null }>();

/** Test hook: forget cached whois answers. */
export function clearWhoisCache(): void {
  whoisCache.clear();
}

/**
 * Resolve a tailnet address to its node + owner. Null when the address isn't
 * a tailnet address, Tailscale isn't available, or the address belongs to no
 * current node. Cached for 60s per address.
 */
export async function tailnetWhois(
  address: string,
  run: TailscaleRunner = defaultTailscaleRunner,
): Promise<TailnetIdentity | null> {
  const ip = normalizeIp(address);
  if (!isTailnetAddress(ip)) return null;
  const hit = whoisCache.get(ip);
  if (hit && Date.now() - hit.at < WHOIS_TTL_MS) return hit.value;
  let value: TailnetIdentity | null = null;
  try {
    const parsed = JSON.parse(await run(["whois", "--json", ip])) as WhoisJson;
    const node = parsed.Node;
    if (node?.StableID) {
      const dns = node.Name ? node.Name.replace(/\.$/, "") : undefined;
      value = {
        address: ip,
        nodeId: node.StableID,
        nodeName: node.ComputedName || node.Hostinfo?.Hostname || dns?.split(".")[0] || ip,
        loginName: parsed.UserProfile?.LoginName ?? "",
        ...(parsed.UserProfile?.DisplayName ? { displayName: parsed.UserProfile.DisplayName } : {}),
        ...(dns ? { dnsName: dns } : {}),
        ...(node.Hostinfo?.OS ? { os: node.Hostinfo.OS } : {}),
      };
    }
  } catch {
    value = null;
  }
  whoisCache.set(ip, { at: Date.now(), value });
  return value;
}

interface StatusJson {
  Self?: StatusPeer;
  Peer?: Record<string, StatusPeer>;
  User?: Record<string, { LoginName?: string; DisplayName?: string }>;
}
interface StatusPeer {
  ID?: string;
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  UserID?: number;
  OS?: string;
  Online?: boolean;
}

/**
 * Every node on the tailnet (self first), for the web page's
 * "authorize a device" picker. [] when Tailscale is unavailable.
 */
export async function tailnetPeers(run: TailscaleRunner = defaultTailscaleRunner): Promise<TailnetIdentity[]> {
  let parsed: StatusJson;
  try {
    parsed = JSON.parse(await run(["status", "--json"])) as StatusJson;
  } catch {
    return [];
  }
  const users = parsed.User ?? {};
  const toIdentity = (p: StatusPeer, isSelf: boolean): TailnetIdentity | null => {
    const v4 = (p.TailscaleIPs ?? []).find((a) => a.includes(".")) ?? p.TailscaleIPs?.[0];
    if (!p.ID || !v4) return null;
    const user = p.UserID !== undefined ? users[String(p.UserID)] : undefined;
    const dns = p.DNSName ? p.DNSName.replace(/\.$/, "") : undefined;
    return {
      address: normalizeIp(v4),
      nodeId: p.ID,
      nodeName: dns?.split(".")[0] || p.HostName || v4,
      loginName: user?.LoginName ?? "",
      ...(user?.DisplayName ? { displayName: user.DisplayName } : {}),
      ...(dns ? { dnsName: dns } : {}),
      ...(p.OS ? { os: p.OS } : {}),
      online: isSelf ? true : !!p.Online,
    };
  };
  const out: TailnetIdentity[] = [];
  if (parsed.Self) {
    const self = toIdentity(parsed.Self, true);
    if (self) out.push(self);
  }
  for (const p of Object.values(parsed.Peer ?? {})) {
    const id = toIdentity(p, false);
    if (id) out.push(id);
  }
  return out;
}
