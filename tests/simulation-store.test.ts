// Simulation store — CRUD per entity, filter handling, balance side-effects,
// EditSequence concurrency control. Each test uses a fresh `QBSessionManager`
// so seed mutations don't leak across tests. New harness (no .mjs predecessor);
// fills the gap CLAUDE.md identifies as required for Phase 8 Item 31.
//
// Important: session.addEntity / modifyEntity take FLAT entity fields. The
// builder wraps them in <EntityAdd> / <EntityMod> for the wire. Returns the
// entity object directly (already unwrapped from *Ret).

import { describe, it, expect } from "vitest";
import { QBSessionManager } from "../src/session/manager.js";

const newSession = async () => {
  const session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-simulation-store",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  await session.openSession();
  return session;
};

describe("Seed data — bootstrap state is queryable for every list entity", () => {
  it("Customer seed loads (Acme + Global + TechStart)", async () => {
    const session = await newSession();
    const customers = await session.queryEntity("Customer");
    expect(customers.length).toBeGreaterThanOrEqual(3);
    expect(customers.some((c) => String(c.Name).toLowerCase().includes("acme"))).toBe(true);
  });

  it("Vendor seed loads", async () => {
    const session = await newSession();
    const vendors = await session.queryEntity("Vendor");
    expect(vendors.length).toBeGreaterThan(0);
  });

  it("Account seed loads with chart of accounts", async () => {
    const session = await newSession();
    const accounts = await session.queryEntity("Account");
    expect(accounts.length).toBeGreaterThan(0);
    // Canonical seed accounts the simulation actually ships.
    expect(accounts.some((a) => a.Name === "Checking")).toBe(true);
    expect(accounts.some((a) => a.Name === "Sales Revenue")).toBe(true);
  });

  it("Item subtype stores all queryable (Item 22 multi-store split)", async () => {
    const session = await newSession();
    // Item 22 split the single Item store into 5 stores; each has its own
    // QueryRq + Ret name. This verifies the routing works.
    const services = await session.queryEntity("ItemService");
    expect(Array.isArray(services)).toBe(true);
    expect(services.some((i) => String(i.Name) === "Consulting Services")).toBe(true);
  });

  it("Class / Terms / PaymentMethod / SalesRep seeds load (Item 30)", async () => {
    const session = await newSession();
    const classes = await session.queryEntity("Class");
    expect(classes.length).toBeGreaterThan(0);
    const paymentMethods = await session.queryEntity("PaymentMethod");
    expect(paymentMethods.length).toBeGreaterThan(0);
    const salesReps = await session.queryEntity("SalesRep");
    expect(salesReps.length).toBeGreaterThan(0);
  });
});

describe("CRUD — Customer round-trip", () => {
  it("add → query → modify → delete", async () => {
    const session = await newSession();

    // Add (flat fields — builder wraps in <CustomerAdd>)
    const customer = await session.addEntity("Customer", {
      Name: "Test Co",
      Phone: "(555) 100-2000",
    });
    const listId = String(customer.ListID);
    const editSeq = String(customer.EditSequence);
    expect(listId).toBeTruthy();
    expect(editSeq).toBeTruthy();
    expect(customer.Name).toBe("Test Co");

    // Query by ListID
    const found = await session.queryEntity("Customer", { ListID: listId });
    expect(found).toHaveLength(1);
    expect((found[0] as Record<string, unknown>).Name).toBe("Test Co");

    // Modify with valid EditSequence
    const modified = await session.modifyEntity("Customer", {
      ListID: listId,
      EditSequence: editSeq,
      Phone: "(555) 999-9999",
    });
    expect(modified.Phone).toBe("(555) 999-9999");
    expect(String(modified.EditSequence)).not.toBe(editSeq);

    // Delete
    await session.deleteEntity("Customer", listId);
    const afterDelete = await session.queryEntity("Customer", { ListID: listId });
    expect(afterDelete).toHaveLength(0);
  });
});

describe("CRUD — EditSequence concurrency control (DECISIONS.md 2026-04-25)", () => {
  it("modify with stale EditSequence rejects with statusCode 3170", async () => {
    const session = await newSession();
    const customer = await session.addEntity("Customer", { Name: "Concurrency Test" });
    const listId = String(customer.ListID);

    let caught: unknown;
    try {
      await session.modifyEntity("Customer", {
        ListID: listId,
        EditSequence: "definitely-not-current",
        Name: "X",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { statusCode: number }).statusCode).toBe(3170);
  });

  it("EditSequence rotates on every successful modify (counter, not pure timestamp)", async () => {
    // Per DECISIONS.md 2026-04-25, EditSequence carries `${ISO}-${counter++}`
    // so two modifies in the same millisecond still produce distinct values.
    const session = await newSession();
    let customer = await session.addEntity("Customer", { Name: "Rapid Mod" });
    const listId = String(customer.ListID);
    const seqs = new Set<string>();
    seqs.add(String(customer.EditSequence));

    for (let i = 0; i < 3; i++) {
      const editSeq = String(customer.EditSequence);
      customer = await session.modifyEntity("Customer", {
        ListID: listId,
        EditSequence: editSeq,
        Phone: `iter-${i}`,
      });
      seqs.add(String(customer.EditSequence));
    }
    // 1 add + 3 mods → 4 distinct EditSequence values.
    expect(seqs.size).toBe(4);
  });
});

describe("Query filters — ListID / TxnID / FullName", () => {
  it("ListID filter returns only the named entity (single value)", async () => {
    const session = await newSession();
    const all = await session.queryEntity("Customer");
    expect(all.length).toBeGreaterThan(1);
    const target = all[0] as Record<string, unknown>;
    const filtered = await session.queryEntity("Customer", { ListID: target.ListID });
    expect(filtered).toHaveLength(1);
    expect((filtered[0] as Record<string, unknown>).ListID).toBe(target.ListID);
  });

  it("ListID filter accepts an array (returns multiple)", async () => {
    const session = await newSession();
    const all = await session.queryEntity("Customer");
    if (all.length < 2) return; // seed not deep enough
    const ids = [
      (all[0] as Record<string, unknown>).ListID,
      (all[1] as Record<string, unknown>).ListID,
    ];
    const filtered = await session.queryEntity("Customer", { ListID: ids });
    expect(filtered).toHaveLength(2);
  });

  it("FullName filter matches FullName on stored entity", async () => {
    const session = await newSession();
    const filtered = await session.queryEntity("Customer", {
      FullName: "Acme Corporation",
    });
    expect(filtered).toHaveLength(1);
    expect((filtered[0] as Record<string, unknown>).Name).toBe("Acme Corporation");
  });
});

describe("Query filters — Item 15: transaction filters (formerly silently ignored)", () => {
  // Item 15 added EntityFilter / TxnDateRangeFilter / PaidStatus / RefNumber /
  // ModifiedDateRangeFilter to handleQuery. Before Item 15 these were silently
  // ignored and queries returned all records. Each test exercises one filter
  // type and asserts the result set was actually narrowed.

  it("TxnDateRangeFilter narrows invoice query (inclusive ISO date window)", async () => {
    const session = await newSession();
    const all = await session.queryEntity("Invoice");
    expect(all.length).toBeGreaterThan(0);

    const inWindow = await session.queryEntity("Invoice", {
      TxnDateRangeFilter: { FromTxnDate: "1900-01-01", ToTxnDate: "2099-12-31" },
    });
    const outOfWindow = await session.queryEntity("Invoice", {
      TxnDateRangeFilter: { FromTxnDate: "1900-01-01", ToTxnDate: "1900-12-31" },
    });
    expect(inWindow.length).toBe(all.length);
    expect(outOfWindow.length).toBe(0);
  });

  it("EntityFilter narrows transaction query by Customer reference", async () => {
    const session = await newSession();
    // Seed has 2 invoices, one for Acme (ListID 80000001-...) and one for
    // Global (80000002-...). Filter to Acme's ListID.
    const acmeInvoices = await session.queryEntity("Invoice", {
      EntityFilter: { ListID: "80000001-1234567890" },
    });
    expect(acmeInvoices.length).toBe(1);
    const ref = (acmeInvoices[0] as Record<string, unknown>).CustomerRef as Record<string, unknown>;
    expect(ref.ListID).toBe("80000001-1234567890");
  });
});

describe("Computed totals — Item 16: AR side-effects on Customer.Balance", () => {
  it("invoice add bumps customer balance by line sum (Subtotal)", async () => {
    const session = await newSession();
    const customers = await session.queryEntity("Customer");
    const acme = customers.find((c) => c.Name === "Acme Corporation") as Record<string, unknown>;
    const beforeBalance = Number(acme.Balance ?? 0);

    // Create an invoice for $250 against Acme.
    await session.addEntity("Invoice", {
      CustomerRef: { FullName: "Acme Corporation" },
      InvoiceLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 250 },
      ],
    });

    const after = await session.queryEntity("Customer", { FullName: "Acme Corporation" });
    expect(after).toHaveLength(1);
    const afterBalance = Number((after[0] as Record<string, unknown>).Balance ?? 0);
    expect(afterBalance - beforeBalance).toBeCloseTo(250, 6);
  });
});

describe("Item 17 — InvoiceLineAdd → InvoiceLineRet conversion", () => {
  // Item 17: simulation must convert input *LineAdd arrays into output
  // *LineRet arrays with synthetic TxnLineID + computed Amount = qty * rate.
  // Without this, downstream tools see no line breakdown.

  it("invoice add produces InvoiceLineRet array with TxnLineID + computed Amount", async () => {
    const session = await newSession();
    const invoice = await session.addEntity("Invoice", {
      CustomerRef: { FullName: "Acme Corporation" },
      InvoiceLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 2, Rate: 100 },
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 3, Rate: 50 },
      ],
    });
    const lines = invoice.InvoiceLineRet as Record<string, unknown>[];
    expect(Array.isArray(lines)).toBe(true);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.TxnLineID).toBeTruthy();
      expect(typeof line.Amount).toBe("number");
    }
    expect(Number(lines[0].Amount)).toBeCloseTo(200, 6);
    expect(Number(lines[1].Amount)).toBeCloseTo(150, 6);
  });

  it("invoice computed Subtotal/BalanceRemaining match line sum (Item 16)", async () => {
    const session = await newSession();
    const invoice = await session.addEntity("Invoice", {
      CustomerRef: { FullName: "Acme Corporation" },
      InvoiceLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 4, Rate: 75 },
      ],
    });
    expect(Number(invoice.Subtotal)).toBeCloseTo(300, 6);
    expect(Number(invoice.BalanceRemaining)).toBeCloseTo(300, 6);
    expect(invoice.IsPaid).toBe(false);
  });
});

describe("Item 22 — Item subtypes route to per-subtype stores", () => {
  it("ItemServiceAdd lands in the Service store with ItemServiceRet shape", async () => {
    const session = await newSession();
    const item = await session.addEntity("ItemService", {
      Name: "Test Service",
      Description: "Vitest item",
    });
    expect(item.Name).toBe("Test Service");
    expect(item.ListID).toBeTruthy();

    // Confirm it landed in the right subtype store.
    const services = await session.queryEntity("ItemService", { FullName: "Test Service" });
    expect(services).toHaveLength(1);
  });

  it("ItemNonInventoryAdd lands in a separate store", async () => {
    const session = await newSession();
    const item = await session.addEntity("ItemNonInventory", {
      Name: "Test NonInv",
      Description: "Vitest non-inv",
    });
    expect(item.Name).toBe("Test NonInv");

    // ItemService store must not see it (per-subtype isolation).
    const services = await session.queryEntity("ItemService", { FullName: "Test NonInv" });
    expect(services).toHaveLength(0);
    // ItemNonInventory store must see it.
    const nonInv = await session.queryEntity("ItemNonInventory", { FullName: "Test NonInv" });
    expect(nonInv).toHaveLength(1);
  });
});

describe("Transaction delete uses TxnDelRq (Item 18 / Phase 4)", () => {
  it("Invoice delete reverses customer balance side-effect", async () => {
    const session = await newSession();
    const customers = await session.queryEntity("Customer");
    const acme = customers.find((c) => c.Name === "Acme Corporation") as Record<string, unknown>;
    const beforeBalance = Number(acme.Balance ?? 0);

    const invoice = await session.addEntity("Invoice", {
      CustomerRef: { FullName: "Acme Corporation" },
      InvoiceLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 500 },
      ],
    });
    const txnId = String(invoice.TxnID);

    // Sanity: balance bumped by 500.
    const mid = await session.queryEntity("Customer", { FullName: "Acme Corporation" });
    expect(Number((mid[0] as Record<string, unknown>).Balance ?? 0) - beforeBalance).toBeCloseTo(500, 6);

    await session.deleteEntity("Invoice", txnId);

    const after = await session.queryEntity("Customer", { FullName: "Acme Corporation" });
    const afterBalance = Number((after[0] as Record<string, unknown>).Balance ?? 0);
    expect(afterBalance).toBeCloseTo(beforeBalance, 6);
  });
});

describe("Cross-test isolation — fresh session per test means fresh store", () => {
  // Defensive: a regression where SimulationStore is accidentally shared
  // across QBSessionManager instances would cause balances to drift between
  // tests. Confirm the per-instance pattern works.
  it("two separate sessions don't share added entities", async () => {
    const sessionA = await newSession();
    await sessionA.addEntity("Customer", { Name: "Only In A" });
    const aCustomers = await sessionA.queryEntity("Customer", { FullName: "Only In A" });
    expect(aCustomers).toHaveLength(1);

    const sessionB = await newSession();
    const bCustomers = await sessionB.queryEntity("Customer", { FullName: "Only In A" });
    expect(bCustomers).toHaveLength(0);
  });
});
