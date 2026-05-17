# Handoff State

_Last updated: 2026-05-17. **Phase 14 #65 shipped — better error surfaces with heuristic field hints + canonical schema-order lookup.** Cross-cutting infrastructure change: no new tools, 28 tool files refactored, 48 new tests. Tool count unchanged at **146**. Tests **1367 → 1415** (+48 new)._

## Last Session Summary

- **#65 better error surfaces — DONE.** Every tool catch block now passes thrown errors through `formatToolError(err, { fallbackMessage })`, which adds a heuristic-derived `hint` block to the response payload when the QB error message contains a recognizable pattern. The hint surfaces the offending field name, the error class (`missing-element` / `invalid-argument` / `out-of-order` / `invalid-ref` / `empty-element`), the canonical schema-order for every `*QueryRq` / `*ModRq` / `*AddRq` that declares the field, and an imperative one-sentence guidance string the agent can act on directly.

- **Three-piece delivery:**
  - **[src/util/qbxml-schema-order.ts](src/util/qbxml-schema-order.ts)** — new module exporting `SCHEMA_ORDER: Record<string, readonly string[]>` covering 50+ request types (list entities, transaction entities, reports, cross-cutting) + `findSchemaOrderForField(field, limit=20)` reverse-index. Source of truth for BOTH the runtime hint AND the inline-pinned sequences in `tests/builder-emit-order.test.ts`; new consistency-check block in that test file asserts every inline-pinned subsequence is contained in its `SCHEMA_ORDER` entry (catches drift between the two surfaces).
  - **[src/util/format-tool-error.ts](src/util/format-tool-error.ts)** — new tool-side wrapper. `parseQbErrorHint(message)` runs 14 regex patterns across 5 kinds, ordered by specificity (out-of-order > missing-element > empty-element > invalid-ref > invalid-argument). `formatToolError(err, options?)` builds the standard tool-response payload (`success:false, statusCode, statusMessage, humanReadable?, hint?`) and merges optional non-reserved `extra` fields. Includes a small `DISPLAY_LABEL_TO_ELEMENT` map normalizing QB's human display labels (`"Transaction id"`, `"List id"`, `"Edit sequence"`, etc.) to XML element names before the schemaOrder lookup — surfaces canonical sequences even when QB quotes the UI label rather than the XSD name (real-live behavior, captured during verification).
  - **Mechanical sweep** via [scripts/refactor-error-wrappers.mjs](scripts/refactor-error-wrappers.mjs) — codemod migrated 137 of 151 standard catch-block boilerplates across 28 tool files from a 14-line inline payload-builder to a 1-line `formatToolError(err, { fallbackMessage })` call. 4 outliers (bills.ts `op` variable case, custom-fields.ts formatting variant, form-1099.ts custom `errorResponse` helper) migrated by hand. Engagement-profitability + client-packet section-level error shapes (`return { error: {...} }` inside a SUCCESS response) intentionally NOT migrated — different surface, not a tool error response.

- **Status-code table extended** ([src/util/qb-status-codes.ts](src/util/qb-status-codes.ts)) with two codes that surfaced during live verification:
  - **3000** — invalid object identifier (often a stale TxnID or ListID)
  - **3110** — invalid enumerated value or argument

- **Live verification — 2 of 5 probes deliver fully-enriched hints.** [scripts/verify-item65-error-hints.mjs](scripts/verify-item65-error-hints.mjs) exercised five deliberate error paths against the operator's open `VR Tax & Consulting Inc..qbw`:
  - **Probe 2 (invalid PaidStatus enum)** → statusCode 3110, kind:`invalid-argument`, field:`PaidStatus`, schemaOrder shows both canonical InvoiceQueryRq + BillQueryRq sequences with PaidStatus visible at position 10.
  - **Probe 5 (bogus TxnID on InvoiceMod)** → statusCode 3000, kind:`invalid-ref`, field:`Transaction id` (display label) normalized to `TxnID` for the lookup, schemaOrder surfacing 20 candidate transaction `*QueryRq` types with guidance summary capped at 3-named + count for scannability.
  - **Probes 1 / 3 / 4 (CustomerAdd missing Name; CustomerQuery FullName-not-found; AccountQuery invalid AccountType enum)** → bare `statusCode -1` "QuickBooks found an error when parsing the provided XML text stream". QBXMLRP2's XSD validation layer rejected the request structure BEFORE reaching the business-message layer; no field name in the message to extract. Wrapper degrades silently. This is the genuine ceiling of message-text heuristics for the XSD-rejection case — nothing the heuristic layer can do.

- **48 new tests** — 30 in [tests/format-tool-error.test.ts](tests/format-tool-error.test.ts) (heuristic patterns + degrade paths + extras merge + reserved-key protection + display-label normalization + status code table) + 14 SCHEMA_ORDER consistency checks in [tests/builder-emit-order.test.ts](tests/builder-emit-order.test.ts) + 4 supporting tests. 1367 → 1415 tests green.

- **`ToolErrorResponse` open index signature.** The MCP SDK's `server.tool` callback expects a return shape with an open string-indexed signature (so it can merge `_meta` etc.). Added `[key: string]: unknown` to the helper's return type — keeps the helper assignable at every callsite without per-tool casts.

- **Cosmetic note:** the codemod's `formatToolError` import insertion sometimes lands on the line immediately following the qb-status-codes import without preserving the blank line between imports and code. Doesn't affect compilation or correctness — Prettier or a future cleanup pass would restore consistent spacing.

## Verify Before Continuing

Re-run if the tree has been touched (skip if next session starts within hours):

- [ ] `npm run build` → exit 0 (tsc clean).
- [ ] `npm test` → `Test Files 55 passed | Tests 1415 passed`.
- [ ] `"" | & node dist/index.js` → exit 0, `Mode: simulation` printed.
- [ ] **(Windows + QB) #65 live re-verification.** Re-run [scripts/verify-item65-error-hints.mjs](scripts/verify-item65-error-hints.mjs) against `VR Tax & Consulting Inc..qbw` — should show 2/5 enriched (Probe 2 + Probe 5) and 3/5 bare-parse-error. If probe count drifts, the heuristic regex set has regressed.
- [ ] **(Windows + QB) Carried — #61 first live exercise** (DataExt custom-field read cycle: `qb_custom_field_list({})` → `qb_custom_field_list({ assignToObject: "Customer" })` → `qb_customer_list({ includeCustomFields: true })` → `qb_customer_list({})`). Steps in prior handoff under git log `6d2eb80`.
- [ ] **(Windows + QB) Carried — #72 / #79 / #81 / #80 / #77 / #76 / #70 / #78 / #71 / #75 / #69+#68 / Phase 18 #85+#86 / `qb_session_status` / #84 / #82 / #55 / #59 / #54 live exercises.** Lowest priority.

## Next Task

**Operator picks next.** With #65 closed, the remaining Phase 14 cluster is two items + the other clusters below:

- **Phase 13 — Data model gaps (remaining)** — customer contact in invoice list (#60), sub-customer/job helpers (#62), memo full-text search (#63).
- **Phase 14 — Safety + DX (remaining)** — dry-run mode (#64), audit log read on Enterprise (#66).
- **Phase 16 follow-ons** — streaming responses (#73), MCP-side caching of stable lookups (#74).
- **#65 follow-on opportunities:**
  - **Extend the schema-order map** to cover more obscure request types as they're added. Current 50+ entries cover every request the server currently emits.
  - **Extend the heuristic regex set** as new QB error patterns surface in live use. Cheapest path: when a `statusCode != -1` error arrives with `hint: absent`, log the raw message and craft a new regex for it (the [scripts/verify-item65-error-hints.mjs](scripts/verify-item65-error-hints.mjs) flow is the template).
  - **Extend `DISPLAY_LABEL_TO_ELEMENT`** in [src/util/format-tool-error.ts](src/util/format-tool-error.ts) as new display labels surface. Currently 12 entries — the ones observed live (`"Transaction id"`) plus close-relatives (`"Ref number"` / `"Edit sequence"` / etc.) and the structural reference labels (`"Customer ref"` / `"Vendor ref"` / etc.).
  - **Apply hint-enrichment to the section-level error shapes** in engagement-profitability.ts + client-packet.ts. Their `return { error: {...} }` blocks could carry the same hint object; would require a separate helper or a shape adapter. Low-priority — those tools' section errors are typically section-scope failures (one of N sections didn't compute), not raw QB rejections.
  - **DataExt write surface (#61 V2):** if a real workflow surfaces, add `qb_custom_field_set` / `qb_custom_field_delete` wrapping `DataExtAdd` / `DataExtDel`.
  - **VehicleMileage delete:** thin tool over `deleteEntity("VehicleMileage", txnId)`.
  - **StatementCharge in ReceivePayment.AppliedToTxn:** extend `validateTxnApplications` to walk both Invoice AND StatementCharge stores.
  - **JournalEntry in `qb_transaction_list`:** extend sim's `handleQuery` `EntityFilter` chain to peek per-line `EntityRef` for JE.

## Context Notes

- **#65 architecture posture — tool-side wrapper, not manager-side.** The hint enrichment happens INSIDE the tool's catch block, not inside `QBSessionManager.sendRequest`. Rationale: the wrapper consumes the same `QBXMLResponseError` (or any object with `.message` + `.statusCode`) every tool already catches; lifting it up to the manager would require the manager to know about MCP response shapes (`content[0].text` etc.) which it currently doesn't. Cleaner division: manager throws structured errors, tools format them into MCP-shaped responses with enrichment.

- **#65 heuristic specificity ordering matters.** The `RULES` array in [src/util/format-tool-error.ts](src/util/format-tool-error.ts) is ordered out-of-order → missing-element → empty-element → invalid-ref → invalid-argument. First match wins. The defensive ordering means a message like `"Element <X> is invalid and out of order"` correctly classifies as `out-of-order` (more specific) rather than `invalid-argument` (more general). Pinned by the `"out-of-order specificity"` test.

- **#65 regex case-sensitivity.** The `FIELD` capture pattern is `([A-Z][A-Za-z0-9]+)` — case-sensitive for the first letter so we only pick up capitalized QBXML identifiers, not arbitrary lowercase words. The `i` regex flag is NOT used (would break field extraction). Where QB capitalizes inconsistently (sentence-start vs mid-sentence), explicit `[Ii]nvalid` / `[Tt]he` alternations are used.

- **#65 "the field "X"" is QB's canonical live pattern.** Observed in BOTH invalid-enum and invalid-id rejections during live verification. Two patterns capture it: `value\s+"..."\s+in the field\s+"(X)"` for invalid-argument, `object ID\s+"..."\s+in the field\s+"(X)"\s+is invalid` for invalid-ref. The QB-quoted field is the human display label (e.g. `"Transaction id"`), normalized to the XML element name (`TxnID`) before schemaOrder lookup.

- **#65 codemod is idempotent.** Re-running [scripts/refactor-error-wrappers.mjs](scripts/refactor-error-wrappers.mjs) on a tree that's already been migrated reports `0 blocks migrated` per file. Safe to re-run if more catch-block boilerplate is added later — the codemod will pick up the new ones without disturbing already-migrated callsites. The import-management path correctly handles "imports got added but blocks didn't migrate this pass" (e.g. when a file was edited by hand between runs).

- **#65 schemaOrder cap at 20 candidates.** `findSchemaOrderForField(field, limit=20)` returns at most 20 matching request types. `OwnerID` and `TxnID` are the high-fan-out fields (~14 and ~20 respectively); 20 covers both with room. Bumping the limit is cheap — pure JS, no I/O.

- **Carried gotchas (unchanged from prior handoffs — all still apply):**
  - **#61 architecture posture — READ-ONLY V1** mirrors Phase 10 #41 IncludeLineItems. Default-strip + opt-in-flag pattern.
  - **#61 OwnerID positioning — schema tail.** OwnerID is LAST child in every entity *QueryRq.
  - **#61 alien-namespace contract.** Unknown OwnerID strips `DataExtRet` entirely rather than emitting an empty array.
  - **#72 architecture posture — COMPOSITE over typed queries, NOT a single `TransactionQueryRq`.**
  - **#72 JournalEntry NOT exposed.** Sim's `handleQuery` `EntityFilter` chain walks header refs only.
  - **#72 `maxPerType` is per-type, not aggregate.**
  - **#79 VehicleMileage has NO `TxnDate` field.** TripStartDate / TripEndDate are the canonical timestamps.
  - **#79 VehicleMileage is non-posting + immutable from SDK perspective.** No `VehicleMileageModRq` exists.
  - **#79 four-list sync** for any new transaction type: `isTransaction` in [src/qbxml/builder.ts](src/qbxml/builder.ts), `isTransaction` in [src/session/manager.ts](src/session/manager.ts), `isTransactionType` in [src/session/simulation-store.ts](src/session/simulation-store.ts), AND the CLAUDE.md doc list.
  - **#81 StatementCharge is single-row-at-header** — no `*LineAdd` array.
  - **#81 ReceivePayment limitation.** `validateTxnApplications` hardcodes the Invoice store.
  - **#80 InventoryAdjustment is the first transaction type that mutates ItemInventory state.**
  - **#80 NO `_update` tool** — operational pattern is delete + recreate.
  - **#76 SalesOrder is non-posting** — Customer.Balance does NOT move on SO add or delete.
  - **#70 `IncludeLineItems: true` is LOAD-BEARING** for any tool that walks line-level data on Bill/Check/CreditCardCharge/SalesOrder.
  - **#70 customer scope on time is POST-FILTERED.**
  - **#70 customer scope on Bill/Check/CCC is LINE-LEVEL.**
  - **#70 `customerRefMatches` accepts EITHER ListID OR FullName match.**
  - **#78 EntityFilter priority reorder** — `handleQuery` does `EntityRef ?? CustomerRef ?? VendorRef ?? PayeeEntityRef`.
  - **#78 Duration is ISO 8601 PT-H-M-S only.**
  - **#71 fail-soft contract** — `sections.<name>` is either success payload OR `{ error: {...} }`.
  - **#71 payroll has THREE skip states** — Pro → 9003, wire-zero → 9004, probe-fail → error.
  - **#75 EntityFilter strict improvement** — `handleQuery` matches `PayeeEntityRef` for Check / BillPaymentCheck / BillPaymentCreditCard / CreditCardCharge / CreditCardCredit.
  - **#67 default path is zero wire I/O.** Probe is opt-in.
  - **#85 SDK gap is permanent** — `qb_closing_date_set` always 9005 + UI navigation.
  - **Synthetic statusCodes**: 9001 read-only, 9002 idempotency conflict, 9003 edition unsupported, 9004 payroll subscription required, 9005 SDK has no write path. **NEW (from #65 live):** 3000 invalid object identifier, 3110 invalid enumerated value (real QB codes, not synthetic).
  - **AR-side `Customer.Balance` discount math is correct; AP-side is NOT** — future `qb_bill_write_off` needs the parallel fix.
  - **Dispatch order in `processRequest`**: non-entity-typed `*QueryRq` / `*ModRq` / `AttachableAddRq` / `DataExtDefQueryRq` MUST precede the `endsWith` catch-alls.
  - **Iterator wire names diverge**: `iterator`/`iteratorID` on request, `iteratorRemainingCount`/`iteratorID` on response.
  - **fast-xml-parser does NOT decode numeric character entities** — use `decodeXmlEntities`.
  - **fast-xml-parser DOES coerce numeric-looking text to numbers**.
  - **Live verification requires `C:\nvm4w\nodejs\node.exe` v20.20.2** (system PATH v22 breaks winax).
  - **QBXMLRP2 cannot OPEN a `.qbw`**, only attach to one QB Desktop has already loaded.
  - **BillPayment* total is on `TotalAmount`**, not `Amount` — coalesce `TotalAmount ?? Amount`.
