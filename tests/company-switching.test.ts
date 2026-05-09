// Company switching (Phase 7 Items 34-36) — qb_company_open swaps the active
// company file mid-session and resets the simulation store; qb_company_list
// enumerates `.qbw` files under the configured root.
//
// The sim-reset behavior on switch is INTENTIONAL: real QB persists per-file,
// the sim doesn't, so without reseed the operator would see entities from the
// prior company on the "new" one. See DECISIONS.md 2026-05-09 (sim-fidelity
// tradeoff). These tests pin that contract — switch A → B → A returns A's
// fresh seed, NOT the mutations from the first A session.
//
// Tool surface is exercised via the same fakeServer pattern as
// error-shape.test.ts — captures the (name, schema, handler) tuple at
// register time, then drives the handler directly.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { QBSessionManager } from "../src/session/manager.js";
import { registerReportTools } from "../src/tools/reports.js";

type Handler = (
  args: unknown
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

const setupHarness = () => {
  const handlers = new Map<string, Handler>();
  const fakeServer = {
    tool: (name: string, _description: string, _schema: Record<string, z.ZodTypeAny>, handler: Handler) => {
      handlers.set(name, handler);
    },
  };
  const session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-company-switching",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  registerReportTools(fakeServer as never, () => session);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const h = handlers.get(name);
    if (!h) throw new Error(`tool not registered: ${name}`);
    const result = await h(args);
    return { isError: !!result.isError, body: JSON.parse(result.content[0].text) };
  };

  return { session, call };
};

describe("qb_company_open — switch active company file", () => {
  it("swaps companyFile path and surfaces previous + new path in the response", async () => {
    const { session, call } = setupHarness();
    await session.openSession();

    const r = await call("qb_company_open", { companyFile: "C:\\fixtures\\Acme.qbw" });
    expect(r.isError).toBe(false);
    expect(r.body.success).toBe(true);
    expect(r.body.previousCompanyFile).toBe("simulation");
    expect(r.body.companyFile).toBe("C:\\fixtures\\Acme.qbw");
    expect(r.body.simulationMode).toBe(true);
    expect(r.body.simulationStoreReset).toBe(true);
    expect(typeof r.body.ticket).toBe("string");
    expect(typeof r.body.openedAt).toBe("string");
  });

  it("resets the simulation store: entities created against company A are not visible after switching to B", async () => {
    const { session, call } = setupHarness();
    await session.openSession();

    // Add an entity to company A's store
    await session.addEntity("Customer", { Name: "Only In A" });
    const inA = await session.queryEntity("Customer", { FullName: "Only In A" });
    expect(inA).toHaveLength(1);

    // Switch to company B — store reseeds
    await call("qb_company_open", { companyFile: "C:\\fixtures\\B.qbw" });

    const inB = await session.queryEntity("Customer", { FullName: "Only In A" });
    expect(inB).toHaveLength(0);

    // B's seed is the standard fresh seed (Acme / Global / TechStart present)
    const allInB = await session.queryEntity("Customer");
    expect(allInB.some((c) => String(c.Name).toLowerCase().includes("acme"))).toBe(true);
  });

  it("switching back to A returns A's FRESH seed, not the prior session's mutations (DECISIONS.md 2026-05-09 — deliberate sim-fidelity tradeoff)", async () => {
    const { session, call } = setupHarness();
    await session.openSession();

    // Mutate company A
    await session.addEntity("Customer", { Name: "Was In A" });

    // A → B
    await call("qb_company_open", { companyFile: "C:\\fixtures\\B.qbw" });
    // B → A (same path string as the original)
    await call("qb_company_open", { companyFile: "simulation" });

    // The mutation from the first A session must NOT carry over.
    // This is the contract: switching ALWAYS reseeds in sim, even when the
    // path matches a prior session. Real QB persists per-file; sim doesn't.
    const reA = await session.queryEntity("Customer", { FullName: "Was In A" });
    expect(reA).toHaveLength(0);
  });

  it("rejects empty companyFile argument at the schema level", async () => {
    // The zod schema requires companyFile to be a non-empty string. The
    // fakeServer harness skips zod validation (handlers receive args
    // directly), so this test asserts the schema's intent by inspecting
    // it — the runtime MCP server applies the same schema before
    // dispatching to the handler.
    const handlers = new Map<string, { schema: Record<string, z.ZodTypeAny>; handler: Handler }>();
    const fakeServer = {
      tool: (name: string, _d: string, schema: Record<string, z.ZodTypeAny>, handler: Handler) => {
        handlers.set(name, { schema, handler });
      },
    };
    const session = new QBSessionManager({
      companyFile: "simulation",
      appName: "vitest-company-switching-schema",
      qbxmlVersion: "16.0",
    });
    registerReportTools(fakeServer as never, () => session);

    const cmd = handlers.get("qb_company_open");
    expect(cmd).toBeDefined();
    const validation = z.object(cmd!.schema).safeParse({ companyFile: "" });
    expect(validation.success).toBe(false);
  });
});

describe("qb_company_list — enumerate .qbw files under root", () => {
  let tmpDir: string;
  let priorRoot: string | undefined;
  let priorFile: string | undefined;

  beforeEach(async () => {
    priorRoot = process.env.QB_COMPANY_ROOT;
    priorFile = process.env.QB_COMPANY_FILE;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-company-list-"));
  });

  afterEach(async () => {
    // Restore env (delete vs. reassign — undefined-restore via assignment is wrong)
    if (priorRoot === undefined) delete process.env.QB_COMPANY_ROOT;
    else process.env.QB_COMPANY_ROOT = priorRoot;
    if (priorFile === undefined) delete process.env.QB_COMPANY_FILE;
    else process.env.QB_COMPANY_FILE = priorFile;

    // Windows occasionally returns ENOTEMPTY on the first rmdir if a child
    // file's handle hasn't fully released — retry briefly.
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("lists .qbw files in $QB_COMPANY_ROOT, sorted by modifiedAt desc", async () => {
    // Three .qbw fixtures + one non-.qbw decoy. mtime stamped in ascending
    // order so we can assert the desc sort.
    await fs.writeFile(path.join(tmpDir, "Alpha.qbw"), "fixture-a");
    await fs.writeFile(path.join(tmpDir, "Beta.qbw"), "fixture-b");
    await fs.writeFile(path.join(tmpDir, "Gamma.qbw"), "fixture-g");
    await fs.writeFile(path.join(tmpDir, "ignore.txt"), "decoy");
    // Force distinct mtimes (ms precision varies across platforms).
    const baseMs = Date.now() - 10_000;
    await fs.utimes(path.join(tmpDir, "Alpha.qbw"), new Date(baseMs), new Date(baseMs));
    await fs.utimes(path.join(tmpDir, "Beta.qbw"), new Date(baseMs + 5_000), new Date(baseMs + 5_000));
    await fs.utimes(path.join(tmpDir, "Gamma.qbw"), new Date(baseMs + 10_000), new Date(baseMs + 10_000));

    process.env.QB_COMPANY_ROOT = tmpDir;
    delete process.env.QB_COMPANY_FILE;

    const { call } = setupHarness();
    const r = await call("qb_company_list");
    expect(r.isError).toBe(false);
    expect(r.body.root).toBe(tmpDir);
    expect(r.body.count).toBe(3);

    const names = r.body.companies.map((c: { displayName: string }) => c.displayName);
    expect(names).toEqual(["Gamma", "Beta", "Alpha"]); // desc by mtime

    for (const c of r.body.companies as Array<Record<string, unknown>>) {
      expect(typeof c.companyFile).toBe("string");
      expect(typeof c.sizeBytes).toBe("number");
      expect(typeof c.modifiedAt).toBe("string");
      expect(String(c.companyFile)).toMatch(/\.qbw$/);
    }
  });

  it("falls back to dirname($QB_COMPANY_FILE) when QB_COMPANY_ROOT is unset", async () => {
    await fs.writeFile(path.join(tmpDir, "OnlyOne.qbw"), "x");
    delete process.env.QB_COMPANY_ROOT;
    process.env.QB_COMPANY_FILE = path.join(tmpDir, "OnlyOne.qbw");

    const { call } = setupHarness();
    const r = await call("qb_company_list");
    expect(r.isError).toBe(false);
    expect(r.body.root).toBe(tmpDir);
    expect(r.body.count).toBe(1);
    expect(r.body.companies[0].displayName).toBe("OnlyOne");
  });

  it("explicit `root` arg wins over both env vars", async () => {
    await fs.writeFile(path.join(tmpDir, "Override.qbw"), "x");

    // Set both env vars to bogus values to confirm the override is honored.
    process.env.QB_COMPANY_ROOT = "C:\\not-a-real-path";
    process.env.QB_COMPANY_FILE = "C:\\not-a-real-path\\nope.qbw";

    const { call } = setupHarness();
    const r = await call("qb_company_list", { root: tmpDir });
    expect(r.isError).toBe(false);
    expect(r.body.root).toBe(tmpDir);
    expect(r.body.count).toBe(1);
  });

  it("returns an error when neither env var nor `root` arg supplies a search root", async () => {
    delete process.env.QB_COMPANY_ROOT;
    delete process.env.QB_COMPANY_FILE;

    const { call } = setupHarness();
    const r = await call("qb_company_list");
    expect(r.isError).toBe(true);
    expect(r.body.success).toBe(false);
    expect(String(r.body.statusMessage)).toMatch(/QB_COMPANY_ROOT|QB_COMPANY_FILE|root/i);
  });

  it("returns a structured error when the resolved root does not exist", async () => {
    const { call } = setupHarness();
    const r = await call("qb_company_list", { root: path.join(tmpDir, "does-not-exist") });
    expect(r.isError).toBe(true);
    expect(r.body.success).toBe(false);
    expect(String(r.body.statusMessage)).toMatch(/Failed to enumerate/);
  });

  it("returns count: 0 when the root contains no .qbw files", async () => {
    await fs.writeFile(path.join(tmpDir, "readme.txt"), "no qbw here");
    const { call } = setupHarness();
    const r = await call("qb_company_list", { root: tmpDir });
    expect(r.isError).toBe(false);
    expect(r.body.count).toBe(0);
    expect(r.body.companies).toEqual([]);
  });
});

describe("qb_company_open + qb_company_list — round-trip discovery → switch", () => {
  let tmpDir: string;
  let priorRoot: string | undefined;
  let priorFile: string | undefined;

  beforeEach(async () => {
    priorRoot = process.env.QB_COMPANY_ROOT;
    priorFile = process.env.QB_COMPANY_FILE;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-roundtrip-"));
  });

  afterEach(async () => {
    if (priorRoot === undefined) delete process.env.QB_COMPANY_ROOT;
    else process.env.QB_COMPANY_ROOT = priorRoot;
    if (priorFile === undefined) delete process.env.QB_COMPANY_FILE;
    else process.env.QB_COMPANY_FILE = priorFile;
    // Windows occasionally returns ENOTEMPTY on the first rmdir if a child
    // file's handle hasn't fully released — retry briefly.
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("paths from qb_company_list are valid input to qb_company_open (sim mode)", async () => {
    await fs.writeFile(path.join(tmpDir, "ClientOne.qbw"), "x");
    process.env.QB_COMPANY_ROOT = tmpDir;
    delete process.env.QB_COMPANY_FILE;

    const { session, call } = setupHarness();
    await session.openSession();

    const list = await call("qb_company_list");
    expect(list.body.count).toBe(1);
    const target = list.body.companies[0].companyFile as string;

    const open = await call("qb_company_open", { companyFile: target });
    expect(open.isError).toBe(false);
    expect(open.body.companyFile).toBe(target);
    expect(open.body.simulationStoreReset).toBe(true);
  });
});
