// Phase 14 #65 — one-shot codemod to collapse the inline error-wrapper
// boilerplate in every src/tools/*.ts file down to a single
// `formatToolError(err, { fallbackMessage })` call.
//
// Idempotent: re-running after a successful pass is a no-op (the source
// pattern no longer exists). Files whose error blocks have already been
// migrated (engagement-profitability.ts — section-level error shape, not
// a tool response) are left alone — the regex only matches the canonical
// tool-response shape.
//
// Usage:  node scripts/refactor-error-wrappers.mjs

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TOOLS_DIR = "src/tools";

// The canonical 14-line catch-block pattern. Pinned by `[ \t]+` for
// whitespace flexibility around indentation; FALLBACK message capture
// supports both string literals ("X failed") and template literals
// (`${X}AddRq failed`) because some tools build the fallback from a
// runtime entity type.
const BLOCK_RE = new RegExp(
  String.raw`} catch \(err\) \{` +
    String.raw`\s+const e = err as \{ message\?: string; statusCode\?: number \};` +
    String.raw`\s+const humanReadable = qbStatusCodeMessage\(e\.statusCode \?\? -1\);` +
    String.raw`\s+return \{` +
    String.raw`\s+content: \[\{` +
    String.raw`\s+type: "text" as const,` +
    String.raw`\s+text: JSON\.stringify\(\{` +
    String.raw`\s+success: false,` +
    String.raw`\s+statusCode: e\.statusCode \?\? -1,` +
    String.raw`\s+statusMessage: e\.message \?\? ((?:"[^"]*"|` + "`" + `[^`+"`"+`]*` + "`" + `)),` +
    String.raw`\s+\.\.\.\(humanReadable \? \{ humanReadable \} : \{\}\),` +
    String.raw`\s+\}\),` +
    String.raw`\s+\}\],` +
    String.raw`\s+isError: true,` +
    String.raw`\s+\};` +
    String.raw`\s+\}`,
  "g",
);

const IMPORT_RE_QB = /^import \{ qbStatusCodeMessage \} from "\.\.\/util\/qb-status-codes\.js";\s*$/m;
const IMPORT_RE_QB_PLUS = /^(import \{[^}]*?)qbStatusCodeMessage,?\s*([^}]*?\} from "\.\.\/util\/qb-status-codes\.js";)\s*$/m;

let totalBlocks = 0;
let totalFiles = 0;

for (const name of readdirSync(TOOLS_DIR)) {
  if (!name.endsWith(".ts")) continue;
  const path = join(TOOLS_DIR, name);
  const before = readFileSync(path, "utf8");

  // Count block matches before substitution.
  const matches = before.matchAll(BLOCK_RE);
  const beforeCount = [...matches].length;

  // If no blocks matched, the file may still need its imports cleaned up
  // (a prior pass might have substituted blocks but failed to add the
  // formatToolError import). Only short-circuit when there's literally
  // nothing to do.
  const fileUsesFormatToolError = /\bformatToolError\(/.test(before);
  const fileHasFormatToolErrorImport =
    /import [^;]*\bformatToolError\b[^;]*from "\.\.\/util\/format-tool-error\.js";/.test(before);
  if (beforeCount === 0 && !(fileUsesFormatToolError && !fileHasFormatToolErrorImport)) {
    continue;
  }

  // Replace each block with a single-line helper call. Indentation: 6
  // spaces because all matching blocks live inside `server.tool(...)
  // handler` bodies which are nested at that depth.
  let after = before.replace(BLOCK_RE, (_full, fallback) =>
    [
      `} catch (err) {`,
      `        return formatToolError(err, { fallbackMessage: ${fallback} });`,
      `      }`,
    ].join("\n"),
  );

  // Count qbStatusCodeMessage occurrences AFTER the sweep, excluding the
  // import line itself. If zero non-import references remain, drop the
  // import. If any remain (a tool with a non-canonical callsite the regex
  // missed), keep it.
  const usagesWithoutImport = after
    .replace(IMPORT_RE_QB, "")
    .replace(IMPORT_RE_QB_PLUS, (_m, head, tail) => `${head}${tail}`)
    .match(/\bqbStatusCodeMessage\b/g);
  const stillUsedElsewhere = (usagesWithoutImport?.length ?? 0) > 0;
  // Only matches an actual import statement — call-sites with
  // `formatToolError(...)` don't count, so the script correctly adds
  // the import to files where the first pass substituted blocks but
  // failed to add the import line.
  const hasFormatToolErrorImport =
    /import [^;]*\bformatToolError\b[^;]*from "\.\.\/util\/format-tool-error\.js";/.test(after);
  if (!stillUsedElsewhere) {
    after = after.replace(IMPORT_RE_QB, "");
    after = after.replace(IMPORT_RE_QB_PLUS, (_m, head, tail) => `${head}${tail}`);
  }
  // Add the formatToolError import if not already present. Place it
  // right after the qb-status-codes import line if it's still there,
  // OTHERWISE after the manager type import, OTHERWISE after the first
  // import line.
  if (!hasFormatToolErrorImport) {
    const qbStatusImportRe = /^(import \{ qbStatusCodeMessage \} from "\.\.\/util\/qb-status-codes\.js";)\s*$/m;
    const managerImportRe = /^(import type \{ QBSessionManager \} from "\.\.\/session\/manager\.js";)\s*$/m;
    const newImport = `import { formatToolError } from "../util/format-tool-error.js";`;
    if (qbStatusImportRe.test(after)) {
      after = after.replace(qbStatusImportRe, (_m, line) => `${line}\n${newImport}`);
    } else if (managerImportRe.test(after)) {
      after = after.replace(managerImportRe, (_m, line) => `${line}\n${newImport}`);
    } else {
      const firstImportRe = /^(import .+;)$/m;
      after = after.replace(firstImportRe, (_m, line) => `${line}\n${newImport}`);
    }
  }

  if (after !== before) {
    writeFileSync(path, after, "utf8");
    totalFiles++;
    totalBlocks += beforeCount;
    console.log(`  ${name}: ${beforeCount} block${beforeCount === 1 ? "" : "s"} migrated`);
  }
}

console.log(`\nDone. ${totalBlocks} catch blocks migrated across ${totalFiles} files.`);
