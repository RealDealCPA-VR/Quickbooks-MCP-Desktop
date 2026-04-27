// Iterator (Item 27) — IteratorID / IteratorRemainingCount support across all
// 5 layers (types, builder, parser, manager, simulation store) plus the four
// tools opted into pagination (Customer / Invoice / Bill / Item).
//
// Ported from scripts/verify-item27-iterator.mjs. The .mjs harness imports
// from dist/ to verify the built output; this Vitest port imports from src/
// to verify the source tree directly. Both must pass — they're complementary,
// not redundant.

import { describe, it, expect, beforeAll } from "vitest";
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
