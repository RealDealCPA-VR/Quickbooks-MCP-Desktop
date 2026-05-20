// Iterator (Item 27) — IteratorID / IteratorRemainingCount support across all
// 5 layers (types, builder, parser, manager, simulation store) plus the four
// tools opted into pagination (Customer / Invoice / Bill / Item).
//
// Ported from scripts/verify-item27-iterator.mjs. The .mjs harness imports
// from dist/ to verify the built output; this Vitest port imports from src/
// to verify the source tree directly. Both must pass — they're complementary,
// not redundant.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import {
  buildQueryRequest,
} from "../src/qbxml/builder.js";
import { parseQBXMLResponse } from "../src/qbxml/parser.js";
import { registerCustomerTools } from "../src/tools/customers.js";
import { registerInvoiceTools } from "../src/tools/invoices.js";
import { registerBillTools } from "../src/tools/bills.js";
import { registerItemTools } from "../src/tools/items.js";
import { registerVendorTools } from "../src/tools/vendors.js";
import { registerAccountTools } from "../src/tools/accounts.js";
import { registerEmployeeTools } from "../src/tools/employees.js";

// fakeServer mirrors the SDK's `server.tool(name, desc, schema, handler)`
// surface so we can capture handlers + schemas without spinning up an MCP
// transport. Same shape used by the .mjs harnesses — kept consistent so a
// single mental model applies to both.
type Handler = (args: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
const handlers = new Map<string, Handler>();
const schemas = new Map<string, Record<string, z.ZodTypeAny>>();
const fakeServer = {
  tool: (name: string, _description: string, schema: Record<string, z.ZodTypeAny>, handler: Handler) => {
    handlers.set(name, handler);
    schemas.set(name, schema);
  },
};

let session: QBSessionManager;

beforeAll(async () => {
  session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-iterator",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  const getSession = () => session;
  registerCustomerTools(fakeServer as never, getSession);
  registerInvoiceTools(fakeServer as never, getSession);
  registerBillTools(fakeServer as never, getSession);
  registerItemTools(fakeServer as never, getSession);
  registerVendorTools(fakeServer as never, getSession);
  registerAccountTools(fakeServer as never, getSession);
  registerEmployeeTools(fakeServer as never, getSession);
  await session.openSession();
});

// callTool runs the captured handler through the tool's zod schema first
// (matching what the MCP SDK does on the live wire). Without this the test
// would skip schema validation and miss the regex sweep covered elsewhere.
const callTool = async (toolName: string, args: Record<string, unknown>) => {
  const schema = schemas.get(toolName);
  const handler = handlers.get(toolName);
  if (!schema || !handler) throw new Error(`Tool not registered: ${toolName}`);
  const parsed = z.object(schema).safeParse(args);
  if (!parsed.success) return { schemaError: parsed.error };
  const result = await handler(parsed.data);
  const payload = JSON.parse(result.content[0].text);
  return { result, payload };
};

describe("Layer 1 — builder serializes iterator options as XML attributes", () => {
  it("iterator='Start' emits as XML attribute on *QueryRq", () => {
    const xml = buildQueryRequest("Customer", {}, { iterator: "Start" });
    expect(xml).toContain('<CustomerQueryRq requestID="1" iterator="Start">');
    expect(xml).not.toContain("<iterator>");
  });

  it("iterator='Continue' + iteratorID emit as paired attributes", () => {
    const xml = buildQueryRequest("Customer", {}, {
      iterator: "Continue",
      iteratorID: "{abc-123}",
    });
    expect(xml).toContain(
      '<CustomerQueryRq requestID="1" iterator="Continue" iteratorID="{abc-123}">'
    );
  });

  it("iterator='Stop' + iteratorID round-trip", () => {
    const xml = buildQueryRequest("Customer", {}, { iterator: "Stop", iteratorID: "{abc}" });
    expect(xml).toContain('iterator="Stop"');
    expect(xml).toContain('iteratorID="{abc}"');
  });

  it("no iterator option → no iterator attributes (regression)", () => {
    const xml = buildQueryRequest("Customer", { ActiveStatus: "ActiveOnly" });
    expect(xml).toContain('<CustomerQueryRq requestID="1">');
    expect(xml).not.toContain("iterator=");
    expect(xml).toContain("<ActiveStatus>ActiveOnly</ActiveStatus>");
  });

  it("iteratorID is xml-escaped (defensive — opaque-string contract)", () => {
    const xml = buildQueryRequest("Customer", {}, {
      iterator: "Continue",
      iteratorID: 'a"b<c',
    });
    expect(xml).toContain('iteratorID="a&quot;b&lt;c"');
  });

  it("iterator + filter children coexist (attrs alongside requestID, body untouched)", () => {
    const xml = buildQueryRequest("Invoice", {
      PaidStatus: "NotPaidOnly",
      MaxReturned: 500,
    }, { iterator: "Start" });
    expect(xml).toContain('iterator="Start"');
    expect(xml).toContain("<PaidStatus>NotPaidOnly</PaidStatus>");
    expect(xml).toContain("<MaxReturned>500</MaxReturned>");
  });
});

describe("Layer 2 — parser surfaces iteratorRemainingCount + iteratorID", () => {
  it("surfaces iteratorRemainingCount (237) + iteratorID from envelope", () => {
    const xml = `<?xml version="1.0" ?>
<QBXML>
  <QBXMLMsgsRs>
    <CustomerQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="Status OK" iteratorRemainingCount="237" iteratorID="{abc-def-123}">
      <CustomerRet><ListID>1</ListID><Name>Acme</Name></CustomerRet>
    </CustomerQueryRs>
  </QBXMLMsgsRs>
</QBXML>`;
    const parsed = parseQBXMLResponse(xml);
    const rs = parsed.responses[0];
    expect(rs.iteratorRemainingCount).toBe(237);
    expect(rs.iteratorID).toBe("{abc-def-123}");
    expect(rs.statusCode).toBe(0);
  });

  it("iteratorRemainingCount=0 (exhausted) round-trips — !== undefined gate is load-bearing", () => {
    // Number(0) is falsy, so a `if (count)` gate would silently drop the
    // exhausted signal. The parser must use `!== undefined`. Regression
    // failure here = we're back to the silent-drop bug.
    const xml = `<?xml version="1.0" ?>
<QBXML>
  <QBXMLMsgsRs>
    <CustomerQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="OK" iteratorRemainingCount="0" iteratorID="{end}">
      <CustomerRet><ListID>1</ListID><Name>Acme</Name></CustomerRet>
    </CustomerQueryRs>
  </QBXMLMsgsRs>
</QBXML>`;
    const parsed = parseQBXMLResponse(xml);
    const rs = parsed.responses[0];
    expect(rs.iteratorRemainingCount).toBe(0);
    expect(rs.iteratorID).toBe("{end}");
  });

  it("response without iterator attrs has no iterator fields (regression)", () => {
    const xml = `<?xml version="1.0" ?>
<QBXML>
  <QBXMLMsgsRs>
    <CustomerQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="Status OK">
      <CustomerRet><ListID>1</ListID><Name>Acme</Name></CustomerRet>
    </CustomerQueryRs>
  </QBXMLMsgsRs>
</QBXML>`;
    const parsed = parseQBXMLResponse(xml);
    const rs = parsed.responses[0];
    expect("iteratorRemainingCount" in rs).toBe(false);
    expect("iteratorID" in rs).toBe(false);
  });
});

describe("Layer 3 — manager.queryEntityPaginated round-trips through simulation", () => {
  it("queryEntityPaginated('Customer', Start) returns entities + iter metadata", async () => {
    const result = await session.queryEntityPaginated("Customer", {}, { iterator: "Start" });
    expect(Array.isArray(result.entities)).toBe(true);
    expect(result.entities.length).toBeGreaterThanOrEqual(1);
    expect(result.iteratorRemainingCount).toBe(0);
    expect(typeof result.iteratorID).toBe("string");
    expect(result.iteratorID?.startsWith("SIM-ITER-")).toBe(true);
  });

  it("queryEntityPaginated Continue returns empty + no iter metadata (sim contract)", async () => {
    // Sim does not maintain iterator state across requests — Continue is
    // treated as exhausted. Real QB would page; this is the documented
    // simpler-strategy.
    const result = await session.queryEntityPaginated("Customer", {}, {
      iterator: "Continue",
      iteratorID: "SIM-ITER-anything",
    });
    expect(result.entities.length).toBe(0);
    expect(result.iteratorRemainingCount).toBeUndefined();
    expect(result.iteratorID).toBeUndefined();
  });

  it("queryEntity (legacy) is unchanged — caller can't tell pagination exists", async () => {
    const customers = await session.queryEntity("Customer");
    expect(Array.isArray(customers)).toBe(true);
    expect(customers.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Layer 4 — simulation iterator-mode behavior on edge cases", () => {
  it("Start on empty store returns iter metadata (empty iterator, real-QB-shaped)", async () => {
    const result = await session.queryEntityPaginated("Bill", {}, { iterator: "Start" });
    expect(result.entities.length).toBe(0);
    expect(result.iteratorRemainingCount).toBe(0);
    expect(typeof result.iteratorID).toBe("string");
    expect(result.iteratorID?.startsWith("SIM-ITER-")).toBe(true);
  });
});

describe("Layer 5 — tool surface threads paginate flag end-to-end", () => {
  it("qb_customer_list paginate:true returns iter fields", async () => {
    const { payload } = await callTool("qb_customer_list", { paginate: true });
    expect(Array.isArray(payload.customers)).toBe(true);
    expect(payload.count).toBeGreaterThanOrEqual(1);
    expect(payload.iteratorRemainingCount).toBe(0);
    expect(typeof payload.iteratorID).toBe("string");
  });

  it("qb_customer_list default (no paginate) has no iter fields (regression)", async () => {
    const { payload } = await callTool("qb_customer_list", {});
    expect(Array.isArray(payload.customers)).toBe(true);
    expect(payload.count).toBeGreaterThanOrEqual(1);
    expect("iteratorRemainingCount" in payload).toBe(false);
    expect("iteratorID" in payload).toBe(false);
  });

  it("qb_customer_list iteratorID alone implies paginate; Continue returns empty", async () => {
    // Passing iteratorID without paginate:true still triggers pagination —
    // iteratorID implies the caller is mid-pagination. Continue → exhausted
    // iterator → 0 results, no iter metadata.
    const { payload } = await callTool("qb_customer_list", { iteratorID: "SIM-ITER-foo" });
    expect(payload.count).toBe(0);
    expect("iteratorRemainingCount" in payload).toBe(false);
    expect("iteratorID" in payload).toBe(false);
  });

  it("qb_invoice_list paginate:true returns iter fields", async () => {
    const { payload } = await callTool("qb_invoice_list", { paginate: true });
    expect(Array.isArray(payload.invoices)).toBe(true);
    expect(payload.iteratorRemainingCount).toBe(0);
    expect(typeof payload.iteratorID).toBe("string");
  });

  it("qb_invoice_list default has no iter fields (regression)", async () => {
    const { payload } = await callTool("qb_invoice_list", {});
    expect(Array.isArray(payload.invoices)).toBe(true);
    expect("iteratorRemainingCount" in payload).toBe(false);
    expect("iteratorID" in payload).toBe(false);
  });

  it("qb_bill_list paginate:true returns iter fields (empty store)", async () => {
    const { payload } = await callTool("qb_bill_list", { paginate: true });
    expect(Array.isArray(payload.bills)).toBe(true);
    expect(payload.iteratorRemainingCount).toBe(0);
    expect(typeof payload.iteratorID).toBe("string");
  });

  it("qb_bill_list default has no iter fields (regression)", async () => {
    const { payload } = await callTool("qb_bill_list", {});
    expect(Array.isArray(payload.bills)).toBe(true);
    expect("iteratorRemainingCount" in payload).toBe(false);
    expect("iteratorID" in payload).toBe(false);
  });

  it("qb_item_list paginate:true with itemType returns iter fields", async () => {
    const { payload } = await callTool("qb_item_list", { paginate: true, itemType: "Service" });
    expect(Array.isArray(payload.items)).toBe(true);
    expect(payload.iteratorRemainingCount).toBe(0);
    expect(typeof payload.iteratorID).toBe("string");
  });

  it("qb_item_list paginate:true without itemType refuses with structured error", async () => {
    // Iterators are scoped to a single *QueryRq — multi-subtype fan-out
    // can't paginate. Pre-flight refusal at the handler layer with
    // { success: false, error: "..." } shape (NOT canonical Item 25
    // shape, intentional — see HANDOFF.md context note).
    const { payload, result } = await callTool("qb_item_list", { paginate: true });
    expect(result?.isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(typeof payload.error).toBe("string");
    expect(payload.error).toContain("itemType");
  });

  it("qb_item_list itemType-only (no paginate) has no iter fields (regression)", async () => {
    const { payload } = await callTool("qb_item_list", { itemType: "Service" });
    expect(Array.isArray(payload.items)).toBe(true);
    expect("iteratorRemainingCount" in payload).toBe(false);
    expect("iteratorID" in payload).toBe(false);
  });

  it("qb_item_list fan-out (no itemType, no paginate) preserved", async () => {
    const { payload } = await callTool("qb_item_list", {});
    expect(Array.isArray(payload.items)).toBe(true);
    expect(payload.count).toBeGreaterThanOrEqual(1);
  });
});

describe("Layer 6 — end-to-end Start → Continue → exhausted through the tool", () => {
  it("caller's pagination loop terminates correctly", async () => {
    const startResp = await callTool("qb_customer_list", { paginate: true });
    const iterID = startResp.payload.iteratorID;
    const continueResp = await callTool("qb_customer_list", { iteratorID: iterID });
    // Stop condition: iteratorRemainingCount === 0 OR absent + count === 0.
    expect(continueResp.payload.count).toBe(0);
    expect("iteratorRemainingCount" in continueResp.payload).toBe(false);
  });
});

describe("Layer 7 — wire-level round-trip (the load-bearing assertion)", () => {
  // This is the single most load-bearing test: it proves builder, sim, and
  // parser agree on attribute names and shapes. If a future change drifts on
  // request `iterator`/`iteratorID` (lowercase) or response `iteratorRemainingCount`/
  // `iteratorID`, this fails first.
  it("builder(iter=Start) → sim → response surfaces iter metadata", async () => {
    const xml = buildQueryRequest("Customer", {}, { iterator: "Start" });
    const response = await session.sendRequest(xml);
    const rs = response.responses.find((r) => r.type === "CustomerQueryRs");
    expect(rs).toBeDefined();
    expect(rs!.statusCode).toBe(0);
    expect(rs!.iteratorRemainingCount).toBe(0);
    expect(typeof rs!.iteratorID).toBe("string");
    expect(rs!.iteratorID?.startsWith("SIM-ITER-")).toBe(true);
  });

  it("builder(iter=Continue) → sim → empty + no iter metadata", async () => {
    const xml = buildQueryRequest("Customer", {}, {
      iterator: "Continue",
      iteratorID: "SIM-ITER-test",
    });
    const response = await session.sendRequest(xml);
    const rs = response.responses.find((r) => r.type === "CustomerQueryRs");
    expect(rs).toBeDefined();
    expect(rs!.statusCode).toBe(1);
    expect("iteratorRemainingCount" in rs!).toBe(false);
    expect("iteratorID" in rs!).toBe(false);
  });
});

describe("Layer 8 — Phase 9 #39: maxReturned defaults to 500 when paginate is enabled", () => {
  // Pre-#39, calling any list tool with `paginate: true` and no `maxReturned`
  // produced "There is a missing element: MaxReturned" from QB. The tool layer
  // now coalesces an unset maxReturned to 500 (QB's effective per-batch cap)
  // whenever pagination is requested. These tests assert the coalesce fires
  // for every tool that exposes paginate, that an explicit value still wins,
  // and that the non-paginated path is untouched.
  //
  // Asserted via spy on session.queryEntityPaginated so we can read the
  // `filters` object the manager would have built MaxReturned from. Spying at
  // the manager layer keeps these tests single-purpose: they pin the tool
  // contract without depending on builder XML serialization or sim behavior.

  const expectMaxReturned = async (
    toolName: string,
    args: Record<string, unknown>,
    expected: number | undefined,
  ) => {
    const spy = vi
      .spyOn(session, "queryEntityPaginated")
      .mockResolvedValueOnce({ entities: [] });
    await callTool(toolName, args);
    expect(spy).toHaveBeenCalledTimes(1);
    const filters = spy.mock.calls[0][1] as Record<string, unknown> | undefined;
    if (expected === undefined) {
      expect(filters?.MaxReturned).toBeUndefined();
    } else {
      expect(filters?.MaxReturned).toBe(expected);
    }
    spy.mockRestore();
  };

  for (const tool of [
    { name: "qb_customer_list", paginateArgs: { paginate: true } },
    { name: "qb_invoice_list", paginateArgs: { paginate: true } },
    { name: "qb_bill_list", paginateArgs: { paginate: true } },
    { name: "qb_item_list", paginateArgs: { paginate: true, itemType: "Service" } },
  ]) {
    it(`${tool.name} paginate:true with no maxReturned → MaxReturned defaults to 500`, async () => {
      await expectMaxReturned(tool.name, tool.paginateArgs, 500);
    });

    it(`${tool.name} paginate:true with explicit maxReturned:50 → explicit value wins`, async () => {
      await expectMaxReturned(tool.name, { ...tool.paginateArgs, maxReturned: 50 }, 50);
    });

    it(`${tool.name} iteratorID alone (implies paginate) defaults MaxReturned to 500`, async () => {
      // iteratorID without paginate:true still triggers pagination — the tool
      // treats iteratorID's presence as the caller being mid-pagination, so
      // the same MaxReturned default must apply.
      const args = tool.name === "qb_item_list"
        ? { iteratorID: "SIM-ITER-test", itemType: "Service" }
        : { iteratorID: "SIM-ITER-test" };
      await expectMaxReturned(tool.name, args, 500);
    });
  }

  // The non-paginated path goes through session.queryEntity (NOT
  // queryEntityPaginated), so the spy never fires. We verify this by spying
  // on queryEntity and confirming filters.MaxReturned was NOT auto-set.
  it("qb_customer_list without paginate has no MaxReturned default (regression)", async () => {
    const spy = vi
      .spyOn(session, "queryEntity")
      .mockResolvedValueOnce([]);
    // Phase 16 #74 — `{}` would normally hit the lookup cache here (warmed
    // by an earlier test in this file). Pass useCache:false to verify the
    // legacy non-paginated wire contract directly.
    await callTool("qb_customer_list", { useCache: false });
    expect(spy).toHaveBeenCalledTimes(1);
    const filters = spy.mock.calls[0][1] as Record<string, unknown> | undefined;
    expect(filters?.MaxReturned).toBeUndefined();
    spy.mockRestore();
  });

  it("qb_invoice_list without paginate, explicit maxReturned:25 → 25 passes through", async () => {
    // Sanity: the non-paginated path still honors an explicit maxReturned —
    // we didn't accidentally rewrite that branch.
    const spy = vi
      .spyOn(session, "queryEntity")
      .mockResolvedValueOnce([]);
    await callTool("qb_invoice_list", { maxReturned: 25 });
    const filters = spy.mock.calls[0][1] as Record<string, unknown> | undefined;
    expect(filters?.MaxReturned).toBe(25);
    spy.mockRestore();
  });
});

describe("Layer 9 — Phase 16 #73: autoExhaust server-side iterator collapse on qb_customer_list (pilot)", () => {
  // autoExhaust:true should loop queryEntityPaginated until the iterator is
  // drained, return the merged result as one CallToolResult, and surface a
  // batchesExhausted count. Cap-hit returns a partial result + iteratorID for
  // caller-driven resumption.
  //
  // The sim's queryEntityPaginated returns iteratorRemainingCount=0 on the
  // first Start call (sim doesn't maintain cross-call iterator state), so a
  // raw sim test only exercises the single-batch happy path. Multi-batch and
  // cap-hit behavior are exercised by spying on queryEntityPaginated and
  // mocking it to return remaining > 0 across N calls.

  describe("validation", () => {
    it("autoExhaust:true + paginate:true rejects with mutex error", async () => {
      const { result, payload } = await callTool("qb_customer_list", {
        autoExhaust: true,
        paginate: true,
      });
      expect(result?.isError).toBe(true);
      expect(payload.success).toBe(false);
      expect(typeof payload.statusMessage).toBe("string");
      expect(payload.statusMessage).toContain("mutually exclusive");
    });

    it("autoExhaust:true + iteratorID rejects with mutex error", async () => {
      const { result, payload } = await callTool("qb_customer_list", {
        autoExhaust: true,
        iteratorID: "SIM-ITER-anything",
      });
      expect(result?.isError).toBe(true);
      expect(payload.success).toBe(false);
      expect(payload.statusMessage).toContain("mutually exclusive");
    });

    it("maxBatches:0 zod-rejected (must be positive integer)", async () => {
      const r = await callTool("qb_customer_list", { autoExhaust: true, maxBatches: 0 });
      expect("schemaError" in r).toBe(true);
    });

    it("maxBatches:-1 zod-rejected", async () => {
      const r = await callTool("qb_customer_list", { autoExhaust: true, maxBatches: -1 });
      expect("schemaError" in r).toBe(true);
    });

    it("maxBatches:1.5 zod-rejected (must be integer)", async () => {
      const r = await callTool("qb_customer_list", { autoExhaust: true, maxBatches: 1.5 });
      expect("schemaError" in r).toBe(true);
    });
  });

  describe("happy path on sim (single-batch exhaustion)", () => {
    it("autoExhaust:true returns merged result with batchesExhausted:1", async () => {
      const { payload } = await callTool("qb_customer_list", { autoExhaust: true });
      expect(Array.isArray(payload.customers)).toBe(true);
      expect(payload.count).toBeGreaterThanOrEqual(1);
      expect(payload.batchesExhausted).toBe(1);
      // No cap hit on fresh seed — no iteratorID / iteratorRemainingCount /
      // warnings surface on the happy path.
      expect("iteratorID" in payload).toBe(false);
      expect("iteratorRemainingCount" in payload).toBe(false);
      expect("warnings" in payload).toBe(false);
    });

    it("default (no autoExhaust) regression — no batchesExhausted field", async () => {
      const { payload } = await callTool("qb_customer_list", {});
      expect(Array.isArray(payload.customers)).toBe(true);
      expect("batchesExhausted" in payload).toBe(false);
    });

    it("autoExhaust:true with nameFilter narrows the result (filters threaded through)", async () => {
      const { payload } = await callTool("qb_customer_list", {
        autoExhaust: true,
        nameFilter: "Acme",
      });
      expect(payload.batchesExhausted).toBe(1);
      // Seed includes Acme Corporation + 4 jobs underneath — exact count
      // depends on seed but every returned customer must be Acme-related.
      expect(payload.count).toBeGreaterThanOrEqual(1);
      const allMatch = payload.customers.every((c: Record<string, unknown>) => {
        const name = (c.FullName ?? c.Name) as string;
        return typeof name === "string" && name.includes("Acme");
      });
      expect(allMatch).toBe(true);
    });
  });

  describe("multi-batch exhaustion via spy", () => {
    it("loops queryEntityPaginated until iteratorRemainingCount === 0, accumulates entities across batches", async () => {
      // Mock three batches: 500 + 500 + 47 = 1047 rows, last batch reports
      // remaining === 0 to terminate the loop.
      const makeBatch = (n: number, remaining: number, idSuffix: string) => ({
        entities: Array.from({ length: n }, (_, i) => ({
          ListID: `cust-${idSuffix}-${i}`,
          Name: `Cust ${idSuffix}-${i}`,
        })),
        iteratorRemainingCount: remaining,
        iteratorID: remaining > 0 ? `SIM-ITER-batch-${idSuffix}` : undefined,
      });
      const spy = vi
        .spyOn(session, "queryEntityPaginated")
        .mockResolvedValueOnce(makeBatch(500, 547, "1"))
        .mockResolvedValueOnce(makeBatch(500, 47, "2"))
        .mockResolvedValueOnce(makeBatch(47, 0, "3"));
      const { payload } = await callTool("qb_customer_list", { autoExhaust: true });
      expect(spy).toHaveBeenCalledTimes(3);
      // First call iterator=Start (no iteratorID), subsequent are Continue.
      expect(spy.mock.calls[0][2]).toMatchObject({ iterator: "Start" });
      expect(spy.mock.calls[1][2]).toMatchObject({ iterator: "Continue", iteratorID: "SIM-ITER-batch-1" });
      expect(spy.mock.calls[2][2]).toMatchObject({ iterator: "Continue", iteratorID: "SIM-ITER-batch-2" });
      expect(payload.count).toBe(1047);
      expect(payload.batchesExhausted).toBe(3);
      expect("iteratorID" in payload).toBe(false);
      expect("warnings" in payload).toBe(false);
      spy.mockRestore();
    });

    it("MaxReturned defaults to 500 under autoExhaust (matches paginate's coalesce)", async () => {
      const spy = vi
        .spyOn(session, "queryEntityPaginated")
        .mockResolvedValueOnce({ entities: [], iteratorRemainingCount: 0 });
      await callTool("qb_customer_list", { autoExhaust: true });
      const filters = spy.mock.calls[0][1] as Record<string, unknown>;
      expect(filters.MaxReturned).toBe(500);
      spy.mockRestore();
    });

    it("explicit maxReturned wins over default under autoExhaust", async () => {
      const spy = vi
        .spyOn(session, "queryEntityPaginated")
        .mockResolvedValueOnce({ entities: [], iteratorRemainingCount: 0 });
      await callTool("qb_customer_list", { autoExhaust: true, maxReturned: 50 });
      const filters = spy.mock.calls[0][1] as Record<string, unknown>;
      expect(filters.MaxReturned).toBe(50);
      spy.mockRestore();
    });
  });

  describe("cap-hit behavior", () => {
    it("maxBatches:2 stops after 2 batches when iterator still has remaining, surfaces warning + iteratorID", async () => {
      const makeBatch = (n: number, remaining: number, idSuffix: string) => ({
        entities: Array.from({ length: n }, (_, i) => ({
          ListID: `cust-${idSuffix}-${i}`,
          Name: `Cust ${idSuffix}-${i}`,
        })),
        iteratorRemainingCount: remaining,
        iteratorID: `SIM-ITER-batch-${idSuffix}`,
      });
      const spy = vi
        .spyOn(session, "queryEntityPaginated")
        .mockResolvedValueOnce(makeBatch(500, 1547, "1"))
        .mockResolvedValueOnce(makeBatch(500, 1047, "2"));
      const { payload } = await callTool("qb_customer_list", {
        autoExhaust: true,
        maxBatches: 2,
      });
      // Only 2 wire calls fire — the loop breaks BEFORE the 3rd call.
      expect(spy).toHaveBeenCalledTimes(2);
      expect(payload.count).toBe(1000);
      expect(payload.batchesExhausted).toBe(2);
      // Cap-hit surfaces iteratorID for resumption + warning.
      expect(payload.iteratorID).toBe("SIM-ITER-batch-2");
      expect(payload.iteratorRemainingCount).toBe(1047);
      expect(Array.isArray(payload.warnings)).toBe(true);
      expect(payload.warnings[0]).toContain("cap hit");
      expect(payload.warnings[0]).toContain("2 batches");
      expect(payload.warnings[0]).toContain("maxBatches");
      spy.mockRestore();
    });

    it("default maxBatches is 20", async () => {
      // Mock 21 batches all reporting remaining>0 — confirm we stop at 20
      // and the warning references the 20-batch ceiling implicitly via the
      // batchesExhausted count.
      const spy = vi.spyOn(session, "queryEntityPaginated");
      for (let i = 0; i < 25; i++) {
        spy.mockResolvedValueOnce({
          entities: [{ ListID: `c-${i}`, Name: `C ${i}` }],
          iteratorRemainingCount: 100,
          iteratorID: `SIM-ITER-b-${i}`,
        });
      }
      const { payload } = await callTool("qb_customer_list", { autoExhaust: true });
      expect(spy).toHaveBeenCalledTimes(20);
      expect(payload.batchesExhausted).toBe(20);
      expect(payload.iteratorID).toBe("SIM-ITER-b-19");
      expect(Array.isArray(payload.warnings)).toBe(true);
      spy.mockRestore();
    });

    it("exactly maxBatches batches with last reporting remaining===0 → no warning (exhausted on the cap, not capped before exhaustion)", async () => {
      const spy = vi
        .spyOn(session, "queryEntityPaginated")
        .mockResolvedValueOnce({
          entities: [{ ListID: "a", Name: "A" }],
          iteratorRemainingCount: 5,
          iteratorID: "SIM-ITER-a",
        })
        .mockResolvedValueOnce({
          entities: [{ ListID: "b", Name: "B" }],
          iteratorRemainingCount: 0,
          iteratorID: "SIM-ITER-b",
        });
      const { payload } = await callTool("qb_customer_list", {
        autoExhaust: true,
        maxBatches: 2,
      });
      // 2nd batch reported remaining=0 → loop exits cleanly, no cap-hit.
      expect(spy).toHaveBeenCalledTimes(2);
      expect(payload.batchesExhausted).toBe(2);
      expect("iteratorID" in payload).toBe(false);
      expect("warnings" in payload).toBe(false);
      spy.mockRestore();
    });
  });

  describe("hierarchy post-filter under autoExhaust applies to FULL accumulated set", () => {
    it("parentListID matching customers split across 2 batches are all found", async () => {
      // Critical correctness pin: paginate's post-filter is per-batch (the
      // pre-existing caveat documented on parentListID's zod description).
      // autoExhaust applies the filter to the FULL set — a sub-customer of
      // PARENT-X that lands in batch 2 must NOT be missed.
      const spy = vi
        .spyOn(session, "queryEntityPaginated")
        .mockResolvedValueOnce({
          entities: [
            { ListID: "c1", Name: "Other 1", ParentRef: { ListID: "PARENT-Y" } },
            { ListID: "c2", Name: "Job 1", ParentRef: { ListID: "PARENT-X" } },
          ],
          iteratorRemainingCount: 2,
          iteratorID: "SIM-ITER-1",
        })
        .mockResolvedValueOnce({
          entities: [
            { ListID: "c3", Name: "Job 2", ParentRef: { ListID: "PARENT-X" } },
            { ListID: "c4", Name: "Other 2", ParentRef: { ListID: "PARENT-Z" } },
          ],
          iteratorRemainingCount: 0,
        });
      const { payload } = await callTool("qb_customer_list", {
        autoExhaust: true,
        parentListID: "PARENT-X",
      });
      expect(spy).toHaveBeenCalledTimes(2);
      expect(payload.count).toBe(2);
      expect(payload.customers.map((c: Record<string, unknown>) => c.ListID).sort()).toEqual(["c2", "c3"]);
      spy.mockRestore();
    });

    it("jobOnly applies to full accumulated set", async () => {
      const spy = vi
        .spyOn(session, "queryEntityPaginated")
        .mockResolvedValueOnce({
          entities: [
            { ListID: "p1", Name: "Parent 1" },
            { ListID: "j1", Name: "Job 1", ParentRef: { ListID: "p1" } },
          ],
          iteratorRemainingCount: 2,
          iteratorID: "SIM-ITER-1",
        })
        .mockResolvedValueOnce({
          entities: [
            { ListID: "p2", Name: "Parent 2" },
            { ListID: "j2", Name: "Job 2", ParentRef: { ListID: "p2" } },
          ],
          iteratorRemainingCount: 0,
        });
      const { payload } = await callTool("qb_customer_list", {
        autoExhaust: true,
        jobOnly: true,
      });
      expect(payload.count).toBe(2);
      expect(payload.customers.map((c: Record<string, unknown>) => c.ListID).sort()).toEqual(["j1", "j2"]);
      spy.mockRestore();
    });
  });
});

// ---------------------------------------------------------------------------
// Layer 10 — Phase 16 #73 mechanical rollout to the remaining 6 paginated
// list tools (qb_vendor_list / qb_account_list / qb_employee_list /
// qb_bill_list / qb_invoice_list / qb_item_list). Per-tool minimum coverage:
// (a) autoExhaust+paginate mutex (the load-bearing invariant — every tool
// must reject the contradictory combo with a structured error), (b) one
// happy-path single-batch test against sim (regression that filters thread
// through + batchesExhausted lands), (c) one multi-batch spy test (proves the
// loop accumulates and the iterator handoff Start→Continue→Continue works).
// Cap-hit + maxBatches default-20 are pilot-pinned by induction.
// Per-tool quirks get their own pin: qb_invoice_list's includeCustomerContact
// must fire ONCE at the end over the merged dedup'd ListIDs (vs. paginate's
// per-batch enrichment); qb_item_list must refuse autoExhaust without
// itemType (iterators are scoped to a single Item*QueryRq).
// ---------------------------------------------------------------------------

describe("Layer 10 — Phase 16 #73 rollout: qb_vendor_list autoExhaust", () => {
  describe("validation", () => {
    it("autoExhaust:true + paginate:true rejects with mutex error", async () => {
      const { result, payload } = await callTool("qb_vendor_list", {
        autoExhaust: true,
        paginate: true,
      });
      expect(result?.isError).toBe(true);
      expect(payload.success).toBe(false);
      expect(payload.statusMessage).toContain("mutually exclusive");
    });
    it("autoExhaust:true + iteratorID rejects with mutex error", async () => {
      const { result, payload } = await callTool("qb_vendor_list", {
        autoExhaust: true,
        iteratorID: "SIM-ITER-anything",
      });
      expect(result?.isError).toBe(true);
      expect(payload.statusMessage).toContain("mutually exclusive");
    });
  });

  describe("happy path on sim", () => {
    it("autoExhaust:true returns merged result with batchesExhausted:1", async () => {
      const { payload } = await callTool("qb_vendor_list", { autoExhaust: true });
      expect(Array.isArray(payload.vendors)).toBe(true);
      expect(payload.count).toBeGreaterThanOrEqual(1);
      expect(payload.batchesExhausted).toBe(1);
      expect("iteratorID" in payload).toBe(false);
      expect("warnings" in payload).toBe(false);
    });
    it("default (no autoExhaust) regression — no batchesExhausted field", async () => {
      const { payload } = await callTool("qb_vendor_list", {});
      expect(Array.isArray(payload.vendors)).toBe(true);
      expect("batchesExhausted" in payload).toBe(false);
    });
  });

  describe("multi-batch exhaustion via spy", () => {
    it("loops queryEntityPaginated until exhausted, accumulates across batches", async () => {
      const spy = vi
        .spyOn(session, "queryEntityPaginated")
        .mockResolvedValueOnce({
          entities: [{ ListID: "v1", Name: "V1" }, { ListID: "v2", Name: "V2" }],
          iteratorRemainingCount: 1,
          iteratorID: "SIM-ITER-1",
        })
        .mockResolvedValueOnce({
          entities: [{ ListID: "v3", Name: "V3" }],
          iteratorRemainingCount: 0,
        });
      const { payload } = await callTool("qb_vendor_list", { autoExhaust: true });
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[0][0]).toBe("Vendor");
      expect(spy.mock.calls[0][2]).toMatchObject({ iterator: "Start" });
      expect(spy.mock.calls[1][2]).toMatchObject({ iterator: "Continue", iteratorID: "SIM-ITER-1" });
      expect(payload.count).toBe(3);
      expect(payload.batchesExhausted).toBe(2);
      spy.mockRestore();
    });
    it("MaxReturned defaults to 500 under autoExhaust", async () => {
      const spy = vi
        .spyOn(session, "queryEntityPaginated")
        .mockResolvedValueOnce({ entities: [], iteratorRemainingCount: 0 });
      await callTool("qb_vendor_list", { autoExhaust: true });
      const filters = spy.mock.calls[0][1] as Record<string, unknown>;
      expect(filters.MaxReturned).toBe(500);
      spy.mockRestore();
    });
  });
});

describe("Layer 10 — qb_account_list autoExhaust", () => {
  describe("validation", () => {
    it("autoExhaust:true + paginate:true rejects with mutex error", async () => {
      const { result, payload } = await callTool("qb_account_list", {
        autoExhaust: true,
        paginate: true,
      });
      expect(result?.isError).toBe(true);
      expect(payload.statusMessage).toContain("mutually exclusive");
    });
    it("autoExhaust:true + iteratorID rejects with mutex error", async () => {
      const { result, payload } = await callTool("qb_account_list", {
        autoExhaust: true,
        iteratorID: "SIM-ITER-x",
      });
      expect(result?.isError).toBe(true);
      expect(payload.statusMessage).toContain("mutually exclusive");
    });
  });

  describe("happy path on sim", () => {
    it("autoExhaust:true returns merged result with batchesExhausted:1", async () => {
      const { payload } = await callTool("qb_account_list", { autoExhaust: true });
      expect(Array.isArray(payload.accounts)).toBe(true);
      expect(payload.count).toBeGreaterThanOrEqual(1);
      expect(payload.batchesExhausted).toBe(1);
    });
    it("autoExhaust:true with accountType filter threads through", async () => {
      const spy = vi
        .spyOn(session, "queryEntityPaginated")
        .mockResolvedValueOnce({ entities: [], iteratorRemainingCount: 0 });
      await callTool("qb_account_list", { autoExhaust: true, accountType: "Bank" });
      const filters = spy.mock.calls[0][1] as Record<string, unknown>;
      expect(filters.AccountType).toBe("Bank");
      spy.mockRestore();
    });
    it("default (no autoExhaust) regression — no batchesExhausted field", async () => {
      const { payload } = await callTool("qb_account_list", {});
      expect("batchesExhausted" in payload).toBe(false);
    });
  });

  describe("multi-batch exhaustion via spy", () => {
    it("loops queryEntityPaginated, accumulates Account rows", async () => {
      const spy = vi
        .spyOn(session, "queryEntityPaginated")
        .mockResolvedValueOnce({
          entities: [{ ListID: "a1", Name: "Checking" }],
          iteratorRemainingCount: 2,
          iteratorID: "SIM-ITER-A",
        })
        .mockResolvedValueOnce({
          entities: [{ ListID: "a2", Name: "Savings" }, { ListID: "a3", Name: "AR" }],
          iteratorRemainingCount: 0,
        });
      const { payload } = await callTool("qb_account_list", { autoExhaust: true });
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[0][0]).toBe("Account");
      expect(payload.count).toBe(3);
      expect(payload.batchesExhausted).toBe(2);
      spy.mockRestore();
    });
  });
});

describe("Layer 10 — qb_employee_list autoExhaust", () => {
  describe("validation", () => {
    it("autoExhaust:true + paginate:true rejects with mutex error", async () => {
      const { result, payload } = await callTool("qb_employee_list", {
        autoExhaust: true,
        paginate: true,
      });
      expect(result?.isError).toBe(true);
      expect(payload.statusMessage).toContain("mutually exclusive");
    });
  });

  describe("happy path on sim", () => {
    it("autoExhaust:true returns merged result with batchesExhausted:1", async () => {
      const { payload } = await callTool("qb_employee_list", { autoExhaust: true });
      expect(Array.isArray(payload.employees)).toBe(true);
      expect(payload.count).toBeGreaterThanOrEqual(1);
      expect(payload.batchesExhausted).toBe(1);
    });
    it("default (no autoExhaust) regression — no batchesExhausted field", async () => {
      const { payload } = await callTool("qb_employee_list", {});
      expect("batchesExhausted" in payload).toBe(false);
    });
  });

  describe("multi-batch exhaustion via spy", () => {
    it("loops queryEntityPaginated, accumulates Employee rows", async () => {
      const spy = vi
        .spyOn(session, "queryEntityPaginated")
        .mockResolvedValueOnce({
          entities: [{ ListID: "e1", Name: "Alice" }],
          iteratorRemainingCount: 1,
          iteratorID: "SIM-ITER-E",
        })
        .mockResolvedValueOnce({
          entities: [{ ListID: "e2", Name: "Bob" }],
          iteratorRemainingCount: 0,
        });
      const { payload } = await callTool("qb_employee_list", { autoExhaust: true });
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[0][0]).toBe("Employee");
      expect(payload.count).toBe(2);
      expect(payload.batchesExhausted).toBe(2);
      spy.mockRestore();
    });
  });
});

describe("Layer 10 — qb_bill_list autoExhaust", () => {
  describe("validation", () => {
    it("autoExhaust:true + paginate:true rejects with mutex error", async () => {
      const { result, payload } = await callTool("qb_bill_list", {
        autoExhaust: true,
        paginate: true,
      });
      expect(result?.isError).toBe(true);
      expect(payload.statusMessage).toContain("mutually exclusive");
    });
  });

  describe("happy path on sim", () => {
    it("autoExhaust:true returns merged result with batchesExhausted:1", async () => {
      const { payload } = await callTool("qb_bill_list", { autoExhaust: true });
      expect(Array.isArray(payload.bills)).toBe(true);
      expect(payload.batchesExhausted).toBe(1);
    });
    it("default (no autoExhaust) regression — no batchesExhausted field", async () => {
      const { payload } = await callTool("qb_bill_list", {});
      expect("batchesExhausted" in payload).toBe(false);
    });
  });

  describe("multi-batch exhaustion via spy + IncludeLineItems threads through every batch", () => {
    it("loops queryEntityPaginated, accumulates Bill rows, IncludeLineItems on every batch", async () => {
      const spy = vi
        .spyOn(session, "queryEntityPaginated")
        .mockResolvedValueOnce({
          entities: [{ TxnID: "b1", VendorRef: { FullName: "V1" } }],
          iteratorRemainingCount: 1,
          iteratorID: "SIM-ITER-B",
        })
        .mockResolvedValueOnce({
          entities: [{ TxnID: "b2", VendorRef: { FullName: "V2" } }],
          iteratorRemainingCount: 0,
        });
      const { payload } = await callTool("qb_bill_list", {
        autoExhaust: true,
        includeLineItems: true,
      });
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[0][0]).toBe("Bill");
      // IncludeLineItems threads through both wire calls — the filter object
      // is built once before the loop, so this is structural rather than
      // per-call, but the assertion pins that it lands on the wire.
      const filters0 = spy.mock.calls[0][1] as Record<string, unknown>;
      const filters1 = spy.mock.calls[1][1] as Record<string, unknown>;
      expect(filters0.IncludeLineItems).toBe(true);
      expect(filters1.IncludeLineItems).toBe(true);
      expect(payload.count).toBe(2);
      expect(payload.batchesExhausted).toBe(2);
      spy.mockRestore();
    });
  });
});

describe("Layer 10 — qb_invoice_list autoExhaust", () => {
  describe("validation", () => {
    it("autoExhaust:true + paginate:true rejects with mutex error", async () => {
      const { result, payload } = await callTool("qb_invoice_list", {
        autoExhaust: true,
        paginate: true,
      });
      expect(result?.isError).toBe(true);
      expect(payload.statusMessage).toContain("mutually exclusive");
    });
  });

  describe("happy path on sim", () => {
    it("autoExhaust:true returns merged result with batchesExhausted:1", async () => {
      const { payload } = await callTool("qb_invoice_list", { autoExhaust: true });
      expect(Array.isArray(payload.invoices)).toBe(true);
      expect(payload.batchesExhausted).toBe(1);
    });
    it("default (no autoExhaust) regression — no batchesExhausted field", async () => {
      const { payload } = await callTool("qb_invoice_list", {});
      expect("batchesExhausted" in payload).toBe(false);
    });
  });

  describe("multi-batch exhaustion via spy", () => {
    it("loops queryEntityPaginated, accumulates Invoice rows", async () => {
      const spy = vi
        .spyOn(session, "queryEntityPaginated")
        .mockResolvedValueOnce({
          entities: [{ TxnID: "i1", CustomerRef: { ListID: "C1", FullName: "Cust 1" } }],
          iteratorRemainingCount: 1,
          iteratorID: "SIM-ITER-I",
        })
        .mockResolvedValueOnce({
          entities: [{ TxnID: "i2", CustomerRef: { ListID: "C2", FullName: "Cust 2" } }],
          iteratorRemainingCount: 0,
        });
      const { payload } = await callTool("qb_invoice_list", { autoExhaust: true });
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[0][0]).toBe("Invoice");
      expect(payload.count).toBe(2);
      expect(payload.batchesExhausted).toBe(2);
      spy.mockRestore();
    });
  });

  describe("includeCustomerContact dedup pin — runs ONCE at the end over merged dedup'd ListIDs", () => {
    it("2 batches share a customer ListID → single CustomerQueryRq, dedup'd", async () => {
      // Critical correctness pin: per the handoff, autoExhaust must enrich
      // ONCE at the end on the merged result (vs. paginate which enriches
      // per-batch). Three invoices across 2 batches reference 2 unique
      // customers (C1 appears in both batches) — exactly one follow-up
      // CustomerQueryRq must fire, scoped to the dedup'd ListID set
      // {C1, C2}.
      let invoiceCalls = 0;
      let customerCalls = 0;
      const customerListIdsSeen: string[][] = [];
      const qpSpy = vi
        .spyOn(session, "queryEntityPaginated")
        .mockImplementation(async (entityType: string) => {
          expect(entityType).toBe("Invoice");
          invoiceCalls += 1;
          if (invoiceCalls === 1) {
            return {
              entities: [
                { TxnID: "i1", CustomerRef: { ListID: "C1", FullName: "Cust 1" } },
                { TxnID: "i2", CustomerRef: { ListID: "C2", FullName: "Cust 2" } },
              ],
              iteratorRemainingCount: 1,
              iteratorID: "SIM-ITER-I-1",
            };
          }
          return {
            entities: [
              { TxnID: "i3", CustomerRef: { ListID: "C1", FullName: "Cust 1" } },
            ],
            iteratorRemainingCount: 0,
          };
        });
      const qSpy = vi
        .spyOn(session, "queryEntity")
        .mockImplementation(async (entityType: string, filters: Record<string, unknown> = {}) => {
          expect(entityType).toBe("Customer");
          customerCalls += 1;
          const ids = Array.isArray(filters.ListID) ? filters.ListID as string[] : [];
          customerListIdsSeen.push(ids.slice().sort());
          return ids.map((id) => ({
            ListID: id,
            FullName: `Cust ${id}`,
            Email: `${id}@example.com`,
          }));
        });
      const { payload } = await callTool("qb_invoice_list", {
        autoExhaust: true,
        includeCustomerContact: true,
      });
      // Two Invoice wire calls (one per batch); ONE Customer wire call
      // (dedup'd across batches).
      expect(invoiceCalls).toBe(2);
      expect(customerCalls).toBe(1);
      expect(customerListIdsSeen[0]).toEqual(["C1", "C2"]);
      expect(payload.count).toBe(3);
      // Every returned invoice carries the customerContact attachment.
      const allHaveContact = payload.invoices.every((inv: Record<string, unknown>) => {
        return inv.customerContact !== undefined;
      });
      expect(allHaveContact).toBe(true);
      qpSpy.mockRestore();
      qSpy.mockRestore();
    });
  });
});

describe("Layer 10 — qb_item_list autoExhaust", () => {
  describe("validation", () => {
    it("autoExhaust:true + paginate:true rejects with mutex error", async () => {
      const { result, payload } = await callTool("qb_item_list", {
        autoExhaust: true,
        paginate: true,
        itemType: "Service",
      });
      expect(result?.isError).toBe(true);
      expect(payload.statusMessage).toContain("mutually exclusive");
    });

    it("autoExhaust:true without itemType refuses with structured error", async () => {
      // Critical pin: iterators are scoped to a single Item*QueryRq, so
      // autoExhaust cannot fan across the 5 subtypes — same constraint as
      // paginate. Surface must match the paginate refusal shape.
      const { result, payload } = await callTool("qb_item_list", { autoExhaust: true });
      expect(result?.isError).toBe(true);
      expect(payload.success).toBe(false);
      expect(typeof payload.error).toBe("string");
      expect(payload.error).toContain("autoExhaust requires itemType");
      expect(payload.error).toContain("Service / Inventory / NonInventory / OtherCharge / Group");
    });
  });

  describe("happy path on sim", () => {
    it("autoExhaust:true with itemType returns merged result with batchesExhausted:1", async () => {
      const { payload } = await callTool("qb_item_list", {
        autoExhaust: true,
        itemType: "Service",
      });
      expect(Array.isArray(payload.items)).toBe(true);
      expect(payload.batchesExhausted).toBe(1);
    });
    it("fan-out (no itemType, no autoExhaust) regression preserved", async () => {
      const { payload } = await callTool("qb_item_list", {});
      expect(Array.isArray(payload.items)).toBe(true);
      expect("batchesExhausted" in payload).toBe(false);
    });
  });

  describe("multi-batch exhaustion via spy", () => {
    it("loops queryEntityPaginated against ItemService, accumulates rows", async () => {
      const spy = vi
        .spyOn(session, "queryEntityPaginated")
        .mockResolvedValueOnce({
          entities: [{ ListID: "si1", Name: "Service 1" }],
          iteratorRemainingCount: 1,
          iteratorID: "SIM-ITER-S",
        })
        .mockResolvedValueOnce({
          entities: [{ ListID: "si2", Name: "Service 2" }],
          iteratorRemainingCount: 0,
        });
      const { payload } = await callTool("qb_item_list", {
        autoExhaust: true,
        itemType: "Service",
      });
      expect(spy).toHaveBeenCalledTimes(2);
      // Item subtype name is concatenated — `ItemService`, not just `Item`.
      expect(spy.mock.calls[0][0]).toBe("ItemService");
      expect(payload.count).toBe(2);
      expect(payload.batchesExhausted).toBe(2);
      spy.mockRestore();
    });
  });
});
