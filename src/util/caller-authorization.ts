/**
 * Per-caller, per-company-file authorization for the MCP tool surface.
 *
 * Callers:
 *   - "local": the MCP host on this machine (stdio), or an HTTP request from
 *     loopback or from this machine's own tailnet address. Unrestricted,
 *     because it is the operator's own machine and session.
 *   - "tailnet": an agent on another tailnet device that reached the HTTP
 *     MCP endpoint. It may use a company file only if that file's entry in
 *     the credential store lists the caller's tailnet address (pinned to the
 *     node's StableID when known). The operator grants this on the web page.
 *
 * Enforcement is a wrapper around every tool handler, installed per MCP
 * server instance (one instance per HTTP session), so no tool file has to
 * know about callers. One QB session is shared by every caller, so a
 * remote call is checked against the company file that is active at that
 * moment, not just against the file it last opened.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import {
  getCredentialsFilePath,
  normalizeCompanyPath,
  readStore,
  type AuthorizedPeer,
} from "./qb-credentials.js";
import { normalizeIp, type TailnetIdentity } from "./tailnet.js";
import { recordActivity } from "./activity-log.js";

export type CallerIdentity =
  | { kind: "local"; via: "stdio" | "loopback" | "self-tailnet" }
  | ({ kind: "tailnet" } & TailnetIdentity);

export const LOCAL_STDIO_CALLER: CallerIdentity = { kind: "local", via: "stdio" };

/** Synthetic statusCode for "caller not authorized for this company file". */
export const NOT_AUTHORIZED_STATUS = 9009;

export function describeCaller(id: CallerIdentity): string {
  if (id.kind === "local") return `local (${id.via})`;
  return `${id.nodeName} ${id.address}${id.loginName ? ` (${id.loginName})` : ""}`;
}

/** Address must match; when the authorization pinned a node, the node must match too. */
export function peerMatches(peer: AuthorizedPeer, id: TailnetIdentity): boolean {
  if (normalizeIp(peer.address) !== normalizeIp(id.address)) return false;
  if (peer.nodeId && peer.nodeId !== id.nodeId) return false;
  return true;
}

/**
 * Normalized paths of every company file `id` may use, or "all" for local
 * callers. Reads the store fresh, so changes made on the web page apply to
 * the very next call.
 */
export function authorizedCompanyFiles(
  id: CallerIdentity,
  vaultPath: string = getCredentialsFilePath(),
): Set<string> | "all" {
  if (id.kind === "local") return "all";
  const out = new Set<string>();
  let entries;
  try {
    entries = readStore(vaultPath).entries;
  } catch {
    return out; // unreadable store → remote callers get nothing
  }
  for (const e of entries) {
    if (e.authorizedPeers.some((p) => peerMatches(p, id))) out.add(normalizeCompanyPath(e.companyFile));
  }
  return out;
}

export function isCompanyFileAuthorized(
  id: CallerIdentity,
  companyFile: string,
  vaultPath: string = getCredentialsFilePath(),
): boolean {
  const allowed = authorizedCompanyFiles(id, vaultPath);
  if (allowed === "all") return true;
  if (!companyFile || !companyFile.trim()) return false;
  return allowed.has(normalizeCompanyPath(companyFile));
}

export type AuthDecision = { ok: true } | { ok: false; companyFile: string; reason: string };

/** Tools a remote caller may always call; any company data they return is filtered. */
const ALWAYS_ALLOWED = new Set([
  "qb_session_status",
  "qb_company_list",
  "qb_company_credentials_list",
  "qb_company_credentials_edit",
  // Hub: routing only, no books data (another workstation's open file is filtered in the tool).
  "qb_workstation_list",
  "qb_workstation_use",
]);

export function authorizeToolCall(
  toolName: string,
  args: unknown,
  id: CallerIdentity,
  activeCompanyFile: string,
  vaultPath: string = getCredentialsFilePath(),
): AuthDecision {
  if (id.kind === "local" || ALWAYS_ALLOWED.has(toolName)) return { ok: true };
  if (toolName === "qb_company_open") {
    const target = String((args as { companyFile?: unknown } | undefined)?.companyFile ?? "");
    return isCompanyFileAuthorized(id, target, vaultPath)
      ? { ok: true }
      : { ok: false, companyFile: target, reason: "This device is not authorized to open that company file." };
  }
  if (!activeCompanyFile.trim()) {
    return {
      ok: false,
      companyFile: "",
      reason: "No specific company file is selected on the server. Call qb_company_open with a company file this device is authorized for.",
    };
  }
  return isCompanyFileAuthorized(id, activeCompanyFile, vaultPath)
    ? { ok: true }
    : { ok: false, companyFile: activeCompanyFile, reason: "This device is not authorized for the company file that is currently open on the server." };
}

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean; [k: string]: unknown };

function deniedResult(id: CallerIdentity, decision: Extract<AuthDecision, { ok: false }>, adminUrl: string | null): ToolResult {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        success: false,
        statusCode: NOT_AUTHORIZED_STATUS,
        statusMessage: decision.reason,
        caller: id.kind === "tailnet"
          ? { address: id.address, nodeName: id.nodeName, loginName: id.loginName }
          : { kind: "local" },
        ...(decision.companyFile ? { companyFile: decision.companyFile } : {}),
        howToFix:
          "Ask the operator to authorize this device for the company file on the QuickBooks MCP web page" +
          (adminUrl ? ` (${adminUrl})` : "") +
          ". Use qb_company_list to see the files this device may use.",
      }),
    }],
    isError: true,
  };
}

/** Narrow company-listing tool output to the caller's authorized files. */
function filterResult(toolName: string, result: ToolResult, allowed: Set<string>): ToolResult {
  if (toolName !== "qb_company_list" && toolName !== "qb_company_credentials_list") return result;
  const first = result.content?.[0];
  if (!first || typeof first.text !== "string") return result;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(first.text);
  } catch {
    return result;
  }
  const key = toolName === "qb_company_list" ? "companies" : "savedLogins";
  const rows = body[key];
  if (!Array.isArray(rows)) return result;
  const kept = rows.filter((r) => {
    const f = (r as { companyFile?: unknown }).companyFile;
    return typeof f === "string" && allowed.has(normalizeCompanyPath(f));
  });
  body[key] = kept;
  if (typeof body.count === "number") body.count = kept.length;
  body.filteredToAuthorizedFiles = true;
  return { ...result, content: [{ ...first, text: JSON.stringify(body, null, 2) }, ...result.content.slice(1)] };
}

/**
 * Wrap every tool registered on `server` AFTER this call with the
 * authorization check for `id`. A no-op for local callers. Call it before
 * any register*Tools(server, ...).
 */
export function installAuthorizationGuard(
  server: McpServer,
  id: CallerIdentity,
  getSession: () => QBSessionManager,
  opts: { vaultPath?: () => string; adminUrl?: () => string | null } = {},
): void {
  if (id.kind === "local") return;
  const vaultPath = opts.vaultPath ?? (() => getCredentialsFilePath());
  const adminUrl = opts.adminUrl ?? (() => null);
  const original = server.tool.bind(server) as (...a: unknown[]) => unknown;
  (server as unknown as { tool: (...a: unknown[]) => unknown }).tool = (...a: unknown[]) => {
    const name = String(a[0]);
    const handlerIdx = a.length - 1;
    const handler = a[handlerIdx];
    if (typeof handler !== "function") return original(...a);
    a[handlerIdx] = async (...hargs: unknown[]) => {
      const vp = vaultPath();
      const decision = authorizeToolCall(name, hargs[0], id, getSession().getCompanyFile(), vp);
      if (!decision.ok) {
        recordActivity({
          level: "warn",
          category: "agent",
          message: `Refused ${name} from ${describeCaller(id)}: not authorized${decision.companyFile ? ` for ${decision.companyFile.split(/[\\/]/).pop()}` : ""}`,
          ...(decision.companyFile ? { companyFile: decision.companyFile } : {}),
        });
        return deniedResult(id, decision, adminUrl());
      }
      const result = (await (handler as (...x: unknown[]) => Promise<ToolResult>)(...hargs)) as ToolResult;
      const allowed = authorizedCompanyFiles(id, vp);
      return allowed === "all" ? result : filterResult(name, result, allowed);
    };
    return original(...a);
  };
}
