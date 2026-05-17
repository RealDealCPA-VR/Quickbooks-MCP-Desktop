/**
 * Tool-side error wrapper (Phase 14 #65).
 *
 * Before this module landed, every tool's catch block returned the same
 * four-field error payload by hand (`{success:false, statusCode,
 * statusMessage, humanReadable?}`) and most cryptic QB errors — especially
 * the `statusCode -1` "QuickBooks found an error when parsing the provided
 * XML text stream" — surfaced with `humanReadable` absent because the
 * code-table lookup only had entries for the well-known status codes (500 /
 * 3120 / 3170 / etc.) and the synthetic codes (9001–9005).
 *
 * `formatToolError` produces the same shape callers used to build inline,
 * plus an optional `hint` object derived from heuristic pattern-matching
 * the QB status message. The four patterns covered map directly to the
 * spec in todo.md item #65:
 *
 *     "missing element: X"        → kind=missing-element, field=X
 *     "invalid argument <X>" /
 *     "invalid value: X"          → kind=invalid-argument, field=X
 *     "out of order: X" /
 *     "X is invalid because it is
 *     out of order"               → kind=out-of-order, field=X
 *     "invalid reference to
 *     QuickBooks X"               → kind=invalid-ref, field=X
 *
 * When the offending field appears in any `SCHEMA_ORDER` sequence (see
 * `./qbxml-schema-order.ts`), the hint also carries the canonical child
 * order for every request type that declares the field — the agent can
 * compare its payload against the canonical sequence and reorder /
 * fill the gap without round-tripping back through manual debugging.
 *
 * The wrapper degrades gracefully:
 *   - statusCode known + no heuristic match → humanReadable from the table,
 *     no hint
 *   - statusCode unknown + heuristic match → humanReadable derived from
 *     the hint kind, hint surfaces field name + (if known) schema-order
 *   - statusCode unknown + no heuristic match → bare statusCode +
 *     statusMessage (unchanged from prior behavior)
 *
 * Sensitive: the wrapper NEVER swallows the original wire message. The
 * heuristic is additive — `statusMessage` is always the QB-supplied text
 * verbatim. If the heuristic misfires, the agent can still read the
 * original message and decide what to do.
 */

import { qbStatusCodeMessage } from "./qb-status-codes.js";
import { findSchemaOrderForField } from "./qbxml-schema-order.js";

// QB error messages quote a field name using the HUMAN DISPLAY LABEL
// (the same label that appears in QB Desktop's UI), not the XML element
// name. The schema-order lookup keys on XML element names, so we
// normalize known display labels to their element-name equivalents
// before the lookup. Conservative — only labels observed live during
// #65 verification are listed; extend as new ones surface.
const DISPLAY_LABEL_TO_ELEMENT: Record<string, string> = {
  "Transaction id": "TxnID",
  "List id": "ListID",
  "Edit sequence": "EditSequence",
  "Ref number": "RefNumber",
  "Full name": "FullName",
  "Account ref": "AccountRef",
  "Customer ref": "CustomerRef",
  "Vendor ref": "VendorRef",
  "Item ref": "ItemRef",
  "Class ref": "ClassRef",
  "Txn line id": "TxnLineID",
  "Modified date": "TimeModified",
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type QbErrorHintKind =
  | "missing-element"
  | "invalid-argument"
  | "out-of-order"
  | "invalid-ref"
  | "empty-element";

export interface QbErrorHint {
  /** Pattern class detected in the QB status message. */
  kind: QbErrorHintKind;
  /** Offending field name extracted from the message. */
  field: string;
  /**
   * Canonical schema-order sequences for request types that declare
   * `field`. Empty when `field` is not in any pinned sequence.
   */
  schemaOrder: { request: string; sequence: readonly string[] }[];
  /**
   * Short imperative description the agent can act on. Derived from the
   * `kind` + `field` + `schemaOrder` — never includes the raw QB message
   * (that lives in `statusMessage`).
   */
  guidance: string;
}

export interface ToolErrorPayload {
  success: false;
  statusCode: number;
  statusMessage: string;
  humanReadable?: string;
  hint?: QbErrorHint;
}

export interface ToolErrorResponse {
  content: { type: "text"; text: string }[];
  isError: true;
  // MCP SDK's server.tool callback expects a return shape with an open
  // string-indexed signature (it merges in optional `_meta` etc.). Adding
  // it here keeps the helper's return type assignable at every callsite
  // without per-tool casts.
  [key: string]: unknown;
}

export interface FormatToolErrorOptions {
  /**
   * Message used when the thrown value doesn't carry one (e.g. a non-Error
   * object). Defaults to "Operation failed". Tools usually pass a
   * request-specific fallback like `"CustomerQueryRq failed"`.
   */
  fallbackMessage?: string;
  /**
   * Extra fields to merge INTO the JSON payload (e.g. `entries: [...]` on
   * batch tools that want to surface per-entry status). Reserved keys
   * (`success`, `statusCode`, `statusMessage`, `humanReadable`, `hint`)
   * cannot be overridden — the wrapper ignores any collision.
   */
  extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Heuristic — internal
// ---------------------------------------------------------------------------

interface PatternRule {
  kind: QbErrorHintKind;
  /**
   * Each rule supplies a list of regexes — first match wins across the
   * whole rule set, with rules ordered by specificity (more specific
   * patterns first to avoid invalid-argument absorbing what should be
   * out-of-order).
   */
  patterns: RegExp[];
}

// Field names QB puts inside the error message are usually angle-bracketed
// or capitalized identifiers. The patterns extract conservatively — they
// fail closed (heuristic returns null) rather than fabricate a field name
// from arbitrary words.
const FIELD = "([A-Z][A-Za-z0-9]+)";

// Regex casing strategy: explicit `[Ii]` / `[Tt]` for the prefix words QB
// inconsistently capitalizes (sentence-start vs mid-sentence). The `i`
// flag is NOT used because the FIELD pattern (`[A-Z][A-Za-z0-9]+`) relies
// on case-sensitivity to extract only capitalized QBXML identifiers and
// reject arbitrary lowercase words.
const RULES: readonly PatternRule[] = [
  // OUT-OF-ORDER variants first — "out of order" can co-occur with
  // "invalid", and the more specific kind should win.
  {
    kind: "out-of-order",
    patterns: [
      // "Element <FieldName> is out of order" / "The element <FieldName> is out of order"
      new RegExp(`(?:[Tt]he\\s+)?[Ee]lement\\s+(?:<)?${FIELD}(?:>)?[^.]*?out of order`),
      // "out of order: FieldName"
      new RegExp(`out of order[^a-zA-Z]+${FIELD}`),
      // "FieldName ... appears in the wrong order"
      new RegExp(`(?:<)?${FIELD}(?:>)?\\s+appears? in the wrong order`),
    ],
  },
  // MISSING-ELEMENT variants.
  {
    kind: "missing-element",
    patterns: [
      // "There is a missing element: FieldName"
      new RegExp(`missing element[^a-zA-Z]+${FIELD}`),
      // "The element <FieldName> is required"
      new RegExp(`(?:[Tt]he\\s+)?[Ee]lement\\s+(?:<)?${FIELD}(?:>)?[^.]*?(?:is required|missing)`),
      // "A required field is missing: FieldName"
      new RegExp(`[Rr]equired (?:field|element)[^:]*:\\s*(?:<)?${FIELD}(?:>)?`),
    ],
  },
  // EMPTY-ELEMENT — distinct from missing-element. QB rejects empty tags
  // for several required-and-non-nullable fields.
  {
    kind: "empty-element",
    patterns: [
      new RegExp(`(?:[Tt]he\\s+)?(?:XML\\s+)?[Ee]lement\\s+(?:<)?${FIELD}(?:>)?[^.]*?(?:is empty|cannot be empty)`),
    ],
  },
  // INVALID-REF — "There is an invalid reference to QuickBooks X", or
  // "The given object ID ... in the field "Transaction id" is invalid"
  // (canonical QB form, captured live during #65 verification — uses
  // double quotes around the field name and the human display label,
  // not the XML element name).
  {
    kind: "invalid-ref",
    patterns: [
      new RegExp(`[Ii]nvalid reference[^a-zA-Z]+(?:to (?:QuickBooks |a )?)?${FIELD}`),
      // "The given object ID "X" in the field "Y" is invalid" — captures Y.
      new RegExp(`object ID[^"]*"[^"]*"\\s+in the field\\s+"([^"]+)"\\s+is invalid`),
      new RegExp(`(?:<)?${FIELD}(?:>)?\\s+(?:does not exist|was not found|could not be found)`),
    ],
  },
  // INVALID-ARGUMENT — most general; ordered last so the more specific
  // rules above win when a message matches multiple.
  {
    kind: "invalid-argument",
    patterns: [
      // QB's most common live form (verified during #65 verification):
      //   The enumerated value "X" in the field "PaidStatus" is unknown or invalid
      //   The provided value "X" in the field "Y" is invalid
      // Captures the field name (PaidStatus / Y) — what the agent needs
      // to identify and re-supply.
      new RegExp(`(?:enumerated|provided)?\\s*value\\s+"[^"]+"\\s+in the field\\s+"([^"]+)"`),
      // "There is an invalid argument <FieldName>"
      new RegExp(`[Ii]nvalid argument[^a-zA-Z<]*<?${FIELD}>?`),
      // "Invalid value for FieldName" / "Invalid value of FieldName"
      new RegExp(`[Ii]nvalid value\\s+(?:for|of)\\s+(?:<)?${FIELD}(?:>)?`),
      // "invalid value: FieldName" — punctuation-separated form
      new RegExp(`[Ii]nvalid value[:\\s,]+(?:<)?${FIELD}(?:>)?`),
      // "The value of FieldName is invalid"
      new RegExp(`value of\\s+(?:<)?${FIELD}(?:>)?\\s+is invalid`),
    ],
  },
];

/**
 * Detect the QB error pattern in `message` and extract the offending field.
 * Returns null when no rule matches. Exported for unit testing — most
 * callers go through `formatToolError`.
 */
export function parseQbErrorHint(message: string): Omit<QbErrorHint, "schemaOrder" | "guidance"> | null {
  if (!message) return null;
  for (const rule of RULES) {
    for (const re of rule.patterns) {
      const m = message.match(re);
      if (m && m[1]) {
        return { kind: rule.kind, field: m[1] };
      }
    }
  }
  return null;
}

/**
 * Build the imperative guidance string from the structured hint. Pure
 * helper — no I/O, no side effects.
 */
function buildGuidance(
  kind: QbErrorHintKind,
  field: string,
  schemaOrder: { request: string; sequence: readonly string[] }[],
): string {
  let ownerHint = "";
  if (schemaOrder.length === 1) {
    ownerHint = ` Field belongs to ${schemaOrder[0].request}; canonical child order: ${schemaOrder[0].sequence.join(" → ")}.`;
  } else if (schemaOrder.length > 1) {
    // Cap the listed names so the guidance string stays scannable for a
    // common field like TxnID (~20 transaction *QueryRq candidates). The
    // structured `schemaOrder` array still carries all candidates for
    // programmatic consumers; the guidance just summarizes.
    const PREVIEW = 3;
    const names = schemaOrder.slice(0, PREVIEW).map((s) => s.request).join(", ");
    const tail = schemaOrder.length > PREVIEW ? ` and ${schemaOrder.length - PREVIEW} more` : "";
    ownerHint = ` Field appears in ${schemaOrder.length} request types (${names}${tail}); see hint.schemaOrder for the full list and the canonical sequence for the one you're calling.`;
  }
  switch (kind) {
    case "missing-element":
      return `QB rejected the request because <${field}> is required but absent.${ownerHint}`;
    case "out-of-order":
      return `QB rejected the request because <${field}> appeared in the wrong position relative to its siblings.${ownerHint} Reorder your filter dict to match.`;
    case "invalid-argument":
      return `QB rejected the value passed for <${field}>.${ownerHint} Check the field's allowed values / format.`;
    case "invalid-ref":
      return `QB could not resolve the reference passed in <${field}> (likely a stale ListID or FullName).${ownerHint} Re-query the parent list and retry with a current identifier.`;
    case "empty-element":
      return `QB rejected the request because <${field}> was present but empty.${ownerHint} Either omit the element entirely or supply a non-empty value.`;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const RESERVED_KEYS = new Set([
  "success",
  "statusCode",
  "statusMessage",
  "humanReadable",
  "hint",
]);

/**
 * Build the standard tool error response from a thrown value. The thrown
 * value is expected to be a `QBXMLResponseError` (or any object with
 * `message` + `statusCode`) but degrades safely for arbitrary throws.
 */
export function formatToolError(
  err: unknown,
  options: FormatToolErrorOptions = {},
): ToolErrorResponse {
  const e = (err ?? {}) as { message?: string; statusCode?: number };
  const statusCode = typeof e.statusCode === "number" ? e.statusCode : -1;
  const statusMessage =
    typeof e.message === "string" && e.message.length > 0
      ? e.message
      : options.fallbackMessage ?? "Operation failed";

  let humanReadable = qbStatusCodeMessage(statusCode);
  let hint: QbErrorHint | undefined;

  // The heuristic runs for ANY statusCode whose message looks parsable —
  // not just -1. Real QB sometimes returns 3120 ("missing field") with
  // the offending field name in the message, and surfacing the canonical
  // schema-order is just as useful there.
  const parsed = parseQbErrorHint(statusMessage);
  if (parsed) {
    // If the heuristic captured a human display label (e.g. "Transaction id")
    // rather than an XML element name (e.g. "TxnID"), normalize before the
    // schema-order lookup. Failed normalization → schemaOrder is empty,
    // hint surfaces kind + label-as-extracted + guidance anyway.
    const lookupField = DISPLAY_LABEL_TO_ELEMENT[parsed.field] ?? parsed.field;
    const schemaOrder = findSchemaOrderForField(lookupField);
    const guidance = buildGuidance(parsed.kind, parsed.field, schemaOrder);
    hint = { kind: parsed.kind, field: parsed.field, schemaOrder, guidance };
    // When the table didn't supply a humanReadable (most common for -1),
    // promote the guidance to humanReadable so single-line consumers see
    // something useful without descending into the hint object.
    if (!humanReadable) {
      humanReadable = guidance;
    }
  }

  const payload: ToolErrorPayload = {
    success: false,
    statusCode,
    statusMessage,
    ...(humanReadable ? { humanReadable } : {}),
    ...(hint ? { hint } : {}),
  };

  // Merge non-reserved extras. Reserved keys cannot be overridden — the
  // wrapper's invariant is that callers can ADD fields, not redefine the
  // standard error envelope.
  let merged: Record<string, unknown> = { ...payload };
  if (options.extra) {
    for (const [k, v] of Object.entries(options.extra)) {
      if (!RESERVED_KEYS.has(k)) merged[k] = v;
    }
  }

  return {
    content: [{ type: "text", text: JSON.stringify(merged) }],
    isError: true,
  };
}
