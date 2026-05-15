# Handoff State

_Last updated: 2026-05-15. **README sync landed.** Tool count surfaces in [README.md](README.md) bumped 120 → 124 in two places (`## Tools (X total)` header + architecture-diagram inset). Two new sections added: `### Time Tracking` (between Employees and Reference Lists, documents `qb_time_track_list` / `qb_time_track_add` + the non-posting nature + `TimeTrackingQueryRq`'s missing-`CustomerFilter` post-filter caveat + the derived `hours` decimal) and `### Workpaper Composites` (between Reports & Queries and Attachments, documents `qb_client_packet` + `qb_engagement_profitability` + the shared fail-soft `sectionStatus` contract + the synthetic `9003`/`9004` payroll codes). Architecture diagram structure unchanged (no new layers). True source-of-truth tool count is **124** (enumerated by counting `server.tool('qb_...')` calls in `src/tools/` — prior handoffs claimed 123, off by one). No source changes; build + tests + simulation banner unchanged from #70 closure._

## Last Session Summary

- **README sync — DONE.** Four edits total: tool count `120 → 124` at [README.md:12](README.md#L12) (`## Tools (124 total)`) + [README.md:350](README.md#L350) (architecture diagram `(124 tools)`); new `### Time Tracking` section at [README.md:188-198](README.md#L188-L198) covering `qb_time_track_list` + `qb_time_track_add` with the intro paragraph pinning the non-posting nature + the post-filter caveat on customer scope (QB's `TimeTrackingQueryRq` has no `CustomerFilter` at any qbXML version — same caveat the tool description carries); new `### Workpaper Composites` section at [README.md:242-253](README.md#L242-L253) covering `qb_client_packet` + `qb_engagement_profitability` with the intro paragraph pinning the shared fail-soft `sectionStatus: 'ok' | 'error' | 'skipped'` contract + synthetic `9003`/`9004` payroll status codes.

- **Tool count discrepancy resolved.** Source-of-truth enumeration via `[regex]::Matches($c, "server\.tool\(\s*['""]([a-z0-9_]+)['""]")` against [src/tools/*.ts](src/tools) yields **124 distinct registered tools** (every `server.tool` call across 26 tool files; 124 occurrences, 124 unique names — no duplicates). Prior handoffs claimed 122 → 123 with #70; the actual jump was 123 → 124. The off-by-one likely entered during one of #71/#75/#78's tool-count math.

- **No source changes this session.** No new files, no Edits to `src/`, no test additions. Build state inherited from #70 closure — `npm run build` clean, `npm test` green at 47 files / 1116 tests, `node dist/index.js` boots with `Mode: simulation` banner.

## Verify Before Continuing

Re-run if the tree has been touched (skip if next session starts within hours):

- [ ] `npm run build` → exit 0 (tsc clean).
- [ ] `npm test` → `Test Files 47 passed | Tests 1116 passed`.
- [ ] `"" | & node dist/index.js` → exit 0, `Mode: simulation` printed.
- [ ] **(Windows + QB) First live exercise of #70.** Connect to `VR Tax & Consulting Inc..qbw`. Run `qb_engagement_profitability({ customerName: "<one active tax-prep client>", fromDate: "2024-01-01", toDate: "2024-12-31" })` and confirm: (1) `success: true`; (2) `customer` carries `fullName` + `balance`; (3) `sections.revenue.netRevenue` matches the operator's mental model for that client; (4) `sections.time.totalHours` reflects any TimeTracking entries logged against that customer (likely zero unless the operator has been logging time — most CPAs don't, so this is mostly empty); (5) `sections.reimbursableExpenses.lines` surfaces any job-costed Bill/Check expense lines (also commonly empty for most clients); (6) `summary` block emits when all three sections succeed. The composite layers EIGHT different `*QueryRq` wire types — any schema-order class of bug from any of them will surface here (the same risk #71 carries, now wider).
- [ ] **(Windows + QB) Carried — #78 time tracking first live exercise.** Run `qb_time_track_add` against a real employee + service item; capture envelope via `QB_DEBUG_QBXML=1` if `TimeTrackingAddRq` rejects with statusCode -1 (schema-order class of bug). Canonical child order: `TxnDate → EntityRef → CustomerRef → ItemServiceRef → Duration → ClassRef → PayrollItemWageRef → Notes → IsBillable → BillableStatus`.
- [ ] **(Windows + QB) Carried — #71 qb_client_packet first live exercise.** Six different *QueryRq wire types.
- [ ] **(Windows + QB) Carried — #75 banking primitives first live exercise.** `qb_deposit_create` / `qb_check_create` / `qb_transfer_create` + list / delete companions.
- [ ] **(Windows + QB) Carried — #69 `qb_tax_line_mapping` + #68 `qb_trial_balance_export` first live exercises** against `VR Tax & Consulting Inc..qbw`.
- [ ] **(Windows + QB) Carried — Phase 18 #85 / #86 first live exercises** of `qb_closing_date_get` / `qb_closing_date_set` (9005 + UI navigation) / all five MCP prompts in Claude Desktop's `/` picker.
- [ ] **(Windows + QB) Carried — `qb_session_status` first live exercise** (zero wire I/O default + fail-soft probe/closingDate).
- [ ] **(Windows + QB) Carried — #84 transient-retry path, #82 host_query field surface, #55 W-2 wire shape, #59 attachment enablement, #54 SCF section labels.** Lowest priority.

## Next Task

**Operator picks next.** With #70 closed + README sync done, the highest-leverage remaining items in roughly descending operator-value order:

- **#76 sales orders** (Phase 17) — `qb_sales_order_create` / `_list` / `_update` / `_delete` / `_convert_to_invoice`. Same shape as #75 banking primitives — pure composite over existing primitives. Sales orders are tracked in `isTransactionType` already.

- **#77 sales tax / #80 inventory adjustments / #81 statement charges** (Phase 17) — remaining domain coverage gaps.

- **Phase 13–14 coverage gaps** — DataExt (#61), sub-customer (#62), memo search (#63), dry-run (#64), better errors (#65), audit log (#66 — Enterprise-only).

## Context Notes

- **Authoritative tool count is 124** (not 123 as prior handoffs claimed). Confirmed by enumerating `server.tool('qb_...')` calls in [src/tools/*.ts](src/tools) — 124 distinct names. README + architecture diagram now both reflect 124. If a future session adds tools, recount the same way (`Get-ChildItem src\tools -Filter *.ts | Select-String "server\.tool\(\s*[`"']qb_"` in PowerShell, or grep equivalent) — don't blindly increment from a HANDOFF figure.

- **README structure landed:** Time Tracking section sits between Employees and Reference Lists; Workpaper Composites section sits between Reports & Queries and Attachments. Architecture diagram (the ASCII box) is unchanged — only the `(124 tools)` inset string was edited. If you add a new tool category section, mirror the existing pattern: optional intro paragraph(s) explaining the underlying QB primitive's quirks, then a `| Tool | Description |` table.

- **README intro paragraphs for both new sections deliberately mirror the tool descriptions** — repeating the non-obvious gotchas (TimeTrackingQueryRq's missing CustomerFilter, fail-soft sectionStatus contract, line-level CustomerRef on bills/checks for job-costing) so a reader skimming the README catches the same warnings without drilling into the tool description string in source. Pattern to follow for future composite tools.

- **Carried gotchas (unchanged from #70's handoff — all still apply):**
  - **#70 `IncludeLineItems: true` is LOAD-BEARING** for any tool that walks line-level data on Bill/Check/CreditCardCharge. Both sim ([src/session/simulation-store.ts](src/session/simulation-store.ts) `handleQuery` ~line 425) and real QB strip `*LineRet` from query responses without it. Initial #70 cut omitted the flag and every reimbursable-expense test failed with `lineCount: 0`. Pinned in 4 tests.
  - **#70 customer scope on time is POST-FILTERED.** QB's `TimeTrackingQueryRq` has NO `CustomerFilter` at any qbxml version. Pull the wire response with `TxnDateRangeFilter` only, then filter in-process by `CustomerRef`. `qb_engagement_profitability` does NOT paginate (capped at MAX_ROWS_PER_CALL=500 per fetch).
  - **#70 customer scope on Bill/Check/CCC is LINE-LEVEL.** Bills carry `VendorRef` on the header (whom you paid), not `CustomerRef` (which job it was for). Job-costing tags ride on each line — `ExpenseLineRet[i].CustomerRef` and `ItemLineRet[i].CustomerRef`. The matched-line total is what counts toward THIS customer's engagement, NOT the parent bill total.
  - **#70 summary OMITTED when any section is error or any toggle off.** Partial profitability silently misreports gross profit. Caller MUST branch on `sectionStatus` to know whether `summary` is trustworthy.
  - **#70 customer lookup is the one non-fail-soft path.** Unknown customer / `CustomerQueryRq` failure fails the whole tool with `'pre-flight failed:'` prefix.
  - **#70 first cross-tool consumer of `parseDurationToHours`** from [src/tools/time-tracking.ts](src/tools/time-tracking.ts). Imports directly. Future tools that compute hours-from-Duration should follow suit — don't re-implement the parser.
  - **#70 `customerRefMatches` accepts EITHER ListID OR FullName match.** ListID match is the canonical form (immutable identifier); FullName is a fallback for stores that happen to have only the name on the ref.
  - **#78 EntityFilter priority reorder** — `handleQuery` does `EntityRef ?? CustomerRef ?? VendorRef ?? PayeeEntityRef`. TimeTracking is the ONLY transaction type with both EntityRef and CustomerRef populated; EntityFilter on TimeTracking targets the WORKER per QB SDK.
  - **#78 Duration is ISO 8601 PT-H-M-S only.** No day component. Empty `PT` rejected.
  - **#78 IsBillable + BillableStatus co-emission.** Both fields set on add when `billable` arg is supplied; both absent when unset.
  - **#71 fail-soft contract** — `sections.<name>` is either the success payload OR an `{ error: {...} }` block; `sectionStatus.<name>` is `'ok' | 'skipped' | 'error'`. #70 follows the same pattern.
  - **#71 payroll has THREE skip states** — Pro → 9003, wire-zero → 9004, probe-fail → error.
  - **#71 GL defaults to PnLOnly scope** for cost reasons.
  - **#71 customerListId / customerName is OPTIONAL CONTEXT, NOT A FILTER.** Underlying sections are WHOLE-FILE. #70 INVERTS this — customer IS the engagement, customer is REQUIRED.
  - **#71 AccountQueryRq failure is the only non-fail-soft path** for #71; #70's parallel is CustomerQueryRq failure.
  - **#75 EntityFilter strict improvement** — `handleQuery` matches `PayeeEntityRef` for Check / BillPaymentCheck / BillPaymentCreditCard / CreditCardCharge / CreditCardCredit.
  - **#75 `computeTotals` Check.Amount / Deposit.DepositTotal** — "set when undefined, preserve explicit overrides".
  - **#75 Sim does NOT move `Bank.Account.Balance`** on Deposit/Transfer/Check.
  - **#67 default path is zero wire I/O.** Probe is opt-in.
  - **#68 RECON_TOLERANCE = 0.01.** AR/AP drift in sim seed is deliberate.
  - **#69 "Mapped" definition** — TaxLineName non-empty. TaxLineID alone is unmapped.
  - **#85 SDK gap is permanent** — `qb_closing_date_set` always 9005 + UI navigation.
  - **Synthetic statusCodes**: 9001 read-only, 9002 idempotency conflict, 9003 edition unsupported, 9004 payroll subscription required, 9005 SDK has no write path.
  - **#86 prompts registration** uses `reg<Args>(entry)` helper + `as const` tuple.
  - **Three transaction-type lists must stay in sync** across builder / manager / simulation-store. #78 added TimeTracking to all three.
  - **AR-side `Customer.Balance` discount math is correct; AP-side is NOT** — future `qb_bill_write_off` needs the parallel fix.
  - **Dispatch order in `processRequest`**: non-entity-typed `*QueryRq` / `*ModRq` / `AttachableAddRq` MUST precede the `endsWith` catch-alls.
  - **Iterator wire names diverge**: `iterator`/`iteratorID` on request, `iteratorRemainingCount`/`iteratorID` on response.
  - **fast-xml-parser does NOT decode numeric character entities** — use `decodeXmlEntities`.
  - **fast-xml-parser DOES coerce numeric-looking text to numbers** — `<CheckNumber>1001</CheckNumber>` → `1001` (number), not `"1001"`.
  - **Live verification requires `C:\nvm4w\nodejs\node.exe` v20.20.2** (system PATH v22 breaks winax).
  - **QBXMLRP2 cannot OPEN a `.qbw`**, only attach to one QB Desktop has already loaded.
  - **BillPayment* total is on `TotalAmount`**, not `Amount` — coalesce `TotalAmount ?? Amount`.
