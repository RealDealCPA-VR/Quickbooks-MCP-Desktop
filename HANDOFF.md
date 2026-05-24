# Handoff State

_Last updated: 2026-05-24. **#88 closed NOT-PURSUED.** Phase 19 remaining: #90, #91, #92 (3 items). Tests still **1647** (61 files, +0 — docs + governance change only). Tool count still **150**. Distribution model decided and pinned in DECISIONS.md: private GitHub repo only, no npm publish, ever, under the current monetization model. The `github:RealDealCPA-VR/Quickbooks-MCP-Desktop` form in the README is now the permanent install path — not provisional. The previously planned post-publish README sweep (6 places, `github:OWNER/REPO` → `quickbooks-desktop-mcp`) is dead and should not be done._

## Last Session Summary

- **Closed #88 NOT-PURSUED.** Operator decision: sell access to the private GitHub repo via collaborator grants; do not publish to npm. Public npm publish gives the product away free; private npm publish requires Pro ($7/mo) for a scoped private package and adds zero gating value since the GitHub repo is already private. The `github:RealDealCPA-VR/Quickbooks-MCP-Desktop` install form (wired by #87's `bin` + `prepare` script) is now permanent.
- **DECISIONS.md** — new top entry `2026-05-24 — Distribution model` pins the choice with full rejected-alternatives, tradeoffs, and revisit triggers. Future sessions should not re-debate npm publishing.
- **[README.md](README.md) §2 install-path table** — dropped the "npm (post-publish — #88)" row. Two rows now: GitHub (primary, with new "Requires access to the private repo" caveat) + Local clone (developer). The 5 host blocks in §3, the §4 live-mode block, the §6 smoke-test invocation are all unchanged — they already use the `github:` form. **No README sweep needed.**
- **[todo.md](todo.md) #88** — checked `[x]` with the NOT-PURSUED rationale inline (mirrors how #45 SDK-BLOCKED was closed). Phase 19 remaining count drops from 4 to 3.
- **Verification clean.** `npm run build` exit 0. `npm test` → 61 files / 1647 tests passed (unchanged — pure docs + governance change). README §2 row count went 3 → 2 rows.

## Verify Before Continuing

- [ ] `npm run build` → exit 0.
- [ ] `npm test` → `Test Files 61 passed | Tests 1647 passed`.
- [ ] [README.md](README.md) §2 — install-path table has exactly **2 rows** (GitHub + Local clone); no "npm" row.
- [ ] [README.md](README.md) §3/§4/§6 — every code block still uses `npx -y github:RealDealCPA-VR/Quickbooks-MCP-Desktop` (5 host blocks + smoke test = 6 places). **No changes here — verify nothing was disturbed.**
- [ ] [DECISIONS.md](DECISIONS.md) — top entry is `2026-05-24 — Distribution model: private GitHub repo only`.
- [ ] [todo.md](todo.md) — #88 is `[x]` with NOT-PURSUED 2026-05-24 inline note. Phase 19 unchecked items: #90, #91, #92 (3 only).
- [ ] **(Windows + QB) carried** — all live spot-checks from prior handoffs (#74 cache layer, #73 autoExhaust, #64a + #64b dry-run, #63 / #66 / #61–65, plus the 18-item legacy bucket).

## Next Task

**Operator should pick from remaining Phase 19 items. Three left.**

- [ ] **#90.** Auto-launch QB Desktop on `qb_company_open`. Meatier feature, 4 design questions still open: (a) exe-path detection (registry vs `QB_DESKTOP_EXE` vs fallback chain); (b) conflicting-file behavior (UI automation to close vs fail clearly); (c) multi-user lock surfacing; (d) sim no-op confirmation.

- [ ] **#91.** Flesh out the doctor probes. Stub file already exists at [src/cli/doctor.ts](src/cli/doctor.ts). Add the 7 probes listed in the stub's comment block; exit 0 if all green, 1 if any fail, 2 if a probe couldn't run. Each `✗` needs a one-line remediation hint. **Note:** the §6 smoke test in the install section references the doctor command — once #91 lands, the parenthetical "currently a stub that exits 2" callout in [README.md](README.md) §6 should be removed. **Recommended forward-motion option** — no product decisions required; the spec is in the stub.

- [ ] **#92.** Windows installer. Low priority; signing cert ($200-400/yr) is the gating decision. Doesn't conflict with #88's NOT-PURSUED — installer would bundle a built `dist/` from the private repo, signed.

## Context Notes

- **DO NOT re-debate npm publishing.** [DECISIONS.md](DECISIONS.md) 2026-05-24 pins the choice. The repo is private; access is sold via collaborator grants; the `github:RealDealCPA-VR/Quickbooks-MCP-Desktop` `npx` form is the permanent install. The trigger conditions for revisiting are documented at the bottom of that decision entry — none of them apply today.

- **The previously planned "post-publish README sweep" is dead.** Prior handoffs noted that once #88 publishes, 6 README places needed changing `github:RealDealCPA-VR/Quickbooks-MCP-Desktop` → `quickbooks-desktop-mcp`. That sweep is no longer applicable. The `github:` form is the final form.

- **The §2 access caveat is the only buyer-facing note about repo gating** — added 2026-05-24 as "Requires access to the private repo" in the GitHub row's "When" column. If buyer feedback surfaces confusion about `gh auth login` / `GITHUB_TOKEN` setup, add a §1 prerequisites bullet then. Default is to keep README terse.

- **GitHub-anchor algorithm gotcha** (carried from #89). Lowercase + strip punctuation (keeps word chars / spaces / hyphens) + replace spaces with hyphens. `+`, `.`, and em-dashes (`—`) all get stripped to nothing — but their surrounding spaces remain, collapsing into multi-hyphens. When adding new internal anchor targets, prefer punctuation-free headings or test the generated anchor before linking.

- **`npx -y github:OWNER/REPO` is load-bearing for the install section** (carried from #89). #87 wired the `bin` + `prepare: npm run build` script in `package.json`. When npm/git installs the package from a GitHub URL it runs `prepare`, which builds `dist/`, and then resolves the `bin` entry matching the package name (`quickbooks-desktop-mcp` → `dist/index.js`). The second bin (`quickbooks-desktop-mcp-doctor`) is invoked by name as a second arg: `npx -y github:... quickbooks-desktop-mcp-doctor`. This pattern is now permanent — see DECISIONS.md 2026-05-24.

- **GitHub repo URL is `https://github.com/RealDealCPA-VR/Quickbooks-MCP-Desktop`** (carried from #89). Used in the §2 install-path table and every §3 host block + §6 smoke test = 7 places. Confirmed via `git remote -v`. **If the repo is ever moved or renamed**, sweep these 7 places AND every buyer needs to update their host config (`npx -y github:OWNER/REPO` doesn't follow GitHub redirects — npm's github-fetch driver doesn't honor them). This is now operationally load-bearing.

- **§4 (live-mode env swap) is deliberately one shared block, not five copies** (carried from #89). Operators read the host blocks in §3, find theirs, then jump to §4 to swap the env. This keeps the section to one page and avoids 5× duplication of the same Windows path.

- **Phase 19 numbering starts at #87** (carried). Items #85 `qb_closing_date_*` and #86 MCP prompts were recovered during the 2026-05-22 cleanup and closed 2026-05-12. Always grep for the next free number before adding a new item.

- **No-decision-required forward-motion option = #91** (carried — recommendation still stands). The stub at [src/cli/doctor.ts](src/cli/doctor.ts) enumerates exactly what to build: 7 probes, exit-code contract, remediation hints. #90 has 4 open design questions; #92 has the signing-cert gating decision. #91 just needs implementation.

- **Carried gotchas** (unchanged from prior handoffs):
  - QBXMLRP2 cannot OPEN a `.qbw` — only attach to one QB Desktop has already loaded. **#90 directly addresses this.** _(Documented in README §1 prereqs.)_
  - Live verification requires `C:\nvm4w\nodejs\node.exe` v20.20.2 (system PATH v22 breaks winax). _(Documented in README §1 prereqs.)_
  - `winax` is in `optionalDependencies` — non-Windows installs skip it cleanly.
  - statusCodes: 9001 read-only, 9002 idempotency conflict, 9003 edition, 9004 payroll, 9005 SDK-no-write, 9006 reserved-but-zero-emit.
  - `*Core` private methods are the chokepoint for dry-run + read-only gating — any new mutation primitive should split add/modify/delete into `*Core` + public wrapper (DECISIONS.md V1).
  - `structuredClone` is the deep-clone primitive in sim store snapshot/restore.
  - `idCounter` ticks twice per add (ListID + EditSequence).
  - `fast-xml-parser` doesn't decode numeric character entities; DOES coerce numeric-looking text to numbers.
  - Dispatch order in sim `processRequest`: non-entity-typed `*QueryRq` / `*ModRq` / `AttachableAddRq` / `DataExtDefQueryRq` MUST precede the `endsWith` catch-alls.
  - `BillPayment*` total is on `TotalAmount`, not `Amount` — coalesce.
  - #66 wire-shape decision: `AuditTrail` is a `CustomDetailReportType` value, NOT a `TxnReportType` value.
