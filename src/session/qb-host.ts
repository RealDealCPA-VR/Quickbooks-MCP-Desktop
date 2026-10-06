/**
 * QBHost: everything the server needs from the machine that runs QuickBooks
 * Desktop (docs/CONNECTOR_DESIGN.md, Phase 1).
 *
 * The session manager, the web page and the tools reach that machine only
 * through this interface. `localQBHost` is today's behavior: QuickBooks,
 * its processes and the .qbw files are on this PC. Phase 2 adds a remote
 * host that makes the same calls over the tailnet to a connector on a
 * QuickBooks workstation.
 *
 * Every method is async so a network-backed host fits the same shape.
 */

import { WorkerRequestProcessor, type QBRequestProcessor } from "./com-worker-client.js";
import {
  defaultCloseQBDesktop,
  defaultFileExists,
  defaultForceCloseQBDesktop,
  defaultIsQBDesktopRunning,
  defaultLaunchQBDesktop,
  defaultRegistryQuery,
  resolveQBDesktopExe,
  type QBCloseResult,
  type QBExeResolution,
} from "../util/qb-desktop-launch.js";
import { getQuickBooksHealth, type QBHealth } from "../util/qb-health.js";
import { findCredentialSummary, startLoginAutofill, type LoginAutofillHandle } from "../util/qb-credentials.js";
import { findCompanyFiles, type CompanyFileEntry } from "../util/company-files.js";
import { browseDirectory, defaultDriveLister, type BrowseListing, type DriveEntry } from "../util/fs-browse.js";

export interface QBHost {
  /** Short label for logs and the control page ("this computer", a workstation name). */
  readonly label: string;
  /** A new QBXMLRP2 handle for one live session. */
  createRequestProcessor(): QBRequestProcessor;
  isQuickBooksRunning(): Promise<boolean>;
  resolveExe(): Promise<QBExeResolution | null>;
  /** Start QuickBooks on a company file, detached. */
  launch(exe: string, companyFile: string): Promise<void>;
  /** Close QuickBooks the way its X button does. Never force-kills. */
  closeGracefully(): Promise<QBCloseResult>;
  /** Kill a hung QuickBooks. Only after the caller explicitly allowed it. */
  forceClose(): Promise<boolean>;
  health(opts?: { fresh?: boolean }): Promise<QBHealth>;
  fileExists(p: string): Promise<boolean>;
  findCompanyFiles(root: string, depth: number): Promise<CompanyFileEntry[]>;
  listDrives(): Promise<DriveEntry[]>;
  browse(dir: string): Promise<BrowseListing>;
  /** Is a QuickBooks user name saved for this company file? */
  hasSavedLogin(companyFile: string): Promise<boolean>;
  /** Fill QuickBooks' login window for this file; null when no login is saved. */
  startLoginAutofill(companyFile: string): Promise<LoginAutofillHandle | null>;
}

export const localQBHost: QBHost = {
  label: "this computer",
  createRequestProcessor: () => new WorkerRequestProcessor(),
  isQuickBooksRunning: async () => defaultIsQBDesktopRunning(),
  resolveExe: async () =>
    resolveQBDesktopExe({
      envExe: process.env.QB_DESKTOP_EXE,
      fileExists: defaultFileExists,
      registryQuery: defaultRegistryQuery,
    }),
  launch: async (exe, companyFile) => defaultLaunchQBDesktop(exe, companyFile),
  closeGracefully: () => defaultCloseQBDesktop(),
  forceClose: () => defaultForceCloseQBDesktop(),
  health: (opts) => getQuickBooksHealth(opts),
  fileExists: async (p) => defaultFileExists(p),
  findCompanyFiles: (root, depth) => findCompanyFiles(root, depth),
  listDrives: () => defaultDriveLister(),
  browse: (dir) => browseDirectory(dir),
  hasSavedLogin: async (companyFile) => {
    try {
      return !!findCredentialSummary(companyFile)?.username;
    } catch {
      return false;
    }
  },
  startLoginAutofill: async (companyFile) => startLoginAutofill({ companyFile }),
};
