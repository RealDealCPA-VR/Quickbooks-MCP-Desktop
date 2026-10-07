/**
 * File-server awareness for the connector (docs/CONNECTOR_DESIGN.md).
 *
 * The books live on a file server that each workstation may map to a
 * different drive letter. Paths the connector hands back (browse listings,
 * discovered company files) use the share's UNC form, so a company file
 * has one identity, one saved login and one set of grants on every
 * workstation. Paths coming in on a mapped letter are translated too.
 */

import type { QBHost } from "../session/qb-host.js";
import { toUncPath, type BrowseListing, type DriveEntry } from "../util/fs-browse.js";

const DRIVE_CACHE_MS = 60_000;

export function withUncPaths(host: QBHost, now: () => number = Date.now): QBHost {
  let cache: { at: number; drives: DriveEntry[] } | null = null;
  const drives = async (fresh = false): Promise<DriveEntry[]> => {
    if (!fresh && cache && now() - cache.at < DRIVE_CACHE_MS) return cache.drives;
    try {
      cache = { at: now(), drives: await host.listDrives() };
    } catch {
      cache = { at: now(), drives: [] };
    }
    return cache.drives;
  };
  const unc = async (p: string) => toUncPath(p, await drives());

  return {
    get label() { return host.label; },
    createRequestProcessor: () => host.createRequestProcessor(),
    isQuickBooksRunning: () => host.isQuickBooksRunning(),
    resolveExe: () => host.resolveExe(),
    launch: async (exe: string, companyFile: string) => host.launch(exe, companyFile),
    closeGracefully: () => host.closeGracefully(),
    forceClose: () => host.forceClose(),
    health: (opts?: { fresh?: boolean }) => host.health(opts),
    hasSavedLogin: (companyFile: string) => host.hasSavedLogin(companyFile),
    startLoginAutofill: (companyFile: string) => host.startLoginAutofill(companyFile),
    listDrives: () => drives(true),
    browse: async (dir: string): Promise<BrowseListing> => host.browse(await unc(dir)),
    fileExists: async (p: string) => host.fileExists(await unc(p)),
    findCompanyFiles: async (root: string, depth: number) => {
      const found = await host.findCompanyFiles(await unc(root), depth);
      const d = await drives();
      return found.map((f) => ({ ...f, companyFile: toUncPath(f.companyFile, d) }));
    },
  };
}
