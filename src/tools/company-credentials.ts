/**
 * Company-file login tools (QuickBooks user name + password per .qbw).
 *
 * The operator enters logins and per-file tailnet authorizations on the
 * local web page served by src/web/server.ts. qb_company_credentials_edit
 * hands out (and, for the local operator, opens) that page.
 * qb_company_credentials_list reports what is saved. No tool ever returns a
 * password or its ciphertext: qb_company_open uses the saved login itself to
 * fill in QuickBooks' login window. See src/util/qb-credentials.ts.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { formatToolError } from "../util/format-tool-error.js";
import { LOCAL_STDIO_CALLER, type CallerIdentity } from "../util/caller-authorization.js";
import { getCredentialsFilePath, readCredentialSummaries } from "../util/qb-credentials.js";
import { getWebServerInfo, openInBrowser } from "../web/server.js";

export function registerCompanyCredentialTools(
  server: McpServer,
  _getSession: () => QBSessionManager,
  caller: CallerIdentity = LOCAL_STDIO_CALLER,
): void {
  server.tool(
    "qb_company_credentials_edit",
    "Get the address of the local QuickBooks MCP web page where the operator enters, views and changes the QuickBooks user name + password for each company file (.qbw), and chooses which tailnet devices may use each file. When called by the agent on the computer running this server, it also opens the page in that computer's browser; pass companyFile to open the page on that file. Saved logins show up already filled in, so the operator never re-enters them, and saving a change overwrites the old login. Passwords are encrypted for the operator's Windows account and are NEVER returned by any tool: qb_company_open uses them itself to log into QuickBooks. Never ask the operator to type a QuickBooks password into the chat; send them to this page instead.",
    {
      companyFile: z.string().optional().describe("Optional .qbw path to pre-select on the page (e.g. the file qb_company_open could not log into)."),
      openBrowser: z.boolean().optional().describe("Open the page in this computer's default browser. Default true for the local agent; ignored for remote tailnet agents (they get the URL only)."),
    },
    async ({ companyFile, openBrowser }) => {
      try {
        const info = getWebServerInfo();
        const q = companyFile ? `?file=${encodeURIComponent(companyFile)}` : "";
        const localUrl = `${info.pageUrls.find((u) => u.includes("127.0.0.1")) ?? info.pageUrls[0]}${q}`;
        const tailnetUrls = info.pageUrls.filter((u) => !u.includes("127.0.0.1")).map((u) => `${u}${q}`);
        const opened = caller.kind === "local" && openBrowser !== false;
        if (opened) openInBrowser(localUrl);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              pageUrl: caller.kind === "local" ? localUrl : tailnetUrls[0] ?? localUrl,
              ...(tailnetUrls.length ? { tailnetPageUrls: tailnetUrls } : {}),
              openedInBrowser: opened,
              message: opened
                ? "Opened the QuickBooks logins page in the operator's browser. Ask them to save the login there, then retry."
                : "Ask the operator to open this page on the computer running the QuickBooks MCP server (or one of their own tailnet devices) and save the login there.",
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "Failed to locate the QuickBooks logins page" });
      }
    }
  );

  server.tool(
    "qb_company_credentials_list",
    "List the company files that have a saved QuickBooks login or tailnet authorizations: companyFile, username, hasPassword, updatedAt, authorizedPeers (tailnet devices allowed to use the file remotely). Never returns passwords. For a remote tailnet agent, only files authorized for that device are listed. Use it to check whether qb_company_open can log into a file automatically; to add or change logins, use qb_company_credentials_edit.",
    {},
    async () => {
      try {
        const vaultPath = getCredentialsFilePath();
        const saved = readCredentialSummaries(vaultPath);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ...(caller.kind === "local" ? { vaultPath } : {}),
              count: saved.length,
              savedLogins: saved.map((s) => ({
                companyFile: s.companyFile,
                username: s.username,
                hasLogin: !!s.username,
                hasPassword: s.hasPassword,
                ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
                authorizedPeers: s.authorizedPeers.map((p) => ({ address: p.address, nodeName: p.nodeName, loginName: p.loginName })),
              })),
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "Failed to read the saved company logins" });
      }
    }
  );
}
