/**
 * Shared input-format regex constants used by zod schemas across `src/tools/*.ts`.
 *
 * Goal: reject obvious garbage at the schema layer so QB doesn't have to surface
 * cryptic 3120 errors. These regexes are intentionally permissive — they catch
 * shape errors (a Date string that isn't a date, an email missing the `@`), not
 * full RFC compliance. QB itself will further validate on the live side.
 *
 * `ISO_DATE_RE` is the one strict pattern: the format is unambiguous and the
 * simulation store already pre-validates with the same shape.
 */

// Strict — `YYYY-MM-DD`. Used by every TxnDate / DueDate / fromDate / toDate /
// asOfDate / hiredDate / etc. across the tool surface.
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Permissive shape check — `something@something.something` with no whitespace
// and no `@` inside parts. NOT RFC 5322 compliant; that's intentional.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Permissive — digits, spaces, parens, dashes, plus, dots. Letters out.
// Minimum 7 chars (shortest plausible domestic phone).
export const PHONE_RE = /^[\d\s().+\-]{7,}$/;

// Permissive — covers US ZIP (5), US ZIP+4 (5-4), CA (A1A 1A1), UK (varies),
// EU (numerics). Alphanumeric start, then alphanumeric / space / dash, length
// 3-10.
export const POSTAL_RE = /^[\dA-Za-z][\dA-Za-z\s-]{2,9}$/;
