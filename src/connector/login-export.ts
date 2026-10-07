/**
 * One-time import of a workstation's saved logins into the hub vault
 * (docs/CONNECTOR_DESIGN.md, migration).
 *
 * Before the hub existed, each QuickBooks PC kept its own credentials.json
 * with DPAPI-encrypted passwords that only that PC + Windows account can
 * read. The connector decrypts them here (scripts/qb-dpapi-unprotect.ps1)
 * and hands them to the hub, which re-encrypts them with its own key.
 * Company-file paths on mapped drives are reported as UNC paths.
 */

import { spawn } from "node:child_process";

import {
  getCredentialsFilePath,
  readStore,
  resolveScriptPath,
  type AuthorizedPeer,
} from "../util/qb-credentials.js";
import { toUncPath, type DriveEntry } from "../util/fs-browse.js";

export interface ExportedLogin {
  companyFile: string;
  username: string;
  /** Plaintext. Empty when none was saved, or when this account couldn't decrypt it (see `unreadable`). */
  password: string;
  unreadable?: boolean;
  authorizedPeers: AuthorizedPeer[];
}

export type LoginExporter = () => Promise<ExportedLogin[]>;

/** Decrypt DPAPI blobs in one PowerShell run; "" for any blob this account can't read. */
export function unprotectPasswords(blobs: string[]): Promise<string[]> {
  if (!blobs.length) return Promise.resolve([]);
  if (process.platform !== "win32") return Promise.reject(new Error("Reading saved QuickBooks passwords requires Windows (DPAPI)."));
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolveScriptPath("qb-dpapi-unprotect.ps1")],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", reject);
    child.on("close", (code) => {
      const lines = stdout.split(/\r?\n/).slice(0, blobs.length);
      if (code !== 0 || lines.length !== blobs.length) {
        reject(new Error(`Could not read the saved passwords: ${stderr.trim() || `exit ${code}`}`));
        return;
      }
      resolve(lines.map((l) => (l.trim() ? Buffer.from(l.trim(), "base64").toString("utf8") : "")));
    });
    child.stdin.end(blobs.join("\n") + "\n\n");
  });
}

export function makeLoginExporter(opts: {
  listDrives: () => Promise<DriveEntry[]>;
  vaultPath?: string;
  unprotect?: (blobs: string[]) => Promise<string[]>;
}): LoginExporter {
  return async () => {
    const entries = readStore(opts.vaultPath ?? getCredentialsFilePath()).entries;
    let drives: DriveEntry[] = [];
    try { drives = await opts.listDrives(); } catch { /* keep paths as saved */ }
    const withPw = entries.filter((e) => e.password);
    const plains = await (opts.unprotect ?? unprotectPasswords)(withPw.map((e) => e.password));
    const byFile = new Map(withPw.map((e, i) => [e, plains[i] ?? ""]));
    return entries.map((e) => {
      const password = byFile.get(e) ?? "";
      return {
        companyFile: toUncPath(e.companyFile, drives),
        username: e.username,
        password,
        ...(e.password && !password ? { unreadable: true } : {}),
        authorizedPeers: e.authorizedPeers,
      };
    });
  };
}
