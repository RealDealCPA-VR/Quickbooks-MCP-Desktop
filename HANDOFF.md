# Handoff State

_Last updated: 2026-05-17. Phase 13 #60 shipped — customer-contact join on `qb_invoice_list`. Tests **1415 → 1423**. Tool count unchanged at **146**._

## Last Session Summary

- **#60 customer-contact join — DONE.** New `includeCustomerContact: boolean` arg on `qb_invoice_list` triggers a single follow-up `CustomerQueryRq` scoped to the unique `CustomerRef.ListID`s in the invoice result. Each invoice gains a `customerContact` sub-object surfacing only the present fields from: `Email` / `Phone` / `AltPhone` / `Fax` / `Contact` / `AltContact` / `CompanyName` / `FirstName` / `MiddleName` / `LastName` / `JobTitle`. Replaces the per-customer `qb_customer_list` round trip the collection-email workflow used to require.

- **Delivery:**
  - Helper `enrichInvoicesWithCustomerContact` + projection helper `pickContactFields` in [src/tools/invoices.ts](src/tools/invoices.ts) — sits above `registerInvoiceTools`. Mutates the invoice rows in place.
  - Wired into both query paths: the non-paginated `queryEntity` call and the `queryEntityPaginated` iterator path.
  - Dedup at the query layer — one CustomerQueryRq batched over the unique ListIDs, not one call per invoice. Falls back to a parallel FullName-batched query only when an invoice CustomerRef lacks ListID (rare in live QB; happens with sim-added invoices that pass `CustomerRef: { FullName }`).
  - Fail-soft: a CustomerQueryRq wire failure surfaces as a `warning` field on the response without poisoning the primary InvoiceQueryRq result.

- **Tests:** 8 new in [tests/customer-contact-on-invoice.test.ts](tests/customer-contact-on-invoice.test.ts) across 3 layers (happy path / paginated path / fail-soft). One-call-many-invoices dedup is pinned via `vi.spyOn(session, "queryEntity")`.

- **README invoice table updated.** [src/index.ts](src/index.ts) instructions block intentionally NOT touched — the per-tool description on `qb_invoice_list` covers it sufficiently and matches the convention for the other list-tool flags (`includeLineItems` / `includeCustomFields` aren't called out at the index level either).

## Verify Before Continuing

Re-run if the tree's been touched. Skip if next session starts within hours.

- [ ] `npm run build` → exit 0 (tsc clean).
- [ ] `npm test` → `Test Files 56 passed | Tests 1423 passed`.
- [ ] `"" | & node dist/index.js` → exit 0, `Mode: simulation` banner printed.
- [ ] **(Windows + QB)** First live exercise of #60: `qb_invoice_list({ includeCustomerContact: true, customerName: "<an open-AR client>" })`. Expected: `customerContact: { Email, Phone, … }` on each invoice; `warning` field absent. Then a stress probe: `qb_invoice_list({ includeCustomerContact: true, paginate: true })` against the open books — should hit dozens of unique customers in one extra CustomerQueryRq call.
- [ ] **(Windows + QB)** — re-run `& "C:\nvm4w\nodejs\node.exe" scripts\verify-item65-error-hints.mjs` against the open books. Expected: `probes with enriched hint : 2/5`. Drift here means a heuristic regression.
- [ ] **(Windows + QB) Carried — #61 first live exercise.** DataExt custom-field read cycle: `qb_custom_field_list({})` → `({ assignToObject: "Customer" })` → `qb_customer_list({ includeCustomFields: true })` → `qb_customer_list({})` (regression pin: strip-by-default must hold).
- [ ] **(Windows + QB) Carried** — #72 / #79 / #81 / #80 / #77 / #76 / #70 / #78 / #71 / #75 / #69+#68 / #85+#86 / `qb_session_status` / #84 / #82 / #55 / #59 / #54 first live exercises. Lowest priority.

## Next Task

**Operator picks next.** With #60 + #61 + #65 closed, the remaining open items from todo.md:

- **Phase 13 — Data model gaps**
  - **#62** Sub-customer / job hierarchy helpers — `qb_customer_jobs(parentListId)` + `parentListID`/`jobOnly` filter on `qb_customer_list`.
  - **#63** Memo full-text search across transactions — server-side filter applied to `*Ret.Memo` post-response (with cost noted).
- **Phase 14 — Safety + DX**
  - **#64** Dry-run mode — `dryRun: true` on every `*_create` / `*_update` / `*_delete`. Returns "what would happen" via the validated payload + sim-store preview without committing. **Composes naturally with the read-only flag (#42) and idempotency keys (#47) — completes the safety triad.**
  - **#66** `qb_audit_log` — Enterprise-only via `TxnReportQueryRq` audit mode. Document the edition dependency; structured 9003-style error on Pro/Premier.
- **Phase 16 follow-ons**
  - **#73** Streaming responses for large lists.
  - **#74** MCP-side caching of stable lookups (chart of accounts, customers, items, terms, classes) with `qb_cache_invalidate({entity})`.

**Recommendation if operator wants the next-highest-leverage:** #64 (dry-run). Builds on the same single-chokepoint pattern as #42 read-only and #47 idempotency — three lines of `assertWritable` / cache logic at the manager layer + a per-call flag. Major confidence win for agent-driven mutation workflows where the operator's books are the real ones.

## Context Notes

- **#60 query dedup happens at the LISTID set.** Invoice CustomerRefs from live QB always carry both `ListID` AND `FullName`; the seed invoices match. Test-added invoices using `addEntity("Invoice", {CustomerRef: {FullName: "..."}})` carry FullName-only, which routes through a parallel FullName batch. The "issues ONE CustomerQueryRq" test pin uses the full {ListID, FullName} shape on every test invoice to match live behavior — if you add a regression test that posts FullName-only refs, expect TWO customer calls (one ListID batch, one FullName batch).

- **#60 contact field list** — `CUSTOMER_CONTACT_FIELDS` constant at the top of [src/tools/invoices.ts](src/tools/invoices.ts). To add a new field (e.g. `Notes`, `BillAddress`), add to the array — `pickContactFields` walks the list and projects whatever the Customer entity has.

- **#60 fail-soft warning is a string, not a structured object.** Future enhancement if other tools want to compose: lift to `{warnings: [{source, message}]}` — but the current shape matches the existing `*Detail` report tools' `warnings: [string]` convention.

- **#60 phantom CustomerRef** — invoice references a deleted customer. No warning emitted (that would be a noisy false alarm — happens routinely with closed clients). The `customerContact` field is simply absent on that invoice.

- **#65 architecture posture — tool-side wrapper, not manager-side.** Enrichment lives in the tool's catch block. Lifting it into `QBSessionManager.sendRequest` would force the manager to know about MCP response shapes (`content[0].text`), which it deliberately doesn't.

- **#65 heuristic specificity ordering.** The `RULES` array in [src/util/format-tool-error.ts](src/util/format-tool-error.ts) is ordered out-of-order → missing-element → empty-element → invalid-ref → invalid-argument. First match wins. Pinned by the `"out-of-order specificity"` test — `"invalid and out of order"` correctly classifies as `out-of-order`, not `invalid-argument`.

- **#65 regex case-sensitivity.** `FIELD` is `([A-Z][A-Za-z0-9]+)` — case-sensitive to reject lowercase words. Explicit `[Ii]nvalid` / `[Tt]he` alternations are used where QB capitalizes inconsistently. Do NOT add the `i` flag (would break field extraction).

- **#65 `the field "X"` is QB's canonical live pattern.** Two patterns capture it: `value\s+"..."\s+in the field\s+"(X)"` for invalid-argument; `object ID\s+"..."\s+in the field\s+"(X)"\s+is invalid` for invalid-ref. QB quotes the human display label (`"Transaction id"`), normalized via `DISPLAY_LABEL_TO_ELEMENT` to the XML element name (`TxnID`) before the schemaOrder lookup. `hint.field` keeps the original label so it matches QB's docs.

- **#65 codemod is idempotent.** Re-running [scripts/refactor-error-wrappers.mjs](scripts/refactor-error-wrappers.mjs) is safe. The import-management path correctly handles "imports got added but blocks didn't migrate this pass" — useful when a file is hand-edited between runs.

- **#65 `ToolErrorResponse` open index signature.** The MCP SDK's `server.tool` callback expects an open string-indexed signature for `_meta` merging. The helper's return type includes `[key: string]: unknown` — keeps the helper assignable at every callsite without per-tool casts.

- **#65 NOT migrated:** engagement-profitability.ts + client-packet.ts section-level error shapes (`return { error: {...} }` inside a SUCCESS response). Different surface; would need a separate adapter helper. Low priority.

- **#65 schemaOrder cap at 20 candidates** in `findSchemaOrderForField`. Covers `OwnerID` (~14 candidates) and `TxnID` (~20). Bumping is cheap.

- **#65 cosmetic gap:** the codemod sometimes drops the blank line between imports and code after stripping `qbStatusCodeMessage` import. No functional impact. Prettier or a future cleanup pass would normalize.

- **Carried gotchas (all still apply):**
  - **#61 architecture** — DataExt read-only V1, strip-by-default, opt-in `includeCustomFields`. OwnerID is LAST child in every entity *QueryRq.
  - **#72 architecture** — `qb_transaction_list` is a COMPOSITE over typed queries, NOT a single `TransactionQueryRq`. JournalEntry deliberately not exposed (sim's `handleQuery` walks header refs only). `maxPerType` is per-type, not aggregate.
  - **#79 VehicleMileage** — no `TxnDate` field (use TripStartDate/TripEndDate); non-posting + immutable from SDK (no `_update`).
  - **#79 four-list sync** for any new transaction type: `isTransaction` in [src/qbxml/builder.ts](src/qbxml/builder.ts), `isTransaction` in [src/session/manager.ts](src/session/manager.ts), `isTransactionType` in [src/session/simulation-store.ts](src/session/simulation-store.ts), AND the [CLAUDE.md](CLAUDE.md) doc list.
  - **#81 StatementCharge** is single-row-at-header (no `*LineAdd` array). ReceivePayment can't apply to StatementCharge TxnIDs — `validateTxnApplications` hardcodes the Invoice store.
  - **#80 InventoryAdjustment** mutates ItemInventory state (two-phase commit invariant). No `_update` — delete + recreate.
  - **#76 SalesOrder is non-posting** — Customer.Balance does NOT move on SO add/delete.
  - **#70 `IncludeLineItems: true` is LOAD-BEARING** for any tool walking line-level data on Bill/Check/CreditCardCharge/SalesOrder. Customer scope: POST-FILTERED on time, LINE-LEVEL on Bill/Check/CCC. `customerRefMatches` accepts ListID OR FullName.
  - **#78 EntityFilter priority** — `handleQuery` does `EntityRef ?? CustomerRef ?? VendorRef ?? PayeeEntityRef`. Duration is ISO 8601 PT-H-M-S only.
  - **#71 fail-soft** — `sections.<name>` is success payload OR `{ error: {...} }`. Payroll has THREE skip states: Pro → 9003, wire-zero → 9004, probe-fail → error.
  - **#75 EntityFilter strict improvement** — matches `PayeeEntityRef` for Check / BillPaymentCheck / BillPaymentCreditCard / CreditCardCharge / CreditCardCredit.
  - **#67 default path is zero wire I/O.** Probe is opt-in.
  - **#85 SDK gap is permanent** — `qb_closing_date_set` always 9005 + UI navigation.
  - **statusCodes** — synthetic: 9001 read-only, 9002 idempotency conflict, 9003 edition unsupported, 9004 payroll subscription required, 9005 SDK has no write path. Real QB (captured 2026-05-17): 3000 invalid object ID, 3110 invalid enumerated value.
  - **AR-side `Customer.Balance` discount math is correct; AP-side is NOT** — future `qb_bill_write_off` needs the parallel fix.
  - **Dispatch order in `processRequest`** — non-entity-typed `*QueryRq` / `*ModRq` / `AttachableAddRq` / `DataExtDefQueryRq` MUST precede the `endsWith` catch-alls.
  - **Iterator wire names diverge** — `iterator` / `iteratorID` on request; `iteratorRemainingCount` / `iteratorID` on response.
  - **fast-xml-parser** does NOT decode numeric character entities (use `decodeXmlEntities`). DOES coerce numeric-looking text to numbers (`<CheckNumber>1001</CheckNumber>` → `1001` number).
  - **Live verification requires `C:\nvm4w\nodejs\node.exe` v20.20.2** (system PATH v22 breaks winax).
  - **QBXMLRP2 cannot OPEN a `.qbw`** — only attach to one QB Desktop has already loaded.
  - **BillPayment* total is on `TotalAmount`**, not `Amount` — coalesce `TotalAmount ?? Amount`.
