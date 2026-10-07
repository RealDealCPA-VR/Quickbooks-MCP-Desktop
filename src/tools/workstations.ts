/**
 * Hub-only tools: which QuickBooks workstations exist and which one this
 * agent uses (docs/CONNECTOR_DESIGN.md). Registered only when the server
 * runs as a hub. Both are callable by any connected agent: they expose no
 * books data, and another workstation's open file is shown only when this
 * device may use that file.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { WorkstationContext } from "../hub/sessions.js";
import { authorizedCompanyFiles, type CallerIdentity } from "../util/caller-authorization.js";
import { normalizeCompanyPath } from "../util/qb-credentials.js";

function text(body: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], ...(isError ? { isError: true } : {}) };
}

export function registerWorkstationTools(server: McpServer, ctx: WorkstationContext, identity: CallerIdentity): void {
  const visible = (file: string | null): string | null => {
    if (!file) return null;
    const allowed = authorizedCompanyFiles(identity);
    return allowed === "all" || allowed.has(normalizeCompanyPath(file)) ? file : "(a file this device is not authorized for)";
  };

  server.tool(
    "qb_workstation_list",
    "List the QuickBooks workstations behind this hub: online/offline, which is the default, which one YOUR requests go to (usedByYou), whether it is your own PC, and the company file each has open. Requests go to your own PC when it is an online workstation, otherwise to the default, unless you chose one with qb_workstation_use or qb_company_open's workstation argument.",
    {},
    async () => {
      const cur = ctx.current();
      return text({
        usingWorkstation: cur.name,
        chosenExplicitly: cur.pinned,
        workstations: ctx.list().map((w) => ({ ...w, openCompanyFile: visible(w.openCompanyFile) })),
        routing: "Own PC (if it is an online workstation) → otherwise the default workstation. qb_workstation_use or qb_company_open({ workstation }) overrides this for your connection.",
      });
    },
  );

  server.tool(
    "qb_workstation_use",
    "Send this agent connection's QuickBooks requests to a specific workstation (by name from qb_workstation_list), e.g. the one that already has a company file open. Pass 'default' to return to automatic routing. Affects only your connection; the choice lasts until you change it or disconnect.",
    {
      workstation: z.string().min(1).describe("Workstation name from qb_workstation_list, or 'default' for automatic routing."),
    },
    async ({ workstation }) => {
      try {
        const r = ctx.use(workstation);
        const cur = ctx.current();
        return text({
          success: true,
          usingWorkstation: r.name,
          chosenExplicitly: r.pinned,
          online: cur.online,
          openCompanyFile: visible(ctx.list().find((w) => w.id === r.id)?.openCompanyFile ?? null),
          ...(cur.online ? {} : { warning: `${r.name ?? "No workstation"} is offline: QuickBooks requests will fail with 9012 until its connector runs.` }),
        });
      } catch (err) {
        const e = err as { message: string; statusCode?: number; reason?: string };
        return text({ success: false, statusCode: e.statusCode ?? 9012, reason: e.reason ?? "unknown-workstation", statusMessage: e.message }, true);
      }
    },
  );
}
