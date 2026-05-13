# Handoff State

_Last updated: 2026-05-13. **#67 `qb_session_status` CLOSED.** Single new tool composing #82 (HostInfo), #84 (transient-retry observability), and #85 (closing date) into one cheap diagnostic snapshot. Tool count 105 → 106; 876 → 895 tests green. Carried-forward Phase 18 #85/#86 work from the prior session is also in the tree (still uncommitted — operator's call when to commit)._

## Last Session Summary

- **#67 `qb_session_status` — CLOSED.** New tool in [src/tools/reports.ts](src/tools/reports.ts) registered next to `qb_session_connect` / `qb_session_disconnect`. Returns a structured snapshot of the current session: `connected`, `mode` (`simulation`|`live`), `companyFile`, `appName`, `appId`, `qbxmlVersion`, `readOnly`, `ticket`, `openedAt`, `serverVersion`, cached `hostInfo` (peek-only — never triggers a fetch), and `retryStats: { lastTransientRetryAt, transientRetryCountLastHour, totalTransientRetries }`. **Default path is zero wire I/O.** Opt-in `probe: true` runs a fresh `HostQueryRq` with `refresh: true` (lightest available real-wire call) as an active connection probe; `includeClosingDate: true` folds `PreferencesQueryRq` into the response. **Both opt-ins are fail-soft** — a probe / closing-date failure surfaces inside the response without making the outer call `isError`, so orchestration callers can rely on the snapshot to ALWAYS return a structured shape.

- **Session manager additions.** [src/session/manager.ts](src/session/manager.ts) gained transient-retry observability: `transientRetryTimestamps: number[]` + `totalTransientRetries: number` pushed inside `sendLiveRequestWithRetry`'s catch (before the sleep, after the classification check, so only retries that actually fire are counted — not transient errors on the LAST attempt). New `getTransientRetryStats()` prunes timestamps older than 1 hour on read (in-place; cheap for the common "no retries" case). New `getAppName()` / `getAppId()` / `getQbxmlVersion()` getters mirror the existing `getCompanyFile()` / `isReadOnly()` / `isSimulation()` pattern. `switchCompanyFile` now ALSO clears the retry observability state (a fresh book is a fresh observability window — a stale `lastTransientRetryAt` from book A would falsely imply recent instability on book B otherwise).

- **Tests.** 19 new tests in [tests/session-status.test.ts](tests/session-status.test.ts) across 6 layers: config getters, rolling-window prune math (including stale-only and in-window cases), default snapshot shape verified with a `vi.spyOn` on `queryEntity` to assert zero wire I/O, `readOnly` toggle, host-info cache surfacing after a real `getHostInfo()` call, probe happy + sad (sad surfaces `probe.ok: false` WITHOUT making outer `isError`), `includeClosingDate` happy + sad (same fail-soft pattern), retry stats surfacing through the tool, `switchCompanyFile` clearing both retry stats and host-info cache. 876 → 895 tests green.

- **Docs.** [README.md](README.md) tool count 105 → 106 + new row in Session Management table. [src/index.ts](src/index.ts) instructions block extended on the `qb_session_*` line to document the new tool's shape + the fail-soft contract. [todo.md](todo.md) #67 flipped to `[x]` with full closeout notes.

## Verify Before Continuing

Re-run if the tree has been touched (skip if next session starts within hours):

- [ ] `npm run build` → exit 0 (tsc clean).
- [ ] `npm test` → `Test Files 39 passed | Tests 895 passed`.
- [ ] `"" | & node dist/index.js` → exit 0, `Mode: simulation` printed; banner does NOT print "QBXML debug log: enabled" when `QB_DEBUG_QBXML` is unset.
- [ ] **(Windows + QB) First live exercise of `qb_session_status`.** Call `qb_session_status({})` against `VR Tax & Consulting Inc..qbw` and confirm: `mode: "live"`, `companyFile` non-empty, `connected: true`, `retryStats.totalTransientRetries: 0` (assuming a clean session), `hostInfo` is `null` UNLESS a prior `qb_host_query` ran. Then call `qb_session_status({ probe: true })` and confirm `probe.ok: true` and `hostInfo` is now populated. Finally call `qb_session_status({ includeClosingDate: true })` and confirm `closingDate.closingDate` matches what `qb_closing_date_get({})` returns.
- [ ] **(Windows + QB) Carried from prior session — Phase 18 #85 / #86 first-live exercises.** `qb_closing_date_get` wire shape (verify `PreferencesQueryRs.PreferencesRet.AccountingPreferences.ClosingDate` is the actual emitted path); `qb_closing_date_set` returns 9005 with UI navigation; all five MCP prompts (`/month_end_close`, `/credit_card_qb_batch`, `/trial_balance_workup`, `/cc_statement_validator`, `/w2_prep`) surface in Claude Desktop's `/` picker.
- [ ] **(Windows + QB) Carried from earlier sessions — #84 transient-retry path, #82 host_query field surface, #55 W-2 wire shape, #59 attachment enablement, #54 SCF section labels.** All verified-by-construction structurally but not live-pinned. Lowest priority; details preserved in git history.

## Next Task

**Operator picks next.** With #67 closed, the highest-leverage remaining items are:

- **#68 `qb_trial_balance_export(asOfDate, basis)`** (Phase 15) — would let the new `/trial_balance_workup` prompt simplify from a multi-tool recipe to one call. Operator's `trial-balance-workup` skill already specifies the exact column shape — coordinate with the skill before shipping.

- **#75 banking primitives** (Phase 17) — would unblock real bank reconciliation workflows. Currently the reconciliation tools (`qb_cleared_status_update`, `qb_uncleared_transactions`, `qb_reconciliation_discrepancy`) are present but the create-side primitives (Deposit, Transfer, Check directly to a bank account) are not.

- **#78 time tracking** (Phase 17) — unblocks #70 (`qb_engagement_profitability`) which can't compute hours-per-job without `TimeTrackingQueryRq`.

- **#76 sales orders / #77 sales tax / #80 inventory adjustments / #81 statement charges** — domain coverage gaps from Phase 17. None block existing work but each opens a workflow surface.

- **Phase 13–14 coverage gaps** — custom fields / DataExt (#61), sub-customer hierarchy (#62), memo full-text search (#63), dry-run mode (#64), better error surfaces (#65), audit log (#66 — Enterprise-only).

## Context Notes

- **#67 default path is zero wire I/O — that's load-bearing.** The whole point of the tool is to be cheap enough to call from orchestration retry loops without burning a round trip. `peekHostInfoCache()` is a pure local-state read; `getTransientRetryStats()` is a prune + count, also pure local. Resist any future urge to "improve" the default by adding a HostQueryRq probe — that breaks the contract. Use `probe: true` for the active probe, that's what it's for.

- **#67 `hostInfo` is peeked AFTER the probe runs (not at function entry).** When `probe: true` populates the cache, the snapshot reflects that. This is intentional — the probe's purpose is to update wire state, and the snapshot should observe it. Pinned by the test "probe with refresh:true forces a wire call even when the cache is populated".

- **#67 fail-soft contract on `probe` and `includeClosingDate` is a deliberate design choice.** An orchestrator calling `qb_session_status({ probe: true })` to decide whether to retry should ALWAYS get a structured response — not an `isError: true` shape that needs different parsing. Failures land INSIDE the response (`probe.ok: false` or `closingDate.error: {...}`). The outer call only fails when something local breaks (which currently can't happen — all the local-state reads are infallible).

- **#67 retry observability uses an in-place prune, not a filter.** `getTransientRetryStats()` does `while (oldestStale) shift()` rather than `arr.filter(...)`. The common case is "no transient retries ever fired" — filter would allocate a new array on every read for no reason. The prune is bounded by the number of stale entries (usually zero).

- **#67 retry tracking pushes BEFORE the sleep, not after.** A test that intercepts `sleepImpl` with a stub that never resolves can still observe the retry firing through the snapshot. Conversely, only retries that the loop actually decides to fire (post-classification, pre-sleep) are counted — transient errors on the LAST attempt propagate without a retry and aren't counted. That's the right semantic: the counter measures retries fired, not transient errors observed.

- **#67 retry tracking survives `reconnectAfterTransientError` BUT is cleared on `switchCompanyFile`.** Same discipline as `readOnly` / `idempotencyCache` / `hostInfoCache`: per-process state survives a connection reset (the reset is the point), but switching books is a fresh observability window. Pinned by the "switchCompanyFile resets observability state" test.

- **#67 `SERVER_VERSION` is hardcoded in `src/tools/reports.ts` as `"1.0.0"`.** Kept in lockstep with the `McpServer({ version: "1.0.0" })` literal in [src/index.ts](src/index.ts). If either moves, both must move. Importing across modules would create a cycle (index → reports → index); reading package.json at module load would add filesystem I/O at boot for one string. Two-line const + a comment explaining the discipline is the lighter approach.

- **Carried gotchas (unchanged from prior handoffs):**
  - **#85 SDK gap is permanent.** Do not speculatively wire a `PreferencesModRq` builder hoping it'll exist in a future qbXML version. The grep evidence (zero hits across qbxmlops20.xml → qbxmlops140.xml) is logged in [DECISIONS.md](DECISIONS.md). The canonical response for any future preference write is the same 9005 + UI navigation pattern.
  - **#85 synthetic statusCode reservations**: 9001 read-only, 9002 idempotency conflict, 9003 edition unsupported, 9004 payroll subscription required, **9005 SDK has no write path**, 9006+ reserved.
  - **#86 prompts registration uses a `reg<Args>(entry)` helper + `as const` tuple** — load-bearing. If adding a new prompt, follow the same `reg({...})` pattern, never push a typed registration directly into the tuple.
  - **Three transaction-type lists must stay in sync**: `buildDeleteRequest` in [src/qbxml/builder.ts](src/qbxml/builder.ts), inline `isTransaction` in `manager.deleteEntity` ([src/session/manager.ts](src/session/manager.ts)), `isTransactionType` in [src/session/simulation-store.ts](src/session/simulation-store.ts). Canonical 16-type set documented in [CLAUDE.md](CLAUDE.md).
  - **AR-side `Customer.Balance` discount math is correct; AP-side is NOT.** `applyTxnApplications` / `reverseReceivePaymentApplication` (AR) move balance by `appliedSum + discountSum`. `applyBillPayment` (AP) still moves only by `appliedSum`. Future `qb_bill_write_off` needs the parallel fix.
  - **Dispatch order in `processRequest`**: non-entity-typed `*QueryRq` / `*ModRq` / `AttachableAddRq` branches MUST precede the `endsWith` catch-alls.
  - **Iterator wire names diverge**: `iterator`/`iteratorID` on request, `iteratorRemainingCount`/`iteratorID` on response.
  - **fast-xml-parser does NOT decode numeric character entities** — use `decodeXmlEntities` in [parser.ts](src/qbxml/parser.ts).
  - **Live verification requires `C:\nvm4w\nodejs\node.exe` v20.20.2** (system PATH v22 breaks winax).
  - **QBXMLRP2 cannot OPEN a `.qbw`**, only attach to one QB Desktop has already loaded.
  - **BillPayment* total is on `TotalAmount`**, not `Amount` — coalesce `TotalAmount ?? Amount` for BillPaymentCheck / BillPaymentCreditCard; Check / CreditCard* / Transfer use `Amount` directly.
  - **Bill ItemLineAdd in test fixtures should pass explicit `Amount`** (or use Rate) — the sim's `convertLineAddToRet` computes `Amount = Quantity * Rate` and Bill ItemLineAdd's `Cost` field isn't picked up there.
