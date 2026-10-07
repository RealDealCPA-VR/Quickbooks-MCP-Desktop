/**
 * Import a workstation's saved logins into the hub vault (migration from
 * the everything-on-one-PC setup; docs/CONNECTOR_DESIGN.md).
 *
 * Passwords are re-encrypted with the hub's key. The file's existing
 * device grants come along, and the source workstation itself is granted
 * each imported file: agents on that PC used to be "this computer"
 * (unrestricted) and now reach the hub as a tailnet device.
 */

import { RemoteQBHost } from "../session/remote-host.js";
import type { ExportedLogin } from "../connector/login-export.js";
import {
  addAuthorizedPeer,
  upsertLogin,
  validateCompanyFilePath,
  type PasswordProtector,
} from "../util/qb-credentials.js";
import type { WorkstationRegistry } from "./workstations.js";

export interface ImportResult {
  workstation: string;
  logins: number;
  grants: number;
  skipped: Array<{ companyFile: string; reason: string }>;
}

export async function importWorkstationLogins(
  registry: WorkstationRegistry,
  workstationId: string,
  opts: { vaultPath: string; protect: PasswordProtector },
): Promise<ImportResult> {
  const ws = registry.get(workstationId);
  if (!ws) throw new Error("Unknown workstation.");
  const remote = new RemoteQBHost(ws, async () => null, async () => false);
  const { logins } = await remote.call<{ logins: ExportedLogin[] }>("/v1/logins/export", {}, 120_000);

  const result: ImportResult = { workstation: ws.name, logins: 0, grants: 0, skipped: [] };
  for (const l of logins) {
    try {
      validateCompanyFilePath(l.companyFile);
    } catch (err) {
      result.skipped.push({ companyFile: l.companyFile, reason: (err as Error).message });
      continue;
    }
    if (l.username) {
      if (l.unreadable) result.skipped.push({ companyFile: l.companyFile, reason: "Saved password couldn't be read on that PC; the user name was imported, so enter the password on the control page." });
      await upsertLogin(
        { companyFile: l.companyFile, username: l.username, password: l.password },
        { vaultPath: opts.vaultPath, protect: opts.protect },
      );
      result.logins++;
    }
    const peers = [
      ...l.authorizedPeers,
      { address: ws.address, nodeId: ws.id.startsWith("local:") ? undefined : ws.id, nodeName: ws.name, loginName: undefined },
    ];
    for (const p of peers) {
      if (!p.address || p.address === "127.0.0.1") continue;
      await addAuthorizedPeer(
        l.companyFile,
        { address: p.address, ...(p.nodeId ? { nodeId: p.nodeId } : {}), ...(p.nodeName ? { nodeName: p.nodeName } : {}), ...(p.loginName ? { loginName: p.loginName } : {}) },
        { vaultPath: opts.vaultPath },
      );
      result.grants++;
    }
  }
  return result;
}
