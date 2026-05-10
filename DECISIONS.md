# Decisions Log

Record meaningful technical decisions here. Append new entries at the top. Each entry answers: **what was chosen**, **why**, **alternatives rejected**, **tradeoffs**.

Skip trivial choices. Log when a future session would otherwise re-debate the same point, when a structural pattern was rejected, or when a constraint forced an unusual approach.

---

## Template

```markdown
## YYYY-MM-DD — <Short title>

**Chosen:** <what was decided>

**Why:** <reasoning, including the constraint or evidence that drove it>

**Alternatives rejected:**
- <option> — <why not>
- <option> — <why not>

**Tradeoffs / consequences:**
- <what we now have to live with>
- <what becomes harder>
- <what becomes easier>

**Revisit when:** <condition that should trigger reconsidering, or "no scheduled revisit">
```

---

## 2026-05-10 — Memorized transactions not exposed by QBXML SDK (#45 closed SDK-blocked)

**Chosen:** Close Phase 10 #45 ("Memorized / recurring transaction CRUD") as not-actionable, no implementation. Address the operator's underlying pain (monthly retainer billing across hundreds of bookkeeping clients) with a separate Phase 12 workflow tool, `qb_invoice_duplicate`, queued as new item #57a.

**Why:** Verified directly against the qbwc/qbxml master mirrors of Intuit's official SDK XSDs (qbxmlops130.xml and qbxmlops140.xml, 2.77 MB each — the highest schema versions Intuit publishes; SDK 15/16 added no new entity types in this area). Search results: the only mention of `memorizedTxn` in the entire 2.77 MB schema is as a `rowType` enumeration value inside `ListDeletedQueryRq` (a way to query *deletion records* of memorized templates — not the live list). There is **no** `MemorizedTransactionListQueryRq`, **no** `MemorizedTxnListQueryRq`, **no** Add / Mod / Del / Execute / Submit for memorized transactions in any SDK version. Intuit's long-standing posture (confirmed by community discussions on the help forum): memorized transactions are managed exclusively through QuickBooks Desktop's UI (Ctrl+M on an open transaction) and auto-executed by QB's internal scheduler. The SDK does not expose the recurring/memorized list to integrators at all.

The HANDOFF's framing ("Intuit's SDK supports read + execute well; create is partial") was incorrect at every layer. Without QBXML elements to wrap, there is nothing to implement.

The operator's actual need — being able to bill monthly retainers without retyping every line — is well served by a tool that DOESN'T need memorized-transaction SDK support: read a prior month's invoice, copy its lines into a fresh `InvoiceAddRq` with a new `TxnDate` / `RefNumber`. Same outcome as right-click "Use" on a QB-Desktop memorized template, just routed through SDK elements that DO exist. Queued as Phase 12 item #57a (`qb_invoice_duplicate`).

**Alternatives rejected:**

- **Implement `ListDeletedQueryRq` filtered to `rowType=memorizedTxn`.** The one SDK affordance that touches memorized transactions. But the operator's pain isn't "I need to see which templates were deleted" — they need to USE the live ones. A deletion-history tool would be cosmetic; nobody asked for it.
- **Wrap QBFC (the COM library) instead of QBXML.** QBFC has slightly broader surface than QBXML for some operations, but research suggests memorized-transaction CRUD is unsupported there too (the gap is at the SDK level, not the wire-protocol level). Adding a COM dependency to dodge a missing feature wouldn't actually deliver it.
- **Build a sim-only mock implementation.** Would violate the NF1 mode-parity invariant (sim claims to do something live mode physically cannot). Worse, would create a foot-gun for operators who develop against sim and discover the gap only after going live.
- **Wait for SDK 17/18 to add it.** Intuit hasn't shipped a meaningful QBXML feature addition in years; this is unlikely to ever land.

**Tradeoffs / consequences:**

- The operator continues to manage memorized templates through QB Desktop's UI (Ctrl+M / Lists → Memorized Transactions). No regression — they already do this.
- `qb_invoice_duplicate` (Phase 12 #57a) gives them the same workflow value for the most common case (monthly retainer billing) without depending on SDK features that don't exist.
- A small block of work (the original #45 estimate) is reclaimed for higher-value tools.
- Carried gotcha for future sessions: do not re-litigate #45 if memorized-transaction tools come up in a different framing. The SDK surface is verified absent at the schema level.

**Revisit when:** Intuit ships a new QBXML SDK version with explicit memorized-transaction support (would appear in qbxmlops150.xml or higher). No scheduled revisit; check the qbwc/qbxml repo when SDK 17 releases.

---

## 2026-05-10 — Bank reconciliation SDK surface — ClearedStatusModRq is the actual primitive (#46 closed with narrowed scope)

**Chosen:** Ship Phase 10 #46 as `qb_cleared_status_update` only — a single write tool wrapping `ClearedStatusModRq`. Defer the read side (which transactions are uncleared) to Phase 11 #56 (which has the matching `CustomDetailReportQueryRq` infrastructure) and a new companion #56a (`qb_uncleared_transactions`).

**Why:** The original HANDOFF's premise — that #46 is a "read-only well-supported" scope and writing reconciliation state isn't possible — turned out to be wrong in **both** directions. Schema research against qbxmlops130.xml + qbxmlops140.xml found:

1. **No `ReconcileQueryRq`** anywhere in the schema (search for "reconcil" found only `SpecialAccountType=ReconciliationDifferences` — a metadata flag, not a query element).
2. **No `ReconcileDetail` GeneralDetailReportType** — the full enum includes `1099Detail`, `AuditTrail`, `BalanceSheetDetail`, `CheckDetail`, `CustomerBalanceDetail`, `DepositDetail`, `MissingChecks`, `Journal`, `OpenInvoices`, etc., but no "Reconcile" or "Uncleared" types.
3. **No `LastReconciledDate` / `LastReconciledBalance` field on AccountRet** (so even "when was account X last reconciled" can't be read directly).
4. **`ClearedStatus` is NOT a filter on any *QueryRq and NOT in any *Ret output** — only appears as `ClearedStatusModRq` input and as a column in `CustomDetailReportQueryRq` output (via `IncludeColumn=ClearedStatus`).
5. **`ClearedStatusModRq` DOES exist** — and is unambiguously the write primitive bank reconciliation is built on. Takes `TxnID` + optional `TxnLineID` + `ClearedStatus` (enum: `Cleared`/`NotCleared`/`Pending`). The QB Desktop reconciliation UI is just a UX wrapper around a sequence of these.

So the actual SDK affordance is the OPPOSITE of what was assumed: the write side IS supported, and the read side requires custom-report infrastructure that hadn't landed yet. Shipping just the write primitive gives the operator real workflow value immediately (they can pair QB Desktop's reconcile screen with bulk `qb_cleared_status_update` agent calls — replaces clicking every line by hand), while the read side gets done correctly in Phase 11 alongside #56 which needs the same `CustomDetailReportQueryRq` plumbing.

**Implementation:**

- New `buildClearedStatusModRequest(params, version)` helper in [src/qbxml/builder.ts](src/qbxml/builder.ts). Emits `TxnID → TxnLineID? → ClearedStatus` in schema order (pinned in [tests/reconciliation.test.ts](tests/reconciliation.test.ts)).
- New `session.updateClearedStatus({txnId, clearedStatus, txnLineId?})` method in [src/session/manager.ts](src/session/manager.ts). Routes through `assertWritable` (read-only sessions reject with `QBReadOnlyError` / statusCode 9001 before any envelope is built). Idempotency cache is intentionally NOT applied — the operation is naturally idempotent (flipping Cleared on an already-Cleared txn is a server no-op) and fingerprinting wouldn't add value.
- New `handleClearedStatusMod` in [src/session/simulation-store.ts](src/session/simulation-store.ts). Walks the seven bank-affecting transaction stores (Check / BillPaymentCheck / BillPaymentCreditCard / Deposit / Transfer / CreditCardCharge / CreditCardCredit). Distinguishes statusCode 3120 ("TxnID exists but txn type doesn't support cleared status" — probes Invoice/Bill/JE/etc. stores explicitly) from 500 ("TxnID doesn't exist anywhere") so error surfaces are useful. Default `ClearedStatus: "NotCleared"` on bank-affecting `handleAdd` matches real QB behavior.
- Dispatch fix in `processRequest`: the `key === "ClearedStatusModRq"` branch must precede the `key.endsWith("ModRq")` catch-all (which would otherwise derive a "ClearedStatus" entity type and call handleMod expecting a ListID). Caught early via test failures.
- New `qb_cleared_status_update` tool in [src/tools/reconciliation.ts](src/tools/reconciliation.ts). Zod enum on `clearedStatus`; rejects unknown values at the schema layer. Error wrapper surfaces statusCode + humanReadable via the existing Item 25 pattern.
- 23 new tests in [tests/reconciliation.test.ts](tests/reconciliation.test.ts) covering all four layers.

**Alternatives rejected:**

- **Ship both `qb_cleared_status_update` AND a sim-only `qb_uncleared_transactions` (live mode returns "use Phase 11" error).** Tempting — gets two tools out of #46. Rejected because it violates the NF1 mode-parity invariant: the same call would succeed in sim and fail in live, creating dev-vs-prod skew the operator would hit at the worst possible moment (middle of month-end close).
- **Implement `CustomDetailReportQueryRq` infrastructure in this session.** Would let both write + read ship under #46 with mode parity. Rejected on scope grounds — CustomDetailReport's row-tree shape is structurally similar to PnL/BS (which already have `adaptLiveReportRet` plumbing) but the IncludeColumn + IncludeAccount + filter combinatorics is its own substantial design. Better landed once, in #56, where it can serve multiple report tools (#56 reconciliation discrepancy + #56a uncleared + #53 GL + #58 sales by customer/item/rep detail variants).
- **Implement `TxnListByDate` GeneralDetailReportQueryRq as the read primitive.** A real schema-supported report type, but its row data doesn't include `ClearedStatus` (the IncludeColumn enum doesn't cover it for this report type per the schema). Wouldn't actually answer the operator's question.
- **Track cleared status as a separate sim-only field and document live as TBD.** A variant of the first alternative; same NF1 problem.

**Tradeoffs / consequences:**

- Operator can mark transactions cleared through the MCP today; cannot yet ENUMERATE uncleared transactions through the MCP (they use QB Desktop's reconcile screen for that part). This is a real but bounded workflow gap that closes when #56 lands.
- The seven bank-affecting transaction types now carry an explicit `ClearedStatus` field on creation (default `NotCleared`). Existing tests still pass (the default is invisible to anything that doesn't look for it).
- Two new statusCode distinctions (3120 "wrong txn type" vs 500 "unknown txn") give downstream agents enough information to retry or pivot. Pinned in tests.
- The dispatch-order subtlety in `processRequest` is now structurally important. If a future PR adds another non-entity-typed `*ModRq` (e.g. a hypothetical `DisplayModRq`), it must also slot in BEFORE the `endsWith("ModRq")` catch-all. Documented inline.
- A new HANDOFF gotcha: future scope assumptions sourced from "I think QBXML supports X" should be verified against qbwc/qbxml master before committing to scope. The original #45/#46 framing was wrong by ~5 different elements; that's a lot of wasted sketch work for a future agent that trusts it.

**Revisit when:** Phase 11 #56 + #56a land — at which point `qb_cleared_status_update` should compose naturally with the read tools and the operator can run month-end close end-to-end through the MCP. No earlier revisit.

---

## 2026-05-10 — Idempotency cache lives at QBSessionManager, fingerprint-matches on replay, only caches successful creates

**Chosen:** Phase 10 #47 ships as a single chokepoint inside `QBSessionManager` mirroring the #42 read-only gate template — new `addEntityIdempotent(entityType, data, key)` and `executeBatchAddIdempotent(entityType, entries, key)` methods that delegate to the existing `addEntity` / `executeBatchAdd` and return `{entity|results, replayed}`. Cache state (`Map<key, {entityType, payloadFingerprint, result, createdAt}>`) is per-`QBSessionManager` instance, FIFO-bounded at 1000 entries, and explicitly cleared on `switchCompanyFile`. Fingerprint is SHA-256 of canonicalized JSON (recursive sorted-key normalization so `{a, b}` and `{b, a}` collide; arrays preserve order so `[line1, line2]` and `[line2, line1]` don't). Same key + matching fingerprint → return cached with `replayed: true`. Same key + different fingerprint → throw `QBIdempotencyKeyConflictError` (synthetic statusCode 9002). Tool surface: every `*_create` / `*_add` tool gains optional `idempotencyKey: z.string().min(1).optional()`; on replay the response carries `idempotentReplay: true`.

**Why:** Five reasons.

1. **Single chokepoint matches #42 architecture.** The read-only gate sets the precedent that policy concerns affecting every mutation belong in `QBSessionManager`, not duplicated across 47 tool call sites. Idempotency is the same shape of concern. Putting the cache in the manager means the next mutation tool added (#75 banking primitives, #76 sales orders, etc.) inherits idempotency for free if it routes through `addEntityIdempotent`.

2. **Stripe-style payload-fingerprint matching is the safe default.** A bare key-only cache would silently overwrite cached results when an agent recycled keys with a different payload — that's a correctness hazard. Forcing fingerprint match (and rejecting mismatches with 9002) catches caller bugs and matches what experienced operators expect from idempotency systems.

3. **Per-companyFile scoping prevents cross-tenant leaks.** A TxnID issued under company A is meaningless under company B even with the same key. Clearing on `switchCompanyFile` is the right invariant. Documented loudly because the failure mode (returning a stale TxnID from a different company) would be silent and dangerous.

4. **Failed creates don't poison the cache.** The operator's mental model: idempotency protects against *successful* duplicates, not against retrying *failed* writes. If the first call throws (validation, network, QB rejection), the next retry should be allowed to fix the underlying problem. Caching the failure would leave the operator stuck.

5. **Batch idempotency only caches full success — by design.** A partial-failure batch runs compensating-delete at the tool layer AFTER `executeBatchAdd` returns. Caching the pre-rollback wire outcome and replaying it would re-attempt deletes against TxnIDs the original call already removed — observable thrash and a divergent response shape from the first call. The simpler and correct semantic: cache only when every entry posted, otherwise let the retry build a fresh envelope (rollback already cleaned up the originally-posted entries; if rollback orphaned anything, that was already surfaced to the operator with TxnIDs to clean up manually).

**Alternatives rejected:**

- **Cache at the tool layer (per-tool registry).** Would have meant 16 copies of the cache + lookup logic across 14 tool files. The read-only gate experiment proved that policy concerns belong in the manager — the same argument applies here.
- **Surface `replayed` as an out-parameter or session-scoped accessor (`getLastIdempotencyResult()`).** Action-at-a-distance; the tool would have to read it after every call and risk forgetting. Returning `{entity, replayed}` from a new method makes the contract explicit at the call site without breaking the existing `addEntity` signature (no churn in the 16 callers that don't pass a key).
- **Bare key-only cache (no fingerprint).** Tempting because the schema is simpler, but accepting any payload under a previously-seen key is too dangerous — silently returning a stale result for a different operation is the worst possible failure mode.
- **TTL-based cache eviction.** Would require a `setTimeout` infrastructure and clock dependence in tests. FIFO at 1000 entries handles the realistic workload (agent runs post < 100 mutations, so the cache is far under cap on every realistic session) without temporal complexity. If memory pressure ever becomes real, swap to a different policy without changing the public interface.
- **Cache full tool response for batches (so partial-failure replays return identical structure).** Would require moving the cache logic out of the manager and into the batch tool handler. Possible, but the partial-failure replay use case is narrow (operator specifically retrying a failed batch with the same key) and the current "fresh retry" semantic is defensible: rollback either cleared everything (retry safe) or surfaced orphans (operator should reconcile before retry).

**Tradeoffs / consequences:**

- **The cache is ephemeral.** Restarting the MCP server clears it. An agent that retries across a server crash gets a duplicate. That's acceptable for personal use; a shared multi-process deployment would need persistent storage (Redis, SQLite). Not required for this codebase.
- **Memory bound is hard-coded at 1000 entries.** If a future workflow generates more than 1000 keyed creates per company-file session (unlikely in a CPA practice — even January 1099 prep posts at most a few hundred bills), older keys age out silently. Document in the manager docstring; revisit if real workloads ever push past it.
- **Conflict semantics may surprise agents that recycle keys.** A naive agent that sets `idempotencyKey: "monthly-rent"` for every monthly post would trip the conflict gate the second month. The fix is on the agent side (use a date-suffixed key like `monthly-rent-2026-05`), not server-side. Tool descriptions document the per-create scope explicitly.
- **`qb_estimate_convert_to_invoice` skips the IsAccepted flip on idempotent replay.** The convert tool is a two-step composite (Invoice add + Estimate IsAccepted modify); only the InvoiceAdd half is keyed. On replay, re-running the EstimateMod with the original `editSequence` would either be a no-op (if already accepted) or fail with `statusCode 3170` (stale editSequence after the original mark). Skipping is safe and matches the operator's mental model: "the conversion already happened, give me back the invoice."

**Revisit when:**
- If a multi-process deployment is ever needed, swap the in-memory `Map` for a persistent backend (interface stays the same).
- If batch partial-failure replay becomes a hot operator request, reconsider option (C) above (cache full tool response).

---

## 2026-05-10 — qb_1099_summary / qb_1099_detail aggregate from typed Bill + Check queries, not Form1099QueryRq

**Chosen:** Phase 10 #44 ships as `qb_1099_summary` + `qb_1099_detail`, both implemented as a tool-side aggregation over the existing typed `Bill` + `Check` stores via `session.queryEntity`. No new wire request type is added. Vendor classification is driven by two fields on the `Vendor` record: `IsVendorEligibleFor1099 === true` selects which vendors participate, and `Vendor1099Type === 'MISC'` opts a vendor into 1099-MISC (default is 1099-NEC, the modern default for nonemployee compensation post the IRS 2020 split). Threshold defaults to $600 (the IRS general TY2024+ threshold for both 1099-NEC and 1099-MISC); `qb_1099_summary` accepts a `threshold` arg for the rare special-box cases ($10 royalties).

**Why:** Three reasons.

1. **Keeps the "tools never construct QBXML directly" rule (CLAUDE.md).** Adding a builder for `Form1099QueryRq` would have introduced a new schema-order surface — the same class of bug that took down `qb_pnl_report` and `TransactionQueryRq` until pinned in `tests/builder-emit-order.test.ts`. Aggregating over `BillQueryRq` + `CheckQueryRq` (already exercised, schema-pinned, live-verified) reuses chokepoints we already trust.

2. **Identical sim/live behavior.** The same TypeScript code path produces results in both modes. No simulation handler to write for a new request type, no shape divergence between sim's emit and QB's wire response, no live verification step blocked on a Windows + QB box (which the handoff confirms isn't currently in this session).

3. **No dependency on QB Preferences' per-account 1099 box mapping.** Real QB's `Form1099QueryRq` honors a per-account → per-1099-box mapping that lives in Preferences. Surfacing it correctly would have required either reading Preferences (which has its own SDK quirks) or letting the wire response carry the mapping implicitly. The chosen aggregation skips this entirely: every payment to an eligible vendor counts toward the threshold. In practice this is a more permissive (safer) signal — operators get a superset of vendors who *might* need a 1099, never miss a vendor who should — and the operator can post-filter in their downstream prep workflow.

Card payments (`CreditCardCharge`) are deliberately excluded from the walk per IRS Form 1099 instructions (the card processor reports those on 1099-K). Bills paid via credit card go through `BillPaymentCreditCard` which doesn't show up in the `Bill` walk's amount accounting either way (the bill itself was originally posted via `Bill`, which IS counted; the credit-card *payment* is the IRS-excluded part — surfacing the bill amount as "spend with vendor X" is the right answer for 1099 reporting).

`qb_1099_summary` defaults to **last completed tax year** (current year − 1) — January is 1099 prep season and the operator's first instinct is "show me last year." Explicit `taxYear` arg overrides; explicit `fromDate` / `toDate` override taxYear. The vendor row sort is `totalPaid` desc so the highest-spend vendors (most likely to need a 1099) surface first.

**Alternatives rejected:**
- Wire `Form1099QueryRq` directly — adds a new schema-order surface, blocked on live verification, and forces sim to emit a shape that mirrors QB's wire response (additional simulation handler complexity for a request that's effectively "summarize Bills + Checks by vendor"). The aggregation we ended up with IS the body of what `Form1099QueryRq` does — exposing the aggregation directly skips the round trip.
- Read QB Preferences for the 1099 box mapping and apply it server-side — possible follow-up, but Preferences read has its own SDK surface (`PreferencesQueryRq` returns a wide tree where the 1099 mapping is one node among many) and would couple the tool to a tax-year-specific mapping that changes when the IRS reshuffles boxes. Out of scope for v1.
- Walk only `Bill` and ignore `Check` — would miss vendors paid by direct check (the operator's `1042` Q2 contractor payment in the test fixture). Both surfaces are needed.
- Walk `BillPaymentCheck` / `BillPaymentCreditCard` instead of `Bill` (cash-basis 1099) — closer to IRS truth but requires every Bill to have a matching BillPayment in the same year, which doesn't always hold (Q4 bills paid in January). For most small-practice operators where bills are paid same-period, the simpler "Bills + Checks" walk produces the same answer. A strict cash-basis flag could be added later if the operator runs into multi-year-AP cases.

**Tradeoffs / consequences:**
- Operators with custom 1099 box mappings in QB Preferences will see slightly different totals than QB's Form1099 wizard. The aggregation is more permissive (counts everything posted to an eligible vendor); the wizard filters to specific GL accounts. Documented in the tool description so operators know to use the wizard for box-by-box filing.
- A future `qb_1099_box_summary` tool that DOES honor Preferences could layer on top of this aggregation by joining account → box mapping post-aggregation. The current tool does not block that.
- Bill totals come from line sum, not header `AmountDue` — paid bills have `AmountDue: 0` but the original total still reads from the line array. Tool requires `IncludeLineItems: true` on the underlying `BillQueryRq` (passed automatically). Falls back to `AmountDue` when lines aren't surfaced (defensive — catches edge cases where the simulation or live response strips lines unexpectedly).
- Card payments are excluded from the walk, but that's the IRS contract, not a limitation. Documented in the tool description.

**Revisit when:** An operator workflow surfaces a need for QB-Preferences-driven box-by-box reporting (e.g., a state filing form that requires Box 1 NEC vs Box 7 services to be split), OR a practice with multi-year-AP runs into the cash-basis-1099 edge case. Either case is additive (a new tool layered on top); the current tool's contract doesn't have to change.

---

## 2026-05-10 — Read-only session flag gates at the session manager, not per-tool

**Chosen:** Phase 10 #42 ships as a single chokepoint inside `QBSessionManager`: a private `readOnly: boolean` flag, public `setReadOnly` / `isReadOnly` accessors, and a private `assertWritable(operation)` helper called at the entry of every typed mutation method (`addEntity`, `modifyEntity`, `deleteEntity`, `executeBatchAdd`). The gate throws `QBReadOnlyError` (synthetic statusCode 9001) BEFORE any QBXML envelope is built or wire I/O happens. The error surfaces through the existing tool-side error wrapper (the Item 25 catch) without touching any tool file — every `*_add` / `*_update` / `*_delete` / `*_apply` / `*_pay` / `*_make_inactive` / `*_convert_to_invoice` / `batch_create` tool returns `isError: true` with `statusCode: 9001` and a humanReadable message automatically.

**Why:** All 47 mutation call sites across the 14 tool files go through one of those four typed methods (verified by grep on `session.{addEntity,modifyEntity,deleteEntity,executeBatchAdd}`). Gating at the session manager catches every existing mutation tool AND every future one for free, with zero per-tool churn and zero risk of a new tool slipping past the gate. A new statusCode (9001, deliberately above the QB SDK's 0/1/3xxx/5xx range) was added rather than reusing 3260 ("insufficient permission"): the latter is a real wire response from QB, this is a CLIENT-SIDE gate that never reaches QB — distinguishing them lets agents tell "I'm in read-only mode" apart from "QB rejected my user role" without needing to parse a string.

`switchCompanyFile` is intentionally NOT gated — switching the active book is a session-level operation, not a data mutation. The flag also persists across `openSession` / `closeSession`, so a session that drops and auto-reconnects mid-conversation stays in read-only mode (only `setReadOnly(false)` clears it). `qb_session_connect` defaults the flag to `false` on every call: a fresh `qb_session_connect()` with no `readOnly` arg ALWAYS re-enables writes, even if the session was previously read-only — matches the "I want to start over" mental model.

**Alternatives rejected:**
- Gate at each tool handler — would touch 14 files, ~47 call sites, and any future tool would silently drift past the gate unless the contributor remembered to add the check. The chokepoint design is structurally safer.
- Gate at `sendRequest` by scanning the XML for mutation request types — brittle (regex on XML) and produces a less informative error (the operation name "addEntity(Customer)" beats "QBXML envelope contained CustomerAddRq").
- Reuse `statusCode 3260` ("insufficient permission") — semantically close but conflates a real QB role denial with a client-side gate. Agents that retry on 3260 (because the operator might have flipped a permission in QB Desktop) would loop forever on 9001.
- Add an `atomic: false` opt-out arg to mutation tools to allow "I'm read-only EXCEPT for this one call" — rejected as a footgun. Read-only mode should be unambiguous.

**Tradeoffs / consequences:**
- Every typed mutation now pays a one-property-read overhead before the wire call (`if (this.readOnly)`). Negligible vs. the QBXML build + wire roundtrip — measurable in ns vs ms.
- A future code path that bypasses the four typed helpers (e.g., constructing QBXML and calling `sendRequest` directly) would slip past the gate. CLAUDE.md's "tools never construct QBXML directly" rule already forbids this; if it's ever broken, this gate is one more reason to fix the bypass rather than add per-tool gates.
- The flag is per-`QBSessionManager` instance — when the operator runs multiple processes (e.g., a write-mode CLI alongside a read-only diagnostic agent), each process's flag is independent. No cross-process coordination is needed because the QBXMLRP2 gate is also per-process.

**Revisit when:** A use case emerges for "write-mode by default, read-only for one specific tool" (e.g., a diagnostic that should never write even when the session is otherwise writable). At that point a per-tool override could layer on top of the session-level flag without breaking the current contract.

---

## 2026-05-10 — qb_journal_entry_batch_create defaults to atomic with auto-rollback (compensating delete)

**Chosen:** Phase 10 #43 ships as a single tool that defaults to all-or-nothing semantics. Per-entry balance is validated upfront (sum(debits) === sum(credits) within $0.005) so an obviously-bad batch never reaches the wire. Wire I/O uses a multi-`JournalEntryAddRq` envelope under `<QBXMLMsgsRq onError="stopOnError">`. When stopOnError halts the envelope mid-batch, the tool then walks the responses, identifies any prior-posted JEs (by `requestID` → `TxnID`), and issues a `TxnDelRq` per posted entry IN REVERSE POST ORDER. If every rollback delete succeeds, the batch is reported as fully atomic (`rolledBack: true`). If any rollback delete fails, the tool surfaces the affected JE as `orphaned` with the surviving `TxnID` so the operator can clean up manually via `qb_journal_entry_delete`.

**Why:** Real QB does NOT atomically roll back already-posted JEs when a later JE in the same envelope fails under stopOnError — the wire-level contract is "halt further processing," not "undo earlier work." The operator's CC-batch workflow is the canonical use case (50–150 JEs/month against the AmEx feed): partial postings would be a reconciliation nightmare, since a partial month's CC charges would land in QB and the operator's downstream scripts would not know which entries to retry vs which to skip. Compensating delete brings the failure mode back to "all or none" for the overwhelmingly common case (rollback delete succeeds), and degrades gracefully to "all or N orphans, with TxnIDs surfaced loudly" when it doesn't. An "atomic by default, opt-out via flag" toggle was considered but rejected for v1: there is no current operator workflow that wants partial-batch semantics, so adding the flag would just enlarge surface area without unblocking work.

100-entry per-batch cap is a guardrail against oversized envelopes (QBXMLRP2 has been observed to time out on >~200-block envelopes; well under that cap is conservative). Bigger batches should be split at the caller layer rather than the tool retrying — the tool's job is to give clean atomicity to a bounded batch, not to manage chunked retry.

**Alternatives rejected:**
- **Document the gap; ship without rollback.** Aligns with QB's wire-level semantics literally. Rejected because the tool's name says "batch_create" — a caller reading "atomic batch JE" reasonably expects the tool to deliver atomicity, not surface a leaky abstraction. The CC-batch workflow specifically would be unusable.
- **Sequential per-JE creates with mid-failure stop.** Same observable behavior as a multi-request envelope — but loses the wire-level efficiency of one round trip and forces the tool to carry session-management complexity for the partial-mutation window. Multi-request envelope is simpler and idiomatic to QBXML.
- **`atomic: false` opt-out flag for partial-batch posting.** No present workflow needs it; defer until #58 (batch invoice/SR) or a real operator request justifies the flag.
- **Lift batch into a generic `qb_batch({ requests: [...] })` cross-type tool.** Cross-type batching is genuinely useful (e.g., create a customer + invoice + payment in one go) but the validation and rollback semantics differ wildly per type — invoices touch AR balance, payments apply to invoices, deletes have entity-specific cascade rules, etc. A per-type batch tool keeps each tool's atomicity contract precise; a generic batch would either weaken every contract or carry a giant per-type adapter. Defer.

**Tradeoffs / consequences:**
- **Rollback is best-effort, not transactional.** A delete that fails after a successful post leaves the JE on the books. The tool surfaces the orphan loudly (`status: "orphaned"`, `txnId`, `rollbackError` in the per-entry payload AND a top-level `summary.orphaned` array), but the operator IS responsible for deciding whether to delete via `qb_journal_entry_delete` or leave it. The `rolledBack: false` top-level flag distinguishes this case from full success.
- **Reverse-order rollback is the safer default but not provably correct.** Deleting JE #N before JE #N-1 minimizes the chance that QB's internal cascade machinery (e.g., audit-log linking, period-close interactions on rare seeds) invalidates an earlier delete. Empirically untestable without a live QB instance, but has no observed downside.
- **Generalizes the multi-request plumbing for all future batch tools.** [src/session/simulation-store.ts](src/session/simulation-store.ts) `processRequest` now walks array-valued request keys and honors `onError="stopOnError"`; [src/qbxml/parser.ts](src/qbxml/parser.ts) captures `@_requestID` per response; [src/session/manager.ts](src/session/manager.ts) `executeBatchAdd` is reusable. #58 (batch invoice/SR) reuses all of this.
- **Schema bound is hardcoded at 100, not configurable.** A future operator workflow may need 200+. Bumping the cap is a one-line zod change; revisit if needed.
- **Test coverage covers the simulation-side rollback path only.** Live-mode mid-batch failure can't be reproduced without an unbalanced JE actually reaching live QB; the orphan path is exercised via `vi.spyOn(session, "deleteEntity")` mock injection. Reasonable trade given that the rollback delete itself is just `session.deleteEntity` (well-covered elsewhere).

**Revisit when:** #58 lands (batch invoice/SR) — the same pattern should be reused; if the new path needs different atomicity semantics (e.g., invoices have AR-balance side effects per post that complicate rollback), break out the shared core. Or when an operator request lands for `atomic: false` partial-batch behavior.

---

## 2026-05-09 — qb_balance_summary sources AS/LI/EQ from BalanceSheetStandard and INC/EXP from ProfitAndLossStandard

**Chosen:** Phase 9 #38 reroutes [src/tools/reports.ts](src/tools/reports.ts) `qb_balance_summary` from a direct `Account.Balance` snapshot read to two `runReport` calls: `BalanceSheetStandard` (toDate=asOfDate) for asset/liability/equity figures, and `ProfitAndLossStandard` (lifetime through asOfDate) for income/expense figures. The resulting per-account totals are bucketed back into the 16-way canonical `AccountType` order via a name→type lookup populated from a single `AccountQuery`. NonPosting accounts (estimates, POs, sales orders) — absent from both reports — fall back to `Account.Balance`. The old `fromDate` / `toDate` params are replaced with `asOfDate` + `basis`; the misleading `asOfNote` is dropped.

**Why:** The pre-#38 implementation accepted `fromDate` / `toDate` and silently ignored them, returning a current-snapshot `Account.Balance` rollup with an `asOfNote` admitting the gap ("Balance reflects current snapshot, not the requested date range. Historical reconstruction requires walking transactions per account — pending Phase 5 P&L / Balance Sheet work."). That admission shipped 2026-04-26 because per-account historical reconstruction was unbuilt. The 2026-05-09 row-tree adapter (DECISIONS.md entry above) made the BS + P&L reports reliable in live mode end-to-end, so the unblocker for `asOfDate` had landed — the tool just needed to be rerouted through the same path. Operator-reported P0 (live data was wrong without warning).

The 16-way canonical bucketing (Bank, AccountsReceivable, OtherCurrentAsset, … Equity, Income, COGS, Expense, NonPosting) is preserved by joining the BS/P&L per-account totals to the chart-of-accounts type via a single `AccountQuery` snapshot. BS only emits 3 sections (Assets/Liabilities/Equity) so the join is required to surface the sub-types the tool's contract promises.

**Alternatives rejected:**
- **Walk transactions per account in simulation mode, defer fully-correct historical balances to live.** Doubles the surface — sim-only path is its own walker; live path uses BS report anyway. Cleaner conceptually but two reconciliation regimes is one more than necessary now that the live-mode BS adapter exists.
- **Drop the income/expense buckets entirely.** Pure BS-only output would simplify the implementation by half. Rejected because the existing tool surface includes `subtotals.income` / `subtotals.expenses` / `subtotals.netIncome` and consumers expect them. P&L is an extra `runReport` call but cheap (QBXMLRP2 serializes COM calls anyway, so the wire pipeline is unchanged).
- **Keep `fromDate` / `toDate` for back-compat.** The old params returned wrong data, so callers that passed them were already getting an incorrect response; renaming to `asOfDate` makes the new contract explicit and prevents the schema-permissive "I passed a date and the tool answered, so it must be honored" failure mode.

**Tradeoffs / consequences:**
- **Sim asOfDate is partially advisory.** Sim `BalanceSheetStandard` reads `Account.Balance` for AS/LI/EQ — same caveat `qb_balance_sheet_report` already documents. The P&L walk IS date-bounded in both modes. The tool description and the sim integration tests in [tests/balance-summary.test.ts](tests/balance-summary.test.ts) both note this.
- **Income/Expense buckets disappear when the P&L walk yields no leaves.** Pre-#38 the buckets were always populated from `Account.Balance` (often arbitrary seed numbers). Post-#38 they reflect actual transaction activity, so an empty seed produces no Income/Expense buckets and `subtotals.netIncome === 0`. This is the intended truthful signal — but an existing pickup-script regression (`scripts/verify-pickup-2026-04-27.mjs` was checking `netIncome === -22800`) was updated to assert the new contract (Bank-first @ 165000, `asOfDate` present).
- **Two reports per call** (vs one `AccountQuery` previously). On a real QB box this is two extra QBXMLRP2 round trips. Acceptable — `qb_balance_sheet_report` and `qb_pnl_report` already do this in two separate calls if the operator wants both, so no new latency floor.
- **`Net Income` / `Balancing Adjustment (simulation seed gap)` rows from BS Equity** are filtered out of `balanceSummary` (they'd otherwise land under the "Unknown" → "Other" bucket). They're already accounted for in `subtotals.netIncome` and `subtotals.equity`; surfacing them as account rows would double-count.
- **Bucket logic is extracted as exported `buildBalanceSummary`** in [src/tools/reports.ts](src/tools/reports.ts) and unit-tested directly in [tests/balance-summary.test.ts](tests/balance-summary.test.ts). Same pattern as `adaptLiveReportRet` — pure function, fixture-driven tests, no MCP transport spin-up.

**Revisit when:** Item 68 (`qb_trial_balance_export`) lands. Trial Balance is the more complete report (debit/credit per account as of a date, including Income/Expense as period totals). Once it ships, `qb_balance_summary` may be a thin wrapper over it, or merge entirely.

---

## 2026-05-09 — Live report shape adapted at the parser layer, not at each tool

**Chosen:** Live QB returns reports as a row tree (`TextRow` / `DataRow` / `SubtotalRow` / `TotalRow` under `<ReportData>`); simulation emits a flat `{ Sections, Totals }` shape directly. Both are now normalized to the same flat shape inside [src/qbxml/parser.ts](src/qbxml/parser.ts) `extractReportData` via a new `adaptLiveReportRet` helper. Tool handlers (`qb_pnl_report`, `qb_balance_sheet_report`) read identical shapes regardless of mode.

**Why:** Two halves of a 2026-05-09 P&L bug:
1. Schema-order: `buildReportRequest` emitted `ReportBasis` at child position 3, but QB's `<xs:sequence>` requires it at position 15 (after `SummarizeColumnsBy` + `IncludeSubcolumns`). Same regression class as the May-9 Customer/Invoice bugs. Fixed in builder + pinned in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts).
2. Adapter: even after the parse error cleared, live returned the row tree instead of `{Sections, Totals}` so every report came back empty. The parser's docstring had flagged this as deferred ("lands with the COM wiring") but it never landed.

The adapter lives at the parser layer (one place, both reports benefit) rather than per-tool (would have meant duplicating row-walking logic in two tools and any future report tool). Detection is intrinsic — `ReportData` present + `Sections` absent → live shape; otherwise pass through. No mode-aware branching required at the call sites.

The adapter trusts QB's labelled subtotals (`Total Income`, `TOTAL ASSETS`, `Net Income`, etc.) rather than recomputing from the leaves it surfaces. This preserves QB's accounting semantics — most importantly `GrossProfit = Income − COGS` (NOT including Other Income), which the simulation gets wrong (sim sums Income + Other Income for `TotalIncome` and uses that in GrossProfit). Treating QB's labels as authoritative means live output reflects what an operator sees in QB Desktop, even where that diverges from sim's computed values.

Live section names ("Expense", "Other Expense") are normalized to sim's plural ("Expenses", "Other Expenses") so the two modes produce identical Section.Name values. The architectural rule — "live and simulation should produce QBXML responses with the same shape" — extends to field-value contracts where reasonable.

**Alternatives rejected:**
- **Adapt at each tool.** Would have put two near-identical row-walking functions in [src/tools/reports.ts](src/tools/reports.ts). Future report tools (sales-by-customer, GL, etc., Phase 11) would each need their own. Parser-layer adapter is the single seam.
- **Make sim emit the row-tree shape too.** Cleaner symmetry, but a much larger sim refactor (every section becomes a TextRow + n DataRows + closing SubtotalRow; sim has no notion of row numbers). Out of proportion to the bug.
- **Recompute totals from leaf sums.** Tempting, but real QB's `Gross Profit` and `Net Ordinary Income` are derived using accounting conventions (which classes of "Other" income/expense to include) that aren't trivially re-derivable. Trusting QB's labelled values means we ship correct values today; the day a derivation diverges from QB's, the leaves are still there for the consumer to inspect.

**Tradeoffs / consequences:**
- The simulation's `GrossProfit` formula is now known-wrong relative to live (sim: `TotalIncome − TotalCOGS` where `TotalIncome` includes Other Income; live: `Income − COGS` only). Filed as a sim-fidelity gap (Phase 11+, not blocking).
- The adapter detects report kind (P&L vs BS) by inspecting which canonical TextRow labels appear, not by `ReportTitle` (which varies by QB locale). Adding new report kinds (Cash Flow, GL, etc.) means extending `PNL_SECTION_NAMES` / `BS_SECTION_NAMES` or introducing a new map.
- `TextRow` labels QB emits in non-English locales would not match the canonical-name maps. Acceptable for a single-operator US-edition tool; future internationalization would require a label-resolution layer.

**Revisit when:** Phase 11 lands the next report (`qb_general_ledger`, `qb_sales_by_customer_summary`, etc.) and the adapter pattern needs to scale beyond two report kinds.

---

## 2026-05-09 — Company switching reseeds the simulation store

**Chosen:** `QBSessionManager.switchCompanyFile(path)` (driving `qb_company_open`) ALWAYS instantiates a fresh `SimulationStore` when running in simulation mode, even when the new path matches a previously-opened path. Mutations made against company A while the sim was active are unrecoverable once the session switches to B and back to A.

**Why:** Real QuickBooks Desktop persists each company's books to its own `.qbw` file on disk — switching between files preserves whatever state was last saved. The simulation has no persistence layer; it's a single in-memory `Map<entityType, Map<id, entity>>` per `SimulationStore` instance. The only behaviorally honest option is to scope the store to "the conversation since last open" and accept that switching loses the prior content. The alternative — keeping a per-path Map of stores in memory — would diverge from real QB in a different way (real QB doesn't keep two files open; sim would). Both are tradeoffs; the reseed is the simpler one and the closer match to "open a different book, see that book's state."

The observational contract holds across modes: in live the operator sees the new file's actual saved state; in sim they see a fresh seed. Different specifics, same shape.

**Alternatives rejected:**
- *Per-path simulation stores cached in a Map.* Closer to "you can switch back and pick up where you left off," but creates two divergences from real QB: (a) two files appear simultaneously open in memory which QBXMLRP2 forbids, (b) the operator's mental model "I switched away — the prior session is over" is broken silently. Also leaks memory across long-lived sessions.
- *Persist the simulation store to disk per path.* Would mirror real QB more faithfully but introduces a data-format we'd have to migrate over time. Not worth it for a dev tool.
- *Refuse to switch in simulation.* Throws away the discovery workflow that Item 35 (`qb_company_list`) is designed for. The agent needs to be able to demonstrate switching even without a Windows box.

**Tradeoffs / consequences:**
- The `qb_company_open` response carries `simulationStoreReset: true` in sim mode so the LLM can observe the discontinuity and re-list entities rather than carrying stale references across the boundary.
- Tests in [tests/company-switching.test.ts](tests/company-switching.test.ts) pin the reseed contract: A → mutate → B → A returns A's fresh seed, NOT the prior mutations. Any future change toward per-path persistence would need to update that test deliberately.
- Live mode is unaffected — live always reads real QB state.

**Revisit when:** Adding any persistence layer to the simulation (e.g. snapshot-and-restore for fixture-driven tests). At that point the per-path cache could carry mutations across switches without diverging from real QB further than the persistence layer already does.

---

## 2026-05-09 — Insert filter children in QBXML schema-sequence order

**Chosen:** Every `*QueryRq` filter dict must be populated in the order Intuit's `qbxmlops*.xml` schema declares its children. The canonical order for the standard list-tool filter group is `ListID/FullName → MaxReturned → ActiveStatus → FromModifiedDate → ToModifiedDate → NameFilter → (type-specific tail e.g. AccountType / TotalBalanceFilter / ClassFilter)`. Each affected tool now opens with a comment pointing back at this rule.

**Why:** [src/qbxml/builder.ts](src/qbxml/builder.ts)'s `serializeBody` walks `Object.entries(body)`, which preserves JS string-key insertion order. QB's QBXML parser strictly enforces XSD `<xs:sequence>` ordering — out-of-order children produce the cryptic, untyped error `QuickBooks found an error when parsing the provided XML text stream` (no statusCode, no field hint). Live exercise on 2026-05-09 caught `qb_customer_list`, `qb_vendor_list`, `qb_item_list` failing with that error when called with `maxReturned: 5`; once we re-ordered insertion the exact same payload returned real records. The same wrong-order pattern was latent in `qb_employee_list`, `qb_account_list`, and the six `qb_*_list` tools in [src/tools/lists.ts](src/tools/lists.ts) — all now corrected defensively.

**Why simulation didn't catch it:** [src/session/simulation-store.ts](src/session/simulation-store.ts)'s `handleQuery` reads the filter dict directly (`filters.NameFilter`, `filters.MaxReturned`, etc.) and never re-serializes through the QBXML builder, so insertion order has no observable effect in sim. This is why all 178 simulation tests pass against the broken code. A regression test that exercises the *XML* (`buildQueryRequest("Customer", filters)` then asserts the order of children in the emitted string) would have caught this — worth adding as future test coverage.

**Alternatives rejected:**
- *Sort filters into schema order inside the builder.* Would centralize the rule, but each request type has a different schema sequence (CustomerQueryRq differs from InvoiceQueryRq differs from AccountQueryRq) and the builder is currently entity-agnostic. Encoding per-type ordering tables in the builder would push schema knowledge into the wrong layer and be brittle as we add new request types. Cheaper to keep the rule at the tool layer where the filter dict is constructed.
- *Switch to a Map-based filter object.* Same insertion-order semantics as objects in modern V8 (objects already preserve string-key order). No improvement.

**Tradeoffs / consequences:**
- Tool authors must remember to follow XSD order when adding filters. The opening comment in each `*_list` tool documents the canonical order.
- The transaction list tools were fixed in the same session under the same rule — `qb_invoice_list`, `qb_bill_list`, `qb_estimate_list`, `qb_sales_receipt_list`, `qb_credit_memo_list`, `qb_purchase_order_list`, `qb_journal_entry_list`, `qb_payment_list`, `qb_bill_payment_list`. Canonical sequence for transaction queries: `TxnID/RefNumber selectors → MaxReturned → ModifiedDateRangeFilter → TxnDateRangeFilter → EntityFilter → AccountFilter → RefNumberFilter → CurrencyFilter → PaidStatus`. Verified against live QB via [scripts/exercise-mcp-live.mjs](scripts/exercise-mcp-live.mjs) with multi-filter probes — 20/20 green, including `DateRange + PaidStatus + MaxReturned` combos.

**Revisit when:** Adding a new `*_list` tool, or once we add a builder-level XSD-order assertion that surfaces the rule statically.

---

## 2026-05-05 — Pin Node 20 LTS for live mode (winax prebuild gap on Node 22+)

**Chosen:** Live-mode environments must run Node **20 LTS**, not the current Node LTS that `winget install OpenJS.NodeJS.LTS` returns. [scripts/setup-qb-pc.ps1](scripts/setup-qb-pc.ps1) installs nvm-windows + Node 20 if any other major version is detected, and a [.nvmrc](.nvmrc) at the repo root pins the project to Node 20.

**Why:** `winax` ships prebuilt `.node` binaries for `{node-v115-win32-x64}` (Node 20 ABI). It does **not** ship prebuilds for Node 22+, so `npm install` falls through to `node-gyp rebuild`, which compiles the bridge's C++ against the host's V8 headers. winax 3.4.x–3.6.9 use V8 API symbols (`PropertyCallbackInfo<void>::HolderV2`) that exist in V8's main-line but are not yet present in Node 22.17.0's V8 12.x — every recent winax version fails compile with `'HolderV2' : is not a member of any direct or indirect base class of 'v8::PropertyCallbackInfo<void>'`. On Node 20 `npm install` skips the compile entirely and uses the prebuilt; on Node 22+ there's no path to a working build today.

The original setup script asked winget for "the LTS" without pinning a major version. When the office PC was provisioned, that resolved to Node 20; when the dev PC was provisioned later, it resolved to Node 22 — silent regression, identical script run, different outcome. Pinning Node 20 explicitly closes that gap.

**Alternatives rejected:**
- **Stay on Node 22; replace `winax` with a PowerShell child-process bridge.** Version-agnostic, no native deps. Rejected as the default because it adds 20–50ms latency per QBXML round-trip (long-running PS host with stdin/stdout, not per-request spawn) and a second failure-mode surface (PS host crash recovery, JSON-over-stdio framing). Worth revisiting if `winax` development stalls long-term — the bridge is the durable answer to "what if winax stops keeping up with V8."
- **Stay on Node 22; pin a specific older `winax` version that built historically.** Tried 3.4.2 (and 3.6.9, the current); both fail with the same V8 ABI error against Node 22.17.0. winax never had a Node-22-ABI-compatible release on npm.
- **Stay on Node 22; fork `winax` and patch the V8 calls.** Brittle — V8 is moving; we'd own the maintenance load. Not worth it for one COM call surface.
- **Allow both Node 20 and Node 22; let users pick.** Tested simulation works on either, but live mode silently breaks on 22. Operators don't read errors carefully enough — the failure mode (`Cannot find package 'winax'` from a lazy import after `npm install` silently skipped extraction via `ideallyInert`) is too easy to misread as a code bug. Better to enforce one supported version.

**Tradeoffs / consequences:**
- Setup script grows a Node-version-check + nvm-windows install path. Runtime: ~30s extra on a fresh box, idempotent on re-runs (it skips both if Node 20 is already active).
- Operators must `nvm use 20` in any new shell where they want to run this project. Mitigated by `nvm alias default 20` (which the script does after install) and by [.nvmrc](.nvmrc) for tooling that honors it.
- Downstream: anyone who pulls this repo on a fresh Windows PC and has Node 18 or 22+ already installed for other projects will get an nvm install on top. nvm-windows is non-destructive (it doesn't remove existing Node), so other projects keep working — the user just has to remember to switch.
- Node 20 LTS is supported until **April 2026**. Plenty of runway; we'll need to revisit before then unless winax catches up.

**Revisit when:**
- `winax` publishes prebuilt binaries for Node 22 win-x64 (`{node-v127-win32-x64}` or higher). At that point the Node 20 pin can drop.
- OR Node 20 reaches end-of-life (April 2026). At that point we either move to whatever Node version winax supports, or replace winax with the PS-bridge alternative.

---

## 2026-05-05 — `winax` for QBXMLRP2 COM bindings (over `node-activex`)

**Chosen:** Add `winax` (^3.x) as a runtime dependency. Live mode in [session/manager.ts](src/session/manager.ts) uses `new (await import("winax")).Object("QBXMLRP2.RequestProcessor")` to instantiate the COM object, then drives `OpenConnection2` / `BeginSession` / `ProcessRequest` / `EndSession` / `CloseConnection`. The import is lazy (only invoked in the live `openSession` branch) so simulation mode and non-Windows platforms never load it.

**Why:** `winax` is the actively-maintained Node ↔ Windows COM bridge in 2025-2026. It supports modern Node (22+), 64-bit ActiveX, native ESM, and ships TypeScript-compatible builds. The QuickBooks SDK exposes `QBXMLRP2.RequestProcessor` as an in-proc COM server; any Node-side bridge must call into it via `new ActiveXObject(...)` and dispatch member calls — which is exactly what `winax`'s `Object` helper does. Lazy `await import()` keeps the dependency a runtime concern only on Windows + live mode; the simulation path and macOS/Linux dev paths never resolve it. A small `src/types/winax.d.ts` shim declares the module so `tsc` can compile before `npm install` has compiled the native binding (the user's first `npm install` after pulling fresh and the setup script's bootstrap both need this).

**Alternatives rejected:**
- **`node-activex`.** Functionally equivalent API but stale: last meaningful release in early 2017, no Node 18+ binaries published, GitHub issues open for 4+ years on x64 / ESM / electron compatibility. Even if it worked today, every future Node upgrade would be a coin flip.
- **`edge-js` + an inline C# host.** Would let us call the QB SDK's higher-level QBFC library, which is friendlier than raw QBXML. But it pulls in a CLR runtime, complicates the install (Mono/.NET dep on the user's box), and the project has already committed to QBXML strings as the wire format. Invariant #2 in [ARCHITECTURE.md](ARCHITECTURE.md) ("simulation and live must be observationally identical") wants the same QBXML round-tripping the simulation already does — moving to QBFC objects breaks that.
- **Spawn a PowerShell/`cscript` child process per request.** Avoids the native dep entirely. Rejected: per-request process spawn cost (50-150ms each), no way to hold a persistent `BeginSession` ticket across calls without keeping the child alive (which just reinvents the COM-bridge problem in a slower, harder-to-debug shape), and each spawn risks tripping QB's per-app session limits.
- **Run a separate Windows-only `qb-bridge` service over a local socket.** Cleanest in theory (decouples the MCP server from native deps; the bridge could be C# / VB6 / anything Intuit's docs use). Rejected for this single-user personal tool — adds an installer, a service to manage, and a second failure-mode surface for what amounts to one COM call wrapped in error handling.

**Tradeoffs / consequences:**
- `npm install` on Windows now requires Python 3 + VS 2022 Build Tools (C++ workload) to compile `winax`'s native binding. [scripts/setup-qb-pc.ps1](scripts/setup-qb-pc.ps1) installs both before running `npm install`, so first-time setup is one-shot.
- macOS/Linux `npm install` is fine because `winax` is OS-skipped at install (it ships a no-op binary stub for non-win32). The simulation-mode dev story stays cross-platform — that's verified by the lazy `await import()` pattern: `import` only happens inside the live branch of `openSession`.
- `tsc` needs the type shim at [src/types/winax.d.ts](src/types/winax.d.ts) because `winax`'s own typings don't ship in a way TypeScript's `Node16` resolver picks up cleanly. The shim declares only the surface we use (`Object` constructor that returns a dispatch-style object).
- `winax`'s upstream is small but active. If it goes unmaintained, the migration target is most likely a `qb-bridge` sidecar — a roughly day-long swap that touches only `manager.ts`'s live branch.
- Dropping the `Sample Company.qbw` default in [src/index.ts:65](src/index.ts#L65) — empty `QB_COMPANY_FILE` now means "use whatever company file QuickBooks Desktop currently has open." The QB SDK accepts `""` for `BeginSession`'s file argument and treats it as "current open file." That's the better UX for a tool that's most often used while the operator is already in QB; the prior fallback was a phantom default that pointed at a path that may not exist.

**Revisit when:** `winax` releases stop or a Node major version (24+) breaks the binding. Or when a non-Windows live path becomes interesting (QuickBooks Online MCP would be a separate server, not a re-platform of this one).

---

## 2026-04-27 — Vitest for the test harness; keep env-matrix as a standalone `.mjs` script

**Chosen:** `vitest@^4` is the test framework. Tests live in `tests/*.test.ts`, import directly from `src/*.ts` (Vitest's Vite-based resolver handles the `.js`-extension imports the project uses for Node16 ESM), and run via `npm test` → `vitest run`. The five new Vitest files port four of the five existing `scripts/verify-*.mjs` harnesses (`item25-error-shape`, `item27-iterator`, `item29-input-validation`, plus two new `qbxml-roundtrip` and `simulation-store` files). The fifth harness — `verify-item23-env-matrix.mjs` — stays as a standalone `node` script invoked from CI / the regression checklist, NOT inside Vitest.

**Why:** Phase 8 Item 31 in `todo.md` requires a Vitest test directory covering builder→parser round-trips, simulation-store CRUD, filter handling, and tool integration. Vitest is the de-facto modern Node test runner for ESM TypeScript projects; it has zero-config TypeScript transform, native ESM, snapshot support, and `--coverage`. The `verify-item23-env-matrix.mjs` script tests environment-variable behavior across `process.platform` values, which it does by spawning child Node processes with mocked `platform` argv — porting that to Vitest would require either `vi.mock("node:os")` / `vi.stubGlobal("process")` patterns that don't reach the CommonJS-imported `os.platform()` call, or extracting the platform check into an injectable interface (which would be a refactor, not a port). Running it as a standalone subprocess driver is the same shape it already has.

**Alternatives rejected:**
- **Jest.** Heavier ESM story (still requires `node --experimental-vm-modules` or a Babel transform), slower cold start, and no native `.ts` execution without `ts-jest` or `@swc/jest`. Vitest does it natively.
- **`node --test` (the built-in runner).** Works for plain `.mjs` and is dependency-free, but doesn't transform TypeScript without a separate `--loader` (e.g. `tsx`). Mixing `tsx` + `node --test` reproduces what Vitest gives us out of the box, with worse error messages and no watch mode.
- **Mocha + Chai.** Mature but requires picking a TS executor (ts-node, tsx, swc) and an assertion library — adds two-to-three deps where Vitest is one. No tangible benefit for this project's scale.
- **Port `verify-item23-env-matrix.mjs` into Vitest with `vi.stubEnv` + `vi.spyOn(process, "platform")`.** Considered but rejected: the platform check happens during module evaluation in `session/manager.ts` (env-driven branch picked at construction time), so a clean port would require either re-importing the module per test (using `vi.resetModules()` plus dynamic `import()`) or refactoring the check into an injectable. The standalone subprocess script already does this correctly via real child processes — no behavioral fidelity is gained by porting.

**Tradeoffs / consequences:**
- One new dev dep (`vitest`) and its 73 transitive deps. `package.json` `devDependencies` only — never reaches production install.
- Tests now run in two places: `npm test` for the main suite, plus `node scripts/verify-item23-env-matrix.mjs` separately. Both must pass for a session to claim "all green." The handoff verification checklist already lists both.
- Existing `scripts/verify-*.mjs` files are kept after the port (they import from `dist/` and verify the built output, while Vitest imports from `src/` and verifies the source). When a future change breaks the build but leaves source consistent, the `.mjs` harnesses catch it; when source drifts but the dist hasn't been rebuilt, Vitest catches it. They're complementary, not redundant.
- Vitest config is intentionally minimal — no `vitest.config.ts` file. The default `test/` glob and Node ESM behavior are sufficient. Add a config file only if we need to set up `coverage`, `setupFiles`, or non-default test pools.

**Revisit when:** A workflow emerges that the standalone `.mjs` harnesses can't cover (e.g. coverage reporting, parallel test sharding, snapshot testing of XML output) — at that point, drop the `.mjs` files and centralize in Vitest. Or when the test suite grows past ~5 files and a `vitest.config.ts` becomes necessary for organization.

---

## 2026-04-26 — `EditSequence` carries a monotonic counter, not a pure ISO timestamp

**Chosen:** The simulation generates `EditSequence` via a new `nextEditSequence()` helper that returns `${new Date().toISOString()}-${counter++}`. The counter is the same `idCounter` field used by `nextId()`, so `EditSequence` is guaranteed to rotate to a unique value on every `handleAdd` and `handleMod`, even when calls land in the same millisecond.

**Why:** The previous implementation set `EditSequence: new Date().toISOString()` directly. On fast hardware (or in inline verification scripts), an entity created at T0 and modified at T0 + <1ms produced two ISO strings that compared equal. The strict-EditSequence check added on 2026-04-25 then accepted the "old" sequence as still-current and the stale-sequence rejection (statusCode 3170) silently broke. Caught by the HANDOFF.md verification script for Phase 3 Item 7 — checks 2b / 3a / 3b / 3c failed because both sides of the comparison were the same millisecond stamp.

**Alternatives rejected:**
- **Use `process.hrtime.bigint()` for sub-ms resolution.** Works but produces opaque numbers that don't help debugging. The ISO+counter form keeps human-readable timestamps in the data while guaranteeing uniqueness.
- **Sleep 1ms in tests / verification scripts.** Pushes the workaround into every caller, doesn't fix the underlying simulation bug, and would re-surface the moment two tools chain mods server-side.
- **Hash of (timestamp + entity contents).** Overkill — the only invariant we need is "every successful mod yields a sequence value that does not equal any prior one for that entity." A monotonic counter delivers that with one shared field.

**Tradeoffs / consequences:**
- `EditSequence` is no longer a pure ISO timestamp. Any future code that pattern-matches on the format (e.g. tries to parse it back to a `Date`) will break. None exists today; all tools round-trip it as an opaque string.
- Sequence is still sortable lexically because the ISO timestamp prefix dominates ordering and the counter is monotonically increasing within a single process. Cross-process ordering is meaningless either way (simulation has no persistence).
- Live mode (Phase 7) will inherit whatever real QB returns — no impact, since the simulation's format is internal.

**Revisit when:** No scheduled revisit. If the seed-data fields (lines 1059-1118 of simulation-store.ts) ever participate in mod paths and need rotating sequences, route them through `nextEditSequence()` too — currently they use a fixed `now` snapshot which is fine because seed records are query-only.

---

## 2026-04-25 — Strict EditSequence validation in simulation `handleMod`

**Chosen:** When any `*ModRq` request includes `EditSequence` and the value does not match the entity's currently-stored `EditSequence`, the simulation rejects with statusCode 3170 ("the given object's EditSequence does not match"). The check is global to `handleMod` and applies to every `*_update` tool, not just `qb_bill_update`.

**Why:** Real QB enforces optimistic-concurrency control via `EditSequence`. Stale-sequence requests fail with 3170. The simulation previously accepted any value (or no value), spread `modData` over the existing entity, and bumped `EditSequence` to a fresh timestamp. That meant "passes in dev, rejects in live" was a guaranteed class of bug for any tool that fetched an entity, sat on it, and then submitted a mod against a now-stale sequence.

The fix is three lines in `handleMod` and applies globally because every existing update tool already requires `editSequence` in its zod schema and passes it on the request. There are no callers that rely on the old lax behavior.

**Alternatives rejected:**
- **Per-tool opt-in (e.g. only Bill checks it).** Inconsistent — every tool would eventually need it as Phase 7 lands. Centralizing in `handleMod` is cheaper and avoids drift.
- **Document the gap, defer to Phase 7.** Defensible, but the risk is that a Phase 3+ tool quietly relies on stale-sequence permissiveness without anyone noticing until live mode breaks it. Catching it now in dev is cheaper than catching it later in live.
- **Validate but warn instead of reject.** Adds a "warnings" channel that doesn't exist anywhere else in the codebase, and doesn't match real QB.

**Tradeoffs / consequences:**
- Any existing test or workflow that re-uses an old `EditSequence` across multiple mods will now fail. Update flows must read the freshest `EditSequence` from the previous response (or a fresh query). Every tool today already returns the entity post-mod with the new `EditSequence`, so the migration is mechanical.
- Mod responses from the simulation now match live more closely — a 3170 path is exercisable in dev.
- Phase 7 (live mode) inherits the same invariant on the live path automatically — the simulation isn't pretending anymore.

**Revisit when:** Live mode lands and the real-QB error code or message text differs noticeably from the simulation's stub. At that point the simulation's status message should be updated to match what live actually returns.

---

## 2026-04-25 — Bill line-mod uses wholesale replacement with merge-by-TxnLineID

**Chosen:** `qb_bill_update` accepts `expenseLines` / `itemLines` arrays. When provided, each array REPLACES the bill's existing `ExpenseLineRet` / `ItemLineRet` wholesale — lines not present in the mod array are dropped. Each entry can optionally carry `txnLineID`: if it matches an existing line, the mod's fields are merged over that line and the original `TxnLineID` is preserved; otherwise (or with `'-1'`) the entry is treated as a brand-new line and gets a freshly-generated `TxnLineID`. After lines change, `AmountDue` recomputes via `computeTotals` and the vendor's `Balance` is adjusted by the signed delta.

**Why:** Real QB's `*LineMod` blocks support per-line modify-or-add semantics: each block carries a `TxnLineID` (or `'-1'` for new), and lines NOT in the request are deleted. Mirroring this exactly with a true diff (modify only the named fields, preserve everything else, support standalone "delete this line" blocks) would significantly complicate the simulation's `handleMod` and require a new `*LineDel` shape. The wholesale-replace-with-merge approach captures the practical operator workflow ("here's what the bill should look like after my edit") with simpler code: `{...existingLine, ...modLine}` per matched line, generate a fresh ID for the rest.

The merge-by-TxnLineID part (rather than pure wholesale replace with no merge) is what gives the operator a usable "change just one field" UX. Without it, a memo edit on one line of a 10-line bill would force the operator to reconstruct all 10 lines. With it, they pass `[{txnLineID: 'L1', memo: 'new'}]` and every other line on the bill is dropped — but the modified line preserves its account, amount, and other fields from the existing record.

**Alternatives rejected:**
- **Pure wholesale replace, no merge.** Forces the operator to re-supply every field on every modified line. Ugly UX for the most common workflow (small partial mods). The simpler simulation isn't worth the operator-side cost.
- **True per-line diff with `*LineDel` blocks.** Faithful to real QB but adds a third request shape (`*LineDel`) and more dispatch logic. Overkill for a personal tool. Document the gap and revisit if a workflow surfaces that genuinely needs to keep N-1 lines while explicitly deleting only one.
- **Tool-side pre-compute of `Amount` for item lines (matching `qb_bill_create`).** Considered but rejected for the Mod path because a partial mod ("change just qty on existing line L1") doesn't have `cost` available without a query round-trip; letting the simulation re-derive `Amount = Quantity * Cost` from the merged line is cleaner. The Add path keeps its tool-side computation since the create schema already requires both fields.

**Tradeoffs / consequences:**
- "Drop all lines but keep one" requires the operator to send `expenseLines: [{txnLineID: 'L_keep'}]`. They cannot say "delete line L_drop" in isolation. Acceptable because (a) bills typically have few lines and (b) the operator usually has the full line list in context anyway from a prior `qb_bill_list`.
- Operator-supplied `TxnLineID` values that don't match any existing line are treated as new lines (the simulation falls back to a fresh ID). Real QB would likely reject. Recording as a known fidelity gap.
- A line whose `TxnLineID` is `'-1'` is always treated as new. Operators must NOT pass `'-1'` for an existing line — that would lose the original `TxnLineID` and create a duplicate.
- The same `applyLineMods` helper is generic across `*LineMod` keys, so Phase 3 item 6 (`qb_invoice_update` line mod) inherits the same semantics for free. The only Item-6-specific work is recomputing `Subtotal` / `BalanceRemaining` and adjusting the customer's `Balance` by the signed delta — both already have machinery from prior items.
- Vendor-change support: if a Bill mod re-points the bill at a different vendor (`vendorName` or `vendorListId` differs from the existing ref), the old vendor's balance is reversed by the OLD `AmountDue` and the new vendor's balance is bumped by the NEW `AmountDue`. Same vendor → signed delta only. Mirrors real QB behavior.

**Revisit when:** A workflow surfaces where the operator needs to delete a single line by ID without re-listing all the lines they want to keep. At that point, add `*LineDel` block support to the schema and a delete-then-merge pass to `applyLineMods`.

---

## 2026-04-25 — Strict TxnID validation in `qb_payment_receive` AppliedToTxnAdd

**Chosen:** When `qb_payment_receive` is called with `appliedTo: [{txnId, ...}]` and any `txnId` does not match an existing invoice in the simulation store, the entire payment is rejected with `isError: true` and statusCode 500. No invoice is mutated, no payment record is stored, and the error message names the bad `txnId`.

**Why:** The previous `adjustEntityBalance` helper from Item 18 silently no-ops on orphan refs — that's correct for invoice creation (a missing customer ref shouldn't block the invoice; it just means the AR side isn't tracked). But payment application is a different shape: the operator is *explicitly identifying* a target invoice. A silent no-op would record the payment as fully unapplied without any signal that the application failed, which is exactly the kind of silent-data-loss failure mode the project's "single user, must work flawlessly" standard wants to avoid. Real QB also rejects unknown `TxnID`s in `AppliedToTxnAdd` with an error.

**Alternatives rejected:**
- **Silent no-op (mirror `adjustEntityBalance` behavior).** Already covered above — rejected because the operator's intent is explicit and a silent failure leaves the books wrong without any hint why the invoice didn't close out. This is the option Item 18 *explicitly preserved* for invoice creation; the asymmetry here is intentional.
- **Apply what you can, drop orphan refs, return a warning in the payload.** Would require introducing a "warnings" channel separate from `isError`, and the payment would still post with a partial-applied state that doesn't match the operator's request. Rejected because it's both more complex and less predictable.
- **Two-pass with rollback only on error.** Same as the chosen option in terms of operator-visible behavior; the chosen option already does a validate-first / apply-second two-pass to guarantee atomicity within the simulation. No rollback path needed because mutation never starts until validation passes.

**Tradeoffs / consequences:**
- Operators get a clear error if they paste a stale or wrong `txnId` — easy to recover from.
- Phase 3 item 8 (`qb_payment_apply` via `ReceivePaymentMod`) will inherit the same strict semantics; its `handleMod` path will share the same helper. Document this when item 8 is picked up so the convention stays consistent.
- The two-pass validate-first design is slightly more verbose than a single loop with an inline early-return, but the atomicity guarantee (no half-applied payments on partial-failure) is worth the duplication. Keep this pattern for any future bulk-mutation tool (e.g. JournalEntry lines that touch multiple accounts).
- The tool-layer also rejects `sum(appliedTo.amount) > totalAmount` with `+1e-9` floating-point slack BEFORE the simulation runs, so two distinct error classes are surfaced to the operator with different statusCodes (the overapply rejection has no statusCode — it's a tool-layer validation; the orphan-TxnID rejection has statusCode 500 from the simulation).

**Revisit when:** A live-mode test reveals that real QB returns a different status code (likely 3170 "specified object not found in QuickBooks" or similar) — at which point the simulation should match the live code rather than picking a generic 500. Defer until live mode lands in Phase 7.

---

## 2026-04-25 — Drop `amountDue` arg from `qb_bill_create` (lines are the only source of total truth)

**Chosen:** Removed the optional top-level `amountDue` arg from `qb_bill_create`. After Phase 3 Item 4, `AmountDue` is computed exclusively as `sum(expenseLines.amount) + sum(itemLines.quantity * cost)` by the simulation's `computeTotals` helper. There is now no way to override it from the tool layer.

**Why:** Once `expenseLines` and `itemLines` became required (at least one), there are two candidates for "what is this bill's AmountDue":
1. The header `amountDue` arg the operator passed.
2. The sum of all line amounts.

Real QB derives AmountDue from the lines server-side and rejects mismatched header totals. Allowing both invites "which wins?" confusion and a class of subtle bugs where a sloppy override leaves AR/AP aging out of sync with the line ledger. The acceptance criterion explicitly says `AmountDue = sum(lines)` — keeping a header override would have meant either silently ignoring it, silently overriding it, or rejecting mismatches with custom logic. All three are worse than just removing the arg.

**Alternatives rejected:**
- **Keep `amountDue` as an override; document precedence.** Documented precedence still leaves the simulation diverging from real QB (which always derives from lines). Operators eventually trip on it.
- **Keep `amountDue`; reject if it doesn't match line sum.** Adds a third validation layer for no win — if the operator computed the sum themselves, why pass it? If they didn't, the lines tell us the right answer already.

**Tradeoffs / consequences:**
- **Breaking schema change.** Any prior caller passing `amountDue` will fail (zod will reject the unknown key — actually no, zod's default is `strip`, so unknown keys are silently dropped, not rejected; the bill will still be created, but the operator's intended override is silently ignored). Acceptable for a single-user personal tool with no external callers.
- **Edge case lost.** If a future workflow legitimately needs to record a bill with a header total that intentionally differs from line totals (e.g. importing legacy bills with rounding artifacts), this would have to be re-added — the use case doesn't exist today and is documented here so a future agent doesn't silently re-add the arg.
- **Simulation now matches real QB more closely.** Both derive AmountDue from lines.

**Revisit when:** A real QB workflow surfaces where header total must differ from line sum (e.g. rounding artifacts on imported legacy data) — at which point the override is reintroduced with explicit precedence docs and a `force` flag.

---

## 2026-04-25 — Light-touch single-schema for `qb_item_add` / `qb_item_update` across all five subtypes

**Chosen:** All five item subtypes (`Service`, `Inventory`, `NonInventory`, `OtherCharge`, `Group`) share one zod schema per tool. The `itemType` arg routes the request to the correct `Item<Subtype>AddRq` / `Item<Subtype>ModRq`. Subtype-inapplicable fields (e.g. `assetAccountName` on a `Service` item) are accepted by the schema and silently ignored when not relevant.

**Why:** The acceptance criterion (`ACCEPTANCE_CRITERIA.md` Item 2 bullet 5) phrases the requirement as "subtype-specific fields are accepted" — it doesn't require strict rejection of inapplicable fields. The five subtypes share most fields (`Name`, `Description`, `Price`, `IsActive`); a unified schema keeps the operator-facing surface compact and discoverable. Live mode would reject inapplicable fields anyway via QB's own validation, so the simulation's permissiveness is a dev-ergonomics choice, not a correctness gap.

**Alternatives rejected:**
- **Five separate `qb_item_<subtype>_add` tools** — explodes the tool count from 4 to 12, fragments the items domain, and forces the operator to know the subtype taxonomy before they can find the right tool. Real QB users think "add an item" first, "what kind" second.
- **Zod `discriminatedUnion` on `itemType`** — gives strict per-subtype field validation (e.g. reject `assetAccountName` on Service), but requires five branches in the schema and complicates the handler with five field-extraction blocks. Worth doing later if a class of bugs emerges from operators passing inapplicable fields; not worth the complexity today when the simulation just stores whatever arrives.

**Tradeoffs / consequences:**
- An operator can pass `assetAccountName` on a Service item and the simulation will store it without complaint. Real QB would reject. This is a known fidelity gap — not a correctness gap, since the item still ends up in the right per-subtype store with the right routing.
- If we later want strict validation, switching to `discriminatedUnion` is a localized change in `src/tools/items.ts` — no schema changes elsewhere.

**Revisit when:** A live-mode session reveals operators routinely passing inapplicable fields and getting cryptic QB errors. Or when the Phase 7 live-mode work begins and surfaces real validation requirements.

---

## 2026-04-25 — Establish project operating system before implementation

**Chosen:** Write `CLAUDE.md`, `HANDOFF.md`, `todo.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `REQUIREMENTS.md`, `REGRESSION_CHECKLIST.md`, `ACCEPTANCE_CRITERIA.md` before fixing any of the 33 identified issues.

**Why:** A 33-item fix list across 8 phases will span many sessions. Without externalized continuity, the second session re-discovers the audit, the third session starts inventing patterns that conflict with the first, and the simulation store accumulates contradictory partial fixes. Cost of writing the operating system upfront (~one session) is small relative to the cost of three sessions of drift.

**Alternatives rejected:**
- Start fixing immediately, document later — historically produces inconsistent fixes and forgotten context.
- Use only `todo.md` — captures sequence but not architecture, decisions, or acceptance.

**Tradeoffs / consequences:**
- One full session spent on docs before any code moves.
- Future sessions inherit a mandatory pickup ritual (read HANDOFF, todo, etc.).
- Drift becomes detectable instead of silent.

**Revisit when:** No scheduled revisit. Operating system itself is the meta-protocol.

---

## 2026-04-25 — Tackle simulation correctness before transaction completeness

**Chosen:** Phase 1 of `todo.md` (simulation filters, line-Ret conversion, computed totals, balance updates, item-store split) executes before Phase 2 (item subtype fixes) and Phase 3 (transaction line items, payment application, bill update).

**Why:** The simulation store currently silently ignores transaction filters and doesn't compute Subtotal/BalanceRemaining. Any tool work in Phase 2+ that touches invoices/bills/payments cannot be verified in dev because the responses are wrong. Fixing the lens before fixing what's seen through it.

**Alternatives rejected:**
- Tackle critical-blocker order (live mode → item subtypes → bills → payments) — would require all verification on a Windows + QB box from day one, which is impractical for iteration speed.
- Skip simulation fidelity and rely on live testing — defeats the purpose of having a simulation at all.

**Tradeoffs / consequences:**
- Phase 1 work appears infrastructural and may feel like "not making progress" — but it's what makes Phase 2-6 verifiable.
- Live mode (Phase 7) is intentionally last because it can only be verified on Windows + QB Desktop, and we want the simulation rock-solid before that constraint kicks in.

**Revisit when:** Phase 1 complete, before starting Phase 2.

---

## 2026-04-25 — Two-mode session (live + simulation) instead of mocks-in-tests

**Chosen:** Production code carries both a live path and a simulation path inside `QBSessionManager`. Mode is selected at construction by env vars. Both paths return identically-shaped `QBXMLResponse` objects.

**Why (inferred from existing code):** The MCP server runs on the operator's machine, not in a CI environment. The operator wants to develop, test, and demonstrate it on macOS/Linux without a QuickBooks license. The simulation path is also useful for letting the LLM exercise tools safely before pointing it at real books. Embedding simulation in production avoids needing a separate mock layer in tests and lets the same code run in dev and prod.

**Alternatives rejected:**
- Mock at the test boundary only — would force every dev to install QuickBooks Desktop on Windows just to run the server, killing the cross-platform development story.
- Separate `simulator/` binary — duplicates the QBXML envelope handling and risks drifting from the live path.

**Tradeoffs / consequences:**
- Production binary carries simulation code (small — `simulation-store.ts` is ~550 lines).
- Risk of behavioral drift between modes — mitigated by Invariant #2 in `ARCHITECTURE.md` ("simulation and live must be observationally identical").
- Mode-detection bug currently exists (`QB_SIMULATION=false` on Windows without `QB_LIVE=1` still simulates) — captured as Phase 6 item 23.

**Revisit when:** If we ever ship the server to non-developer operators who never need simulation, consider stripping it out. Not before.

---

## 2026-04-25 — In-memory `Map`-based simulation store, no persistence

**Chosen:** `SimulationStore` uses `Map<string, EntityStore>` with no disk persistence. Seed data is hardcoded in the constructor.

**Why (inferred from existing code):** Simulation is for development and demos. Resetting on process restart is a feature, not a bug — every session starts from the same known seed state, making behavior reproducible.

**Alternatives rejected:**
- SQLite — adds a dependency, complicates the cross-platform story (better-sqlite3 native build), and offers no real benefit for ephemeral simulation data.
- JSON file persistence — risks stale state across sessions and creates a new "what's in this file?" question for every developer.

**Tradeoffs / consequences:**
- Cannot survive a restart in dev. Workflow: start server → exercise tools → trust seed data is back next time.
- Tests will need to construct fresh `SimulationStore` instances for isolation (relevant when Phase 8 item 31 lands).
- If we ever want a "load from real export" feature, we'd add it as a separate mode, not by changing the store backing.

**Revisit when:** If a workflow emerges where mid-session simulation state needs to be inspected after a crash, reconsider.

---

## 2026-04-25 — One file per entity domain in `src/tools/`

**Chosen:** Tools are organized by entity domain — `customers.ts`, `vendors.ts`, `invoices.ts`, etc. — each exporting a single `register<Domain>Tools(server, getSession)` function.

**Why (inferred from existing code):** Matches QBXML's own taxonomy. Keeps related CRUD operations together so the next agent can find all customer-related code in one file. Avoids a single mega-file or a hyper-fragmented one-tool-per-file layout.

**Alternatives rejected:**
- Single `tools.ts` — unwieldy at 36+ tools, hard to navigate.
- One file per tool — too much ceremony, and forces shared zod schemas to live in awkward shared modules.
- Group by verb (all `*_list.ts`, all `*_add.ts`) — splits cohesive entity logic across files.

**Tradeoffs / consequences:**
- `payments.ts` currently also contains estimate tools (probably should be split when estimates grow per Phase 4 item 13).
- Reports/session/raw-query tools all live in `reports.ts` because they didn't fit a single entity — fine for now, may want a `meta.ts` later.

**Revisit when:** If a domain grows past ~500 lines or a domain spans multiple QBXML entity types (like `payments.ts` does today).

---

## 2026-04-25 — Defer extraction of transaction-vs-list classification constant

**Chosen:** Leave the `isTransaction` array duplicated across [builder.ts:115-131](src/qbxml/builder.ts#L115-L131), [manager.ts:200-203](src/session/manager.ts#L200-L203), and [simulation-store.ts:359-366](src/session/simulation-store.ts#L359-L366) for now. Document in `ARCHITECTURE.md` that all three must be updated together.

**Why:** Extracting the constant is a separate refactor that touches three files. The audit identified more critical fixes; doing the refactor now mixes concerns and risks an unrelated regression. Ship the documentation cost (Invariant #5) and revisit when one of those files is being touched anyway.

**Alternatives rejected:**
- Extract immediately to `src/qbxml/entity-types.ts` — pure win architecturally, but adds churn to a session focused on operating-system setup.

**Tradeoffs / consequences:**
- Risk that a future session adds a new transaction type to one location and not the others. Mitigated by the architecture invariant and by the regression checklist's "QBXML round-trip" section.

**Revisit when:** Phase 4 item 12 (sales receipts / credit memos / POs / journal entries) — those add multiple new transaction types and will touch all three files anyway. Do the extraction in that session.
