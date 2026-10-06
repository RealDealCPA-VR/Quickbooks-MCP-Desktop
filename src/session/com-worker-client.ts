/**
 * Server-side handle on the QuickBooks COM helper process (com-worker.ts).
 *
 * Exposes the same five QBXMLRP2 methods the session manager has always
 * called (OpenConnection2 / BeginSession / ProcessRequest / EndSession /
 * CloseConnection), but async and out-of-process:
 *   - The helper crashing (QB killed mid-call → native segfault) rejects
 *     every pending call with a "COM helper exited" error. The session
 *     manager classifies that as "QuickBooks went away" and recovers.
 *   - Every call has a time limit. A QuickBooks frozen mid-report no longer
 *     hangs a request forever: past the limit the helper is killed and the
 *     call fails with a "did not answer within" error. Recovery's health
 *     check then tells a frozen QB from one that is gone.
 */

import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Default limits. BeginSession can block while QB starts and logs in. */
export const COM_TIMEOUTS = Object.freeze({
  openMs: 120_000,
  beginMs: 300_000,
  processMs: Number(process.env.QB_COM_TIMEOUT_MS) || 600_000,
  endMs: 30_000,
});

/** What the manager calls. Fakes in tests may implement these synchronously. */
export interface QBRequestProcessor {
  OpenConnection2(appId: string, appName: string, connectionType: number): unknown;
  BeginSession(companyFile: string, fileMode: number): unknown;
  ProcessRequest(ticket: string, xml: string): unknown;
  EndSession(ticket: string): unknown;
  CloseConnection(): unknown;
  /** Stop the helper process (no-op for fakes). */
  dispose?(): void;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; op: string };

function workerScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/session/com-worker.js next to this file; under tsx (src/) the .ts sibling.
  return path.join(here, path.basename(fileURLToPath(import.meta.url)).endsWith(".ts") ? "com-worker.ts" : "com-worker.js");
}

export interface WorkerRequestProcessorOptions {
  /** Script to fork (tests point this at a fake helper). Default: com-worker.js. */
  scriptPath?: string;
  /** Per-call time limits; defaults to COM_TIMEOUTS. */
  timeouts?: Partial<typeof COM_TIMEOUTS>;
}

export class WorkerRequestProcessor implements QBRequestProcessor {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private exitInfo: string | null = null;
  private readonly timeouts: typeof COM_TIMEOUTS;

  constructor(private readonly opts: WorkerRequestProcessorOptions = {}) {
    this.timeouts = { ...COM_TIMEOUTS, ...opts.timeouts };
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const script = this.opts.scriptPath ?? workerScriptPath();
      const child = fork(script, [], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        execArgv: script.endsWith(".ts") ? ["--import", "tsx"] : [],
        // Passed through to spawn at runtime; keeps a console window from
        // flashing when the server runs under a GUI host (Claude Desktop).
        windowsHide: true,
      } as ForkOptions & { windowsHide: boolean });
      this.child = child;
      let stderr = "";
      child.stderr?.on("data", (d) => { stderr = (stderr + String(d)).slice(-2000); });
      child.on("message", (raw) => {
        const m = raw as { ready?: boolean; fatal?: string; id?: number; ok?: boolean; result?: unknown; error?: string };
        if (m.ready) { resolve(); return; }
        if (m.fatal) { reject(new Error(m.fatal)); return; }
        if (typeof m.id !== "number") return;
        const p = this.pending.get(m.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(m.id);
        if (m.ok) p.resolve(m.result);
        else p.reject(new Error(m.error ?? "QBXMLRP2 call failed"));
      });
      child.on("exit", (code, signal) => {
        this.exitInfo = `QuickBooks COM helper exited (code ${code ?? "none"}${signal ? `, signal ${signal}` : ""}). QuickBooks is not running or stopped responding.${stderr.trim() ? ` ${stderr.trim().slice(-300)}` : ""}`;
        const err = new Error(this.exitInfo);
        reject(err);
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(err);
          this.pending.delete(id);
        }
        this.child = null;
      });
      child.on("error", (err) => reject(err));
    });
    return this.ready;
  }

  private async call(op: string, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.exitInfo) throw new Error(this.exitInfo);
    await this.start();
    const child = this.child;
    if (!child) throw new Error(this.exitInfo ?? "QuickBooks COM helper is not running");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`QuickBooks did not answer within ${Math.round(timeoutMs / 1000)}s (${op}); the COM helper was stopped. QuickBooks may be frozen.`));
        this.dispose();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, op });
      child.send({ id, op, ...payload });
    });
  }

  OpenConnection2(appId: string, appName: string, connectionType: number): Promise<unknown> {
    return this.call("open", { appId, appName, connectionType }, this.timeouts.openMs);
  }
  BeginSession(companyFile: string, fileMode: number): Promise<unknown> {
    return this.call("begin", { companyFile, fileMode }, this.timeouts.beginMs);
  }
  ProcessRequest(ticket: string, xml: string): Promise<unknown> {
    return this.call("process", { ticket, xml }, this.timeouts.processMs);
  }
  EndSession(ticket: string): Promise<unknown> {
    return this.call("end", { ticket }, this.timeouts.endMs);
  }
  CloseConnection(): Promise<unknown> {
    return this.call("close", {}, this.timeouts.endMs);
  }

  /** Kill the helper. Pending calls reject with the exit error. */
  dispose(): void {
    if (this.child && this.child.exitCode === null) this.child.kill();
  }

  /** Test/diagnostic: the helper's PID while it runs. */
  get pid(): number | undefined {
    return this.child?.pid;
  }
}
