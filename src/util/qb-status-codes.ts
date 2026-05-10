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
  3030: "Journal entry debits and credits do not balance",
  3120: "Required field missing or invalid value",
  3170: "Modify rejected — record was changed since last read (stale EditSequence)",
  3260: "Insufficient permission — the operation is blocked (commonly: cannot delete a record with transaction history)",
  // 9001 — synthetic, client-side. Distinct from QB-server-side 3260
  // ("insufficient permission") so agents can tell read-only-mode rejections
  // apart from real QB role-permission denials. Issued by QBReadOnlyError
  // in src/session/manager.ts (Phase 10 #42).
  9001: "Read-only session — mutation blocked by client gate. Reconnect with qb_session_connect({ readOnly: false }) to re-enable writes.",
};

export function qbStatusCodeMessage(statusCode: number): string | undefined {
  return TABLE[statusCode];
}
