/**
 * Company-file login store + QuickBooks login-dialog autofill.
 *
 * QBXMLRP2's BeginSession has no username/password parameters: the SDK
 * authenticates as whichever QB user is logged into the file in the GUI.
 * So "log into file X as user Y" means filling in QB Desktop's own login
 * dialog after launching it with the .qbw. Pieces:
 *
 *   - The STORE (this module): one JSON file on the machine running the
 *     MCP server, holding per-company-file { username, DPAPI-encrypted
 *     password, authorized tailnet peers }. It is re-read on every use, so
 *     edits made on the web page apply at once with no restart.
 *   - The local WEB PAGE (src/web/) is where the operator enters and edits
 *     logins and per-file tailnet authorizations.
 *   - scripts/qb-dpapi-protect.ps1 encrypts a password on save.
 *   - scripts/qb-login-autofill.ps1, after QB is launched with a .qbw,
 *     decrypts that file's password, types it into QB's login window and
 *     presses OK once.
 *
 * Security properties:
 *   - Passwords are encrypted at rest (DPAPI, CurrentUser scope + app
 *     entropy). Only this Windows account on this PC can decrypt them.
 *   - Node never decrypts. It holds plaintext only briefly while the page
 *     saves a new password, and passes it to the protect script over stdin.
 *   - No tool response, web API response or log ever contains a password
 *     or its ciphertext. Agents get { companyFile, username, hasPassword }.
 *
 * Store location: $QB_CREDENTIALS_FILE, else
 * %APPDATA%\quickbooks-desktop-mcp\credentials.json.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeIp } from "./tailnet.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A tailnet device allowed to use a company file through the remote MCP endpoint. */
export interface AuthorizedPeer {
  /** Pinned tailnet address (the caller's connection must come from it). */
  address: string;
  /** Tailscale StableID captured when authorized; a different node at the same address is refused. */
  nodeId?: string;
  nodeName?: string;
  loginName?: string;
  addedAt: string;
}

/** On-disk entry. `password` is a DPAPI blob (base64) or "" — never plaintext. */
export interface StoredEntry {
  companyFile: string;
  username: string;
  password: string;
  updatedAt: string;
  authorizedPeers: AuthorizedPeer[];
}

export interface CredentialStoreData {
  version: 2;
  entries: StoredEntry[];
}

/** What tools / the web page may see about an entry. */
export interface CredentialSummary {
  companyFile: string;
  username: string;
  hasPassword: boolean;
  updatedAt?: string;
  authorizedPeers: AuthorizedPeer[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function getCredentialsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.QB_CREDENTIALS_FILE && env.QB_CREDENTIALS_FILE.trim()) return env.QB_CREDENTIALS_FILE;
  const appData = env.APPDATA && env.APPDATA.trim()
    ? env.APPDATA
    : path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "quickbooks-desktop-mcp", "credentials.json");
}

/** Case-insensitive, fully-resolved key, matching Get-NormalizedPath in the scripts. */
export function normalizeCompanyPath(p: string): string {
  return path.win32.resolve(p).toLowerCase();
}

/** scripts/ sits two levels above both src/util/ and dist/util/. */
export function resolveScriptPath(scriptName: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "scripts", scriptName);
}

// ---------------------------------------------------------------------------
// Store read / write
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Read the whole store. Missing / empty file → empty store. Version-1 files
 * (from the retired popup) load unchanged with no authorizations. Malformed
 * JSON throws, so the operator finds out instead of silently losing every
 * saved login.
 */
export function readStore(vaultPath: string = getCredentialsFilePath()): CredentialStoreData {
  if (!existsSync(vaultPath)) return { version: 2, entries: [] };
  const raw = readFileSync(vaultPath, "utf8").replace(/^\uFEFF/, "");
  if (!raw.trim()) return { version: 2, entries: [] };
  const parsed = JSON.parse(raw) as { entries?: unknown };
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  return {
    version: 2,
    entries: entries
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .map((e) => ({
        companyFile: str(e.companyFile),
        username: str(e.username),
        password: str(e.password),
        updatedAt: str(e.updatedAt),
        authorizedPeers: (Array.isArray(e.authorizedPeers) ? e.authorizedPeers : [])
          .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && typeof p.address === "string")
          .map((p) => ({
            address: normalizeIp(String(p.address)),
            ...(typeof p.nodeId === "string" ? { nodeId: p.nodeId } : {}),
            ...(typeof p.nodeName === "string" ? { nodeName: p.nodeName } : {}),
            ...(typeof p.loginName === "string" ? { loginName: p.loginName } : {}),
            addedAt: str(p.addedAt),
          })),
      }))
      .filter((e) => e.companyFile),
  };
}

/**
 * Replace the store file atomically: write a temp file beside it, then
 * rename over the original, so a crash never leaves a half-written file.
 * Saving a changed login therefore overwrites the old one in place.
 */
export function writeStore(data: CredentialStoreData, vaultPath: string = getCredentialsFilePath()): void {
  mkdirSync(path.dirname(vaultPath), { recursive: true });
  const tmp = `${vaultPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 2, entries: data.entries }, null, 2), { encoding: "utf8" });
  renameSync(tmp, vaultPath);
}

function toSummary(e: StoredEntry): CredentialSummary {
  return {
    companyFile: e.companyFile,
    username: e.username,
    hasPassword: e.password.length > 0,
    ...(e.updatedAt ? { updatedAt: e.updatedAt } : {}),
    authorizedPeers: e.authorizedPeers.map((p) => ({ ...p })),
  };
}

/** Every entry, without secrets. Includes authorization-only entries (empty username). */
export function readCredentialSummaries(vaultPath: string = getCredentialsFilePath()): CredentialSummary[] {
  return readStore(vaultPath).entries.map(toSummary);
}

export function findCredentialSummary(
  companyFile: string,
  vaultPath: string = getCredentialsFilePath(),
): CredentialSummary | null {
  const key = normalizeCompanyPath(companyFile);
  const hit = readStore(vaultPath).entries.find((e) => normalizeCompanyPath(e.companyFile) === key);
  return hit ? toSummary(hit) : null;
}

// ---------------------------------------------------------------------------
// Mutations (used by the web page)
// ---------------------------------------------------------------------------

export class CredentialInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialInputError";
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

export function validateCompanyFilePath(p: string): string {
  const v = (p ?? "").trim();
  if (!v) throw new CredentialInputError("Company file path is required.");
  if (v.length > 400) throw new CredentialInputError("Company file path is too long.");
  if (CONTROL_CHARS.test(v)) throw new CredentialInputError("Company file path contains control characters.");
  if (!path.win32.isAbsolute(v)) throw new CredentialInputError("Use the full path, e.g. C:\\Clients\\Acme.qbw or \\\\server\\share\\Acme.qbw.");
  if (!/\.qbw$/i.test(v)) throw new CredentialInputError("The path must point to a .qbw company file.");
  return v;
}

/** Encrypts a plaintext password into the vault's DPAPI format. */
export type PasswordProtector = (plain: string) => Promise<string>;

/** Default protector: scripts/qb-dpapi-protect.ps1 (Windows only). */
export function protectPassword(plain: string): Promise<string> {
  if (process.platform !== "win32") {
    return Promise.reject(new Error("Saving QuickBooks passwords requires Windows (DPAPI)."));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolveScriptPath("qb-dpapi-protect.ps1")],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", reject);
    child.on("close", (code) => {
      const blob = stdout.trim();
      if (code === 0 && /^[A-Za-z0-9+/=]+$/.test(blob)) resolve(blob);
      else reject(new Error(`Could not encrypt the password: ${stderr.trim() || `exit ${code}`}`));
    });
    child.stdin.end(Buffer.from(plain, "utf8").toString("base64") + "\n");
  });
}

// Serialize read-modify-write cycles inside this process.
let writeChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T> | T): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next;
}

export interface UpsertLoginInput {
  companyFile: string;
  username: string;
  /** New password. Omitted or "" keeps the saved one. */
  password?: string;
  /** Remove the saved password (for a QB user with a blank password). */
  clearPassword?: boolean;
}

export interface UpsertLoginResult {
  created: boolean;
  passwordChanged: boolean;
  usernameChanged: boolean;
  entry: CredentialSummary;
}

/**
 * Create or overwrite the login for one company file. The existing entry
 * (matched case-insensitively by path) is replaced in place, and its tailnet
 * authorizations are kept.
 */
export function upsertLogin(
  input: UpsertLoginInput,
  opts: { vaultPath?: string; protect?: PasswordProtector } = {},
): Promise<UpsertLoginResult> {
  const vaultPath = opts.vaultPath ?? getCredentialsFilePath();
  const protect = opts.protect ?? protectPassword;
  return serialized(async () => {
    const companyFile = validateCompanyFilePath(input.companyFile);
    const username = (input.username ?? "").trim();
    if (!username) throw new CredentialInputError("QuickBooks user name is required.");
    if (username.length > 100 || CONTROL_CHARS.test(username)) throw new CredentialInputError("User name is invalid.");
    const newPassword = input.password ?? "";
    if (newPassword.length > 256 || /[\u0000\r\n]/.test(newPassword)) throw new CredentialInputError("Password is invalid.");

    const cipher = newPassword ? await protect(newPassword) : null;
    const store = readStore(vaultPath);
    const key = normalizeCompanyPath(companyFile);
    const idx = store.entries.findIndex((e) => normalizeCompanyPath(e.companyFile) === key);
    const prev = idx >= 0 ? store.entries[idx] : null;
    const password = cipher ?? (input.clearPassword ? "" : prev?.password ?? "");
    const entry: StoredEntry = {
      companyFile: prev?.companyFile ?? companyFile,
      username,
      password,
      updatedAt: new Date().toISOString(),
      authorizedPeers: prev?.authorizedPeers ?? [],
    };
    if (idx >= 0) store.entries[idx] = entry;
    else store.entries.push(entry);
    writeStore(store, vaultPath);
    return {
      created: idx < 0,
      passwordChanged: password !== (prev?.password ?? ""),
      usernameChanged: !!prev && prev.username !== username,
      entry: toSummary(entry),
    };
  });
}

/** Delete a company file's entry (login + authorizations). Returns false if absent. */
export function removeEntry(companyFile: string, opts: { vaultPath?: string } = {}): Promise<boolean> {
  const vaultPath = opts.vaultPath ?? getCredentialsFilePath();
  return serialized(() => {
    const store = readStore(vaultPath);
    const key = normalizeCompanyPath(companyFile);
    const before = store.entries.length;
    store.entries = store.entries.filter((e) => normalizeCompanyPath(e.companyFile) !== key);
    if (store.entries.length === before) return false;
    writeStore(store, vaultPath);
    return true;
  });
}

/**
 * Authorize a tailnet device for a company file. Creates an
 * authorization-only entry (no login) when the file has none yet.
 * Re-authorizing the same address refreshes its pinned node details.
 */
export function addAuthorizedPeer(
  companyFile: string,
  peer: Omit<AuthorizedPeer, "addedAt">,
  opts: { vaultPath?: string } = {},
): Promise<CredentialSummary> {
  const vaultPath = opts.vaultPath ?? getCredentialsFilePath();
  return serialized(() => {
    const file = validateCompanyFilePath(companyFile);
    const store = readStore(vaultPath);
    const key = normalizeCompanyPath(file);
    let entry = store.entries.find((e) => normalizeCompanyPath(e.companyFile) === key);
    if (!entry) {
      entry = { companyFile: file, username: "", password: "", updatedAt: new Date().toISOString(), authorizedPeers: [] };
      store.entries.push(entry);
    }
    const address = normalizeIp(peer.address);
    entry.authorizedPeers = entry.authorizedPeers.filter((p) => p.address !== address);
    entry.authorizedPeers.push({ ...peer, address, addedAt: new Date().toISOString() });
    entry.updatedAt = new Date().toISOString();
    writeStore(store, vaultPath);
    return toSummary(entry);
  });
}

export function removeAuthorizedPeer(
  companyFile: string,
  address: string,
  opts: { vaultPath?: string } = {},
): Promise<boolean> {
  const vaultPath = opts.vaultPath ?? getCredentialsFilePath();
  return serialized(() => {
    const store = readStore(vaultPath);
    const key = normalizeCompanyPath(companyFile);
    const entry = store.entries.find((e) => normalizeCompanyPath(e.companyFile) === key);
    if (!entry) return false;
    const ip = normalizeIp(address);
    const before = entry.authorizedPeers.length;
    entry.authorizedPeers = entry.authorizedPeers.filter((p) => p.address !== ip);
    if (entry.authorizedPeers.length === before) return false;
    entry.updatedAt = new Date().toISOString();
    writeStore(store, vaultPath);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Login-dialog autofill
// ---------------------------------------------------------------------------

/** Last non-empty stdout line parsed as JSON, or null. */
function parseLastJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i]);
      if (v && typeof v === "object") return v as Record<string, unknown>;
    } catch { /* keep scanning */ }
  }
  return null;
}

export type LoginAutofillStatus =
  | "filled"
  | "rejected"
  /** Login typed in, but QuickBooks ignored every automated OK press. */
  | "submit-failed"
  | "no-credentials"
  | "no-login-window"
  | "cancelled"
  | "error";

export interface LoginAutofillResult {
  status: LoginAutofillStatus;
  detail?: string;
}

export interface LoginAutofillHandle {
  result: Promise<LoginAutofillResult>;
  /** Stop waiting (e.g. the session attached without a login prompt). */
  cancel(): void;
}

/**
 * Start the autofill helper for `companyFile` in the background. Returns
 * null when there is nothing to do (non-Windows, or no saved user name for
 * the file), so callers skip spawning PowerShell entirely.
 */
export function startLoginAutofill(opts: {
  companyFile: string;
  vaultPath?: string;
  timeoutSeconds?: number;
}): LoginAutofillHandle | null {
  if (process.platform !== "win32") return null;
  const vaultPath = opts.vaultPath ?? getCredentialsFilePath();
  let summary: CredentialSummary | null;
  try {
    summary = findCredentialSummary(opts.companyFile, vaultPath);
  } catch {
    summary = null;
  }
  if (!summary || !summary.username) return null;

  let cancelled = false;
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", resolveScriptPath("qb-login-autofill.ps1"),
      "-VaultPath", vaultPath,
      "-CompanyFile", opts.companyFile,
      "-TimeoutSeconds", String(Math.max(5, Math.floor(opts.timeoutSeconds ?? 150))),
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const result = new Promise<LoginAutofillResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", (err) => resolve({ status: "error", detail: err.message }));
    child.on("close", () => {
      if (cancelled) { resolve({ status: "cancelled" }); return; }
      const r = parseLastJsonLine(stdout);
      if (!r || typeof r.status !== "string") {
        resolve({ status: "error", detail: (stderr || stdout).trim().slice(0, 500) || "autofill exited without a result" });
        return;
      }
      resolve({
        status: r.status as LoginAutofillStatus,
        ...(typeof r.detail === "string" ? { detail: r.detail } : {}),
      });
    });
  });
  return {
    result,
    cancel: () => {
      if (child.exitCode !== null || cancelled) return;
      cancelled = true;
      child.kill();
    },
  };
}
