/**
 * QuickBooks health + crash recovery tools.
 *
 * QuickBooks Desktop on the operator's machine sometimes crashes, freezes
 * on a large report, stops on a dialog, or hands off to File Doctor. These
 * tools let an agent see which of those is happening (qb_health) and
 * re-engage (qb_session_recover). Reads also recover automatically: see
 * QBSessionManager.sendRequest.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { getActivity } from "../util/activity-log.js";
import { formatToolError } from "../util/format-tool-error.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";

function errorResult(err: unknown, fallback: string) {
  const e = err as { message?: string; statusCode?: number; reason?: string; recommendedAction?: string; underlyingMessage?: string };
  if (typeof e?.statusCode === "number" && e.statusCode >= 9000) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: false,
          statusCode: e.statusCode,
          statusMessage: e.message ?? fallback,
          ...(e.reason ? { reason: e.reason } : {}),
          ...(e.recommendedAction ? { recommendedAction: e.recommendedAction } : {}),
          ...(e.underlyingMessage ? { underlyingMessage: e.underlyingMessage } : {}),
          ...(qbStatusCodeMessage(e.statusCode) ? { humanReadable: qbStatusCodeMessage(e.statusCode) } : {}),
        }, null, 2),
      }],
      isError: true,
    };
  }
  return formatToolError(err, { fallbackMessage: fallback });
}

export function registerHealthTools(server: McpServer, getSession: () => QBSessionManager): void {
  server.tool(
    "qb_health",
    "What QuickBooks is doing right now on the server computer: state (ready | login | dialog | not-responding | file-doctor | crashed | starting | not-running | unsupported), a plain-language summary, the recommended next step, the titles of any QuickBooks dialogs on screen, this server's session (connected file, last request, last error, last automatic recovery), and recent activity. Call it whenever a QuickBooks request fails unexpectedly or reports won't pull, BEFORE retrying. Reads run in about a second and never change anything.",
    {
      activityLimit: z.number().int().min(0).max(100).optional().describe("How many recent activity events to include (newest first). Default 15."),
    },
    async ({ activityLimit }) => {
      try {
        const session = getSession();
        const health = await session.getHost().health({ fresh: true });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              state: health.state,
              summary: health.summary,
              recommendedAction: health.recommendedAction,
              ...(health.openCompanyTitle ? { openCompany: health.openCompanyTitle } : {}),
              dialogs: health.dialogs,
              quickbooksProcesses: health.raw.quickbooks.map((p) => ({ pid: p.pid, responding: p.responding, startedAt: p.startedAt })),
              fileDoctor: health.raw.fileDoctor,
              session: { ...session.getDiagnostics(), simulationMode: session.isSimulation() },
              recentActivity: getActivity(activityLimit ?? 15),
            }, null, 2),
          }],
        };
      } catch (err) {
        return errorResult(err, "Health check failed");
      }
    }
  );

  server.tool(
    "qb_session_recover",
    "Re-engage QuickBooks after it crashed, froze, was closed, or went through File Doctor: checks QuickBooks' health, then reconnects to the SAME company file. It starts QuickBooks and logs in with the saved login if needed. Refuses with statusCode 9010 (and says why) when a person must act first: File Doctor is still repairing the file (never reopen mid-repair), a QuickBooks dialog is waiting for an answer, or QuickBooks is frozen. For a frozen QuickBooks, pass forceCloseHungQuickBooks:true ONLY after the operator agrees: it kills QuickBooks (an unsaved form is lost), and only after it has stayed frozen for 10 more seconds. Read requests already recover automatically once; use this tool when that failed, after File Doctor finished, or when qb_health says to reconnect.",
    {
      forceCloseHungQuickBooks: z.boolean().optional().describe("Allow force-closing QuickBooks if Windows still reports it as not responding after a 10-second recheck. Get the operator's OK first. Default false."),
    },
    async ({ forceCloseHungQuickBooks }) => {
      try {
        const session = getSession();
        const s = await session.recover({ forceCloseHungQuickBooks: !!forceCloseHungQuickBooks, trigger: "qb_session_recover" });
        const launch = session.getLastSwitchLaunchInfo();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              companyFile: s.companyFile,
              openedAt: s.openedAt.toISOString(),
              ...(launch.launched ? { launched: true } : {}),
              ...(launch.loginAutofill ? { loginAutofill: launch.loginAutofill } : {}),
              message: "Reconnected. Retry the request that failed; for writes, look the record up first and use an idempotencyKey.",
            }, null, 2),
          }],
        };
      } catch (err) {
        return errorResult(err, "Recovery failed");
      }
    }
  );
}
