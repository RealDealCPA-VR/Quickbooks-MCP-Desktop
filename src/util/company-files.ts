/**
 * .qbw discovery shared by qb_company_list and qb_company_credentials_edit.
 * Pure filesystem — identical in live and simulation mode.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export interface CompanyFileEntry {
  companyFile: string;
  displayName: string;
  sizeBytes: number;
  modifiedAt: string;
}

/** Hard ceiling on recursion so a root like D:\ can't walk the whole drive. */
export const MAX_COMPANY_SEARCH_DEPTH = 6;

/**
 * Search root: explicit override → $QB_COMPANY_ROOT → dirname($QB_COMPANY_FILE).
 * Null when none is available.
 */
export function resolveCompanyRoot(override?: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (override && override.trim()) return override;
  if (env.QB_COMPANY_ROOT && env.QB_COMPANY_ROOT.trim()) return env.QB_COMPANY_ROOT;
  if (env.QB_COMPANY_FILE && env.QB_COMPANY_FILE.trim()) return path.dirname(env.QB_COMPANY_FILE);
  return null;
}

/**
 * List .qbw files under `root`, newest first. `depth` 0 = only `root`
 * itself (the original qb_company_list behavior); N = descend N levels.
 * Unreadable subdirectories are skipped; an unreadable `root` throws.
 */
export async function findCompanyFiles(root: string, depth = 0): Promise<CompanyFileEntry[]> {
  const maxDepth = Math.max(0, Math.min(MAX_COMPANY_SEARCH_DEPTH, Math.floor(depth)));
  const found: CompanyFileEntry[] = [];

  const walk = async (dir: string, level: number, isRoot: boolean): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isRoot) throw err;
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase().endsWith(".qbw")) {
        try {
          const stat = await fs.stat(full);
          found.push({
            companyFile: full,
            displayName: path.basename(e.name, path.extname(e.name)),
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          });
        } catch { /* vanished or unreadable — skip */ }
      } else if (e.isDirectory() && level < maxDepth) {
        await walk(full, level + 1, false);
      }
    }
  };

  await walk(root, 0, true);
  found.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return found;
}
