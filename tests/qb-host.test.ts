// QBHost seam (docs/CONNECTOR_DESIGN.md, Phase 1): the session manager and
// the web page reach the QuickBooks machine only through the host they were
// given, and an async host (the future network connector) works end to end.

import http from "node:http";

import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { QBSessionManager } from "../src/session/manager.js";
import { localQBHost, type QBHost } from "../src/session/qb-host.js";
import type { QBRequestProcessor } from "../src/session/com-worker-client.js";
import { startWebServer } from "../src/web/server.js";

function recordingHost(over: Partial<QBHost> = {}) {
  const calls: string[] = [];
  const rp: QBRequestProcessor = {
    OpenConnection2: async () => { calls.push("rp.open"); },
    BeginSession: async () => { calls.push("rp.begin"); return "TICKET-1"; },
    ProcessRequest: async () => "",
    EndSession: async () => { calls.push("rp.end"); },
    CloseConnection: async () => { calls.push("rp.close"); },
  };
  const host: QBHost = {
    label: "fake workstation",
    createRequestProcessor: () => { calls.push("createRequestProcessor"); return rp; },
    isQuickBooksRunning: async () => { calls.push("isQuickBooksRunning"); return true; },
    resolveExe: async () => { calls.push("resolveExe"); return null; },
    launch: async () => { calls.push("launch"); },
    closeGracefully: async () => { calls.push("closeGracefully"); return { closed: true, outcome: "closed" as const }; },
    forceClose: async () => { calls.push("forceClose"); return true; },
    health: async () => { calls.push("health"); return localQBHost.health({ fresh: false }); },
    fileExists: async (p) => { calls.push(`fileExists ${p}`); return false; },
    findCompanyFiles: async () => { calls.push("findCompanyFiles"); return []; },
    listDrives: async () => { calls.push("listDrives"); return [{ path: "Q:\\", label: "Books", kind: "network", ready: true }]; },
    browse: async (dir) => { calls.push(`browse ${dir}`); return { path: dir, parent: null, folders: [], files: [], truncated: false }; },
    hasSavedLogin: async () => { calls.push("hasSavedLogin"); return false; },
    startLoginAutofill: async () => { calls.push("startLoginAutofill"); return null; },
    ...over,
  };
  return { host, calls };
}

function liveManager(host: QBHost) {
  const mgr = new QBSessionManager({ companyFile: "C:\\initial.qbw", appName: "vitest-host", qbxmlVersion: "16.0" }, host);
  (mgr as unknown as { simulationMode: boolean }).simulationMode = false;
  (mgr as unknown as { sleepImpl: (ms: number) => Promise<void> }).sleepImpl = async () => {};
  return mgr;
}

describe("QBSessionManager uses the host it was given", () => {
  it("defaults to this computer", () => {
    const mgr = new QBSessionManager({ companyFile: "", appName: "vitest-host", qbxmlVersion: "16.0" });
    expect(mgr.getHost()).toBe(localQBHost);
  });

  it("live session opens through the host's request processor", async () => {
    const { host, calls } = recordingHost();
    const mgr = liveManager(host);
    expect(mgr.getHost()).toBe(host);
    await mgr.openSession();
    expect(mgr.getSession()?.ticket).toBe("TICKET-1");
    expect(calls.slice(0, 3)).toEqual(["createRequestProcessor", "rp.open", "rp.begin"]);
  });

  it("the file-exists pre-check is awaited from the (async) host", async () => {
    const { host, calls } = recordingHost();
    const mgr = liveManager(host);
    await expect(mgr.switchCompanyFile("\\\\files\\books\\Gone.qbw", { closeCurrentCompany: true }))
      .rejects.toMatchObject({ statusCode: 9007, reason: "file-not-found" });
    expect(calls).toContain("fileExists \\\\files\\books\\Gone.qbw");
    expect(calls).not.toContain("closeGracefully");
    expect(calls).not.toContain("launch");
  });
});

describe("web page reaches the machine through the session's host", () => {
  it("drives and browse come from the host", async () => {
    const { host, calls } = recordingHost();
    const mgr = liveManager(host);
    const web = await startWebServer({
      port: 0,
      listenHosts: ["127.0.0.1"],
      bindTailnet: false,
      createMcpServer: () => new McpServer({ name: "t", version: "1" }),
      getSession: () => mgr,
      tailscale: async () => "",
      identifyCaller: async () => ({ kind: "local", via: "loopback" }),
    });
    const post = (body: unknown) =>
      new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
        const data = JSON.stringify(body);
        const r = http.request(`http://127.0.0.1:${web.port}/api/browse`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(data)), "X-QB-Admin": "1" },
        }, (res) => {
          let t = "";
          res.on("data", (c) => { t += c; });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(t) }));
        });
        r.on("error", reject);
        r.end(data);
      });
    try {
      const drives = await post({ path: "" });
      expect(drives.json).toEqual({ drives: [{ path: "Q:\\", label: "Books", kind: "network", ready: true }] });
      const listing = await post({ path: "\\\\files\\books" });
      expect(listing.status).toBe(200);
      expect(listing.json.path).toBe("\\\\files\\books");
      expect(calls).toEqual(expect.arrayContaining(["listDrives", "browse \\\\files\\books"]));
    } finally {
      await web.close();
    }
  });
});
