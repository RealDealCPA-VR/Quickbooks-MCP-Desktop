/**
 * QuickBooks COM helper process.
 *
 * The ONLY place that loads `winax` and touches QBXMLRP2. The MCP server
 * forks one of these per QuickBooks session (src/session/com-worker-client.ts)
 * and talks to it over Node IPC. When QuickBooks dies under a COM call,
 * the native layer can crash the calling process outright: observed live on
 * 2026-10-05, a segfault (exit 139) after QuickBooks was ended in Task
 * Manager. Here that kills only this helper; the server sees the exit,
 * treats it as "QuickBooks went away", and its crash recovery starts a
 * fresh helper.
 *
 * Protocol (one request at a time is fine; COM calls are synchronous):
 *   parent → { id, op: "open", appId, appName, connectionType }
 *          → { id, op: "begin", companyFile, fileMode }      → ticket
 *          → { id, op: "process", ticket, xml }              → response XML
 *          → { id, op: "end", ticket }
 *          → { id, op: "close" }
 *   child  → { id, ok: true, result } | { id, ok: false, error }
 *          → { ready: true } once winax has loaded, or { fatal } on load failure
 */

type Rp = Record<string, (...args: unknown[]) => unknown>;
type Msg =
  | { id: number; op: "open"; appId: string; appName: string; connectionType: number }
  | { id: number; op: "begin"; companyFile: string; fileMode: number }
  | { id: number; op: "process"; ticket: string; xml: string }
  | { id: number; op: "end"; ticket: string }
  | { id: number; op: "close" };

const send = (m: unknown) => { if (process.send) process.send(m); };

async function main(): Promise<void> {
  let ActiveXObject: (new (progId: string) => Rp) | undefined;
  try {
    const winax = (await import("winax")) as unknown as { Object?: new (p: string) => Rp; default?: { Object?: new (p: string) => Rp } };
    ActiveXObject = winax.Object ?? winax.default?.Object;
    if (!ActiveXObject) throw new Error("winax loaded but does not expose an `Object` constructor (incompatible winax version)");
  } catch (err) {
    send({ fatal: `winax module not available: ${(err as Error).message}. Live mode needs Node 20.x with winax built (scripts/setup-qb-pc.ps1).` });
    process.exit(1);
  }

  let rp: Rp | null = null;
  send({ ready: true });

  process.on("message", (raw: unknown) => {
    const m = raw as Msg;
    try {
      let result: unknown = null;
      switch (m.op) {
        case "open":
          rp = new ActiveXObject!("QBXMLRP2.RequestProcessor");
          rp.OpenConnection2(m.appId, m.appName, m.connectionType);
          break;
        case "begin":
          if (!rp) throw new Error("no QBXMLRP2 connection is open");
          result = rp.BeginSession(m.companyFile, m.fileMode);
          break;
        case "process":
          if (!rp) throw new Error("no QBXMLRP2 connection is open");
          result = rp.ProcessRequest(m.ticket, m.xml);
          break;
        case "end":
          if (rp) rp.EndSession(m.ticket);
          break;
        case "close":
          if (rp) rp.CloseConnection();
          rp = null;
          break;
        default:
          throw new Error(`unknown op ${(m as { op?: string }).op}`);
      }
      send({ id: m.id, ok: true, result: result == null ? null : String(result) });
    } catch (err) {
      send({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Parent gone → nothing left to serve.
  process.on("disconnect", () => process.exit(0));
}

void main();
