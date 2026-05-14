# Handoff State

_Last updated: 2026-05-14. **#75 banking primitives CLOSED.** 12 new tools (Deposit / Check / Transfer × CRUD) shipped riding on the existing generic addEntity/modifyEntity/deleteEntity/queryEntity infrastructure — no new wire types, no new manager methods. Two strict sim-store improvements rode in: `EntityFilter` now matches `PayeeEntityRef` (was Customer/Vendor only), and `computeTotals` derives `Check.Amount` + `Deposit.DepositTotal` from line sums. Tool count 108 → 120; 949 → 1014 tests green._

## Last Session Summary

- **#75 banking primitives — CLOSED.** Three new tool files registered in [src/index.ts](src/index.ts): [src/tools/deposits.ts](src/tools/deposits.ts) (`qb_deposit_list` / `_create` / `_update` / `_delete`), [src/tools/checks.ts](src/tools/checks.ts) (`qb_check_list` / `_create` / `_update` / `_delete`), [src/tools/transfers.ts](src/tools/transfers.ts) (`qb_transfer_list` / `_create` / `_update` / `_delete`). Pure composites — every tool calls `session.addEntity` / `modifyEntity` / `deleteEntity` / `queryEntity` / `queryEntityPaginated` / `addEntityIdempotent`. No new wire request types, no parser changes, no manager methods.

- **Why the scope was small:** the infrastructure was already in place. `Deposit` / `Transfer` / `Check` were already in `isTransactionType` ([src/session/simulation-store.ts](src/session/simulation-store.ts)), `isTransaction` lists in [src/qbxml/builder.ts](src/qbxml/builder.ts) `buildDeleteRequest` and [src/session/manager.ts](src/session/manager.ts) `deleteEntity`, and `BANK_AFFECTING_TXN_TYPES`. Parser `arrayElements` already covered `DepositRet` / `DepositLineRet` / `TransferRet` / `CheckRet` (and Check's `ExpenseLineRet` / `ItemLineRet` shared with Bill). `handleAdd` / `handleMod` / `handleTxnDel` / `handleQuery` are all generic and dispatched these txn types correctly. The work was tool-surface + a few small sim-store extensions.

- **Sim store extensions (3 strict improvements, all paired with the new tools):**
  1. `computeTotals` now derives `Check.Amount = sum(ExpenseLineRet.Amount + ItemLineRet.Amount)` and `Deposit.DepositTotal = sum(DepositLineRet.Amount)` when undefined on create. Explicit override on create wins (preserves `seedCheck`'s `Amount: 250` pattern and any future test fixture).
  2. `handleMod`'s post-line-mod recompute block now includes `Check` + `Deposit` — deletes the header field before computeTotals fires, so a partial line-mod re-derives the new header total. Mirrors how Bill handles `AmountDue`.
  3. `handleQuery`'s `EntityFilter` now matches `PayeeEntityRef` in addition to `CustomerRef`/`VendorRef`. Required for `qb_check_list({payeeName})` to scope (pre-#75 the filter silently returned every check). **Strict improvement on every existing BillPaymentCheck/BillPaymentCreditCard caller that already passed EntityFilter against PayeeEntityRef — they now match correctly.** No existing tests broke; all 949 prior tests still green.

- **Tool-layer conventions** mirror `bills.ts` / `invoices.ts` exactly: Zod schemas for create + mod-style line shapes (mod schemas accept partial fields with a `txnLineID`-keyed merge; new lines need create-shape fields enforced by `.refine()`); same try/catch error wrapper with `qbStatusCodeMessage` humanReadable; same idempotencyKey behavior on `*_create` (replay → `idempotentReplay: true`; key+different-payload → 9002); same read-only gate via `assertWritable` (9001). Stale `editSequence` → 3170. **Transfer-specific guard:** self-transfer (same From/To by ListID OR by FullName) rejects at the tool layer with `statusCode 3120` before any wire I/O — surfaces a clearer message than QB's server-side rejection.

- **Inventory site transfers explicitly out of scope.** `TransferInventoryAddRq` is Enterprise-only and orthogonal to cash transfers — it belongs under Phase 17 #80 inventory adjustments. Flagged in `qb_transfer_create`'s tool description.

- **Tests:** 65 new tests across 3 files — [tests/deposits.test.ts](tests/deposits.test.ts) (22), [tests/checks.test.ts](tests/checks.test.ts) (24), [tests/transfers.test.ts](tests/transfers.test.ts) (19). Layers: sim-handler totals derivation (DepositTotal / Check.Amount on create + re-derive on mod, ClearedStatus defaulting to NotCleared), list shape (line-strip default, includeLineItems, txnId / refNumber / payeeName / date filters, paginate iterator state), create happy paths (single + multi line, expense + item, payee EntityFilter), validation (missing required ref, no-lines rejection on Check, self-transfer rejection 3120), idempotency (replay returns same TxnID with `idempotentReplay:true` + no duplicate; conflict 9002), update flows (header + line mod, line replacement wholesale, header total re-derive, stale editSequence 3170, unknown TxnID 500), delete flows (happy path, unknown TxnID 500, read-only gate 9001).

- **Test gotcha resolved during the work:** fast-xml-parser's default `parseTagValue: true` coerces numeric-looking text to numbers — `<CheckNumber>1001</CheckNumber>` parses back as the number `1001`, not the string `"1001"`. The test fixture's `chequeNumber: "1001"` survives as a string up to the XML serialization step but reappears as a number on the parse-back. Assertion wrapped in `String(...)` to be agnostic. Flag for future tool authors who send numeric-looking strings into the sim and read them back.

- **Docs:** [README.md](README.md) tool count 108 → 120 + architecture diagram + new "Banking (Deposit / Check / Transfer)" section right before "Bank Reconciliation". [src/index.ts](src/index.ts) instructions block extended with one banking-primitives category line + idempotency-keyed tools list updated with `qb_deposit_create` / `qb_check_create` / `qb_transfer_create`. [todo.md](todo.md) #75 flipped to `[x]` with full closeout notes.

## Verify Before Continuing

Re-run if the tree has been touched (skip if next session starts within hours):

- [ ] `npm run build` → exit 0 (tsc clean).
- [ ] `npm test` → `Test Files 44 passed | Tests 1014 passed`.
- [ ] `"" | & node dist/index.js` → exit 0, `Mode: simulation` printed; banner does NOT print "QBXML debug log: enabled" when `QB_DEBUG_QBXML` is unset.
- [ ] **(Windows + QB) First live exercise of #75.** Connect to `VR Tax & Consulting Inc..qbw`. Walk through one of each: (1) `qb_deposit_create({ depositToAccountName: "Checking", lines: [{ entityName: "<existing customer>", accountName: "Sales Revenue", amount: 250 }] })` — confirm response carries `DepositTotal: 250` + `ClearedStatus: "NotCleared"`; (2) `qb_check_create({ accountName: "Checking", payeeName: "<existing vendor>", expenseLines: [{ accountName: "Office Expenses", amount: 50 }] })` — confirm `Amount: 50` + `ClearedStatus: "NotCleared"`; (3) `qb_transfer_create({ fromAccountName: "Checking", toAccountName: "Savings", amount: 1000 })` — confirm `TransferFromAccountRef` / `TransferToAccountRef` round-trip cleanly. Then `qb_deposit_list({})` / `qb_check_list({})` / `qb_transfer_list({})` — each should return the freshly-created entity. Then `qb_uncleared_transactions({ accountName: "Checking" })` — the new Check + Transfer's "out" leg should appear; clear them via `qb_cleared_status_update` and re-query. **If any `*QueryRq` / `*AddRq` / `*ModRq` rejects with statusCode -1 ("error when parsing the provided XML text stream"), it's the schema-order class of bug** — capture the wire envelope via `QB_DEBUG_QBXML=1` (writes `./logs/qbxml-YYYYMMDD.log`), compare child order against QB's `<xs:sequence>` for the offending request, and pin the canonical order in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts) the way #37 did for `GeneralSummaryReportQueryRq`. Cleanup: `qb_deposit_delete` / `qb_check_delete` / `qb_transfer_delete` the test entities before disconnecting.
- [ ] **(Windows + QB) Carried — Phase 15 #69 first live exercise** of `qb_tax_line_mapping` (still pending from prior session). Confirms `Account.TaxLineInfoRet` surfaces cleanly via `qb_tax_line_mapping({})` against `VR Tax & Consulting Inc..qbw`, cross-checks against `qb_trial_balance_export({})` taxLine column.
- [ ] **(Windows + QB) Carried — Phase 15 #68 first live exercises** (still pending). Full `qb_trial_balance_export` walk against last completed FY (2024-12-31), Accrual basis. Confirm rows.length > 0, totalDebits === totalCredits, all four crossChecks reconcile.
- [ ] **(Windows + QB) Carried — Phase 18 #85 / #86 first live exercises** (still pending). `qb_closing_date_get` wire shape; `qb_closing_date_set` returns 9005 with UI navigation; all five MCP prompts surface in Claude Desktop's `/` picker.
- [ ] **(Windows + QB) Carried — `qb_session_status` first live exercise** (still pending). Zero wire I/O on the default + fail-soft probe/closingDate.
- [ ] **(Windows + QB) Carried — #84 transient-retry path, #82 host_query field surface, #55 W-2 wire shape, #59 attachment enablement, #54 SCF section labels.** All verified-by-construction structurally but not live-pinned. Lowest priority.

## Next Task

**Operator picks next.** With #75 closed, the highest-leverage remaining items in roughly descending operator-value order:

- **#71 `qb_client_packet(customerListId, taxYear)`** (Phase 15) — bundles TB (#68, ready) + GL (#53) + bank rec discrepancy (#56) + payroll summary (#55) + fixed asset detail. Workflow run 2,000 times per tax season. Composite that calls existing tools — every prerequisite is now in place. Cheap composite to ship.

- **#78 time tracking** (Phase 17) — `qb_time_track_add` / `_list`. `TimeTrackingAddRq` / `TimeTrackingQueryRq`. Unblocks #70 (`qb_engagement_profitability`) which can't compute hours-per-job without it. Also blocks any service-business billing-by-time workflow.

- **#70 `qb_engagement_profitability(customerListId, dateRange)`** (Phase 15) — pulls revenue + time + reimbursable expenses for a job. Needs #78 (time tracking) first.

- **#76 sales orders** (Phase 17) — `qb_sales_order_create` / `_list` / `_update` / `_delete` / `_convert_to_invoice`. Same shape as #75 — pure composite over existing primitives. Sales orders are tracked in `isTransactionType` already.

- **#77 sales tax / #80 inventory adjustments / #81 statement charges** (Phase 17) — remaining domain coverage gaps.

- **Phase 13–14 coverage gaps** — DataExt (#61), sub-customer (#62), memo search (#63), dry-run (#64), better errors (#65), audit log (#66 — Enterprise-only).

## Context Notes

- **#75 EntityFilter strict improvement is load-bearing.** `handleQuery` now matches `PayeeEntityRef` in addition to `CustomerRef`/`VendorRef`. This affects every transaction type that uses `PayeeEntityRef` — Check (primary user), `BillPaymentCheck`, `BillPaymentCreditCard`, `CreditCardCharge`, `CreditCardCredit`. If a future test passes `EntityFilter: { FullName: "X" }` to one of these stores and expects ALL rows to come back (i.e. expects the filter to NOT match), the test is wrong — the filter now matches correctly.

- **#75 `computeTotals` Check.Amount / Deposit.DepositTotal derivation is "set when undefined, preserve explicit overrides".** Mirrors Bill's `AmountDue` pattern exactly. On line mod, `handleMod` deletes the header field BEFORE calling `computeTotals` so the re-derive fires. If a tool ever needs to set `Check.Amount` independent of lines (e.g. a fee or service charge that shouldn't be reflected in the line set), that explicit override survives create but will be wiped on a line mod — same trap Bill has, document loudly if it bites.

- **#75 Transfer self-transfer guard is tool-layer-only.** `qb_transfer_create` rejects same-account From/To with statusCode 3120 BEFORE any wire I/O. The sim's `handleAdd` doesn't enforce this; a direct `session.addEntity("Transfer", { TransferFromAccountRef: ..., TransferToAccountRef: <same>, ... })` will succeed in sim. Future tests should call through the tool, not raw `addEntity`, if they want to exercise the guard.

- **#75 Inventory site transfers (`TransferInventoryAddRq`) intentionally not exposed.** Enterprise-only, distinct from `TransferAddRq` (cash). Belongs under #80. If a user asks "transfer inventory between sites", route them to `qb_inventory_adjustment_*` (once #80 ships) rather than `qb_transfer_*`.

- **#75 tool descriptions warn against the AR/AP wrong-tool trap.** `qb_check_create` description says "for paying an EXISTING bill use `qb_bill_pay`" (different txn type — `BillPaymentCheck` — that moves vendor balance). `qb_deposit_create` description explains the two-step AR workflow (qb_payment_receive into Undeposited Funds first, then `qb_deposit_create` from Undeposited Funds to bank). Operators (and agents) who confuse these will post twice or move the wrong balance.

- **#75 sim store does NOT move bank `Account.Balance` on Deposit/Transfer/Check.** Matches existing precedent (Invoice/Bill don't move their AR/AP `Account.Balance` either; sim only moves `Customer.Balance`/`Vendor.Balance`). Reports (`qb_balance_summary`, `qb_pnl_report`, `qb_balance_sheet_report`) read `Account.Balance` for static snapshots and walk line postings for period activity — the line walks pick up the new banking entries correctly via `txnPostingsToBankAccount` / `walkBankActivity`. If a future test expects `Bank.Account.Balance` to MOVE on Deposit creation, the test is wrong; the snapshot is intentionally static.

- **Carried gotchas (unchanged from prior handoffs):**
  - **#67 default path is zero wire I/O** — don't add wire calls to the default path. Use `probe: true` for active probing.
  - **#67 fail-soft on `probe` / `includeClosingDate`** — failures land INSIDE the response, not as `isError`.
  - **#68 `RECON_TOLERANCE = 0.01`** is the bookkeeping standard.
  - **#68 sim seed has deliberate AR/AP drift** — pinned by e2e tests asserting the cross-check FIRES (not that the seed reconciles).
  - **#68 contra-balance column flip is load-bearing** — matches CPA workpaper convention.
  - **#68 `Account.AccountNumber` is a string** (`1000-1`, `1000.A` etc.) — sort uses `localeCompare`, not numeric.
  - **#69 "Mapped" definition** — `TaxLineInfoRet.TaxLineName` non-empty. `TaxLineID` alone → unmapped row, but `taxLineId` preserved as audit signal.
  - **#69 sim seed leaves Savings + Consulting Revenue UNMAPPED** — tests pin `mappedCount: 8` / `unmappedCount: 2`.
  - **#85 SDK gap is permanent** — `qb_closing_date_set` always returns 9005 + UI navigation. Do not speculatively wire a `PreferencesModRq` builder.
  - **Synthetic statusCodes**: 9001 read-only, 9002 idempotency conflict, 9003 edition unsupported, 9004 payroll subscription required, 9005 SDK has no write path, 9006+ reserved.
  - **#86 prompts registration uses a `reg<Args>(entry)` helper + `as const` tuple** — load-bearing.
  - **Three transaction-type lists must stay in sync**: `buildDeleteRequest` in [src/qbxml/builder.ts](src/qbxml/builder.ts), inline `isTransaction` in `manager.deleteEntity` ([src/session/manager.ts](src/session/manager.ts)), `isTransactionType` in [src/session/simulation-store.ts](src/session/simulation-store.ts). Canonical 16-type set in [CLAUDE.md](CLAUDE.md).
  - **AR-side `Customer.Balance` discount math is correct; AP-side is NOT.** Future `qb_bill_write_off` needs the parallel fix.
  - **Dispatch order in `processRequest`**: non-entity-typed `*QueryRq` / `*ModRq` / `AttachableAddRq` branches MUST precede the `endsWith` catch-alls.
  - **Iterator wire names diverge**: `iterator`/`iteratorID` on request, `iteratorRemainingCount`/`iteratorID` on response.
  - **fast-xml-parser does NOT decode numeric character entities** — use `decodeXmlEntities` in [parser.ts](src/qbxml/parser.ts).
  - **fast-xml-parser DOES coerce numeric-looking text to numbers** — `<CheckNumber>1001</CheckNumber>` parses back as `1001` (number), not `"1001"` (string). If a test sends a numeric-string field into the sim and reads it back, wrap the assertion in `String(...)`.
  - **Live verification requires `C:\nvm4w\nodejs\node.exe` v20.20.2** (system PATH v22 breaks winax).
  - **QBXMLRP2 cannot OPEN a `.qbw`**, only attach to one QB Desktop has already loaded.
  - **BillPayment* total is on `TotalAmount`**, not `Amount` — coalesce `TotalAmount ?? Amount`.
  - **Bill ItemLineAdd in test fixtures should pass explicit `Amount`** (or use Rate).
