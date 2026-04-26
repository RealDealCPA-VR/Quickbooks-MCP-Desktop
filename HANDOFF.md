# Handoff State

_Last updated: 2026-04-25_

## Last Session Summary

- Completed **Phase 1, Item 18** — `SimulationStore` now mutates `Customer.Balance` / `Vendor.Balance` (with `Customer.TotalBalance` mirrored) when invoices/bills are added or deleted, so AR/AP aging reports reflect activity in dev.
- New private helper `adjustEntityBalance(entityType, refKey, delta)` at [src/session/simulation-store.ts:417-450](src/session/simulation-store.ts#L417-L450) does the cross-store lookup-and-mutate. ListID first, FullName fallback, orphan ref → silent no-op (so creation never blocks). Customer-only `TotalBalance` mirroring matches the seed shape (vendors deliberately do NOT get a `TotalBalance` field). Designed for Phase 3 item 5 (payment apply) to call directly with a negative delta.
- Thin adapter `adjustPartyBalanceForTxn(txn, partyType, amountField, sign)` at [src/session/simulation-store.ts:455-475](src/session/simulation-store.ts#L455-L475) wraps the helper for the txn-shaped call sites. `sign: 1 | -1` lets `handleAdd` and `handleTxnDel` share one call site.
- `handleAdd` call site at [src/session/simulation-store.ts:304-308](src/session/simulation-store.ts#L304-L308) — Invoice (Customer / `BalanceRemaining`) and Bill (Vendor / `AmountDue`) only. Other transaction types (Estimate, PurchaseOrder, etc.) deliberately do NOT mutate party balances.
- `handleTxnDel` refactored at [src/session/simulation-store.ts:508-538](src/session/simulation-store.ts#L508-L538): `store.has` → `store.get` so the entity can be read first, balance reversed via the same adapter (sign = -1), then deleted. Original 500 not-found response shape preserved.
- Verified with a 17-check inline script (deleted post-verification per "no test infra yet"): seed preservation (Acme, Office Supplies, vendor-no-TotalBalance), invoice add bumps customer with TotalBalance mirror, bill add bumps vendor with no TotalBalance leak, FullName-only ref resolves, orphan ref doesn't block creation and doesn't create a phantom customer, invoice + bill delete each reverse the delta, full add→delete round-trip nets to zero, Estimate doesn't move customer Balance, PurchaseOrder doesn't move vendor Balance, Customer add (non-transaction) still works, seed `INV-1001` Subtotal/BalanceRemaining still untouched, AR-source field moves on new activity. All 17 pass; build green.
- `handleMod` deliberately untouched. Modifying an invoice's `BalanceRemaining` only happens via payment application (Phase 3 item 5) or line modification (Phase 3 items 6/7); each will own its own helper call.

## Verify Before Continuing

- [ ] **Build.** `npm run build` exits with code 0.
- [ ] **Item 18 invoice path.** Through any MCP client: query Acme (`qb_customer_list { nameFilter: "Acme" }`) → note `Balance`. Then `qb_invoice_create { customerName: "Acme Corporation", lines: [{ itemName: "Consulting Services", quantity: 4, rate: 150 }] }` returns `BalanceRemaining: 600`. Re-query Acme → `Balance` increased by 600 and `TotalBalance === Balance`.
- [ ] **Item 18 bill path.** `qb_bill_create` for `Office Supplies Co` (note vendor `Balance` first), expect vendor `Balance` to increase by the bill's `AmountDue` after creation. Vendor must NOT acquire a `TotalBalance` field.
- [ ] **Item 18 delete reversal.** `qb_invoice_delete { txnId: <id from above> }`, then re-query Acme: `Balance` returns to its pre-invoice value.
- [ ] **Seed protection.** Customer `Balance` for Acme starts at 15000 on a fresh process — verify by querying with no prior writes. `qb_invoice_list { refNumber: "INV-1001" }` still returns the seed with `Subtotal: 7500, BalanceRemaining: 7500`.

## Next Task

**Phase 1, Item 22** in [todo.md:15](todo.md#L15):

> Multi-store Item simulation: split the single `Item` store into `ItemService` / `ItemInventory` / `ItemNonInventory` / `ItemOtherCharge` / `ItemGroup` stores keyed by `ItemType`, return correct `*Ret` element name (`ItemServiceRet` etc.) so parser's `arrayElements` set actually matches.

Acceptance criteria pre-written at [ACCEPTANCE_CRITERIA.md § Item 22](ACCEPTANCE_CRITERIA.md). After this: Phase 2 begins (items 2 + 3, the per-subtype request-type fixes — handoff note says consider doing 22 + 2 + 3 in one session because they're tightly coupled).

## Context Notes

- **Item 22 is structural.** Today every Item (Service, Inventory, NonInventory, OtherCharge, Group) lives in a single `Item` store at [src/session/simulation-store.ts:563](src/session/simulation-store.ts#L563) and gets queried via a generic `ItemQueryRq` (which real QB does not accept — that's Phase 2 item 2's problem). The split is the prerequisite that lets per-subtype request types route correctly.
- **Where to split.** The `getStore` helper at [src/session/simulation-store.ts:534-539](src/session/simulation-store.ts#L534-L539) takes an `entityType` string and returns/creates a `Map`. New entity-type strings to support: `ItemService`, `ItemInventory`, `ItemNonInventory`, `ItemOtherCharge`, `ItemGroup`. Real QB request types map 1:1: `ItemServiceQueryRq` → entity `ItemService`, `ItemServiceAddRq` → entity `ItemService`, etc. The existing `handleQuery` / `handleAdd` / `handleMod` regex-derive entityType from the request key, so they should "just work" once the seed data is split and `getStore` returns the right map.
- **Seed migration.** The 3 seed items at [src/session/simulation-store.ts:689-693](src/session/simulation-store.ts#L689-L693) carry `ItemType: "Service"|"NonInventory"|"Inventory"`. Place each into the `Item<ItemType>` store at seed time. Drop the generic `items` store entirely (no shim — the single-store path won't be referenced anywhere after this change because the regression criterion below covers it).
- **Regression: `qb_item_list` (generic `ItemQueryRq`).** This currently calls `session.queryEntity("Item", ...)`. After Item 22, the `Item` store is empty (or doesn't exist), so the call would return zero results. Acceptance criterion calls for "a transitional shim" — simplest options:
  - **Option A (recommended):** in the simulation store, special-case the request key `ItemQueryRq` to merge results from all 5 subtype stores. The tool keeps working unchanged until Phase 2 item 2 lands and rewrites it.
  - **Option B:** rewrite `qb_item_list` now to issue 5 separate queries (one per subtype) and merge — but that bleeds Phase 2 item 2's work into Item 22.
  Option A is less code, scoped strictly to the simulation, and removable in one delete when item 2 lands. Go with A unless a wrinkle appears.
- **`isTransactionType` is unaffected.** Items are list entities — they should NOT appear in the transaction array at [src/session/simulation-store.ts:545-552](src/session/simulation-store.ts#L545-L552). Don't add `ItemService` etc. there.
- **Add handler ID prefix.** Currently all add'd items get an ID via `nextId()` — fine. No need to differentiate by subtype.
- **Don't touch [src/qbxml/parser.ts](src/qbxml/parser.ts) for Item 22.** The parser already declares `ItemServiceRet`, `ItemInventoryRet`, `ItemNonInventoryRet`, `ItemOtherChargeRet`, `ItemGroupRet` in `arrayElements` ([src/qbxml/parser.ts:32-36](src/qbxml/parser.ts#L32-L36)) — the array side is already wired for the per-subtype response shape. Phase 2 item 2 is what flips the request side.
- **Don't touch [src/qbxml/builder.ts](src/qbxml/builder.ts) either.** Builder is generic over entity type — once the simulation store accepts `Item<Subtype>QueryRq`, the existing `buildQueryRequest("ItemService", ...)` call will already produce the right XML. Phase 2 item 2 is where the items tool starts calling that.
- **Verification sequence after Item 22:**
  1. Generic `qb_item_list` (no `itemType` arg) still returns all 3 seed items (via the Option A shim).
  2. `getStore("ItemService")` contains "Consulting Services"; `getStore("ItemInventory")` contains "Widget A"; `getStore("ItemNonInventory")` contains "Software License"; the other two stores are empty.
  3. Adding an item via the existing `qb_item_add` path — that tool today builds `ItemAddRq` (not subtype-specific), so post-Item-22 it'll fail or land in nowhere. **Acceptance criterion for Item 22 doesn't require `qb_item_add` to keep working** — that's Phase 2 item 2. Document this as a known partial in the handoff if you stop at Item 22 alone.
- **Project conventions reminder** ([CLAUDE.md](CLAUDE.md) § Stable Code Conventions): TS strict, ESM with `.js` extensions on relative imports, no comments explaining WHAT, helpers private to `SimulationStore`, generic `ItemQueryRq` shim isolated to `processRequest`/`handleQuery`.

## Post-Task Chores

When Item 22 is done: `npm run build` green, [REGRESSION_CHECKLIST.md](REGRESSION_CHECKLIST.md) walked (especially §5 Simulation Store CRUD-per-entity check, since the Item entity is now 5 entities), Item 22 marked `[x]` in `todo.md`, acceptance entry moved to Completed, fresh `HANDOFF.md` pointing to Phase 2 (item 2 — the matching tool-side fix; item 3 — delete with correct `ListDelType`).
