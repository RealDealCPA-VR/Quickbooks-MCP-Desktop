# Handoff State

_Last updated: 2026-05-29. **Phase 19 #91 closed.** CLI doctor (`quickbooks-desktop-mcp-doctor`) fleshed out — 7 pure probes over an injected `DoctorDeps` bag, `✓ / ✗ / ⚠` per probe with a one-line remediation on every `✗`, exit **0** all-green / **1** any-fail / **2** any-skip (fail outranks skip). QB-install probe reuses #90's `resolveQBDesktopExe` chain and surfaces both the resolved exe path AND the source branch. Verified live on the Windows box. Build green, **63 test files / 1725 tests passing** (was 62 / 1690 → +1 file, +35 tests). Tool count unchanged at 150 (doctor is a separate bin, not an MCP tool). **Phase 19 now has only #92 left (Windows installer — lower priority, gated on a signing-cert decision).** The feature/delivery backlog is effectively complete._

## Last Session Summary

- **Phase 19 #91 implemented end-to-end.** [src/cli/doctor.ts](src/cli/doctor.ts) replaced the #87 stub. Architecture: a pure, I/O-free core (`runDoctor(deps)` + seven `probe*` helpers + `formatReport`) over an injected `DoctorDeps` bag; `main()` is the only impure part (wires `buildDefaultDeps()`, prints, `process.exit`). Same test-seam discipline as #90's `makeFakeLiveManager`.
- **Seven probes:** Node version (major 20 only → ok; else fail), Platform (win32 → ok; else skip — sim mode is legit off-Windows), QuickBooks Desktop (reuses #90's `resolveQBDesktopExe` + surfaces `exe` + `source: env|registry|fallback`), QBXMLRP2 COM (`reg query` the ProgID; distinguishes key-absent→fail from reg.exe-unavailable→skip via the spawn error code), QB_COMPANY_FILE (unset/missing → fail), QB_COMPANY_ROOT (unset → ok, defaults to dirname; set-but-missing → fail), winax (real `require("winax")`, classifies missing vs abi-mismatch).
- **Exit-code contract:** 0 all-green / 1 any-fail / 2 any-skip-and-no-fail. `fail` outranks `skip` (CI-friendly; actionable signal wins).
- **Live verified on the Windows dev box.** `node dist/cli/doctor.js` → exit 1 with honest output: `✓` Node 20.20.2, `✓` Windows x64, `✗` QB Desktop not at known paths (COM is registered but the exe isn't at a known path on this box → correctly told to set `QB_DESKTOP_EXE`), `✓` QBXMLRP2 registered, `✗` QB_COMPANY_FILE unset, `✓` QB_COMPANY_ROOT default, `✓` winax loadable.
- **Tests.** New [tests/doctor.test.ts](tests/doctor.test.ts) (35 tests: every branch of all 7 probes, the 4 exit-code paths incl. fail-outranks-skip, and `formatReport` rendering — symbols, remediation arrows, summary line). No other test file touched.
- **Docs.** README smoke-test parenthetical rewritten (real 7-probe description + 0/1/2 contract). DECISIONS.md 2026-05-29 + ACCEPTANCE_CRITERIA.md Item 91 entry + todo.md #91 closed.

## Verify Before Continuing

- [ ] `npm run build` → exit 0.
- [ ] `npm test` → `Test Files 63 passed | Tests 1725 passed`.
- [ ] `node dist/cli/doctor.js` → prints a 7-line probe report (Node version / Platform / QuickBooks Desktop / QBXMLRP2 COM / QB_COMPANY_FILE / QB_COMPANY_ROOT / winax) + a `Summary: N passed, N failed, N skipped → exit N` line, and the process exit code matches that summary.
- [ ] [src/cli/doctor.ts](src/cli/doctor.ts) exports `runDoctor`, `formatReport`, `buildDefaultDeps`, all seven `probe*` functions, `defaultComRegistered`, `defaultWinaxStatus`, and the `DoctorDeps` / `ProbeResult` / `ProbeStatus` / `DoctorReport` types. `main()` is NOT exported and only runs when invoked as the bin entry.
- [ ] [todo.md](todo.md) — **#91 is `[x]`** with the 2026-05-29 close annotation. Phase 19 unchecked: only **#92**.
- [ ] [DECISIONS.md](DECISIONS.md) — top entry is `2026-05-29 — CLI doctor probe model + exit-code precedence (Phase 19 #91 closed)`. The 2026-05-28 #90 entry is still immediately below.
- [ ] **(Windows + QB) carried** — all live spot-checks from prior handoffs, including #90's `launchIfClosed: true` first-run verification (file-not-loaded → spawn+attach; different .qbw open → 9007 file-conflict).

## Next Task

**Only Phase 19 #92 remains — and it's blocked on a non-technical decision, not code.**

- [ ] **#92.** (Lower priority) Windows installer — bundle the Node runtime + built CLI into a **signed** `.exe` via `pkg` or `oclif`, to reach accountants who would never type `npx`. **Gating decision is the code-signing certificate (~$200-400/yr), not the packaging.** Do NOT start building this without the operator first deciding (a) whether there's real non-developer demand and (b) whether they'll buy a signing cert — an unsigned installer trips SmartScreen and is worse than the `npx` path for trust. **Recommend surfacing this as a question to the operator rather than auto-starting it.**

If the operator does not want #92 yet, **Phase 19 (and the whole fix list) is complete.** Reasonable forward motion in that case: a final pass on the carried Windows-only live verifications (they're the only `partial` items left across the project), or close out the project formally.

## Context Notes

- **#91 reused #90's exe-detection chain by design.** The doctor imports `resolveQBDesktopExe` + `defaultRegistryQuery` + `defaultFileExists` from [src/util/qb-desktop-launch.ts](src/util/qb-desktop-launch.ts) — do NOT reimplement. The known-paths list there is the shared brittle surface: a QB install at a non-standard path with no registry `InstallPath` reports `✗ QuickBooks Desktop` in the doctor even when QB is present. `QB_DESKTOP_EXE` is the escape hatch and fixes both the doctor probe AND the launcher in one shot. (Observed live: this box has QBXMLRP2 registered but no exe at a known path.)

- **Doctor test-seam pattern.** `runDoctor` / the `probe*` helpers / `formatReport` are pure over `DoctorDeps`. To test a branch, build a deps bag with `makeDeps({ ...override })` in [tests/doctor.test.ts](tests/doctor.test.ts) and assert on the returned `ProbeResult` / `DoctorReport`. The real side-effecting probes (`defaultComRegistered`, `defaultWinaxStatus`, `defaultRegistryQuery`, `defaultFileExists`) are only wired in `buildDefaultDeps()` — never call them from a test.

- **Probe judgement calls that look opinionated but are deliberate** (all in DECISIONS.md 2026-05-29): Node major-20-only is a hard fail (not a warn) because v22 breaks winax; `QB_COMPANY_FILE` unset is a fail (headline live setting) while `QB_COMPANY_ROOT` unset is `ok` (it defaults to dirname); non-Windows is `skip` not `fail` (sim mode is the documented default); `fail` outranks `skip` for the exit code.

- **The CLI entry guard** is `import.meta.url === pathToFileURL(process.argv[1]).href`. This keeps `main()` from printing/exiting when vitest imports the module. If you add another bin or move the file, preserve that guard or tests will call `process.exit`.

- **Carried gotchas** (unchanged from #90's handoff — still authoritative):
  - QBXMLRP2 cannot OPEN a `.qbw` — only attach. #90's auto-launch path spawns QB Desktop with the .qbw as a process arg to resolve this.
  - Live verification requires `C:\nvm4w\nodejs\node.exe` v20.20.2 (system PATH v22 breaks winax) — this is exactly what the doctor's Node-version probe enforces.
  - `winax` is in `optionalDependencies` — non-Windows installs skip it cleanly; the doctor's winax probe `skip`s off-Windows accordingly.
  - statusCodes: 9001 read-only, 9002 idempotency conflict, 9003 edition, 9004 payroll, 9005 SDK-no-write, 9006 reserved-but-zero-emit, 9007 launch failure, 9008 multi-user lock. (The doctor uses its own `ok`/`fail`/`skip` model + 0/1/2 exit codes — it does NOT emit QB statusCodes; it's a pre-flight CLI, not a tool handler.)
  - `*Core` private methods are the chokepoint for dry-run + read-only gating.
  - `structuredClone` is the deep-clone primitive in sim store snapshot/restore.
  - `idCounter` ticks twice per add (ListID + EditSequence).
  - `fast-xml-parser` doesn't decode numeric character entities; DOES coerce numeric-looking text to numbers.
  - Dispatch order in sim `processRequest`: non-entity-typed `*QueryRq` / `*ModRq` / `AttachableAddRq` / `DataExtDefQueryRq` MUST precede the `endsWith` catch-alls.

- **Phase 19 numbering** ends at #92. There is no #93 — the fix list is closed once #92 is resolved (built or explicitly deferred).

- **DO NOT re-debate** npm publishing (DECISIONS.md 2026-05-24) or #90's design Qs (DECISIONS.md 2026-05-28).
