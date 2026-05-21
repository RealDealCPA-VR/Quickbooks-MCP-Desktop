# Handoff State

_Last updated: 2026-05-21. **Phase 14 #64b closed.** Dry-run V2 shipped bespoke for all 11 composite outliers — no 9006 emissions. New `compositePreviewDryRun` manager primitive supports 2-envelope composites (convert tools). Tests **1647** (+18). Tool count unchanged at **150** — dryRun is a flag on existing tools, not a new surface. All work since last sync uncommitted on master (operator handles commits)._

## Last Session Summary

- **Phase 14 #64b implementation landed end-to-end.** Goal: ship dry-run preview on the 11 composite outliers V1/#64a flagged as needing per-tool design — instead of the handoff's mixed bespoke + 9006 framing, all 11 got bespoke previews because 9 of them are effectively single-envelope-after-pre-flight and the other 2 are 2-envelope composites that fit cleanly into a new primitive.
- **New manager primitive** [src/session/manager.ts](src/session/manager.ts) — `compositePreviewDryRun(specs: CompositeOpSpec[]): Promise<DryRunCompositeResult>`. Snapshots the sim store ONCE, runs each spec's `*Core` against the shared snapshot context, halts on first failure (subsequent specs → `"skipped"`), restores in `finally`. New exported types: `CompositeOpSpec` (kind: "add" / "modify" / "delete"), `CompositeOpResult` (per-op status + envelope + entity/statusCode), `DryRunCompositeResult` (wouldSucceed + results array + live-mode note).
- **Tools threaded (11 total):**
  - **3 batch tools** via the existing `executeBatchAddDryRun` (V1 primitive — no new infrastructure needed). Upfront validation gate still runs before the dry-run branch (customer-ref / JE-balance checks). **Rollback path NOT previewed** (documented in dryRun schema string on all 3).
  - **`qb_invoice_write_off`** via `addEntityDryRun("ReceivePayment", ...)` after the source-read + balance pre-flight. The write-off is wire-shaped as a single `ReceivePaymentAdd` envelope (0-total payment with `DiscountAmount` posting to the write-off account) — no compensating CreditMemo, no second envelope. The handoff's framing was wrong on this point.
  - **`qb_bill_pay`** via `addEntityDryRun(<BillPaymentCheck|BillPaymentCreditCard>, ...)`. Vendor-ref check is part of the AddRq sim-oracle path, so it surfaces correctly in the preview.
  - **4 duplicate tools** (invoice / bill / journal_entry / sales_receipt _duplicate) — each is source-read + ONE `*Add` envelope. Use `addEntityDryRun(<sourceType>, ...)` after the source read.
  - **2 convert tools** (estimate_convert_to_invoice / sales_order_convert_to_invoice) — the ONLY genuine 2-envelope composites. Use the new `compositePreviewDryRun` with `[{kind: "add", entityType: "Invoice", ...}, {kind: "modify", entityType: "Estimate"|"SalesOrder", ...}]`. When `markAccepted: false` / `markClosed: false`, only 1 spec is built and the response carries `estimateMod`/`salesOrderMod: { status: "skipped", reason: "markAccepted: false" }`.
- **Documented limitation on convert tools:** dry-run does NOT preview idempotent replay — InvoiceAdd half always previews as a fresh call regardless of `idempotencyKey`. Modeling replay would require either exposing `fingerprintPayload` to the tool layer or adding `idempotencyKey` to the `CompositeOpSpec` API; punted per DECISIONS.md 2026-05-21 entry. Operator can verify replay behavior on the live path.
- **Rollback NOT previewed on batch tools.** Per-entry status array (`posted` / `failed` / `skipped`) tells the operator the failure landscape; operator must mentally model "all entries before the first `failed` would be auto-deleted on the real call." Cost of previewing rollback: another snapshot/restore cycle running `deleteEntityDryRun` against each would-be-posted entry. Skipped because the rollback rarely fails in practice; pinned as a future option in DECISIONS.md.
- **Status code 9006** stays reserved but is no longer emitted anywhere — kept defensive for future tools whose composition is genuinely unpreviewable (external side effects, irreversible wire ops with no sim oracle).
- **18 new tests** in [tests/dry-run.test.ts](tests/dry-run.test.ts) across two layers:
  - **Layer 8** — `compositePreviewDryRun` primitive: 2-op success (Customer add + Customer modify, both succeed, store unchanged after restore); first-op-fails halts second (unknown ParentRef on add → modify skipped); second-op-fails preserves first's success + store unchanged (stale EditSequence on modify); `delete` spec support; live-mode contract documented in-place (sim-test harness can't flip simulationMode mid-run, so the live branch is structurally pinned by Layer 5 single-op equivalents).
  - **Layer 9** — 11 outlier tool surfaces: per-outlier "preview returned + underlying entities unchanged" pin, plus the JE-batch upfront-balance-gate test (unbalanced entry → 3030 BEFORE reaching dry-run preview) and the convert tools' `markAccepted: false` skip-spec variant.
- **Counts.** 1629 → 1647 tests green. Tool count UNCHANGED at 150 (dryRun is a flag on existing tools, not a new tool surface). Build clean, sim banner clean. README + src/index.ts instructions block left unchanged — the dryRun threading is structurally identical to V1/#64a's surface and existing dryRun callouts cover it by induction. The 11 tools' per-tool dryRun schema descriptions carry the per-tool quirks (rollback-not-previewed on batch tools, idempotency-replay-not-modeled on converts, pre-flight-still-runs on write-off + duplicates + bill_pay).

## Verify Before Continuing

Re-run only if the tree's been touched. Skip if next session starts within hours of the last sim run (2026-05-21).

- [ ] `npm run build` → exit 0 (tsc clean).
- [ ] `npm test` → `Test Files 61 passed | Tests 1647 passed`.
- [ ] `"" | & node dist/index.js` → exit 0, `Mode: simulation` banner printed.
- [ ] **(Windows + QB) NEW — #64b live spot-check** for the 11 outliers' dry-run path. Live-mode dry-run is envelope-only (`previewSupported: false` + `note` populated) — no wire I/O. Quick exercise per category:
  - **Batch tool:** `qb_invoice_batch_create({ invoices: [{customerName: "<a customer>", lines: [{itemName: "<a service item>", quantity: 1, rate: 100}]}], dryRun: true })`. Confirm response carries `previewSupported: false` + `note` + the QBXML envelope; confirm no new invoice in QB UI.
  - **Read-then-write:** `qb_invoice_write_off({ txnId: "<an open invoice TxnID>", writeOffAccount: "<a P&L account>", dryRun: true })`. Confirm envelope built, source invoice's BalanceRemaining unchanged.
  - **Duplicate:** `qb_invoice_duplicate({ sourceTxnId: "<any invoice>", dryRun: true })`. Confirm envelope built, no new invoice posted.
  - **Convert:** `qb_estimate_convert_to_invoice({ estimateTxnId: "<an estimate>", dryRun: true })`. Confirm 2 envelopes in response (`qbxmlEnvelopes` array length 2), source estimate IsAccepted unchanged. With `markAccepted: false`, confirm 1 envelope only.
- [ ] **(Windows + QB) Carried — #74 live spot-check.** MCP-side lookup cache (the previous session's work). See prior handoff for the full exercise list (cache hit on second call, qb_cache_invalidate, autoExhaust write-back priming).
- [ ] **(Windows + QB) Carried — #73 live spot-check across the 7 paginated tools** (autoExhaust pattern).
- [ ] **(Windows + QB) Carried — #63 / #66 / #64a / #64 / #62 / #60 / #65 / #61** first live exercises.
- [ ] **(Windows + QB) Lowest priority** — carried 18-item live-exercise bucket from prior handoffs.

## Next Task

The todo.md is **CLOSED through #74 + #64b**. Phase 18 robustness picks are also closed.

### Pick from one of:

**Option A — Live verification sweep.** Highest payoff is the new #64b live spot-check (zero wire I/O for sim-side previews, but envelope-built check is worth pinning at least once per outlier category). Also #74's live spot-check (cache layer is sim-verified end-to-end but live envelope-silence on the second call needs `QB_DEBUG_QBXML=1` capture).

**Option B — Open-ended improvement.** Operator-driven. The natural next layer is "what new domain coverage does the operator's actual practice still want?" — examples: tax-form-1040-summary that aggregates K-1 inputs across an S-corp's books, automated trial-balance cross-checker against last year's filed return, batch import from a CSV/spreadsheet. None of these are in todo.md yet.

**Option C — Rollback preview opt-in (#64b extension).** If an operator gets burned by a batch-tool rollback failure that the dry-run didn't predict, add `rollbackPreview: true` to the 3 batch tools — would run `deleteEntityDryRun` against each would-be-posted entry on partial-failure preview. Skipped by default per DECISIONS.md 2026-05-21 entry. Low-priority defensive work.

**Option D — Idempotency-aware composite preview.** Companion to #64b — would let the convert tools' dry-run preview the idempotent-replay routing path (currently always previews as "fresh execution"). Requires either exposing `fingerprintPayload` or adding idempotencyKey to the `CompositeOpSpec` API. Punted at #64b ship; revisit only if operator workflow surfaces the need.

## Context Notes

- **The `compositePreviewDryRun` primitive is now load-bearing.** Any future tool that emits 2+ envelopes in sequence and wants dry-run support should use it — chaining single-op `*DryRun` calls would each take their own snapshot/restore (wasted work, plus the second op would see the unsnapshotted store). Spec is `kind: "add" | "modify" | "delete"` + `entityType` + payload (or `listIdOrTxnId` for delete). The first failure halts the chain; subsequent specs return `status: "skipped"`. Live mode builds all envelopes, returns all results as `"skipped"`, sets `previewSupported: false`.

- **The pre-implementation cardinality count was wrong in the handoff.** The handoff described `qb_invoice_write_off` as "read-then-mutate: reads source invoice, applies a compensating CreditMemo." Actually it's `ReceivePaymentAdd` with `DiscountAmount` — one envelope, not two. Same shape as QB Desktop's "Discounts and Credits → Discount Tab" workflow on the Receive Payments form. This matters because the prior framing made write-off look like a 2-envelope composite that needs the new primitive; it doesn't. The new primitive is only used by the 2 convert tools.

- **Idempotency-replay routing on convert tools is real-call-only.** The dry-run preview always shows the "fresh execution" path even when an `idempotencyKey` is supplied. Documented in the dryRun schema description on both convert tools. If an operator needs to verify what a replay would do, run the real call once and inspect the response. If this becomes a recurring pain point, the resolution is a new `peekIdempotencyDecision(key, entityType, data): "miss" | "match" | "conflict"` public method on the manager + tool-layer routing.

- **Rollback NOT previewed on batch tools.** The per-entry results array (`posted` / `failed` / `skipped`) tells the operator the failure landscape, but doesn't show the compensating-delete outcomes. Operator must mentally model "all entries before the first `failed` would be auto-deleted on the real call." If this becomes confusing, add `rollbackPreview: true` opt-in to the 3 batch tools.

- **Status code 9006 stays reserved but is now zero-emit.** Originally reserved for the V2 outliers' "we can't preview this composition" rejection. Since all 11 outliers got bespoke previews, 9006 is purely defensive — kept for future tools whose composition is genuinely unpreviewable (external side effects, irreversible wire ops with no sim oracle).

- **The `CompositeOpSpec` type is exported from `manager.ts`** for the 2 convert tools to type-check their spec construction. No runtime impact; purely TS surface.

- **Tool count is UNCHANGED at 150.** dryRun is a flag on existing tools, not a new tool surface. README + src/index.ts instructions block left unchanged — the V1/#64a dryRun callout covers the 11 outliers by induction; per-tool quirks are documented inline in each tool's dryRun schema description.

- **Carried gotchas** (still apply):
  - **#74's lookup cache** — Read vs Write eligibility split is load-bearing; per-subtype keying for Item + Terms intentional; merged-cache "all subtypes must hit" rule; cache write doesn't deep-clone (mutation safety lives at the tool layer); cache scope is per-session, per-companyFile.
  - **#73's autoExhaust pattern pinned across 7 tools.**
  - **statusCodes** — 9001 read-only, 9002 idempotency conflict, 9003 edition, 9004 payroll, 9005 SDK-no-write, **9006 reserved-but-zero-emit** (defensive for future unpreviewable composites).
  - **The `*Core` refactor is load-bearing** (DECISIONS.md V1 entry). New `compositePreviewDryRun` calls `addEntityCore` / `modifyEntityCore` / `deleteEntityCore` directly (private methods that skip the read-only gate, mirroring how the V1 `*DryRun` primitives work).
  - **`structuredClone` is the deep-clone primitive** in the sim store. snapshot/restore use it.
  - **`idCounter` ticks TWICE per add** (ListID via `nextId()` + EditSequence via `nextEditSequence()`). Dry-run snapshot preserves it.
  - **#64a dry-run rollout pattern is baseline.** Any new mutation tool MUST thread `dryRun`. #64b extends this to all 11 outliers — there are no remaining mutation tools that lack dryRun support.
  - **Live-mode dry-run never hits the wire.**
  - `fast-xml-parser` does NOT decode numeric character entities (use `decodeXmlEntities`). DOES coerce numeric-looking text to numbers.
  - Live verification requires `C:\nvm4w\nodejs\node.exe` v20.20.2 (system PATH v22 breaks winax).
  - AR-side `Customer.Balance` discount math is correct; AP-side is NOT — future `qb_bill_write_off` (if added) would need the parallel fix.
  - Dispatch order in `processRequest` — non-entity-typed `*QueryRq` / `*ModRq` / `AttachableAddRq` / `DataExtDefQueryRq` MUST precede the `endsWith` catch-alls.
  - Iterator wire names diverge — `iterator` / `iteratorID` on request; `iteratorRemainingCount` / `iteratorID` on response.
  - QBXMLRP2 cannot OPEN a `.qbw` — only attach to one QB Desktop has already loaded.
  - `BillPayment*` total is on `TotalAmount`, not `Amount` — coalesce `TotalAmount ?? Amount`.
  - **#66 wire-shape decision is load-bearing for any future audit-trail-related work.** `AuditTrail` is a `CustomDetailReportType` value, NOT a `TxnReportType` value.
