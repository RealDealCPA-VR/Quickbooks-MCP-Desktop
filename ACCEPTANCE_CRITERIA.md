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

_(Items 6, 7, 8, 9 — criteria pending pickup.)_

---

_(Add criteria for items 6, 7, 8, 9, etc. as they are picked up. Don't pre-write criteria for distant tasks — they tend to drift before implementation, and writing them up-front wastes effort if priorities shift.)_

---

## Completed

_(Move entries here when criteria are satisfied. Keep the criteria list intact — it's the historical record of what "done" meant for that task.)_

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
