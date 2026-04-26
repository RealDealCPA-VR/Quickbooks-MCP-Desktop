# Acceptance Criteria

Per-task definition of "done." A task is complete only when its criteria are observably satisfied AND `REGRESSION_CHECKLIST.md` passes.

If criteria change during implementation, update them here in the same session — never silently move the goalposts.

Item numbers map to `todo.md`. Add criteria below as you pick up each task. Move completed entries to the bottom under "Completed."

---

## Template

```markdown
## Item N — <Short title> _(Phase X)_

**Status:** pending | in-progress | done | partial

**Behavioral criteria** _(observable, testable, no ambiguity)_:
- [ ] <Criterion 1 — describe what someone calling the tool sees>
- [ ] <Criterion 2>
- [ ] <Edge case>
- [ ] <Error case>

**Regression criteria** _(things that should still work after the change)_:
- [ ] <Adjacent tool / behavior that uses shared code>
- [ ] <Seed-data assumption that should still hold>

**Documentation criteria**:
- [ ] README updated if a tool was added/renamed/removed
- [ ] `instructions` block in src/index.ts updated if a tool surface changed
- [ ] `ARCHITECTURE.md` / `DECISIONS.md` / `REQUIREMENTS.md` updated if applicable

**Verification commands**:
```bash
npm run build
npm run dev   # in another terminal: exercise the tool through an MCP client
```

**Notes**: <gotchas, scope clarifications, follow-ups discovered>
```

---

## Phase 3 — Transaction completeness

_(All Phase 3 items complete — see Completed below.)_

---

## Phase 4 — Missing tools / coverage gaps

_(All Phase 4 in-scope items complete — Items 10, 11, 12, 13, 30. See Completed for entries. Item 24 (dead-code hygiene) and remaining Phase 4 plumbing items (23, 25-29) still open per `todo.md`.)_

---

## Phase 5 — Reporting

_(Item 14 done — see Completed below. Items 19, 20, 21 still open per `todo.md`.)_

---

_(Don't pre-write criteria for distant tasks — they tend to drift before implementation, and writing them up-front wastes effort if priorities shift.)_

---

## Completed

_(Move entries here when criteria are satisfied. Keep the criteria list intact — it's the historical record of what "done" meant for that task.)_

### Item 14 — Real `CompanyQueryRq` in `qb_company_info` _(Phase 5)_ — done 2026-04-26

**Status:** done

**Behavioral criteria** _(observable, testable, no ambiguity)_:
- [x] `qb_company_info` (no args) returns a structured payload with a `companyInfo` object containing `CompanyName`, `LegalCompanyName`, `Address` (Addr1/City/State/PostalCode/Country block), `LegalAddress`, `Phone`, `Email`, `CompanyType`, `EIN`, `FirstMonthInFiscalYear`, `FirstMonthInIncomeTaxYear`, `TaxForm`, `IsSampleCompany`, `SubscriberID`, `CompanyFilePath`.
- [x] The payload still surfaces session state for operator transparency: `connected`, `simulationMode`, `companyFile`, `sessionTicket`, `openedAt`. The hardcoded `serverInfo` block is gone (it was stale and never updated as tools were added).
- [x] In simulation mode the seeded company comes back: `CompanyName: "Demo Co"`, fiscal year `January`, `TaxForm: "Form1120"`, `IsSampleCompany: true`.
- [x] Calling `qb_company_info` BEFORE any explicit `qb_session_connect` still works — the tool auto-connects via `session.queryEntity` (which routes through `sendRequest` → `openSession`), so the operator can call it as a first move.

**Regression criteria** _(things that should still work after the change)_:
- [x] `qb_balance_summary` still returns the 10 seeded accounts grouped by AccountType (no overlap with the new Company seed/store).
- [x] `qb_account_list` / `qb_customer_list` / `qb_vendor_list` etc. unaffected — adding a new `Company` store does not bleed into other entity lookups.
- [x] `qb_session_connect` / `qb_session_disconnect` still work; sessionTicket and openedAt still surface through the new payload.

**Documentation criteria**:
- [x] README "Reports" tool table description for `qb_company_info` updated to reflect the real query.
- [x] `instructions` block in [src/index.ts](src/index.ts) — left as `"Connection & company info"` (still accurate; the granular field list lives in the tool's description).
- [x] No DECISIONS.md entry needed (no tradeoff — straightforward implementation of an obvious gap).
- [x] No ARCHITECTURE.md change (Company is just another entity routed through the standard query path; no new subsystem).

**Verification commands**:
```bash
npm run build
# Then via verification harness:
#   qb_company_info -> assert companyInfo.CompanyName === "Demo Co", IsSampleCompany === true
#   qb_balance_summary -> assert totalAccounts === 10 (regression)
#   prior-handoff regression suite (account/invoice/JE/bill paths) all green
```

**Notes**: Company is a singleton in real QB — exactly one record per company file. Stored as a single-entry Map keyed by sentinel `"COMPANY"` so the existing `getStore`/`handleQuery` flow needs no special-case branch (the generic path returns `[companySeed]`, applies no filters since the request has none, and wraps as `{ CompanyRet: [companySeed] }`). `CompanyRet` deliberately stays out of the parser's `arrayElements` set (spec is singular); `flattenEntityArray` handles both single-object and array shapes so the consumer is uniform either way. Read-only — no `CompanyMod`, no nested address validation. If the operator ever needs to edit company info that's a separate item.

### Item 12 (JournalEntry) — Journal entry tools (`qb_journal_entry_list` / `_create` / `_update` / `_delete`) _(Phase 4)_ — done 2026-04-26

**Status:** done (4 of 4 families in Item 12 — Item 12 is now fully complete).

**Behavioral criteria** _(create / list / delete)_:
- [x] All four tools registered and listed by the MCP server. Verified J1.
- [x] `qb_journal_entry_create` with balanced `debits` + `credits` arrays returns a JE with both `JournalDebitLineRet` + `JournalCreditLineRet` arrays (each line carrying `TxnLineID` + `AccountRef` + `Amount`) plus `TotalDebit` and `TotalCredit` (always equal, derived in `computeTotals`). Verified J2.
- [x] `qb_journal_entry_create` with `sum(debits) !== sum(credits)` is rejected with `isError: true` + `statusCode: 3030` and the entry is NOT persisted (subsequent `qb_journal_entry_list` cannot find it). Verified J3.
- [x] `qb_journal_entry_create` with empty `debits` (or empty `credits`) is rejected by zod (`.min(1)`); the simulation never receives the request. Verified J4.
- [x] `qb_journal_entry_create` does NOT move any Customer/Vendor balance, even when lines carry `entityName` (per-line entity-balance moves are deferred per the handoff — `EntityRef` is recorded faithfully on the stored entity but no balance side effect). Verified J5.
- [x] `qb_journal_entry_list` filters by `txnId` (TxnID), `refNumber`, `fromDate`/`toDate` (TxnDateRangeFilter), `modifiedFrom`/`modifiedTo` (ModifiedDateRangeFilter). Verified J6.
- [x] `qb_journal_entry_delete` happy path: subsequent `qb_journal_entry_list { txnId }` returns `count: 0`. No customer/vendor balance side effect (no per-line entity bookkeeping to reverse). Verified J7.
- [x] `qb_journal_entry_delete` unknown `txnId` returns `isError: true` with `statusCode: 500`. Verified J8.

**Behavioral criteria** _(`qb_journal_entry_update` — header / line edits, balance invariant)_:
- [x] Header-only mod (no `debits`, no `credits`) leaves the existing line sets, `TotalDebit`, and `TotalCredit` untouched; `EditSequence` rotates and `TimeModified` updates. Verified U1.
- [x] When `debits` is provided, the array REPLACES the JE's `JournalDebitLineRet` wholesale — debit lines whose `TxnLineID` is not listed are dropped. Same for `credits` and `JournalCreditLineRet`. The two sides are independent. Verified U2.
- [x] A line entry with a `txnLineID` matching an existing line preserves that `TxnLineID` and merges the mod's fields onto the existing line (e.g. memo-only mod preserves accountName and amount). Verified U2.
- [x] After a line mod, `TotalDebit` and `TotalCredit` recompute from the new line sets via `computeTotals` (JournalEntry branch added to the post-mod recompute conjunction). Verified U2.
- [x] A mod that breaks the balance invariant (post-mod `sum(debits) !== sum(credits)`) is rejected with `statusCode: 3030`; the JE does NOT mutate (re-fetched JE has the pre-mod amounts, line shapes, and `EditSequence`). Verified U3.
- [x] Updating only one side (e.g. `debits` provided, `credits` omitted) is allowed when the post-mod sums still balance (the unmodified side carries forward). Verified U4.
- [x] Stale `editSequence` rejects with `statusCode: 3170`; the JE does NOT mutate. Verified U5.
- [x] `EditSequence` rotates after every successful mod. Verified U6.

**Regression criteria**:
- [x] `qb_invoice_update` line mod still recomputes `Subtotal` + `BalanceRemaining` (computeTotals JournalEntry branch did not regress Invoice path). Verified R1.
- [x] `qb_estimate_update` line mod still recomputes `Subtotal`. Verified R2.
- [x] `qb_bill_update` line mod still recomputes `AmountDue`. Verified R3.
- [x] `qb_sales_receipt_update` line mod still recomputes `Subtotal` + `TotalAmount`. Verified R4.
- [x] `qb_credit_memo_update` line mod still recomputes `Subtotal` + `TotalAmount` + `RemainingValue` and moves customer balance by the delta. Verified R5.
- [x] `qb_purchase_order_update` line mod still recomputes `TotalAmount`; vendor balance unchanged. Verified R6.

**Build / structural criteria**:
- [x] `npm run build` passes (no TypeScript errors).
- [x] `instructions` block in [src/index.ts](src/index.ts) updated with a `qb_journal_entry_*` bullet describing the debit/credit balance invariant (3030), per-line entity-balance deferral, and replacement-line semantics.
- [x] README tool count bumped 66 → 70; new "Journal Entries" section with intro paragraphs + 4-row tool table; `JournalEntryQueryRq/AddRq/ModRq` added to the QBXML reference list.
- [x] `JournalDebitLineRet` and `JournalCreditLineRet` added to `arrayElements` in [src/qbxml/parser.ts](src/qbxml/parser.ts) so single-line responses still come back as arrays.
- [x] `convertLinesAddToRet` regex `/^(.+?)Line(s?)Add$/` matches `JournalDebitLineAdd` / `JournalCreditLineAdd` for free; tool layer pre-computes `Amount` so `convertLineAddToRet` honors it (no qty/rate/cost on JE lines).
- [x] `applyLineMods` regex `/^(.+?)Line(s?)Mod$/` matches `JournalDebitLineMod` / `JournalCreditLineMod` for free.
- [x] JournalEntry already wired in `isTransactionType` ([src/session/simulation-store.ts](src/session/simulation-store.ts)), `buildDeleteRequest` transaction list ([src/qbxml/builder.ts](src/qbxml/builder.ts)), `deleteEntity` transaction list ([src/session/manager.ts](src/session/manager.ts)).

---

### Item 12 (PurchaseOrder) — Purchase order tools (`qb_purchase_order_list` / `_create` / `_update` / `_delete`) _(Phase 4)_ — done 2026-04-26

**Status:** done (3 of 4 families in Item 12; JournalEntry still pending under Item 12)

**Behavioral criteria** _(create / list / delete)_:
- [x] All four tools registered and listed by the MCP server.
- [x] `qb_purchase_order_create` with a `lines` array returns `TotalAmount = sum(line.Amount)` derived server-side via `computeTotals`. POs have NO separate `Subtotal` header — the line set aggregates straight to `TotalAmount` (distinct from Invoice/Estimate/SalesReceipt/CreditMemo). Verified P1.
- [x] Each line's `Amount` is computed at the tool layer as `quantity * cost` (POs use Cost, not Rate). Tool also pre-computes Amount so `convertLineAddToRet` honors the explicit value. Verified P2.
- [x] `qb_purchase_order_create` returns `PurchaseOrderLineRet` array with one entry per `lines[]`, each with a freshly-generated `TxnLineID` and computed `Amount`. Verified P3.
- [x] `qb_purchase_order_create` does NOT post to AP — vendor `Balance` is unchanged after creation (POs are non-posting; only bills entered against received items move the vendor balance). Verified P4 (vendor.Balance delta = 0).
- [x] `qb_purchase_order_create` with no lines (empty array or omitted) is rejected by the zod schema (`lines` is `.min(1)`). Verified P5.
- [x] `qb_purchase_order_create` with `isManuallyClosed: true` stores the flag on the entity; default omits the flag. Verified P6.
- [x] `qb_purchase_order_list` filters by `txnId` (TxnID), `vendorName` (EntityFilter scoped to VendorRef), `refNumber`, `fromDate`/`toDate` (TxnDateRangeFilter). Verified J-series.
- [x] `qb_purchase_order_delete` happy path: subsequent `qb_purchase_order_list { txnId }` returns `count: 0`; vendor balance unchanged (no AP posting to reverse). Verified G1, G2.
- [x] `qb_purchase_order_delete` unknown `txnId` returns `isError: true` with `statusCode: 500`. Verified H1.

**Behavioral criteria** _(`qb_purchase_order_update` — header / line edits)_:
- [x] Header-only mod (no `lines`) leaves the existing `PurchaseOrderLineRet`, `TotalAmount`, and `TxnLineID`s untouched. Verified B1, B2.
- [x] When `lines` is provided, the array REPLACES the PO's `PurchaseOrderLineRet` wholesale — lines whose `TxnLineID` is not listed are dropped. Verified D1.
- [x] A line entry with a `txnLineID` matching an existing line preserves that `TxnLineID` and merges the mod's fields onto the existing line (Cost carried over when only Quantity is passed; `applyLineMods` re-derives Amount = Quantity * Cost). Verified D2, D3.
- [x] After a line mod, `TotalAmount` recomputes from the new line set via `computeTotals` (PurchaseOrder branch added to the post-mod recompute list). Verified D4.
- [x] After a line mod, vendor `Balance` is unchanged — POs are non-posting, no balance bookkeeping on the mod path. Verified D5 (vendor.Balance delta = 0 across grow + shrink mods).
- [x] `isManuallyClosed` toggles correctly on mod (false → true and back). Verified M1.
- [x] Stale `editSequence` rejects with `statusCode: 3170`; the PO does NOT mutate. Verified C1, C2.
- [x] `EditSequence` rotates after every successful mod. Verified B3.

**Regression criteria**:
- [x] `qb_invoice_update` line mod still recomputes `Subtotal` + `BalanceRemaining` (computeTotals PurchaseOrder branch did not regress Invoice path). Verified N1.
- [x] `qb_estimate_update` line mod still recomputes `Subtotal`. Verified N2.
- [x] `qb_bill_update` line mod still recomputes `AmountDue` (Cost-based itemLines still re-derive Amount via `applyLineMods`). Verified N3.
- [x] `qb_sales_receipt_update` line mod still recomputes `Subtotal` + `TotalAmount`. Verified N4.
- [x] `qb_credit_memo_update` line mod still recomputes `Subtotal` + `TotalAmount` + `RemainingValue` and moves customer balance by the delta. Verified N5.
- [x] `qb_credit_memo_apply` still re-applies atomically and preserves customer balance. Verified N6.
- [x] `qb_payment_apply` still moves customer balance by `-appliedSum`. Verified N7.

**Build / structural criteria**:
- [x] `npm run build` passes (no TypeScript errors).
- [x] `instructions` block in [src/index.ts](src/index.ts) updated with a `qb_purchase_order_*` bullet describing the non-posting nature, Cost-based lines, `TotalAmount` derivation (no Subtotal split), and `isManuallyClosed` flag.
- [x] README tool count bumped 62 → 66; new "Purchase Orders" section with intro paragraphs + 4-row tool table.
- [x] `convertLinesAddToRet` regex `/^(.+?)Line(s?)Add$/` already matches `PurchaseOrderLineAdd` — no parser/builder changes needed.
- [x] `applyLineMods` regex `/^(.+?)Line(s?)Mod$/` matches `PurchaseOrderLineMod` for free; existing Quantity * Cost re-derivation works unchanged.
- [x] PurchaseOrder already wired in `isTransactionType` ([src/session/simulation-store.ts](src/session/simulation-store.ts)), `arrayElements` ([src/qbxml/parser.ts](src/qbxml/parser.ts)), `buildDeleteRequest` transaction list ([src/qbxml/builder.ts](src/qbxml/builder.ts)), `deleteEntity` transaction list ([src/session/manager.ts](src/session/manager.ts)).

### Item 12 (CreditMemo) — Credit memo tools (`qb_credit_memo_list` / `_create` / `_update` / `_apply` / `_delete`) _(Phase 4)_ — done 2026-04-26

**Status:** done (2 of 4 families in Item 12; PurchaseOrder / JournalEntry still pending under Item 12)

**Behavioral criteria** _(create / list / delete)_:
- [x] All five tools registered and listed by the MCP server.
- [x] `qb_credit_memo_create` with a `lines` array returns `Subtotal = sum(line.Amount)` derived server-side via `computeTotals`. Verified A1.
- [x] `qb_credit_memo_create` returns `TotalAmount = Subtotal + SalesTaxTotal` (SalesTaxTotal defaults to 0). Verified A2.
- [x] `qb_credit_memo_create` returns `RemainingValue = TotalAmount − AppliedAmount` (AppliedAmount defaults to 0 when no `appliedTo` is passed; RemainingValue starts at TotalAmount). Verified A3.
- [x] `qb_credit_memo_create` returns `CreditMemoLineRet` array with one entry per `lines[]`, each with a freshly-generated `TxnLineID` and computed `Amount`. Verified A4.
- [x] `qb_credit_memo_create` posts to AR — customer `Balance` moves by `-TotalAmount` regardless of whether `appliedTo` is passed. Verified A5 (delta = -1000 on first create with no appliedTo).
- [x] `qb_credit_memo_create` with `appliedTo: [{txnId, amount}]` reduces each named invoice's `BalanceRemaining` by `amount` and bumps `AppliedAmount`; flips `IsPaid` when balance hits zero. The customer balance moves only by `-TotalAmount` — application does NOT move it again. Verified P1–P4.
- [x] `qb_credit_memo_create` records `AppliedToTxnRet` array on the memo (one entry per applied invoice with TxnLineID + TxnID + PaymentAmount). Memo `AppliedAmount` = sum(applied), `RemainingValue` = TotalAmount − AppliedAmount. Verified P5.
- [x] `qb_credit_memo_create` with `appliedTo` summing > TotalAmount returns `isError: true` with `statusCode: 500` (overapplication guard at the simulation layer). Verified Q1.
- [x] `qb_credit_memo_create` with an unknown `txnId` in `appliedTo` returns `isError: true` with `statusCode: 500` and does NOT mutate any partial state — atomic rejection. Verified Q2.
- [x] `qb_credit_memo_list` filters by `txnId` (TxnID), `customerName` (EntityFilter), `refNumber`, `fromDate`/`toDate` (TxnDateRangeFilter). Verified J-series.
- [x] `qb_credit_memo_delete` happy path: subsequent `qb_credit_memo_list { txnId }` returns `count: 0`; customer balance reverses by `+TotalAmount`; any applied invoice's `BalanceRemaining` is restored. Verified G1–G3.
- [x] `qb_credit_memo_delete` unknown `txnId` returns `isError: true` with `statusCode: 500`. Verified H1.

**Behavioral criteria** _(`qb_credit_memo_update` — header / line edits)_:
- [x] Header-only mod (no `lines`) leaves the existing `CreditMemoLineRet`, `Subtotal`, `TotalAmount`, `RemainingValue`, `AppliedAmount`, and `TxnLineID`s untouched. Verified B1–B5.
- [x] When `lines` is provided, the array REPLACES the memo's `CreditMemoLineRet` wholesale — lines whose `TxnLineID` is not listed are dropped. Verified D1.
- [x] A line entry with a `txnLineID` matching an existing line preserves that `TxnLineID` and merges the mod's fields onto the existing line (Rate carried over when only Quantity is passed). Verified D2, D3.
- [x] After a line mod, `Subtotal` / `TotalAmount` / `RemainingValue` recompute from the new line set via `computeTotals`. Verified D4.
- [x] After a line mod, customer `Balance` adjusts by `-(newTotalAmount − oldTotalAmount)` so the AR-negative posting stays consistent (memo grew → customer balance drops further; memo shrank → customer balance recovers). Verified D5 (delta = -200 when total grew 1000 → 1200), D6 (delta = +500 when total shrank 1200 → 700).
- [x] `AppliedAmount` is preserved across line mods — a memo with prior applications keeps its application bookkeeping intact through header / line edits. `RemainingValue` recomputes as `TotalAmount − AppliedAmount`. Verified D7 (memo with applied=400, total mod 1000→1200, AppliedAmount stays 400, RemainingValue becomes 800).
- [x] Stale `editSequence` rejects with `statusCode: 3170`; the memo does NOT mutate. Verified C1, C2.
- [x] `EditSequence` rotates after every successful mod. Verified B6.

**Behavioral criteria** _(`qb_credit_memo_apply` — re-application path)_:
- [x] Tool registered. Verified R0.
- [x] Pass `txnId` + `editSequence` + replacement `applyTo: [{txnId, amount}]`. The new array REPLACES the memo's prior application wholesale. Verified R1 (1 invoice → 2 invoices).
- [x] Previously-applied invoices have their `BalanceRemaining` / `AppliedAmount` / `IsPaid` restored by the previously-applied amount. Verified R2 (Invoice A's BR jumps back from 0 → 1000 when the application moves to Invoice B + C).
- [x] Newly-applied invoices have their `BalanceRemaining` reduced by the new applied amount. Verified R3.
- [x] Memo `AppliedToTxnRet` reflects the new application set; `AppliedAmount` = sum(new applied); `RemainingValue` = `TotalAmount − AppliedAmount`. Verified R4.
- [x] Customer `Balance` does NOT move on re-apply — the credit pool just shifts between memo `RemainingValue` and invoice `BalanceRemaining`. Verified R5 (no delta in Customer.Balance before/after re-apply).
- [x] Pass `applyTo: []` to fully unapply: memo `RemainingValue` returns to `TotalAmount`, `AppliedAmount` = 0, `AppliedToTxnRet` = []. Previously-applied invoices fully restored. Customer balance unchanged. Verified S1–S3.
- [x] `sum(applyTo.amount) > TotalAmount` rejects with `statusCode: 500` and the prior application is NOT disturbed (validate-first ordering). Verified T1, T2.
- [x] Unknown invoice `txnId` in `applyTo` rejects with `statusCode: 500`; prior application untouched. Verified T3.
- [x] Stale `editSequence` rejects with `statusCode: 3170`; memo state unchanged. Verified T4.
- [x] `TotalAmount` is immutable on this path — `applyTo` mods do NOT recompute or replace `TotalAmount`. Verified R4.

**Regression criteria**:
- [x] `qb_invoice_update` line mod still recomputes `Subtotal` + `BalanceRemaining` (computeTotals CreditMemo branch did not regress Invoice path). Verified N1.
- [x] `qb_estimate_update` line mod still recomputes `Subtotal`. Verified N2.
- [x] `qb_bill_update` line mod still recomputes `AmountDue`. Verified N3.
- [x] `qb_sales_receipt_update` line mod still recomputes `Subtotal` + `TotalAmount`. Verified N4 (shared post-mod recompute path with newly-added CreditMemo branch).
- [x] `qb_payment_apply` still closes invoices end-to-end via `applyTxnApplications`. Verified N5.
- [x] `qb_payment_receive` still moves customer balance by `-appliedSum` (NOT by full TotalAmount — distinguishing AR-payment semantics from CreditMemo's full-TotalAmount posting). Verified N6.
- [x] `qb_class_list` returns 3 active seed classes. Verified N7.

**Documentation criteria**:
- [x] README updated: tool count 57 → 62; new "Credit Memos" section with intro paragraphs (AR-negative posting, RemainingValue tracking, apply-vs-update distinction) and 5-row tool table.
- [x] `instructions` block in [src/index.ts](src/index.ts) updated — qb_credit_memo_* bullet documents the AR-negative semantics, customer-balance posting at memo level, RemainingValue tracking, the apply path's no-customer-balance-move guarantee, and stale-editSequence rejection.
- [x] No new `DECISIONS.md` entry — CreditMemo follows the established CRUD + apply-mod patterns; the customer-balance-at-memo-level (vs. ReceivePayment's apply-time posting) is a domain semantic, not an architectural choice.
- [x] No `ARCHITECTURE.md` change — CreditMemo is the same builder/parser/store path as Invoice/Estimate/SalesReceipt, with new helpers `applyCreditMemo` / `reverseCreditMemoApplication` / `handleCreditMemoApplyMod` mirroring the ReceivePayment plumbing.

**Verification commands**:
```bash
npm run build              # exits 0
node scratch-verify.mjs    # inline verification script (deleted post-verification)
```

**Notes**:
- The structural difference between CreditMemo and ReceivePayment is *where* customer balance moves: ReceivePayment moves it at apply time (`-appliedSum`, the rest is `UnusedPayment`); CreditMemo moves it at memo-add time (`-TotalAmount`, regardless of application). Re-application on CreditMemo therefore does NOT touch customer balance — it just shifts bookkeeping between `RemainingValue` and invoice `BalanceRemaining`. This is mirrored in `applyCreditMemoApplications` (no `adjustEntityBalance` call) vs. `applyTxnApplications` (calls `adjustEntityBalance` with `-appliedSum`).
- `adjustPartyBalanceForTxnMod` was extended with an optional `sign: 1 | -1 = 1` parameter and `amountField: "TotalAmount"` member. The sign inverts both the same-party delta path and the reverse-then-apply path uniformly. Bill/Invoice continue to call without `sign` (defaults to +1); CreditMemo passes `sign: -1` because TotalAmount growing means customer balance shrinking.
- Discount handling on `AppliedToTxn` lines is intentionally not exposed in `qb_credit_memo_create` / `_apply` — uncommon for credit memos, and the existing `qb_payment_receive` discount path establishes the precedent for the rare case where it matters (discounts on AR closures live on the payment, not the memo).
- The `applyLineMods` regex `^(.+?)Line(s?)Mod$` at [simulation-store.ts](src/session/simulation-store.ts) caught `CreditMemoLineMod` with zero handler changes, exactly as predicted. Builder/parser unchanged: `CreditMemoRet` / `CreditMemoLineRet` / `AppliedToTxnRet` were already in `arrayElements`; CreditMemo was already in `buildDeleteRequest`'s transaction list.

### Item 12 (SalesReceipt) — Sales receipt tools (`qb_sales_receipt_list` / `_create` / `_update` / `_delete`) _(Phase 4)_ — done 2026-04-26

**Status:** done (1 of 4 families in Item 12; CreditMemo / PurchaseOrder / JournalEntry still pending under Item 12)

**Behavioral criteria** _(create / list / delete)_:
- [x] All four tools registered and listed by the MCP server.
- [x] `qb_sales_receipt_create` with a `lines` array returns `Subtotal = sum(line.Amount)` derived server-side via `computeTotals`. Verified A1 (qty=10 × rate=100 → Subtotal=1000).
- [x] `qb_sales_receipt_create` returns `TotalAmount = Subtotal + SalesTaxTotal` (SalesTaxTotal defaults to 0). Verified A2 (TotalAmount=1000).
- [x] `qb_sales_receipt_create` returns `SalesReceiptLineRet` array with one entry per `lines[]`, each with a freshly-generated `TxnLineID` and computed `Amount`. Verified A3.
- [x] `qb_sales_receipt_create` is AR-untouched — customer `Balance` does NOT change. Verified A4 (cash sale; no AR posting).
- [x] `qb_sales_receipt_create` does NOT set `BalanceRemaining`, `IsPaid`, or `AppliedAmount` (no AR fields). Verified A5.
- [x] `qb_sales_receipt_create` carries `PaymentMethodRef`, `DepositToAccountRef` onto the entity when supplied. Verified A6.
- [x] `qb_sales_receipt_list` filters by `txnId` (TxnID), `customerName` (EntityFilter), `refNumber`, `fromDate`/`toDate` (TxnDateRangeFilter). Verified J-series.
- [x] `qb_sales_receipt_delete` happy path: subsequent `qb_sales_receipt_list { txnId }` returns `count: 0`; customer balance unchanged. Verified G1, G2.
- [x] `qb_sales_receipt_delete` unknown `txnId` returns `isError: true` with `statusCode: 500`. Verified H1.

**Behavioral criteria** _(`qb_sales_receipt_update`)_:
- [x] Header-only mod (no `lines`) leaves the existing `SalesReceiptLineRet`, `Subtotal`, `TotalAmount`, and `TxnLineID`s untouched. Verified B1–B4.
- [x] When `lines` is provided, the array REPLACES the receipt's `SalesReceiptLineRet` wholesale — lines whose `TxnLineID` is not listed are dropped. Verified D1.
- [x] A line entry with a `txnLineID` matching an existing line preserves that `TxnLineID` and merges the mod's fields onto the existing line (Rate carried over when only Quantity is passed). Verified D2, D3.
- [x] After a line mod, `Subtotal` and `TotalAmount` recompute from the new line set via `computeTotals` (post-mod recompute branch extended to fire for SalesReceipt). Verified D4, D5.
- [x] `qb_sales_receipt_update` is AR-untouched — customer `Balance` does NOT change before/after header or line mods. Verified B5, D6.
- [x] Stale `editSequence` rejects with `statusCode: 3170`; the receipt does NOT mutate. Verified C1, C2.
- [x] `EditSequence` rotates after every successful mod. Verified B6.

**Regression criteria**:
- [x] `qb_invoice_update` line mod still recomputes Subtotal + BalanceRemaining (computeTotals SalesReceipt branch did not regress Invoice path). Verified N1.
- [x] `qb_estimate_update` line mod still recomputes Subtotal (Estimate branch in post-mod recompute condition still fires). Verified N2.
- [x] `qb_bill_update` line mod still recomputes AmountDue. Verified N3.
- [x] `qb_payment_apply` still closes invoices end-to-end. Verified N4.
- [x] `qb_estimate_convert_to_invoice` still works (shared addEntity path). Verified N5.
- [x] Seed data still loads and `qb_class_list` returns 3 active seed classes. Verified N6.

**Documentation criteria**:
- [x] README updated: tool count 53 → 57; new "Sales Receipts" section with intro paragraphs and 4-row tool table.
- [x] `instructions` block in [src/index.ts](src/index.ts) updated — qb_sales_receipt_* bullet documents the cash-sale semantics, deposit account, line + Subtotal + TotalAmount derivation, AR-untouched guarantee, and stale-editSequence rejection.
- [x] No new `DECISIONS.md` entry — SalesReceipt fits the existing CRUD shape; no architectural choice was made (post-mod recompute extension mirrors the Estimate addition from Item 13).
- [x] No `ARCHITECTURE.md` change — SalesReceipt is the same builder/parser/store path as Invoice/Estimate.

**Verification commands**:
```bash
npm run build              # exits 0
node scratch-verify.mjs    # 38-check inline script (deleted post-verification)
```

**Notes**:
- SalesReceipt's `computeTotals` branch only derives `Subtotal` + `TotalAmount`. Real QB has additional tax fields (`SalesTaxPercentage`, etc.) but those are not derived from lines — they're carried as-is. The simulation defaults `SalesTaxTotal` to 0 if undefined.
- `DepositToAccountRef` is preserved on the stored entity but the simulation does NOT post a corresponding ledger entry against the named account (no GL-balance bookkeeping yet — same scope-line as Invoice/Bill, which also don't update GL accounts in the sim, only the customer/vendor balance).
- The `applyLineMods` regex `^(.+?)Line(s?)Mod$` at [simulation-store.ts:1087](src/session/simulation-store.ts#L1087) caught `SalesReceiptLineMod` with zero handler changes, exactly as predicted by the prior handoff.

### Item 13 — Estimate tools (`qb_estimate_update` / `qb_estimate_delete` / `qb_estimate_convert_to_invoice`) _(Phase 4)_ — done 2026-04-26

**Status:** done

**Behavioral criteria** _(`qb_estimate_update`)_:
- [x] Tool registered and listed by the MCP server. Verified F1 (IsAccepted update via tool path).
- [x] Header-only mod (no `lines`) leaves the existing `EstimateLineRet`, `Subtotal`, and `TxnLineID`s untouched. Verified B1–B6.
- [x] When `lines` is provided, the array REPLACES the estimate's `EstimateLineRet` wholesale — lines whose `TxnLineID` is not listed are dropped. Verified D1 (2 → 1).
- [x] A line entry with a `txnLineID` matching an existing line preserves that `TxnLineID` and merges the mod's fields onto the existing line. Verified D2 (TxnLineID preserved), D3 (Rate carried from existing).
- [x] A line entry with `txnLineID: '-1'` (or omitted) gets a freshly-generated `TxnLineID` and is treated as a new line. Verified E2 (new TxnLineID ≠ existing or '-1').
- [x] After a line mod, `Subtotal` recomputes from the new line set via `computeTotals` (extended to fire for Estimate). Verified D5 (1200), E4 (1325).
- [x] `Amount` re-derives from the merged line: `Quantity * Rate` when both are present (changing only `quantity` on an existing line picks up the existing `rate`); explicit `amount` wins when provided. Verified D4 (12 * 100 = 1200 from merge), E3 (5 * 25 = 125).
- [x] Estimates don't post to AR — `qb_estimate_update` (header or line mod) does NOT touch customer `Balance`. Verified A7, B6, D6.
- [x] `isAccepted: true` flag flips the stored `IsAccepted` field. Verified F1.

**Behavioral criteria** _(`qb_estimate_delete`)_:
- [x] Tool registered. Verified G1 (delete returned a result object).
- [x] Successful delete removes the estimate from the store. Verified G2 (post-delete query returns empty).
- [x] Estimate delete does NOT touch customer `Balance` (estimates are non-posting). Verified G3.
- [x] Delete is wrapped in try/catch and surfaces `isError: true` + `statusCode` for unknown TxnIDs. Verified H1/H2 (statusCode 500).

**Behavioral criteria** _(`qb_estimate_convert_to_invoice`)_:
- [x] Tool registered. Verified J1 (returns invoice object).
- [x] Invoice CustomerRef matches the source estimate. Verified J2.
- [x] Invoice's `InvoiceLineRet` count matches the estimate's `EstimateLineRet` count; each line carries ItemRef, Desc, Quantity, Rate, Amount. Verified J3, J6, J7.
- [x] Invoice TxnLineIDs are freshly generated (not carried from estimate). Verified J8.
- [x] Invoice Subtotal matches estimate Subtotal (1300). Verified J4.
- [x] Invoice posts to AR — customer `Balance` bumps by Subtotal. Verified J13 (delta = +1300).
- [x] Invoice RefNumber defaults to estimate's RefNumber when not overridden. Verified J9.
- [x] Invoice Memo defaults to `"Converted from estimate <ref>"` when not overridden. Verified J10.
- [x] Operator-supplied `invoiceTxnDate` / `invoiceDueDate` / `invoiceRefNumber` / `invoiceMemo` override defaults. Verified M1–M4.
- [x] Default `markAccepted=true` flips estimate `IsAccepted: true` after invoice creation. Verified J11 + J12.
- [x] `markAccepted: false` leaves estimate `IsAccepted` unchanged. Verified K2 + K3.
- [x] Convert non-existent estimate returns `isError: true` (tool layer) — verified at the tool-handler level by inspection (the `if (!estimate)` short-circuit returns the structured error before any side effects).

**Error criteria**:
- [x] `qb_estimate_update` unknown `txnId` rejects via `isError: true` with statusCode 500. Verified I1/I2 via `session.modifyEntity` rejection (the tool's try/catch surfaces this).
- [x] `qb_estimate_update` stale `editSequence` rejects with statusCode 3170. The failed mod does NOT mutate the estimate. Verified C1/C2/C3.
- [x] `qb_estimate_update` new line (no `txnLineID` / `'-1'`) without `itemName`/`itemListId` rejected by `estimateLineModSchema.refine` at the zod boundary. (Schema-only, mirrors invoiceLineModSchema in tools/invoices.ts.)
- [x] `qb_estimate_update` new line without `amount` AND without (`quantity` AND `rate`) rejected by the same refine — Amount must be derivable. (Same.)
- [x] `qb_estimate_delete` unknown `txnId` rejects via `isError: true` with statusCode 500. Verified H1/H2.
- [x] `qb_estimate_convert_to_invoice` source estimate not found returns structured error before any invoice creation. (Tool-layer pre-check — inspection-verified.)

**Regression criteria**:
- [x] `qb_estimate_list` still returns persisted estimates. Verified N5.
- [x] `qb_estimate_create` (now with `lines` support) still creates estimates with the line set converted to `EstimateLineRet`. Verified A1–A6 + J0.
- [x] `qb_invoice_update` (Item 6) still computes Subtotal/BalanceRemaining via the shared `applyLineMods` + `computeTotals` path. Verified N1a–N1c (line mod 5*100 → 10*100 → Subtotal=1000, BalanceRemaining=1000).
- [x] `qb_bill_update` (Item 7) still recomputes AmountDue. Verified N2 (mod from 100 → 250).
- [x] `qb_class_list` (Item 30) still returns 3 active classes. Verified N3.
- [x] `qb_payment_apply` (Item 8) still closes invoices via `ReceivePaymentMod` + `AppliedToTxnMod`. Verified N4 (BalanceRemaining=0 after apply).

**Documentation criteria**:
- [x] README header tool count bumped 50 → 53. Estimate section expanded from 2-tool to 5-tool with intro paragraphs documenting the line-mod semantics, customer-balance non-effect, and the convert flow's carry-over fields + `markAccepted` flag + post-create mark order.
- [x] `instructions` block in [src/index.ts](src/index.ts) updated — estimate bullet now enumerates list/create/update/delete/convert_to_invoice, documents the `lines` argument on create, the wholesale-replace + Subtotal-recompute on update, and the convert tool's mark-after-create order + `markAccepted: false` opt-out.
- [x] `todo.md` Item 13 marked `[x]`.
- [x] `ACCEPTANCE_CRITERIA.md` entry moved to Completed (this entry).
- [x] No new `DECISIONS.md` entry — Option A (tool-layer composition for convert) is just chained primitives. The single architectural touch (extending `handleMod`'s post-mod recompute branch to include Estimate) is a one-line rule extension that mirrors the existing Invoice/Bill semantic for the same line-mod regex; not a tradeoff worth a separate entry.

**Implementation notes**:
- New tool module [src/tools/estimates.ts](src/tools/estimates.ts) hosts all five estimate tools. Estimates were previously co-located with payments in [src/tools/payments.ts](src/tools/payments.ts) — extracted now to follow the "one file per entity domain" convention from CLAUDE.md, since the estimate section was about to balloon from 2 tools to 5. The file header in payments.ts updated accordingly.
- `qb_estimate_create` gained a `lines` arg (same shape as `qb_invoice_create`) — out of strict scope for Item 13 but necessary for `qb_estimate_convert_to_invoice` to be useful end-to-end through the tool surface (without it, the operator can't seed estimates with lines via this MCP and the convert tool has nothing to convert).
- `estimateLineModSchema` mirrors `invoiceLineModSchema` exactly: every field optional, refine requires the create-shape fields ONLY when `txnLineID` is absent or `'-1'`. New lines need `itemName`/`itemListId` AND a way to derive Amount (explicit `amount`, or `quantity` + `rate`).
- `qb_estimate_update` builds the `EstimateLineMod` array only when `args.lines` is provided — header-only mods send no line key and `applyLineMods` short-circuits via `lineModKeys.size === 0`. Try/catch wraps `session.modifyEntity` so simulation 500s and 3170s surface as structured tool errors with `isError: true` + `statusCode` (same pattern as Item 6/7). `isAccepted` is a header field passed through unchanged.
- `qb_estimate_delete` wraps `session.deleteEntity("Estimate", txnId)`. Estimate is in the transaction list at [src/qbxml/builder.ts:115-131](src/qbxml/builder.ts#L115-L131) and routes to `TxnDelRq`. Wrapped in try/catch for the unknown-TxnID case (matches Item 11's structured-error pattern). No customer-balance reversal needed because estimates don't post to AR — the `handleTxnDel` path's adjust call only fires for Invoice/Bill.
- `qb_estimate_convert_to_invoice` is Option A from the prior handoff — pure tool-layer composition. Flow: `queryEntity("Estimate", { TxnID })` → `addEntity("Invoice", { CustomerRef, [carry-over header fields], InvoiceLineAdd: mapped })` → `modifyEntity("Estimate", { IsAccepted: true })`. The mark step runs LAST so a successful invoice is preserved even if the mark fails (surfaced as `markAcceptedError` in the response, distinct from `success: false`). Carries `ClassRef` / `TermsRef` / `SalesRepRef` / `PORefNumber` from the estimate header when present (these can exist on real-QB estimates even though `qb_estimate_create` doesn't accept them yet — the convert tool reads from any estimate, not just MCP-created ones).
- Simulation-store change: extended `handleMod`'s post-mod recompute branch in [src/session/simulation-store.ts](src/session/simulation-store.ts) to fire for Estimate too. Estimate has only `Subtotal` to re-derive (no `AmountDue`, no `BalanceRemaining`, no `IsPaid` — estimates aren't posted to any ledger), and `computeTotals` already handled `Estimate` for the Subtotal case (added in Phase 1 Item 16). The pre-delete that fires for Bill (`delete updated.AmountDue`) is correctly Bill-only — Estimate has no field that needs clearing because `computeTotals` always overwrites Subtotal.
- Verified end-to-end with a 62-check inline script (deleted post-verification): A-series (estimate create with lines + Subtotal derivation + AR-untouched), B-series (header-only mod preservation), C-series (stale EditSequence rejection), D-series (wholesale line replace with merge-by-TxnLineID + Subtotal recompute + AR-untouched), E-series (new-line addition with fresh TxnLineID + Subtotal recompute), F-series (IsAccepted via update), G/H-series (delete happy path + AR-untouched + unknown-TxnID error), I-series (update unknown TxnID error), J-series (default convert with all 13 sub-checks for invoice shape, line carry-over, refnum/memo defaults, mark-accepted, customer balance bump), K-series (markAccepted=false skip), M-series (operator field overrides), N-series regressions for invoice_update / bill_update / class_list / payment_apply / estimate_list. `npm run build` green throughout.

---

### Item 30 — Reference list tools (Class / Terms / PaymentMethod / SalesRep / CustomerType / VendorType) _(Phase 4)_ — done 2026-04-26

**Status:** done

**Behavioral criteria**:
- [x] Six new tools registered and listed by the MCP server: `qb_class_list`, `qb_terms_list`, `qb_payment_method_list`, `qb_sales_rep_list`, `qb_customer_type_list`, `qb_vendor_type_list`. Verified A1–A6.
- [x] Each tool returns a non-empty array when seed data exists for the entity type. Counts: Class=3, StandardTerms=3, DateDrivenTerms=2, PaymentMethod=4, SalesRep=2, CustomerType=3, VendorType=3. Verified B1–B6.
- [x] Each tool returns `{ count: 0, ... : [] }` (graceful empty) when the underlying store has no entities matching the filter. Verified C1.
- [x] `nameFilter`, `activeOnly`, `listId`, `maxReturned` pass through to the simulation's `handleQuery` and behave the same way as in `qb_account_list` / `qb_employee_list`:
  - [x] `nameFilter` is a Contains match against `Name` / `FullName`. Verified D1 (qb_terms_list `nameFilter: "Net"` returns only Net 15 / Net 30 / 2% 10 Net 30).
  - [x] `activeOnly` defaults to true; explicit `activeOnly: false` includes inactive entries. Verified D2 (added an inactive class, default list excludes it, `activeOnly: false` includes it).
  - [x] `listId` fetches a single specific entity. Verified D3.
  - [x] `maxReturned` caps the result count. Verified D4.
- [x] `qb_terms_list` fans across `StandardTerms` + `DateDrivenTerms` by default and merges; result count = StandardTerms count + DateDrivenTerms count. Each row carries a `TermsType` discriminator field set to `"StandardTerms"` or `"DateDrivenTerms"`. Verified E1.
- [x] `qb_terms_list { termsType: "Standard" }` returns only `StandardTerms` rows; `{ termsType: "DateDriven" }` returns only `DateDrivenTerms` rows. Verified E2/E3.
- [x] `qb_sales_rep_list` does NOT accept `nameFilter` (sales reps are keyed by Initial, not Name) — schema-enforced. Confirmed by reading the tool's schema.

**Error criteria**:
- [x] Tools follow existing list-tool conventions (qb_account_list / qb_employee_list / qb_customer_list) which do NOT wrap session errors in try/catch. Reference list queries are read-only and the only meaningful error path is the underlying transport — no need for the structured-error pattern that mutating tools (Items 5/7/8/9/10/11) use.

**Regression criteria**:
- [x] `qb_account_list` defaults still return seed accounts (10). Verified F1.
- [x] `qb_employee_list` defaults still return seed employees. Verified F2.
- [x] `qb_customer_list` defaults still return seed customers (3). Verified F3.
- [x] Item 10 smoke — `qb_account_make_inactive` still works. Verified F4.
- [x] Item 11 smoke — `qb_employee_make_inactive` still works. Verified F5.
- [x] Phase 3 Item 9 smoke — `qb_bill_pay` still closes bills. Verified F6.

**Documentation criteria**:
- [x] README header tool count bumped 44 → 50.
- [x] New "Reference Lists" section between Employees and Reports & Queries explains the read-only nature, the StandardTerms/DateDrivenTerms split for `qb_terms_list`, and lists tool table rows for all six.
- [x] `instructions` block in [src/index.ts](src/index.ts) updated — new bullet enumerates all six tools and explains the `qb_terms_list` fan-out.
- [x] `ACCEPTANCE_CRITERIA.md` entry moved to Completed (this entry).
- [x] No new `DECISIONS.md` entry — fan-out for `qb_terms_list` follows the established `qb_bill_payment_list` pattern (Item 9). Tool-only-no-add/update/delete is the established pattern for read-only reference data (operators define new classes/terms/etc. in QB itself).

**Implementation notes**:
- Tool layer in [src/tools/lists.ts](src/tools/lists.ts) (new file): six tools, all thin wrappers around `session.queryEntity(<type>, filters)`. `qb_terms_list` is the one outlier — fans across `StandardTerms` + `DateDrivenTerms` via `Promise.all`, attaching a `TermsType` discriminator to each row before merging (mirrors the `qb_bill_payment_list` pattern). `qb_sales_rep_list` omits `nameFilter` because real QB SalesRep records are keyed by `Initial`, not by a Name field — `nameFilter` would silently no-op against `e.Name ?? e.FullName` since neither is set.
- Parser in [src/qbxml/parser.ts](src/qbxml/parser.ts): six new `*Ret` entries added to `arrayElements` so multi-element responses come back as arrays even when a single entity exists — `StandardTermsRet`, `DateDrivenTermsRet`, `PaymentMethodRet`, `SalesRepRet`, `CustomerTypeRet`, `VendorTypeRet` (`ClassRet` was already registered).
- Simulation in [src/session/simulation-store.ts](src/session/simulation-store.ts): seed data added at the end of `seedData()` for all seven stores (Class, StandardTerms, DateDrivenTerms, PaymentMethod, SalesRep, CustomerType, VendorType). No request-handler changes needed — the generic `handleQuery` path with `getStore(entityType)` works as-is for any list entity, exactly as the prior Item 11 handoff predicted.
- Builder in [src/qbxml/builder.ts](src/qbxml/builder.ts): no changes — `buildQueryRequest` is generic (`${entityType}QueryRq`) so Class / StandardTerms / DateDrivenTerms / PaymentMethod / SalesRep / CustomerType / VendorType all flow through the existing path.
- Verified end-to-end with a 25-check inline script (deleted post-verification): A1–A6 tool registration; B1–B6 seed-data presence per type; C1 graceful empty; D1–D4 filter pass-through (nameFilter / activeOnly / listId / maxReturned); E1–E3 termsType fan-out; F1–F6 regressions. `npm run build` green throughout.

---

### Item 11 — `qb_employee_make_inactive` + `qb_employee_delete` _(Phase 4)_ — done 2026-04-26

**Status:** done

**Behavioral criteria**:
- [x] `qb_employee_make_inactive` is registered and listed by the MCP server. Accepts `listId` + `editSequence` only (bare-minimum schema). Verified A1.
- [x] Calling `qb_employee_make_inactive` with a valid `listId` + matching `editSequence` returns the modified employee with `IsActive: false` and a fresh `EditSequence`. Verified A3/A4.
- [x] After deactivation, the employee does NOT appear in `qb_employee_list { activeOnly: true }`. Verified A5.
- [x] After deactivation, the employee DOES appear in `qb_employee_list { activeOnly: false }` — record preserved, just hidden. Verified A6.
- [x] Reversible via `qb_employee_update { isActive: true }`. Verified A7/A8.
- [x] `qb_employee_delete` is registered and listed. Accepts `listId` only. Verified C1.
- [x] `qb_employee_delete` removes the employee from the store (subsequent list queries don't contain it). Verified C2.
- [x] `qb_employee_delete` returns `{ success: true, deleted: { ListDelType: "Employee", ListID: <id> } }` on success. Verified C1.

**Error criteria**:
- [x] `qb_employee_make_inactive` with stale `editSequence` returns `isError: true` + `statusCode: 3170`. Verified B1; employee stays active after rejection (B2).
- [x] `qb_employee_make_inactive` with unknown `listId` returns `isError: true` + `statusCode: 500`. Verified B3.
- [x] `qb_employee_delete` with unknown `listId` returns `isError: true` + `statusCode: 500`. Verified D1.
- [x] Both tools wrap session calls in try/catch (same pattern as Items 5/7/8/9/10) — simulation errors surface as structured `isError: true` + `statusCode`, not raw exceptions.
- [x] `qb_employee_delete` tool description warns about the inactive-vs-delete tradeoff (real QB returns 3260/3170 for employees with paycheck/timesheet history).

**Regression criteria**:
- [x] `qb_employee_list` (existing) still returns seed employees. Verified E1.
- [x] `qb_employee_add` (existing) still creates employees with `IsActive: true`. Verified E2.
- [x] `qb_employee_update` (existing) still updates non-IsActive fields (Phone). Verified E3.
- [x] Shared `handleListDel` plumbing intact — Account delete still works. Verified E4.
- [x] Item 10 smoke — `qb_account_make_inactive` still flips `IsActive`. Verified E5.
- [x] Phase 3 Item 9 smoke — `qb_bill_pay` still closes bills (AmountDue=0, IsPaid=true). Verified E6.

**Documentation criteria**:
- [x] README employee section: explains `qb_employee_make_inactive` (preferred for employees with history) vs `qb_employee_delete` (hard delete) tradeoff. Tool table rows added for both.
- [x] `instructions` block in [src/index.ts](src/index.ts) updated — employee bullet now mentions delete + make_inactive with the inactive-vs-delete tradeoff.
- [x] Tool count in README header bumped 42 → 44.
- [x] `ACCEPTANCE_CRITERIA.md` entry moved to Completed (this entry).
- [x] No new `DECISIONS.md` entry — same two-separate-tools pattern as Item 10 (an established QB SDK convention, not a project-specific tradeoff).

**Implementation notes**:
- Tool layer in [src/tools/employees.ts](src/tools/employees.ts):
  - `qb_employee_make_inactive` is a thin wrapper around `session.modifyEntity("Employee", { ListID, EditSequence, IsActive: false })`. Bare-minimum schema (just `listId` + `editSequence`) — operators wanting to mutate FirstName / LastName / Phone / Email should still use `qb_employee_update`.
  - `qb_employee_delete` wraps `session.deleteEntity("Employee", listId)`. Tool description explicitly warns about real QB's 3260/3170 rejection for employees with paycheck/timesheet history and recommends `make_inactive` as the safer default.
  - Both tools use the established try/catch pattern from Items 5/7/8/9/10.
- Simulation in [src/session/simulation-store.ts](src/session/simulation-store.ts) — no changes needed. `handleMod`'s generic `{...modData}` spread already supports `IsActive` mutation; `handleListDel` already routes `Employee` to its own per-entity store generically (the entityType is read from `ListDelType`). Same as Item 10.
- Verified end-to-end with a 20-check inline script (deleted post-verification): A1–A8 make_inactive happy path including reversibility via `qb_employee_update`; B1–B3 stale-EditSequence (3170) and unknown-listId (500) error paths with no side effects on rejection; C1–C2 delete happy path; D1 delete error path; E1–E6 regressions for `qb_employee_list` defaults, `qb_employee_add` IsActive default, `qb_employee_update` non-IsActive fields (Phone), shared `handleListDel` plumbing via Account delete, Item 10 `qb_account_make_inactive` smoke, and Phase 3 Item 9 `qb_bill_pay` smoke. `npm run build` green throughout.

---

### Item 10 — `qb_account_delete` + `qb_account_make_inactive` _(Phase 4)_ — done 2026-04-26

**Status:** done

**Behavioral criteria**:
- [x] `qb_account_make_inactive` is registered and listed by the MCP server. Accepts `listId` + `editSequence` only (bare-minimum schema). Verified A1.
- [x] Calling `qb_account_make_inactive` with a valid `listId` + matching `editSequence` returns the modified account with `IsActive: false` and a fresh `EditSequence`. Verified A4/A5.
- [x] After deactivation, the account does NOT appear in `qb_account_list { activeOnly: true }`. Verified A6.
- [x] After deactivation, the account DOES appear in `qb_account_list { activeOnly: false }` — record preserved, just hidden. Verified A7.
- [x] Reversible via `qb_account_update { isActive: true }`. Verified A8/A9.
- [x] `qb_account_delete` is registered and listed. Accepts `listId` only. Verified C1.
- [x] `qb_account_delete` removes the account from the store (subsequent list queries don't contain it). Verified C4.
- [x] `qb_account_delete` returns `{ success: true, deleted: { ListDelType: "Account", ListID: <id> } }` on success. Verified C2/C3.

**Error criteria**:
- [x] `qb_account_make_inactive` with stale `editSequence` returns `isError: true` + `statusCode: 3170`. Verified B1/B2; account stays active after rejection (B3).
- [x] `qb_account_make_inactive` with unknown `listId` returns `isError: true` + `statusCode: 500`. Verified B4/B5.
- [x] `qb_account_delete` with unknown `listId` returns `isError: true` + `statusCode: 500`. Verified D1/D2.
- [x] Both tools wrap session calls in try/catch (same pattern as Items 5/7/8/9) — simulation errors surface as structured `isError: true` + `statusCode`, not raw exceptions.
- [x] `qb_account_delete` tool description warns about the inactive-vs-delete tradeoff (real QB returns 3260/3170 for accounts with history).

**Regression criteria**:
- [x] `qb_account_list` (existing) still returns the seed accounts. Verified E1/E2 (Checking + Utilities seed accounts present).
- [x] `qb_account_add` (existing) still creates accounts with `IsActive: true`. Verified E3/E4.
- [x] `qb_account_update` (existing) still updates non-IsActive fields (Description). Verified E5/E6.
- [x] Shared `handleListDel` plumbing intact — Customer delete still works. Verified E7.
- [x] Phase 3 Item 9 (`qb_bill_pay`) smoke — bill_pay closure + IsPaid flip + payment TotalAmount. Verified F1–F3.

**Documentation criteria**:
- [x] README account section: explains `qb_account_make_inactive` (preferred for accounts with history) vs `qb_account_delete` (hard delete) tradeoff. Tool table rows added for both.
- [x] `instructions` block in [src/index.ts](src/index.ts) updated — account bullet now mentions delete + make_inactive with the inactive-vs-delete tradeoff.
- [x] Tool count in README header bumped 40 → 42.
- [x] `ACCEPTANCE_CRITERIA.md` entry moved to Completed (this entry).
- [x] No new `DECISIONS.md` entry — two-separate-tools (vs discriminated) was the recommended choice in the prior handoff and matches the existing pattern (e.g. `qb_invoice_delete` is its own tool, not a mode of `qb_invoice_update`).

**Implementation notes**:
- Tool layer in [src/tools/accounts.ts](src/tools/accounts.ts):
  - `qb_account_make_inactive` is a thin wrapper around `session.modifyEntity("Account", { ListID, EditSequence, IsActive: false })`. Bare-minimum schema (just `listId` + `editSequence`) — operators wanting to mutate Name / AccountNumber / Description should still use `qb_account_update`.
  - `qb_account_delete` wraps `session.deleteEntity("Account", listId)`. Tool description explicitly warns about real QB's 3260/3170 rejection for accounts with history and recommends `make_inactive` as the safer default.
  - Both tools use the established try/catch pattern from Items 5/7/8/9 — `session.*Entity` errors surface as `isError: true` + structured `error` + `statusCode`.
- Simulation in [src/session/simulation-store.ts](src/session/simulation-store.ts) — no changes needed. `handleMod`'s generic `{...modData}` spread already supports `IsActive` mutation; `handleListDel` already supports `Account` (the entityType is read from `ListDelType` and the per-entity store is generic).
- Verified end-to-end with a 30-check inline script (deleted post-verification): A1–A9 make_inactive happy path including reversibility via `qb_account_update`; B1–B5 stale-EditSequence and unknown-listId error paths; C1–C4 delete happy path; D1/D2 delete error path; E1–E7 regressions for `qb_account_list` defaults, `qb_account_add` IsActive, `qb_account_update` non-IsActive fields, and shared `handleListDel` plumbing via Customer; F1–F3 Phase 3 Item 9 smoke. `npm run build` green throughout.

---

### Item 9 — `qb_bill_pay` + `qb_bill_payment_list` _(Phase 3)_ — done 2026-04-26

**Status:** done

**Behavioral criteria**:
- [x] `qb_bill_pay` is registered and listed by the MCP server. Routes via `paymentMethod: "check" | "creditcard"` discriminator to `BillPaymentCheck` or `BillPaymentCreditCard`. Verified A1–A10 (check route) + E1–E5 (credit card route — payment lands in correct store, NOT the other).
- [x] `applyTo: [{txnId, amount, discountAmount?, discountAccountName?}]` is required and non-empty (`z.array(...).min(1)`); empty array rejected at the simulation level too with statusCode 500. Verified G1/G2.
- [x] Each `applyTo` entry reduces the named bill's `AmountDue` by `paymentAmount + discountAmount`. Verified A3 (500 → 0), B1 (1000 → 700), C1+C3 (multi-bill split), D1 (950 + 50 discount → 0), H1 (over-payment → -50).
- [x] Bill `IsPaid` flips to true when `AmountDue` hits 0 exactly. Verified A4, C2/C4, D2, E2.
- [x] Over-payment leaves `AmountDue` negative + `IsPaid` false (vendor credit semantics — matches Invoice over-application policy from Item 6). Verified H1/H2 (AmountDue = -50, IsPaid = false).
- [x] Vendor `Balance` decreases by the applied sum (NOT including discount). Verified A5 (-500), B3 (-300), C5 (-500 across two bills), D3 (-950 NOT -1000), E3 (-400), H3 (-150 on over-pay).
- [x] `BillPaymentCheck.TotalAmount` / `BillPaymentCreditCard.TotalAmount` returned on the response = sum of applied PaymentAmounts (NOT including discount, since discount isn't a cash flow). Verified A6, C6, D4, H4.
- [x] `AppliedToTxnRet` array carries `TxnLineID`, `TxnID`, `PaymentAmount`, optional `DiscountAmount` + `DiscountAccountRef`. Verified A7–A9, C7, D5/D6.
- [x] `qb_bill_payment_list` fans out across both `BillPaymentCheck` + `BillPaymentCreditCard` stores by default; `paymentType: "check" | "creditcard"` scopes to one. Verified I1/I2 (mixed inventory: count = checkStore + ccStore, both stores have entries from prior checks).
- [x] `Bill.IsPaid` field added by `computeTotals` symmetric with Invoice — bills created via `qb_bill_create` have `IsPaid = false` initially (since `AmountDue > 0`); bills with no lines or explicit `AmountDue: 0` have `IsPaid = true`. Verified A1/A2 (created bill has `AmountDue=500`, `IsPaid=false`).

**Error criteria**:
- [x] Unknown bill `txnId` in `applyTo` rejects with `isError: true`, statusCode 500. CRITICAL atomicity invariant: a valid line followed by an orphan in the SAME `AppliedToTxnAdd` array does NOT mutate the valid bill or move vendor balance. Verified F1–F6 (line 1 = real bill $800, line 2 = orphan; rejected; real bill still AmountDue=800/IsPaid=false; vendor balance UNCHANGED; NO phantom payment in store).
- [x] Empty `applyTo` array rejected at the simulation level (defensive — tool layer's `z.array(...).min(1)` gates this first, but the simulation guards too in case a future caller bypasses the schema). Verified G1/G2.
- [x] Tool layer's try/catch wraps `session.addEntity` so simulation 500s surface as structured `isError: true` + `statusCode` (same pattern as Items 5/8).

**Regression criteria**:
- [x] `qb_payment_receive` (Item 5) Add path with `appliedTo` still closes invoices and moves customer balance. Verified J1/J2.
- [x] `qb_payment_apply` (Item 8) `ReceivePaymentMod` path still re-applies an existing payment to a new invoice. Verified L1.
- [x] `qb_bill_update` (Item 7) line mod still recomputes `AmountDue` and moves vendor balance by the delta. Verified K1/K2/K3 — including the new `IsPaid` field staying false on a non-zero AmountDue post-update.
- [x] `qb_bill_create` (Item 4) still creates a bill with `AmountDue = sum(lines)` and `IsPaid = false`. Verified A1/A2 (used as setup throughout).
- [x] AP aging would reflect the post-payment vendor balance — `qb_ap_aging` reads `Vendor.Balance` directly per Item 18, which is moved end-to-end via `adjustEntityBalance("Vendor", refKey, -appliedSum)` in `applyBillPayment`.
- [x] No new TypeScript errors; `npm run build` green throughout.

**Documentation criteria**:
- [x] README bill section: two new paragraphs explain `qb_bill_pay` semantics (paymentMethod discriminator, applyTo required, AmountDue reduction, IsPaid flip, discount handling, over-payment policy, atomic orphan rejection) and `qb_bill_payment_list` fan-out. Tool table rows added for both.
- [x] `instructions` block in [src/index.ts](src/index.ts) bill bullet expanded with `qb_bill_pay` + `qb_bill_payment_list` semantics.
- [x] Tool count in README header bumped 38 → 40.
- [x] `ACCEPTANCE_CRITERIA.md` entry moved to Completed (this entry).
- [x] No new `DECISIONS.md` entry — single-tool-with-discriminator + single-list-with-fanout were the recommended choices in the prior handoff and don't introduce surprise tradeoffs. Parallel `applyBillPayment` (rather than a generic `applyTxnPayments` extracted from the AR side) follows CLAUDE.md's "three similar lines is better than a premature abstraction" — there are exactly 2 call sites and the divergent fields (no AppliedAmount/UnusedPayment on bill payments, different store/balance/ref) make the abstraction shape uncertain. Will revisit if a third payment kind lands.

**Implementation notes**:
- Tool layer in [src/tools/bills.ts](src/tools/bills.ts):
  - New `appliedToBillSchema` duplicated alongside `appliedToSchema` from [src/tools/payments.ts](src/tools/payments.ts) — same field shape but the named entity is a Bill. Hoisting to a shared file deferred (8 lines, two call sites; no share-pressure yet).
  - `qb_bill_pay` is a single tool with `paymentMethod: z.enum(["check", "creditcard"])` discriminator. Routes to `addEntity("BillPaymentCheck", ...)` or `addEntity("BillPaymentCreditCard", ...)` in the handler. Optional `bankAccountName` / `creditCardAccountName` / `apAccountName` fields propagate as `BankAccountRef` / `CreditCardAccountRef` / `APAccountRef` (real QB SDK shape).
  - `applyTo` uses `.min(1)` so the schema rejects empty arrays at the boundary.
  - try/catch wraps `session.addEntity` so simulation 500s surface as structured tool errors with `isError: true` + `statusCode` (same pattern as Items 5/8).
  - `qb_bill_payment_list` fans out via `Promise.all` when no `paymentType` is provided (parallel queries on both stores). Single-type queries skip the fan-out. `MaxReturned` is applied per-store on the fan-out path — documented in the field's `.describe()`.
- Simulation in [src/session/simulation-store.ts](src/session/simulation-store.ts):
  - New `applyBillPayment(payment)` is a parallel function to `applyReceivePayment`. Two-pass: validate every TxnID exists in the Bill store first (atomicity), then mutate. No overapplication-vs-TotalAmount check because BillPayment's TotalAmount is derived from the applied sum (not a separable header total like ReceivePayment's). Sets `payment.TotalAmount = appliedSum` so consumers don't have to re-derive.
  - Bill mutation: `bill.AmountDue -= paymentAmount + discountAmount`, `bill.IsPaid = bill.AmountDue === 0`. Strict equality (no clamping on over-payment) matches Item 6's BalanceRemaining policy.
  - Vendor balance moves via the existing `adjustEntityBalance("Vendor", refKey, -appliedSum)` helper from Item 18 — same machinery as Item 5's AR-side customer balance move.
  - `handleAdd` branches on `entityType === "BillPaymentCheck" || entityType === "BillPaymentCreditCard"` and dispatches to `applyBillPayment`. Mirrors the existing `entityType === "ReceivePayment"` branch.
  - `computeTotals` extended: Bill branch now sets `result.IsPaid = Number(result.AmountDue ?? 0) === 0`. Symmetric with Invoice's `IsPaid` derivation. Invoice's `IsPaid` set independently a few lines below — kept separate for readability since Invoice's `BalanceRemaining` formula has more inputs (Subtotal + SalesTaxTotal − AppliedAmount).
  - No `BillPaymentCheckMod` / `BillPaymentCreditCardMod` path — Item 9 is Add-only. Re-targeting bill payments is implicit Phase 4 work; not currently in the todo list.
- Parser in [src/qbxml/parser.ts](src/qbxml/parser.ts): added `BillPaymentCheckRet`, `BillPaymentCreditCardRet` to `arrayElements` so live mode parses single-bill-payment responses as 1-element arrays. `AppliedToTxnRet` was already there from Item 5.
- Verified end-to-end with a 51-check inline script (deleted post-verification per "no test infra yet"): single-bill check happy path with full close-out + IsPaid flip + vendor balance drop (A1–A10), partial pay with bill open + IsPaid false (B1–B3), multi-bill split closing both bills atomically (C1–C7), discount preservation with vendor-balance-only-by-paid-amount (D1–D6), credit card route lands in correct store (E1–E5), orphan TxnID atomicity — line 1 valid + line 2 orphan = NO mutation anywhere (F1–F6), empty applyTo rejection (G1/G2), over-payment producing negative AmountDue + IsPaid false + full vendor balance hit (H1–H4), `qb_bill_payment_list` fan-out (I1/I2), regressions for Item 5 `qb_payment_receive` (J1/J2), Item 7 `qb_bill_update` line mod with new IsPaid field (K1–K3), Item 8 `qb_payment_apply` (L1). One verification-script bug surfaced and fixed: `vbal()` helper used `ListFilter: { FullName: ... }` which the sim doesn't recognize, so it silently returned all vendors and `r[0]` was wrong on any non-first vendor. Fixed by querying all + `find(v => v.FullName === name)`. Implementation was correct throughout. `npm run build` green.

---

### Item 8 — `qb_payment_apply` (`ReceivePaymentMod` + `AppliedToTxnMod`) _(Phase 3)_ — done 2026-04-26

**Status:** done

**Behavioral criteria**:
- [x] `qb_payment_apply` is registered and listed by the MCP server. Verified A5/B/C/D/E paths all execute through the tool's `session.modifyEntity("ReceivePayment", ...)` plumbing.
- [x] Calling with `txnId` + `editSequence` + `applyTo: [{txnId, amount}]` against a previously-unapplied payment closes the named invoice (`BalanceRemaining` → 0, `IsPaid=true`, `AppliedAmount` bumps by amount), drops customer balance by the applied sum, and rotates the payment's `EditSequence`. Verified A5–A12.
- [x] Re-targeting from invoice A → invoice B atomically reverses A (BR/AppliedAmount/IsPaid restored) and applies B. Customer balance moves by the *change* in applied sum (delta=0 in same-amount case, signed when amounts differ). Verified B4–B10 (re-target with delta=0) and C7 (delta=+700 → balance drops by 700) and D5 (delta=-600 → balance rises by 600).
- [x] `applyTo: []` (or omitted `AppliedToTxnMod` block) fully unapplies the payment: the previously-applied invoices are restored, customer balance is restored, payment carries `AppliedToTxnRet=[]` + `AppliedAmount=0` + `UnusedPayment=TotalAmount`. Verified E2–E8.
- [x] Discount is preserved through the mod path: `DiscountAmount` reduces `BalanceRemaining` alongside the payment but does NOT count toward `AppliedAmount` and does NOT move the customer balance. `DiscountAccountRef` round-trips. Verified F1–F7.
- [x] Multi-invoice application splits a single payment across N invoices in one call. Verified J1–J6 (2-invoice split).
- [x] Header fields (`memo`, `refNumber`, `txnDate`, `paymentMethodName`) propagate through the mod and persist via re-query. Verified K1–K4 for memo + refNumber.
- [x] `payment.AppliedAmount = sum(new applied)` and `payment.UnusedPayment = TotalAmount - sum(new applied)` recompute after every mod. Verified across A6, B12/B13, C8/C9, D6/D7, E7/E8, F7, J5/J6.

**Error criteria**:
- [x] Unknown invoice `txnId` in `applyTo` rejects with `isError: true`, statusCode 500. The failed mod does NOT reverse the existing application or move the customer balance. Verified H2–H6.
- [x] Overapplication (`sum(applyTo.amount) > payment.TotalAmount`) rejects with statusCode 500. The simulation is the authoritative gate (the tool can't validate against TotalAmount without a pre-query). Verified I1–I5; payment + invoice state untouched after rejection.
- [x] Stale `editSequence` rejects with statusCode 3170 via the global `handleMod` EditSequence check. The failed mod does NOT mutate the payment or invoices. Verified G1–G4.

**Regression criteria**:
- [x] `qb_payment_receive` (Item 5) Add path with `appliedTo` still closes invoices and moves customer balance. Verified L1.
- [x] `qb_invoice_update` (Item 6) header-only mod still propagates Memo. Verified M1.
- [x] `qb_bill_update` (Item 7) line-mod still recomputes `AmountDue`. Verified N1.
- [x] `qb_payment_list` returns the modded payment with intact `AppliedToTxnRet` (verified throughout — every check re-queried via `getPayment`).
- [x] AR aging reflects the moved customer balance — Item 18's helpers `adjustEntityBalance` / `Customer.Balance` direct read drive both the apply and reverse paths.

**Documentation criteria**:
- [x] README payment section: intro paragraph explains `qb_payment_apply` semantics — replacement-array, reverse-then-apply, customer-balance-by-delta, empty-array-fully-unapplies, immutable TotalAmount, 3170 rejection on stale editSequence. Tool table row added.
- [x] `instructions` block in [src/index.ts](src/index.ts): `qb_payment_*` line expanded to flag `qb_payment_apply` + the immutable-TotalAmount rule + 3170 rejection.
- [x] Tool count in README header bumped 37 → 38.
- [x] `ACCEPTANCE_CRITERIA.md` entry moved to Completed (this entry).
- [x] No new `DECISIONS.md` entry — the validate-then-reverse-then-apply ordering is the obvious atomicity choice (avoids the rollback-on-orphan edge case) and falls naturally out of the existing two-pass pattern in `applyTxnApplications`. The "TotalAmount is immutable on this path" choice matches real QB and is documented in the tool description.

**Implementation notes**:
- Tool layer in [src/tools/payments.ts](src/tools/payments.ts):
  - Reused the existing `appliedToSchema` from Item 5 — same shape (`txnId`, `amount`, optional `discountAmount` + `discountAccountName`).
  - `applyTo` is required (no `.optional()`), but the tool accepts `applyTo: []` to fully unapply. Forcing the operator to pass an explicit array (even empty) makes intent unambiguous.
  - Builds `AppliedToTxnMod` blocks in the same shape as `AppliedToTxnAdd` from Item 5 — the simulation engine accepts both because `applyTxnApplications` only reads `TxnID` / `PaymentAmount` / `DiscountAmount` / `DiscountAccountRef` from each line.
  - try/catch wraps `session.modifyEntity` so simulation 500s (orphan TxnID, overapplication) and 3170s (stale EditSequence) surface as structured tool errors with `isError: true` + `statusCode`.
  - Optional header fields (`memo`, `refNumber`, `txnDate`, `paymentMethodName`) propagate through the same merge path used by `qb_payment_receive`.
- Simulation engine refactor in [src/session/simulation-store.ts](src/session/simulation-store.ts):
  - Split `applyReceivePayment`'s validation pass into a standalone `validateTxnApplications(lines, totalAmount)` helper. Pure — returns ok/error with no mutation. Reused by `applyTxnApplications` (called inline) and by `handleReceivePaymentMod` (called BEFORE the reversal so a doomed mod never disturbs payment state).
  - New `applyTxnApplications(payment, lines)` is the engine for both Add and Mod paths. Takes the line array directly so the caller controls where it comes from (`payment.AppliedToTxnAdd` for Add, `modData.AppliedToTxnMod` for Mod).
  - `applyReceivePayment` is now a thin shim that reads `payment.AppliedToTxnAdd`, deletes it, and hands the array to `applyTxnApplications`.
  - New `reverseReceivePaymentApplication(payment)` walks `payment.AppliedToTxnRet` and undoes every per-invoice bump + customer balance move. Tolerates orphan TxnIDs in the prior application (silently skipped on per-invoice undo, but still moves customer balance by the named applied sum — the original Add path moved the customer balance regardless of where the targets ended up). Resets `AppliedToTxnRet=[]`, `AppliedAmount=0`, `UnusedPayment=TotalAmount`.
  - New `handleReceivePaymentMod` in `handleMod`: short-circuits before the Bill/Invoice line-mod plumbing (the AppliedToTxnMod block doesn't match `/^(.+?)Line(s?)Mod$/` and the rest of the path doesn't apply). Flow: validate → reverse → apply → merge headers → bump TimeModified + EditSequence → persist. Reserved keys (`AppliedToTxnMod`, `AppliedToTxnRet`, `AppliedAmount`, `UnusedPayment`, `TotalAmount`, `TxnID`, `EditSequence`) stripped from the header merge — the engine owns those, the operator can't overwrite.
  - `validateTxnApplications` is called twice per mod (once in `handleReceivePaymentMod`, once inside `applyTxnApplications`). Cheap (O(N) per pass), and the redundant call is the price of keeping `applyTxnApplications` self-validating for the Add path.
- Verified end-to-end with an 84-check inline script (deleted post-verification per "no test infra yet"): single-invoice apply (A1–A12), re-target with delta-zero balance (B1–B13), increase applied with positive delta on customer balance (C1–C9), decrease applied with negative delta (D1–D7), full unapply via empty AppliedToTxnMod (E1–E8), discount preservation through mod path (F1–F7), stale-EditSequence rejection without rollback (G1–G4), orphan TxnID rejection without side effects (H1–H6) — confirms the validate-first ordering works, overapplication rejection (I1–I5), multi-invoice split (J1–J6), header field propagation (K1–K4), and regressions for `qb_payment_receive` Item 5 (L1), `qb_invoice_update` Item 6 (M1), `qb_bill_update` Item 7 (N1). `npm run build` green throughout.

---

### Item 6 — `qb_invoice_update` line mod (`InvoiceLineMod`) _(Phase 3)_ — done 2026-04-26

**Status:** done

**Behavioral criteria**:
- [x] `qb_invoice_update` accepts an optional `lines: [{txnLineID?, itemName?, itemListId?, description?, quantity?, rate?, amount?}]` arg. Verified A1 setup + B/D/E/F/G mods.
- [x] Header-only mod (no `lines`) leaves the existing `InvoiceLineRet` array, `Subtotal`, `BalanceRemaining`, `IsPaid`, and `AppliedAmount` untouched. Memo propagates. Verified B1–B9.
- [x] When `lines` is provided, the array REPLACES the invoice's `InvoiceLineRet` wholesale — lines whose `TxnLineID` is not listed are dropped. Verified D1 (2 → 1) and F1 (2 → 1 again with different existing line).
- [x] A line entry with a `txnLineID` matching an existing line preserves that `TxnLineID` and merges the mod's fields onto the existing line. Verified D2 (TxnLineID preserved), D3 (rate carried), D5 (Desc merged), F3 (rate carried via partial merge).
- [x] A line entry without `txnLineID` (or with `'-1'`) gets a freshly-generated `TxnLineID` and is treated as a new line. Verified E3 (new TxnLineID ≠ either prior ID).
- [x] After a line mod, `Subtotal` recomputes from the new line set; `BalanceRemaining = Subtotal + SalesTaxTotal - AppliedAmount` recomputes; `IsPaid = (BalanceRemaining === 0)` recomputes. Verified D6/D7/D8, E5, F5/F6, G3/G5/G6.
- [x] `AppliedAmount` is preserved across line mods (paid portions don't disappear when lines change). Verified D9 (=0 preserved), G4 (=600 preserved across over-apply mod).
- [x] If a line mod drops `Subtotal` below `AppliedAmount`, `BalanceRemaining` goes negative (over-application state) and `IsPaid` becomes false. No clamping. Verified G5 (BR=-300) and G6 (IsPaid=false on negative).
- [x] Customer `Balance` adjusts by `newBalanceRemaining - oldBalanceRemaining` (signed delta). Verified D10 (-50), E6 (+75), F (transitive), G7 (-700 on over-apply), and reverse-then-apply on customer change H3 (-500) + H4 (+500).
- [x] An `Amount` re-derives from the merged line: `Quantity * Rate` when both are present (changing only `quantity` on an existing line picks up the existing `rate`); explicit `amount` wins when provided; otherwise carries from the merge. Verified F4 (`5 * 100 = 500` from existing rate), E4 (explicit `Amount: 75` honored), D4 (`2 * 100 = 200` from preserved fields).

**Error criteria**:
- [x] Unknown `txnId` rejects via `isError: true` with statusCode 500. Verified I1/I2 via tool's try/catch wrapper around `session.modifyEntity`.
- [x] Stale `editSequence` rejects with statusCode 3170. The failed mod does NOT mutate the invoice. Verified C1/C2/C3.
- [x] New line (no `txnLineID` / `'-1'`) without `itemName`/`itemListId` rejected by `invoiceLineModSchema.refine` at the zod boundary. (Schema-only, not exercised in the QBSessionManager-level script.)
- [x] New line without `amount` AND without (`quantity` AND `rate`) rejected by the same refine — Amount must be derivable. (Same.)

**Regression criteria**:
- [x] `qb_invoice_create` still creates with `Subtotal = sum(lines)` and customer balance bump. Verified M1/M2.
- [x] `qb_invoice_delete` still reverses customer balance. Verified N1.
- [x] `qb_invoice_list` still returns persisted invoices with intact `InvoiceLineRet` (verified throughout — every mod check re-queried via getInvoice).
- [x] `qb_bill_update` still works (Item 7 path) — same `applyLineMods`, same `EditSequence` enforcement, same generalized party-balance helper. Verified K1 (create=100), K2 (mod=250), K3 (vendor balance moved by +150).
- [x] `qb_payment_receive` (Item 5) still applies and updates invoice `BalanceRemaining` / `AppliedAmount`. Verified G1 (AppliedAmount=600), G2 (BalanceRemaining=400) — payment side worked end-to-end before the line-mod.
- [x] `qb_customer_update` with fresh `EditSequence` still succeeds. Verified L1.
- [x] AR aging reflects post-mod customer balance — reads `Customer.Balance` directly per Item 18; balance moves are end-to-end-verified.

**Documentation criteria**:
- [x] README invoice section: intro paragraph documents `lines` semantics, BalanceRemaining recompute, AppliedAmount preservation, negative-on-overapply, customer-balance delta, and the 3170 rejection. Tool table row updated with `lines` shape and customer-balance delta description.
- [x] `instructions` block in [src/index.ts](src/index.ts) invoice bullet expanded with mod semantics, `AppliedAmount` preservation, over-apply behavior, and 3170 rejection.
- [x] `ACCEPTANCE_CRITERIA.md` entry moved to Completed (this entry).
- [x] No new `DECISIONS.md` entry — Item 7's "Bill line-mod uses wholesale replacement with merge-by-TxnLineID" already documents the generic line-mod approach. The negative-`BalanceRemaining` policy (accept, no clamp) follows directly from `BalanceRemaining = Subtotal + SalesTaxTotal - AppliedAmount` and matches real QB; not a tradeoff worth a separate entry.

**Implementation notes**:
- Tool layer in [src/tools/invoices.ts](src/tools/invoices.ts):
  - `invoiceLineModSchema` mirrors Item 7's pattern: every field optional so a partial mod (e.g. just `description` on an existing line) works; refine requires the create-shape fields ONLY when `txnLineID` is absent or `'-1'`. New lines need `itemName`/`itemListId` AND a way to derive Amount (explicit `amount`, or `quantity` + `rate`).
  - `qb_invoice_update` builds the `InvoiceLineMod` array only when `args.lines` is provided — header-only mods send no line key and `applyLineMods` short-circuits via `lineModKeys.size === 0`.
  - Try/catch wraps `session.modifyEntity` so simulation 500s and 3170s surface as structured tool errors with `isError: true` + `statusCode` (same pattern as Item 5/7).
- Simulation `handleMod` in [src/session/simulation-store.ts](src/session/simulation-store.ts):
  - Generalized `adjustVendorBalanceForBillMod` → `adjustPartyBalanceForTxnMod(partyType, refField, amountField, before, after, oldAmount)`. Bill and Invoice share the same machinery; the only per-entity choices are which ref field to read and which amount field maps to the party's open balance.
  - `oldPartyAmount` capture branches on `entityType`: Bill reads `existing.AmountDue`, Invoice reads `existing.BalanceRemaining`. Captured BEFORE `applyLineMods` so the pre-mod value is preserved.
  - Recompute branch fires for both Bill and Invoice when `lineModKeys.size > 0`. For Bill, `delete updated.AmountDue` first (because `computeTotals` only sets `AmountDue` when undefined — preserves explicit overrides). For Invoice, no pre-delete needed because `computeTotals` always overwrites `Subtotal` / `BalanceRemaining` / `IsPaid`. `AppliedAmount` is read from `result.AppliedAmount ?? 0` and preserved.
  - `applyLineMods` itself is unchanged — the `/^(.+?)Line(s?)Mod$/` regex matched `InvoiceLineMod` for free.
- Verified end-to-end with a 61-check inline script (deleted post-verification per "no test infra yet"): invoice setup with line totals + customer balance bump (A1–A7), header-only mod with full preservation (B1–B9), stale-EditSequence rejection (C1–C3), wholesale line drop with field merge + balance delta (D1–D10), new line addition with fresh TxnLineID + balance delta (E1–E6), quantity-only mod re-deriving Amount via existing rate (F1–F6), over-application from line drop on partially-paid invoice with negative BalanceRemaining + customer balance delta (G1–G7), customer-change reverse-then-apply (H1–H4), unknown-TxnID rejection (I1/I2), and full regressions for `qb_bill_update` (K1–K3), `qb_customer_update` (L1), `qb_invoice_create` (M1/M2), `qb_invoice_delete` (N1). One verification-script bug surfaced and fixed: the script was holding object references from `queryEntity` and reading `.Balance` later, which returned the latest mutated value rather than a snapshot — `getCustomerBalance(name)` helper now captures the value as a Number at query time. Implementation was correct throughout. `npm run build` green.

---

### Item 7 — `qb_bill_update` (BillModRq) _(Phase 3)_ — done 2026-04-25

**Status:** done

**Behavioral criteria**:
- [x] `qb_bill_update` is registered and listed by the MCP server. Verified via setup step (bill created and TxnID/EditSequence captured).
- [x] Calling with `txnId` + `editSequence` + a new `memo` returns the bill with the new memo and a fresh `EditSequence`. Verified Header-only memo mod check.
- [x] Header-only mod (no line args) leaves the existing `ExpenseLineRet` and `AmountDue` untouched.
- [x] Header field updates propagate: `memo`, `vendorName` (verified explicitly via vendor-change check), `txnDate` / `dueDate` / `refNumber` follow the same `{...modData}` spread path so propagate identically.
- [x] `expenseLines` wholesale-replace + merge-by-`TxnLineID` semantics work: a single-entry mod with `{txnLineID: rentLineId, memo: ...}` survives only the rent line, preserves account + amount from the existing line, and recomputes `AmountDue` to 100. Verified Line-mod merge check.
- [x] New line (no `txnLineID`) gets a freshly-generated `TxnLineID`; existing line passed by `TxnLineID` only is preserved untouched. Verified "new line gets fresh TxnLineID" check.
- [x] `AmountDue` recomputes via `computeTotals` after line mods. Verified across all line-mod paths (100, 175, 275, 375).
- [x] Vendor `Balance` adjusts by `newAmountDue - oldAmountDue` (signed delta). Verified `-50` (line drop), `+75` (line add), `+100` (item line add), and full reverse-then-apply on vendor change.
- [x] Mixing expense and item ledgers: `ItemLineMod` alone leaves `ExpenseLineRet` untouched; both contribute to `AmountDue`. Verified items-alongside-expenses check.
- [x] Item line `Quantity` mod re-derives `Amount = Quantity * Cost` from the merged line. Verified with `Q=10, C=20 (existing) → A=200`.

**Error criteria**:
- [x] Unknown `txnId` rejects via `isError: true` with statusCode 500. Verified via tool's try/catch wrapper around `session.modifyEntity`.
- [x] Stale `editSequence` rejects with statusCode 3170 ("EditSequence does not match"). The failed mod does NOT mutate the bill (verified by re-querying the bill's memo post-rejection).
- [x] New expense line (no `txnLineID`) without `accountName`/`accountListId` rejected by `expenseLineModSchema.refine` at the zod boundary.
- [x] New item line (no `txnLineID`) without `itemName`/`itemListId`/`quantity`/`cost` rejected by `itemLineModSchema.refine`.

**Regression criteria**:
- [x] `qb_bill_create` still works (`AmountDue = sum(lines)`, vendor balance bumps).
- [x] `qb_bill_delete` still reverses vendor balance.
- [x] `qb_bill_list` still returns persisted bills with intact `ExpenseLineRet` / `ItemLineRet` (verified throughout — every mod check re-queried the bill via `getBill` and inspected the line arrays).
- [x] `qb_customer_update` still works with a fresh `EditSequence` (verified via Acme `CompanyName` update).
- [x] `qb_invoice_update` still works (verified via INV-1001 memo header-only mod). The strict `EditSequence` check accepts a freshly-queried sequence as expected.
- [x] Seed `INV-1002` untouched (no test path modified it).
- [x] AP aging would reflect the post-mod vendor balance — `qb_ap_aging` reads `Vendor.Balance` directly per Item 18, and the balance moves are verified end-to-end.

**Documentation criteria**:
- [x] README bill table: `qb_bill_update` row inserted between create and delete; bill section intro paragraph documents `txnLineID` semantics and the `editSequence` → 3170 rejection.
- [x] `instructions` block in [src/index.ts](src/index.ts) updated: bill bullet now lists update and explains that line arrays REPLACE the line set wholesale with merge-by-`txnLineID`.
- [x] `DECISIONS.md` entry: "Strict EditSequence validation in simulation handleMod" — documents global `handleMod` tightening and the rationale.
- [x] `DECISIONS.md` entry: "Bill line-mod uses wholesale replacement with merge-by-TxnLineID" — documents the chosen middle ground between pure-replace and full per-line diff.
- [x] Tool count in README header bumped 36 → 37.

**Implementation notes**:
- Tool layer in [src/tools/bills.ts](src/tools/bills.ts):
  - Two new schemas: `expenseLineModSchema` and `itemLineModSchema`. Each makes nearly every field optional (so partial mods on existing lines work) and uses `.refine()` to require the create-shape fields ONLY when `txnLineID` is absent or `'-1'`.
  - `qb_bill_update` handler builds `ExpenseLineMod` / `ItemLineMod` arrays only when the corresponding tool arg is provided — so a header-only mod sends no line keys at all and `applyLineMods` short-circuits via `lineModKeys.size === 0`.
  - try/catch wraps `session.modifyEntity` so simulation 500s and 3170s surface as structured tool errors with `isError: true` + `statusCode` (same pattern as `qb_payment_receive` from Item 5).
- Simulation `handleMod` in [src/session/simulation-store.ts](src/session/simulation-store.ts):
  - Strict `EditSequence` check is global (any entity type), keyed on the request including `EditSequence`. Three lines, returns 3170 on mismatch, applied BEFORE any mutation so a mismatched mod can't leak partial state.
  - `applyLineMods(existing, modData)` is generic on `*LineMod` keys — the regex `/^(.+?)Line(s?)Mod$/` finds every line-mod key, processes the mod array against the entity's existing `*LineRet`, and produces a new `*LineRet` array. Item 6 (`qb_invoice_update` line mod) reuses this helper with no changes.
  - `omitKeys` strips the `*LineMod` keys before the spread `{...lineModResult.entityWithLines, ...stripped}` so the raw mod arrays don't end up persisted on the entity.
  - `adjustVendorBalanceForBillMod` handles both the same-vendor delta path and the vendor-change reverse-then-apply path. Vendor identity check uses `ListID` first, falls back to `FullName`. Same machinery is reusable for Phase 3 item 6 (Customer/Invoice) — consider extracting to a generic `adjustPartyBalanceForTxnMod` when item 6 lands.
- Amount re-derivation in `applyLineMods`: `Quantity * Rate` (Invoice/Estimate convention) takes precedence over `Quantity * Cost` (Bill ItemLine convention). For ExpenseLineMod (no qty/rate/cost), neither branch fires and `Amount` carries from the merge — operator's explicit `Amount` wins.
- Item 6's path is now straightforward: it'll add an `invoiceLineModSchema` to [src/tools/invoices.ts](src/tools/invoices.ts), wire `InvoiceLineMod` in the tool, extend the `entityType === "Bill"` branch in `handleMod` to also include `"Invoice"` (recompute `Subtotal` + `BalanceRemaining` + `IsPaid`), and add a customer-balance equivalent of `adjustVendorBalanceForBillMod`. The line-mod plumbing itself is already done.
- Verified end-to-end with a 17-check inline script (deleted post-verification per "no test infra yet"): bill setup with vendor balance bump, header-only mod (memo + EditSequence advance + lines/AmountDue/balance unchanged), stale-EditSequence rejection (3170 + bill not mutated), unknown-TxnID rejection (500), single-line merge by TxnLineID with line-drop balance delta (-50), new line with fresh TxnLineID + existing-line preservation by TxnLineID-only (+75 delta), parallel ItemLineMod alongside existing ExpenseLineRet (+100), item-qty mod with merged-Cost re-derivation (10 * 20 = 200), vendor-change reverse-then-apply (office −375, cloud +375), `qb_customer_update` regression with fresh editSequence, `qb_invoice_update` regression on INV-1001, `qb_bill_create` Item 4 regression, `qb_bill_delete` Item 18 regression. `npm run build` green throughout.

---

### Item 5 — Payment applied to invoices _(Phase 3)_ — done 2026-04-25

**Status:** done

**Behavioral criteria**:
- [x] `qb_payment_receive` accepts `appliedTo: [{txnId, amount, discountAmount?, discountAccountName?}]` array. Verified C1, F1, G1.
- [x] Each applied invoice's `BalanceRemaining` decreases by the applied amount. Verified C5 (7500→4500), D3 (4500→0), E3 (1000→0), F5/F6, G2.
- [x] When `BalanceRemaining` reaches 0, the invoice's `IsPaid` flips to true. Verified D4, E4, F5/F6, G3. Partial closeout leaves `IsPaid=false` (C7).
- [x] Customer `Balance` decreases by the total applied amount (not the gross payment). Verified C8 (-3000), E5 (only -1000 of $1500 gross), F7 (-500), G5 (-950 of $950 + $50 discount).
- [x] Unapplied amount (`TotalAmount > sum(appliedTo.amount)`) remains as customer credit and is returned as `UnusedPayment` on the payment payload. Verified B3 (500), E2 (500), F4/G6 (0).
- [x] Calling `qb_payment_receive` without `appliedTo` records the payment as fully unapplied. Verified B1–B5: AppliedAmount=0, UnusedPayment=totalAmount, no AppliedToTxnRet, no customer balance change.

**Regression criteria**:
- [x] `qb_payment_list` shows the new payment with `AppliedAmount` and `AppliedToTxnRet` intact across query round-trip. Verified K1–K3.
- [x] `qb_invoice_list` reflects updated `BalanceRemaining` and `IsPaid` on the affected invoices (verified throughout C/D/E/F/G via direct query lookups by RefNumber).
- [x] AR aging still runs after payment activity (L1). Report reads `Customer.Balance` directly per Item 18, so the moved balance flows through automatically.

**Edge / error criteria** (added during implementation):
- [x] Strict TxnID validation: an unknown `txnId` returns `isError: true` with statusCode 500 and the bad TxnID in the error message; no invoice is mutated. Verified H1–H3. See DECISIONS.md 2026-04-25 entry.
- [x] Overapplication (sum(appliedTo.amount) > totalAmount) rejected at the tool-layer schema-after-coercion check. Verified I1–I2. Floating-point tolerance: `+1e-9`.
- [x] Pre-existing customer-required validation still works (J1).
- [x] Discount handling: `discountAmount` closes invoice alongside `amount` but is NOT counted toward `AppliedAmount` on the invoice and does NOT reduce the customer balance — matches real QB semantics. Verified G2/G4/G5/G6 with `DiscountAccountRef` on the response payload.

**Documentation criteria**:
- [x] README payment section updated: intro paragraph describes `appliedTo` semantics + strict TxnID rule + UnusedPayment formula; tool table row mentions `appliedTo`.
- [x] `instructions` block in [src/index.ts](src/index.ts) updated: `qb_payment_*` line flags `appliedTo` and the prepayment-without-appliedTo path.
- [x] `DECISIONS.md` 2026-04-25 entry added: "Strict TxnID validation in `qb_payment_receive` AppliedToTxnAdd."

**Implementation notes**:
- Tool-layer schema in [src/tools/payments.ts:7-14](src/tools/payments.ts#L7-L14): `appliedToSchema` requires `txnId` + `amount`; `discountAmount` and `discountAccountName` are optional. Per-line refinement intentionally NOT used — `txnId` and `amount` are required directly via `z.string()` / `z.number()`, so the schema rejects missing fields without a `.refine()` predicate.
- Tool-layer overapplication check at [src/tools/payments.ts:50-63](src/tools/payments.ts#L50-L63): runs before the request is built, returns `isError: true` with the computed sum and the totalAmount. Floating-point slack: `+1e-9`. Rejects at the tool layer rather than the simulation so live mode also gets the friendly error message instead of a cryptic QB rejection.
- Tool-layer try/catch at [src/tools/payments.ts:96-106](src/tools/payments.ts#L96-L106) wraps `session.addEntity` so a 500 from the simulation (orphan TxnID) surfaces as a structured tool error instead of a raw exception. Pattern is candidate for replication on other tools when Phase 6 item 25 lands.
- Side-effect logic centralized in `applyReceivePayment` at [src/session/simulation-store.ts:332-432](src/session/simulation-store.ts#L332-L432). Two-pass design: pass 1 validates every TxnID (atomicity — orphan in line 5 of 5 must NOT leave lines 1-4 mutated); pass 2 applies invoice mutations and customer-balance delta. Phase 3 item 8 (`qb_payment_apply` via `ReceivePaymentMod`) will reuse this exact helper from `handleMod` — currently inline because there's only one call site.
- `AppliedToTxnRet` carries `TxnLineID` (from `nextId()`), `TxnID`, `PaymentAmount`, and conditionally `DiscountAmount` + `DiscountAccountRef`. Added to parser's `arrayElements` set at [src/qbxml/parser.ts:46](src/qbxml/parser.ts#L46) so live mode parses single-applied-invoice responses as a 1-element array, matching multi-application shape.
- Customer balance moves via the existing `adjustEntityBalance` helper from Item 18 with a negative delta, exactly as the previous handoff predicted. Skipped when `appliedSum === 0` so prepayments don't accidentally bump customer balance.
- Order in `handleAdd`: `applyReceivePayment` runs AFTER `convertLinesAddToRet` + `computeTotals` (both are no-ops for ReceivePayment) and BEFORE `store.set`, so an orphan-TxnID rejection short-circuits without leaving a phantom payment in the store.
- Verified end-to-end with a 51-check inline script (deleted post-verification per "no test infra yet"): seed sanity, prepayment without appliedTo, single-invoice partial application, full closeout with `IsPaid` flip, unapplied-portion-as-credit (1500 paid / 1000 applied / 500 unused), multi-invoice application, discount handling with proper customer-balance and AppliedAmount semantics, strict TxnID validation, overapplication rejection, missing-customer regression, persistence via `qb_payment_list`, and AR aging smoke. `npm run build` green.

### Item 4 — Bill expense + item lines _(Phase 3)_ — done 2026-04-25

**Status:** done

**Behavioral criteria**:
- [x] `qb_bill_create` accepts `expenseLines: [{accountName | accountListId, amount, memo?, className?}]` array.
- [x] `qb_bill_create` accepts `itemLines: [{itemName | itemListId, quantity, cost, memo?}]` array.
- [x] At least one of `expenseLines` or `itemLines` is required — header-only bills (and empty arrays for both) are rejected with `isError: true` and a message that names both arg keys.
- [x] Created bill's `AmountDue` equals sum of all expense + item line amounts. Verified C5 (350), D5 (262.5), E3 (80) — all line-derived.
- [x] Vendor `Balance` increases accordingly. Verified H1 — `Office Supplies Co` balance moved from 2500 → 2500 + 717.5 (sum of four bills) via Item 18's `adjustPartyBalanceForTxn` integration.
- [x] AP aging reflects the new bill. Verified I2 — `qb_ap_aging` output mentions `Office Supplies` after activity.

**Regression criteria**:
- [x] Existing transaction tools still work: `qb_invoice_list { refNumber: "INV-1001" }` returns the seed invoice with `BalanceRemaining = 7500` (verified K1, K2).
- [x] Existing vendor-required validation still works: `qb_bill_create` without `vendorName`/`vendorListId` returns `isError: true` (verified B1).
- [x] Bills persist with their lines: subsequent `qb_bill_list` retrieval of `BILL-EXP-1` returns `AmountDue = 350` and the 2-element `ExpenseLineRet` array intact (verified J3, J4).

**Documentation criteria**:
- [x] README bill table updated: `qb_bill_create` row now describes `expenseLines` / `itemLines` schemas and the `quantity * cost` math; intro paragraph notes that lines are required.
- [x] `instructions` block in [src/index.ts](src/index.ts) updated: `qb_bill_*` line now flags that `qb_bill_create` requires line items and that `AmountDue` is derived from lines.
- [x] `DECISIONS.md` 2026-04-25 entry added at top: "Drop `amountDue` arg from `qb_bill_create`" — records the schema break and reasoning.

**Implementation notes**:
- Two zod refinements live alongside the schema definitions in [src/tools/bills.ts](src/tools/bills.ts) so per-line `AccountRef` / `ItemRef` validation fires at the schema boundary, not in the handler. F1 + F2 verify both refinements reject lines that omit the relevant ref.
- Per-line `Amount = quantity * cost` is computed in the tool handler before `session.addEntity("Bill", data)`. The simulation's line-converter at [src/session/simulation-store.ts:349-368](src/session/simulation-store.ts#L349-L368) only computes `Quantity * Rate` (Bill item lines use `Cost`, not `Rate`), so doing the math in the tool layer is the right boundary — it keeps the converter honest about what real QB derives server-side and what it doesn't.
- The previously-optional `amountDue` arg was removed entirely. `computeTotals` in the simulation is now the single source of truth for the bill total. Logged in `DECISIONS.md` because zod's default `unknownKeys: "strip"` means a caller passing `amountDue` will silently lose it rather than getting a clear rejection — future agents should not "fix" that by re-adding the arg without rereading the decision entry.
- `ClassRef` on expense lines (`className` arg → `ClassRef.FullName`) supported for class tracking, matching the acceptance note. Item lines deliberately do NOT take `className` — the acceptance criterion only specified it on expense lines, and Phase 4 item 30 will land a proper `qb_class_list` tool that makes this discoverable across both line types.
- Verified end-to-end with a 35-check inline script (deleted post-verification per "no test infra yet"): header-only rejection (incl. empty-arrays variant), expense-only with `Memo` preservation, item-only with the `qty * cost` math (12.5 → 62.5 line, 100 → 200 line), mixed bills, per-line ref validation, `accountListId` variant, vendor balance integration with Item 18, AP aging integration, persistence via `qb_bill_list`, invoice regression, and `ClassRef` on expense lines. `npm run build` green.

---

### Item 2 — Per-subtype Item request types _(Phase 2)_ — done 2026-04-25

**Status:** done

**Behavioral criteria**:
- [x] `qb_item_list` accepts an optional `itemType` arg. When provided, only that subtype is queried.
- [x] When `itemType` is omitted, the tool fans out across all five subtypes and merges results via `Promise.all` + `flat()`.
- [x] `qb_item_add` routes to the correct `Item<Subtype>AddRq` based on the required `itemType` arg — verified each subtype lands in its own store and does not leak into others.
- [x] `qb_item_update` routes to the correct `Item<Subtype>ModRq` (added required `itemType` arg per the implementation note in `HANDOFF.md`).
- [x] Subtype-specific fields are accepted: Inventory accepts `assetAccountName` / `cogsAccountName` / `cost`; Service items take the same schema but routing makes the inapplicable fields a no-op at the simulation level. Light-touch single-schema chosen — see `DECISIONS.md` 2026-04-25 entry.

**Regression criteria**:
- [x] All seed items still appear when `qb_item_list` is called with no `itemType` (fan-out merges to 3).
- [x] Invoice creation referencing `"Consulting Services"` by `ItemRef.FullName` still resolves and computes Subtotal correctly.

**Documentation criteria**:
- [x] README item table updated with the `itemType` arg behavior per tool.
- [x] `ARCHITECTURE.md` Invariant #7 updated — dropped the "currently violates" clause and described the new tool-layer routing.
- [x] `src/index.ts` `instructions` block updated with the subtype enum + when `itemType` is required.
- [x] `DECISIONS.md` entry added for the light-touch schema choice (single zod schema across subtypes, route on `itemType`).

**Implementation notes**:
- `ITEM_SUBTYPES` constant defined locally in [src/tools/items.ts:11-17](src/tools/items.ts#L11-L17) — kept independent of the simulation store's internals per the layer-hygiene note in the prior handoff. The simulation-store's `ITEM_SUBTYPES` constant has been deleted as part of this task because the only thing that read it (the generic `ItemQueryRq` shim) has also been deleted.
- `qb_item_list` fan-out uses `Promise.all` so the five subtype queries run in parallel rather than serially.
- All four tools share a single `itemTypeSchema = z.enum([...])` so the operator-facing values stay identical across `add` / `update` / `delete` / `list`.
- Verified end-to-end with a 29-check inline script (deleted post-verification per "no test infra yet" project state): per-subtype query routing (3 occupied + 2 empty subtypes), fan-out merge total = 3, fan-out filter passthrough (`NameFilter='Widget'` → 1), per-subtype add (Service / Inventory / OtherCharge each land in correct store, no cross-store leakage), Inventory subtype-specific fields preserved (`Cost` / `COGSAccountRef` / `AssetAccountRef`), per-subtype mod with `TimeModified` bump, per-subtype delete returns correct `ListDelType`, wrong-subtype delete fails with 500 (proves real subtype isolation), shim removal proven (generic `Item` query returns 0), and full regression spot-checks for Customer/Account/Invoice + invoice line referencing item by FullName.

---

### Item 3 — Item delete uses correct subtype _(Phase 2)_ — done 2026-04-25

**Status:** done

**Behavioral criteria**:
- [x] `qb_item_delete` requires `itemType` and sends `ListDelType: "Item<Subtype>"` (e.g. `"ItemService"`) instead of `"Item"`. Verified by inspecting the response payload's `ListDelType` field on each subtype.
- [x] Deletion succeeds for each subtype. Verified Service / Inventory / OtherCharge directly; NonInventory and Group share the exact same code path and routing.

**Regression criteria**:
- [x] `qb_customer_delete` still returns `ListDelType: "Customer"` (verified — shared `ListDelRq` machinery is unaffected).
- [x] `qb_account_delete` still returns `ListDelType: "Account"` (verified).
- [x] Wrong-subtype delete (e.g. deleting Service ListID via the `ItemInventory` route) fails cleanly with statusCode 500 "object not found" — proves the per-subtype store isolation is real, not just cosmetic.

**Implementation notes**:
- Implemented in the same edit as Item 2 in [src/tools/items.ts:140-156](src/tools/items.ts#L140-L156). The handoff recommendation to bundle Items 2 + 3 was correct: they share the same tool file, the same routing pattern, and the same verification surface.
- The simulation's `handleListDel` already reads `ListDelType` from the request directly, so per-subtype types hit per-subtype stores with no further simulation changes needed.

---

### Item 22 — Split Item store by subtype _(Phase 1)_ — done 2026-04-25

**Status:** done

**Behavioral criteria**:
- [x] Simulation store has separate maps for `ItemService`, `ItemInventory`, `ItemNonInventory`, `ItemOtherCharge`, `ItemGroup`. Created lazily by the existing `getStore` helper — no schema change needed beyond routing.
- [x] A query for `ItemServiceQueryRq` returns only service items, wrapped in `ItemServiceRet`. Verified the wrapping element directly via raw response inspection.
- [x] Same for each subtype: `ItemInventoryQueryRq` → `ItemInventoryRet`, `ItemNonInventoryQueryRq` → `ItemNonInventoryRet`. Empty subtypes (`ItemOtherCharge`, `ItemGroup`) return `statusCode 1` ("not found") and produce no `*Ret` key.
- [x] Seed data migrated: each of the 3 seed items is placed into `Item${i.ItemType}` at seed time. The legacy `Item` store is no longer seeded.

**Regression criteria**:
- [x] `qb_item_list` (which still uses generic `ItemQueryRq`) returns all 3 seed items via the transitional shim in `handleQuery`. Verified via `mgr.queryEntity("Item", {})` returning 3.
- [x] All existing query filters apply through the shim: `NameFilter` (Widget → 1), `ActiveStatus=ActiveOnly` (3), `MaxReturned` (cap), `FullName` (exact match).
- [x] Non-Item entity queries unaffected: Customer (Acme.Balance=15000), Account (10 chart entries), Invoice (INV-1001 BalanceRemaining=7500).

**Documentation criteria**:
- [x] No README change required — `qb_item_list` surface is unchanged from the operator's perspective.
- [x] No `instructions` block change in [src/index.ts](src/index.ts) — same reason.
- [x] `ARCHITECTURE.md` Invariant #7 deliberately NOT marked resolved — the violation is in the tool layer (generic `ItemQueryRq`), and Phase 2 item 2 is what flips it. Item 22 is the simulation-side prerequisite only.
- [x] No `DECISIONS.md` entry — Option A (shim in simulation store, isolated to one branch in `handleQuery`) was the recommended path in the prior handoff and introduces no surprise tradeoffs. Option B (rewriting `qb_item_list` to issue 5 queries up front) was rejected because it bleeds Phase 2 item 2's tool-side work into a Phase 1 simulation task.

**Implementation notes**:
- New private constant `ITEM_SUBTYPES` at [src/session/simulation-store.ts:43-55](src/session/simulation-store.ts#L43-L55) — single source of truth for the 5 subtype names. Used by the query shim and (implicitly) by seed routing through string concatenation.
- `handleQuery` shim at [src/session/simulation-store.ts:114-127](src/session/simulation-store.ts#L114-L127): when `entityType === "Item"`, results are merged across all 5 subtype stores via `flatMap`. All downstream filters (`ListID`, `FullName`, `EntityFilter`, `TxnDateRangeFilter`, `ModifiedDateRangeFilter`, `PaidStatus`, `RefNumber`, `NameFilter`, `ActiveStatus`, `MaxReturned`) apply uniformly because they operate on the merged array — no per-store filter dispatch needed. Results return wrapped in `ItemRet` (the legacy element name the existing tool expects), NOT in any `Item${Subtype}Ret`.
- Seed migration at [src/session/simulation-store.ts:786-792](src/session/simulation-store.ts#L786-L792): each seed item is routed via `this.getStore(\`Item${i.ItemType}\`)` based on its `ItemType` discriminator. The discriminator values (`Service` / `Inventory` / `NonInventory` / `OtherCharge` / `Group`) map 1:1 to the subtype suffixes, so string concatenation suffices — no lookup table needed.
- `isTransactionType` deliberately not extended — items are list entities and must not enter the transaction array.
- `handleAdd` / `handleMod` / `handleListDel` deliberately NOT changed for Item subtypes. The existing dispatch (regex-derived `entityType` from request key) already routes per-subtype requests to their per-subtype stores. The catch is that the legacy `qb_item_add` / `qb_item_update` / `qb_item_delete` tools still build generic `ItemAddRq` / `ItemModRq` / `ListDelType: "Item"` requests — those land in the now-empty `Item` store and are functionally broken until Phase 2 items 2 + 3. This is anticipated; Item 22's acceptance criterion explicitly does NOT require the write-side tools to keep working.
- Verified end-to-end with a 16-check inline script (deleted post-verification per "no test infra yet"): per-subtype query shape (Service/Inventory/NonInventory each return the right `*Ret` array with the right ItemType), empty-subtype behavior (statusCode 1, no leaked `*Ret` key), subtype isolation (ItemService doesn't leak Inventory items), generic shim merge total = 3 (proves no double-count from a stale `Item` store), all four filters through the shim, and regression spot-checks for Customer/Account/Invoice.

---

### Item 18 — Update entity balances on transaction activity _(Phase 1)_ — done 2026-04-25

**Status:** done

**Behavioral criteria**:
- [x] Adding an invoice for `Acme Corporation` increases that customer's `Balance` by the invoice `BalanceRemaining`.
- [x] Adding a bill for a vendor increases that vendor's `Balance` by `AmountDue`.
- [ ] Recording a payment applied to an invoice (Phase 3 item 5) decreases the customer's `Balance` and the invoice's `BalanceRemaining` by the applied amount. _(Out of scope for Item 18 — the helper `adjustEntityBalance` is designed so Phase 3 item 5 can call it directly with a negative delta. Verified by Phase F round-trip in this task's verification, which proves the negative-delta path works.)_
- [x] Deleting an invoice/bill reverses the balance change.
- [x] `qb_ar_aging` and `qb_ap_aging` reflect these changes immediately. _(Reports read `Customer.Balance` / `Vendor.Balance` directly per HANDOFF — no report-side change needed; verified that the source field moves on activity.)_

**Regression criteria**:
- [x] Initial seed balances remain at their seeded values until activity touches them.

**Implementation notes**:
- New helper `adjustEntityBalance(entityType, refKey, delta)` at [src/session/simulation-store.ts:417-450](src/session/simulation-store.ts#L417-L450). Looks up by `ListID` first (exact `Map.get`), falls back to a `FullName` linear scan. Orphan ref → silent no-op so creation never blocks. `TotalBalance` mirrors `Balance` only on the Customer branch (vendors have no such field per seed shape; verified A2 + C2 in the verification script). Zero-delta short-circuit + `Number.isFinite` guard so a malformed amount never poisons a balance.
- Thin adapter `adjustPartyBalanceForTxn(txn, partyType, amountField, sign)` at [src/session/simulation-store.ts:455-475](src/session/simulation-store.ts#L455-L475) pulls the ref + amount off a stored transaction and applies a signed delta. `sign: 1 | -1` lets `handleAdd` and `handleTxnDel` share one call site without duplicating ref-extraction logic. Phase 3 item 5 (payment apply) will call `adjustEntityBalance` directly with a negative delta — it does NOT need the txn-shaped adapter, since the payment carries its own structure.
- `handleAdd` call site at [src/session/simulation-store.ts:304-308](src/session/simulation-store.ts#L304-L308): only `Invoice` (Customer / `BalanceRemaining`) and `Bill` (Vendor / `AmountDue`) trigger the bump. Other transaction types (Estimate, PurchaseOrder, SalesReceipt, etc.) deliberately do NOT mutate party balances — estimates/POs aren't AR/AP, and SalesReceipt/CreditMemo etc. need explicit per-type rules that belong with their tools (Phase 4 item 12).
- `handleTxnDel` refactored at [src/session/simulation-store.ts:508-538](src/session/simulation-store.ts#L508-L538) — `store.has` → `store.get` so we can read the entity, reverse the delta via the same adapter (sign = -1), then delete. Preserves the original 500 not-found response shape.
- `handleMod` deliberately untouched. Modifying an invoice's `BalanceRemaining` only happens via payment application (Phase 3 item 5) or line modification (Phase 3 items 6/7); each of those will own its own helper call.
- Verified end-to-end with a 17-check inline script (deleted post-verification per "no test infra yet"): seed preservation (Acme + Office Supplies + vendor-has-no-TotalBalance), invoice-add bumps customer (with TotalBalance mirroring), bill-add bumps vendor (with no TotalBalance leak), FullName-only ref resolves, orphan ref doesn't block creation and doesn't create a phantom customer, invoice + bill delete each reverse the delta, full add→delete round-trip nets to zero, Estimate doesn't move customer balance, PurchaseOrder doesn't move vendor balance, Customer add (non-transaction) still works, seed INV-1001 still untouched, AR-source field moves on new activity.

---

### Item 16 — Compute totals in simulation `handleAdd` _(Phase 1)_ — done 2026-04-25

**Status:** done

**Behavioral criteria**:
- [x] Created invoices return `Subtotal = sum(InvoiceLineRet.Amount)`.
- [x] Created invoices return `BalanceRemaining = Subtotal + SalesTaxTotal - AppliedAmount`.
- [x] Created invoices return `IsPaid = (BalanceRemaining === 0)`.
- [x] Created bills return `AmountDue = sum(line amounts)` if not explicitly provided.
- [x] Created estimates return `Subtotal = sum(line amounts)`.
- [x] No-line invoices/bills/estimates return `Subtotal = 0` (not undefined). Bill no-line case returns `AmountDue = 0`.

**Regression criteria**:
- [x] Item 17 still produces correct line arrays.
- [x] Customer/vendor add still works (no-op for these — non-transactional).

**Implementation notes**:
- New helper `computeTotals(entity, entityType)` at [src/session/simulation-store.ts:367-403](src/session/simulation-store.ts#L367-L403). Runs after `convertLinesAddToRet` so every line is in `*LineRet` form before summing — see the call site at [src/session/simulation-store.ts:300-302](src/session/simulation-store.ts#L300-L302).
- `lineSum` walks every key matching `/^(.+?)Line(s?)Ret$/` and sums `Amount` across all of them. Bill is the only multi-line-key entity today (`ExpenseLineRet` + `ItemLineRet`), but the regex makes it free for any future entity that lands.
- Per-entity dispatch is explicit, not generic: only `Invoice`/`Estimate` get `Subtotal`, only `Bill` gets `AmountDue`, only `Invoice` gets `BalanceRemaining`/`IsPaid`. Other transaction types (SalesReceipt, CreditMemo, PurchaseOrder, etc.) are intentionally NOT touched — they have no tools yet and the right field names per type need verification when those tools land in Phase 4 item 12.
- Bill `AmountDue` honors an explicit value from the caller (`if (... && result.AmountDue === undefined)`). Invoice/Estimate `Subtotal` always overwrites — real QB doesn't let you override the line-derived subtotal, and an explicit subtotal contradicting the lines would be a bug worth surfacing, not silently honoring.
- `SalesTaxTotal` and `AppliedAmount` default to `0` when absent and are normalized via `Number(... ?? 0)` so the response always has numeric fields (criterion: "not undefined"). `Number.isNaN` guard on per-line sum so a malformed `Amount` doesn't poison the total — silently skipped instead.
- `IsPaid = (BalanceRemaining === 0)` — strict equality on numbers. Floating-point drift (e.g. `0.1 + 0.2 - 0.3 !== 0`) is a known risk if a future test uses non-trivial fractions; not a problem for the current Phase 1 acceptance values.
- `handleMod` deliberately untouched (per HANDOFF directive — line-mod recomputation belongs to Phase 3 items 6 and 7). Seed invoices have hardcoded totals from `seedData()` and remain frozen because `computeTotals` only fires inside `handleAdd`.
- Verified end-to-end with a 39-check inline script (deleted post-verification per "no test infra yet"): all 6 acceptance bullets, explicit-tax-and-applied invoice, fully-paid invoice (`IsPaid=true`), no-line cases for all three entities, Bill with parallel expense+item lines, Bill with explicit `AmountDue` preserved, Estimate doesn't get invoice-only fields, persistence via list, Customer/Vendor non-transaction (no totals attempted), seed `INV-1001` untouched, and Item 15 `PaidStatus` filter regression on the now-computed `IsPaid`.

---

### Item 17 — Convert `*LineAdd` to `*LineRet` in simulation responses _(Phase 1)_ — done 2026-04-25

**Status:** done

**Behavioral criteria**:
- [x] Creating an invoice with 2 lines via `qb_invoice_create` returns a response containing `InvoiceLineRet` (not `InvoiceLineAdd`) with 2 entries.
- [x] Each `InvoiceLineRet` entry has a generated `TxnLineID`.
- [x] Each line has `Amount` computed as `Quantity * Rate` if both supplied; otherwise echoes the explicit `Amount` if provided; otherwise `0`.
- [x] Subsequent `qb_invoice_list` retrieval of the same invoice returns the same `InvoiceLineRet` array (persistence verification).
- [x] Same conversion happens for `EstimateLineRet`, Bill `ExpenseLineRet` + `ItemLineRet`, and any other `*LineAdd` → `*LineRet` pair.

**Regression criteria**:
- [x] Existing seed invoices (which have no lines) still list correctly.
- [x] Item 15's filters still work after this change.

**Documentation criteria**:
- [x] None required — internal correctness change.

**Implementation notes**:
- Generic helper `convertLinesAddToRet` at [src/session/simulation-store.ts:312-359](src/session/simulation-store.ts#L312-L359) scans the entity for keys matching `/^(.+?)Line(s?)Add$/` and rewrites each into a `*LineRet` array. Only invoked for transaction entities (the `isTransactionType` gate in `handleAdd`) — list entities never carry line arrays.
- Single-line input (parsed by fast-xml-parser as an object, not array) is normalized to a 1-element array before mapping, so the response always has a homogeneous `*LineRet` shape regardless of input cardinality.
- `Amount` rule per acceptance: `Quantity * Rate` if both present → fallback to explicit `Amount` → fallback to `0`. Bill `ItemLineAdd` uses `Cost`, not `Rate`, so `Quantity * Cost` is NOT auto-computed — explicit `Amount` is required for those lines (matches real QB behavior).
- Adopted real QBXML element names (`ExpenseLineRet`, `ItemLineRet`, no Bill prefix) over the handoff's draft `BillExpenseLineRet` / `BillItemLineRet` because live mode will return the standard names — staying consistent across modes.
- Parser `arrayElements` extended at [src/qbxml/parser.ts:39-55](src/qbxml/parser.ts#L39-L55) with `ExpenseLineRet`, `ItemLineRet`, `SalesReceiptLineRet`, `CreditMemoLineRet`, `PurchaseOrderLineRet`, `SalesOrderLineRet`, `DepositLineRet` — single-line responses now parse as 1-element arrays for live mode.
- `TxnLineID` reuses `nextId()` (counter + base36 timestamp). Real QB uses a different ID format but downstream code only cares about presence + uniqueness.
- Verified end-to-end with a 30-check inline script (deleted post-verification per "no test infra yet"): 2-line invoice, persistence via list, single-line normalization, all three Amount fallback paths, no-line invoice (no `*LineRet` key produced — preserves seed invoice shape), Bill with parallel `ExpenseLineAdd` + `ItemLineAdd`, Estimate, Customer non-transaction (no conversion attempted), and Item 15 filter regression.

---

### Item 15 — Transaction filters in simulation store _(Phase 1)_ — done 2026-04-25

**Status:** done

**Behavioral criteria**:
- [x] `qb_invoice_list` with `customerName: "Acme Corporation"` returns only invoices where `CustomerRef.FullName === "Acme Corporation"`.
- [x] `qb_invoice_list` with `customerListId: "80000001-1234567890"` returns only invoices for that customer.
- [x] `qb_invoice_list` with `fromDate: "2024-11-01"`, `toDate: "2024-11-10"` returns only invoices with `TxnDate` lexicographically between (inclusive).
- [x] `qb_invoice_list` with `fromDate` only (no `toDate`) returns invoices on or after `fromDate`. Same for `toDate` only.
- [x] `qb_invoice_list` with `paidStatus: "PaidOnly"` returns only invoices where `IsPaid === true`. With `"NotPaidOnly"`, only `IsPaid !== true`. With `"All"` (or unset), no filter.
- [x] `qb_invoice_list` with `refNumber: "INV-1001"` returns only the invoice with that exact `RefNumber`.
- [x] `qb_bill_list` vendor variant of EntityFilter verified (matches via `VendorRef`).
- [x] Combining filters narrows results (AND semantics).
- [x] Empty result set returns 0 results (handled by existing zero-result branch returning statusCode 1).

**Regression criteria**:
- [x] `qb_customer_list` with existing filters (`nameFilter`, `activeOnly`, `maxReturned`, `listId`) still works unchanged.
- [x] `qb_invoice_list` with `txnId` (existing filter) still returns the single matching invoice.
- [x] Seed data still loads — 2 invoices appear on a no-filter `qb_invoice_list` call.
- [x] No regression in non-transaction list tools — verified via `Customer.NameFilter` / `Customer.ActiveStatus` / `Account.MaxReturned` checks.

**Documentation criteria**:
- [x] No README change required.
- [x] No architecture change.
- [x] No `DECISIONS.md` entry — implementation followed advertised filter shapes; no surprises.

**Implementation notes**:
- All filter handlers added to [src/session/simulation-store.ts](src/session/simulation-store.ts#L139-L227) immediately after the existing `FullName` filter and before `NameFilter` (so transaction-only filters are grouped together, list-only filters stay where they were).
- `EntityFilter` matches `CustomerRef.ListID/FullName` or `VendorRef.ListID/FullName` — entities only carry one ref, so a single check covers both invoice and bill cases without needing entity-type dispatch.
- All date comparisons are lexicographic on ISO strings, including `ModifiedDateRangeFilter` against full ISO `TimeModified`. If a future caller passes a `YYYY-MM-DD` string for `ToModifiedDate`, same-day modifications could be excluded — flag for future work if it bites.
- `PaidStatus`: relies on the stored `IsPaid` boolean. Item 16 will compute `IsPaid` from `BalanceRemaining === 0` — at that point the filter still works, so no follow-up needed here.
- `RefNumber`: exact match only. `RefNumberFilter` (partial / case-sensitive) deferred — record decision if/when added.
- Verified end-to-end with a 28-check standalone script that round-tripped through `buildQueryRequest` → `SimulationStore.processRequest` → `extractResponseData` (script deleted post-verification per "no test infra yet" project state).

---
