# Handoff State

_Last updated: 2026-05-22. **No code changes this session — pure hygiene + planning.** todo.md compressed ~13× (80K tokens → ~6K) with all 90 closed items + headlines preserved. **New Phase 19 — Delivery and ease of use** scoped with 6 unchecked items (#87–92) covering npm packaging, MCP host install templates, auto-launch QB Desktop on `qb_company_open`, and CLI doctor command. Tests still **1647** (+0). Tool count still **150**._

## Last Session Summary

- **todo.md aggressively truncated.** Every closed item's 50–300 word `_(Closed YYYY-MM-DD. ...)_` annotation was compressed to a single short sentence (date + key file pointer + counts where load-bearing + pointer to DECISIONS.md when applicable). Headlines kept verbatim so the "what was this item" question remains answerable from the file alone. Deep play-by-play implementation context lives where it always did: DECISIONS.md (dated entries), HANDOFF.md (last session), and inline source comments. The file went from 167 lines / ~432KB / 80K tokens (over the Read tool's 25K limit, required paging) to 173 lines / ~25KB / ~6K tokens (loads in one Read).
- **Recovered two items missed during the rewrite** — #85 (`qb_closing_date_get` + `_set` informational stub, **9005** synthetic statusCode) and #86 (MCP prompts via `prompts/workflows.ts`), both closed 2026-05-12. Phase 19 numbering shifted from 85–90 to **87–92** to avoid collision.
- **New Phase 19 — Delivery and ease of use** scoped with 6 items, ordered cost-to-value:
  - **#87** Add `bin` entry + `prepare` script to `package.json` (one-line unlock for #88).
  - **#88** Publish to npm — **decision needed**: scoped (`@valentino/quickbooks-desktop-mcp`) vs unscoped, public vs private.
  - **#89** "5-minute install" README section with config-block templates per MCP host (Claude Desktop / Cursor / opencode / Windsurf / generic) + full env-var matrix.
  - **#90** Auto-launch QB Desktop on `qb_company_open({ launchIfClosed: true })` — the multi-client question's missing piece. Spawn `qbw32.exe` with the `.qbw` path, poll for QBXMLRP2 attach success, then retry `BeginSession`. Open design questions documented inline: executable-path detection, behavior when QB has a different file open, multi-user lock state.
  - **#91** `quickbooks-desktop-mcp doctor` CLI — env-probe with ✓/✗ remediation hints (Node version, platform, QB Desktop installed, QBXMLRP2 COM registration, env vars, winax rebuild status).
  - **#92** (Low) Windows installer via `pkg`/`oclif` — non-CLI accountant reach; gated on signing-cert cost.

## Verify Before Continuing

- [ ] `npm run build` → exit 0 (no code touched this session — should still pass).
- [ ] `npm test` → `Test Files 61 passed | Tests 1647 passed`.
- [ ] `"" | & node dist/index.js` → exit 0, `Mode: simulation` banner printed.
- [ ] Skim the new [todo.md](todo.md) — confirm every phase header and item number you remember is still present. Headlines preserved verbatim from the old file; close-notes intentionally compressed.
- [ ] (Optional) Verify the count: `git show HEAD:todo.md | grep -c "^- \[x\]"` should return 90; current `todo.md` should also return 90 closed + 6 unchecked.
- [ ] **(Windows + QB) carried** — all live spot-checks from prior handoffs (#74 cache layer, #73 autoExhaust, #64a + #64b dry-run, #63 / #66 / #61–65, plus the 18-item legacy bucket).

## Next Task

**Pick one of these Phase 19 items:**

- [ ] **#87.** Add `bin` entry to package.json so users can `npx quickbooks-desktop-mcp` once published. One-line change: `"bin": { "quickbooks-desktop-mcp": "dist/index.js" }`. Also add a `prepare` script that runs `npm run build` so consumers installing as a git dep get a built `dist/`. Pre-req for #88.

- [ ] **#88.** Publish to npm. Decide scope (`@valentino/quickbooks-desktop-mcp` vs unscoped `quickbooks-desktop-mcp`); verify name availability; configure GitHub Actions for `npm publish` on tag. Enables MCP host config blocks like `"command": "npx", "args": ["-y", "quickbooks-desktop-mcp"]` rather than requiring `git clone` + `npm install` + absolute path to `dist/index.js`. **Decision needed: public or private package?**

- [ ] **#90.** Auto-launch QB Desktop on `qb_company_open` — extend the tool with `launchIfClosed: boolean` (default false; explicit opt-in). When true: if the wire layer reports the target file isn't open, spawn QB Desktop with the `.qbw` as a process arg, poll for QBXMLRP2 attach success (up to ~30s with exponential backoff), then retry `BeginSession`. Closes the operator's "ask about a different client's books" loop end-to-end. **Design questions** (must answer before implementing): (a) executable-path detection — registry lookup vs `QB_DESKTOP_EXE` env override vs fallback chain; (b) behavior when QB Desktop already has a DIFFERENT file open (QB serializes — close current via UI automation? fail clearly?); (c) multi-user QB lock state surfacing; (d) sim mode = no-op.

Operator suggested ordering in last exchange: **#87 + #88 paired** as the cheap unlock, OR **#90 standalone** since that's the meatier feature behind the multi-book question. Operator deferred the choice — pick whichever fits the available session time.

## Context Notes

- **No code changed this session.** The build / test / sim-banner verification chain from the prior handoff still holds. If `npm run build` fails today, something OTHER than this session broke it — investigate accordingly.

- **todo.md is no longer the source of truth for "why was this built."** It became too verbose. The new file is a navigable INDEX of what shipped + a planning surface for what hasn't. Deep context lives in:
  - [DECISIONS.md](DECISIONS.md) — dated entries pinning load-bearing design tradeoffs (read-only gate composition, idempotency cache scope, dry-run live-mode strategy, etc.). Don't repeat decisions; reference the entry by date.
  - [HANDOFF.md](HANDOFF.md) — short-term session continuity (this file).
  - Inline source comments — implementation detail. Tool descriptions carry per-tool quirks and limitations.
  - [tests/](tests/) — behavioral pin for every load-bearing invariant.

- **Two items recovered during cleanup** — #85 (`qb_closing_date_*`) and #86 (MCP prompts) were missed on the first pass. Both closed 2026-05-12 and verified to exist via `git show HEAD:todo.md | grep ^- \\[x\\]`. The Phase 19 items consequently start at **#87, not #85** — important for any new item numbering. Always grep the file for the next free number before adding a new item.

- **Phase 19 #88 (npm publish) blocks on a product decision** that hasn't been made: is this server going to be public (anyone can `npx quickbooks-desktop-mcp`) or private (operator-only)? Both are technically straightforward; the cost is the choice. **Ask the operator before doing #88.** #87 ships independently of that decision — `bin` works for local installs too.

- **Phase 19 #90 (auto-launch) is the multi-book story.** The current architecture already supports multi-book switching via `qb_company_open` + `switchCompanyFile` — the new wrinkle is just covering the case where the operator asks about a book QuickBooks Desktop doesn't currently have loaded. QBXMLRP2 cannot OPEN a `.qbw` (load-bearing constraint pinned in DECISIONS.md and every prior HANDOFF). The auto-launch path bypasses that by spawning QB Desktop with the file as a CLI argument.

- **Phase 19 #91 (doctor CLI) ships alongside #87.** If you wire `bin` for #87, add `doctor` as a sibling entry now to avoid touching `package.json` twice: `"bin": { "quickbooks-desktop-mcp": "dist/index.js", "quickbooks-desktop-mcp-doctor": "dist/cli/doctor.js" }` (file doesn't exist yet — create when implementing).

- **Carried gotchas** (unchanged from prior handoff):
  - QBXMLRP2 cannot OPEN a `.qbw` — only attach to one QB Desktop has already loaded. **#90 directly addresses this.**
  - Live verification requires `C:\nvm4w\nodejs\node.exe` v20.20.2 (system PATH v22 breaks winax).
  - `winax` is in `optionalDependencies` — non-Windows installs skip it cleanly.
  - statusCodes: 9001 read-only, 9002 idempotency conflict, 9003 edition, 9004 payroll, 9005 SDK-no-write, 9006 reserved-but-zero-emit.
  - `*Core` private methods are the chokepoint for dry-run + read-only gating — any new mutation primitive should split add/modify/delete into `*Core` + public wrapper (DECISIONS.md V1).
  - `structuredClone` is the deep-clone primitive in sim store snapshot/restore.
  - `idCounter` ticks twice per add (ListID + EditSequence).
  - `fast-xml-parser` doesn't decode numeric character entities; DOES coerce numeric-looking text to numbers.
  - Dispatch order in sim `processRequest`: non-entity-typed `*QueryRq` / `*ModRq` / `AttachableAddRq` / `DataExtDefQueryRq` MUST precede the `endsWith` catch-alls.
  - `BillPayment*` total is on `TotalAmount`, not `Amount` — coalesce.
  - #66 wire-shape decision: `AuditTrail` is a `CustomDetailReportType` value, NOT a `TxnReportType` value.
