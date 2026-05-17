/**
 * Preferences tools for QuickBooks Desktop MCP — Phase 18 #85 (closing date).
 *
 * Wraps `PreferencesQueryRq` to surface the closing-date / year-end-lock state
 * of the active company file. The qbXML SDK exposes preferences as a
 * read-only surface: `PreferencesModRq` (or `AccountingPreferencesModRq`) does
 * NOT exist at any qbXML version through 16.0 — verified against the qbwc/qbxml
 * master mirrors of Intuit's official SDK XSDs (qbxmlops20.xml through
 * qbxmlops140.xml; `grep ClosingDatePassword` returns zero hits across all
 * versions). See DECISIONS.md 2026-05-12 #85 for source citations.
 *
 * Two tools:
 *   • qb_closing_date_get — real wire read; returns ISO date (or null) +
 *     audit-trail flag from AccountingPreferences.
 *   • qb_closing_date_set — informational stub; fails fast with statusCode
 *     9005 + explicit UI navigation steps. Surfaced as a tool (rather than
 *     omitted) so an agent that thinks "I should set the closing date" gets
 *     routed correctly instead of hallucinating an arbitrary mutation.
 *
 * The SDK gap is permanent — Intuit has never shipped a write path for
 * company preferences. If a future qbXML version (17.0+) adds one, replace
 * the informational handler with a real builder call; the synthetic 9005
 * code can be retired or repurposed.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";
import { formatToolError } from "../util/format-tool-error.js";
import { ISO_DATE_RE } from "../util/validators.js";

/**
 * Normalize the raw `PreferencesRet.AccountingPreferences.ClosingDate` field
 * into an ISO YYYY-MM-DD string (or null when unset).
 *
 * qbXML DATETYPE elements come back from fast-xml-parser as either:
 *   - a string `"2024-12-31"` (most common — the wire format is already ISO),
 *   - `null` / `undefined` (no closing date set),
 *   - an empty object `{}` (some QB versions emit `<ClosingDate/>` self-closing
 *     when the field is empty — fast-xml-parser converts that to `{}`).
 *
 * Anything that isn't a non-empty ISO date string normalizes to null. The
 * regex is the same one used for ISO date validation across the codebase.
 */
export function normalizeClosingDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return ISO_DATE_RE.test(trimmed) ? trimmed : null;
}

export function registerPreferenceTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  // -----------------------------------------------------------------------
  // qb_closing_date_get — wraps PreferencesQueryRq
  // -----------------------------------------------------------------------
  //
  // Reads the company file's closing-date / year-end-lock state plus a few
  // adjacent accounting-preferences flags (audit trail, class tracking) that
  // an agent doing audit work would commonly want alongside the date.
  //
  // The response carries `closingDate: string | null` — null means "no
  // closing date set" (most common mid-year). When set, transactions dated
  // on-or-before this date are protected by QB Desktop's password gate (if
  // configured) — the password-set flag itself is NOT surfaced by qbXML at
  // any version, so this tool cannot tell you whether the date is
  // password-protected, only whether it exists.
  //
  // Read-only safe; no read-only-session gate needed.
  server.tool(
    "qb_closing_date_get",
    "Read the company file's closing date (year-end lock) and adjacent accounting preferences via PreferencesQueryRq. Returns `closingDate` (ISO YYYY-MM-DD, or null if no closing date is set) plus `isUsingAuditTrail` / `isUsingClassTracking` / `isUsingAccountNumbers` flags from AccountingPreferences. The qbXML SDK does NOT expose the closing-date password status at any version — this tool cannot tell you whether the date is password-protected, only whether it exists. There is no write path for the closing date; qb_closing_date_set returns instructions to set it in QB Desktop's UI.",
    {},
    async () => {
      const session = getSession();
      try {
        const records = await session.queryEntity("Preferences", {});
        const prefs = (records[0] ?? {}) as Record<string, unknown>;
        const acctRaw = (prefs.AccountingPreferences ?? {}) as Record<string, unknown>;
        const closingDate = normalizeClosingDate(acctRaw.ClosingDate);
        // Boolean fields use loose truthy on the string "true" (wire form)
        // and boolean true (sim form) — matches the IncludeLineItems-style
        // coercion used elsewhere in this codebase.
        const flag = (v: unknown): boolean =>
          v === true || String(v ?? "").toLowerCase() === "true";
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              closingDate,
              isUsingAuditTrail: flag(acctRaw.IsUsingAuditTrail),
              isUsingClassTracking: flag(acctRaw.IsUsingClassTracking),
              isUsingAccountNumbers: flag(acctRaw.IsUsingAccountNumbers),
              isRequiringAccounts: flag(acctRaw.IsRequiringAccounts),
              note: closingDate === null
                ? "No closing date set. Prior-period transactions are unprotected."
                : `Closing date set to ${closingDate}. Transactions on or before this date are protected (password gate, if configured).`,
              simulationMode: session.isSimulation(),
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "PreferencesQueryRq failed" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // qb_closing_date_set — informational stub (SDK has no write path)
  // -----------------------------------------------------------------------
  //
  // The qbXML SDK has no PreferencesModRq / AccountingPreferencesModRq /
  // CompanyActivityModRq request at any version through 16.0 (verified
  // against the qbwc/qbxml master schema mirrors). The closing date is
  // exclusively a UI-managed setting — Intuit's long-standing posture is
  // "preferences are read-only via the SDK."
  //
  // Rather than omitting the tool entirely, surface it as a fail-fast
  // informational stub: an agent that decides "I should call qb_closing_date_set"
  // gets routed to the QB Desktop navigation path instead of inventing a
  // non-existent mutation. The error is structured (statusCode 9005,
  // humanReadable from qb-status-codes.ts) and the response carries the
  // exact UI path the operator (or the user the agent is helping) must
  // follow.
  //
  // No wire I/O is performed; this is a pure client-side tool. The
  // closingDate arg is validated against ISO YYYY-MM-DD purely so the error
  // surface can quote it back in the user-facing message — a malformed date
  // gets a Zod-level rejection before the tool body runs.
  server.tool(
    "qb_closing_date_set",
    "Informational tool — the qbXML SDK does NOT expose a write path for the company-file closing date at any version through 16.0 (PreferencesModRq / AccountingPreferencesModRq do not exist in the schema). This tool always fails with statusCode 9005 and returns explicit QB Desktop UI navigation steps so an agent thinking 'I should set the closing date' routes the user correctly instead of hallucinating a non-existent mutation. Use qb_closing_date_get to READ the current closing date — that path works.",
    {
      closingDate: z.string().regex(ISO_DATE_RE).describe("Target closing date in ISO YYYY-MM-DD format. Quoted back in the response so the user-facing message tells them exactly what to set in QB Desktop. Validated for shape only — not actually applied (the SDK has no write path)."),
      password: z.string().optional().describe("Optional closing-date password the operator wants to apply. Quoted back in the response (NOT logged to disk by the tool surface; if QB_DEBUG_QBXML is enabled, the request envelope is not built and the password never reaches the wire). Same outcome as without it — the tool returns instructions and exits."),
    },
    async ({ closingDate, password }) => {
      // No wire call. Direct fail-fast response carrying UI navigation +
      // synthetic 9005 status code.
      const passwordHint = password
        ? `Then click "Set Password..." and enter "${password}" in the Closing Date Password field; confirm; click OK.`
        : 'Optionally click "Set Password..." to require a password for backdated entries; click OK.';
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            statusCode: 9005,
            statusMessage: "Closing date cannot be set via the QuickBooks Desktop SDK",
            humanReadable: qbStatusCodeMessage(9005),
            requestedClosingDate: closingDate,
            uiInstructions: [
              "Open QuickBooks Desktop with the target company file loaded.",
              "From the menu bar, choose: Edit → Preferences.",
              "In the left-hand list, select \"Accounting\".",
              "Switch to the \"Company Preferences\" tab (top of the dialog).",
              "Under \"Closing date\", click \"Set Date/Password...\".",
              `In the Closing Date field, enter ${closingDate}.`,
              passwordHint,
              "Click OK on the Preferences dialog.",
              "Re-run qb_closing_date_get to confirm the new closing date is reported.",
            ],
            sdkLimitation: "qbXML schema (qbxmlops20.xml through qbxmlops140.xml) has no PreferencesModRq, AccountingPreferencesModRq, or CompanyActivityModRq element. Intuit has not shipped a write path for company preferences at any version through QB Desktop 2024 / qbXML 16.0.",
            workaround: "If the closing-date set must be automated, the QuickBooks Desktop UI must be driven by an external automation layer (e.g. UI Automation / SendKeys against the running QB instance). No QBXML or QBFC equivalent exists.",
          }, null, 2),
        }],
        isError: true,
      };
    }
  );
}
