# Handoff State

_Last updated: 2026-05-20. **Phase 16 #74 closed.** MCP-side lookup cache shipped — 5-minute TTL cache of unfiltered list calls (Account, Customer, Item subtypes, Terms subtypes, Class) collapses repeated read round trips into in-process Map reads. New `qb_cache_invalidate` tool brings the surface to **150 tools**. Tests **1629** (+44). All work since #62 still uncommitted on master (operator handles commits)._

## Last Session Summary

- **Phase 16 #74 implementation landed end-to-end.** Goals: collapse redundant wire calls on the 5 stable-lookup domains (chart of accounts, customer list, item list, terms list, class list) that an agent typically reads multiple times per workflow.
- **New primitive** [src/session/lookup-cache.ts](src/session/lookup-cache.ts) — `QBLookupCache` class. Surface: `get(entityType)` / `set(entityType, entities)` / `invalidate(entityType?)` / `companyFileChanged(newFile)` / `keys()` / `getCompanyFile()` / `getTtlMs()` / `fetchedAt()`. Lazy TTL eviction on read (cheaper than a background timer). Default TTL 5 minutes (`DEFAULT_LOOKUP_TTL_MS`). Entities held verbatim — callers MUST treat them as immutable (list tools emit into JSON, never mutate, so safe by construction).
- **Wired into [QBSessionManager](src/session/manager.ts)** — `private readonly lookupCache: QBLookupCache` instantiated in constructor with the initial `companyFile`. Exposed via new `getLookupCache()` public accessor. `switchCompanyFile` calls `lookupCache.companyFileChanged(companyFile)` alongside the existing idempotency / hostInfo / transient-retry clear block (fresh book is a fresh set of stable lookups).
- **Threaded `useCache` through 5 list tools** — `qb_account_list` ([src/tools/accounts.ts](src/tools/accounts.ts)), `qb_customer_list` ([src/tools/customers.ts](src/tools/customers.ts)), `qb_item_list` ([src/tools/items.ts](src/tools/items.ts)), `qb_terms_list` + `qb_class_list` ([src/tools/lists.ts](src/tools/lists.ts)). Each gains a `useCache: boolean` arg (default true). **Cache eligibility** = `isUnfilteredCall && isRegularCall`:
  - **Unfiltered** = no nameFilter / listId / accountType / parentListID / jobOnly / includeCustomFields AND activeOnly !== false.
  - **Regular** = no paginate / iteratorID / **autoExhaust** — each of those is an explicit "go pull from QB" intent.
- **Read vs write split is load-bearing.** `paginate` / `iteratorID` / `autoExhaust` BYPASS the READ but `autoExhaust` STILL WRITES on completion (no cap-hit) — a successful exhaustion IS the canonical "give me everything" result and primes the next call. **This was the source of the 20-test regression** mid-implementation: initial design had autoExhaust also reading from cache, which broke Layer 10 iterator tests that expected `batchesExhausted` in the response shape. Fixed by splitting `cacheRead` (gated by `isRegularCall`) from `cacheWrite` (not gated). Future paths that add new "explicit fetch" intents (e.g. a future `forceRefresh:true`) should follow the same split.
- **Per-subtype keying.** `qb_item_list` keys under `Item${itemType}` (5 independent slots — Service / Inventory / NonInventory / OtherCharge / Group). No-itemType fan-out caches each slot, but the no-itemType cache hit only serves when ALL 5 slots are populated + fresh — partial hits silently undercount, so we fall through to wire. `qb_terms_list` mirrors this with StandardTerms + DateDrivenTerms; the `TermsType` per-row tag is re-emitted on cache hit (tool-layer enrichment, wire result stored verbatim).
- **New tool `qb_cache_invalidate`** ([src/tools/cache.ts](src/tools/cache.ts)) with `entity?: 'Account' | 'Customer' | 'Item' | 'Terms' | 'Class'` (omit to clear all). User-facing names hide subtype keying — `'Item'` clears all 5 Item* slots, `'Terms'` clears both Terms subtypes. Returns `{ scope, cleared, count }` listing only slots that were actually cleared. Empty-cache success returns `cleared: []`.
- **Response shape** on cache hit: same as wire response + `fromCache: true` field. Caller can branch on it (e.g. "if fromCache, also invalidate before retry" — but most callers don't need to).
- **44 new tests** in [tests/lookup-cache.test.ts](tests/lookup-cache.test.ts) across 5 layers — primitive (Layer 1), manager integration (Layer 2), per-tool hit/miss/bypass (Layer 3 — covers each of the 5 tools), `qb_cache_invalidate` surface (Layer 4 — scoped + all-clear + empty + bad-entity schema reject), end-to-end lifecycle (Layer 5 — populate→invalidate→repopulate, switchCompanyFile, partial Item invalidate falls through).
- **Adjacent test fix**: [tests/iterator.test.ts](tests/iterator.test.ts) "qb_customer_list without paginate has no MaxReturned default" pinned with `useCache: false`. The test calls `qb_customer_list({})` after the cache is warmed by earlier tests in the same file; the cache intercepts that path post-#74. Adding the flag keeps the legacy-contract verification honest without changing what's being verified.
- **README.md** tool count 149 → 150, architecture diagram updated, new "Cache Management" section added between Bank Reconciliation and Workflow Prompts. **[src/index.ts](src/index.ts)** instructions block extended with dedicated `qb_cache_invalidate` line. **todo.md #74** marked closed with full implementation context inlined.
- **Counts.** 1585 → 1629 tests green. Tool count 149 → 150. Build clean.

## Verify Before Continuing

Re-run only if the tree's been touched. Skip if next session starts within hours of the last sim run (2026-05-20).

- [ ] `npm run build` → exit 0 (tsc clean).
- [ ] `npm test` → `Test Files 61 passed | Tests 1629 passed`.
- [ ] `"" | & node dist/index.js` → exit 0, `Mode: simulation` banner printed.
- [ ] **(Windows + QB) NEW — #74 live spot-check.** Wire path is just `queryEntity` (no new wire types — this is purely an in-process cache layer). Risk is shaped like "cache serves stale data after an out-of-band edit in QB UI" or "cache hit silently undercounts on a partial Item* fan-out miss". Lightest exercise:
  - `qb_account_list({})` (twice) → first call hits the wire, second returns `fromCache: true` with zero wire I/O. Capture envelope via `QB_DEBUG_QBXML=1` to confirm wire is silent on the second call.
  - `qb_customer_list({})` → same pattern. Then `qb_cache_invalidate({ entity: 'Customer' })` → next `qb_customer_list({})` re-hits the wire.
  - `qb_item_list({ itemType: 'Service' })` (twice) → confirm second is `fromCache:true`. Then `qb_item_list({})` → confirm wire fan-out (4 round trips for the missing 4 subtypes; ItemService slot's hit isn't served on the no-itemType path because the merged-cache path requires all 5).
  - `qb_terms_list({})` (twice) → confirm second is `fromCache:true` and `TermsType` tag re-emits correctly.
  - `qb_customer_list({ autoExhaust: true })` → confirm the wire still loops (autoExhaust bypasses read) and `batchesExhausted` is in the response shape. After completion, a plain `qb_customer_list({})` should return `fromCache:true` (autoExhaust's write-back primed it).
  - `qb_company_open({ companyFile: <path-to-different-file> })` (if a second client `.qbw` is available) → after switch, `qb_customer_list({})` re-hits the wire (cache cleared by `companyFileChanged`).
- [ ] **(Windows + QB) Carried — #73 live spot-check across the 7 paginated tools.** Wire path is `queryEntityPaginated` (Start → Continue → ...). See prior handoff for the full per-tool exercise list.
- [ ] **(Windows + QB) Carried — #63 live spot-check** for `qb_transaction_memo_search` (typed `*QueryRq` fanout).
- [ ] **(Windows + QB Enterprise) Carried — #66 live envelope verification** for `qb_audit_log`. Operator's book is Premier Accountant — expect 9003. Test against any available Enterprise install (or accept #66 as sim-verified-only).
- [ ] **(Windows + QB) Carried — #64a live envelope spot-check** across pattern categories.
- [ ] **(Windows + QB) Carried — #64 / #62 / #60 / #65 / #61** first live exercises.
- [ ] **(Windows + QB) Lowest priority** — carried 18-item live-exercise bucket from prior handoffs.

## Next Task

The todo.md is **CLOSED through #74** with the sole exception of **#64b** — dry-run V2 for the 11 composite outliers (write-off, batch creates, duplicates, conversions, bill_pay). Status: explicitly deferred until operator-feedback on V1/#64a makes the ergonomics worth iterating on; status code 9006 is reserved for the "dry-run not supported in this mode" rejection.

### Pick from one of:

**Option A — #64b composite-outlier dry-run V2.** Eleven tools need per-tool design (peek idempotency cache? snapshot sim store before the read step? what does "would happen" mean for the rollback path?). Implementation-ready spec lives in todo.md:127. Two candidate framings: bespoke per-tool dryRun against a shared snapshot, OR 9006 across the board for one-offs. Tentative recommendation: bespoke for workflow-critical composites (write-off, batch tools), 9006 for one-offs (duplicates, conversions).

**Option B — Live verification sweep.** Many carried "first live exercise" items just need operator time at a Windows + QB Desktop box. Highest payoff is #74's live spot-check (the new cache work) — sim-verified end-to-end but the in-process cache layer has zero observable wire effect, so live verification is mostly "confirm wire is silent on the second call" via `QB_DEBUG_QBXML=1` envelope capture.

**Option C — Open-ended improvement.** If the operator has a workflow that's still painful, pick a fresh item. Phase 18 robustness picks are closed; the natural next layer would be "what new domain coverage does the operator's actual practice still want?". Examples: a tax-form-1040-summary tool that aggregates K-1 inputs across an S-corp's books, an automated trial-balance cross-checker against last year's filed return, etc. None of these are in todo.md yet — operator-driven.

## Context Notes

- **The Read vs Write cache eligibility split is load-bearing.** Future paths that add new "explicit fetch" intents (a hypothetical `forceRefresh:true`, a future `bypassCache:true`) should follow the same pattern — bypass the READ via `isRegularCall`, opt into WRITE-back via `cacheWrite`. Mid-implementation we initially had autoExhaust also reading from cache, which broke 20 iterator Layer 10 tests; the fix is the split. Same pattern applies if a future tool adds something like `bulkExport:true`.

- **Per-subtype keying for Item + Terms is intentional.** A user-facing `qb_cache_invalidate({entity:'Item'})` clears all 5 subtypes — that's what an operator who just edited an item in QB UI expects. But internally the cache keys per subtype because each subtype is a separate wire request (`Item*QueryRq`). Don't collapse this to a single `Item` key — the no-itemType fan-out path would lose the ability to partially cache (e.g. a user who only ever calls `qb_item_list({itemType:'Service'})` shouldn't have their cache invalidated because someone else called the no-itemType path).

- **The merged-cache "all 5 subtypes must hit" rule for no-itemType `qb_item_list`.** Partial hits would silently undercount (return 4 subtypes' worth as if it were the full set) — that's the wrong failure mode. Same applies to `qb_terms_list` (both subtypes required for the default fan-out cache hit).

- **TTL is lazy on read.** The cache doesn't have a background eviction timer. An aged entry is only evicted when `get()` is called against it. This is cheaper than a timer and correct — there's no harm in holding an expired entry in memory between reads. If memory ever becomes a concern, add `cache.cleanupExpired()` and call it from `qb_session_status` (which currently runs zero wire I/O — adding a cheap O(n) cache prune is fine).

- **Cache write doesn't deep-clone.** Entities are held by reference. If a future tool layer needs to enrich cached entities (e.g. inject a `TermsType` tag on every row), it MUST clone first — otherwise the cached entry gets mutated and the next cache hit returns the mutated version. The existing tool layer is safe: every tool emits cached entities into a JSON.stringify response without mutation, AND `qb_terms_list`'s tag re-emission uses `.map((e) => ({ ...e, TermsType }))` (spread-clone per row).

- **Cache scope is per-session, per-companyFile.** Two `QBSessionManager` instances have independent caches (pinned by a Layer 2 test). `switchCompanyFile` clears via `companyFileChanged`. There's no cross-process cache (no Redis, no filesystem persistence) — that's intentional. The cache exists to dodge wire round trips within a single agent session; across sessions, the data IS the source of truth and should be re-fetched.

- **The `fromCache: true` response field.** New on every cached-hit response, never on a wire response. Tests use it as the assertion key. Callers don't need to branch on it (the entity shape is identical) but it's a useful signal for orchestration-layer "retry with fresh data" patterns.

- **Carried gotchas** (still apply):
  - **#73's autoExhaust pattern is pinned across 7 tools.** Mutex, MaxReturned coalesce, accumulate-then-filter, cap-hit response shape, sim caveat in warning.
  - **statusCodes** — 9001 read-only, 9002 idempotency conflict, 9003 edition, 9004 payroll, 9005 SDK-no-write, **9006 reserved for dry-run-not-supported** (still pending #64b composite outliers).
  - **The `*Core` refactor is load-bearing** (DECISIONS.md V1 entry).
  - **`structuredClone` is the deep-clone primitive** in the sim store. Now also clones `auditTrail` in snapshot/restore.
  - **`idCounter` ticks TWICE per add** (ListID via `nextId()` + EditSequence via `nextEditSequence()`).
  - **#64a dry-run rollout pattern is baseline.** Any new mutation tool MUST thread `dryRun`.
  - **Live-mode dry-run never hits the wire.**
  - `fast-xml-parser` does NOT decode numeric character entities (use `decodeXmlEntities`). DOES coerce numeric-looking text to numbers.
  - Live verification requires `C:\nvm4w\nodejs\node.exe` v20.20.2 (system PATH v22 breaks winax).
  - AR-side `Customer.Balance` discount math is correct; AP-side is NOT — future `qb_bill_write_off` needs the parallel fix.
  - Dispatch order in `processRequest` — non-entity-typed `*QueryRq` / `*ModRq` / `AttachableAddRq` / `DataExtDefQueryRq` MUST precede the `endsWith` catch-alls.
  - Iterator wire names diverge — `iterator` / `iteratorID` on request; `iteratorRemainingCount` / `iteratorID` on response.
  - QBXMLRP2 cannot OPEN a `.qbw` — only attach to one QB Desktop has already loaded.
  - `BillPayment*` total is on `TotalAmount`, not `Amount` — coalesce `TotalAmount ?? Amount`.
  - **#66 wire-shape decision is load-bearing for any future audit-trail-related work.** `AuditTrail` is a `CustomDetailReportType` value, NOT a `TxnReportType` value. DECISIONS.md 2026-05-20 entry pins the reasoning.
