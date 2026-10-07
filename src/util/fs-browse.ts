/**
 * Drive + folder browsing for the control page's company-file picker (#108).
 *
 * Read-only and deliberately narrow: a listing returns sub-folders and .qbw
 * files only, never any other file name or any file content. Served only to
 * page admins (see src/web/server.ts), the same people who can already add
 * logins and grant access.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface DriveEntry {
  /** Root path to browse, e.g. "C:\\" (or "/" off Windows). */
  path: string;
  /** Volume label, or "" when the drive has none or isn't ready. */
  label: string;
  kind: "fixed" | "network" | "removable" | "cdrom" | "other";
  /** False for an empty card reader / disc drive or a disconnected network drive. */
  ready: boolean;
  /** For a mapped network drive: the share it points to, e.g. "\\\\fileserver\\books". */
  unc?: string;
}

export interface BrowseListing {
  path: string;
  /** Null at a drive root (the page then offers the drive list). */
  parent: string | null;
  folders: Array<{ name: string; path: string }>;
  files: Array<{ name: string; path: string; sizeBytes: number; modifiedAt: string }>;
  /** True when a cap below cut the listing short. */
  truncated: boolean;
}

export type DriveLister = () => Promise<DriveEntry[]>;

export class BrowseError extends Error {}

export const MAX_BROWSE_FOLDERS = 1000;
export const MAX_BROWSE_FILES = 500;
const DRIVE_LIST_TIMEOUT_MS = 8000;

/** Folders Windows keeps at drive roots that never hold company files. */
const HIDDEN_FOLDERS = new Set(["system volume information", "recovery", "config.msi"]);

// One line per drive: "C:\|Fixed|True||Windows", or for a mapped drive
// "Q:\|Network|True|\\fileserver\books|Books". Pure ASCII (PowerShell 5.1).
// The UNC root comes from Get-PSDrive's DisplayRoot (no admin needed). A
// disconnected network drive can stall IsReady, hence the outer time limit.
const PS_LIST_DRIVES =
  "[System.IO.DriveInfo]::GetDrives() | ForEach-Object { " +
  "$l = ''; $r = $false; $u = ''; try { $r = $_.IsReady; if ($r) { $l = $_.VolumeLabel } } catch {} ; " +
  "try { $u = (Get-PSDrive -Name $_.Name.Substring(0,1) -ErrorAction Stop).DisplayRoot } catch {} ; " +
  "'{0}|{1}|{2}|{3}|{4}' -f $_.Name, $_.DriveType, $r, $u, $l }";

export function parseDriveLines(out: string): DriveEntry[] {
  const kinds: Record<string, DriveEntry["kind"]> = {
    fixed: "fixed", network: "network", removable: "removable", cdrom: "cdrom",
  };
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z]:\\\|/.test(line))
    .map((line) => {
      const [root, type, ready, unc, ...label] = line.split("|");
      const share = (unc ?? "").trim().replace(/\\+$/, "");
      return {
        path: root.toUpperCase(),
        label: label.join("|").trim(),
        kind: kinds[type.trim().toLowerCase()] ?? "other",
        ready: ready.trim().toLowerCase() === "true",
        ...(share.startsWith("\\\\") ? { unc: share } : {}),
      };
    });
}

/**
 * Rewrite a path on a mapped drive to its UNC form ("Q:\\Acme\\Acme.qbw" →
 * "\\\\fileserver\\books\\Acme\\Acme.qbw"). Company files on a file server
 * then have one identity on every workstation, whatever letter each PC
 * mapped. Other paths are returned unchanged.
 */
export function toUncPath(p: string, drives: DriveEntry[]): string {
  const m = /^([A-Za-z]):(?:\\(.*))?$/.exec(String(p ?? "").trim());
  if (!m) return p;
  const d = drives.find((x) => x.unc && x.path.toUpperCase() === `${m[1].toUpperCase()}:\\`);
  if (!d?.unc) return p;
  return m[2] ? `${d.unc}\\${m[2]}` : `${d.unc}\\`;
}

/** Fallback when PowerShell is unavailable: probe C:..Z: (A:/B: are floppy letters). */
async function probeDriveLetters(): Promise<DriveEntry[]> {
  const letters = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const probe = (root: string) =>
    Promise.race([
      fs.access(root).then(() => true, () => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
    ]);
  const found = await Promise.all(letters.map(async (l) => ((await probe(`${l}:\\`)) ? l : null)));
  return found
    .filter((l): l is string => l !== null)
    .map((l) => ({ path: `${l}:\\`, label: "", kind: "other" as const, ready: true }));
}

export const defaultDriveLister: DriveLister = async () => {
  if (process.platform !== "win32") return [{ path: "/", label: "", kind: "fixed", ready: true }];
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", PS_LIST_DRIVES],
        { timeout: DRIVE_LIST_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
      );
    });
    const drives = parseDriveLines(out);
    if (drives.length) return drives;
  } catch { /* fall through to probing */ }
  return probeDriveLetters();
};

/** Sub-folders and .qbw files of `dir`, both sorted by name. */
export async function browseDirectory(dir: string): Promise<BrowseListing> {
  const raw = String(dir ?? "").trim();
  if (!raw || !path.isAbsolute(raw)) throw new BrowseError("Use a full folder path, e.g. C:\\Clients.");
  // "C:" alone means "current dir on C:" to Windows; treat it as the drive root.
  const target = path.resolve(/^[A-Za-z]:$/.test(raw) ? `${raw}\\` : raw);

  let entries;
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new BrowseError(`Folder not found: ${target}`);
    if (code === "ENOTDIR") throw new BrowseError(`Not a folder: ${target}`);
    if (code === "EPERM" || code === "EACCES") throw new BrowseError(`Windows won't let the server read ${target}.`);
    if (code === "EBUSY" || code === "EIO" || code === "UNKNOWN") throw new BrowseError(`${target} isn't ready (empty drive or disconnected network drive?).`);
    throw new BrowseError(`Can't open ${target}: ${(err as Error).message}`);
  }

  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  const folders = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("$") && !e.name.startsWith(".") && !HIDDEN_FOLDERS.has(e.name.toLowerCase()))
    .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
    .sort(byName);
  const qbw = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".qbw"));

  const files: BrowseListing["files"] = [];
  for (const e of qbw.slice(0, MAX_BROWSE_FILES)) {
    const full = path.join(target, e.name);
    try {
      const st = await fs.stat(full);
      files.push({ name: e.name, path: full, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() });
    } catch { /* vanished or unreadable: skip */ }
  }
  files.sort(byName);

  const parentDir = path.dirname(target);
  return {
    path: target,
    parent: parentDir === target ? null : parentDir,
    folders: folders.slice(0, MAX_BROWSE_FOLDERS),
    files,
    truncated: folders.length > MAX_BROWSE_FOLDERS || qbw.length > MAX_BROWSE_FILES,
  };
}
