// Phase 13 #61 — Custom-field (DataExt) support across all entities.
//
// Coverage layers:
//   1. Parser — DataExtRet / DataExtDefRet / AssignToObject round-trip as
//      arrays even when only a single entry appears. Without these in the
//      arrayElements set, callers that expect to walk `entity.DataExtRet[]`
//      would crash on a single-CF entity that comes back as an object.
//   2. Sim DataExtDef discovery — handleDataExtDefQuery returns every seeded
//      def by default; AssignToObject filter narrows to defs targeting one
//      entity type; OwnerID filter narrows to one namespace; missing match
//      returns statusCode 1.
//   3. Sim OwnerID strip — handleQuery strips DataExtRet from *Ret rows when
//      OwnerID is absent (default); preserves them (filtered by namespace)
//      when OwnerID is present.
//   4. Tool surface — qb_custom_field_list happy + filter paths;
//      qb_customer_list / qb_vendor_list / qb_invoice_list with
//      includeCustomFields:true surface DataExtRet on the matching seed
//      entities; default (without the flag) strips them.

import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerCustomerTools } from "../src/tools/customers.js";
import { registerVendorTools } from "../src/tools/vendors.js";
import { registerInvoiceTools } from "../src/tools/invoices.js";
import { registerCustomFieldTools } from "../src/tools/custom-fields.js";
import { parseQBXMLResponse } from "../src/qbxml/parser.js";

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

let session: QBSessionManager;

beforeAll(async () => {
  session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-data-ext-custom-fields",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  registerCustomerTools(fakeServer as never, () => session);
  registerVendorTools(fakeServer as never, () => session);
  registerInvoiceTools(fakeServer as never, () => session);
  registerCustomFieldTools(fakeServer as never, () => session);
  await session.openSession();
});

async function call(
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const handler = handlers.get(toolName);
  if (!handler) throw new Error(`tool not registered: ${toolName}`);
  const result = await handler(args);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// =============================================================================
// Layer 1 — parser round-trip pins
// =============================================================================

describe("Layer 1 — parser surfaces DataExt elements as arrays", () => {
  it("DataExtRet survives as an array with a single entry", () => {
    const xml = `<?xml version="1.0"?>
<QBXML>
  <QBXMLMsgsRs>
    <CustomerQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="OK">
      <CustomerRet>
        <ListID>X-1</ListID>
        <Name>Acme</Name>
        <DataExtRet>
          <OwnerID>0</OwnerID>
          <DataExtName>Tax Year</DataExtName>
          <DataExtType>STR255TYPE</DataExtType>
          <DataExtValue>2024</DataExtValue>
        </DataExtRet>
      </CustomerRet>
    </CustomerQueryRs>
  </QBXMLMsgsRs>
</QBXML>`;
    const parsed = parseQBXMLResponse(xml);
    const customers = parsed.responses[0].data.CustomerRet as Record<
      string,
      unknown
    >[];
    expect(Array.isArray(customers)).toBe(true);
    const dx = customers[0].DataExtRet;
    expect(Array.isArray(dx)).toBe(true);
    expect((dx as Record<string, unknown>[])[0].DataExtName).toBe("Tax Year");
    expect((dx as Record<string, unknown>[])[0].DataExtValue).toBe(2024);
  });

  it("DataExtRet survives as an array with multiple entries", () => {
    const xml = `<?xml version="1.0"?>
<QBXML>
  <QBXMLMsgsRs>
    <CustomerQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="OK">
      <CustomerRet>
        <ListID>X-1</ListID>
        <DataExtRet>
          <OwnerID>0</OwnerID>
          <DataExtName>Tax Year</DataExtName>
          <DataExtValue>2024</DataExtValue>
        </DataExtRet>
        <DataExtRet>
          <OwnerID>0</OwnerID>
          <DataExtName>Partner</DataExtName>
          <DataExtValue>V. Vasquez</DataExtValue>
        </DataExtRet>
      </CustomerRet>
    </CustomerQueryRs>
  </QBXMLMsgsRs>
</QBXML>`;
    const parsed = parseQBXMLResponse(xml);
    const customers = parsed.responses[0].data.CustomerRet as Record<
      string,
      unknown
    >[];
    const dx = customers[0].DataExtRet as Record<string, unknown>[];
    expect(dx).toHaveLength(2);
    expect((dx[0].DataExtName as string).startsWith("Tax")).toBe(true);
    expect(dx[1].DataExtName).toBe("Partner");
  });

  it("DataExtDefRet survives as an array with a single AssignToObject", () => {
    const xml = `<?xml version="1.0"?>
<QBXML>
  <QBXMLMsgsRs>
    <DataExtDefQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="OK">
      <DataExtDefRet>
        <OwnerID>0</OwnerID>
        <DataExtName>Engagement Type</DataExtName>
        <DataExtType>STR255TYPE</DataExtType>
        <AssignToObject>Customer</AssignToObject>
      </DataExtDefRet>
    </DataExtDefQueryRs>
  </QBXMLMsgsRs>
</QBXML>`;
    const parsed = parseQBXMLResponse(xml);
    const defs = parsed.responses[0].data.DataExtDefRet as Record<
      string,
      unknown
    >[];
    expect(Array.isArray(defs)).toBe(true);
    const ato = defs[0].AssignToObject;
    expect(Array.isArray(ato)).toBe(true);
    expect(ato).toEqual(["Customer"]);
  });

  it("DataExtDefRet survives with multiple AssignToObject entries", () => {
    const xml = `<?xml version="1.0"?>
<QBXML>
  <QBXMLMsgsRs>
    <DataExtDefQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="OK">
      <DataExtDefRet>
        <OwnerID>0</OwnerID>
        <DataExtName>Project Code</DataExtName>
        <DataExtType>STR255TYPE</DataExtType>
        <AssignToObject>Invoice</AssignToObject>
        <AssignToObject>Estimate</AssignToObject>
        <AssignToObject>SalesReceipt</AssignToObject>
      </DataExtDefRet>
    </DataExtDefQueryRs>
  </QBXMLMsgsRs>
</QBXML>`;
    const parsed = parseQBXMLResponse(xml);
    const defs = parsed.responses[0].data.DataExtDefRet as Record<
      string,
      unknown
    >[];
    const ato = defs[0].AssignToObject as string[];
    expect(ato).toEqual(["Invoice", "Estimate", "SalesReceipt"]);
  });
});

// =============================================================================
// Layer 2 — sim DataExtDef discovery handler
// =============================================================================

describe("Layer 2 — sim DataExtDefQueryRq handler", () => {
  it("default call returns every seeded definition", async () => {
    const defs = await session.queryEntity("DataExtDef", {});
    // Phase 13 #61 seed defines 4 CFs: Engagement Type, Partner Assigned,
    // 1099 Box, Project Code.
    expect(defs.length).toBeGreaterThanOrEqual(4);
    const names = defs.map((d) => String(d.DataExtName));
    expect(names).toContain("Engagement Type");
    expect(names).toContain("Partner Assigned");
    expect(names).toContain("1099 Box");
    expect(names).toContain("Project Code");
  });

  it("AssignToObject filter narrows to Customer-applicable defs", async () => {
    const defs = await session.queryEntity("DataExtDef", {
      AssignToObject: "Customer",
    });
    const names = defs.map((d) => String(d.DataExtName));
    expect(names).toContain("Engagement Type");
    expect(names).toContain("Partner Assigned");
    expect(names).not.toContain("1099 Box");
    expect(names).not.toContain("Project Code");
  });

  it("AssignToObject filter narrows to Vendor-applicable defs", async () => {
    const defs = await session.queryEntity("DataExtDef", {
      AssignToObject: "Vendor",
    });
    expect(defs).toHaveLength(1);
    expect(defs[0].DataExtName).toBe("1099 Box");
  });

  it("AssignToObject matches multi-target defs (Invoice)", async () => {
    const defs = await session.queryEntity("DataExtDef", {
      AssignToObject: "Invoice",
    });
    expect(defs).toHaveLength(1);
    expect(defs[0].DataExtName).toBe("Project Code");
    // The def's AssignToObject set carries every entity it applies to.
    const ato = defs[0].AssignToObject as string[];
    expect(ato).toContain("Invoice");
    expect(ato).toContain("Estimate");
    expect(ato).toContain("SalesReceipt");
  });

  it("OwnerID filter narrows to one namespace", async () => {
    // Every seeded def has OwnerID="0". Asking for OwnerID="0" returns all.
    const allCompany = await session.queryEntity("DataExtDef", {
      OwnerID: "0",
    });
    expect(allCompany.length).toBeGreaterThanOrEqual(4);
    // Asking for a phantom UUID returns empty (statusCode 1 → flattens to []).
    const phantom = await session.queryEntity("DataExtDef", {
      OwnerID: "not-a-real-namespace-uuid",
    });
    expect(phantom).toEqual([]);
  });

  it("AssignToObject filter with no match returns empty", async () => {
    const defs = await session.queryEntity("DataExtDef", {
      AssignToObject: "BuildAssembly",
    });
    expect(defs).toEqual([]);
  });
});

// =============================================================================
// Layer 3 — sim handleQuery OwnerID gate (strip-by-default)
// =============================================================================

describe("Layer 3 — sim strips DataExtRet unless OwnerID is supplied", () => {
  it("CustomerQueryRq without OwnerID hides DataExtRet on Acme", async () => {
    const rows = await session.queryEntity("Customer", {
      ListID: "80000001-1234567890",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].DataExtRet).toBeUndefined();
  });

  it("CustomerQueryRq with OwnerID surfaces DataExtRet on Acme", async () => {
    const rows = await session.queryEntity("Customer", {
      ListID: "80000001-1234567890",
      OwnerID: "0",
    });
    expect(rows).toHaveLength(1);
    const dx = rows[0].DataExtRet as Record<string, unknown>[];
    expect(Array.isArray(dx)).toBe(true);
    expect(dx).toHaveLength(2);
    const names = dx.map((d) => String(d.DataExtName));
    expect(names).toContain("Engagement Type");
    expect(names).toContain("Partner Assigned");
  });

  it("OwnerID filter scopes to the namespace (alien OwnerID drops the key)", async () => {
    const rows = await session.queryEntity("Customer", {
      ListID: "80000001-1234567890",
      OwnerID: "alien-ns-uuid",
    });
    expect(rows).toHaveLength(1);
    // Acme's seed only stores OwnerID="0" CFs; an alien-ns request returns
    // the customer with no DataExtRet rather than retaining the wrong-namespace
    // entries.
    expect(rows[0].DataExtRet).toBeUndefined();
  });

  it("VendorQueryRq with OwnerID surfaces Joe Contractor's CF", async () => {
    const rows = await session.queryEntity("Vendor", {
      ListID: "90000003-1234567890",
      OwnerID: "0",
    });
    expect(rows).toHaveLength(1);
    const dx = rows[0].DataExtRet as Record<string, unknown>[];
    expect(dx).toHaveLength(1);
    expect(dx[0].DataExtName).toBe("1099 Box");
    expect(dx[0].DataExtValue).toBe("NEC-1");
  });

  it("InvoiceQueryRq with OwnerID surfaces the seed invoice's CF", async () => {
    const rows = await session.queryEntity("Invoice", {
      TxnID: "T0000001-INV",
      OwnerID: "0",
      // Phase 10 #41 strips lines by default — irrelevant here, we're testing
      // the OwnerID gate. The CF surfaces independent of IncludeLineItems.
    });
    expect(rows).toHaveLength(1);
    const dx = rows[0].DataExtRet as Record<string, unknown>[];
    expect(dx).toHaveLength(1);
    expect(dx[0].DataExtName).toBe("Project Code");
  });

  it("entities without any DataExt seeded come back without a DataExtRet key when OwnerID supplied", async () => {
    // Global Industries (Customer #2) carries no DataExtRet in the seed —
    // a query with OwnerID:"0" should still succeed but omit the key
    // entirely rather than emit an empty array.
    const rows = await session.queryEntity("Customer", {
      ListID: "80000002-1234567890",
      OwnerID: "0",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].DataExtRet).toBeUndefined();
  });

  it("IncludeLineItems and OwnerID compose independently", async () => {
    // Invoice with both gates lit — should surface BOTH InvoiceLineRet AND
    // DataExtRet. Lines come from #41's gate, CFs from #61's gate.
    // (The seed Invoice T0000001-INV doesn't have InvoiceLineRet in the
    // seed shape — handleAdd populates lines but the seed sets header
    // totals directly. This test verifies the GATES are independent;
    // the line surface is asserted separately in include-line-items.test.ts.)
    const rows = await session.queryEntity("Invoice", {
      TxnID: "T0000001-INV",
      IncludeLineItems: true,
      OwnerID: "0",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].DataExtRet).toBeDefined();
  });
});

// =============================================================================
// Layer 4 — tool surface
// =============================================================================

describe("Layer 4 — qb_custom_field_list tool surface", () => {
  it("returns every seeded def by default", async () => {
    const out = await call("qb_custom_field_list", {});
    expect(out.count).toBeGreaterThanOrEqual(4);
    const defs = out.customFields as Record<string, unknown>[];
    const names = defs.map((d) => String(d.DataExtName));
    expect(names).toContain("Engagement Type");
    expect(names).toContain("1099 Box");
  });

  it("filters by assignToObject:Customer", async () => {
    const out = await call("qb_custom_field_list", {
      assignToObject: "Customer",
    });
    expect(out.count).toBe(2);
    const names = (out.customFields as Record<string, unknown>[]).map((d) =>
      String(d.DataExtName),
    );
    expect(names.sort()).toEqual(["Engagement Type", "Partner Assigned"]);
  });

  it("filters by ownerId='0' (standard namespace)", async () => {
    const out = await call("qb_custom_field_list", { ownerId: "0" });
    expect(out.count).toBeGreaterThanOrEqual(4);
  });

  it("filters by ownerId='not-a-namespace' returns empty (no matching def)", async () => {
    const out = await call("qb_custom_field_list", {
      ownerId: "not-a-real-namespace",
    });
    expect(out.count).toBe(0);
    expect(out.customFields).toEqual([]);
  });

  it("returns empty for an entity type with no defined CFs (e.g. Account)", async () => {
    // Real QB exposes Account in the AssignToObject enum, but the seed has
    // no Account CFs. The handler returns count:0 cleanly — the sim's
    // statusCode 1 "no matching object" path flattens to an empty array at
    // the manager layer, the tool emits count:0 + customFields:[].
    const out = await call("qb_custom_field_list", {
      assignToObject: "Account",
    });
    expect(out.count).toBe(0);
    expect(out.customFields).toEqual([]);
  });
});

describe("Layer 4 — list tools surface DataExtRet only when opted in", () => {
  it("qb_customer_list default strips DataExtRet on Acme", async () => {
    const out = await call("qb_customer_list", {
      listId: "80000001-1234567890",
    });
    const customers = out.customers as Record<string, unknown>[];
    expect(customers[0].DataExtRet).toBeUndefined();
  });

  it("qb_customer_list includeCustomFields:true surfaces DataExtRet on Acme", async () => {
    const out = await call("qb_customer_list", {
      listId: "80000001-1234567890",
      includeCustomFields: true,
    });
    const customers = out.customers as Record<string, unknown>[];
    const dx = customers[0].DataExtRet as Record<string, unknown>[];
    expect(Array.isArray(dx)).toBe(true);
    expect(dx).toHaveLength(2);
  });

  it("qb_customer_list includeCustomFields:true respects customFieldOwnerId override", async () => {
    const out = await call("qb_customer_list", {
      listId: "80000001-1234567890",
      includeCustomFields: true,
      customFieldOwnerId: "alien-ns",
    });
    // Alien namespace yields no matching CFs → the key drops entirely.
    const customers = out.customers as Record<string, unknown>[];
    expect(customers[0].DataExtRet).toBeUndefined();
  });

  it("qb_vendor_list includeCustomFields:true surfaces Joe Contractor's CF", async () => {
    const out = await call("qb_vendor_list", {
      listId: "90000003-1234567890",
      includeCustomFields: true,
    });
    const vendors = out.vendors as Record<string, unknown>[];
    const dx = vendors[0].DataExtRet as Record<string, unknown>[];
    expect(dx).toHaveLength(1);
    expect(dx[0].DataExtValue).toBe("NEC-1");
  });

  it("qb_invoice_list includeCustomFields:true surfaces Project Code on the seed invoice", async () => {
    const out = await call("qb_invoice_list", {
      txnId: "T0000001-INV",
      includeCustomFields: true,
    });
    const invoices = out.invoices as Record<string, unknown>[];
    const dx = invoices[0].DataExtRet as Record<string, unknown>[];
    expect(dx).toHaveLength(1);
    expect(dx[0].DataExtName).toBe("Project Code");
    expect(dx[0].DataExtValue).toBe("PRJ-2024-Q4");
  });

  it("qb_invoice_list default strips DataExtRet (no opt-in)", async () => {
    const out = await call("qb_invoice_list", { txnId: "T0000001-INV" });
    const invoices = out.invoices as Record<string, unknown>[];
    expect(invoices[0].DataExtRet).toBeUndefined();
  });
});
