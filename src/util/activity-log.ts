/**
 * Activity log: a plain-language timeline of what the server did (sessions,
 * company switches, logins, crashes and recoveries, logins-page edits,
 * access grants, refused remote calls). It is shown on the logins page and
 * returned by qb_health.
 *
 * Kept in memory (last 300 events) and appended as JSON lines to
 * activity.log beside the credential store, so the history survives
 * restarts. The file is trimmed to its newest half once it passes 1 MB.
 * Events never contain passwords or company data, only file paths, user
 * names, device names and error text.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getCredentialsFilePath } from "./qb-credentials.js";

export type ActivityLevel = "info" | "success" | "warn" | "error";
export type ActivityCategory = "session" | "switch" | "login" | "recovery" | "health" | "logins" | "access" | "agent";

export interface ActivityEvent {
  at: string;
  level: ActivityLevel;
  category: ActivityCategory;
  message: string;
  companyFile?: string;
  detail?: string;
}

const MAX_EVENTS = 300;
const MAX_FILE_BYTES = 1024 * 1024;
const events: ActivityEvent[] = [];
let loadedFrom: string | null = null;

export function getActivityLogPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.QB_ACTIVITY_LOG && env.QB_ACTIVITY_LOG.trim()) return env.QB_ACTIVITY_LOG;
  return path.join(path.dirname(getCredentialsFilePath(env)), "activity.log");
}

function persistEnabled(): boolean {
  return process.env.QB_ACTIVITY_LOG !== "0" && !process.env.VITEST;
}

/** Load earlier history once, so the timeline survives restarts. */
function ensureLoaded(): void {
  if (!persistEnabled()) return;
  const file = getActivityLogPath();
  if (loadedFrom === file) return;
  loadedFrom = file;
  try {
    if (!existsSync(file)) return;
    const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-MAX_EVENTS);
    const old: ActivityEvent[] = [];
    for (const l of lines) {
      try { old.push(JSON.parse(l) as ActivityEvent); } catch { /* skip a torn line */ }
    }
    events.unshift(...old);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  } catch { /* history is best-effort */ }
}

export function recordActivity(e: Omit<ActivityEvent, "at"> & { at?: string }): ActivityEvent {
  ensureLoaded();
  const event: ActivityEvent = {
    at: e.at ?? new Date().toISOString(),
    level: e.level,
    category: e.category,
    message: e.message,
    ...(e.companyFile ? { companyFile: e.companyFile } : {}),
    ...(e.detail ? { detail: e.detail.slice(0, 600) } : {}),
  };
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  if (persistEnabled()) {
    try {
      const file = getActivityLogPath();
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
      if (statSync(file).size > MAX_FILE_BYTES) {
        const keep = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
        writeFileSync(file, keep.slice(Math.floor(keep.length / 2)).join("\n") + "\n", "utf8");
      }
    } catch { /* never let logging break a tool call */ }
  }
  return event;
}

/** Newest first. */
export function getActivity(limit = 100): ActivityEvent[] {
  ensureLoaded();
  return events.slice(-limit).reverse();
}

/** Test hook. */
export function clearActivity(): void {
  events.length = 0;
}
