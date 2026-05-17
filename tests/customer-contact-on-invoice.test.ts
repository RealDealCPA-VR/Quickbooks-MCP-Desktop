// Phase 13 #60 — qb_invoice_list includeCustomerContact join.
//
// Coverage:
//   1. Helper unit — pickContactFields surfaces present fields only,
//      drops empty / null / undefined values.
//   2. Tool surface — happy path: contact fields attach on each invoice;
//      multi-customer dedup (one CustomerQueryRq for many invoices);
//      flag-off default doesn't surface customerContact.
//   3. Paginated path — flag works under paginate:true.
//   4. Fail-soft — CustomerQueryRq failure surfaces as a `warning` without
//      poisoning the InvoiceQueryRq result; invoices missing CustomerRef
//      survive gracefully.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerInvoiceTools } from "../src/tools/invoices.js";

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
    appName: "vitest-customer-contact-on-invoice",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

beforeEach(() => {
  handlers.clear();
});

// ---------------------------------------------------------------------------
// Layer 1 — happy path: contact fields attach on every invoice
// ---------------------------------------------------------------------------

describe("qb_invoice_list — includeCustomerContact:true", () => {
  it("attaches customerContact with Email / Phone / CompanyName etc. on every invoice", async () => {
    const session = freshSession();
    await session.openSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const list = handlers.get("qb_invoice_list")!;

    // Seed: one invoice each against two of the standard seed customers.
    await session.addEntity("Invoice", {
      CustomerRef: { FullName: "Acme Corporation" },
      TxnDate: "2026-04-15",
      RefNumber: "INV-A",
      InvoiceLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 500 },
      ],
    });
    await session.addEntity("Invoice", {
      CustomerRef: { FullName: "Global Industries" },
      TxnDate: "2026-04-16",
      RefNumber: "INV-G",
      InvoiceLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 750 },
      ],
    });

    const result = await list({ includeCustomerContact: true });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.warning).toBeUndefined();

    const invoices = payload.invoices as Array<Record<string, unknown>>;
    const acme = invoices.find(
      (i) =>
        (i.CustomerRef as { FullName?: string })?.FullName === "Acme Corporation",
    );
    const global = invoices.find(
      (i) =>
        (i.CustomerRef as { FullName?: string })?.FullName === "Global Industries",
    );

    expect(acme?.customerContact).toEqual({
      Phone: "555-0100",
      Email: "john@acmecorp.com",
      CompanyName: "Acme Corporation",
      FirstName: "John",
      LastName: "Smith",
    });
    expect(global?.customerContact).toEqual({
      Phone: "555-0200",
      Email: "jane@globalind.com",
      CompanyName: "Global Industries LLC",
      FirstName: "Jane",
      LastName: "Doe",
    });
  });

  it("drops empty / null / undefined contact fields (surfaces present fields only)", async () => {
    const session = freshSession();
    await session.openSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const list = handlers.get("qb_invoice_list")!;

    // Add a customer with ONLY Email; everything else absent.
    await session.addEntity("Customer", {
      Name: "Sparse Contact LLC",
      FullName: "Sparse Contact LLC",
      Email: "ops@sparse.example",
      Phone: "", // empty string — must drop
      CompanyName: undefined, // undefined — must drop
    });
    await session.addEntity("Invoice", {
      CustomerRef: { FullName: "Sparse Contact LLC" },
      TxnDate: "2026-04-20",
      RefNumber: "INV-SP",
      InvoiceLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 100 },
      ],
    });

    const result = await list({
      includeCustomerContact: true,
      customerName: "Sparse Contact LLC",
    });
    const invoices = JSON.parse(result.content[0].text).invoices as Array<
      Record<string, unknown>
    >;
    expect(invoices).toHaveLength(1);
    expect(invoices[0].customerContact).toEqual({
      Email: "ops@sparse.example",
    });
  });

  it("issues ONE CustomerQueryRq regardless of how many invoices share the same customer", async () => {
    const session = freshSession();
    await session.openSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const list = handlers.get("qb_invoice_list")!;

    // 3 invoices for Acme + 1 for Global = 2 unique customers. Seed with the
    // full CustomerRef shape (both ListID + FullName) — that's what live QB
    // always returns, and what the standard seed invoices already carry.
    for (const ref of ["INV-A1", "INV-A2", "INV-A3"]) {
      await session.addEntity("Invoice", {
        CustomerRef: { ListID: "80000001-1234567890", FullName: "Acme Corporation" },
        TxnDate: "2026-04-15",
        RefNumber: ref,
        InvoiceLineAdd: [
          { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 100 },
        ],
      });
    }
    await session.addEntity("Invoice", {
      CustomerRef: { ListID: "80000002-1234567890", FullName: "Global Industries" },
      TxnDate: "2026-04-15",
      RefNumber: "INV-G1",
      InvoiceLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 100 },
      ],
    });

    const originalQuery = session.queryEntity.bind(session);
    const spy = vi.spyOn(session, "queryEntity").mockImplementation((entity, filters) => {
      return originalQuery(entity, filters);
    });

    await list({ includeCustomerContact: true });

    // 1 InvoiceQueryRq + 1 CustomerQueryRq (NOT 4 CustomerQueryRq).
    const customerCalls = spy.mock.calls.filter((c) => c[0] === "Customer");
    expect(customerCalls).toHaveLength(1);
    // The single CustomerQueryRq filters by an array of ListIDs, not one per call.
    const filters = customerCalls[0][1] as { ListID?: unknown };
    expect(Array.isArray(filters.ListID)).toBe(true);
    // Across seed invoices + the 4 new ones, the unique-ListID set covers
    // Acme + Global + the seed's other customers (TechStart, etc.) — dedup
    // by ListID, but the count depends on what seed invoices exist. The
    // contract under test is "one call, ListIDs batched", not the exact
    // cardinality of the seed.
    expect((filters.ListID as string[]).length).toBeGreaterThanOrEqual(2);
    expect((filters.ListID as string[]).length).toBeLessThan(10);

    spy.mockRestore();
  });

  it("default (no flag) does NOT surface customerContact", async () => {
    const session = freshSession();
    await session.openSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const list = handlers.get("qb_invoice_list")!;

    await session.addEntity("Invoice", {
      CustomerRef: { FullName: "Acme Corporation" },
      TxnDate: "2026-04-15",
      RefNumber: "INV-A",
      InvoiceLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 500 },
      ],
    });

    const result = await list({});
    const invoices = JSON.parse(result.content[0].text).invoices as Array<
      Record<string, unknown>
    >;
    expect(invoices.length).toBeGreaterThan(0);
    for (const inv of invoices) {
      expect(inv.customerContact).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — paginated path
// ---------------------------------------------------------------------------

describe("qb_invoice_list — includeCustomerContact under paginate:true", () => {
  it("attaches customerContact on the paginated response too", async () => {
    const session = freshSession();
    await session.openSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const list = handlers.get("qb_invoice_list")!;

    await session.addEntity("Invoice", {
      CustomerRef: { FullName: "Acme Corporation" },
      TxnDate: "2026-04-15",
      RefNumber: "INV-A",
      InvoiceLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 500 },
      ],
    });

    const result = await list({ paginate: true, includeCustomerContact: true });
    const payload = JSON.parse(result.content[0].text);
    const invoices = payload.invoices as Array<Record<string, unknown>>;
    const acme = invoices.find(
      (i) =>
        (i.CustomerRef as { FullName?: string })?.FullName === "Acme Corporation",
    );
    expect(acme?.customerContact).toMatchObject({
      Email: "john@acmecorp.com",
      Phone: "555-0100",
    });
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — fail-soft
// ---------------------------------------------------------------------------

describe("qb_invoice_list — includeCustomerContact fail-soft", () => {
  it("surfaces a `warning` and returns invoices without customerContact when CustomerQueryRq fails", async () => {
    const session = freshSession();
    await session.openSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const list = handlers.get("qb_invoice_list")!;

    await session.addEntity("Invoice", {
      CustomerRef: { FullName: "Acme Corporation" },
      TxnDate: "2026-04-15",
      RefNumber: "INV-A",
      InvoiceLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 500 },
      ],
    });

    const originalQuery = session.queryEntity.bind(session);
    const spy = vi
      .spyOn(session, "queryEntity")
      .mockImplementation((entity, filters) => {
        if (entity === "Customer") {
          return Promise.reject(new Error("simulated CustomerQueryRq wire failure"));
        }
        return originalQuery(entity, filters);
      });

    const result = await list({ includeCustomerContact: true });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.invoices.length).toBeGreaterThan(0);
    expect(payload.warning).toContain("CustomerQueryRq");
    expect(payload.warning).toContain("simulated CustomerQueryRq wire failure");
    for (const inv of payload.invoices as Array<Record<string, unknown>>) {
      expect(inv.customerContact).toBeUndefined();
    }

    spy.mockRestore();
  });

  it("returns gracefully on empty result — no warning, no customer query", async () => {
    const session = freshSession();
    await session.openSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const list = handlers.get("qb_invoice_list")!;

    const spy = vi.spyOn(session, "queryEntity");

    // RefNumber filter for a number that doesn't exist → empty invoices.
    const result = await list({
      includeCustomerContact: true,
      refNumber: "NO-SUCH-INV-9999",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.invoices).toHaveLength(0);
    expect(payload.warning).toBeUndefined();
    // Only the InvoiceQueryRq fires; no CustomerQueryRq when invoices is empty.
    const customerCalls = spy.mock.calls.filter((c) => c[0] === "Customer");
    expect(customerCalls).toHaveLength(0);

    spy.mockRestore();
  });

  it("skips invoices whose CustomerRef cannot be resolved (customer deleted)", async () => {
    const session = freshSession();
    await session.openSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const list = handlers.get("qb_invoice_list")!;

    // Post an invoice with a CustomerRef that points to a non-existent
    // ListID + FullName. The join finds no match → leave invoice unchanged.
    await session.addEntity("Invoice", {
      CustomerRef: { ListID: "PHANTOM-9999", FullName: "Phantom Customer" },
      TxnDate: "2026-04-15",
      RefNumber: "INV-PH",
      InvoiceLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 1 },
      ],
    });

    const result = await list({
      includeCustomerContact: true,
      refNumber: "INV-PH",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.invoices).toHaveLength(1);
    expect(payload.invoices[0].customerContact).toBeUndefined();
    // The CustomerQueryRq ran but matched nothing — that's not a warning,
    // it's a join miss. Real production case: a customer was deleted but
    // the invoice still references the old ListID.
    expect(payload.warning).toBeUndefined();
  });
});
