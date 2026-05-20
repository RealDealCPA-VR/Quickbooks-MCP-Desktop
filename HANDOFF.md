# Handoff State

_Last updated: 2026-05-20. **#64 dry-run V1 shipped on 3 pilot tools.** Tests **1479** (+23). Tool count **147** (unchanged — dryRun is a flag). All work since #62 still uncommitted on master (operator handles commits)._

## Last Session Summary

- **#64 dry-run mode V1 — DONE.** Operator said "proceed" with the three tentative composition decisions, so V1 ships with: (1) **read-only × dry-run = ALLOW** (dry-run primitives skip `assertWritable`); (2) **idempotency × dry-run = PEEK** (same-fingerprint hit → `wouldReplay: true`, different-fingerprint hit → `wouldSucceed: false, statusCode: 9002`; cache NEVER written by dry-run); (3) **live mode = option (b)** — envelope-only with `note`, no entity preview oracle.
- **Manager**: refactored five public mutation methods to call private `*Core` siblings after `assertWritable`. New primitives: `addEntityDryRun` / `modifyEntityDryRun` / `deleteEntityDryRun` / `executeBatchAddDryRun` / `updateClearedStatusDryRun` ([src/session/manager.ts](src/session/manager.ts)). Exported `DryRunResult` + `DryRunBatchResult` + `DRY_RUN_LIVE_NOTE`. Sim store gained `snapshot()` / `restore(snap)` ([src/session/simulation-store.ts](src/session/simulation-store.ts)) via `structuredClone` per entity (Map+entity deep-clone).
- **Pilot tools** threaded with `dryRun: z.boolean().optional()`: `qb_customer_add`, `qb_invoice_create`, `qb_invoice_delete`. 23 new tests in [tests/dry-run.test.ts](tests/dry-run.test.ts). DECISIONS.md gained the 2026-05-20 entry documenting the three composition calls.

## Verify Before Continuing

Re-run only if the tree's been touched. Skip if next session starts within hours of the last sim run (2026-05-20).

- [ ] `npm run build` → exit 0 (tsc clean).
- [ ] `npm test` → `Test Files 58 passed | Tests 1479 passed`.
- [ ] `"" | & node dist/index.js` → exit 0, `Mode: simulation` banner printed.
- [ ] **(Windows + QB) NEW — #64 live envelope shape spot-check.** Run `qb_customer_add({ name: "Live DryRun Probe", dryRun: true })` against the open books. Expected: `{ success: true, dryRun: true, committed: false, mode: "live", previewSupported: false, qbxmlEnvelope: "<...CustomerAddRq...>", note: "Live preview unavailable…" }`. Then `qb_invoice_create({ customerName: "<existing>", lines: [...], dryRun: true })`. Confirm NEITHER posted (re-query both lists — dry-run names/refs absent).
- [ ] **(Windows + QB)** Carried — #62 / #60 / #65 / #61 first live exercises (see prior handoffs).
- [ ] **(Windows + QB) Lowest priority** — carried 18-item live-exercise bucket from prior handoffs.

## Next Task

**Phase 14 #64a — Dry-run mechanical rollout to remaining ~50 mutation tools.** V1 (#64) pilots 3 of ~55 `*_create` / `*_update` / `*_delete` tools. Per-tool transformation pattern is mechanical and pinned by the pilot tools — add `dryRun: z.boolean().optional()` to the Zod schema, branch `if (args.dryRun)` at the top of the handler to call the matching `*DryRun` manager primitive, return the dryRun-shaped payload. See todo.md #64a for the full per-domain tool inventory.

**Suggested approach:** Codemod via a new `scripts/threadDryRun.mjs` similar to [scripts/refactor-error-wrappers.mjs](scripts/refactor-error-wrappers.mjs). Per-tool tests reuse the patterns in [tests/dry-run.test.ts](tests/dry-run.test.ts).

**Deliberate outliers — DO NOT add dryRun in this sweep:** `qb_invoice_write_off`, `qb_invoice_batch_create`, `qb_sales_receipt_batch_create`, `qb_journal_entry_batch_create`, `qb_invoice_duplicate`, `qb_estimate_convert_to_invoice`, and any future composite tool. These read-then-mutate or run compensating-rollback logic; each needs a bespoke V2 design (peek the idempotency cache? snapshot before the read? what does "would happen" mean for the rollback path?).

After #64a closes: **Phase 14 #66 — `qb_audit_log({ txnId | dateRange })`**, Enterprise-only edition-gated via `HostInfo.isEnterprise`.

## Context Notes

- **The `*Core` refactor is load-bearing.** Public `addEntity` / `modifyEntity` / `deleteEntity` / `executeBatchAdd` / `updateClearedStatus` are now thin `assertWritable`+delegate wrappers; the build/send/extract logic lives in private `*Core` siblings. Dry-run calls `*Core` directly. **If you add a new pre-send gate, decide whether it should fire on dry-run too** — gate semantics (read-only style) go in the public wrapper BEFORE the `*Core` call; checks that should run on both real and dry-run go in `*Core` or higher.

- **Per-tool rollout pattern** (the codemod transformation):
  ```ts
  // schema field:
  dryRun: z.boolean().optional().describe("If true, preview what this call WOULD do without committing. See qb_customer_add's dryRun docs for the full composition matrix."),
  // handler branch (insert before the existing real-call path):
  if (args.dryRun) {
    try {
      const preview = await session.<addEntityDryRun|modifyEntityDryRun|deleteEntityDryRun>("<EntityType>", <data | id>, <args.idempotencyKey if applicable>);
      const { entity, ...rest } = preview;
      return { content: [{ type: "text" as const, text: JSON.stringify({
        success: true, dryRun: true, ...rest, ...(entity ? { <domain key>: entity } : {}),
      }, null, 2) }] };
    } catch (err) {
      return formatToolError(err, { fallbackMessage: "<...DryRq>... dry-run failed" });
    }
  }
  ```
  Map of domain key → entity field varies per tool: `customer`, `invoice`, `bill`, `vendor`, `account`, `check`, `deposit`, `transfer`, etc. Pilot tools at [src/tools/customers.ts:328-348](src/tools/customers.ts#L328-L348) and [src/tools/invoices.ts:329-348](src/tools/invoices.ts#L329-L348) and [src/tools/invoices.ts:676-694](src/tools/invoices.ts#L676-L694) are the canonical exemplars.

- **`structuredClone` is the deep-clone primitive.** Sim store entities are mutated in-place by `handleAdd` / `handleMod` (Customer.Balance, *LineRet appends). Shallow Map clone would leak through restore. Pinned by `tests/dry-run.test.ts` "Customer.Balance reverts after restore" test.

- **`idCounter` ticks TWICE per add** (ListID via `nextId()` + EditSequence via `nextEditSequence()`, see [simulation-store.ts:5342-5353](src/session/simulation-store.ts#L5342-L5353)). Tests that pin counter-preservation must use `+2` per add, not `+1`.

- **Live-mode dry-run never hits the wire.** The envelope-build path returns BEFORE any `sendRequest` call. Idempotency PEEK in live mode is also wire-free (cache is per-process Map).

- **Status code 9006** is reserved for the future "dry-run not supported in this mode" case if a future composite tool can't preview cleanly. V1 doesn't use it.

- **Composite outliers — when V2 picks up:** open question is whether to (a) implement per-tool bespoke `dryRun` against a shared snapshot, or (b) skip dry-run on composites entirely. Tentative recommendation: (a) for workflow-critical composites (write-off, batch tools), (b) for one-offs. Defer until #64a sweep is done so V1 ergonomics get load-tested first.

- **Carried gotchas** (still apply):
  - **statusCodes** — 9001 read-only, 9002 idempotency conflict, 9003 edition, 9004 payroll, 9005 SDK-no-write, **9006 reserved for dry-run-not-supported**.
  - `fast-xml-parser` does NOT decode numeric character entities (use `decodeXmlEntities`). DOES coerce numeric-looking text to numbers.
  - Live verification requires `C:\nvm4w\nodejs\node.exe` v20.20.2 (system PATH v22 breaks winax).
  - AR-side `Customer.Balance` discount math is correct; AP-side is NOT — future `qb_bill_write_off` needs the parallel fix.
  - Dispatch order in `processRequest` — non-entity-typed `*QueryRq` / `*ModRq` / `AttachableAddRq` / `DataExtDefQueryRq` MUST precede the `endsWith` catch-alls.
  - Iterator wire names diverge — `iterator` / `iteratorID` on request; `iteratorRemainingCount` / `iteratorID` on response.
  - QBXMLRP2 cannot OPEN a `.qbw` — only attach to one QB Desktop has already loaded.
  - `BillPayment*` total is on `TotalAmount`, not `Amount` — coalesce `TotalAmount ?? Amount`.
