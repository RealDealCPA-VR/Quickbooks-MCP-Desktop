# Handoff State

_Last updated: 2026-05-23. **#89 closed.** Phase 19 remaining: #88, #90, #91, #92. Tests still **1647** (61 files, +0 — pure docs change). Tool count still **150**. After three forward-motion sessions in a row (#87 mech + #91 stub + this one), the operator-facing onboarding path is now self-serve: an MCP-host user can copy one block and have a working server in five minutes. Live-publish (#88) is the next mechanical step; #89 unblocks "here is the install command" copy in #88's release notes._

## Last Session Summary

- **Closed #89.** Added new `## 5-minute install` section ([README.md](README.md) lines 25–145) directly after the Documentation map. Six subsections: prereqs, install paths (npm / GitHub / local-clone), 5 host blocks (Claude Desktop, Cursor, opencode, Windsurf, generic stdio), live-mode env swap, env-var quick-ref table, smoke test. All host blocks use `npx -y github:RealDealCPA-VR/Quickbooks-MCP-Desktop` so they work today on git-deps (#87 wired the `bin` entry + `prepare` script that makes this possible); the npm path lists `npx -y quickbooks-desktop-mcp` for when #88 publishes.
- **Slimmed the old Setup section's host blocks.** The opencode + Claude Desktop config blocks under `## Setup` (lines 666–684) collapsed to a pointer at the new section, keeping just the local-clone-with-absolute-path variant for developer-mode setup. No duplicated env-var docs.
- **Anchor-link gotcha fixed mid-edit.** GitHub-flavored markdown strips `+` and em-dashes from headings, then collapses adjacent spaces into double-hyphens. First-draft heading "### 4. Windows + live mode — swap the env block" would have generated anchor `#4-windows--live-mode--swap-the-env-block` (two double-hyphens). Renamed to "### 4. Live mode (Windows)" → clean anchor `#4-live-mode-windows`. Both `[§4](...)` cross-references (in the new §3 and in the trimmed Setup pointer) updated.
- **Verification clean.** `npm run build` exit 0. `npm test` → 61 files / 1647 tests passed (unchanged — pure docs change). README grew 595 → 727 lines (+132). All 6 new subsection headers present; 5 internal anchor links wired.

## Verify Before Continuing

- [ ] `npm run build` → exit 0.
- [ ] `npm test` → `Test Files 61 passed | Tests 1647 passed`.
- [ ] [README.md](README.md) — `## 5-minute install` section is present near the top (right after the Documentation map table, before `## Tools (150 total)`); six subsections rendered: Prerequisites, Pick an install path, Wire up your MCP host, Live mode (Windows), Environment variable quick reference, Smoke test.
- [ ] [README.md](README.md) — the old `### Configure as MCP server (opencode.jsonc)` + `### Configure for Claude Desktop` blocks under `## Setup` are gone; replaced by a brief pointer + local-clone variant.
- [ ] Skim [todo.md](todo.md) — confirm #89 now `[x]`; Phase 19 remaining items are #88, #90, #91, #92 (4 unchecked).
- [ ] **(Windows + QB) carried** — all live spot-checks from prior handoffs (#74 cache layer, #73 autoExhaust, #64a + #64b dry-run, #63 / #66 / #61–65, plus the 18-item legacy bucket).
- [ ] **(npm-publish prep, defer to #88)** — when implementing #88, add a `files` field to [package.json](package.json) restricting the tarball to `["dist", "README.md", "LICENSE"]` (and create LICENSE if missing). Without this the publish would ship `node_modules`, `src/`, `tests/`, and `.env` if present.

## Next Task

**Operator should pick from remaining Phase 19 items. Four left.**

- [ ] **#88.** Publish to npm. Still blocks on: public unscoped `quickbooks-desktop-mcp` vs scoped `@valentino/quickbooks-desktop-mcp` (public or private). When implementing, also add a `files: ["dist", "README.md", "LICENSE"]` field so the tarball is clean. Configure GitHub Actions for `npm publish` on tag. Confirm name availability with `npm view quickbooks-desktop-mcp` before publishing. **Once published, do a one-line README sweep:** change `github:RealDealCPA-VR/Quickbooks-MCP-Desktop` → `quickbooks-desktop-mcp` (or the scoped name) in every code block under `## 5-minute install` (5 host blocks + the smoke-test `doctor` invocation = 6 places). The §2 install-path table already lists both forms so that row stays.

- [ ] **#90.** Auto-launch QB Desktop on `qb_company_open`. Meatier feature, 4 design questions still open: (a) exe-path detection (registry vs `QB_DESKTOP_EXE` vs fallback chain); (b) conflicting-file behavior (UI automation to close vs fail clearly); (c) multi-user lock surfacing; (d) sim no-op confirmation.

- [ ] **#91.** Flesh out the doctor probes. Stub file already exists at [src/cli/doctor.ts](src/cli/doctor.ts). Add the 7 probes listed in the stub's comment block; exit 0 if all green, 1 if any fail, 2 if a probe couldn't run. Each `✗` needs a one-line remediation hint. **Note:** the §6 smoke test in the new install section references the doctor command — once #91 lands, the parenthetical "currently a stub that exits 2" callout in [README.md](README.md) §6 should be removed.

- [ ] **#92.** Windows installer. Low priority; signing cert ($200-400/yr) is the gating decision.

## Context Notes

- **GitHub-anchor algorithm gotcha.** Lowercase + strip punctuation (keeps word chars / spaces / hyphens) + replace spaces with hyphens. `+`, `.`, and em-dashes (`—`) all get stripped to nothing — but their surrounding spaces remain, collapsing into multi-hyphens. "### 4. Windows + live mode — swap the env block" → `#4-windows--live-mode--swap-the-env-block` (two double-hyphens). When adding new internal anchor targets, prefer punctuation-free headings or test the generated anchor before linking.

- **`npx -y github:OWNER/REPO` is load-bearing for the install section.** #87 wired the `bin` + `prepare: npm run build` script in `package.json`. When npm/git installs the package from a GitHub URL it runs `prepare`, which builds `dist/`, and then resolves the `bin` entry matching the package name (`quickbooks-desktop-mcp` → `dist/index.js`). The second bin (`quickbooks-desktop-mcp-doctor`) is invoked by name as a second arg: `npx -y github:... quickbooks-desktop-mcp-doctor`. Confirmed: this is the form used in the §6 smoke test.

- **GitHub repo URL is `https://github.com/RealDealCPA-VR/Quickbooks-MCP-Desktop`.** Used in the §2 install-path table and every §3 host block. Confirmed via `git remote -v`. If the repo moves or is renamed under a different org for #88 / publish, sweep these 7 places ([README.md](README.md) §2 + §3 × 5 + §6 smoke test).

- **§4 (live-mode env swap) is deliberately one shared block, not five copies.** Operators read the host blocks in §3, find theirs, then jump to §4 to swap the env. This keeps the section to one page and avoids 5× duplication of the same Windows path. If operators get confused, the alternative is to inline live + sim variants per host (would 2× the section's length).

- **Two consecutive no-code sessions broken, then THREE forward-motion sessions in a row.** 2026-05-23 morning: #87 (bin + stub). 2026-05-23 midday: this one (#89). Next session has 4 Phase 19 items left. Two are pure-mechanical (#89 just shipped is one analog), two need product decisions (#88 publish-scope, #90 4 open design questions). If operator stalls again, **#91 (doctor probes)** is the no-decision-required forward-motion option since the stub's comment block already enumerates exactly what to build.

- **todo.md is an INDEX, not a source of truth** for "why was this built." Deep context lives in:
  - [DECISIONS.md](DECISIONS.md) — dated entries pinning load-bearing design tradeoffs.
  - [HANDOFF.md](HANDOFF.md) — short-term session continuity (this file).
  - Inline source comments + tool descriptions — per-tool quirks and limitations.
  - [tests/](tests/) — behavioral pin for every load-bearing invariant.

- **Phase 19 numbering starts at #87** (not #85). Items #85 `qb_closing_date_*` and #86 MCP prompts were recovered during the 2026-05-22 cleanup and closed 2026-05-12. Always grep for the next free number before adding a new item.

- **Carried gotchas** (unchanged from prior handoffs):
  - QBXMLRP2 cannot OPEN a `.qbw` — only attach to one QB Desktop has already loaded. **#90 directly addresses this.** _(Now documented in the new README §1 prereqs so operators discover this before failing.)_
  - Live verification requires `C:\nvm4w\nodejs\node.exe` v20.20.2 (system PATH v22 breaks winax). _(Now documented in the new README §1 prereqs.)_
  - `winax` is in `optionalDependencies` — non-Windows installs skip it cleanly.
  - statusCodes: 9001 read-only, 9002 idempotency conflict, 9003 edition, 9004 payroll, 9005 SDK-no-write, 9006 reserved-but-zero-emit.
  - `*Core` private methods are the chokepoint for dry-run + read-only gating — any new mutation primitive should split add/modify/delete into `*Core` + public wrapper (DECISIONS.md V1).
  - `structuredClone` is the deep-clone primitive in sim store snapshot/restore.
  - `idCounter` ticks twice per add (ListID + EditSequence).
  - `fast-xml-parser` doesn't decode numeric character entities; DOES coerce numeric-looking text to numbers.
  - Dispatch order in sim `processRequest`: non-entity-typed `*QueryRq` / `*ModRq` / `AttachableAddRq` / `DataExtDefQueryRq` MUST precede the `endsWith` catch-alls.
  - `BillPayment*` total is on `TotalAmount`, not `Amount` — coalesce.
  - #66 wire-shape decision: `AuditTrail` is a `CustomDetailReportType` value, NOT a `TxnReportType` value.
