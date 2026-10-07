#!/usr/bin/env node
/**
 * quickbooks-desktop-mcp-connector: run on a QuickBooks workstation to make
 * its QuickBooks Desktop available to the hub (docs/CONNECTOR_DESIGN.md).
 *
 *   QB_HUB_URL=http://100.87.42.62:8765  npx -y -p github:RealDealCPA-VR/Quickbooks-MCP-Desktop quickbooks-desktop-mcp-connector
 *
 * It listens on this PC's tailnet address (QB_CONNECTOR_PORT, default 8766)
 * and checks in with the hub every 30 s. The hub lists the workstation as
 * available while check-ins arrive. Stop it (or turn the PC off) and it
 * shows as offline.
 */

import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { tailnetSelfAddresses } from "../util/tailnet.js";
import { CONNECTOR_HEARTBEAT_MS, CONNECTOR_PROTOCOL, DEFAULT_CONNECTOR_PORT, postJson } from "./protocol.js";
import { startConnectorServer } from "./server.js";
import { withUncPaths } from "./unc-host.js";
import { localQBHost } from "../session/qb-host.js";

function configPath(): string {
  if (process.env.QB_CONNECTOR_CONFIG?.trim()) return process.env.QB_CONNECTOR_CONFIG;
  const base = process.platform === "win32"
    ? (process.env.APPDATA?.trim() || path.join(os.homedir(), "AppData", "Roaming"))
    : path.join(os.homedir(), ".config");
  return path.join(base, "quickbooks-desktop-mcp", "connector.json");
}

/** The secret the hub must present. Created once per PC and kept in the user's profile. */
function loadOrCreateSecret(file: string): string {
  if (existsSync(file)) {
    const v = JSON.parse(readFileSync(file, "utf8")) as { secret?: unknown };
    if (typeof v.secret === "string" && v.secret.length >= 32) return v.secret;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(file, JSON.stringify({ secret, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows: the profile folder is already per-user */ }
  return secret;
}

function packageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return (JSON.parse(readFileSync(path.join(here, "..", "..", "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const hubUrl = (process.env.QB_HUB_URL ?? "").trim().replace(/\/+$/, "");
  if (!/^http:\/\/[^/]+$/i.test(hubUrl)) {
    console.error("Set QB_HUB_URL to the hub's address, e.g. QB_HUB_URL=http://100.87.42.62:8765");
    process.exit(2);
  }
  const hubHost = new URL(hubUrl).hostname.replace(/^\[|\]$/g, "");
  const hubAddresses = (await lookup(hubHost, { all: true })).map((a) => a.address);

  const port = Number(process.env.QB_CONNECTOR_PORT) || DEFAULT_CONNECTOR_PORT;
  const self = (await tailnetSelfAddresses()).filter((a) => a.includes("."));
  if (!self.length) {
    console.error("Tailscale isn't running on this PC (no tailnet address). Start Tailscale and try again.");
    process.exit(2);
  }
  const secret = loadOrCreateSecret(configPath());
  const version = packageVersion();
  // Mapped drive letters are reported as their file-server (UNC) paths.
  const server = await startConnectorServer({ port, secret, hubAddresses, listenHosts: ["127.0.0.1", ...self], version, host: withUncPaths(localQBHost) });

  console.error(`QuickBooks connector ${version} on ${os.hostname()}`);
  console.error(`  Listening: ${server.urls.join("  ")}`);
  console.error(`  Hub: ${hubUrl}`);

  let lastOk: boolean | null = null;
  const checkIn = async () => {
    try {
      const r = await postJson<{ ok: boolean; name?: string }>(
        `${hubUrl}/connector/register`,
        { name: os.hostname(), port: server.port, secret, version, platform: process.platform, protocol: CONNECTOR_PROTOCOL },
        { timeoutMs: 15_000 },
      );
      if (lastOk !== true) console.error(`  Registered with the hub as "${r.name ?? os.hostname()}". This workstation is available.`);
      lastOk = true;
    } catch (err) {
      if (lastOk !== false) console.error(`  Can't reach the hub yet (${(err as Error).message}). Retrying every ${CONNECTOR_HEARTBEAT_MS / 1000}s.`);
      lastOk = false;
    }
  };
  await checkIn();
  setInterval(() => { void checkIn(); }, CONNECTOR_HEARTBEAT_MS);

  const stop = () => { void server.close().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error(`Connector failed to start: ${(err as Error).message}`);
  process.exit(1);
});
