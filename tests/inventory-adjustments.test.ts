// Phase 17 #80 — Inventory adjustment CRUD + ItemInventory mutation tests.
//
// Coverage layers:
//   1. Sim handleAdd — applyInventoryAdjustment mutates ItemInventory's
//      QuantityOnHand / QuantityOnHandValue / AverageCost; line-shape
//      validation rejects WITHOUT mutating any items (two-phase commit);
//      both QuantityAdjustment and ValueAdjustment branches walk correctly;
//      AverageCost preserved at zero-qty stock-out; multi-line same-item
//      composition.
//   2. Sim handleTxnDel — reverseInventoryAdjustment unwinds every line's
//      qty/value delta; orphan items (item deleted) silently skipped.
//   3. qb_inventory_adjustment_list — list shape, line-strip default,
//      includeLineItems passthrough, txnId / refNumber / accountName /
//      accountListId / date filters, fresh-sim empty path.
//   4. qb_inventory_adjustment_create — happy path single + multi line,
//      every input shape (NewQuantity / QuantityDifference / NewValue /
//      ValueDifference / combined), accountRef validation, line validation
//      (mutually-exclusive branches, no-lines), idempotencyKey replay +
//      9002 conflict, read-only gate (9001), error surface with humanReadable.
//   5. qb_inventory_adjustment_delete — happy path with full reversal,
//      unknown TxnID 500, read-only gate (9001).

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerInventoryAdjustmentTools } from "../src/tools/inventory-adjustments.js";

type Handler = (args: unknown) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

const handlers = new Map<string, Handler>();
const fakeServer = {
  tool: (
    name: string,
    _description: string,
    _schema: Record<string, z.ZodTypeAny>,
    handler: Handler,
  ) => {
    handlers.set(name, handler);
  },
};

function freshSession(): QBSessionManager {
  return new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-inventory-adjustments",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

async function getInventoryItem(
  session: QBSessionManager,
  fullName: string,
): Promise<Record<string, unknown>> {
  const items = await session.queryEntity("ItemInventory", { FullName: fullName });
  return items[0];
}

beforeEach(() => {
  handlers.clear();
});

// ---------------------------------------------------------------------------
// Layer 1 — sim handleAdd: applyInventoryAdjustment mutates ItemInventory
// ---------------------------------------------------------------------------

describe("SimulationStore — applyInventoryAdjustment", () => {
  it("seed has Widget A at 100 / $12 / $1200 and Widget B at 40 / $22 / $880", async () => {
    const session = freshSession();
    const a = await getInventoryItem(session, "Widget A");
    expect(a.QuantityOnHand).toBe(100);
    expect(a.AverageCost).toBe(12);
    expect(a.QuantityOnHandValue).toBe(1200);
    const b = await getInventoryItem(session, "Widget B");
    expect(b.QuantityOnHand).toBe(40);
    expect(b.AverageCost).toBe(22);
    expect(b.QuantityOnHandValue).toBe(880);
  });

  it("QuantityAdjustment.NewQuantity (shrinkage 100 → 95) walks at AverageCost", async () => {
    const session = freshSession();
    const adj = await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      TxnDate: "2026-05-15",
      RefNumber: "ADJ-001",
      InventoryAdjustmentLineAdd: [
        {
          ItemRef: { FullName: "Widget A" },
          QuantityAdjustment: { NewQuantity: 95 },
        },
      ],
    });

    // Item state mutated.
    const a = await getInventoryItem(session, "Widget A");
    expect(a.QuantityOnHand).toBe(95);
    expect(a.AverageCost).toBe(12); // unchanged
    expect(a.QuantityOnHandValue).toBe(95 * 12); // 1140

    // Line normalized: QuantityAdjustment dropped, deltas surfaced.
    const lines = adj.InventoryAdjustmentLineRet as Record<string, unknown>[];
    expect(lines.length).toBe(1);
    expect(lines[0].QuantityAdjustment).toBeUndefined();
    expect(lines[0].QuantityDifference).toBe(-5);
    expect(lines[0].ValueDifference).toBe(-60);
    expect(lines[0].Amount).toBe(-60);
    expect(adj.TotalAmount).toBe(-60);
  });

  it("QuantityAdjustment.QuantityDifference (delta) form composes correctly", async () => {
    const session = freshSession();
    const adj = await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      InventoryAdjustmentLineAdd: [
        {
          ItemRef: { FullName: "Widget A" },
          QuantityAdjustment: { QuantityDifference: -3 },
        },
      ],
    });

    const a = await getInventoryItem(session, "Widget A");
    expect(a.QuantityOnHand).toBe(97);
    expect(a.QuantityOnHandValue).toBe(97 * 12); // 1164
    const lines = adj.InventoryAdjustmentLineRet as Record<string, unknown>[];
    expect(lines[0].QuantityDifference).toBe(-3);
    expect(lines[0].ValueDifference).toBe(-36);
  });

  it("ValueAdjustment.NewValue (write-down without count change) recomputes AverageCost", async () => {
    const session = freshSession();
    // Widget A starts at 100 units / $1200 value / $12 cost. Write down to
    // $800 total without changing count → new AvgCost = $800/100 = $8.
    const adj = await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      InventoryAdjustmentLineAdd: [
        {
          ItemRef: { FullName: "Widget A" },
          ValueAdjustment: { NewValue: 800 },
        },
      ],
    });

    const a = await getInventoryItem(session, "Widget A");
    expect(a.QuantityOnHand).toBe(100);
    expect(a.QuantityOnHandValue).toBe(800);
    expect(a.AverageCost).toBe(8);
    const lines = adj.InventoryAdjustmentLineRet as Record<string, unknown>[];
    expect(lines[0].QuantityDifference).toBe(0);
    expect(lines[0].ValueDifference).toBe(-400);
    expect(lines[0].Amount).toBe(-400);
  });

  it("ValueAdjustment.ValueDifference (delta) form recomputes AverageCost", async () => {
    const session = freshSession();
    const adj = await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      InventoryAdjustmentLineAdd: [
        {
          ItemRef: { FullName: "Widget A" },
          ValueAdjustment: { ValueDifference: 200 },
        },
      ],
    });

    const a = await getInventoryItem(session, "Widget A");
    expect(a.QuantityOnHand).toBe(100);
    expect(a.QuantityOnHandValue).toBe(1400);
    expect(a.AverageCost).toBe(14);
    const lines = adj.InventoryAdjustmentLineRet as Record<string, unknown>[];
    expect(lines[0].ValueDifference).toBe(200);
    expect(adj.TotalAmount).toBe(200);
  });

  it("Combined ValueAdjustment with NewQuantity + NewValue moves both axes", async () => {
    const session = freshSession();
    // Restock + reprice in one line: bring Widget A to 150 units at $1500 total
    // (new AvgCost $10).
    await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      InventoryAdjustmentLineAdd: [
        {
          ItemRef: { FullName: "Widget A" },
          ValueAdjustment: { NewQuantity: 150, NewValue: 1500 },
        },
      ],
    });
    const a = await getInventoryItem(session, "Widget A");
    expect(a.QuantityOnHand).toBe(150);
    expect(a.QuantityOnHandValue).toBe(1500);
    expect(a.AverageCost).toBe(10);
  });

  it("Multi-line adjustment touches multiple items in one txn; TotalAmount sums deltas", async () => {
    const session = freshSession();
    const adj = await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      InventoryAdjustmentLineAdd: [
        // Widget A: -2 units * $12 = -24
        { ItemRef: { FullName: "Widget A" }, QuantityAdjustment: { QuantityDifference: -2 } },
        // Widget B: +5 units * $22 = +110
        { ItemRef: { FullName: "Widget B" }, QuantityAdjustment: { QuantityDifference: 5 } },
      ],
    });

    const a = await getInventoryItem(session, "Widget A");
    const b = await getInventoryItem(session, "Widget B");
    expect(a.QuantityOnHand).toBe(98);
    expect(b.QuantityOnHand).toBe(45);
    expect(adj.TotalAmount).toBe(-24 + 110);
  });

  it("Quantity falls to zero — AverageCost is PRESERVED (not divided by zero)", async () => {
    const session = freshSession();
    await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      InventoryAdjustmentLineAdd: [
        // Drop Widget A to zero (write off entire stock).
        { ItemRef: { FullName: "Widget A" }, QuantityAdjustment: { NewQuantity: 0 } },
      ],
    });
    const a = await getInventoryItem(session, "Widget A");
    expect(a.QuantityOnHand).toBe(0);
    expect(a.QuantityOnHandValue).toBe(0);
    // Cost-basis history preserved — a future restock keeps the prior $12 cost.
    expect(a.AverageCost).toBe(12);
  });

  it("Multiple lines against the SAME item compose running state correctly", async () => {
    const session = freshSession();
    // Two lines against Widget A: -5 then -3 = -8 net. Both must use the
    // running quantity, not re-read from the store.
    const adj = await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      InventoryAdjustmentLineAdd: [
        { ItemRef: { FullName: "Widget A" }, QuantityAdjustment: { QuantityDifference: -5 } },
        { ItemRef: { FullName: "Widget A" }, QuantityAdjustment: { QuantityDifference: -3 } },
      ],
    });
    const a = await getInventoryItem(session, "Widget A");
    expect(a.QuantityOnHand).toBe(92);
    expect(adj.TotalAmount).toBe(-8 * 12);
  });

  it("ItemRef by ListID resolves correctly", async () => {
    const session = freshSession();
    await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      InventoryAdjustmentLineAdd: [
        { ItemRef: { ListID: "I0000003" }, QuantityAdjustment: { NewQuantity: 90 } },
      ],
    });
    const a = await getInventoryItem(session, "Widget A");
    expect(a.QuantityOnHand).toBe(90);
  });

  it("Missing AccountRef rejects with statusCode 3120", async () => {
    const session = freshSession();
    await expect(
      session.addEntity("InventoryAdjustment", {
        InventoryAdjustmentLineAdd: [
          { ItemRef: { FullName: "Widget A" }, QuantityAdjustment: { NewQuantity: 95 } },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 3120 });

    // Item state untouched — pre-validation fired before any mutation.
    const a = await getInventoryItem(session, "Widget A");
    expect(a.QuantityOnHand).toBe(100);
  });

  it("Missing lines array rejects with statusCode 3120", async () => {
    const session = freshSession();
    await expect(
      session.addEntity("InventoryAdjustment", {
        AccountRef: { FullName: "Cost of Goods Sold" },
        InventoryAdjustmentLineAdd: [],
      }),
    ).rejects.toMatchObject({ statusCode: 3120 });
  });

  it("Unknown ItemRef rejects with statusCode 500 and item state is untouched", async () => {
    const session = freshSession();
    await expect(
      session.addEntity("InventoryAdjustment", {
        AccountRef: { FullName: "Cost of Goods Sold" },
        InventoryAdjustmentLineAdd: [
          { ItemRef: { FullName: "Widget A" }, QuantityAdjustment: { NewQuantity: 95 } },
          { ItemRef: { FullName: "Nonexistent Widget Z" }, QuantityAdjustment: { NewQuantity: 50 } },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 500 });

    // Two-phase commit: Widget A's state was NOT mutated even though it was
    // the first valid line — the doomed second line aborts the whole txn.
    const a = await getInventoryItem(session, "Widget A");
    expect(a.QuantityOnHand).toBe(100);
  });

  it("Both QuantityAdjustment AND ValueAdjustment on one line rejects with 3120", async () => {
    const session = freshSession();
    await expect(
      session.addEntity("InventoryAdjustment", {
        AccountRef: { FullName: "Cost of Goods Sold" },
        InventoryAdjustmentLineAdd: [
          {
            ItemRef: { FullName: "Widget A" },
            QuantityAdjustment: { NewQuantity: 95 },
            ValueAdjustment: { NewValue: 1000 },
          },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 3120 });

    const a = await getInventoryItem(session, "Widget A");
    expect(a.QuantityOnHand).toBe(100);
  });

  it("Line with neither QuantityAdjustment nor ValueAdjustment rejects with 3120", async () => {
    const session = freshSession();
    await expect(
      session.addEntity("InventoryAdjustment", {
        AccountRef: { FullName: "Cost of Goods Sold" },
        InventoryAdjustmentLineAdd: [
          { ItemRef: { FullName: "Widget A" } },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 3120 });
  });

  it("QuantityAdjustment without NewQuantity or QuantityDifference rejects with 3120", async () => {
    const session = freshSession();
    await expect(
      session.addEntity("InventoryAdjustment", {
        AccountRef: { FullName: "Cost of Goods Sold" },
        InventoryAdjustmentLineAdd: [
          { ItemRef: { FullName: "Widget A" }, QuantityAdjustment: {} },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 3120 });
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — sim handleTxnDel: reverseInventoryAdjustment
// ---------------------------------------------------------------------------

describe("SimulationStore — reverseInventoryAdjustment on TxnDelRq", () => {
  it("delete restores Widget A to pre-adjustment QuantityOnHand + AverageCost + Value", async () => {
    const session = freshSession();
    const adj = await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      InventoryAdjustmentLineAdd: [
        { ItemRef: { FullName: "Widget A" }, QuantityAdjustment: { NewQuantity: 90 } },
      ],
    });
    // Post-add state: 90 / $1080 / $12.
    let a = await getInventoryItem(session, "Widget A");
    expect(a.QuantityOnHand).toBe(90);
    expect(a.QuantityOnHandValue).toBe(1080);

    await session.deleteEntity("InventoryAdjustment", String(adj.TxnID));

    // Restored to seed: 100 / $1200 / $12.
    a = await getInventoryItem(session, "Widget A");
    expect(a.QuantityOnHand).toBe(100);
    expect(a.QuantityOnHandValue).toBe(1200);
    expect(a.AverageCost).toBe(12);
  });

  it("delete reverses a value-only write-down — AverageCost returns to prior", async () => {
    const session = freshSession();
    const adj = await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      InventoryAdjustmentLineAdd: [
        // Write down to $800 → AvgCost $8.
        { ItemRef: { FullName: "Widget A" }, ValueAdjustment: { NewValue: 800 } },
      ],
    });
    let a = await getInventoryItem(session, "Widget A");
    expect(a.AverageCost).toBe(8);

    await session.deleteEntity("InventoryAdjustment", String(adj.TxnID));
    a = await getInventoryItem(session, "Widget A");
    expect(a.QuantityOnHand).toBe(100);
    expect(a.QuantityOnHandValue).toBe(1200);
    expect(a.AverageCost).toBe(12);
  });

  it("delete reverses a multi-line adjustment across two items", async () => {
    const session = freshSession();
    const adj = await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      InventoryAdjustmentLineAdd: [
        { ItemRef: { FullName: "Widget A" }, QuantityAdjustment: { QuantityDifference: -10 } },
        { ItemRef: { FullName: "Widget B" }, QuantityAdjustment: { QuantityDifference: -5 } },
      ],
    });
    expect((await getInventoryItem(session, "Widget A")).QuantityOnHand).toBe(90);
    expect((await getInventoryItem(session, "Widget B")).QuantityOnHand).toBe(35);

    await session.deleteEntity("InventoryAdjustment", String(adj.TxnID));
    expect((await getInventoryItem(session, "Widget A")).QuantityOnHand).toBe(100);
    expect((await getInventoryItem(session, "Widget B")).QuantityOnHand).toBe(40);
  });

  it("delete with orphan item (item deleted) silently skips that line", async () => {
    const session = freshSession();
    // Adjust Widget B (so a later Widget B delete leaves the adjustment line orphan).
    const adj = await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      InventoryAdjustmentLineAdd: [
        { ItemRef: { FullName: "Widget B" }, QuantityAdjustment: { QuantityDifference: -5 } },
      ],
    });
    expect((await getInventoryItem(session, "Widget B")).QuantityOnHand).toBe(35);
    // Manually nuke Widget B from the inventory store to simulate a hard
    // delete (qb_item_delete would be the operator path; addressing the
    // store directly avoids dragging in the items tool wiring here).
    const store = (session as unknown as { store: { getStore: (t: string) => Map<string, unknown> } })
      .store.getStore("ItemInventory");
    store.delete("I0000004");

    // Delete must not throw despite the orphan — adjustment delete is the
    // last-resort cleanup path, blocking it on a missing item is hostile.
    await expect(
      session.deleteEntity("InventoryAdjustment", String(adj.TxnID)),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — qb_inventory_adjustment_list tool surface
// ---------------------------------------------------------------------------

describe("qb_inventory_adjustment_list tool", () => {
  it("bare call returns count 0 against fresh sim (no seeded adjustments)", async () => {
    const session = freshSession();
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_list")!;
    const result = await handler({});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(0);
    expect(Array.isArray(payload.inventoryAdjustments)).toBe(true);
  });

  it("after creating one adjustment, list returns it (lines stripped by default)", async () => {
    const session = freshSession();
    const adj = await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      RefNumber: "ADJ-100",
      InventoryAdjustmentLineAdd: [
        { ItemRef: { FullName: "Widget A" }, QuantityAdjustment: { NewQuantity: 95 } },
      ],
    });
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_list")!;
    const result = await handler({});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.inventoryAdjustments[0].TxnID).toBe(adj.TxnID);
    expect(payload.inventoryAdjustments[0].RefNumber).toBe("ADJ-100");
    expect(payload.inventoryAdjustments[0].TotalAmount).toBe(-60);
    // Default: lines stripped (matches qb_purchase_order_list / qb_invoice_list).
    expect(payload.inventoryAdjustments[0].InventoryAdjustmentLineRet).toBeUndefined();
  });

  it("includeLineItems:true surfaces InventoryAdjustmentLineRet with normalized deltas", async () => {
    const session = freshSession();
    await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      InventoryAdjustmentLineAdd: [
        { ItemRef: { FullName: "Widget A" }, QuantityAdjustment: { NewQuantity: 95 } },
      ],
    });
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_list")!;
    const result = await handler({ includeLineItems: true });
    const payload = JSON.parse(result.content[0].text);
    const lines = payload.inventoryAdjustments[0].InventoryAdjustmentLineRet;
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBe(1);
    expect(lines[0].QuantityDifference).toBe(-5);
    expect(lines[0].ValueDifference).toBe(-60);
    expect(lines[0].QuantityAdjustment).toBeUndefined();
  });

  it("txnId filter narrows to one adjustment", async () => {
    const session = freshSession();
    const a = await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      InventoryAdjustmentLineAdd: [
        { ItemRef: { FullName: "Widget A" }, QuantityAdjustment: { NewQuantity: 99 } },
      ],
    });
    await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      InventoryAdjustmentLineAdd: [
        { ItemRef: { FullName: "Widget B" }, QuantityAdjustment: { NewQuantity: 39 } },
      ],
    });
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_list")!;
    const result = await handler({ txnId: String(a.TxnID) });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.inventoryAdjustments[0].TxnID).toBe(a.TxnID);
  });

  it("refNumber filter scopes correctly", async () => {
    const session = freshSession();
    await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      RefNumber: "ADJ-A",
      InventoryAdjustmentLineAdd: [
        { ItemRef: { FullName: "Widget A" }, QuantityAdjustment: { NewQuantity: 95 } },
      ],
    });
    await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      RefNumber: "ADJ-B",
      InventoryAdjustmentLineAdd: [
        { ItemRef: { FullName: "Widget B" }, QuantityAdjustment: { NewQuantity: 38 } },
      ],
    });
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_list")!;
    const result = await handler({ refNumber: "ADJ-B" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.inventoryAdjustments[0].RefNumber).toBe("ADJ-B");
  });

  it("accountName filter (tool-layer post-filter) scopes by AccountRef.FullName", async () => {
    const session = freshSession();
    await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      InventoryAdjustmentLineAdd: [
        { ItemRef: { FullName: "Widget A" }, QuantityAdjustment: { NewQuantity: 99 } },
      ],
    });
    await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Rent Expense" },
      InventoryAdjustmentLineAdd: [
        { ItemRef: { FullName: "Widget B" }, QuantityAdjustment: { NewQuantity: 38 } },
      ],
    });
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_list")!;
    const result = await handler({ accountName: "Cost of Goods Sold" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.inventoryAdjustments[0].AccountRef.FullName).toBe("Cost of Goods Sold");
  });

  it("date range filter scopes by TxnDate", async () => {
    const session = freshSession();
    await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      TxnDate: "2026-01-15",
      InventoryAdjustmentLineAdd: [
        { ItemRef: { FullName: "Widget A" }, QuantityAdjustment: { NewQuantity: 99 } },
      ],
    });
    await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      TxnDate: "2026-04-30",
      InventoryAdjustmentLineAdd: [
        { ItemRef: { FullName: "Widget B" }, QuantityAdjustment: { NewQuantity: 38 } },
      ],
    });
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_list")!;
    const result = await handler({ fromDate: "2026-04-01", toDate: "2026-05-01" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.inventoryAdjustments[0].TxnDate).toBe("2026-04-30");
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — qb_inventory_adjustment_create tool surface
// ---------------------------------------------------------------------------

describe("qb_inventory_adjustment_create tool", () => {
  it("happy path: NewQuantity input mutates item and returns the txn", async () => {
    const session = freshSession();
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_create")!;
    const result = await handler({
      accountName: "Cost of Goods Sold",
      txnDate: "2026-05-15",
      refNumber: "ADJ-001",
      memo: "Annual count",
      lines: [
        { itemName: "Widget A", newQuantity: 95 },
      ],
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.inventoryAdjustment.TotalAmount).toBe(-60);
    expect(payload.inventoryAdjustment.RefNumber).toBe("ADJ-001");

    const a = await getInventoryItem(session, "Widget A");
    expect(a.QuantityOnHand).toBe(95);
  });

  it("happy path: quantityDifference (delta) form", async () => {
    const session = freshSession();
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_create")!;
    const result = await handler({
      accountName: "Cost of Goods Sold",
      lines: [
        { itemName: "Widget A", quantityDifference: -10 },
      ],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.inventoryAdjustment.TotalAmount).toBe(-120);
    const a = await getInventoryItem(session, "Widget A");
    expect(a.QuantityOnHand).toBe(90);
  });

  it("happy path: pure value adjustment via valueDifference (write-down)", async () => {
    const session = freshSession();
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_create")!;
    const result = await handler({
      accountName: "Cost of Goods Sold",
      lines: [
        { itemName: "Widget A", valueDifference: -300 },
      ],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    const a = await getInventoryItem(session, "Widget A");
    expect(a.QuantityOnHand).toBe(100);
    expect(a.QuantityOnHandValue).toBe(900);
    expect(a.AverageCost).toBe(9);
  });

  it("happy path: combined value + quantity (newQuantity + newValue) routes through ValueAdjustment", async () => {
    const session = freshSession();
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_create")!;
    const result = await handler({
      accountName: "Cost of Goods Sold",
      lines: [
        { itemName: "Widget A", newQuantity: 200, newValue: 2000 },
      ],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    const a = await getInventoryItem(session, "Widget A");
    expect(a.QuantityOnHand).toBe(200);
    expect(a.QuantityOnHandValue).toBe(2000);
    expect(a.AverageCost).toBe(10);
  });

  it("multi-line happy path: two items, one txn", async () => {
    const session = freshSession();
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_create")!;
    const result = await handler({
      accountName: "Cost of Goods Sold",
      lines: [
        { itemName: "Widget A", quantityDifference: -2 },
        { itemName: "Widget B", quantityDifference: 5 },
      ],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.inventoryAdjustment.TotalAmount).toBe(-24 + 110);
    expect((payload.inventoryAdjustment.InventoryAdjustmentLineRet as unknown[]).length).toBe(2);
  });

  it("itemListId resolves correctly", async () => {
    const session = freshSession();
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_create")!;
    const result = await handler({
      accountName: "Cost of Goods Sold",
      lines: [
        { itemListId: "I0000003", newQuantity: 95 },
      ],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect((await getInventoryItem(session, "Widget A")).QuantityOnHand).toBe(95);
  });

  it("missing accountName + accountListId rejects upfront (no wire I/O)", async () => {
    const session = freshSession();
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_create")!;
    const result = await handler({
      lines: [{ itemName: "Widget A", newQuantity: 95 }],
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("accountName or accountListId");
  });

  it("idempotencyKey replay returns identical TxnID with idempotentReplay flag", async () => {
    const session = freshSession();
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_create")!;

    const args = {
      accountName: "Cost of Goods Sold",
      idempotencyKey: "year-end-2025-count",
      lines: [{ itemName: "Widget A", newQuantity: 95 }],
    };
    const first = JSON.parse((await handler(args)).content[0].text);
    expect(first.success).toBe(true);
    expect(first.idempotentReplay).toBeUndefined();

    const second = JSON.parse((await handler(args)).content[0].text);
    expect(second.success).toBe(true);
    expect(second.idempotentReplay).toBe(true);
    expect(second.inventoryAdjustment.TxnID).toBe(first.inventoryAdjustment.TxnID);

    // Item state was mutated ONCE — replay must not double-apply.
    const a = await getInventoryItem(session, "Widget A");
    expect(a.QuantityOnHand).toBe(95);
  });

  it("idempotencyKey + different payload returns statusCode 9002 conflict", async () => {
    const session = freshSession();
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_create")!;
    await handler({
      accountName: "Cost of Goods Sold",
      idempotencyKey: "shared-key",
      lines: [{ itemName: "Widget A", newQuantity: 95 }],
    });
    const result = await handler({
      accountName: "Cost of Goods Sold",
      idempotencyKey: "shared-key",
      lines: [{ itemName: "Widget A", newQuantity: 90 }], // different
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(9002);
  });

  it("read-only session rejects create with statusCode 9001", async () => {
    const session = freshSession();
    session.setReadOnly(true);
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_create")!;
    const result = await handler({
      accountName: "Cost of Goods Sold",
      lines: [{ itemName: "Widget A", newQuantity: 95 }],
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(9001);
    expect(payload.humanReadable).toBeTruthy();
  });

  // The fakeServer test harness invokes the handler directly without running
  // the Zod schema (real McpServer would reject at validation). The two cases
  // below escape Zod and exercise the sim-layer fallback validation, which
  // catches them with statusCode 3120.
  it("line with neither value nor quantity field surfaces as sim-layer 3120", async () => {
    const session = freshSession();
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_create")!;
    const result = await handler({
      accountName: "Cost of Goods Sold",
      lines: [{ itemName: "Widget A" }],
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(3120);
    expect(payload.statusMessage).toMatch(/QuantityAdjustment or ValueAdjustment/);
  });

  it("empty lines array surfaces as sim-layer 3120 (Zod min(1) bypassed by harness)", async () => {
    const session = freshSession();
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_create")!;
    const result = await handler({
      accountName: "Cost of Goods Sold",
      lines: [],
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(3120);
    expect(payload.statusMessage).toMatch(/at least one/);
  });

  it("unknown item surfaces as structured tool error with humanReadable", async () => {
    const session = freshSession();
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_create")!;
    const result = await handler({
      accountName: "Cost of Goods Sold",
      lines: [{ itemName: "Mystery Widget Z", newQuantity: 42 }],
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.statusCode).toBe(500);
    expect(payload.humanReadable).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Layer 5 — qb_inventory_adjustment_delete tool surface
// ---------------------------------------------------------------------------

describe("qb_inventory_adjustment_delete tool", () => {
  it("happy path: delete reverses item state + returns success", async () => {
    const session = freshSession();
    const created = await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      InventoryAdjustmentLineAdd: [
        { ItemRef: { FullName: "Widget A" }, QuantityAdjustment: { NewQuantity: 90 } },
      ],
    });
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_delete")!;
    const result = await handler({ txnId: String(created.TxnID) });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);

    // Adjustment removed from store.
    const list = await session.queryEntity("InventoryAdjustment", {});
    expect(list.find((r) => r.TxnID === created.TxnID)).toBeUndefined();

    // Widget A restored to seed.
    expect((await getInventoryItem(session, "Widget A")).QuantityOnHand).toBe(100);
  });

  it("unknown TxnID returns structured 500 error", async () => {
    const session = freshSession();
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_delete")!;
    const result = await handler({ txnId: "T9999999-NONEXISTENT" });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.statusCode).toBe(500);
  });

  it("read-only session rejects delete with 9001", async () => {
    const session = freshSession();
    const created = await session.addEntity("InventoryAdjustment", {
      AccountRef: { FullName: "Cost of Goods Sold" },
      InventoryAdjustmentLineAdd: [
        { ItemRef: { FullName: "Widget A" }, QuantityAdjustment: { NewQuantity: 95 } },
      ],
    });
    session.setReadOnly(true);
    registerInventoryAdjustmentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_inventory_adjustment_delete")!;
    const result = await handler({ txnId: String(created.TxnID) });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(9001);
  });
});
