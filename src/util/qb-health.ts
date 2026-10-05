/**
 * QuickBooks Desktop health: is QB running, responding, stuck on a dialog,
 * handed off to File Doctor, or crashed? Feeds the logins page, the
 * qb_health tool, and crash recovery in QBSessionManager.
 *
 * Raw facts come from scripts/qb-health.ps1 (read-only). This module turns
 * them into one `state` plus a plain-language summary and a recommended
 * action. Snapshots are cached for 3s because the page polls.
 */

import { execFile } from "node:child_process";

import { resolveScriptPath } from "./qb-credentials.js";

export interface QBWindowInfo { title: string; className: string; isMain: boolean }
export interface QBProcessInfo {
  pid: number;
  responding: boolean;
  startedAt?: string | null;
  mainTitle?: string;
  windows: QBWindowInfo[];
}
export interface RawHealth {
  ok: boolean;
  error?: string;
  quickbooks: QBProcessInfo[];
  fileDoctor: Array<{ pid: number; name: string; title?: string }>;
  crashReporter: Array<{ pid: number; title: string }>;
}

export type QBHealthState =
  | "unsupported"     // not Windows / probe failed
  | "not-running"     // no QBW process
  | "starting"        // QBW running, no main window yet
  | "ready"           // main window up, no blocking dialog
  | "login"           // QuickBooks Desktop Login window is up
  | "dialog"          // some other dialog (error box, prompt) is up
  | "not-responding"  // Windows reports QB as hung
  | "file-doctor"     // File Doctor / Tool Hub / rebuild is running
  | "crashed";        // Windows Error Reporting is showing a QuickBooks crash

export interface QBHealth {
  checkedAt: string;
  state: QBHealthState;
  summary: string;
  recommendedAction: string;
  /** The company name from QB's title bar when a file is open. */
  openCompanyTitle?: string;
  dialogs: string[];
  raw: RawHealth;
}

/** Windows we don't treat as "dialogs": the main frame, toolbars, tooltips, splash. */
function isIgnorableWindow(w: QBWindowInfo): boolean {
  if (w.isMain) return true;
  if (!w.title.trim()) return true;
  return /^Afx:|tooltips_class|^#32768$|^IME$|^MSCTFIME/i.test(w.className);
}

export function interpretHealth(raw: RawHealth, now = new Date()): QBHealth {
  const base = { checkedAt: now.toISOString(), raw, dialogs: [] as string[] };
  if (!raw.ok) {
    return { ...base, state: "unsupported", summary: `Could not check QuickBooks: ${raw.error ?? "unknown error"}`, recommendedAction: "None. Health checks need Windows." };
  }
  const dialogs = raw.quickbooks.flatMap((p) => p.windows.filter((w) => !isIgnorableWindow(w)).map((w) => w.title));
  const mainTitle = raw.quickbooks.flatMap((p) => p.windows.filter((w) => w.isMain).map((w) => w.title))[0] ?? raw.quickbooks[0]?.mainTitle ?? "";
  const company = mainTitle.split(/\s+-\s+Intuit QuickBooks/i)[0]?.trim();
  const openCompanyTitle = company && !/^Intuit QuickBooks/i.test(company) ? company : undefined;
  const withCompany = { ...base, dialogs, ...(openCompanyTitle ? { openCompanyTitle } : {}) };

  if (raw.crashReporter.length) {
    return { ...withCompany, state: "crashed", summary: `QuickBooks crashed (Windows is showing "${raw.crashReporter[0].title}").`, recommendedAction: "Close the Windows crash message. Then press Reconnect: the server reopens the same company file and logs in again." };
  }
  if (raw.fileDoctor.length) {
    const what = raw.fileDoctor[0].title || raw.fileDoctor[0].name;
    return { ...withCompany, state: "file-doctor", summary: `QuickBooks File Doctor / Tool Hub is running (${what}). It may be repairing the company file.`, recommendedAction: "Let File Doctor finish. Don't reopen the file while it is being repaired. Afterwards press Reconnect." };
  }
  if (!raw.quickbooks.length) {
    return { ...withCompany, state: "not-running", summary: "QuickBooks is not running.", recommendedAction: "Nothing to do. The next agent request (or Reconnect) starts QuickBooks on the company file and logs in." };
  }
  if (raw.quickbooks.some((p) => !p.responding)) {
    return { ...withCompany, state: "not-responding", summary: "Windows reports QuickBooks as not responding.", recommendedAction: "Wait a minute; large reports can freeze QuickBooks briefly. If it stays frozen, use Force close, then Reconnect." };
  }
  if (dialogs.some((d) => /quickbooks desktop login/i.test(d))) {
    return { ...withCompany, state: "login", summary: "QuickBooks is at its login window.", recommendedAction: "If an open is in progress the server fills this in from the saved login. Otherwise log in by hand, or check the saved login." };
  }
  if (dialogs.length) {
    return { ...withCompany, state: "dialog", summary: `QuickBooks is showing: ${dialogs.map((d) => `"${d}"`).join(", ")}.`, recommendedAction: "Answer the QuickBooks window. Agents can't use QuickBooks while a dialog is open. Then press Reconnect if requests were failing." };
  }
  if (!raw.quickbooks.some((p) => p.windows.some((w) => w.isMain))) {
    return { ...withCompany, state: "starting", summary: "QuickBooks is starting.", recommendedAction: "Wait for it to finish opening." };
  }
  return {
    ...withCompany,
    state: "ready",
    summary: openCompanyTitle ? `QuickBooks is open on ${openCompanyTitle.replace(/\.+$/, "")}.` : "QuickBooks is open with no company file.",
    recommendedAction: "None.",
  };
}

export type HealthProbe = () => Promise<RawHealth>;

export function defaultHealthProbe(): Promise<RawHealth> {
  if (process.platform !== "win32") {
    return Promise.resolve({ ok: false, error: "not Windows", quickbooks: [], fileDoctor: [], crashReporter: [] });
  }
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolveScriptPath("qb-health.ps1")],
      { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        const line = String(stdout ?? "").trim().split(/\r?\n/).pop() ?? "";
        try {
          const parsed = JSON.parse(line) as Partial<RawHealth>;
          resolve({
            ok: !!parsed.ok,
            ...(parsed.error ? { error: parsed.error } : {}),
            quickbooks: (parsed.quickbooks ?? []).map((p) => ({ ...p, windows: p.windows ?? [] })),
            fileDoctor: parsed.fileDoctor ?? [],
            crashReporter: parsed.crashReporter ?? [],
          });
        } catch {
          resolve({ ok: false, error: err?.message ?? "health probe returned no data", quickbooks: [], fileDoctor: [], crashReporter: [] });
        }
      },
    );
  });
}

let cache: { at: number; value: QBHealth } | null = null;
let inflight: Promise<QBHealth> | null = null;

/** Cached (3s) health snapshot. `fresh` bypasses the cache. */
export async function getQuickBooksHealth(opts: { fresh?: boolean; probe?: HealthProbe } = {}): Promise<QBHealth> {
  if (!opts.fresh && !opts.probe && cache && Date.now() - cache.at < 3000) return cache.value;
  if (!opts.probe && inflight) return inflight;
  const run = (async () => interpretHealth(await (opts.probe ?? defaultHealthProbe)()))();
  if (!opts.probe) inflight = run;
  try {
    const value = await run;
    if (!opts.probe) cache = { at: Date.now(), value };
    return value;
  } finally {
    if (!opts.probe) inflight = null;
  }
}
