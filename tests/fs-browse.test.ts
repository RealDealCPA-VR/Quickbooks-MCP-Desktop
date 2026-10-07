// Company-file picker (#108): drive list parsing and folder browsing.
// Listings must expose only sub-folders and .qbw files.

import { promises as fs, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowseError, browseDirectory, parseDriveLines, toUncPath } from "../src/util/fs-browse.js";
import { withUncPaths } from "../src/connector/unc-host.js";
import { localQBHost } from "../src/session/qb-host.js";

describe("parseDriveLines (PowerShell DriveInfo output)", () => {
  it("maps root, type, readiness and label; skips noise lines", () => {
    const out = [
      "C:\\|Fixed|True||Windows",
      "D:\\|Fixed|True||",
      "E:\\|CDRom|False||",
      "Z:\\|Network|True|\\\\files\\books|Clients|Share",
      "Y:\\|Network|False|\\\\files\\archive\\|",
      "",
      "WARNING: something unrelated",
    ].join("\r\n");
    expect(parseDriveLines(out)).toEqual([
      { path: "C:\\", label: "Windows", kind: "fixed", ready: true },
      { path: "D:\\", label: "", kind: "fixed", ready: true },
      { path: "E:\\", label: "", kind: "cdrom", ready: false },
      { path: "Z:\\", label: "Clients|Share", kind: "network", ready: true, unc: "\\\\files\\books" },
      { path: "Y:\\", label: "", kind: "network", ready: false, unc: "\\\\files\\archive" },
    ]);
  });
  it("unknown drive types become 'other'", () => {
    expect(parseDriveLines("R:\\|Ram|True|")[0].kind).toBe("other");
  });
});

describe("browseDirectory", () => {
  let root: string;
  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "qb-browse-"));
    for (const d of ["clients 10", "Clients 2", "$RECYCLE.BIN", "System Volume Information", ".git"]) {
      await fs.mkdir(path.join(root, d));
    }
    await fs.writeFile(path.join(root, "Zeta.QBW"), "x".repeat(2048));
    await fs.writeFile(path.join(root, "acme.qbw"), "");
    await fs.writeFile(path.join(root, "notes.txt"), "secret");
    await fs.writeFile(path.join(root, "acme.qbw.tlg"), "");
  });
  afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it("lists sub-folders (natural, case-insensitive order) and .qbw files only", async () => {
    const r = await browseDirectory(root);
    expect(r.path).toBe(path.resolve(root));
    expect(r.parent).toBe(path.dirname(path.resolve(root)));
    expect(r.folders.map((f) => f.name)).toEqual(["Clients 2", "clients 10"]);
    expect(r.folders[0].path).toBe(path.join(root, "Clients 2"));
    expect(r.files.map((f) => f.name)).toEqual(["acme.qbw", "Zeta.QBW"]);
    expect(r.files[1]).toMatchObject({ path: path.join(root, "Zeta.QBW"), sizeBytes: 2048 });
    expect(JSON.stringify(r)).not.toMatch(/notes\.txt|\.tlg|RECYCLE|Volume Information|\.git/);
    expect(r.truncated).toBe(false);
  });

  it("a filesystem root has no parent", async () => {
    const top = path.parse(path.resolve(root)).root;
    expect((await browseDirectory(top)).parent).toBeNull();
  });

  it("relative, missing and non-folder paths are refused with a readable message", async () => {
    await expect(browseDirectory("Clients")).rejects.toThrow(BrowseError);
    await expect(browseDirectory("")).rejects.toThrow(/full folder path/);
    await expect(browseDirectory(path.join(root, "nope"))).rejects.toThrow(/Folder not found/);
    await expect(browseDirectory(path.join(root, "acme.qbw"))).rejects.toThrow(/Not a folder/);
  });
});

describe("UNC identity for files on a file server", () => {
  const drives = [
    { path: "C:\\", label: "", kind: "fixed" as const, ready: true },
    { path: "Q:\\", label: "Books", kind: "network" as const, ready: true, unc: "\\\\files\\books" },
  ];
  it("mapped letters become the share path; other paths are unchanged", () => {
    expect(toUncPath("Q:\\Acme\\Acme.qbw", drives)).toBe("\\\\files\\books\\Acme\\Acme.qbw");
    expect(toUncPath("q:\\", drives)).toBe("\\\\files\\books\\");
    expect(toUncPath("Q:", drives)).toBe("\\\\files\\books\\");
    expect(toUncPath("C:\\Clients\\A.qbw", drives)).toBe("C:\\Clients\\A.qbw");
    expect(toUncPath("\\\\files\\books\\A.qbw", drives)).toBe("\\\\files\\books\\A.qbw");
  });
  it("the connector's host browses and discovers through the UNC path", async () => {
    const seen: string[] = [];
    const host = withUncPaths({
      ...localQBHost,
      listDrives: async () => drives,
      browse: async (dir) => { seen.push(`browse ${dir}`); return { path: dir, parent: null, folders: [], files: [], truncated: false }; },
      fileExists: async (p) => { seen.push(`exists ${p}`); return true; },
      findCompanyFiles: async (root) => { seen.push(`find ${root}`); return [{ companyFile: "Q:\\Acme\\Acme.qbw", displayName: "Acme", sizeBytes: 1, modifiedAt: "" }]; },
    });
    expect((await host.browse("Q:\\Acme")).path).toBe("\\\\files\\books\\Acme");
    await host.fileExists("Q:\\Acme\\Acme.qbw");
    const found = await host.findCompanyFiles("Q:\\", 2);
    expect(found[0].companyFile).toBe("\\\\files\\books\\Acme\\Acme.qbw");
    expect(seen).toEqual(["browse \\\\files\\books\\Acme", "exists \\\\files\\books\\Acme\\Acme.qbw", "find \\\\files\\books\\"]);
  });
});
