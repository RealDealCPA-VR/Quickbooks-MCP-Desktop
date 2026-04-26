# Handoff State

_Last updated: 2026-04-25_

## Last Session Summary

- Completed **Phase 1, Item 22** — `SimulationStore` now keeps a separate `Map` per item subtype (`ItemService` / `ItemInventory` / `ItemNonInventory` / `ItemOtherCharge` / `ItemGroup`) instead of a single `Item` store. Each per-subtype `*QueryRq` returns the correct `*Ret` element name (verified by raw response inspection).
- New private constant `ITEM_SUBTYPES` at [src/session/simulation-store.ts:43-55](src/session/simulation-store.ts#L43-L55) — single source of truth for the 5 subtype names.
- Transitional shim at [src/session/simulation-store.ts:114-127](src/session/simulation-store.ts#L114-L127): when `entityType === "Item"` (the legacy generic `ItemQueryRq` request the unmodified `qb_item_list` tool still issues), the handler `flatMap`s across all 5 subtype stores and returns the merged result wrapped in `ItemRet`. All existing filters (`ListID`, `FullName`, `EntityFilter`, `*DateRangeFilter`, `PaidStatus`, `RefNumber`, `NameFilter`, `ActiveStatus`, `MaxReturned`) apply uniformly to the merged array — no per-store filter dispatch needed. Removable in one delete when Phase 2 item 2 lands.
- Seed routing at [src/session/simulation-store.ts:786-792](src/session/simulation-store.ts#L786-L792): each seed item lands in `Item${i.ItemType}` instead of a flat `items` map. The legacy `Item` store is no longer seeded (and is no longer referenced by anything except the shim's special-case branch, which doesn't read it).
- `handleAdd` / `handleMod` / `handleListDel` deliberately untouched for Item subtypes — the existing regex-derived dispatch already routes per-subtype requests correctly. The catch: legacy `qb_item_add` / `qb_item_update` / `qb_item_delete` tools still build generic `ItemAddRq` / `ItemModRq` / `ListDelType: "Item"` requests, which land in the now-empty `Item` store. **They are functionally broken until Phase 2 items 2 + 3 land.** This is the anticipated partial state — Item 22's acceptance criterion explicitly excluded the write-side from scope.
- Verified with a 16-check inline script (deleted post-verification per "no test infra yet"): per-subtype query shape, empty-subtype behavior (statusCode 1, no leaked `*Ret` key), subtype isolation (Service queries don't leak Inventory items), generic shim merge total = 3 (proves no double-count from a stale `Item` store), four filter regressions through the shim, and Customer / Account / Invoice spot-checks. All 16 pass; build green.

## Verify Before Continuing

- [ ] **Build.** `npm run build` exits with code 0.
- [ ] **Generic shim still works.** Through any MCP client: `qb_item_list {}` returns 3 items (`Consulting Services`, `Software License`, `Widget A`). `qb_item_list { nameFilter: "Widget" }` returns exactly 1.
- [ ] **Per-subtype query routes correctly.** Issue a raw `ItemServiceQueryRq` (e.g. via `session.queryEntity("ItemService", {})` or by inspecting `mgr.sendRequest(buildQueryRequest("ItemService", {}, "16.0"))`) — response data carries `ItemServiceRet: [Consulting Services]`. Same shape for `ItemInventory` (Widget A) and `ItemNonInventory` (Software License). `ItemOtherCharge` / `ItemGroup` return statusCode 1.
- [ ] **Known partials present.** `qb_item_add { name: "Test", itemType: "Service", ... }` succeeds in returning a payload but the new item does NOT appear in subsequent `qb_item_list` calls (it lands in the legacy `Item` store, which the shim doesn't read). Same for `qb_item_update` and `qb_item_delete`. **This is expected and is what Phase 2 items 2 + 3 fix.** If `qb_item_add` somehow does show up in `qb_item_list`, something extra is reading the legacy store and needs investigation.
- [ ] **Non-item regression.** `qb_customer_list { nameFilter: "Acme" }` still returns Acme with `Balance: 15000`. `qb_invoice_list { refNumber: "INV-1001" }` still returns the seed invoice with `BalanceRemaining: 7500`.

## Next Task

**Phase 2, Item 2** in [todo.md:19](todo.md#L19):

> Fix Item request types: replace generic `ItemQueryRq` / `AddRq` / `ModRq` with per-type variants (`ItemServiceQueryRq`, `ItemInventoryQueryRq`, `ItemNonInventoryQueryRq`, `ItemOtherChargeQueryRq`, `ItemGroupQueryRq`) in [src/tools/items.ts](src/tools/items.ts) and route through manager based on `itemType` arg.

Acceptance criteria pre-written at [ACCEPTANCE_CRITERIA.md § Item 2](ACCEPTANCE_CRITERIA.md). Strongly consider doing **Item 2 + Item 3 in the same session** — item 3 is the matching delete-side fix (`ListDelType: "ItemService"` etc. instead of `"Item"`), they touch the same tool file ([src/tools/items.ts](src/tools/items.ts)), and the Item 22 shim becomes deletable as soon as both land.

## Context Notes

- **What `items.ts` looks like today** ([src/tools/items.ts](src/tools/items.ts)): four tools (`qb_item_list`, `qb_item_add`, `qb_item_update`, `qb_item_delete`) all calling `session.queryEntity("Item", ...)` / `session.addEntity("Item", ...)` / `session.modifyEntity("Item", ...)` / `session.deleteEntity("Item", ...)`. The `qb_item_add` zod schema already has `itemType: z.enum(["Service", "Inventory", "NonInventory", "OtherCharge", "Group"])` — that's the discriminator you'll route on. `qb_item_list` does NOT take `itemType` today; you'll add it as optional per the acceptance criterion.
- **Routing pattern.** `session.queryEntity("ItemService", filters)` builds `ItemServiceQueryRq`, `session.addEntity("ItemService", data)` builds `ItemServiceAddRq`. The simulation already handles these correctly (Item 22 verification proved it). Live mode will too — Intuit's QBXML spec defines all 5 subtype request types.
- **`qb_item_list` rewrite.** Acceptance: optional `itemType` arg → query that single subtype. No `itemType` → fan out 5 queries and merge. The simplest implementation:
  ```ts
  if (itemType) {
    items = await session.queryEntity(`Item${itemType}`, filters);
  } else {
    const all = await Promise.all(
      ["Service", "Inventory", "NonInventory", "OtherCharge", "Group"]
        .map(t => session.queryEntity(`Item${t}`, filters))
    );
    items = all.flat();
  }
  ```
  Note: don't reuse the `ITEM_SUBTYPES` constant from the simulation store — that's the simulation's internal naming. The tool layer should have its own list of subtype suffixes (`Service`, `Inventory`, ...) since the operator-facing arg uses those names. Keep the two lists independent — coupling them would be a layer violation (tool reading from simulation internals).
- **`qb_item_add` rewrite.** `itemType` is already required. Just route: `session.addEntity(\`Item${args.itemType}\`, data)`. No need for the discriminator field in the data payload after that — the request type carries the subtype.
- **`qb_item_update` rewrite.** Acceptance criterion adds `itemType` to the schema. Route: `session.modifyEntity(\`Item${itemType}\`, data)`. The simulation's `handleMod` derives `entityType` from the request key, so per-subtype `Item${Subtype}ModRq` will hit the right store automatically.
- **Delete the shim when Item 2 lands.** Once `qb_item_list` no longer issues `ItemQueryRq`, the shim at [src/session/simulation-store.ts:114-127](src/session/simulation-store.ts#L114-L127) is dead code. Delete the special-case branch and revert to the original single line: `let results = Array.from(this.getStore(entityType).values());`. The `ITEM_SUBTYPES` constant can also be deleted at that point — it's only used by the shim. (Re-add later if a future feature needs it.)
- **Subtype-specific fields (acceptance criterion 5).** Inventory items accept `assetAccountName`, `cost`. Service items don't accept either. The current `qb_item_add` schema already declares all of them as optional; tightening to per-subtype validation would require splitting the schema (one zod object per subtype, or a discriminated union). Two options:
  - **Light-touch:** keep one schema, silently ignore inapplicable fields per subtype. Faster but leaves the schema lying about what each subtype accepts.
  - **Proper:** five separate registrations or a zod `discriminatedUnion`. The acceptance criterion phrases this as "are accepted" — it doesn't require strict rejection of inapplicable fields. Light-touch is acceptable for Item 2; tighten later if needed. Whatever you pick, document the choice in `DECISIONS.md` so the next agent doesn't re-debate it.
- **Item 3 delete fix.** Currently `qb_item_delete` calls `session.deleteEntity("Item", listId)`, which goes through `buildDeleteRequest("Item", ...)` and produces `<ListDelRq><ListDelType>Item</ListDelType><ListID>...</ListID></ListDelRq>`. Real QB rejects `ListDelType: "Item"`. Fix: add `itemType: z.enum([...])` to the schema, route as `session.deleteEntity(\`Item${itemType}\`, listId)`. The simulation's `handleListDel` reads `ListDelType` directly from the request, so per-subtype types route to per-subtype stores automatically.
- **README & instructions.** Once items 2 + 3 land, the operator-facing surface adds an `itemType` arg to `list` (optional) and to `delete` (required). Update both the README item table AND the `instructions` block in [src/index.ts](src/index.ts).
- **`ARCHITECTURE.md` Invariant #7.** It currently says "Item types are not generic" with a note that the code violates the rule. Once Item 2 + Item 3 land, that invariant is fully resolved at the tool layer — update the wording (drop the "currently violates" clause) and consider whether the invariant note about "fixing it is Phase 2 of todo.md" should be removed too.
- **No new dependencies.** Per CLAUDE.md, any new dep needs a `DECISIONS.md` entry. Items 2 + 3 don't need any.
- **Project conventions reminder** ([CLAUDE.md](CLAUDE.md) § Stable Code Conventions): TS strict, ESM with `.js` extensions on relative imports, every zod field has `.describe()`, no comments explaining WHAT, no backwards-compat shims in tools.

## Post-Task Chores

When items 2 + 3 are done: `npm run build` green, [REGRESSION_CHECKLIST.md](REGRESSION_CHECKLIST.md) walked (especially §3 Tool Surface and §5 Simulation Store CRUD-per-entity for the 5 subtypes), shim deleted from `simulation-store.ts`, `ITEM_SUBTYPES` constant likely deleted too, items 2 and 3 marked `[x]` in `todo.md`, acceptance entries moved to Completed, ARCHITECTURE.md invariant #7 updated, README + index.ts instructions updated, fresh `HANDOFF.md` pointing to whatever's next (Phase 3 item 4 — bill expense + item lines — is the natural follow-on per todo.md ordering, since Phase 2 was the last simulation-correctness-blocker for transaction work).
