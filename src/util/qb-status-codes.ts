/**
 * Human-readable mapping for the QBXML status codes the server actually
 * encounters. Looked up by the structured-error wrappers in `src/tools/*.ts`
 * when a `session.queryEntity / addEntity / modifyEntity / deleteEntity` call
 * throws a `QBXMLResponseError` (or anything carrying a `statusCode`).
 *
 * Scope:
 * - Codes the simulation store emits today (500, 3030, 3120, 3170) — confirmed
 *   exhaustive by `grep -E "statusCode: [0-9]" src/session/simulation-store.ts`.
 * - 3260 is included for forward-compat with live mode (real QB returns it
 *   when an account/employee has transaction history that blocks hard delete).
 * - 0 (success) and 1 (no records — the parser converts to `{}`, never throws)
 *   are intentionally absent: neither reaches the error wrapper.
 *
 * The wrapper only attaches `humanReadable` when this returns a string, so
 * unknown codes (including the `-1` fallback) silently produce no field.
 */

const TABLE: Record<number, string> = {
  500: "Object not found in QuickBooks",
  // 3000 + 3110 added 2026-05-17 after Phase 14 #65 live verification surfaced
  // them against `VR Tax & Consulting Inc..qbw`:
  //   - 3000 fires for invalid object IDs (e.g. bogus TxnID on a Mod call).
  //     QB's message format: 'The given object ID "X" in the field "Y" is invalid.'
  //   - 3110 fires for invalid enum values (e.g. PaidStatus="NotARealEnum"). QB
  //     surfaces the field name in quotes; the #65 hint heuristic extracts it.
  3000: "Invalid object identifier — the given ID does not resolve to a record (often a stale TxnID or ListID)",
  3030: "Journal entry debits and credits do not balance",
  3110: "Invalid enumerated value or argument — the supplied value is not allowed for this field at the current qbXML version",
  3120: "Required field missing or invalid value",
  3170: "Modify rejected — record was changed since last read (stale EditSequence)",
  3260: "Insufficient permission — the operation is blocked (commonly: cannot delete a record with transaction history)",
  // 9001 — synthetic, client-side. Distinct from QB-server-side 3260
  // ("insufficient permission") so agents can tell read-only-mode rejections
  // apart from real QB role-permission denials. Issued by QBReadOnlyError
  // in src/session/manager.ts (Phase 10 #42).
  9001: "Read-only session — mutation blocked by client gate. Reconnect with qb_session_connect({ readOnly: false }) to re-enable writes.",
  // 9002 — synthetic, client-side. Issued by QBIdempotencyKeyConflictError
  // in src/session/manager.ts (Phase 10 #47) when a previously-seen
  // idempotency key is reused with a DIFFERENT request payload. Replaying
  // with the exact original payload returns the cached result silently;
  // diverging payloads under the same key is treated as a caller bug.
  9002: "Idempotency key conflict — a different request was already processed under this key. Use a fresh idempotency key, or replay with the exact original payload.",
  // 9003 — synthetic, client-side. Issued by qb_w2_summary (Phase 11 #55)
  // when the resolved edition is "Pro". The QBXML SDK technically allows
  // PayrollSummaryReportQueryRq on Pro builds, but in practice Pro does not
  // ship with payroll-subscription-eligible features (Pro Plus / Premier
  // Plus / Enterprise are the supported tiers post-2022). Surfaced as a
  // pre-flight error so the caller can avoid a wire round trip that would
  // either return empty data or a confusing QB-side subscription error.
  9003: "Edition does not support QB Payroll. Pro builds (without Plus) do not surface payroll data via the SDK; upgrade to Pro Plus, Premier Plus, or Enterprise for payroll features.",
  // 9004 — synthetic, client-side. Issued by qb_w2_summary when the wire
  // call succeeds but returns no payroll data (statusCode 1 / empty
  // EmployeeWagesTaxesRet) OR when QB returns a known payroll-subscription
  // error pattern. Distinguishes "no payroll subscription" from "no
  // matching employees" — the first means the operator can't get W-2 data
  // until they subscribe; the second is a legitimate empty result.
  9004: "QB Payroll subscription required or not active. PayrollSummaryReportQueryRq returned no data — verify the subscription status in QB Desktop (Employees → My Payroll Service → Account/Billing Info) before retrying.",
  // 9005 — synthetic, client-side. Issued by qb_closing_date_set (Phase 18 #85)
  // because the qbXML SDK does NOT expose a write path for the closing date
  // (no PreferencesModRq / AccountingPreferencesModRq exists at any qbXML
  // version through 16.0 — verified against the qbwc/qbxml master mirrors of
  // Intuit's official SDK XSDs). The tool fails fast with this code and
  // returns explicit UI navigation steps in its response. Reads of the
  // closing date work normally via qb_closing_date_get.
  9005: "Closing date cannot be set via the QuickBooks Desktop SDK. The qbXML schema has no write path for company preferences (PreferencesModRq does not exist at any version). Set the closing date manually in QB Desktop under Edit → Preferences → Accounting → Company Preferences → Set Date/Password. Read access via qb_closing_date_get is supported.",
};

export function qbStatusCodeMessage(statusCode: number): string | undefined {
  return TABLE[statusCode];
}
