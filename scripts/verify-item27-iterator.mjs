// Item 27 verification — IteratorID / IteratorRemainingCount support across
// the QBXML envelope, the parser, the manager, the simulation store, and the
// four list tools opted into pagination (Customer / Invoice / Bill / Item).
//
// Layered design (top to bottom):
//   1. Builder — buildQueryRequest takes options { iterator, iteratorID }
//      and emits them as XML attributes on the *QueryRq element (NOT
//      children). Threaded via QBXMLRequestBody.attributes.
//   2. Parser — surfaces @_iteratorRemainingCount / @_iteratorID on
//      *QueryRs envelopes into typed iteratorRemainingCount + iteratorID
//      fields on QBXMLResponseBody.
//   3. Manager — additive queryEntityPaginated() returns
//      { entities, iteratorRemainingCount?, iteratorID? }. Existing
//      queryEntity() signature unchanged.
//   4. Simulation store — handleQuery reads @_iterator on the request.
//      Start returns full result set + iteratorRemainingCount=0 +
//      synthesized iteratorID (sim does not actually page — seed data
//      fits well under 500 rows). Continue/Stop are treated as exhausted
//      (statusCode=1, empty data, no iterator metadata).
//   5. Tool surface — qb_customer_list / qb_invoice_list / qb_bill_list /
//      qb_item_list accept paginate?: boolean and iteratorID?: string.
//      Items requires itemType when paginating (iterators are scoped to
//      one *QueryRq, so the multi-subtype fan-out path can't paginate).
//
// Regression invariants preserved:
//   - Non-paginated calls produce the exact same JSON shape as before.
//   - Existing queryEntity callers see no change.
//   - Iterator metadata only appears on responses to iterator-mode requests.

import { z } from "zod";
import { QBSessionManager } from "../dist/session/manager.js";
import {
  buildQueryRequest,
  buildQBXMLRequest,
} from "../dist/qbxml/builder.js";
import { parseQBXMLResponse } from "../dist/qbxml/parser.js";
import { registerCustomerTools } from "../dist/tools/customers.js";
import { registerInvoiceTools } from "../dist/tools/invoices.js";
import { registerBillTools } from "../dist/tools/bills.js";
import { registerItemTools } from "../dist/tools/items.js";

const handlers = new Map();
const schemas = new Map();
const fakeServer = {
  tool: (name, _description, schema, handler) => {
    handlers.set(name, handler);
    schemas.set(name, schema);
  },
};

const session = new QBSessionManager({
  companyFile: "simulation",
  appName: "verify-item27",
  qbxmlVersion: "16.0",
  connectionMode: "optimistic",
});
const getSession = () => session;

registerCustomerTools(fakeServer, getSession);
registerInvoiceTools(fakeServer, getSession);
registerBillTools(fakeServer, getSession);
registerItemTools(fakeServer, getSession);

await session.openSession();

let passes = 0;
let fails = 0;
const log = (label, pass, detail = "") => {
  const tag = pass ? "PASS" : "FAIL";
  if (pass) passes++; else fails++;
  console.log(`[${tag}] ${label}${detail ? " — " + detail : ""}`);
};

const callTool = async (toolName, args) => {
  const schema = schemas.get(toolName);
  const handler = handlers.get(toolName);
  if (!schema || !handler) throw new Error(`Tool not registered: ${toolName}`);
  const parsed = z.object(schema).safeParse(args);
  if (!parsed.success) {
    return { schemaError: parsed.error };
  }
  const result = await handler(parsed.data);
  const payload = JSON.parse(result.content[0].text);
  return { result, payload };
};

// =============================================================================
// Layer 1 — Builder: iterator + iteratorID emit as XML attributes on the
// request element, not as child elements.
// =============================================================================

{
  const xml = buildQueryRequest("Customer", {}, { iterator: "Start" });
  const ok =
    xml.includes('<CustomerQueryRq requestID="1" iterator="Start">') &&
    !xml.includes("<iterator>");
  log("builder: iterator='Start' emits as XML attribute on *QueryRq", ok, ok ? "" : xml.slice(0, 200));
}

{
  const xml = buildQueryRequest("Customer", {}, {
    iterator: "Continue",
    iteratorID: "{abc-123}",
  });
  const ok = xml.includes(
    '<CustomerQueryRq requestID="1" iterator="Continue" iteratorID="{abc-123}">'
  );
  log("builder: iterator='Continue' + iteratorID emit as paired attributes", ok, ok ? "" : xml.slice(0, 200));
}

{
  const xml = buildQueryRequest("Customer", {}, { iterator: "Stop", iteratorID: "{abc}" });
  const ok = xml.includes('iterator="Stop"') && xml.includes('iteratorID="{abc}"');
  log("builder: iterator='Stop' + iteratorID round-trip", ok);
}

{
  // No iterator → builder behaves exactly as before; no iterator attrs.
  const xml = buildQueryRequest("Customer", { ActiveStatus: "ActiveOnly" });
  const ok =
    xml.includes('<CustomerQueryRq requestID="1">') &&
    !xml.includes("iterator=") &&
    xml.includes("<ActiveStatus>ActiveOnly</ActiveStatus>");
  log("builder: no iterator option → no iterator attributes (regression)", ok, ok ? "" : xml.slice(0, 200));
}

{
  // Special characters in iteratorID must be xml-escaped (defensive — real
  // QB iteratorIDs are GUIDs but the contract is "opaque string").
  const xml = buildQueryRequest("Customer", {}, {
    iterator: "Continue",
    iteratorID: 'a"b<c',
  });
  const ok = xml.includes('iteratorID="a&quot;b&lt;c"');
  log("builder: iteratorID is xml-escaped", ok);
}

{
  // The body still serializes filter children; iterator attrs sit alongside
  // requestID, body children stay untouched.
  const xml = buildQueryRequest("Invoice", {
    PaidStatus: "NotPaidOnly",
    MaxReturned: 500,
  }, { iterator: "Start" });
  const ok =
    xml.includes('iterator="Start"') &&
    xml.includes("<PaidStatus>NotPaidOnly</PaidStatus>") &&
    xml.includes("<MaxReturned>500</MaxReturned>");
  log("builder: iterator + filter children coexist", ok);
}

// =============================================================================
// Layer 2 — Parser: surface iteratorRemainingCount + iteratorID from
// response envelope as typed fields on QBXMLResponseBody.
// =============================================================================

{
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
  const ok =
    rs.iteratorRemainingCount === 237 &&
    rs.iteratorID === "{abc-def-123}" &&
    rs.statusCode === 0;
  log("parser: surfaces iteratorRemainingCount (237) + iteratorID from envelope", ok,
    `count=${rs.iteratorRemainingCount} id=${rs.iteratorID}`);
}

{
  // iteratorRemainingCount=0 means exhausted — must round-trip cleanly
  // (Number(0) is falsy, so the != undefined gate is the load-bearing check).
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
  const ok = rs.iteratorRemainingCount === 0 && rs.iteratorID === "{end}";
  log("parser: iteratorRemainingCount=0 (exhausted) round-trips", ok,
    `count=${rs.iteratorRemainingCount} id=${rs.iteratorID}`);
}

{
  // Response without iterator attrs — fields must be absent (not undefined-
  // valued, not 0). The exact-shape contract is "absent unless server set it".
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
  const ok =
    !("iteratorRemainingCount" in rs) &&
    !("iteratorID" in rs);
  log("parser: response without iterator attrs has no iterator fields (regression)", ok,
    `keys=${Object.keys(rs).join(",")}`);
}

// =============================================================================
// Layer 3 — Manager.queryEntityPaginated round-trips through the simulation.
// =============================================================================

{
  const result = await session.queryEntityPaginated("Customer", {}, {
    iterator: "Start",
  });
  const ok =
    Array.isArray(result.entities) &&
    result.entities.length >= 1 &&
    result.iteratorRemainingCount === 0 &&
    typeof result.iteratorID === "string" &&
    result.iteratorID.startsWith("SIM-ITER-");
  log("manager: queryEntityPaginated('Customer', Start) → entities + iter metadata", ok,
    `count=${result.entities.length} remaining=${result.iteratorRemainingCount} id=${result.iteratorID?.slice(0,12)}…`);
}

{
  const result = await session.queryEntityPaginated("Customer", {}, {
    iterator: "Continue",
    iteratorID: "SIM-ITER-anything",
  });
  // Continue treated as exhausted iterator → empty result, no iterator
  // metadata (sim does not maintain iterator state across requests).
  const ok =
    result.entities.length === 0 &&
    result.iteratorRemainingCount === undefined &&
    result.iteratorID === undefined;
  log("manager: queryEntityPaginated Continue returns empty + no iter metadata (sim contract)", ok,
    `count=${result.entities.length}`);
}

{
  // Existing queryEntity must be untouched — no iterator attrs in the wire,
  // no iterator metadata in the result. (Caller can't tell pagination exists.)
  const customers = await session.queryEntity("Customer");
  const ok = Array.isArray(customers) && customers.length >= 1;
  log("manager: queryEntity (legacy) unchanged shape", ok, `count=${customers.length}`);
}

// =============================================================================
// Layer 4 — Simulation store: iterator-mode requests behave as designed.
// Verified through queryEntityPaginated above; here we exercise an empty
// store path explicitly so the empty + Start branch is covered.
// =============================================================================

{
  // Bills seed is empty — Start on an empty store still returns iterator
  // metadata (the iterator was created and is empty), per real QB behavior.
  const result = await session.queryEntityPaginated("Bill", {}, { iterator: "Start" });
  const ok =
    result.entities.length === 0 &&
    result.iteratorRemainingCount === 0 &&
    typeof result.iteratorID === "string" &&
    result.iteratorID.startsWith("SIM-ITER-");
  log("simulation: Start on empty store returns iter metadata (empty iterator)", ok,
    `count=${result.entities.length} remaining=${result.iteratorRemainingCount}`);
}

// =============================================================================
// Layer 5 — Tool surface: paginate flag flows through end-to-end.
// =============================================================================

{
  const { payload } = await callTool("qb_customer_list", { paginate: true });
  const ok =
    Array.isArray(payload.customers) &&
    payload.count >= 1 &&
    payload.iteratorRemainingCount === 0 &&
    typeof payload.iteratorID === "string";
  log("qb_customer_list paginate:true returns iter fields", ok,
    `count=${payload.count} remaining=${payload.iteratorRemainingCount}`);
}

{
  const { payload } = await callTool("qb_customer_list", {});
  // Default path — no iterator fields in the response.
  const ok =
    Array.isArray(payload.customers) &&
    payload.count >= 1 &&
    !("iteratorRemainingCount" in payload) &&
    !("iteratorID" in payload);
  log("qb_customer_list default (no paginate) has no iter fields (regression)", ok,
    `count=${payload.count}`);
}

{
  // Continue path — passing iteratorID without paginate flag still triggers
  // pagination (iteratorID implies paginate by design).
  const { payload } = await callTool("qb_customer_list", {
    iteratorID: "SIM-ITER-foo",
  });
  // Continue → exhausted iterator → 0 results, no iter metadata
  const ok =
    payload.count === 0 &&
    !("iteratorRemainingCount" in payload) &&
    !("iteratorID" in payload);
  log("qb_customer_list iteratorID alone implies paginate; Continue returns empty", ok,
    `count=${payload.count}`);
}

{
  const { payload } = await callTool("qb_invoice_list", { paginate: true });
  const ok =
    Array.isArray(payload.invoices) &&
    payload.iteratorRemainingCount === 0 &&
    typeof payload.iteratorID === "string";
  log("qb_invoice_list paginate:true returns iter fields", ok,
    `count=${payload.count} remaining=${payload.iteratorRemainingCount}`);
}

{
  const { payload } = await callTool("qb_invoice_list", {});
  const ok =
    Array.isArray(payload.invoices) &&
    !("iteratorRemainingCount" in payload) &&
    !("iteratorID" in payload);
  log("qb_invoice_list default has no iter fields (regression)", ok);
}

{
  const { payload } = await callTool("qb_bill_list", { paginate: true });
  const ok =
    Array.isArray(payload.bills) &&
    payload.iteratorRemainingCount === 0 &&
    typeof payload.iteratorID === "string";
  log("qb_bill_list paginate:true returns iter fields (empty store)", ok,
    `count=${payload.count} remaining=${payload.iteratorRemainingCount}`);
}

{
  const { payload } = await callTool("qb_bill_list", {});
  const ok =
    Array.isArray(payload.bills) &&
    !("iteratorRemainingCount" in payload) &&
    !("iteratorID" in payload);
  log("qb_bill_list default has no iter fields (regression)", ok);
}

{
  const { payload } = await callTool("qb_item_list", {
    paginate: true,
    itemType: "Service",
  });
  const ok =
    Array.isArray(payload.items) &&
    payload.iteratorRemainingCount === 0 &&
    typeof payload.iteratorID === "string";
  log("qb_item_list paginate:true with itemType returns iter fields", ok,
    `count=${payload.count} remaining=${payload.iteratorRemainingCount}`);
}

{
  // Iterators are scoped to a single *QueryRq — the multi-subtype fan-out
  // path can't paginate. Tool refuses with a structured error before
  // touching the session.
  const { payload, result } = await callTool("qb_item_list", { paginate: true });
  const ok =
    result?.isError === true &&
    payload.success === false &&
    typeof payload.error === "string" &&
    payload.error.includes("itemType");
  log("qb_item_list paginate:true without itemType refuses with structured error", ok,
    `error=${payload.error?.slice(0, 60)}…`);
}

{
  const { payload } = await callTool("qb_item_list", { itemType: "Service" });
  const ok =
    Array.isArray(payload.items) &&
    !("iteratorRemainingCount" in payload) &&
    !("iteratorID" in payload);
  log("qb_item_list itemType-only (no paginate) has no iter fields (regression)", ok);
}

{
  // Multi-subtype fan-out (no itemType, no paginate) still works and merges
  // across all 5 stores — pre-Item-27 behavior preserved.
  const { payload } = await callTool("qb_item_list", {});
  const ok = Array.isArray(payload.items) && payload.count >= 1;
  log("qb_item_list fan-out (no itemType, no paginate) preserved", ok,
    `count=${payload.count}`);
}

// =============================================================================
// Layer 6 — Continuation flow end-to-end through the tool.
// Caller's pagination loop: Start → response with iteratorID → Continue with
// that iteratorID until iteratorRemainingCount === 0 (or absent).
// =============================================================================

{
  const startResp = await callTool("qb_customer_list", { paginate: true });
  const iterID = startResp.payload.iteratorID;
  const continueResp = await callTool("qb_customer_list", { iteratorID: iterID });
  // Sim treats the iterator as exhausted on Continue (we returned everything
  // on Start). Real QB would send the next page. Either way, the contract is
  // "stop when iteratorRemainingCount === 0 OR absent + count === 0".
  const ok =
    continueResp.payload.count === 0 &&
    !("iteratorRemainingCount" in continueResp.payload);
  log("end-to-end: Start → Continue → exhausted (sim contract)", ok,
    `start.count=${startResp.payload.count} cont.count=${continueResp.payload.count}`);
}

// =============================================================================
// Layer 7 — Wire-level round-trip: builder → simulation → parser surfaces
// iterator metadata. This is the single most load-bearing assertion: it
// proves the three layers agree on attribute names and shapes.
// =============================================================================

{
  const xml = buildQueryRequest("Customer", {}, { iterator: "Start" });
  const response = await session.sendRequest(xml);
  const rs = response.responses.find((r) => r.type === "CustomerQueryRs");
  const ok =
    rs &&
    rs.statusCode === 0 &&
    rs.iteratorRemainingCount === 0 &&
    typeof rs.iteratorID === "string" &&
    rs.iteratorID.startsWith("SIM-ITER-");
  log("round-trip: builder(iter=Start) → sim → response surfaces iter metadata", ok,
    `code=${rs?.statusCode} remaining=${rs?.iteratorRemainingCount} id=${rs?.iteratorID?.slice(0,12)}…`);
}

{
  // Continue path through the wire — sim returns empty, no iter metadata.
  const xml = buildQueryRequest("Customer", {}, {
    iterator: "Continue",
    iteratorID: "SIM-ITER-test",
  });
  const response = await session.sendRequest(xml);
  const rs = response.responses.find((r) => r.type === "CustomerQueryRs");
  const ok =
    rs &&
    rs.statusCode === 1 &&
    !("iteratorRemainingCount" in rs) &&
    !("iteratorID" in rs);
  log("round-trip: builder(iter=Continue) → sim → empty + no iter metadata", ok,
    `code=${rs?.statusCode}`);
}

console.log(`\n${passes} pass / ${fails} fail`);
process.exit(fails === 0 ? 0 : 1);
