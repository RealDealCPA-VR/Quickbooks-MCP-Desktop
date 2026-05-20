// Phase 14 #64 — dry-run mode.
//
// Coverage layers:
//   1. Sim store snapshot/restore — the low-level primitive that makes
//      dry-run side-effect-free. Deep-clones nested Maps and entities so a
//      post-snapshot mutation (e.g. Customer.Balance increment on Invoice
//      add) doesn't leak through restore. Preserves idCounter and seed
//      iteration order.
//   2. Manager dry-run primitives — addEntityDryRun /
//      modifyEntityDryRun / deleteEntityDryRun / executeBatchAddDryRun /
//      updateClearedStatusDryRun in sim mode: snapshot → operation →
//      restore. Sim store rejections are caught and surfaced as
//      wouldSucceed: false. The doomed-entity invariant (3120 unknown
//      parent) and the idCounter-unchanged invariant pin that dry-run
//      truly leaves no trace.
//   3. Read-only × dry-run composition — ALLOW. Dry-run methods do not
//      call assertWritable; a read-only session can dry-run-add/modify/
//      delete and gets a preview.
//   4. Idempotency × dry-run composition — PEEK + surface conflict, never
//      write to cache. Same-key + same-fingerprint reports wouldReplay:
//      true with the cached entity. Same-key + different-fingerprint
//      reports statusCode 9002. The cache is NOT populated by dry-run.
//   5. Live-mode preview (option b) — committed: false, previewSupported:
//      false, qbxmlEnvelope built, note set. No entity preview (the sim
//      oracle doesn't mirror real QB). Idempotency PEEK still runs
//      (cache is per-process, no wire I/O needed).
//   6. Tool surface — qb_customer_add / qb_invoice_create /
//      qb_invoice_delete with dryRun: true return dryRun-shaped payloads
//      and leave the store unchanged.

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { SimulationStore } from "../src/session/simulation-store.js";
import { registerCustomerTools } from "../src/tools/customers.js";
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
    appName: "vitest-dry-run",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

beforeEach(() => {
  handlers.clear();
});

// ---------------------------------------------------------------------------
// Layer 1 — SimulationStore.snapshot() / restore()
// ---------------------------------------------------------------------------

describe("SimulationStore — snapshot / restore", () => {
  it("snapshot is a deep clone — post-snapshot entity mutation does not leak through restore", () => {
    const store = new SimulationStore();
    const req =
      '<?xml version="1.0"?><QBXML><QBXMLMsgsRq onError="stopOnError">' +
      "<CustomerAddRq><CustomerAdd><Name>SnapTest A</Name></CustomerAdd></CustomerAddRq>" +
      "</QBXMLMsgsRq></QBXML>";
    store.processRequest(req);
    const snap = store.snapshot();

    // Mutate after the snapshot — add another Customer.
    store.processRequest(
      '<?xml version="1.0"?><QBXML><QBXMLMsgsRq onError="stopOnError">' +
      "<CustomerAddRq><CustomerAdd><Name>SnapTest B</Name></CustomerAdd></CustomerAddRq>" +
      "</QBXMLMsgsRq></QBXML>",
    );
    // After restore, the post-snapshot Customer should be gone.
    store.restore(snap);

    const queryReq =
      '<?xml version="1.0"?><QBXML><QBXMLMsgsRq onError="stopOnError">' +
      "<CustomerQueryRq></CustomerQueryRq>" +
      "</QBXMLMsgsRq></QBXML>";
    const resp = store.processRequest(queryReq);
    const data = resp.responses[0].data as Record<string, unknown>;
    const rets = Array.isArray(data.CustomerRet) ? data.CustomerRet : [data.CustomerRet];
    const names = rets.map((c) => (c as { Name: string }).Name);
    expect(names).toContain("SnapTest A");
    expect(names).not.toContain("SnapTest B");
  });

  it("snapshot deep-clones nested entity fields — Customer.Balance reverts after restore", async () => {
    const session = freshSession();
    await session.openSession();
    const customer = await session.addEntity("Customer", { Name: "Snap Balance Customer" });
    const beforeBalance = Number(customer.Balance ?? 0);

    // Use the store directly via the manager's internal — easier to grab via
    // a fresh sim store mirroring the same path. We test through the manager's
    // dry-run primitive in Layer 2; this test pins the cloning primitive.
    const sim = new SimulationStore();
    sim.processRequest(
      '<?xml version="1.0"?><QBXML><QBXMLMsgsRq onError="stopOnError">' +
      "<CustomerAddRq><CustomerAdd><Name>BalanceTest</Name></CustomerAdd></CustomerAddRq>" +
      "</QBXMLMsgsRq></QBXML>",
    );
    const snap = sim.snapshot();

    // Find the customer's ListID by querying.
    const findCust = (s: SimulationStore) => {
      const r = s.processRequest(
        '<?xml version="1.0"?><QBXML><QBXMLMsgsRq onError="stopOnError">' +
        "<CustomerQueryRq></CustomerQueryRq>" +
        "</QBXMLMsgsRq></QBXML>",
      );
      const d = r.responses[0].data as Record<string, unknown>;
      const arr = Array.isArray(d.CustomerRet) ? d.CustomerRet : [d.CustomerRet];
      return arr.find((c) => (c as { Name: string }).Name === "BalanceTest") as
        | Record<string, unknown>
        | undefined;
    };
    const c1 = findCust(sim)!;
    const listId = String(c1.ListID);
    const balBefore = Number(c1.Balance ?? 0);

    // Post an invoice against that customer (triggers handleAdd's Customer
    // balance side effect).
    sim.processRequest(
      '<?xml version="1.0"?><QBXML><QBXMLMsgsRq onError="stopOnError">' +
      "<InvoiceAddRq><InvoiceAdd>" +
      `<CustomerRef><ListID>${listId}</ListID></CustomerRef>` +
      "<InvoiceLineAdd><Desc>Service</Desc><Amount>123.45</Amount></InvoiceLineAdd>" +
      "</InvoiceAdd></InvoiceAddRq>" +
      "</QBXMLMsgsRq></QBXML>",
    );
    const c2 = findCust(sim)!;
    // Mutation actually happened
    expect(Number(c2.Balance ?? 0)).toBeGreaterThan(balBefore);

    // Restore — Customer.Balance must roll back.
    sim.restore(snap);
    const c3 = findCust(sim)!;
    expect(Number(c3.Balance ?? 0)).toBe(balBefore);

    // Reference customer's balance for sanity (unrelated to this assertion).
    expect(beforeBalance).toBeGreaterThanOrEqual(0);
  });

  it("idCounter is preserved by snapshot/restore", () => {
    // ListID format is `${idCounter}-${base36 timestamp}`. Parse the counter
    // off the leading numeric portion before the dash.
    const counterOf = (id: string): number => Number(id.split("-")[0]);

    const sim = new SimulationStore();
    const addAndGet = (name: string): number => {
      const r = sim.processRequest(
        '<?xml version="1.0"?><QBXML><QBXMLMsgsRq onError="stopOnError">' +
        `<CustomerAddRq><CustomerAdd><Name>${name}</Name></CustomerAdd></CustomerAddRq>` +
        "</QBXMLMsgsRq></QBXML>",
      );
      const d = r.responses[0].data as Record<string, unknown>;
      const ret = (Array.isArray(d.CustomerRet) ? d.CustomerRet[0] : d.CustomerRet) as
        Record<string, unknown>;
      return counterOf(String(ret.ListID));
    };

    const baseline = addAndGet("CounterPre");
    const snap = sim.snapshot();
    // Burn the counter — 3 adds advance the counter by 6 (each add ticks
    // twice: ListID + EditSequence).
    addAndGet("Burn0");
    addAndGet("Burn1");
    addAndGet("Burn2");
    sim.restore(snap);
    // Post-restore add should reuse the snapshot's counter — the next
    // ListID counter is baseline + 2 (the next ListID after the
    // snapshot's own counter+EditSequence ticks).
    const restored = addAndGet("CounterCheck");
    expect(restored).toBe(baseline + 2);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — manager: addEntityDryRun (sim mode happy + sad)
// ---------------------------------------------------------------------------

describe("addEntityDryRun — sim mode preview", () => {
  it("happy path: wouldSucceed:true + entity + envelope; store unchanged", async () => {
    const session = freshSession();
    await session.openSession();
    const before = (await session.queryEntity("Customer", {})).length;

    const preview = await session.addEntityDryRun("Customer", {
      Name: "DryRun A",
      Phone: "555-9000",
    });
    expect(preview.committed).toBe(false);
    expect(preview.mode).toBe("simulation");
    expect(preview.previewSupported).toBe(true);
    expect(preview.wouldSucceed).toBe(true);
    expect(preview.entity).toBeDefined();
    expect((preview.entity as { Name: string }).Name).toBe("DryRun A");
    expect(preview.qbxmlEnvelope).toContain("CustomerAddRq");
    expect(preview.qbxmlEnvelope).toContain("DryRun A");

    // Store unchanged — the customer was never persisted.
    const after = (await session.queryEntity("Customer", {})).length;
    expect(after).toBe(before);
    const matches = (await session.queryEntity("Customer", {})).filter(
      (c) => (c as { Name: string }).Name === "DryRun A",
    );
    expect(matches.length).toBe(0);
  });

  it("sad path (3120 unknown parent): wouldSucceed:false with statusCode 3120, store still unchanged", async () => {
    const session = freshSession();
    await session.openSession();
    const before = (await session.queryEntity("Customer", {})).length;

    const preview = await session.addEntityDryRun("Customer", {
      Name: "OrphanedChild",
      ParentRef: { ListID: "NOPE-NO-SUCH-PARENT" },
    });
    expect(preview.wouldSucceed).toBe(false);
    expect(preview.statusCode).toBe(3120);
    expect(preview.statusMessage).toMatch(/cannot be found/i);
    expect(preview.entity).toBeUndefined();

    // Doomed-entity invariant: the rejected entity must NOT be in the store
    // post-restore.
    const after = (await session.queryEntity("Customer", {})).length;
    expect(after).toBe(before);
    const orphans = (await session.queryEntity("Customer", {})).filter(
      (c) => (c as { Name: string }).Name === "OrphanedChild",
    );
    expect(orphans.length).toBe(0);
  });

  it("does not increment idCounter — a follow-up real add gets the next-in-line ID", async () => {
    const session = freshSession();
    await session.openSession();
    // ListID format: `${idCounter}-${base36 timestamp}`. Parse the counter.
    const counterOf = (id: unknown): number => Number(String(id).split("-")[0]);

    const baseline = await session.addEntity("Customer", { Name: "Baseline" });
    // Do 5 dry-runs — if they burned counter, each would advance it by 2.
    for (let i = 0; i < 5; i++) {
      await session.addEntityDryRun("Customer", { Name: `Throwaway${i}` });
    }
    const real = await session.addEntity("Customer", { Name: "PostDryRunReal" });
    // Each real add ticks the counter by 2 (ListID + EditSequence). So
    // back-to-back real adds with no dry-runs in between would tick by 2.
    expect(counterOf(real.ListID) - counterOf(baseline.ListID)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — manager: modifyEntityDryRun, deleteEntityDryRun
// ---------------------------------------------------------------------------

describe("modifyEntityDryRun / deleteEntityDryRun — sim mode preview", () => {
  it("modifyEntityDryRun: previews change, store unchanged after", async () => {
    const session = freshSession();
    await session.openSession();
    const cust = await session.addEntity("Customer", { Name: "ModDryRun A", Phone: "111-1111" });

    const preview = await session.modifyEntityDryRun("Customer", {
      ListID: cust.ListID,
      EditSequence: cust.EditSequence,
      Phone: "222-2222",
    });
    expect(preview.wouldSucceed).toBe(true);
    expect((preview.entity as { Phone: string }).Phone).toBe("222-2222");

    // Re-query — phone should still be the original.
    const all = await session.queryEntity("Customer", {});
    const found = all.find((c) => (c as { ListID: string }).ListID === cust.ListID) as
      | Record<string, unknown>
      | undefined;
    expect(found?.Phone).toBe("111-1111");
  });

  it("deleteEntityDryRun: previews deletion, entity still queryable after", async () => {
    const session = freshSession();
    await session.openSession();
    const cust = await session.addEntity("Customer", { Name: "DelDryRun A" });

    const preview = await session.deleteEntityDryRun("Customer", String(cust.ListID));
    expect(preview.wouldSucceed).toBe(true);
    expect(preview.entity).toBeDefined();

    // Customer still in store post-dry-run.
    const all = await session.queryEntity("Customer", {});
    const found = all.find((c) => (c as { ListID: string }).ListID === cust.ListID);
    expect(found).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — read-only × dry-run composition (ALLOW)
// ---------------------------------------------------------------------------

describe("dry-run × read-only composition (ALLOW)", () => {
  it("addEntityDryRun on a read-only session returns a preview (not blocked by 9001)", async () => {
    const session = freshSession();
    await session.openSession();
    session.setReadOnly(true);

    const preview = await session.addEntityDryRun("Customer", { Name: "ReadOnlyDryRun" });
    expect(preview.wouldSucceed).toBe(true);
    expect((preview.entity as { Name: string }).Name).toBe("ReadOnlyDryRun");

    // Confirm a real call IS still blocked.
    await expect(session.addEntity("Customer", { Name: "BlockedByReadOnly" })).rejects.toThrow(
      /Read-only session/,
    );
  });

  it("modifyEntityDryRun + deleteEntityDryRun on a read-only session also work", async () => {
    const session = freshSession();
    await session.openSession();
    // Set up an entity while still writable.
    const cust = await session.addEntity("Customer", { Name: "ROModTarget" });
    session.setReadOnly(true);

    const modPrev = await session.modifyEntityDryRun("Customer", {
      ListID: cust.ListID,
      EditSequence: cust.EditSequence,
      Phone: "555-0000",
    });
    expect(modPrev.wouldSucceed).toBe(true);

    const delPrev = await session.deleteEntityDryRun("Customer", String(cust.ListID));
    expect(delPrev.wouldSucceed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — idempotency × dry-run composition (PEEK + surface conflict)
// ---------------------------------------------------------------------------

describe("dry-run × idempotency composition (PEEK)", () => {
  it("dry-run with new key (miss): runs preview, does NOT write to cache", async () => {
    const session = freshSession();
    await session.openSession();
    const sizeBefore = session.idempotencyCacheSize();
    const preview = await session.addEntityDryRun(
      "Customer",
      { Name: "DryRunNewKey" },
      "dr-key-1",
    );
    expect(preview.wouldSucceed).toBe(true);
    expect(preview.wouldReplay).toBeUndefined();
    expect(session.idempotencyCacheSize()).toBe(sizeBefore);

    // A subsequent REAL call with the same key + same payload should NOT
    // report idempotentReplay (cache was never populated by the dry-run).
    const real = await session.addEntityIdempotent(
      "Customer",
      { Name: "DryRunNewKey" },
      "dr-key-1",
    );
    expect(real.replayed).toBe(false);
  });

  it("dry-run with hit + same fingerprint: wouldReplay:true, returns cached entity, NO sim call", async () => {
    const session = freshSession();
    await session.openSession();
    // Populate cache via a real call.
    const real = await session.addEntityIdempotent(
      "Customer",
      { Name: "DryRunCached", Phone: "555-2222" },
      "dr-key-2",
    );
    const sizeBefore = session.idempotencyCacheSize();
    const before = (await session.queryEntity("Customer", {})).length;

    const preview = await session.addEntityDryRun(
      "Customer",
      { Name: "DryRunCached", Phone: "555-2222" },
      "dr-key-2",
    );
    expect(preview.wouldReplay).toBe(true);
    expect(preview.wouldSucceed).toBe(true);
    expect((preview.entity as { ListID: string }).ListID).toBe(real.entity.ListID);

    // Cache size unchanged, store unchanged.
    expect(session.idempotencyCacheSize()).toBe(sizeBefore);
    expect((await session.queryEntity("Customer", {})).length).toBe(before);
  });

  it("dry-run with hit + different fingerprint: wouldSucceed:false + statusCode 9002, does NOT throw", async () => {
    const session = freshSession();
    await session.openSession();
    await session.addEntityIdempotent(
      "Customer",
      { Name: "ConflictOriginal" },
      "dr-key-3",
    );
    const sizeBefore = session.idempotencyCacheSize();

    const preview = await session.addEntityDryRun(
      "Customer",
      { Name: "ConflictDifferent" },
      "dr-key-3",
    );
    expect(preview.wouldSucceed).toBe(false);
    expect(preview.statusCode).toBe(9002);
    expect(preview.statusMessage).toMatch(/Idempotency key conflict/i);
    expect(preview.entity).toBeUndefined();
    // Cache untouched.
    expect(session.idempotencyCacheSize()).toBe(sizeBefore);
  });
});

// ---------------------------------------------------------------------------
// Layer 5 — live-mode preview (option b)
// ---------------------------------------------------------------------------

describe("dry-run in live mode (option b)", () => {
  // Force live mode by flipping the internal flag — the test never touches
  // a real winax connection because the dry-run path returns BEFORE
  // sendRequest is called in live mode (envelope-only).
  function liveSession(): QBSessionManager {
    const s = freshSession();
    (s as unknown as { simulationMode: boolean }).simulationMode = false;
    // Stub session so dry-run doesn't try openSession.
    (s as unknown as { session: { ticket: string; companyFile: string; openedAt: Date } }).session = {
      ticket: "LIVE-STUB",
      companyFile: "stub.qbw",
      openedAt: new Date(),
    };
    return s;
  }

  it("live-mode addEntityDryRun returns envelope only — previewSupported:false, note set", async () => {
    const session = liveSession();
    const preview = await session.addEntityDryRun("Customer", { Name: "LiveDryRun" });
    expect(preview.committed).toBe(false);
    expect(preview.mode).toBe("live");
    expect(preview.previewSupported).toBe(false);
    expect(preview.wouldSucceed).toBeUndefined();
    expect(preview.entity).toBeUndefined();
    expect(preview.note).toMatch(/Live preview unavailable/i);
    expect(preview.qbxmlEnvelope).toContain("CustomerAddRq");
    expect(preview.qbxmlEnvelope).toContain("LiveDryRun");
  });

  it("live-mode dry-run + idempotency hit: wouldReplay still reported (cache is per-process)", async () => {
    // Cache is per-process, not per-mode. Populate in sim mode then flip.
    const session = freshSession();
    await session.openSession();
    const real = await session.addEntityIdempotent(
      "Customer",
      { Name: "LiveReplayer" },
      "dr-key-live",
    );
    (session as unknown as { simulationMode: boolean }).simulationMode = false;

    const preview = await session.addEntityDryRun(
      "Customer",
      { Name: "LiveReplayer" },
      "dr-key-live",
    );
    expect(preview.mode).toBe("live");
    expect(preview.previewSupported).toBe(false);
    expect(preview.wouldReplay).toBe(true);
    expect((preview.entity as { ListID: string }).ListID).toBe(real.entity.ListID);
  });
});

// ---------------------------------------------------------------------------
// Layer 6 — tool surface (qb_customer_add, qb_invoice_create, qb_invoice_delete)
// ---------------------------------------------------------------------------

describe("tool surface: dryRun: true on pilot tools", () => {
  it("qb_customer_add with dryRun returns dryRun envelope; customer NOT persisted", async () => {
    const session = freshSession();
    await session.openSession();
    registerCustomerTools(fakeServer as never, () => session);

    const before = (await session.queryEntity("Customer", {})).length;
    const result = await handlers.get("qb_customer_add")!({
      name: "ToolDryRun A",
      phone: "555-7777",
      dryRun: true,
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.dryRun).toBe(true);
    expect(payload.committed).toBe(false);
    expect(payload.previewSupported).toBe(true);
    expect(payload.wouldSucceed).toBe(true);
    expect(payload.customer.Name).toBe("ToolDryRun A");
    expect(payload.qbxmlEnvelope).toContain("CustomerAddRq");

    // No new customer in store.
    expect((await session.queryEntity("Customer", {})).length).toBe(before);
  });

  it("qb_invoice_create with dryRun previews entity-after; no invoice posted", async () => {
    const session = freshSession();
    await session.openSession();
    const cust = await session.addEntity("Customer", { Name: "InvDryRunTarget" });
    registerInvoiceTools(fakeServer as never, () => session);

    const before = (await session.queryEntity("Invoice", {})).length;
    const result = await handlers.get("qb_invoice_create")!({
      customerListId: cust.ListID,
      lines: [{ description: "Test line", amount: 100 }],
      dryRun: true,
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.dryRun).toBe(true);
    expect(payload.wouldSucceed).toBe(true);
    expect(payload.invoice).toBeDefined();
    expect(payload.qbxmlEnvelope).toContain("InvoiceAddRq");

    // No new invoice committed.
    expect((await session.queryEntity("Invoice", {})).length).toBe(before);
  });

  it("qb_invoice_delete with dryRun previews deletion; invoice still queryable", async () => {
    const session = freshSession();
    await session.openSession();
    const cust = await session.addEntity("Customer", { Name: "DelTarget" });
    const inv = await session.addEntity("Invoice", {
      CustomerRef: { ListID: cust.ListID },
      InvoiceLineAdd: [{ Desc: "Item", Amount: 50 }],
    });
    registerInvoiceTools(fakeServer as never, () => session);

    const result = await handlers.get("qb_invoice_delete")!({
      txnId: inv.TxnID,
      dryRun: true,
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.dryRun).toBe(true);
    expect(payload.wouldSucceed).toBe(true);
    expect(payload.deleted).toBeDefined();

    // Invoice still in store.
    const all = await session.queryEntity("Invoice", {});
    const found = all.find((i) => (i as { TxnID: string }).TxnID === inv.TxnID);
    expect(found).toBeDefined();
  });

  it("qb_customer_add with dryRun + idempotency hit reports wouldReplay (no preview run)", async () => {
    const session = freshSession();
    await session.openSession();
    registerCustomerTools(fakeServer as never, () => session);

    // Populate cache via the real handler.
    await handlers.get("qb_customer_add")!({
      name: "ToolReplayer",
      idempotencyKey: "tool-key-1",
    });
    const sizeBefore = session.idempotencyCacheSize();

    const result = await handlers.get("qb_customer_add")!({
      name: "ToolReplayer",
      idempotencyKey: "tool-key-1",
      dryRun: true,
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.dryRun).toBe(true);
    expect(payload.wouldReplay).toBe(true);
    expect(payload.wouldSucceed).toBe(true);
    expect(payload.customer).toBeDefined();
    // Cache size unchanged
    expect(session.idempotencyCacheSize()).toBe(sizeBefore);
  });

  it("qb_customer_add with dryRun + idempotency conflict surfaces 9002 in the dryRun shape", async () => {
    const session = freshSession();
    await session.openSession();
    registerCustomerTools(fakeServer as never, () => session);

    await handlers.get("qb_customer_add")!({
      name: "ConflictOriginal",
      idempotencyKey: "tool-key-2",
    });
    const result = await handlers.get("qb_customer_add")!({
      name: "ConflictDifferent",
      idempotencyKey: "tool-key-2",
      dryRun: true,
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.dryRun).toBe(true);
    expect(payload.wouldSucceed).toBe(false);
    expect(payload.statusCode).toBe(9002);
    expect(payload.statusMessage).toMatch(/Idempotency key conflict/i);
    expect(payload.customer).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Layer 2b — executeBatchAddDryRun + updateClearedStatusDryRun
// ---------------------------------------------------------------------------

describe("executeBatchAddDryRun — sim mode batch preview", () => {
  it("happy batch (all entries valid): wouldSucceed:true, results all posted, store unchanged", async () => {
    const session = freshSession();
    await session.openSession();
    const cust = await session.addEntity("Customer", { Name: "BatchDryTarget" });
    const before = (await session.queryEntity("Invoice", {})).length;

    const preview = await session.executeBatchAddDryRun("Invoice", [
      {
        CustomerRef: { ListID: cust.ListID },
        InvoiceLineAdd: [{ Desc: "A", Amount: 10 }],
      },
      {
        CustomerRef: { ListID: cust.ListID },
        InvoiceLineAdd: [{ Desc: "B", Amount: 20 }],
      },
    ]);
    expect(preview.wouldSucceed).toBe(true);
    expect(preview.results).toHaveLength(2);
    expect(preview.results!.every((r) => r.status === "posted")).toBe(true);

    expect((await session.queryEntity("Invoice", {})).length).toBe(before);
  });

  it("empty entries: returns trivial wouldSucceed:true with no envelope", async () => {
    const session = freshSession();
    await session.openSession();
    const preview = await session.executeBatchAddDryRun("Invoice", []);
    expect(preview.wouldSucceed).toBe(true);
    expect(preview.results).toEqual([]);
  });
});

describe("updateClearedStatusDryRun", () => {
  it("happy path: returns wouldSucceed:true; cleared status NOT actually persisted", async () => {
    const session = freshSession();
    await session.openSession();
    // Find a bank-affecting transaction. Sim store seeds a few; pick by querying Checks.
    const checks = await session.queryEntity("Check", {});
    if (checks.length === 0) {
      // Bail — the sim store has no seed Check (shouldn't happen, but
      // bail-skip if so).
      return;
    }
    const check = checks[0] as Record<string, unknown>;
    const beforeStatus = check.ClearedStatus;

    const preview = await session.updateClearedStatusDryRun({
      txnId: String(check.TxnID),
      clearedStatus: "Cleared",
    });
    expect(preview.wouldSucceed).toBe(true);
    expect(preview.previewSupported).toBe(true);

    // Re-query — the original ClearedStatus should be unchanged.
    const reQuery = (await session.queryEntity("Check", {})).find(
      (c) => (c as { TxnID: string }).TxnID === check.TxnID,
    ) as Record<string, unknown> | undefined;
    expect(reQuery?.ClearedStatus).toBe(beforeStatus);
  });
});
