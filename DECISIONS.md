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

## 2026-05-21 — Phase 14 #64b composite-outlier dry-run V2 — bespoke for all 11 outliers; new `compositePreviewDryRun` primitive for 2-envelope composites; idempotent-replay preview deferred

**Chosen:** Ship bespoke dry-run for all 11 composite outliers carried out of #64a. No tool emits the reserved `9006` "dry-run not supported" statusCode — every outlier has a workable preview shape using either an existing single-op primitive (`addEntityDryRun` / `executeBatchAddDryRun`) or the new multi-op primitive `compositePreviewDryRun`. Status code 9006 stays reserved for any future tool whose composition is genuinely unpreviewable (e.g. tools that depend on external side effects).

**Why:** Pre-implementation inspection of the 11 outliers showed only 2 (`qb_estimate_convert_to_invoice`, `qb_sales_order_convert_to_invoice`) are TRUE multi-envelope composites. The other 9 are effectively single-envelope after a pre-flight read: the 4 duplicates (`qb_invoice_duplicate`, `qb_bill_duplicate`, `qb_journal_entry_duplicate`, `qb_sales_receipt_duplicate`) emit ONE `*AddRq` after the source-read pre-flight; `qb_invoice_write_off` emits ONE `ReceivePaymentAdd` (a 0-total payment with `DiscountAmount`); `qb_bill_pay` emits ONE `BillPaymentCheck`/`BillPaymentCreditCard`; the 3 batch tools (`qb_invoice_batch_create`, `qb_sales_receipt_batch_create`, `qb_journal_entry_batch_create`) emit ONE QBXML envelope containing N AddRq requests — exactly the shape `executeBatchAddDryRun` (V1) already handles. The handoff's framing ("bespoke for workflow-critical, 9006 for one-offs") undersold how cheap most of these were to thread.

For the 2 convert tools, a new manager primitive `compositePreviewDryRun(specs: CompositeOpSpec[])` snapshots the sim store ONCE, runs each spec's `*Core` method against the shared snapshot context, halts on first failure (subsequent specs → `"skipped"`), and restores on `finally`. The single-snapshot semantics matter: the EstimateMod / SalesOrderMod op reads the source entity from the just-snapshotted store, so the preview accurately reflects the cumulative state effect of both ops. Per-op return shape carries `qbxmlEnvelope` so the operator can inspect both envelopes; `entity` carries the *Ret block on success; `statusCode` + `statusMessage` carry on failure.

**Alternatives rejected:**
- **9006 across all 11 outliers** — Cheap to ship (skip every outlier with a structured rejection), but throws away most of the value. Operators want preview on the workflow-critical paths (batch posting, write-offs, bill payments) where the cost of getting it wrong is real. Going 9006 also locks the operator into either skipping dry-run entirely or building the underlying payload by hand and previewing it via the single-entity tools.
- **Handoff's split (bespoke for write-off + batch tools, 9006 for everything else)** — Inconsistent product surface. Duplicates and converts are the EASIEST to bespoke because the underlying primitive (`addEntityDryRun`, `compositePreviewDryRun`) handles all the snapshot/restore for free; the tool layer just threads the dryRun branch. 9006 on duplicates would have been a "we couldn't be bothered" footprint visible to operators.
- **Idempotency-aware composite preview** — For the convert tools, the real-call path applies idempotency to the InvoiceAdd half only (the EstimateMod runs unconditionally on cache miss, skips on cache replay). Modeling that in `compositePreviewDryRun` would require either exposing `fingerprintPayload` to the tool layer (a security-shaped surface) or adding an `idempotencyKey` field to the first `CompositeOpSpec` (complicates the primitive's API + return shape — would need `wouldReplay`-per-op semantics). Punted: dry-run on convert tools previews as a "fresh execution" regardless of idempotencyKey, documented in the dryRun schema description. Operator can verify replay behavior on the live path. If this becomes painful, the resolution is a new `peekIdempotencyDecision(key, entityType, data): "miss" | "match" | "conflict"` public method on the manager + tool-layer routing.
- **Rollback preview for batch tools** — When the sim oracle reports partial failure on a batch dry-run (e.g. entry 3 of 5 fails), the real-call path would auto-delete the first 2 posted entries via compensating `TxnDelRq`. We DON'T preview that delete path. Cost of previewing: another snapshot/restore cycle running `deleteEntityDryRun` against each would-be-posted entry, plus a response-shape extension to surface the delete outcomes. Benefit: minimal — the rollback rarely fails in practice (sim-store `TxnDelRq` against an entity created in the same envelope is always a clean delete), and the per-entry `posted` / `failed` / `skipped` array already tells the operator the failure picture. Documented as "rollback NOT previewed" in the dryRun schema description on all 3 batch tools.

**Tradeoffs / consequences:**
- **No 9006 emissions exist in production code** — but the status code remains reserved. Future tools that genuinely can't be previewed (external side effects, irreversible wire operations with no sim oracle) should emit it. The new `qb_status_codes` table entry is purely defensive.
- **Convert-tool dry-run is "fresh execution" only** — operator who relies on idempotency replay routing must verify via the real call. Documented limitation on both convert tools' dryRun schema strings.
- **Batch-tool dry-run doesn't preview rollback** — the per-entry status array shows the failure landscape; the operator must mentally model "all entries before the first `failed` would be auto-deleted on the real call." If this becomes confusing in practice, add `rollbackPreview: true` opt-in.
- **The `compositePreviewDryRun` primitive is now load-bearing** — any future tool that emits 2+ envelopes in sequence (and wants dry-run support) should use it rather than chaining single-op `*DryRun` calls (which would each take their own snapshot/restore — wasted work, plus the second op would see the unsnapshotted store).
- **Halt-on-first-fail semantics match the convert-tool real-call path** — if the EstimateMod were to fail in real life, the invoice has already been created (partial state). The dry-run mirrors this by reporting `wouldSucceed: false` with the invoice's `succeeded` result still populated. Same shape as real-call partial failure.
- **TS-only export of `CompositeOpSpec`** — surfaced from `manager.ts` for the convert tools to type-check their spec construction. No runtime impact.

**Revisit when:**
- An operator workflow surfaces "I want to know what would happen if my idempotency key replays on convert" — add the idempotency-aware composite preview.
- An operator gets burned by a batch-tool rollback failure that the dry-run didn't predict — add `rollbackPreview: true`.
- A new tool needs to emit 3+ envelopes in sequence (the primitive supports it; convert tools just happen to use 2).
- 9006 starts being emitted by a tool that gets added later — keep this entry as the authoritative pinning of "the slot is reserved, here's what it's for."

---

## 2026-05-20 — Streaming responses research (Phase 16 #73) — MCP SDK has no streaming primitive for tool result bodies; reframed as server-side iterator exhaustion

**Chosen:** Reject "true" streaming at the `server.tool` callback layer. Implement #73 as `autoExhaust: boolean` on the 7 paginated list tools — server-side loops `queryEntityPaginated` until `iteratorRemainingCount === 0` and returns the merged result as a single `CallToolResult`. Hard `maxBatches` cap (default 20) prevents runaway scans; cap hit returns partial result + final `iteratorID` for caller-driven resumption.

**Why:** Investigated `@modelcontextprotocol/sdk@1.29.0` source. The `ToolCallback<Args>` type signature (mcp.d.ts:261) is `(args, extra) => CallToolResult | Promise<CallToolResult>` — explicit single-return contract, NOT `AsyncGenerator<CallToolResult>`. Each `tools/call` request resolves to exactly one `CallToolResult` at the JSON-RPC framing layer. Streaming-of-content does not exist as a first-class primitive. Three SDK-adjacent mechanisms exist but none deliver result-body chunking:

1. **`extra.sendNotification`** (`RequestHandlerExtra.sendNotification`, protocol.d.ts:207) — emit `notifications/progress` `{ progress, total?, message? }` or `notifications/message` mid-call. Advisory only — for UI ticks, not result data. Client only sees them if it passed a `progressToken` in `params._meta`. No MCP client renders progress notifications in any user-visible way on stdio today.
2. **`server.experimental.tasks.registerToolTask`** (mcp.d.ts:32) — register a tool with `createTask` / `getTask` / `getTaskResult` handlers. Client polls via `tasks/get` / `tasks/result` (with optional `pollInterval`). Side-channel `TaskMessageQueue` can queue intermediate messages.
3. **`Protocol.requestStream`** (protocol.d.ts:345) — experimental CLIENT-side `AsyncGenerator<ResponseMessage>` consuming `taskCreated` / `taskStatus` / `result` / `error` events. Lifecycle stream, not result chunks.

Rejected option 1 as a primary mechanism — it's UI sugar, not the feature operators asked for. Rejected option 2 (experimental tasks API) for two reasons: (a) explicitly marked "experimental, may change without notice" — locking a load-bearing operator workflow into shifting SDK surface is a maintenance bet; (b) client-polled, requires `TaskStore` + `TaskMessageQueue` plumbing in `src/index.ts` (the in-memory variants ship in the SDK at `experimental/tasks/stores/in-memory`), and would ship without a consumer (Claude Code stdio doesn't exercise task semantics).

The original #73 premise was also wrong on a load-bearing point: "QB can produce one stream" — it cannot. QBXML's iterator cap (`MaxReturned` ~500/batch) is a server-side QuickBooks Desktop constraint. A 2,000-customer dump is exactly 4 wire round trips to QB regardless of MCP-layer shape. The cost #73 actually targets is **LLM-side round trips** (4 `tools/call` invocations vs. 1), not wire-side fetch time. Server-side iterator collapse collapses the LLM side without depending on any MCP streaming surface.

**Alternatives rejected:**
- **AsyncGenerator return from `server.tool`** — not supported by the SDK type signature. Would require forking the SDK or dropping below `McpServer` and registering raw request handlers directly. Both reject the project convention of "register via `server.tool(name, description, zodSchema, handler)` — never bypass the SDK" (CLAUDE.md).
- **Progress notifications as a primary delivery mechanism** — advisory only, no MCP client renders them today, would ship without a consumer.
- **Experimental task-based tools (`registerToolTask`)** — marked experimental, requires non-trivial plumbing in `src/index.ts` (TaskStore + TaskMessageQueue), no consumer on the operator side, locks a load-bearing operator workflow into shifting SDK surface.
- **Status quo (caller-driven iterator loop)** — operator already has this via `paginate: true` + `iteratorID`. The complaint in todo.md #73 is the 4 round-trip LLM-side cost, not the wire shape. Status quo is not the answer.

**Tradeoffs / consequences:**
- `autoExhaust: true` is a **single slow tool response** instead of N fast ones — that's the inherent tradeoff for batch-dump UX. The operator chose latency-per-call vs. round-trip count.
- `maxBatches` cap is a hard guardrail — under default 20, a tool can return up to ~10k rows (20 × 500/batch). Books larger than that need the caller to either bump `maxBatches` explicitly OR resume via the returned `iteratorID`. Default deliberately favors safety over completeness — silent unbounded scans on a multi-million-customer book would be worse than a cap-hit warning.
- The wire-cost analysis is asymmetric: **MCP-side round trips collapse 4→1, QB-side round trips stay 4** (`queryEntityPaginated` makes the same N calls under the hood). If a future operator says "this is still too slow," the answer is "QB Desktop's wire cap is the floor" — there is no MCP-layer fix.
- The bound on the response body grows with `maxBatches`. A 10k-customer response at ~1KB/row = ~10MB JSON in one `CallToolResult` — well below the stdio transport's effective ceiling but larger than the typical paginated response (~500KB). Memory cost is one-shot (the result accumulates in-process, gets stringified, gets emitted, gets GC'd) — no streaming back-pressure path.
- The `iteratorID` returned on a cap-hit is **only valid in live mode** for resumption — sim's `queryEntityPaginated` doesn't maintain cross-call iterator state (Continue is treated as exhausted). The `autoExhaust` path emits a sim-side warning if it hits the cap (rare — sim seed sizes are well under 500 rows per entity type) noting that resumption only works against real QB.
- Iterator state is per-`*QueryRq` envelope on the QB side, so `autoExhaust` cannot combine filters across types (e.g. "every entity in the book"). It's strictly a single-entity-type collapse.

**Revisit when:**
- An MCP client emerges that meaningfully renders progress notifications on stdio AND an operator workflow has UI feedback as a hard requirement — then layer Option B (`extra.sendNotification` between iterator pages) on top of `autoExhaust`. ~30 LoC per tool, one shared `emitProgress` helper.
- The SDK promotes `registerToolTask` out of experimental AND a downstream orchestration consumer (not Claude Code) needs the polling shape. Migration would be a per-tool `taskSupport: 'optional'` opt-in — non-destructive over `autoExhaust`; both can coexist.
- Memory pressure from a 10k-row `CallToolResult` becomes a real bottleneck (currently theoretical — no observed instance).

---

## 2026-05-20 — qb_audit_log wire shape (Phase 14 #66) — `CustomDetailReportQueryRq` with `CustomDetailReportType=AuditTrail`, NOT `TxnReportQueryRq`

**Chosen:** Route `qb_audit_log` through `CustomDetailReportQueryRq` with `CustomDetailReportType=AuditTrail`. Reuse the existing `buildCustomDetailReportRequest` builder + `extractCustomDetailReportData` adapter — no new builder, no new parser surface. Manager exposes a thin convenience method `runAuditTrailReport({ fromDate?, toDate? })` that hardcodes the report type + canonical IncludeColumn list (`User` / `TimeModified` / `ModifyType` / `ChangedField` / `OldValue` / `NewValue` / `TxnID` / `TxnType`).

**Why:** `AuditTrail` is a value in the QBXML SDK's `CustomDetailReportType` enum (alongside `CustomTxnDetail` / `CustomSummary`) — NOT a value in `TxnReportType`. The prior HANDOFF.md speculated `TxnReportQueryRq (audit-trail mode)` but that enum doesn't include `AuditTrail`. Going down that path would have failed at QBXML XSD validation on the first live call (statusCode -1 "found an error when parsing"). Operator-confirmed the `CustomDetailReportQueryRq` route before implementation.

**Alternatives rejected:**
- `TxnReportQueryRq` with audit-trail mode (the HANDOFF guess) — `TxnReportType` enum does not include `AuditTrail`; would fail XSD validation in live.
- New dedicated builder (`buildAuditTrailReportRequest`) — would duplicate the `CustomDetailReport` envelope shape. Reuse via `reportType="AuditTrail"` is structurally identical to the operator-already-validated bank-rec read path.
- Skip the tool, defer Phase 14 #66 to a future session — operator explicitly picked the `CustomDetailReportQueryRq` route and asked to proceed.

**Tradeoffs / consequences:**
- `qb_audit_log` shares the `CustomDetailReportQueryRq` wire path with `qb_uncleared_transactions` / `qb_reconciliation_discrepancy` — a parser regression on the row-tree adapter (`adaptLiveCustomDetailReportRet`) breaks all three. The existing CustomDetailReport tests pin the row-tree shape; the AuditTrail tests pin the column-by-title mapping. Both layers must stay green.
- `CustomDetailReportType="AuditTrail"` differs from `CustomTxnDetail` in that it does NOT require a `ReportAccountFilter` (audit entries span every entity type, not a single account). The sim's `handleCustomDetailReportQuery` dispatches to `handleAuditTrailReport` BEFORE the `CustomTxnDetail`-specific account-filter requirement — a future refactor that hoists the account-filter check above the dispatch will silently break the AuditTrail path (test pins this).
- `txnId` scoping has no wire-level filter (`CustomDetailReportQueryRq` accepts no `TxnIDFilter`) — the tool layer post-filters after a 2-year default lookback fetch. Cost noted in tool description: on a very-large audit log (multi-year heavy-mutation books) a 2-year fetch may be slow. If operator workflows demand it, relax the both-args XOR to AND-combine: `dateRange` narrows the wire-side fetch + `txnId` post-filters within that window.
- The seeded audit-trail entries are static — sim does NOT auto-generate audit events on entity mutations (would require event-sourcing the entire sim store, a much larger refactor). Tests that exercise the audit log against sim mutations would need to either (a) extend the sim to event-source — out of #66 scope, or (b) add to `auditTrail` directly via a sim-test-only helper. Today, all #66 tests use the static seed.
- Snapshot/restore extended to clone `auditTrail` — defensive against a future event-sourced sim path. Today there's no audit-mutating code, so the clone is a no-op cost-wise (8 entries × structuredClone).
- Column titles in `IncludeColumn` are best-effort inferred from QB Desktop's Audit Trail report UI labels — exact wire names await live verification against an Enterprise install. Tool layer reads columns by title with `""` defaults — tolerant to column-name drift; live mismatch surfaces as empty strings for affected fields, not a runtime crash. Fix would be in `runAuditTrailReport`'s IncludeColumn list, not the row mapper.

**Revisit when:** First live exercise against an Enterprise QB install reveals column-name mismatch or schema-validation failure on the envelope (status -1 "found an error when parsing"). The HANDOFF's "Live verification deferred" caveat is the trigger.

---

## 2026-05-20 — Dry-run mechanical rollout (Phase 14 #64a) — `dryRun: z.boolean().optional()` threaded into all ~50 simple-mutation tools; composite tools deferred to V2 per a per-tool decision matrix

**Chosen:** Hand-thread the V1 pattern into every `*_create` / `*_update` / `*_delete` / `*_apply` / `*_make_inactive` tool whose handler reduces to a single `addEntity` / `modifyEntity` / `deleteEntity` / `updateClearedStatus` primitive call. Skip any tool whose handler reads-then-mutates, runs compensating-rollback logic, or fans out to multiple mutation primitives — those need bespoke V2 decisions. Codemod was considered and rejected: per-tool pre-validation varies (vendorName-or-vendorListId guards, line-source guards, hierarchy parent resolution, etc.), and the rolled-up Edit-tool budget for 62 mechanical transformations (~5-10 min/tool of attentive hand-threading) was lower than the round-trip cost of writing a robust codemod that handles all the variation. Build-passes-after-every-domain cadence catches mistakes early.

**Domains threaded (24 files, 62 dryRun-bearing handlers):**
- list entities: `accounts` (4: add/update/make_inactive/delete), `vendors` (3), `employees` (4: includes make_inactive), `items` (3: subtype-aware via `Item${args.itemType}`), `customers` (2 new: update/delete)
- transaction entities — AR side: `invoices` (1 new: update), `estimates` (3), `sales-orders` (3), `sales-receipts` (3), `credit-memos` (4: includes apply), `statement-charges` (3), `payments` (2: receive/apply)
- transaction entities — AP side: `bills` (3), `purchase-orders` (3), `checks` (3)
- transaction entities — banking: `deposits` (3), `transfers` (3), `journal-entries` (3)
- transaction entities — other: `inventory-adjustments` (2), `time-tracking` (1), `vehicle-mileage` (1), `sales-tax` (1: payment_create), `attachments` (2)
- specialty primitive: `reconciliation` (1: `cleared_status_update` uses `updateClearedStatusDryRun`)

**Composite outliers deliberately NOT threaded in this sweep (need V2 per-tool design):**
- Originally flagged in V1 handoff: `qb_invoice_write_off`, `qb_invoice_batch_create`, `qb_sales_receipt_batch_create`, `qb_journal_entry_batch_create`, `qb_invoice_duplicate`, `qb_estimate_convert_to_invoice`
- **Newly added to outlier set** (same logic — read-then-mutate or fan-out to multiple primitives): `qb_bill_duplicate`, `qb_journal_entry_duplicate`, `qb_sales_receipt_duplicate`, `qb_sales_order_convert_to_invoice`, `qb_bill_pay` (composite that creates BillPaymentCheck/BillPaymentCreditCard against open bills)

**Per-tool transformation pattern (verbatim across all 62 handlers):**
```ts
// schema field:
dryRun: z.boolean().optional().describe("If true, preview what this call WOULD do without committing. See qb_customer_add's dryRun docs for the full composition matrix."),

// handler branch (inserted immediately BEFORE the existing real-call try { ... }):
if (args.dryRun) {
  try {
    const preview = await session.<addEntityDryRun|modifyEntityDryRun|deleteEntityDryRun|updateClearedStatusDryRun>(<entity-type>, <data | id>, <args.idempotencyKey if applicable>);
    const { entity, ...rest } = preview;
    return { content: [{ type: "text" as const, text: JSON.stringify({
      success: true, dryRun: true, ...rest, ...(entity ? { <domain-key>: entity } : {}),
    }, null, 2) }] };
  } catch (err) {
    return formatToolError(err, { fallbackMessage: "<RqName> dry-run failed" });
  }
}
```

The domain key (`customer`, `invoice`, `bill`, `vendor`, `account`, `check`, `deposit`, `transfer`, `estimate`, `salesOrder`, `salesReceipt`, `creditMemo`, `statementCharge`, `payment`, `purchaseOrder`, `journalEntry`, `inventoryAdjustment`, `timeTracking`, `vehicleMileage`, `salesTaxPayment`, `attachment`, `employee`, `item`, `deleted`) is the same key the real-call path uses — preserves response shape for the `success: true` case.

**Tests:** +4 new tool-surface tests in [tests/dry-run.test.ts](tests/dry-run.test.ts) Layer 7, filling the coverage gaps the V1 pilot's 3 tools didn't pin:
- list-entity update (`qb_account_update` — Account.Description NOT modified)
- list-entity delete (`qb_account_delete` — Account still present)
- transaction-entity update (`qb_bill_update` — Bill.Memo NOT modified)
- cleared_status_update (`qb_cleared_status_update` — ClearedStatus NOT modified)

Total tests 1479 → 1483. Tool count unchanged at 147 (`dryRun` is a flag on existing tools, not a new tool surface).

**Why hand-thread over codemod:**
- **Pre-validation variance is real.** `qb_bill_create` has a "either vendorName or vendorListId" pre-check + an "expense or item lines required" pre-check; `qb_check_create` has a "either accountName or accountListId" pre-check + the same line-source check; `qb_statement_charge_create` has a "amount OR quantity+rate" derivation guard. A codemod that handles all of these correctly is a small parser, not a regex. The Edit-tool round-trip cost of writing + testing that parser exceeded the per-tool hand-thread cost.
- **Build-after-every-domain cadence is the safety net.** TypeScript catches shape mismatches immediately — `npm run build` ran clean after each 2-4 tool batch. Codemod would have run all 62 transformations before any feedback, multiplying debug surface.
- **Description prose is per-tool.** Some tools got "Pass `dryRun: true` to preview without committing." appended to their existing description; the V1 pilots got bespoke language explaining the composition matrix. A codemod would either ignore descriptions (worse for operator-discoverability) or need a regex per tool family (no time savings).

**Alternatives rejected:**
- **One-shot codemod** — see above; not zero-cost given variance, and would skip the build-after-batch safety net.
- **Per-domain test file (one sanity test per tool)** — would add ~60 tests for ~0 marginal pin value. The pattern is identical across handlers; TypeScript validates the shape; the 4 Layer-7 tests cover the pattern families that V1 didn't pin (list-modify, list-delete, txn-modify, special primitive). One sanity test per primitive pattern beats one per tool.
- **Thread composite outliers anyway with "best-effort" previews** — A `qb_invoice_write_off` preview that ran the read but skipped the compensating-rollback path would silently misreport "this would work" when the real call could still fail mid-rollback. Deferring to V2 with explicit per-tool decisions preserves the dry-run safety guarantee (a successful dry-run accurately predicts the real call).

**Tradeoffs / consequences:**
- **Composite outliers are now an explicit V2 deferral with named tools, not "everything else."** The 11-tool outlier list (6 originally flagged + 5 added by this sweep + `qb_bill_pay`) is the definitive set needing bespoke V2 designs. Each needs a per-tool question answered before threading: peek the idempotency cache? snapshot before the read? what does "would happen" mean when the rollback path could itself fail? Defer until operator-feedback on V1 makes the ergonomics worth iterating on.
- **`qb_credit_memo_apply` + `qb_payment_apply` ARE threaded** even though they sound composite. Both are pure `modifyEntity` wrappers — they don't fan out to multiple primitives, just send a `*ModRq` with an `AppliedToTxnMod` array. The sim store's `handleMod` does the AR-balance reversal/re-application atomically inside the single mutation, so `modifyEntityDryRun`'s snapshot/restore captures the entire side-effect surface.
- **`qb_account_make_inactive` + `qb_employee_make_inactive`** — these are thin wrappers over `modifyEntity({ IsActive: false })`. Threaded the same way as `_update`; both share the `dryRun: true` preview shape.
- **`time-tracking` has a small post-processing wrinkle.** The real call derives `hours` from the persisted Duration as part of the response. The dry-run path mirrors this — derives `hours` from `entity.Duration` before constructing the response — so the dry-run preview's `timeTracking.hours` matches what the real call would return.

**Revisit when:**
- An operator runs the V1 dry-run against a real workflow and reports an ergonomics gap (e.g. preview output too verbose, or a missing field).
- A composite outlier reaches the top of the priority queue. The first composite-V2 candidates are probably `qb_invoice_batch_create` and `qb_journal_entry_batch_create` (high-impact monthly recurring flows where preview before commit is most valuable).
- A new mutation tool is added — it MUST land with `dryRun` threaded (the pattern is now baseline expectation, not opt-in).

---

## 2026-05-20 — Dry-run mode (Phase 14 #64) V1 — manager-layer primitives + snapshot/restore + three composition decisions pinned

**Chosen:** Phase 14 #64 ships dry-run mode in two layers. (1) **Manager layer** — new `addEntityDryRun` / `modifyEntityDryRun` / `deleteEntityDryRun` / `executeBatchAddDryRun` / `updateClearedStatusDryRun` methods on [QBSessionManager](src/session/manager.ts), each returning a typed `DryRunResult` (or `DryRunBatchResult`). Sim mode runs the operation against a snapshot of the sim store and restores it in a `finally` block — observable side-effects are zero. Live mode (Option B below) builds the QBXML envelope and returns it without hitting the wire. (2) **Sim store** — new `snapshot()` / `restore(snap)` primitives on [SimulationStore](src/session/simulation-store.ts) that deep-clone the `stores: Map<string, EntityStore>` and `idCounter` via `structuredClone`. (3) **Pilot tool surface** — `dryRun: z.boolean().optional()` threaded into three representative tools: `qb_customer_add` (simplest list entity + idempotency composition), `qb_invoice_create` (transaction with lines + Customer.Balance side effect), `qb_invoice_delete` (transaction delete with side effects). Composition with read-only (`#42`) and idempotency keys (`#47`) completes the safety triad.

**Three composition decisions** (the load-bearing ones):

1. **Read-only × dry-run = ALLOW.** A session opened with `readOnly: true` CAN run dry-run. Dry-run is observationally a read — an audit-mode operator should be able to preview what a mutation would do without changing the read-only contract. Implementation: dry-run primitives delegate to private `*Core` methods (added in this change) that skip `assertWritable`. Tested by `dry-run.test.ts` — Layer 3.

2. **Idempotency × dry-run = PEEK, never write to cache.** Same-key + same-fingerprint reports `wouldReplay: true` and returns the cached entity (no preview run). Same-key + different-fingerprint reports `wouldSucceed: false, statusCode: 9002` in the DryRunResult shape (NOT thrown — surfaced as a structured result for symmetry with other dry-run failures). Dry-run results are NEVER persisted to the idempotency cache, even on a successful preview. Tested by `dry-run.test.ts` — Layer 4.

3. **Live mode preview = Option (b) — envelope + payload validation only.** No entity-after preview. The sim store doesn't mirror real QB data, so a sim-oracle preview against a fresh seed would be misleading. Live dry-run returns `previewSupported: false`, `qbxmlEnvelope: "<built XML>"`, and a human-readable `note` explaining why. The Zod payload validation and envelope build are still useful — they catch the structural class of bug before any wire call. Idempotency PEEK still runs in live mode (the cache is per-process, no wire I/O needed). Tested by `dry-run.test.ts` — Layer 5.

**Why each over the rejected alternative:**

- **Read-only ALLOW vs REJECT** — REJECT would preserve the "read-only is unambiguous" contract but kill the read-only-auditor use case for dry-run (the entire point of the safety triad). ALLOW matches Stripe's `?test_mode=true` ergonomics where preview is always available. The unambiguity argument actually cuts the other way: dry-run IS observationally a read, so allowing it doesn't violate read-only's semantic guarantee — the session still emits zero mutations.
- **Idempotency PEEK vs run-anyway** — Run-anyway would run the sim preview against a same-key + different-payload mismatch, telling the agent "this would succeed" when in reality the REAL call would 9002-conflict. PEEK + surface conflict matches the real call's behavior so the agent learns what would actually happen. The "never write to cache" rule keeps dry-runs strictly non-persistent — a dry-run on a fresh key followed by a real call with the same key must NOT short-circuit on a phantom cache entry.
- **Live mode Option (b) vs (a) refuse / (c) sim oracle regardless** — (a) refuse kills the safety win for live operators (no envelope validation, no Zod check confirmation). (c) sim oracle regardless is dangerous — operators may misinterpret "preview against fresh seed" as "preview against my books" and act on bogus information. (b) is the honest middle ground: deliver the validation safety net without misleading entity-after data.

**Implementation notes:**

- **Chokepoint refactor** — `addEntity` / `modifyEntity` / `deleteEntity` / `executeBatchAdd` / `updateClearedStatus` each split into a public wrapper (`assertWritable` gate + delegate) plus a private `*Core` method (no gate). Dry-run primitives call the `*Core` method. This puts the read-only ALLOW × dry-run composition in ONE place (the gate is skipped at exactly one entry point per operation) rather than forking the dry-run path four ways for the four mutation entry points. Same pattern used by [DECISIONS.md:90](DECISIONS.md) auto-reconnect for the same "single chokepoint" reason.
- **Snapshot deep-clone** — sim store entities are mutated IN PLACE by handleAdd / handleMod (e.g. `Customer.Balance += invoice.subtotal` on Invoice add; line `*Ret` arrays appended; sublevel hierarchy recomputed). A shallow Map clone leaks those mutations through restore. `structuredClone` per entity solves this without per-shape knowledge.
- **Doomed-entity invariant carries forward** — handleAdd's Customer-with-unknown-parent path rejects with 3120 BEFORE `store.set(id, entity)`. The dry-run wrapper catches the thrown `QBXMLResponseError` from `extractResponseData` and surfaces `wouldSucceed: false, statusCode: 3120, statusMessage`. The snapshot/restore approach is belt-and-suspenders here: even if a future handleAdd bug partially mutated before throwing, restore would roll it back.
- **`previewInSim` private helper** — centralizes the snapshot → operation → restore try/finally + the QBXMLResponseError classification for the four single-entity dry-run methods. Batch dry-run has its own variant because its shape differs (`results` array vs `entity` object).
- **idempotency PEEK reuses existing primitives** — `peekIdempotencyEntry` (added for `qb_invoice_write_off` in [DECISIONS.md:281](DECISIONS.md)) is reused verbatim. `fingerprintPayload` (module-level helper in manager.ts) is reused for the same-fingerprint check. Dry-run does NOT call `cacheIdempotencyResult` — that's the "never write to cache" rule.

**Alternatives rejected:**
- **Per-call `dryRun` flag on the existing typed methods** (`addEntity(entityType, data, { dryRun: true })`) — would fork the return type at the manager level (success returns `Record<string, unknown>`, dry-run returns `DryRunResult`). Separate methods give a clean type per call site and let dry-run grow extra parameters (`idempotencyKey` PEEK) without polluting the real-call signature.
- **Tool-layer-only dry-run** (build envelope at the tool, never hit sim store) — would lose the entity-after preview which is the bulk of dry-run's value in sim mode. The chokepoint refactor was the right place to put this.
- **One unified `DryRunResult` for both single and batch** — `results` array vs `entity` object is a meaningful shape difference; one union type loses inference at the tool layer. Two interfaces (`DryRunResult` + `DryRunBatchResult`) make tool-layer code cleaner.
- **Auto-enable dry-run on read-only sessions** — would silently change semantics: a tool call with no `dryRun` arg would behave differently in read-only vs writable sessions. Explicit `dryRun: true` opt-in is clearer.

**Tradeoffs / consequences:**
- **+~50 mechanical tool migrations remain.** Pilot covers 3 of ~55 `*_create` / `*_update` / `*_delete` tools. Remaining surface needs the same `dryRun: z.boolean().optional()` schema field + handler branch. Codemod-friendly per the [scripts/refactor-error-wrappers.mjs](scripts/refactor-error-wrappers.mjs) template — same shape transform across most tools. Composite tools (`qb_invoice_write_off`, `qb_journal_entry_batch_create`) are outliers needing bespoke decisions; deferred to V2 or pinned in a follow-up DECISIONS entry.
- **Live mode dry-run is less useful than sim mode.** Operators get envelope inspection + Zod validation but not entity-after preview. Documented in the `note` field. Could be lifted to (c) sim-oracle-regardless if the operator decides the disclaimer is sufficient, but that's a deliberate forward decision.
- **Read-only × dry-run blurs the read-only contract slightly.** A read-only session CAN now call a "mutation" method (the dry-run variant). Mitigated by the explicit `dryRun: true` arg — there's no path where read-only + an apparent mutation call silently produces a preview. The tool surface is unambiguous.
- **Cache-peek-before-snapshot order matters.** Same-key + same-fingerprint hit short-circuits BEFORE the sim snapshot/restore runs — cheaper and matches what the REAL call would do (replay returns cached without wire I/O). Cache-peek-after would do extra work for no reason.
- **`structuredClone` is V20+ standard.** Node 16 had it shimmed; node 20+ has it native. Our minimum is node 20 (project's `package.json` engines pin), so this is safe.

**Revisit when:** Operator wants Option (c) sim-oracle-regardless in live mode (cancel decision 3). Or when a mutation primitive is added that doesn't fit the `*Core` chokepoint pattern (e.g. a multi-table compound mutation). Or when the V1 pilot's surface grows enough to merit the mechanical rollout — that's a separate todo.md item now (the V1 close note flags it).

---

## 2026-05-20 — Dry-run mode V1 (Phase 14 #64) — manager-chokepoint *DryRun primitives, sim-snapshot oracle, ALLOW × read-only, PEEK × idempotency, envelope-only in live

**Chosen:** V1 ships dry-run as a per-call `dryRun: boolean` flag (Stripe `?test_mode=true`-style ergonomics) on the three pilot tools — `qb_customer_add`, `qb_invoice_create`, `qb_invoice_delete` — backed by five new manager primitives: `addEntityDryRun` / `modifyEntityDryRun` / `deleteEntityDryRun` / `executeBatchAddDryRun` / `updateClearedStatusDryRun` in [src/session/manager.ts](src/session/manager.ts). Same single-chokepoint pattern as the read-only gate (DECISIONS.md:633) and the idempotency cache (DECISIONS.md:564). The refactor extracted five private `*Core` methods (`addEntityCore`, `modifyEntityCore`, `deleteEntityCore`, `executeBatchAddCore`, `updateClearedStatusCore`) — public mutation methods call `assertWritable` then delegate to the `*Core` method; dry-run primitives skip `assertWritable` and call `*Core` directly inside a snapshot/restore brace. New `SimulationStore.snapshot()` / `restore(snap)` deep-clone the `stores: Map<string, EntityStore>` and `idCounter` (uses `structuredClone` on each entity so in-place mutations like `Customer.Balance` increments roll back cleanly). Exported `DryRunResult` and `DryRunBatchResult` interfaces. Module-level `DRY_RUN_LIVE_NOTE` constant for the human-readable live-mode disclaimer.

**The three composition decisions (all settled in V1):**

1. **Read-only × dry-run = ALLOW.** Dry-run is observationally a read. An audit-mode operator (`readOnly: true`) can preview a would-be mutation without changing the read-only contract — the dry-run primitives don't call `assertWritable`. The real call from the same read-only session still rejects with `QBReadOnlyError` (9001) as expected.

2. **Idempotency × dry-run = PEEK, never write to cache.** Same-key + same-fingerprint reports `wouldReplay: true` with the cached entity. Same-key + different-fingerprint reports `wouldSucceed: false, statusCode: 9002` (surfaced as a structured DryRunResult field, NOT thrown — keeps dry-run failures uniform). Dry-run results are NEVER persisted to the idempotency cache (a successful dry-run isn't a successful create — caching it would shadow the real call).

3. **Live mode preview = option (b): envelope + payload validation only, no entity-after preview.** The sim store doesn't mirror real QuickBooks data, so a sim-oracle preview against a fresh seed would be misleading. Live dry-run returns `previewSupported: false, qbxmlEnvelope: <built XML>, note: "Live preview unavailable…"`. The idempotency PEEK still runs in live mode (the cache is per-process, no wire I/O needed) so `wouldReplay` / 9002 conflict can still surface without ever hitting QBXMLRP2.

**Why:**
- **Single chokepoint matches established architecture.** The read-only gate (DECISIONS.md:633) and the idempotency cache (DECISIONS.md:564) both established that policy concerns affecting every mutation belong in `QBSessionManager`, not duplicated across ~55 tool call sites. Dry-run is the third member of this triad. Putting the dry-run primitives in the manager means the mechanical rollout to the remaining ~50 `*_create` / `*_update` / `*_delete` tools is a `dryRun: z.boolean().optional()` schema addition + a 6-line handler branch per tool, no per-tool oracle logic.
- **Snapshot/restore on the sim store is the safe rollback primitive.** Even if a buggy `handleAdd` path partially mutated before throwing (it shouldn't — the doomed-entity invariant at [simulation-store.ts](src/session/simulation-store.ts) Customer branch rejects unknown parents BEFORE persist), restore() rolls it back. Tested by pinning the post-dry-run state in `tests/dry-run.test.ts` — `idCounter` is preserved, `Customer.Balance` reverts when an Invoice preview rolls back, the doomed-entity is not in the store after a 3120 rejection.
- **ALLOW composition with read-only is the more useful default.** Rejecting dry-run from a read-only session would protect the "unambiguous read-only" contract but would also kill the safety triad's utility for the audit-mode operator (a CPA reviewing a junior's proposed changes without write access). The unambiguity argument cuts the other way here — dry-run IS observationally read-only, so allowing it doesn't break the contract.
- **PEEK + structured conflict for idempotency.** Dry-run should tell the agent what the REAL call would do. A real `addEntityIdempotent` with same-key + same-fingerprint short-circuits and returns the cached result — dry-run reports `wouldReplay: true` so the agent knows. A real call with same-key + different-fingerprint throws 9002 — dry-run reports `statusCode: 9002` as a structured field so dry-run failures stay uniform with other failure modes (3120, 3170, etc.) rather than surfacing as `isError: true`.
- **Envelope-only in live mode is honest.** The two alternatives — refuse outright (option a) or run the sim oracle against fresh-seed data and disclaim (option c) — either kill the safety win or risk operators misinterpreting a preview against fictional data as a preview against their books. Envelope + Zod validation IS still useful (it catches the structural class of bug before the wire call) and the `note` field makes the limitation explicit.
- **Pilot scope of 3 tools before mechanical rollout.** `qb_customer_add` (simplest list entity + #62 ParentRef derivation), `qb_invoice_create` (transaction with lines + Customer.Balance side effects), `qb_invoice_delete` (transaction delete with side effects). Pin behavior across the full design-question matrix before rolling out to the other ~50 mutation tools.

**Alternatives rejected:**
- **Sim-store oracle in live mode (option c)** — Risky. Operators may misinterpret a preview against fictional seed data as a preview against their books, especially on tools where the sim store's seed doesn't include relevant entities (e.g. previewing an invoice against a customer that exists in live QB but not in the seed). The disclaimer-via-note approach (option b) is more honest about the limitation.
- **Refuse dry-run in live mode (option a)** — Returns a 9006-class error. Kills the safety win for the live operator (the Zod + envelope-validation pass IS still useful even without entity-after preview).
- **REJECT dry-run from a read-only session** — Preserves the unambiguous read-only contract but kills the audit-mode use case (CPA previewing junior's proposed mutations without write access). Dry-run is observationally a read, so the contract isn't actually broken.
- **Cache dry-run results in the idempotency cache** — Would shadow the real call. A dry-run isn't a successful create; caching it would cause the next REAL call with the same key to return the dry-run result as a replay (which has different `previewSupported` / `mode` fields than the real entity-after-create response).
- **Tool-layer composition (each tool implements its own dry-run logic)** — Would mean ~55 tools each implementing snapshot/restore + idempotency PEEK + live-mode disclaimer. The single-chokepoint pattern collapses this to ~6 lines per tool.
- **`?dryRun=true` URL-style query parameter** — Not applicable to MCP tool calls (they take typed Zod args, not URL queries). A `dryRun: z.boolean().optional()` schema field is the natural MCP equivalent.

**Tradeoffs / consequences:**
- **Mechanical rollout still needed for the other ~50 mutation tools.** V1 ships dry-run on 3 pilot tools. The remaining `*_create` / `*_update` / `*_delete` tools across [src/tools/](src/tools/) (accounts, bills, checks, credit-memos, deposits, employees, estimates, items, journal-entries, purchase-orders, sales-orders, sales-receipts, statement-charges, transfers, vendors, inventory-adjustments, attachments, time-tracking, vehicle-mileage, sales-tax, reconciliation) need a `dryRun: z.boolean().optional()` schema field and a 6-line handler branch each. Recommend a codemod similar to [scripts/refactor-error-wrappers.mjs](scripts/refactor-error-wrappers.mjs) used for #65.
- **Composite mutation tools (`qb_invoice_write_off`, `qb_journal_entry_batch_create` with its compensating-rollback path) are outliers** — they mutate state they read or run multi-step orchestrations. V1 does NOT add dry-run to these. V2 needs bespoke per-tool decisions: write-off needs to peek the idempotency cache AND skip the read-then-validate path (the source invoice was supposedly closed by the same call); batch-create needs to dry-run each entry against a single shared snapshot. Pinned in HANDOFF.md.
- **Snapshot/restore overhead.** Each dry-run deep-clones the full sim store (every entity in every type's Map). Cost is O(entities × avg entity size). For a typical agent session with a few hundred seed entities, this is sub-millisecond on modern hardware. Live mode skips the snapshot entirely (envelope-only path). If sim store growth ever crosses into thousands of entities and dry-run latency becomes noticeable, the snapshot could move to copy-on-write — but premature for V1.
- **The `wouldSucceed: undefined` ambiguity in live mode** is intentional. We can't know without hitting the wire. Documented in the JSDoc on `DryRunResult.wouldSucceed`. Agents should branch on `previewSupported` rather than `wouldSucceed === undefined`.
- **Status code 9006 reserved for the future "dry-run not supported in this mode" case.** V1 doesn't use it (we chose option b, not option a). If V2 ever adds tools where dry-run is structurally impossible (e.g. composite mutations that can't be cleanly previewed), 9006 is the natural slot per the synthetic-status-code ladder (9001 read-only / 9002 idempotency / 9003 edition / 9004 payroll / 9005 SDK-no-write).
- **`structuredClone` requires Node 17+.** This codebase targets Node 20 (ESM `Node16` resolution); confirmed safe.

**Revisit when:**
- Operator wants dry-run on the composite tools (`qb_invoice_write_off`, `qb_journal_entry_batch_create`). Each needs a bespoke design pass — composite mutations don't fit the snapshot/restore preview cleanly.
- Live-mode preview becomes critical to a workflow. Two paths: (1) ship a separate "shadow QB" mode where the sim store seeds from a recent live read — significant engineering; (2) ship per-tool wire-validation-only previews where the envelope is sent and the response shape is asserted without commit — would need QBXML protocol support (does not exist as of 16.0).
- Sim store grows past several thousand entities and snapshot latency becomes a measurable hot path. Switch to copy-on-write Map semantics.
- Mechanical rollout to the remaining ~50 tools — track as a separate todo item (see HANDOFF.md / todo.md Phase 14 #64.2).

---

## 2026-05-12 — MCP prompts as workflow bundles (Phase 18 #86) — 5 prompts in src/prompts/workflows.ts, each emits one user-role text message; bridges the operator's existing skill workflows

**Chosen:** Phase 18 #86 ships five workflow-bundle prompts via the MCP `prompts/list` + `prompts/get` API: `month_end_close`, `credit_card_qb_batch`, `trial_balance_workup`, `cc_statement_validator`, `w2_prep`. Each is registered through `McpServer.registerPrompt` in [src/prompts/workflows.ts](src/prompts/workflows.ts), wired via a new `registerWorkflowPrompts(server)` entry point called once during server bring-up. The server's capabilities block now includes `prompts: {}` alongside `tools` and `logging`. Every prompt callback returns a `GetPromptResult` with a SINGLE user-role text message — the body lays out the workflow step-by-step with explicit references to the `qb_*` tools the agent should call in order, plus argument substitutions from the operator's optional inputs. All schema args are OPTIONAL, with sensible defaults (prior calendar month for month-end, last completed year for W-2 prep, today for trial balance / CC statement validator).

**Why:**
- **Bridges the operator's existing skill workflows.** HANDOFF named three named skills the operator already runs by hand (`credit-card-qb-batch`, `trial-balance-workup`, `cc-statement-validator`). Each had been an external workflow that hand-off-ed to QB Desktop via an Excel intermediate or manual CSV export. The post-Phase-11/12 tool surface now covers the actual operations directly (`qb_journal_entry_batch_create`, `qb_balance_summary` + cross-checks, `qb_uncleared_transactions` + `qb_cleared_status_update`); prompts make the right tool sequence discoverable instead of requiring the operator to remember which tool to call when. Adding `month_end_close` and `w2_prep` extends to two new bundles that compose against the new infrastructure.
- **One user-role text message per prompt, not multi-turn pre-fills.** `GetPromptResult.messages` is an array — technically a prompt could pre-fill both a user message and an assistant response. Rejected: pre-fills tie the prompt to a specific host LLM's response style, and the value of MCP prompts is to seed the conversation with a clear plan that any model can execute. A single user-role message reads as "here is the task and the recommended tool sequence" — the host LLM picks it up from there.
- **All args optional, sensible defaults.** A bare `/month_end_close` should produce a useful prompt — defaulting to the prior calendar month is the 90% case. Required args would create dead-ends when the operator forgets one (host UIs don't always validate required-flag well). The default-computation helpers (`todayISO`, `lastCompletedYear`, `priorCalendarMonth`) are pure functions exported for testing.
- **Prompts reference `qb_*` tools by EXACT name.** The agent's tool-use loop maps quoted tool names to actual calls — using approximate names ("the customer query tool") forces the model to do name resolution. Embedding the exact names cuts that hop. The prompts also embed argument shapes (`qb_pnl_report({ fromDate: "...", toDate: "..." })`) so the model has a concrete starting template.
- **Prompt bodies live in TS, not external .md templates.** Externalizing to markdown files would add a build step (markdown → embedded string) without buying anything — the operator owns the codebase and is comfortable editing TS. The TS form also lets the prompts compute dynamic defaults inline (date math, argument substitution).
- **Heterogeneous registration array with per-entry generic.** The MCP SDK's `registerPrompt` is generic over `Args extends PromptArgsRawShape`; iterating over a `PROMPT_REGISTRATIONS[]` array would widen `Args` to a union and force the callbacks into an incompatibly-loose contract. The fix is a `reg<Args>(...)` helper function that captures each entry's narrow Args type and a `forEach` over the heterogeneously-typed `as const` tuple — preserves the per-entry argsSchema ↔ callback link without runtime casts.

**Alternatives rejected:**
- **Skip MCP prompts entirely, document workflows in CLAUDE.md** — the operator's named skills (currently external) are exactly the kind of repeated workflow MCP prompts exist to solve. Surfacing them as slash-commands in Claude Desktop (or any MCP host) is strictly better than asking the operator to remember which CLAUDE.md section to scroll to.
- **One mega-prompt that branches on a `workflow: "month-end" | "tb-workup" | ...` arg** — collapses the slash-command UX. Each workflow has its own argument set; folding them into one prompt forces the operator to figure out which args apply to which workflow. Five prompts are cheaper.
- **Pre-fill an assistant response that announces "I'll start with step 1"** — tested with a draft assistant pre-fill; the host LLM (Claude Desktop) reliably ignores it and re-plans anyway, so the pre-fill was pure overhead.
- **Externalize prompt bodies to `.md` files loaded at startup** — see "TS, not markdown" above.
- **Make every prompt arg required** — see "all optional, sensible defaults" above.

**Tradeoffs / consequences:**
- Adding a new workflow prompt requires editing TypeScript (vs. dropping in a markdown file). Cost: one new entry in `PROMPT_REGISTRATIONS`. Not a maintenance burden for a project where the operator already does all the TS edits.
- The five prompts encode a specific recommended tool sequence. If a future workflow change makes a different sequence more useful, the prompt body must be edited (and the test's `references the right tool set` assertions updated). This is the right ownership model — the prompt is the documentation.
- Prompts cannot enforce that the agent actually follows the sequence — a model could ignore steps. Mitigation: prompt bodies are explicit, structured, and reference exact tool names. If we see drift, switch to assistant pre-fills or multi-message prompts.
- The `prompts: {}` capability is now advertised on the wire. Hosts that don't support prompts will simply ignore it; no compatibility risk.
- Test coverage relies on the `PROMPT_REGISTRATIONS` array being the source of truth — anyone who adds a prompt via direct `server.registerPrompt` call (not through the array) would silently bypass the registration test. Documented in the file header.

**Revisit when:** the operator names a new repeated workflow (likely candidates: 1099 prep, fixed-asset rollforward, AR collections run, sales-tax filing). Each is one new entry in `PROMPT_REGISTRATIONS`. Also: when the MCP spec adds prompt argument completion (`completions/complete` for prompt args, like resource templates have) — at that point we can wire `qb_account_list` / `qb_employee_list` into argument autocomplete and remove the "ask the operator which one" fallback in several prompts.

---

## 2026-05-12 — Closing date is read-only via QBXML SDK (Phase 18 #85) — qb_closing_date_get hits the wire, qb_closing_date_set is an informational stub (statusCode 9005)

**Chosen:** Phase 18 #85 ships `qb_closing_date_get` (real PreferencesQueryRq wire call, returns `closingDate: string | null` plus adjacent AccountingPreferences flags) and `qb_closing_date_set` (informational stub — always fails with synthetic statusCode 9005 + explicit QB Desktop UI navigation steps; no wire I/O). Both registered in fresh [src/tools/preferences.ts](src/tools/preferences.ts) via `registerPreferenceTools`. Simulation store gains a `Preferences` singleton seed with the qbXML SDK `AccountingPreferences` / `FinanceChargePreferences` / etc. groups; `ClosingDate` defaults to `null` (unset) and can be flipped via direct store mutation in tests. New synthetic statusCode `9005` added to [src/util/qb-status-codes.ts](src/util/qb-status-codes.ts) ("Closing date cannot be set via the QuickBooks Desktop SDK ... Set the closing date manually in QB Desktop under Edit → Preferences → Accounting → Company Preferences → Set Date/Password.").

**Why:**
- **The qbXML SDK has no write path for company preferences.** Verified by grep across the qbwc/qbxml master schema mirrors (`qbxmlops20.xml` through `qbxmlops140.xml`, covering every qbXML version from 2.0 through 16.0): zero hits for `PreferencesModRq`, `AccountingPreferencesModRq`, `CompanyActivityModRq`. The only Preferences surface is `PreferencesQueryRq` (read). Intuit's long-standing posture (echoed across community SDK references — ConsoliBYTE wiki, jsgoupil/quickbooks-sync's XSD, multiple Stack Overflow / Intuit Developer threads) is that **preferences are read-only via the SDK**. The closing date itself is a UI-managed setting (Edit → Preferences → Accounting → Company Preferences).
- **The read surface DOES expose `ClosingDate`.** `PreferencesQueryRs.PreferencesRet.AccountingPreferences.ClosingDate` (DATETYPE, present since qbXML 2.0). qbXML does NOT expose `ClosingDatePasswordIsSet` at any version — the password-set flag is not surfaceable. So `qb_closing_date_get` can return the date (or null) but cannot tell the caller whether the date is password-protected.
- **Ship the write tool as an informational stub, not omit it.** The handoff explicitly considered "fall back to documenting 'set in QB Desktop' with a clear error path" — that's exactly the right shape, but doing it as a stub TOOL (vs. just docs) means an agent's tool-use loop that decides "I should set the closing date" routes the user correctly. Without the stub, the agent would either invent a non-existent tool name or skip the operation entirely with no user-facing explanation. The stub returns: `statusCode: 9005`, `humanReadable` from `qb-status-codes.ts`, the 9-step UI navigation path including the operator-supplied target date, optional password-set guidance, an `sdkLimitation` field naming the missing SDK element, and a `workaround` field pointing at UI Automation as the only programmatic path.
- **Synthetic statusCode 9005 (not reuse of 3260 or -1).** The 9005 reservation was explicitly noted in HANDOFF as "reserved for future synthetic gates"; #84 deliberately did NOT burn it. 9005 distinguishes "the SDK doesn't support this operation" from QB-server-side codes (3260 = "insufficient permission" is meaningfully different — a different user with admin privileges would NOT fix the 9005 case) and from -1 (parse error — also meaningfully different). The 9000-block carries the convention "synthetic, client-side"; 9005 fits.
- **No-wire-I/O on the set tool is verified by test.** A `processRequest` spy confirms the stub never reaches the simulation store. Important because the password arg, if passed, must not be logged via `QB_DEBUG_QBXML` (we don't build the request envelope, so no debug-log entry is generated — no redaction problem to solve).

**Alternatives rejected:**
- **Omit the set tool entirely** — an agent thinking "set the closing date" would either invent a tool or skip silently. Worse UX than a fail-fast stub with UI instructions.
- **Wrap a real CompanyActivityModRq / PreferencesModRq call** — these requests do not exist in the qbXML schema (grep-verified across qbxmlops20–140). A built envelope would be rejected by QB Desktop at parse time with statusCode -1 ("found an error when parsing the provided XML text stream"), which is unhelpful to the operator. Pre-empting with statusCode 9005 + UI instructions is strictly better.
- **Try `DataEventCallbackAddRq`** — referenced in HANDOFF as a candidate. Verified: this is the event-subscription wire request (subscribe to notifications when QB data changes); it does NOT mutate preferences. Excluded.
- **Surface `ClosingDatePasswordIsSet`** — does not exist in qbXML at any version. Documented as a known SDK gap in the tool description.
- **Hard-code closingDate=null in a constant** instead of seeding the simulation store — the seed is more honest about the shape and lets tests verify the test seam (set ClosingDate → read it back).

**Tradeoffs / consequences:**
- Operators cannot lock a period programmatically via this server. The workaround (UI Automation against the running QB Desktop) is named in the stub's response but out of scope for this MCP. For practices that NEED programmatic lock control, the workaround would be a separate desktop-automation tool — not a server change.
- The `qb_closing_date_get` tool cannot tell the caller whether the closing date is password-protected. If the operator opens a backdated transaction window via QB Desktop (no password set), the SDK can write through that window — but read-only callers using qb_closing_date_get to gate "is it safe to backdate?" decisions need to assume protection MIGHT be off and ask the operator.
- The 9005 code is now reserved for SDK-write-not-supported errors. Future tools that hit similar SDK gaps (memorized transactions write — already SDK-blocked per #45 — would be a candidate) should consider whether to reuse 9005 or claim a new code. Reuse is fine when the user-facing remediation is "do it in QB Desktop's UI"; a new code is warranted when the remediation differs.
- Seeding `Preferences` adds a new entity-type to the simulation store. This is the eighth singleton-shape seed (Company, Host, Preferences are the three pure singletons; the others are lists). No regression risk: nothing else queries `Preferences`.

**Revisit when:** Intuit ships qbXML 17.0+ with a write path for preferences (extremely unlikely given the 16-year-stable read-only posture). Or when the operator wants programmatic period-lock as a critical feature — at that point, the right move is a separate desktop-automation primitive, not a server change.

---

## 2026-05-12 — Auto-reconnect on transient QBXMLRP2 errors (Phase 18 #84) — conservative whitelist, fixed 3-retry schedule, retry chokepoint inside sendRequest live branch

**Chosen:** The remaining half of Phase 18 #84 (auto-reconnect on transient QBXMLRP2 failures) ships as a retry loop inside `sendRequest`'s live branch, gated by a CONSERVATIVE transient-error classifier (`isTransientLiveError`) and a FIXED 3-retry exponential backoff schedule (`RECONNECT_BACKOFF_MS = [250, 500, 1000]`). The classifier matches only on signals we have direct evidence are recoverable: the `0x80040408` HRESULT (in hex, decimal `-2147220472`, and descriptive `"QBSession not open"` forms). The retry chokepoint lives at `sendRequest` rather than at the typed mutation helpers — wrapping `addEntity` / `modifyEntity` / etc. would put the retry above the idempotency cache, risking duplicate creates on a wire-level retry; wrapping inside `sendRequest` keeps the retry below idempotency, so the cached fingerprint guards against duplication regardless of which layer initiated the retry. State that survives reconnect: `readOnly` flag, `idempotencyCache`, `hostInfoCache` — all intentionally preserved (each invariant is per-process, not per-session). Per-attempt logger entries (`logRequest` / `logResponse` / `logError`) so the QB_DEBUG_QBXML file shows the full retry sequence with separate seq markers. Per-retry stderr `console.error` for live operability without requiring debug-log enablement.

**Why:**
- **Conservative classification, not "retry on anything".** The HANDOFF named `0x80040408` ("QBSession not open" — surfaces when QB Desktop briefly stalls during autosave or background indexing) as the canonical transient signal. Retrying on `0x80040409` / RPC_E_* codes / QB-status-code-shaped errors (3120 / 3170 / 500) would either be ineffective (the underlying error doesn't change with a fresh ticket) or actively harmful (looping wastes the budget for errors the operator needs to see). Adding more codes is one-line work when we see one in the wild; preemptively adding speculative codes risks masking real failures behind silent retries.
- **Fixed schedule, not jittered or unbounded.** Backoff jitter is a guard against thundering-herd retry collisions in distributed systems; this is a single-process MCP server talking to a single local QB Desktop process. Jitter adds complexity for no benefit. Unbounded retry would inflate latency in scenarios where QB is permanently unavailable; the 1.75s total budget caps the worst-case wait at a value humans tolerate without thinking the agent is hung.
- **Retry inside `sendRequest`, NOT around `addEntity` / mutation helpers.** Wrapping mutation helpers above the manager would put retry above the idempotency cache — a wire-level retry after a half-successful first attempt could double-post. The current architecture has idempotency at the manager (#47), which means the cache fingerprint matches BEFORE the wire call; retrying inside `sendRequest` reuses the same envelope on the same fingerprint, so the QB-side behavior is identical to a single attempt that happens to take longer. Wire-level retry is also the only level where the transient signal is observable — by the time the error reaches `addEntity`, the manager has already lost context on whether the failure was a transport stall or an application rejection.
- **State preservation across reconnect is intentional.** Before this change, an auto-reconnect (hypothetical, since none existed) would have had to choose whether to clear or preserve the idempotency cache. The choice is clear: the cache is per-companyFile (already documented), and a transient transport failure does NOT change the company file — so cached idempotency keys remain valid. Same logic for `hostInfoCache` (installation-scoped, unaffected by ticket reset) and `readOnly` (documented as surviving close/open already). `switchCompanyFile` remains the only API that clears these caches.
- **Sleep impl as an instance field, not a static class property.** The existing test seam pattern is `(sm as any).<private-field>` (used for `store.processRequest` overrides in qbxml-logger tests). Following the same pattern means tests don't need new infrastructure; the field is `private` for prod ergonomics but reachable through `as any` for tests.
- **Per-attempt logger entries, not single-marker spanning all attempts.** When debugging a transient retry, the operator wants to see each attempt's request/response separately — was the retry triggered by the same wire response twice, or did the second attempt see different data? Single-marker would collapse this into one entry per `sendRequest` invocation and hide the retry pattern. The cost is N entries per retried request when `QB_DEBUG_QBXML=1`, which is exactly when the operator wants to see them.
- **Reconnect failure wraps both causes.** If `openSession` throws during the recovery path (QB Desktop fully closed, dialog blocking the reconnect, cert revoked), the operator needs to see both: (a) WHY we tried to reconnect (the original transient error), and (b) WHY the reconnect itself failed (the new error). The error message bundles both so the operator doesn't have to dig.

**Alternatives rejected:**
- **Retry above the mutation helpers** (wrap `addEntity` / `modifyEntity` / `deleteEntity` instead of `sendRequest`) — would put retry above the idempotency cache. A retry after a half-successful create (QB committed but the response was lost) would re-attempt the create with a fresh wire call, bypassing the fingerprint cache, and double-post. Choosing the lower layer is non-negotiable for safety.
- **Jittered backoff** — adds complexity for a problem this codebase doesn't have (no distributed retry storm risk against a local QB process).
- **Unbounded retry with cumulative timeout** — operator latency unpredictability is worse than a hard cap. A 1.75s ceiling means "either we got it or we surface the error" — clear.
- **Retry on a broader set of HRESULTs** — see "conservative classification" above. Failure to retry on a real transient is a one-line fix when we see it; spuriously retrying on a permanent error is a silent latency tax and a debugging hazard.
- **Clear idempotency cache on reconnect** — pessimistic and breaks the documented per-companyFile cache contract. Transient transport failures don't invalidate idempotency keys.
- **Sleep impl via global module mutation** (e.g. `setReconnectSleepForTesting`) — works but pollutes the module surface. Per-instance field via `as any` matches the existing pattern with no new module exports.
- **Synthetic statusCode for transient retry exhaustion** — initially considered using a new 9005 to distinguish "we tried 4 times" from a one-shot QB error. Rejected: the operator sees the original transient error message verbatim plus the console.error retry breadcrumbs; adding a synthetic code would require qb-status-codes.ts entry + tool-side branching for negligible UX gain. Leave 9005+ reserved for future synthetic gates.

**Tradeoffs / consequences:**
- A request that ultimately fails after 3 retries waits an extra 1.75s before surfacing the error. For an agent expecting fast feedback on a permanently-unavailable QB this is a noticeable delay — but operators report the alternative (running the same call manually after the failure) takes far longer.
- The fake-live test seam (`(sm as any).simulationMode = false` + patched `rp` + patched `openSession` + `sleepImpl`) is now a load-bearing test pattern. Future changes that rename these private fields will break the retry tests; the test file is documented to make this explicit.
- The retry classifier whitelist is intentionally narrow. If a NEW transient signal appears in the wild that's not on the list, retries won't kick in — the operator must report the wire-level error message and we extend the whitelist. This is the right default for a tool where retries can mask real failures.
- The retry runs INSIDE `sendRequest` for live mode only; simulation mode never retries. Tests that want to simulate the retry pattern must use the fake-live manager (sim mode short-circuits the retry loop entirely). The "does NOT retry in simulation mode" test pins this behavior.
- Per-attempt logger entries inflate the QB_DEBUG_QBXML log file when retries fire — typically 0% of the time, but during a retry storm the log could grow N× faster. Acceptable: that's exactly when the operator needs the detail.
- `RECONNECT_BACKOFF_MS` is exported so future tuning is intentional (anyone changing it has to update the pinning test); not exported through any user-facing surface so operators don't see it.

**Revisit when:**
- A live operator reports a transient-shaped error that's NOT on the whitelist (likely `0x80040409` or an RPC_E_* code under sustained load). Extend `isTransientLiveError` to match it; add a regression test.
- The retry budget proves insufficient for a real recovery pattern (QB Desktop's autosave routinely takes >1.75s). Add a fourth tier (e.g. 2000ms) rather than stretching existing values; the existing tiers are pinned by tests.
- A future feature needs per-request retry overrides (e.g. a bulk batch tool that wants to abort fast rather than burn the retry budget). Add an optional `noRetry: true` flag at the `sendRequest` level.
- The `readOnly` / idempotency cache / hostInfo cache invariants change. If any of them becomes per-session rather than per-process, the reconnect path must explicitly clear it; the docstring on `reconnectAfterTransientError` calls these out so a future agent will see the dependency.

---

## 2026-05-12 — qb_w2_summary ships full wire surface (PayrollSummaryReportQueryRq) with edition gate + synthetic 9003/9004 status codes

**Chosen:** Phase 11 #55 `qb_w2_summary` ships an end-to-end NEW wire surface for `PayrollSummaryReportQueryRq` (builder + manager method + sim handler + tool) rather than aggregating from typed entity queries (the `qb_1099_summary` pattern from Phase 10 #44). Edition gating is a pre-flight probe at the tool layer via `session.getHostInfo()` — Pro builds (without Plus) reject with new synthetic `statusCode 9003` BEFORE the wire call. Empty-result path (sim returns `statusCode 1` → `extractReportData` returns `{}`) is translated to new synthetic `statusCode 9004` ("payroll subscription required or not active") at the tool layer. Sim seeds three Employee records with a sim-only `PayrollYTDByYear` extension carrying deterministic YTD totals per tax year — chosen over walking a synthesized `Paycheck` store to keep the sim surface minimal. Live mode is verified-by-construction (no `adaptLivePayrollReportRet` row-tree adapter yet — the first live run against a real QB Desktop will reveal the `EmployeeWagesTaxesRet` wire shape and any schema-order corrections needed). SSN is masked to last 4 (`XXX-XX-1234`) in the sim handler before emit — matches real QB's printed payroll-summary behavior.

**Why:**
- **PayrollSummaryReportQueryRq is its own SDK request element** — distinct from `GeneralSummaryReportQueryRq` (different report-type discriminator child: `PayrollSummaryReportType`, not `GeneralSummaryReportType`) and has no `ReportBasis` child (payroll reports are inherently cash-basis). The `qb_1099_summary` aggregate-from-Bill+Check pattern doesn't apply here — `Paycheck` is payroll-subscription-only and not stored generically in the sim; aggregating from a synthetic store would be pure sim-side fabrication with no live equivalence.
- **Edition gate at the tool layer, not the manager.** The host info cache (#82) is already lazy at the manager — putting the gate in `runPayrollSummaryReport` would force every payroll wire call through a HostQueryRq round trip even when edition is already cached. The tool-layer probe uses the cache transparently, and only Pro is rejected; Premier / Enterprise / Accountant all proceed.
- **Two synthetic status codes, not one.** `9003` (edition unsupported) and `9004` (subscription required/inactive) are distinct failure modes — `9003` is a hard "your QB build can't do this" (operator needs to upgrade), `9004` is "your build CAN do this but the subscription isn't active or there's no data" (operator can fix by subscribing or verifying employees). Different remediations → different error codes.
- **Sim seeds 2024 + 2025 per employee.** Today (2026-05-12) the default `taxYear` resolves to 2025 (last completed year). Seeding both years lets the default-path test AND explicit-year tests share the seeded employees. Three employees cover the state-tax variants: IL (full state W-2), CO (full state W-2), TX (no state income tax — state boxes absent, exercises the optional-state-fields branch).
- **SSN masking at the sim handler.** Sim seeds full SSN for realism but masks before emit; the tool layer trusts what the sim emits. Mirrors real QB's report format (masked) rather than QB's stored record (full).
- **Cross-year period rejection.** `fromDate=2024-06-01` + `toDate=2025-05-31` returns 3120 — the W-2 box model is annual by construction. Allowing cross-year periods would force the tool to either split the result across years (confusing) or pick one (silently wrong). Rejecting forces the caller to be explicit.

**Alternatives rejected:**
- **Aggregate from existing typed entity queries** (the `qb_1099_summary` pattern) — would require synthesizing paycheck data sim-side AND live-side, and the SDK ALREADY exposes `PayrollSummaryReportQueryRq` so there's no reason to fake it. Plus the W-2 box model is inherently report-shaped; the wire request returns exactly what we need.
- **Gate at the manager via a new `runPayrollSummaryReportGated` method** — concentrates gating logic at the wrong layer. Edition is a tool-policy decision, not a manager invariant. Future tools may want different edition policies; the gate belongs with the tool.
- **Single synthetic status code (9003) for both "edition unsupported" and "subscription required"** — collapses two distinct remediations into one error. The cost of separating them is one extra entry in `qb-status-codes.ts`; the benefit is the operator gets actionable feedback.
- **Add a live row-tree adapter (`adaptLivePayrollReportRet`)** for first cut — pure speculation without live verification data. Sim emits the simplified shape directly; live will reveal the actual wire shape and an adapter can be added when the first live run shows what's needed.
- **Walk a synthesized `Paycheck` store in sim** — would have required adding `Paycheck` to the entity model + per-paycheck CRUD + sum-aggregation logic just to drive a single report. The `PayrollYTDByYear` extension on Employee is a much smaller sim-side surface for the same observed behavior.

**Tradeoffs / consequences:**
- The first live exercise against a real QB Desktop must capture the actual `EmployeeWagesTaxesRet` wire shape — if QB emits per-employee data via a row-tree under `ReportData` (like P&L / BS), the sim's flat `EmployeeWagesTaxesRet[]` shape won't match and `extractReportData` will return `{}`. Fix: add a payroll-specific branch to `adaptLiveReportRet` (similar to the SCF route added with #54). The schema-order pin in `tests/builder-emit-order.test.ts` catches request-side bugs but cannot catch response-shape divergence.
- `PayrollYTDByYear` is a sim-only field that doesn't exist on real `EmployeeRet`. Anyone reading `Employee` records via `qb_employee_list` will see the field in sim and not in live — documented as a sim seed extension; not a contract that survives the live switch.
- Sim's seed is fixed at three employees with three state variants (IL, CO, TX). Tests that need a different state (e.g. CA with disability) can add a sim-side seed via `session.addEntity("Employee", {PayrollYTDByYear: {...}})`.
- `9004` is dispatched for both "no employees matched the entity filter" AND "no payroll data for the year". The tool emits a descriptive `statusMessage` that distinguishes the two paths (carries the employee filter when applied) — but the statusCode itself doesn't. Agents that branch on statusCode treat both the same (correct — both mean "no W-2 data to return").
- The `PayrollSummaryReportType` enum supported is exactly one value: `EmployeeWagesTaxesAdjustments`. Real QB exposes ~10 (PayrollLiability / PayrollItem / etc.) — those are explicitly out of scope and reject with 3120.

**Revisit when:**
- First live run reveals `EmployeeWagesTaxesRet` doesn't match the sim's flat shape — extend `adaptLiveReportRet` (or write a payroll-specific adapter) to translate the actual wire format.
- Operator needs per-payroll-item box mapping (box 12 codes, box 14 other, local taxes) — that's QB's W-2 wizard territory; the SDK doesn't expose the necessary metadata. Consider whether to bundle the YTD totals + a "consult W-2 wizard for full box detail" callout, or extend to additional `PayrollSummaryReportType` values.
- A live operator needs to drill from the W-2 summary to per-paycheck detail — `PayrollDetailReportQueryRq` is the SDK surface; would add as a paired `qb_w2_detail` tool the same way #49/#50/#52 paired summary + detail.

---

## 2026-05-12 — qb_attachment_* ships full Attachable surface with file-path validation at sim handler + tool layer

**Chosen:** Phase 12 #59 ships three new tools (`qb_attachment_add` / `qb_attachment_list` / `qb_attachment_delete`) wrapping `AttachableAddRq` / `AttachableQueryRq` (with new `ObjectFilter`) / `ListDelRq{ListDelType="Attachable"}`. Tool layer enforces absolute-path inputs (rejects relative paths upfront with 3120) and mutual-exclusivity on `txnId` / `listId`. Sim handler `handleAttachableAdd` validates the file path exists on disk via `fs.statSync`, validates the `ObjectRef` target exists by walking every store (skip Attachable itself), derives `FileName` / `FileSize` / `FileExtension` from the path, and synthesizes the `AttachableRet`. Generic `handleQuery` extended with an `ObjectFilter` branch (entity-type-agnostic) so AttachableQueryRq can scope by `ObjectRef.TxnID` / `ObjectRef.ListID`. Delete rides the existing generic `handleListDel` path (no Attachable-specific delete handler needed). Read-only gate composes through `session.addEntity` / `deleteEntity`'s `assertWritable`. Idempotency key on add rides `addEntityIdempotent`. No new sim seeds — the tool creates attachments per test.

**Why:**
- **Wire-surface novelty justifies the full plumbing.** Unlike #82 `qb_host_query` (no request body — generic builder works) or #54 `qb_statement_of_cash_flows` (rides `buildReportRequest`), Attachable has a unique request shape (`FileReference.FullPath` + `ObjectRef.{ListID|TxnID}` + `Note` + `ShowAsImage` + `AttachmentType`) AND a unique response shape (`AttachableRet` carries `FileName` / `FileSize` / `FileExtension` derived from disk, not echoed from input). A custom `handleAttachableAdd` is unavoidable.
- **File-path validation at the sim handler.** Real QB rejects an `AttachableAdd` whose source file doesn't exist with a 500-class error. Sim must mirror this so observers see the same failure mode in both modes — running tests against a wrong path should fail loudly in sim, not silently succeed and surface a confusing error only in live. The validation uses `fs.statSync` (synchronous so the handler stays synchronous; matches the rest of `processRequest`'s sync contract).
- **Absolute-path enforcement at the tool layer, not the sim.** A relative path resolved against the QB Desktop process's CWD is almost never what the operator intended. Catching it at the tool layer with a clear 3120 error beats letting `fs.statSync` resolve to "whatever happens to be in the QB process's working directory" — the failure mode is undefined and platform-dependent. Sim's `handleAttachableAdd` trusts what the tool sends.
- **ObjectFilter extends the GENERIC `handleQuery`, not a custom `handleAttachableQuery`.** ObjectFilter is conceptually parallel to EntityFilter (already in handleQuery) — both scope by a ref on the entity. Inlining the filter logic keeps the dispatch table simpler. Only Attachable carries an `ObjectRef` in this server's first cut; other entities are unaffected.
- **No new manager methods.** `addEntity` / `queryEntity` / `deleteEntity` already cover the three tool surfaces. Manager methods like `addAttachment` would be pure wrappers with no added value.
- **No new sim seeds.** Attachments are heavily test-fixture-shaped — each test creates the file + attachable it needs. Seeding a "default" attachable would force tests to filter it out or be aware of it, with no benefit.
- **ObjectType reverse-lookup on add.** The tool returns `AttachableRet.ObjectRef.{ObjectType, FullName}` derived from walking the stores. Real QB also surfaces `ObjectType` on the response (it's how the QB attachment UI knows whether to link to a transaction view vs a list entity view).

**Alternatives rejected:**
- **Defer file-path validation to live mode** (sim stores the path verbatim, doesn't check disk) — drops the sim/live observational equivalence. Tests would pass in sim with bogus paths and fail in live; that's the same anti-pattern the broader sim store explicitly avoids.
- **Single tool with `action: 'add'|'list'|'delete'`** — three distinct workflows; collapsing them into one tool with a discriminator hurts schema clarity and forces optional-everything in the args. The three-tool surface aligns with how the rest of the codebase models CRUD (every entity has separate `_add` / `_list` / `_delete` tools).
- **Allow file BYTES via base64 in the tool args** — would require QBXMLRP2 to accept binary uploads, which it doesn't. QB Desktop reads the file from disk during `ProcessRequest`. Forcing the operator to base64-encode + decode the file would be pure waste of tokens.
- **Skip `ObjectType` reverse-lookup on add** — the sim could just echo the input ObjectRef shape. But real QB DOES surface `ObjectType` (verified against the SDK reference) — sim should match for observational equivalence. Cheap to derive (walks stores anyway for validation).
- **Custom `handleAttachableQuery`** dispatch branch — adds a special case where the generic path already works with one small ObjectFilter extension. The extension is entity-type-agnostic and skipped silently for entities without ObjectRef.

**Tradeoffs / consequences:**
- The file path must be on the SAME MACHINE as QB Desktop (live mode) — QBXMLRP2 reads the file during `ProcessRequest`. For typical localQBD this is fine; hypothetical remote-mode setups would need a UNC path the QB process can read. Documented loudly on the tool surface.
- The "Attached Documents" feature is itself **edition-dependent** in real QB — some editions don't support it and `AttachableAddRq` fails at the wire. The tool surfaces that QB-side error through the standard error wrapper; we don't pre-flight gate on edition (unlike #55 W-2 which has a known Pro-only failure mode) because the failure pattern varies by QB version and would over-restrict working setups.
- `qb_attachment_list` returns METADATA only — actual file bytes live in QB's Attached Documents folder and are not exposed by the SDK at all. To export an attachment, the operator opens it through the QB Desktop UI; the SDK has no `AttachableGet` for retrieving the file contents.
- Sim doesn't COPY the source file anywhere. Sim mode tests that depend on file persistence (e.g. "open the attachment back up") would need to keep the source file alive; in real QB the operator's source file can be moved/deleted after upload because QB has its own copy. Documented on the tool surface.
- The `ObjectFilter` extension to `handleQuery` is currently only meaningful for Attachable — but the implementation is entity-type-agnostic, so any future entity type that adds `ObjectRef` will get the filter "for free". Low-risk forward-compat.

**Revisit when:**
- An operator needs to RETRIEVE the actual file bytes from QB through the MCP — that requires SDK surface QB doesn't expose; would need an out-of-band copy step from QB's Attached Documents folder (which the operator can do through the QB UI).
- Bulk-attach workflows surface — `qb_attachment_batch_add` would ride the multi-request envelope pattern (`executeBatchAdd` already entity-type-generic since #43); fits the same pattern as `qb_invoice_batch_create` / `qb_journal_entry_batch_create`. Defer until the operator hits the use case.
- Live-mode test reveals that `AttachableRet` carries fields beyond the seven sim emits (additional metadata, e.g. `Thumbnail`, `OriginalRequestID`) — extend `handleAttachableAdd` to propagate; trivial.

---

## 2026-05-12 — qb_host_query ships as a thin wrapper over queryEntity("Host", {}) with manager-level lazy caching

**Chosen:** Phase 18 #82 `qb_host_query` ships as a tool that calls a new `QBSessionManager.getHostInfo()` method, which delegates to `queryEntity("Host", {})` and caches the normalized result. Sim handling is the existing generic `handleQuery` path against a newly-seeded Host singleton — no dedicated `handleHostQuery` branch in `processRequest`. Cache is LAZILY populated (first call hits the wire; subsequent calls return the cache) — NOT eagerly populated on `openSession`. Cleared on `switchCompanyFile`. Derived `edition` enum + `isEnterprise` / `isAccountant` flags are the gating signal for downstream tools; `productName` is never to be parsed by tools directly.

**Why:**
- **`HostQueryRq` has no request body.** The generic `buildQueryRequest("Host", {})` emits exactly the correct envelope (`<HostQueryRq requestID="1"></HostQueryRq>`) — adding a dedicated `buildHostQueryRequest` builder would be pure duplication.
- **Sim's generic `handleQuery` works for Host because `HostRet` is structurally a singleton, like Company.** The existing Company-seeded pattern (single-entry Map under a sentinel key) extends one-to-one to Host. Adding a dedicated `handleHostQuery` branch would mean writing essentially the same code Code review preview.
- **Lazy caching beats eager on `openSession`.** The todo's "run on session connect" framing suggested eager — but that adds an unconditional wire round trip to every `openSession`, including for tools that never need Host info (which is most of them). Lazy gets the same caching benefit (one round trip per process), defers cost until needed, and surfaces wire errors at the tool layer where they can be reported cleanly rather than as session-open failures.
- **`switchCompanyFile` clear is defensive, not load-bearing.** Under QBXMLRP2 localQBD, the host (QB Desktop process) never changes across company-file switches. But a future remote-mode or hosted setup might, and the cost of re-querying is one round trip on a rare event. Cheap insurance against shipping stale edition info.
- **Derived `edition` enum centralizes the parsing logic.** Tools that gate on edition (#66 audit log = Enterprise, #55 W-2 = additionally needs payroll subscription) should not each re-derive edition from `productName`. The enum is a single source of truth that handles the awkward "QuickBooks Accountant Desktop" alias (= rebranded Premier Accountant).

**Alternatives rejected:**
- **Dedicated `handleHostQuery` branch in sim's `processRequest`.** Considered for "cleaner separation" between company-file entities (Customer/Vendor/Invoice/Company) and installation metadata (Host). Rejected — the generic path is strictly less code, the conceptual mixing is purely aesthetic, and switching to a dedicated branch later is a 5-LOC refactor if the need ever arises.
- **Eager `getHostInfo()` on `openSession`.** The todo phrased this as "run on session connect" — implementation-wise it would mean `await this.getHostInfo()` after a successful `openSession`. Rejected on latency grounds and because lazy with caching is observationally equivalent for any tool that calls Host-info-using paths.
- **Pre-built per-edition feature flags (`canRunAuditLog`, `canRunPayrollReports`).** Considered. Rejected — the edition-to-feature mapping is the downstream tool's responsibility (a payroll-gated tool also needs to probe subscription status, not just edition). The host-query tool should report what QB reports, not opine on what's available; downstream tools compose `edition` with their own subscription checks.
- **Polluting parser `arrayElements` with `"Version"` so live `SupportedQBXMLVersionList.Version` is always an array.** Rejected — `Version` is a too-generic name; it could conflict with future QBXML responses that use the same tag for unrelated semantics. The normalizer handles both string-or-array shapes locally.
- **Returning the raw HostRet shape (`MajorVersion`, `IsAutomaticLogin`) instead of camelCasing.** Rejected — the rest of this server's tool surface returns camelCased fields (`statusCode`, `companyFile`, `editSequence`); inconsistency here would be jarring. The normalizer also coerces `IsAutomaticLogin` from the possible string `"true"` / `"false"` forms (live parser produces these depending on `parseTagValue` config — defensive).

**Tradeoffs:**
- **Sim seed is fixed (`Premier Accountant Edition 2024` / `MajorVersion 34`).** Tools that gate on `edition === "Enterprise"` will always fail in sim mode. Acceptable — sim is for testing tool wiring, not for testing edition gating logic (which is a live-mode concern). If a future sim-mode test needs a different edition, it can seed a custom value via `session.peekHostInfoCache()`-replacing path or by adding a `setHostInfoForTesting` accessor.
- **Live verification is deferred.** The first live exercise will reveal the actual `ProductName` / `MajorVersion` / `SupportedQBXMLVersionList` QB returns. If the live response shape includes fields beyond the seven seeded (e.g. `Beta`, `IsHostedOnline`, additional installation flags), `normalizeHostInfo` silently drops them. Extending the `HostInfo` type and the normalizer to surface them is one-line work. Logged the same way the deferred #54 SCF verification is logged.
- **`maxQbxmlVersion` is derived numerically.** Lex compare would put `"9.0" > "16.0"` — the numeric-tuple compare handles this. If QB ever ships a version with non-numeric components (e.g. `"16.0-beta"`), `.split(".").map(Number)` would produce `NaN` and the compare would silently misorder. Acceptable for now (QBXML version numbers have been numeric for 20+ years); if it becomes an issue, switch to a real semver parse.

**Revisit when:**
- A new edition-gated tool ships and needs to compose `edition` with subscription state (#55 W-2 payroll, #66 audit log Enterprise gate). At that point, decide whether to expose a `gatesAllowed` map on the response or keep that logic in each downstream tool.
- Live verification reveals additional HostRet fields. Extend the `HostInfo` type + normalizer.
- A remote-mode or hosted QB setup is introduced. The "host doesn't change across switchCompanyFile" assumption may break; consider keying the cache on a richer (host, file) tuple.

---

## 2026-05-12 — Persistent QBXML wire logger (Phase 18 #83) hooks at the manager.sendRequest chokepoint

**Chosen:** A single `QbxmlLogger` module in [src/util/qbxml-logger.ts](src/util/qbxml-logger.ts), env-gated by `QB_DEBUG_QBXML=1`, accessed as a process-wide singleton through `getQbxmlLogger()`. Wired into [src/session/manager.ts](src/session/manager.ts) `sendRequest` — the single chokepoint that every QBXML envelope (live + sim) flows through. Writes paired `request` / `response` entries with a per-process monotonic `seq=N` so concurrent in-flight pairs are unambiguous. File name is date-stamped (`qbxml-YYYYMMDD.log`); date is recomputed per write so a long-running process rolls over at midnight without restart. Tag-regex redaction over `VendorTaxIdent` / `SSN` / `BankAccountNumber` / `CreditCardNumber` runs before write; first write failure latches `disabled=true` and stderr-warns once so a logging fault never poisons request flow.

**Why:**
- **One chokepoint, two modes for free.** `sendRequest` is the only method that touches QBXMLRP2 in live mode AND `SimulationStore.processRequest` in sim mode. Hooking there covers both with one diff — no per-tool / per-helper instrumentation, no risk of a future tool bypassing logging.
- **Direct unblock for the deferred Phase 11 #54 live verification.** Last session shipped `qb_statement_of_cash_flows` with best-guess live adapter labels that haven't been validated against a real QB Desktop SCF dump. The first live SCF run can now write the actual `TextRow` / `SubtotalRow` / `TotalRow` labels to disk for direct inspection — no rebuild + `console.error` loop, no transient stdout that gets swallowed by the MCP transport.
- **Same need surfaces for every future schema-order bug.** Phase 9 #37's P&L parse error was the same shape: live returned `statusCode -1` with no useful info; the only fix was to capture the wire bytes by adding `console.error` and rebuilding. A persistent log makes that diagnosis available without code changes.
- **Sim-mode logging is useful too.** Even in sim, debugging schema-order test fixtures or new sim handler branches benefits from seeing the exact envelope shape and the parsed-response JSON. Logging both modes uniformly is strictly more useful than gating it to live.

**Alternatives rejected:**
- **Per-tool logging hooks.** Considered — would let each tool decide what to log. Rejected because the failure modes that need logging are wire-level (schema order, raw response parse), not tool-level. Per-tool hooks would duplicate the log-format logic across 98 tools and almost certainly drift.
- **Async writes (`fs.promises.appendFile`).** Considered for throughput. Rejected because a synchronous `appendFileSync` per request is fast enough for the operator's typical request volume (10s/min, not 1000s/sec), AND ensures the envelope is on disk before the next line of code runs — so a request that crashes after send still leaves its envelope to inspect.
- **Structured log format (JSONL).** Considered. Rejected because the primary consumer is a human reading the file in an editor — wrapping the XML in JSON string escaping makes the XML painful to read. The current `=== header ===` + raw body block is grep-friendly AND copyable into a QBXML validator.
- **Log everywhere (every helper, every transformer).** Rejected — would 10x the log volume with no diagnostic value. The bug class that needs logging lives in the request/response pair, not in intermediate transformations.
- **Include ALL personally-identifying fields in the redaction list** (e.g. `Phone`, `Email`, `Address1`, customer `FullName`). Rejected — overbroad scope makes the log less useful for debugging without meaningfully improving safety. The conservative four-field list covers actual credentials (TIN, SSN, bank account, card number) without obscuring the legitimate debugging signal. Easy to extend if a new sensitive field is discovered.
- **Detect rollover via filesystem mtime / stat.** Rejected for the date-comparison approach — recomputing the date string on every write is one `Date.prototype.toISOString()` call (microseconds) versus a stat syscall (milliseconds). The cached `currentDate` short-circuit means real cost is only paid once per day.

**Tradeoffs:**
- **Redaction is regex-based, not parse-based.** A malformed QBXML envelope where `<VendorTaxIdent>` spans a line break or is inside a CDATA section would not be redacted. Acceptable — the envelope builder always produces well-formed single-line tags for these fields, and the worst case is a sensitive value leaking into a debug log that the operator can rm.
- **Sim mode response is JSON-serialized, not raw XML.** The sim store never produces raw XML — it goes parsed-shape directly. The JSON output is still useful for inspection but isn't byte-for-byte what live would emit. Acceptable — sim debugging is rarely about wire bytes.
- **Process-wide seq counter doesn't reset across QB sessions.** If the operator does qb_session_disconnect / qb_session_connect mid-process, seq numbers continue incrementing rather than restarting at 1. Considered a feature — global ordering is what a forensic reader actually wants.
- **Concurrent writes from a single process are atomic at the appendFileSync syscall level.** If a future change introduces true multi-process MCP serving (not on the roadmap), the log file could interleave. Document if/when that happens.

**Revisit when:**
- A new sensitive field type is added to the QBXML SDK (e.g. routing-number, employee bank account). Append to `SENSITIVE_TAGS` in [src/util/qbxml-logger.ts](src/util/qbxml-logger.ts) and add a redaction test.
- Log volume becomes a problem (rare — typical day is < 1MB of logs). At that point add a size cap + rotate-by-size in addition to rotate-by-date.
- A multi-process MCP serving model is introduced. The single-process-atomic-append assumption breaks.

---

## 2026-05-12 — qb_statement_of_cash_flows ships sim-side + live adapter verified-by-construction

**Chosen:** Phase 11 #54 `qb_statement_of_cash_flows` ships in one session with: (a) full sim handler implementing a narrower indirect-method model (Operating = NetIncome + ΔAR + ΔAP only; Investing = period postings to FixedAsset+OtherAsset; Financing = period postings to LongTermLiability+Equity), (b) live adapter that detects QB's SCF section labels (`OPERATING/INVESTING/FINANCING Activities` plus the `Cash from/provided by` variants) and routes through `adaptLiveReportRet`'s existing section-based row-tree walker with SCF-specific close-label patterns, (c) tool surface + tests + schema-order pin, all without first live-validating against a real QB Desktop SCF dump.

**Why:**
- **The HANDOFF's "verify live shape first" caveat was conservative but unblockable in-session.** No Windows + QB Desktop available; the operator would have had to capture an SCF dump and feed it back. That's a multi-session round-trip that blocks shipping the sim + tool work that would have to happen anyway.
- **The structural pattern is already proven.** The PnL/BS section walker in `adaptLiveReportRet` is the same algorithm: TextRow opens section, DataRow inside is a leaf account, SubtotalRow/TotalRow closes section. SCF differs only in (1) section labels and (2) close-label patterns ("Net cash provided by X" vs "Total X"). Both extensions are localized, additive, and easy to fix if the live capture surfaces a variant the map doesn't cover.
- **Sim handler is necessary regardless.** Even with a perfect live adapter, the simulation needs an SCF implementation so every other test that exercises the report subsystem (sim CRUD round-trip, idempotency, etc.) doesn't break with an empty payload. The sim-side work is the bulk of the implementation.
- **The narrower indirect-method model is a known sim-fidelity tradeoff, not a bug.** Real QB pulls inventory changes, prepaid asset changes, accrued liability changes, and depreciation add-back from JE postings to a Depreciation Expense account. The sim's narrower walk is documented loudly in the tool description and DECISIONS.md; for accurate cash-flow numbers operators run against live QB.
- **CashAtBeginningOfPeriod is derived, not observed.** The sim has only `Account.Balance` as a snapshot — no historical series to back-calculate `Bank.Balance` at the start of the period from. The derived form `CashAtBeginningOfPeriod = CashAtEnd − NetCashIncrease` reconciles totals by construction. In live mode QB computes both independently and the two should agree (modulo the indirect-method math being non-trivial to externally verify).

**Alternatives rejected:**
- **Block on live verification.** Defers the sim handler, tool surface, and test coverage to a future session. The sim work is independent of the live adapter — sim CRUD and tests don't care what QB's actual SCF row labels look like — so blocking gains nothing.
- **Skip the live adapter entirely.** The flat-summary fork (Phase 11 #49) would have fired for SCF in the absence of section detection, producing a single-section "Sales" payload — actively wrong. The new `isScf` detection branch + section-based walker is required.
- **Add a separate `adaptLiveScfReportRet` function.** Considered. Rejected because the existing P&L/BS walker is 95% reusable — the only SCF-specific bits are the section name map and close-label list, both small enough to inline.
- **Use the direct method (cash inflows from customers / cash outflows to vendors / etc.) in sim.** Rejected because real QB defaults to indirect method (Net Income + adjustments) — the operator's expectation is indirect, and a direct-method sim would diverge from live in shape, not just precision.

**Tradeoffs:**
- **Live adapter label variants are best-guess from QBXML SDK reference docs.** The HANDOFF "verify before continuing" check on the next session covers this — first live SCF run against `VR Tax & Consulting Inc..qbw` should capture actual TextRow / SubtotalRow / TotalRow labels and, if they diverge from the seeded variants in `CASH_FLOWS_SECTION_NAMES`, extend the map or the close-label patterns to match. Same pattern Phase 9 #37 followed for P&L (initial shape was wrong, live capture surfaced the schema-order + row-tree fixes).
- **Sim Operating section misses inventory/prepaid/accrued/depreciation.** Operator running SCF in sim mode against a seeded inventory chart won't see those adjustments. Documented on the tool surface and acceptable for a personal tool whose primary mode is live.
- **Sim's `cashAtBeginningOfPeriod` is non-observable.** Derived from `cashAtEnd − netCashIncrease`. Reconciles by construction but doesn't reflect what `Bank.Balance` actually was at the start of the period (the sim doesn't track that). Live mode is the authoritative source for beginning-of-period cash.
- **No JE-to-Equity for Net Income closure.** The sim doesn't run year-end close, so Net Income closure to Retained Earnings never appears as an Equity-section JE — the period NetIncome stays in Operating's first row. This matches QB's actual SCF behavior (Net Income is the starting line of the indirect method, not a financing entry), so it's accurate-by-construction.

---

## 2026-05-11 — qb_invoice_write_off ships via ReceivePayment + Discount, NOT CreditMemo + apply

**Chosen:** Ship Phase 12 #57 `qb_invoice_write_off(txnId, writeOffAccount, …)` as a single-call composite that submits a $0 `ReceivePayment` whose `AppliedToTxnAdd` carries `PaymentAmount=0 + DiscountAmount=writeOffAmount + DiscountAccountRef={FullName: writeOffAccount}`. Single QBXML envelope. The operator's `writeOffAccount` arg maps directly to `DiscountAccountRef.FullName` — no item indirection.

**Why:**
- **Matches the operator's spec exactly.** The todo.md entry literally said `qb_invoice_write_off(txnId, writeOffAccount, memo)` with an **account name**, not an item name. The ReceivePayment + Discount path is the only QB SDK primitive that accepts a write-off account directly. The CreditMemo path would require the operator (or the tool) to look up a "Bad Debt" Item that points at the write-off account — a forced indirection because real QB's `CreditMemoLineAdd` schema requires `ItemRef`, not `AccountRef`.
- **Atomic; no compensating delete needed.** Single QBXML envelope (the underlying ReceivePaymentAddRq). If the apply fails, QB rolls back the whole thing. Contrast with a CreditMemo path that would create a CM and then re-apply it via `CreditMemoMod` — two write operations needing the #43 batch-style compensating-delete pattern.
- **Same mechanism QB Desktop uses internally.** QB's "Discounts and Credits" dialog on the Receive Payments form is exactly this wire shape. The operator's `qb_invoice_write_off` is a single-call equivalent of that UI flow.
- **No new wire types, no schema-order risk.** The tool composes over existing primitives (`queryEntity("Invoice", { TxnID })` + `addEntity("ReceivePayment", …)`). Both run cleanly in live mode today.

**Alternatives rejected:**
- **CreditMemo + AppliedToTxnAdd path** — would need a "Bad Debt" Other Charge item pre-existing in the operator's file with `IncomeAccountRef` (or `SalesOrPurchase.AccountRef`) pointing at the write-off account. Surfaces the item indirection to the operator — the spec said `writeOffAccount`, not `writeOffItem`. Also: CreditMemo creation moves Customer.Balance by `-TotalAmount` at memo-add time (Customer balance correctly drops), but the bookkeeping involves two transactions on the customer ledger (the CM and the apply) where ReceivePayment + Discount produces just one (the $0 payment with the discount line). Cleaner audit trail with ReceivePayment.
- **Generic JournalEntry** debiting the write-off account and crediting AR — would close the AR-side posting but wouldn't naturally apply against the specific invoice's `BalanceRemaining`. The invoice would still appear open in AR aging, just with an offsetting JE. Wrong shape for the operator's actual workflow ("write off this invoice").
- **Two-step compose (qb_credit_memo_create + qb_credit_memo_apply)** — the todo's literal description ("currently requires create credit memo + qb_credit_memo_apply, two calls plus the editSequence dance"). The operator's pain point IS the multi-call dance; the right answer is a single-call tool that doesn't require any precondition (like a "Bad Debt" item) the operator might not have set up.

**Tradeoffs / consequences:**
- **Required a sim correctness fix on the AR side.** `applyTxnApplications` previously moved `Customer.Balance` by `appliedSum` only (the PaymentAmount portion), so a discount-close left `sum(invoice.BalanceRemaining for customer) ≠ Customer.Balance`. The original comment claimed this was intentional ("the customer didn't pay it — they got it") but that's wrong accounting — Customer.Balance represents total open AR, and a discount-close reduces it. Fixed both `applyTxnApplications` and `reverseReceivePaymentApplication` to use `appliedSum + discountSum`. Symmetric, strict improvement. No existing test pinned the broken behavior; 2 new regression tests in [tests/invoice-write-off.test.ts](tests/invoice-write-off.test.ts) Layer 5 pin the corrected behavior on both forward (qb_payment_receive with discount) and reverse (qb_payment_apply with empty applyTo) paths.
- **AP-side `applyBillPayment` has the parallel inconsistency on `Vendor.Balance` — left in place.** Out of scope for #57 (no AP write-off tool shipped). A future `qb_bill_write_off` would need the symmetric fix in `applyBillPayment` + `reverseBillPaymentApplication`. Flagged in this entry so the next agent doesn't re-debate.
- **Idempotency-replay required a new `session.peekIdempotencyEntry` accessor.** Unlike `qb_invoice_duplicate` (which doesn't mutate its source), write-off closes the source invoice on first call — so a naive replay through `addEntityIdempotent` would fail the tool's "still open" check before reaching the fingerprint. The peek lets the tool detect "cache hit for this key" up front and relax stale-state validation; the cached `DiscountAmount` is then pulled in as the `writeOffAmount` default so the rebuilt payload fingerprint-matches. Generic primitive on `QBSessionManager` — usable by any future tool that mutates its source.
- **Adjacent manager bug fix:** `manager.deleteEntity`'s `isTransaction` list was stale — had `"Payment"` instead of `"ReceivePayment"`, missing CC / Deposit / Transfer / Check / etc. (drifted from the canonical list in `buildDeleteRequest`). CLAUDE.md's stable-conventions list explicitly calls these arrays out as needing to stay in sync. Fixed; pre-existing bug that would surface on any `session.deleteEntity("ReceivePayment", …)` call (the response would route to `ListDelRs` extraction instead of `TxnDelRs` and the parser would throw `Unknown QBXML error`). No existing test pinned the broken behavior because nothing in the suite deleted a ReceivePayment before this work.
- **Tool count 91 → 92.** 17 new tests (579 → 596).

**Revisit when:** a `qb_bill_write_off` tool is added — that's when the AP-side `applyBillPayment` / `reverseBillPaymentApplication` discount-balance bug becomes load-bearing and needs the parallel fix.

---

## 2026-05-11 — Phase 11 #48 + #51 ship as a composite over typed entity queries, NOT TransactionQueryRq

**Chosen:** Ship `qb_customer_balance_detail` (#48) and `qb_vendor_balance_detail` (#51) as a composite over `InvoiceQueryRq` / `ReceivePaymentQueryRq` / `CreditMemoQueryRq` (customer side) and `BillQueryRq` / `BillPaymentCheckQueryRq` / `BillPaymentCreditCardQueryRq` (vendor side) — three round trips per tool regardless of customer/vendor count, grouping in-process by entity FullName, with running-balance math from a shared `buildEntityBalanceSection` helper (mirror of `buildGeneralLedgerSection`). No new wire request types, no new builder/parser surface — the sole source-modification at the QBXML layer is a `extractOriginalTxnAmount(txn, txnType)` helper that handles Bill's outlier line-walk extraction.

**Why:**
- **TransactionQueryRq's sim handler doesn't surface AR/AP counter-postings.** The HANDOFF originally suggested "fan out TransactionQueryRq per customer/vendor + running-balance walk client-side" but that path is broken in the simulation: `handleTransactionQuery` requires `AccountFilter` and emits LINE-LEVEL postings only — the implicit AR/AP counter-postings (the actual AR/AP balance movement) are not materialized. Filtering by `AccountFilter=AccountsReceivable` in sim returns empty even when invoices exist. This limitation is documented loudly at [src/session/simulation-store.ts:1373-1378](src/session/simulation-store.ts#L1373-L1378). Composite over typed entity queries (the `qb_ar_aging` / `qb_ap_aging` pattern) reaches the AR/AP posting directly via `Invoice.Subtotal+SalesTaxTotal` / `ReceivePayment.TotalAmount` / `CreditMemo.TotalAmount` without needing the counter-posting to be materialized.
- **3 round trips ≪ N round trips at scale.** A 2,000-client practice hitting the original HANDOFF design (per-customer fanout) would take 100+ seconds at typical QBXMLRP2 latency. Composite collapses to ≤3 round trips total regardless of customer count; `EntityFilter` is only passed when the operator scopes to one customer.
- **Bill outlier on amount extraction is the only real complication.** `Bill.AmountDue` is decremented on every bill payment, so a fully-paid bill reports `AmountDue=0`. The HANDOFF's "use AmountDue" suggestion would surface fully-paid bills with zero face value in the report — wrong by definition. `extractOriginalTxnAmount` walks `ExpenseLineRet + ItemLineRet` for Bill specifically (other transaction types use their stable header total fields). Pinned by the test "Bill paid in full still surfaces its original face value (AmountDue=0 is irrelevant)" in [tests/vendor-balance-detail.test.ts](tests/vendor-balance-detail.test.ts).
- **Same composite pattern as #53 `qb_general_ledger`.** Reuses verified primitives (typed entity queries) that already work cleanly in live mode. Zero new schema-order risk; no new builder/parser/adapter surface to maintain. The sole new wire-touching detail is that `qb_vendor_balance_detail` passes `IncludeLineItems: true` on its `BillQueryRq` (lines are stripped by default since Phase 10 #41 and the line walk needs them) — pinned by the existing `BillQueryRq: IncludeLineItems sits at the tail after PaidStatus` test.

Sim limitation carried forward: `EntityFilter` matching in the sim's `handleQuery` checks `ref.ListID === target` directly, but stored `CustomerRef` / `VendorRef` on entities added via `addEntity` with only `FullName` don't have ListID hydrated. The tool canonicalizes `customerListId` / `vendorListId` → `FullName` (taken from the already-fetched entity record) before populating `EntityFilter`, so matching is robust in both sim and live regardless of how the stored ref was created. Documented inline at the filter-construction site.

**Alternatives rejected:**
- **`CustomerBalanceDetailReportQueryRq` / `VendorBalanceDetailReportQueryRq` as a new wire type** (the literal report names in the QBXML SDK) — would require new builder + parser-adapter + sim-handler surface, plus a schema-order pin in `tests/builder-emit-order.test.ts`. Composite over typed queries achieves the same output with zero new wire surface and the same row shape the operator wants. The literal wire request remains available for a future "stricter mirror of QB's report" if needed; for the practical use case (auditing customer balances, finding stuck invoices), composite is structurally indistinguishable.
- **TransactionQueryRq fan-out per customer/vendor with AccountFilter=AccountsReceivable** (the HANDOFF's literal recommendation) — breaks in sim per the LINE-LEVEL limitation above, and even in live mode the per-customer fanout is N+1 round trips. Documented in the rejected-alternatives list rather than re-debated next session.
- **Including JournalEntry postings to AR/AP** — JE lines DO have an optional `EntityRef` (real QB), but the sim doesn't populate it consistently on test fixtures, and a JE that debits AR for customer X without specifying X on the line wouldn't be attributable. The accurate, robust behavior is to exclude JE entirely from the customer/vendor walk and surface them via `qb_transaction_list_by_account` on the AR/AP account directly (which IS the right tool for the "what JEs hit AR this month" question). Limitation documented loudly on the tool description.
- **Including VendorCredit on the vendor side** — no `VendorCredit*` tool exists in this server's first cut, and the entity type isn't part of the sim's stores. Documented as a limitation rather than implementing the missing surface (Phase 12 follow-up if the operator asks).

**Tradeoffs / consequences:**
- 2 new tools (count 89 → 91), 42 new tests (537 → 579 passing). Tool surface for the "who owes us / who do we owe" drilldown is now complete on both sides; together with `qb_general_ledger` it covers the entire balance-detail surface QB Desktop exposes via the GUI.
- Empty-section pruning is the default behavior. Customers/vendors with no activity in the window AND zero opening+closing balance are dropped silently; `includeZeroBalance: true` keeps them. Customers/vendors with no in-window activity but a non-zero opening balance (e.g. TechStart with seed Balance 3200) DO surface — opening = closing, periodChange = 0, transactions = []. Matches QB's actual report (it doesn't surface customers with neither activity nor balance).
- New helper exports (`buildEntityBalanceSection`, `extractOriginalTxnAmount`) are public on `src/tools/reports.ts` so unit tests can exercise the math without an MCP transport. Same export discipline as `buildGeneralLedgerSection` from #53 and `buildBalanceSummary` from #38.

**Revisit when:** the operator hits a workflow that needs JE-on-AR / VendorCredit / multi-entity JE attribution. The composite design accepts new entity types cheaply (just extend the txn-type walks in the two tools' handlers); the structural separation between header-amount entities and the Bill line-walk outlier survives that growth.

---

## 2026-05-11 — Phase 11 #50 + #52 mirror #49 and surface a latent CreditCardCharge transaction-type gap

**Chosen:** Ship `qb_sales_by_item_*` (#50) and `qb_expense_by_vendor_*` (#52) as parallel structural mirrors of the #49 `qb_sales_by_customer_*` pair — same `GeneralSummaryReportQueryRq` / `GeneralDetailReportQueryRq` infrastructure, same sim handler shape, same tool-surface shape. Each summary handler is a ~20 LOC closure over the existing line walks; each detail handler is a ~30 LOC variant of `buildSalesByCustomerDetail`. The "by-X" sub-family closes out cleanly with one decision template instead of four ad-hoc ones.

Adjacent fix forced by #52: added `CreditCardCharge` + `CreditCardCredit` to `isTransactionType` in `simulation-store.ts` and to the parallel `isTransaction` array in `builder.ts`. The omission was a pre-existing inconsistency — both types ARE in `BANK_AFFECTING_TXN_TYPES` and ARE used by the reconciliation tools, but `isTransactionType` returning false silently disabled `convertLinesAddToRet` for them. The reports walk `*LineRet`, so the bug stayed latent until #52's `qb_expense_by_vendor_*` walk needed the converted lines and surfaced the gap via a failing test. CLAUDE.md's transaction-entities list updated to match. No existing tests broke (reconciliation tests already consumed CC charges through report wire shape, not direct property access).

**Why:**
- **Mirror beats reuse.** Both #50 and #52 are structurally analogous to #49 — the sim handler is mostly key-name swaps (`CustomerRef.FullName` → `ItemRef.FullName`, walks Invoice/SR/CM → walks Bill/Check/CCCharge). Factoring a shared abstraction across the three pairs would obscure the per-pair sign conventions (CreditMemo subtracts on sales; no analog on expenses) without saving meaningful code. Each ~50 LOC pair is small enough to read inline.
- **Wire infrastructure was already paid for.** #49 landed `GeneralDetailReportQueryRq` end-to-end (builder + parser + manager method + sim dispatch + flat-summary live adapter for the summary side). Adding `SalesByItemDetail` + `ExpensesByVendorDetail` to the supported-set was a 3-line whitelist change plus the new builder methods. `buildReportRequest` gained an optional `itemFilter` arg that emits `ReportItemFilter` between `ReportEntityFilter` and `SummarizeColumnsBy` — same schema-position pattern as #49's `entityFilter` extension. Pinned in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts).
- **CreditCardCharge fix is in scope.** The fix is one-line; not fixing it would have required either narrowing the report scope (drop CC support — diminishes the report's value) or special-casing `ExpenseLineAdd`-vs-`ExpenseLineRet` lookups in just my new walk (introduces an inconsistency in the line-key contract that the rest of the codebase relies on). Fixing the root cause is cheaper than working around it, and brings the codebase to a more consistent state.

**Alternatives rejected:**
- Shared "by-entity-X" helper across #49/#50/#52 — adds an abstraction with three call sites that hide more than they reveal. The grouping key (`CustomerRef.FullName` vs `ItemRef.FullName` vs `txn-level VendorRef/PayeeEntityRef`) and the source stores (Invoice+SR+CM vs Bill+Check+CCCharge) diverge enough that a unified walker would need 4+ branching dimensions.
- Account-type-filtered expense walk for #52 (match real QB's actual `ExpensesByVendor` behavior which scopes to Expense/COGS/OtherExpense postings) — would require a name→AccountType lookup on every line; opted for the simpler "sum every line.Amount" pattern that #49 uses on the sales side, with the caveat documented loudly on the tool surface and in the README. Live mode goes through real QB, which applies the AccountType filter itself; sim is the simpler version.
- Working around the `CreditCardCharge` transaction-type gap locally in my new walk (read both `ExpenseLineAdd` AND `ExpenseLineRet`) — preserves the existing inconsistency, fragments the line-key contract.

**Tradeoffs / consequences:**
- 4 new tools (count 85 → 89), 33 new tests (504 → 537 passing). Tool surface for "operator's monthly review" is now substantively complete for the sales/expense slice.
- Sim's CreditCardCharge entities now carry a `TxnID` field (not `ListID`) and go through `convertLinesAddToRet` + `computeTotals`. This is observationally identical to what the live wire emits — both `Check` and `CreditCardCharge` carry `TxnID` in QBXML — so live consumers see no change. Any in-sim test that relied on `entity.ListID` for a CC entity would break (none exist as of this writing).
- `qb_pnl_report` and `qb_balance_summary` in sim get more-accurate CC expense walking too (the existing `walkTxnLines("CreditCardCharge", ["ExpenseLineRet","ItemLineRet"], "expense")` path was previously silently empty for sim-seeded CC txns). This is a strict improvement.
- New "flat-summary" live adapter from #49 handles `SalesByItemSummary` + `ExpensesByVendorSummary` for free (the adapter triggers on absence of P&L/BS section labels, not on report-type-specific signals).
- Live-mode validation for the new detail variants is still pending (same caveat as #49 — verified-by-construction structurally, not yet QBXMLRP2-validated). Documented on each tool's description.

**Revisit when:**
- Phase 11 detail variants for `CustomerBalanceDetail` / `VendorBalanceDetail` / `StatementOfCashFlows` land (#48, #51, #54). Those have different aggregation shapes (open balance walk per entity rather than line aggregation) and may not fit this mirror pattern cleanly.
- First live QBXML run against the new detail reports against a real `.qbw` — if `statusCode -1` surfaces, the fix is a child-order tweak in `buildGeneralDetailReportRequest` (same class as the 2026-05-09 P&L bug); the schema-order pin in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts) makes the regression source unambiguous.

---

## 2026-05-10 — Phase 11 #49 (`qb_sales_by_customer_summary` + `qb_sales_by_customer_detail`) ships the GeneralDetailReportQueryRq wire infrastructure

**Chosen:** Land Phase 11 #49 as a paired delivery — `qb_sales_by_customer_summary` extends the existing `GeneralSummaryReportQueryRq` path (sim whitelist + ReportEntityFilter wire-side + flat-summary live adapter), and `qb_sales_by_customer_detail` introduces the new `GeneralDetailReportQueryRq` wire request end-to-end (builder + parser branch + adapter reuse + sim handler + manager method + dispatch). Tool count 83 → 85. The infrastructure scaffolding amortizes over the planned #50/#52/#54 sales/expense detail variants — each future detail tool plugs in as ~50 LOC of sim-handler branch + tool wrapper.

**Why:** Three reasons.

1. **The HANDOFF's pair-up suggestion was the right one.** The carry-forward note said "landing two detail variants in one session amortizes the builder/parser/sim-handler cost properly." A summary + detail pair for the SAME domain (customer) maximizes the test reuse and shares fixture setup. Sales-by-customer is the first natural pair because the income-side line walk (`Invoice` + `SalesReceipt` − `CreditMemo`) is the simplest aggregation in the report family and the customer-scoping shape (`ReportEntityFilter`) is reused by the per-vendor / per-item variants. Landing two unrelated detail variants in parallel (e.g. sales-by-item + expenses-by-vendor) would have required two distinct sim aggregations without enough test reuse to amortize the cost.

2. **`GeneralDetailReportType` is a separate SDK enum from `CustomDetailReportType`.** Per the #53 lesson — `SalesByCustomerDetail` is NOT a valid `CustomDetailReportType` enum value. Trying to compose the new detail tool on the existing `CustomDetailReportQueryRq` infrastructure would have returned statusCode 3120 from live QB. The proper wire request is structurally similar (ColDesc + ReportData row-tree on the response) but goes through a different envelope — so the builder/parser/dispatch is new but the response-shape adapter (`adaptLiveCustomDetailReportRet`) is reused as-is.

3. **The summary half couldn't ride entirely on the existing `runReport` shape.** Live wire shape for `SalesByCustomerSummary` is a flat DataRow list with no section TextRows — the existing `adaptLiveReportRet` (which detects PnL/BS by section labels) would have returned empty Sections. A new "flat-summary" fork was needed in the adapter: when neither PnL nor BS labels appear in the timeline AND there is actual data, synthesize a single section named by the report's natural domain ("Sales" for SalesByCustomerSummary), walk every DataRow as a customer entry, and surface the closing TOTAL row as `Totals.TotalSales`. An empty-data short-circuit preserves the prior `Sections: []` contract for status-1 / no-data responses (this was the regression caught by the existing `report-adapter.test.ts` defensive case).

**Implementation:**

- **Summary half (existing wire path, extended):**
  - `buildReportRequest` gains an optional `entityFilter: { FullName?, ListID? }` arg — emitted between `ReportPeriod` and `SummarizeColumnsBy` per the schema. Pinned in `tests/builder-emit-order.test.ts`. P&L / BS callers that don't pass entityFilter get the original wire shape unchanged.
  - Sim `handleReportQuery` whitelists `SalesByCustomerSummary` and dispatches to a new `buildSalesByCustomerSummary(from, to, basis, customerFilter)` method. The walker fans across `Invoice` + `SalesReceipt` + `CreditMemo` line stores, sums `line.Amount` by `CustomerRef.FullName` on the parent txn, and emits the same `{ReportTitle, Sections: [{Name:"Sales", Accounts, Subtotal}], Totals: {TotalSales}}` shape the live flat-summary adapter produces. CreditMemo lines subtract (matches QB).
  - Live adapter gets the flat-summary fork described above. Detection is locale-stable: it triggers only when neither `PNL_SECTION_NAMES` nor `BS_SECTION_NAMES` appears in TextRows AND the timeline has data rows.

- **Detail half (new wire path):**
  - `buildGeneralDetailReportRequest` — new builder. Emits `GeneralDetailReportType` → `ReportPeriod` → `ReportAccountFilter` → `ReportEntityFilter` → `ReportItemFilter` → `ReportModifiedDateRangeFilter` → `ReportBasis` → `IncludeColumn`. Schema order inferred from QBXML 16.0 patterns (consistent with `GeneralSummary` + `CustomDetail` builders) and pinned in `tests/builder-emit-order.test.ts`.
  - `extractGeneralDetailReportData` — new parser export. Delegates to `adaptLiveCustomDetailReportRet` for the live row-tree → `{Columns, Rows}` translation (the wire shape is structurally identical to CustomDetailReport — same ColDesc + ReportData tree). Returns sim's native `{Columns, Rows}` unchanged.
  - Sim `handleGeneralDetailReportQuery` — new method. Currently handles `SalesByCustomerDetail` only; unsupported report types return statusCode 3120 with an explicit "implemented in simulation" message so the handler shell is in place for future variants. Walker fans across `Invoice` + `SalesReceipt` + `CreditMemo` line stores, emits one row per line with `TxnType` / `Date` / `Num` / `Name` / `Memo` / `Item` / `Quantity` / `Rate` / `Account` (income from line resolution) / `Amount` / `TxnID`. CreditMemo rows emit with `Amount` sign-flipped (negative) so the running sum matches QB. Sort: Customer (alpha) → Date (asc) → TxnID (stable).
  - `processRequest` dispatch gets a `key === "GeneralDetailReportQueryRq"` branch BEFORE the `endsWith("QueryRq")` catch-all. Same pattern as `CustomDetailReportQueryRq` (which has the same precedence requirement).
  - `QBSessionManager.runGeneralDetailReport(params)` — new method mirroring `runCustomDetailReport`. Tool-side use only; not surfaced as a public read primitive.

- **Tool surface:**
  - `qb_sales_by_customer_summary({fromDate?, toDate?, customerName?, customerListId?, basis?})` — flattens the synthesized "Sales" section into a plain `customers: [{customerName, total}]` list at the tool boundary. Surfaces `customerCount`, `totalSales`, `reportPeriod`. Customer scope (name takes precedence over ListID) passes through as `ReportEntityFilter`.
  - `qb_sales_by_customer_detail({fromDate?, toDate?, customerName?, customerListId?, basis?})` — returns `rowCount`, `totalAmount` (aggregated client-side from the rows), `columns` metadata, and the raw `rows` array. Same customer-scoping semantics.

- **Tests (29 new):** five layers — sim summary handler (6), sim detail handler (6), live flat-summary adapter (5), tool surface summary (4), tool surface detail (6) + 2 schema-order pins in `builder-emit-order.test.ts`. 504/504 tests green.

**Alternatives rejected:**

- **Ship sales-by-customer summary ALONE.** The HANDOFF was explicit that landing two together amortizes the wire-level cost. Shipping summary alone would have left the `GeneralDetailReportQueryRq` infrastructure unbuilt — every future detail variant (#50/#52/#54) would re-pay the full schema-order-risk + adapter-design cost. Pairing them halves that.
- **Ship sales-by-customer + sales-by-item simultaneously.** Tempting because both share the income-line walk; rejected because the item walker would need a separate aggregation method, separate sim handler branch, and separate test fixtures — too much surface area for one PR. #50 (sales-by-item) is now ~half-day work on top of this infrastructure.
- **Extend the existing `runReport` path to support detail reports too** (e.g. dispatch by report-type prefix). Rejected — `GeneralSummaryReportQueryRq` and `GeneralDetailReportQueryRq` are separate envelopes with different child sequences. Trying to flow both through `runReport` would have required a wrapper that toggles envelopes by report-type string, with risk that future schema changes diverge the two. Keeping them as distinct methods (`runReport` for GeneralSummary, `runGeneralDetailReport` for GeneralDetail, `runCustomDetailReport` for CustomDetail) matches the SDK's actual structure and keeps each method's contract narrow.
- **Skip the flat-summary live adapter; document live-mode as best-effort.** Rejected because the operator's primary use case for these reports IS live mode (the simulation has no real sales data — the operator is asking about VR Tax & Consulting's actual books). A live adapter that silently returns empty Sections would have been worse UX than no live support at all.

**Tradeoffs / consequences:**

- **`adaptLiveReportRet` is now a three-way dispatch (P&L / BS / flat-summary).** The flat-summary fork is gated by "no canonical section labels detected AND timeline has data" so it doesn't trigger on empty P&L responses (regression-pinned). New defensive test confirms P&L with an Income TextRow still routes to the P&L branch.
- **Detail-report live shape uses the same adapter as CustomDetailReport.** Verified by-construction — same ColDesc + ReportData row-tree on the wire — but not yet live-validated against a real QB Desktop. If QBXMLRP2 surfaces `statusCode -1`, the fix is in `buildGeneralDetailReportRequest` (child-order tweak). The tool description documents this caveat.
- **`buildSalesByCustomerSummary` sums `line.Amount`, not txn-level `TotalAmount`.** This matches QB's actual SalesByCustomerSummary report (which sums only the sales-line amounts, excluding sales tax). A future caveat for sales-tax-bearing line patterns: if QB ever introduces a hybrid line that contributes to both, this would need re-evaluation. Currently safe — the sim handles sales-tax through a separate AppliedToTxn path, not through line.Amount.
- **`GeneralDetailReportQueryRq` is now a known-good wire request.** Phase 11 #50/#52/#54 should plug into the existing infrastructure rather than re-paying the build/parse/dispatch cost. Each future variant is ~50 LOC of sim-handler branch (new aggregation walker) + ~40 LOC of tool wrapper + tests.

**Revisit when:** A future report tool surfaces `GeneralDetailReportType` validation issues against live QBXMLRP2 (statusCode -1). Most likely cause would be the inferred schema position of `ReportAccountFilter` / `ReportEntityFilter` / `ReportItemFilter` not matching the actual XSD `<xs:sequence>`. Pinned in `tests/builder-emit-order.test.ts` so the regression source is unambiguous when fixing.

---

## 2026-05-10 — `qb_general_ledger` shipped as composite over TransactionQueryRq + AccountQueryRq, not as a new wire type

**Chosen:** Ship Phase 11 #53 (`qb_general_ledger`) as a **composite tool** that orchestrates the existing `TransactionQueryRq` + `AccountQueryRq` primitives — N round trips for N matching accounts in live mode — rather than as a single-envelope `GeneralDetailReportQueryRq` (or any variant of the new `CustomDetailReportQueryRq` infrastructure). Tool count 82 → 83. No new builder / parser-adapter / sim-handler surface area was added.

**Why:** Three reasons.

1. **The HANDOFF's suggestion was wrong-shaped against the actual QBXML schema.** The carry-forward note said #53 "can compose on top of the new `CustomDetailReportQueryRq` infrastructure — same builder + parser-adapter + sim-handler shape, just different `IncludeColumn` lists and report types." Verified against qbxmlops130/140: `CustomDetailReportType` is an enum with exactly two values — `CustomTxnDetail` and `CustomSummary`. `GeneralLedger` is a `GeneralDetailReportType`, NOT a `CustomDetailReportType`. Wiring GL as `CustomDetailReportQueryRq{ CustomDetailReportType=GeneralLedger }` would have returned statusCode 3120 from live QB and "Unsupported CustomDetailReportType" from the sim. The proper wire request for GL is `GeneralDetailReportQueryRq` — a structurally similar but distinct envelope.

2. **A new `GeneralDetailReportQueryRq` builder would have added schema-order risk for marginal gain.** Building `buildGeneralDetailReportRequest` + a new parser branch + a new sim handler would mirror the bank-rec scaffold (~150 LOC + tests + a new schema-order pin). The pin would be best-effort "until live verifies" — the same fix-and-pin loop the #37 P&L bug established. For a single tool (with no immediate downstream callers that block on it), that's overhead disproportionate to the value: `TransactionQueryRq` is already wired, already tested, already verified live.

3. **The composite reuses 100% verified primitives.** `qb_transaction_list_by_account` rides the same `session.queryTransactions` + `session.queryEntity("Account", ...)` plumbing and has been live-verified. `qb_general_ledger` is fundamentally "do that for every account that matches a filter and aggregate into sections" — semantically a multi-account version of the same tool. Zero new wire types means zero new live-mode risk.

**Implementation:**

- Pure helper `buildGeneralLedgerSection(account, rows)` in [src/tools/reports.ts](src/tools/reports.ts) — exported for unit testing without an MCP transport. Computes `openingBalance = currentBalance − periodSum`, walks forward annotating each row with `RunningBalance`, returns the section shape. Same math as `qb_transaction_list_by_account`'s in-tool walk (cf. [src/tools/transactions.ts:106-140](src/tools/transactions.ts#L106-L140)); the helper extraction lets us pin the math in isolation.
- Tool handler orchestrates: (a) one `AccountQuery` to fetch the chart of accounts; (b) in-process filter by `accountName` / `accountListId` / `accountType`; (c) drop `NonPosting` accounts from chart-wide fanout (with a `warnings` surface so the operator sees what was excluded); (d) cap fanout by `maxAccounts` (default 200); (e) one `TransactionQuery` per remaining account with `MaxReturned: maxRowsPerAccount` (default 500); (f) per-section sort (defensive — sim sorts already, live order is QB-driven), `buildGeneralLedgerSection`, prune empty sections unless `includeEmpty: true`, flag `truncated: true` when row count hits the per-account cap.
- Section-level error isolation: each account's TransactionQuery is wrapped in try/catch. A failure on one account surfaces as `section.error` without breaking the rest of the response. Tests pin this with a spy that throws on the first call and succeeds thereafter.
- Single-account error paths return statusCode 500 (unknown `accountName` or `accountListId`) — same shape as `qb_status_codes.ts` surfaces for other "not found" cases. Empty result on a chart-wide query returns a structured success with a `note` rather than an error.

**Alternatives rejected:**

- **`CustomDetailReportQueryRq{ CustomDetailReportType=GeneralLedger }`** — what the HANDOFF suggested. Rejected because `GeneralLedger` is not a valid `CustomDetailReportType` enum value (see "Why" #1 above). Would have failed live with statusCode 3120.
- **New `GeneralDetailReportQueryRq` wire request** (correct QBXML for GL). Would have added a new builder, parser branch, sim handler, schema-order pin, and ~150 LOC. Rejected for the marginal-gain reason above. Reconsider if (a) a future tool needs `GeneralDetailReportType` for something other than GL (sales-by-customer detail, trial balance, etc.), at which point the infrastructure cost amortizes; or (b) live latency makes the N-round-trip composite painful enough to warrant the work.
- **Single-account-only tool (mirror `qb_transaction_list_by_account` with renamed args).** Rejected — the operator's GL ask is fundamentally multi-account ("show me every expense account's activity for March"). A single-account-only tool would just be a thin alias.
- **Implicit chart-wide fanout with no `accountType` filter.** Rejected as a default. With a 200-account chart and ~500ms QBXMLRP2 latency, an unfiltered call would take 100s. The tool surfaces `accountType` prominently in the description and the `maxAccounts` cap protects against accidental runaway. Operator can still pass nothing for the rare "full GL" workflow.

**Tradeoffs / consequences:**

- **N round trips in live mode** for N matching accounts. Acceptable for a personal-tool month-end workflow; would not scale to multi-tenant SaaS. Mitigation: scope by `accountType` (`'Expense'` typically returns ~10-30 accounts, well under 500ms × 30 = 15s).
- **No new schema-order risk.** Zero new builder or wire type means zero new "what's the correct xs:sequence" guesses.
- **`NonPosting` accounts surface a warning, not silent drop.** Operator visibility into what was excluded. Explicitly-named NonPosting accounts go through (caller's choice).
- **Same RunningBalance accuracy bounds as `qb_transaction_list_by_account`** — exact when `toDate ≥ now`, approximate (overstated by post-period postings) for historical windows. Documented in the tool description.
- **Section-level error isolation** means a partial response is possible (some sections OK, some with `error` field). Caller code must check `sections[].error` rather than only the top-level error path. Documented behavior.
- **`maxRowsPerAccount` truncation flag** (`truncated: true` on the section) lets the operator detect when a single account exceeded the cap and re-query with a higher value.

**Revisit when:** A future report tool needs `GeneralDetailReportType` for sales-by-customer-detail / sales-by-item-detail / trial-balance / vendor-balance-detail (Phase 11 #48-52, #54). At that point the new wire-level infrastructure becomes worth building — and `qb_general_ledger` should be re-evaluated for migration to the single-envelope `GeneralDetailReportQueryRq` form to drop the N-round-trip cost in live mode.

---

## 2026-05-10 — CustomDetailReportQueryRq infrastructure for the bank-rec read side (#56 + #56a paired)

**Chosen:** Ship Phase 11 #56 (`qb_reconciliation_discrepancy`) and #56a (`qb_uncleared_transactions`) as a paired delivery on shared `CustomDetailReportQueryRq` infrastructure. Both tools route through one new `runCustomDetailReport(params)` method on `QBSessionManager`, which itself wraps a new `buildCustomDetailReportRequest` helper + a new `extractCustomDetailReportData` extractor + a new `adaptLiveCustomDetailReportRet` row-tree adapter (mirroring the `adaptLiveReportRet` pattern shipped for PnL/BS in #37). The simulation gets a `handleCustomDetailReportQuery` handler that walks the seven bank-affecting transaction stores, applies the AccountFilter / ClearedStatusFilter / ModifiedDateRangeFilter / TxnDateRangeFilter combinatorics server-side, and emits the same `{Columns, Rows}` shape the live row-tree adapter produces. Tool count 80 → 82.

**Why:** Three reasons.

1. **`CustomDetailReportQueryRq` is the only QBXML path that returns ClearedStatus.** Verified against qbxmlops130/140: ClearedStatus is NOT a field on any `*Ret` element and NOT a filter on any `*QueryRq`. It appears as input on `ClearedStatusModRq` and as output ONLY when `IncludeColumn=ClearedStatus` is on a CustomDetailReport request. Any read tool that needs to surface "which txns are uncleared" or "which Cleared txns were modified" has to go through this report — there is no per-type query alternative that returns the field.

2. **Server-side filtering matters for the operator's volumes.** `ReportClearedStatusFilter` (`ClearedOnly` / `UnclearedOnly` / `All`) and `ReportModifiedDateRangeFilter` are both filters QB applies before returning rows. The alternative — query each of the 7 bank-affecting types independently and filter client-side — works for sim/dev but scales poorly for a real practice that may have thousands of bank txns per account per month. Wiring the filters through to QB is the right call.

3. **One infrastructure unblocks multiple downstream tools.** Phase 11 #53 (general ledger) needs row-level transaction detail with operator-selected columns; Phase 11 #58 (sales by customer/item detail variants) does too. They all use CustomDetailReport-family requests with different `IncludeColumn` lists. Building this infrastructure once for #56 + #56a and then reusing it cuts the cost of those follow-ups substantially.

**Implementation:**

- New `buildCustomDetailReportRequest(params, version?)` in [src/qbxml/builder.ts](src/qbxml/builder.ts). Schema-required emit order pinned in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts): `CustomDetailReportType → ReportPeriod → ReportAccountFilter → ReportClearedStatusFilter → ReportModifiedDateRangeFilter → ReportBasis → IncludeColumn` (multiple). The exact xs:sequence position numbers per the QBXML 16.0 SDK XSD have not been verified line-by-line in this session — if live QBXMLRP2 surfaces statusCode -1 "found an error when parsing", that's the same class of bug as the 2026-05-09 #37 P&L bug and the fix is to reorder children to match the actual XSD `<xs:sequence>`. The pin keeps the contract testable independent of live access.
- New `adaptLiveCustomDetailReportRet(reportRet)` + `extractCustomDetailReportData(response, type)` in [src/qbxml/parser.ts](src/qbxml/parser.ts). Translates QB's row-tree (`ReportData.DataRow[]` + `ColDesc[]` keyed by colID) into a flat `{Columns, Rows}` shape. Numeric ColTypes (Amount/Quantity/Price/Number) coerce via `Number()`; everything else stays a string. NaN coercion falls back to the raw string rather than dropping the cell. `<DataRow @_rowType="Check">` surfaces as `_rowType` so callers can disambiguate when `IncludeColumn` omits TxnType.
- New `runCustomDetailReport(params)` in [src/session/manager.ts](src/session/manager.ts). Mirrors `runReport` (the GeneralSummaryReport analog). Read path — does NOT route through `assertWritable`.
- New `handleCustomDetailReportQuery` + dispatch branch in [src/session/simulation-store.ts](src/session/simulation-store.ts). Branch must precede the `endsWith("QueryRq")` catch-all. Walks the seven bank-affecting stores, resolves each txn's bank/CC posting account from its header ref (`Check.AccountRef`, `Deposit.DepositToAccountRef`, `Transfer.{From,To}AccountRef`, `BillPayment*.{Bank,CreditCard}AccountRef`, `CreditCard*.AccountRef`), applies natural-balance sign convention (positive = increases account natural balance), emits one row per (txn, account-match) pair. Transfer hits both From and To accounts independently. Missing `ReportAccountFilter` returns 3120; unsupported `CustomDetailReportType` returns 3120; unknown account returns empty rows (status 0, not 3120).
- New `qb_uncleared_transactions(accountName | accountListId, asOfDate?, clearedStatusFilter?, basis?)` in [src/tools/reconciliation.ts](src/tools/reconciliation.ts). Wraps `runCustomDetailReport` with `clearedStatusFilter` defaulting to `UnclearedOnly` (NotCleared + Pending). Returns `{ account, asOfDate, clearedStatusFilter, count, totalAmount, transactions: [...] }`. `totalAmount` is the signed sum of postings — shows net effect on the account. Read-side; ungated.
- New `qb_reconciliation_discrepancy(accountName | accountListId, sinceDate?, asOfDate?, basis?)` in same file. Wraps `runCustomDetailReport` with `clearedStatusFilter='ClearedOnly'` + `fromModifiedDate=sinceDate` (default 30 days back). Returns `{ account, sinceDate, asOfDate, count, note, candidates: [...] }`. Surfaces only the modified-after-cleared signal; postings to the QB-internal "Reconciliation Discrepancies" expense account are reachable today via `qb_transaction_list_by_account({ accountName: "Reconciliation Discrepancies" })` and are explicitly NOT bundled here (keeps each tool single-purpose).
- 45 new tests in [tests/reconciliation-read.test.ts](tests/reconciliation-read.test.ts) (5 builder shape, 6 parser adapter, 1 extractor, 14 sim handler, 1 manager, 8 uncleared tool, 5 discrepancy tool, 4 cross-cutting) plus 1 schema-order pin in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts). 454/454 tests green (was 409 + 45).

**Alternatives rejected:**

- **Use 7 per-type `*QueryRq`s with `AccountFilter` instead of `CustomDetailReportQueryRq`.** Tempting because each `*Ret` element does carry `ClearedStatus` (set by `handleAdd` on bank-affecting types), so client-side filtering by ClearedStatus would work. Rejected because (a) the field is sim-only — live mode's bank-affecting `*Ret` does NOT include ClearedStatus on every type, so per-type queries would degrade in live mode in a non-obvious way; (b) doesn't scale (7 round trips vs 1 for any operator with > 500 bank txns per account); (c) doesn't unblock the downstream report tools (#53, #58) that need the same custom-report infrastructure.
- **Bundle the "Reconciliation Discrepancies expense account postings" signal into `qb_reconciliation_discrepancy`.** Originally proposed in the plan to the operator. Rejected during implementation because the existing `qb_transaction_list_by_account` tool already answers exactly that question — calling it with `accountName: "Reconciliation Discrepancies"` returns the same data. Bundling would couple two unrelated read paths inside one tool for no gain. Documented the workflow in the tool description instead.
- **Call the read tool `qb_uncleared_transactions_by_account` per #56's text.** Rejected — verbose and `_by_account` is implicit (the tool requires an account argument). Operator's #56a item used the shorter `qb_uncleared_transactions` name; matching that.
- **Limit the discrepancy tool to a fixed sinceDate window (e.g. always 30 days).** Rejected — operators reconciling quarterly need to scope to the last reconciliation date, not a fixed window. Default of 30 days back covers the monthly close path; explicit override covers the quarterly path.

**Tradeoffs / consequences:**

- Bank-rec end-to-end now closes through the MCP: discover uncleared (#56a) → mark cleared (#46) → check for discrepancies (#56). The operator can run an entire month-end close against a `.qbw` from an agent without touching QB Desktop's reconciliation screen.
- The `CustomDetailReportQueryRq` infrastructure (builder + parser adapter + manager method + sim handler) is now in place and reusable. Phase 11 #53 (`qb_general_ledger`) and #58 (sales-by-* detail variants) can compose on top of it with substantially less work than building from scratch.
- Schema-order pin is "best understanding" not "verified against XSD" for the new builder. Documented loudly. If live exercises surface a parse error, it'll be the standard fix-and-pin loop the #37 path established.
- Sim handler emits `TxnID` and `TimeModified` as bonus columns beyond the requested `IncludeColumn` list. Live mode emits whatever ColDesc returns; the tool layer (`formatRow`) handles missing fields gracefully via optional surface. Discrepancy tool's `timeModified` field is reliably present in sim, may or may not be in live depending on the QBXML version's ColDesc behavior — degrades by omitting the field, not by failing.
- Per-line ClearedStatus (set via line-level `ClearedStatusModRq`) is NOT aggregated into the row's ClearedStatus — the txn header field governs. For mixed-status txns (rare — typically full-line reconciliation), the tool surfaces the header status only. Documented in the `qb_uncleared_transactions` tool description.
- Carried gotcha: BillPayment* total amount lives on `TotalAmount` (set by `applyBillPayment` from sum of `AppliedToTxn.PaymentAmount`), NOT on `Amount`. The sim handler must coalesce `TotalAmount ?? Amount` for these two types — Check / CreditCard* / Transfer use `Amount`. Fixed during test development; pinned by the BillPaymentCheck test in [tests/reconciliation-read.test.ts](tests/reconciliation-read.test.ts).

**Revisit when:** Live QBXMLRP2 testing on Windows + QB Desktop verifies (or refutes) the schema-order assumption — at which point either pin stands or gets reordered to match the actual XSD. Phase 11 #53 / #58 land — at which point this infrastructure should compose naturally for them too. No earlier revisit.

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
