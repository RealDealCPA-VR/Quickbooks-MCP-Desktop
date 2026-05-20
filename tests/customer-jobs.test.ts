// Phase 13 #62 — Sub-customer / job hierarchy helpers.
//
// Coverage layers:
//   1. Parser — CustomerRet's ParentRef + Sublevel round-trip cleanly. ParentRef
//      is a single nested element (object), not an array; Sublevel is numeric.
//   2. Sim store — seed pins (Acme is Sublevel 0; jobs of Acme carry Sublevel 1
//      with ParentRef.ListID === Acme; sub-sub-customer carries Sublevel 2 with
//      ParentRef.ListID === audit-job ListID). addEntity("Customer", ...) with
//      ParentRef derives FullName = `Parent:Child`, sets Sublevel from the
//      parent chain, hydrates ParentRef.FullName from the store; unknown
//      parent ListID rejects with 3120.
//   3. Tool surface — qb_customer_jobs (parent resolution, direct vs recursive
//      walk, validation paths, sort, includeInactive), qb_customer_list
//      hierarchy post-filters (parentListID, jobOnly, AND-combine, pagination),
//      qb_customer_add with parentListId end-to-end.

import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerCustomerTools } from "../src/tools/customers.js";
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

const ACME_LIST_ID = "80000001-1234567890";
const ACME_AUDIT_LIST_ID = "80000001-1234567891";
const ACME_TAX_LIST_ID = "80000001-1234567892";
const ACME_Q3_LIST_ID = "80000001-1234567893";
const ACME_FIELDWORK_LIST_ID = "80000001-1234567894";

beforeAll(async () => {
  session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-customer-jobs",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  registerCustomerTools(fakeServer as never, () => session);
  await session.openSession();
});

async function call(
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
  const handler = handlers.get(toolName);
  if (!handler) throw new Error(`tool not registered: ${toolName}`);
  const result = await handler(args);
  return {
    payload: JSON.parse(result.content[0].text) as Record<string, unknown>,
    isError: result.isError === true,
  };
}

// =============================================================================
// Layer 1 — parser round-trip for ParentRef + Sublevel
// =============================================================================

describe("Layer 1 — parser surfaces ParentRef + Sublevel on CustomerRet", () => {
  it("ParentRef parses as an object with ListID + FullName; Sublevel as number", () => {
    const xml = `<?xml version="1.0"?>
<QBXML>
  <QBXMLMsgsRs>
    <CustomerQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="OK">
      <CustomerRet>
        <ListID>80000001-1234567891</ListID>
        <Name>2024 Audit</Name>
        <FullName>Acme Corporation:2024 Audit</FullName>
        <IsActive>true</IsActive>
        <Sublevel>1</Sublevel>
        <ParentRef>
          <ListID>80000001-1234567890</ListID>
          <FullName>Acme Corporation</FullName>
        </ParentRef>
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
    const c = customers[0];
    expect(c.FullName).toBe("Acme Corporation:2024 Audit");
    expect(c.Sublevel).toBe(1);
    const parent = c.ParentRef as Record<string, unknown>;
    expect(Array.isArray(parent)).toBe(false); // single object, NOT array
    expect(parent.ListID).toBe("80000001-1234567890");
    expect(parent.FullName).toBe("Acme Corporation");
  });

  it("top-level CustomerRet (no ParentRef child) parses without a phantom ParentRef key", () => {
    const xml = `<?xml version="1.0"?>
<QBXML>
  <QBXMLMsgsRs>
    <CustomerQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="OK">
      <CustomerRet>
        <ListID>80000001-1234567890</ListID>
        <Name>Acme Corporation</Name>
        <FullName>Acme Corporation</FullName>
        <Sublevel>0</Sublevel>
      </CustomerRet>
    </CustomerQueryRs>
  </QBXMLMsgsRs>
</QBXML>`;
    const parsed = parseQBXMLResponse(xml);
    const c = (parsed.responses[0].data.CustomerRet as Record<string, unknown>[])[0];
    expect(c.Sublevel).toBe(0);
    expect("ParentRef" in c).toBe(false);
  });
});

// =============================================================================
// Layer 2 — Simulation store seed + ParentRef derivation on add
// =============================================================================

describe("Layer 2 — sim store seed carries the Acme hierarchy", () => {
  it("Acme Corporation (parent) carries Sublevel 0 and no ParentRef", async () => {
    const rows = await session.queryEntity("Customer", { ListID: ACME_LIST_ID });
    expect(rows).toHaveLength(1);
    const acme = rows[0] as Record<string, unknown>;
    expect(acme.FullName).toBe("Acme Corporation");
    expect(acme.Sublevel).toBe(0);
    expect("ParentRef" in acme).toBe(false);
  });

  it("Acme:2024 Audit carries Sublevel 1 with ParentRef pointing to Acme", async () => {
    const rows = await session.queryEntity("Customer", { ListID: ACME_AUDIT_LIST_ID });
    expect(rows).toHaveLength(1);
    const job = rows[0] as Record<string, unknown>;
    expect(job.FullName).toBe("Acme Corporation:2024 Audit");
    expect(job.Sublevel).toBe(1);
    expect(job.Balance).toBe(0); // jobs hold no AR; parent does
    const parent = job.ParentRef as Record<string, unknown>;
    expect(parent.ListID).toBe(ACME_LIST_ID);
    expect(parent.FullName).toBe("Acme Corporation");
  });

  it("Acme:2024 Audit:Fieldwork Phase 1 carries Sublevel 2 (multi-level hierarchy)", async () => {
    const rows = await session.queryEntity("Customer", { ListID: ACME_FIELDWORK_LIST_ID });
    expect(rows).toHaveLength(1);
    const subJob = rows[0] as Record<string, unknown>;
    expect(subJob.FullName).toBe("Acme Corporation:2024 Audit:Fieldwork Phase 1");
    expect(subJob.Sublevel).toBe(2);
    const parent = subJob.ParentRef as Record<string, unknown>;
    expect(parent.ListID).toBe(ACME_AUDIT_LIST_ID);
    expect(parent.FullName).toBe("Acme Corporation:2024 Audit");
  });

  it("seed: total customer count includes both top-level (3) + sub-customers (4)", async () => {
    const rows = await session.queryEntity("Customer", {});
    // 3 top-level (Acme, Global, TechStart) + 3 first-level jobs of Acme + 1 sub-sub-job
    expect(rows.length).toBeGreaterThanOrEqual(7);
  });
});

describe("Layer 2 — addEntity('Customer', {ParentRef}) derives FullName + Sublevel", () => {
  it("ParentRef.ListID resolves to Parent:Child FullName, Sublevel = parent + 1, hydrated ParentRef.FullName", async () => {
    const created = await session.addEntity("Customer", {
      Name: "2025 Audit",
      ParentRef: { ListID: ACME_LIST_ID },
    });
    expect(created.FullName).toBe("Acme Corporation:2025 Audit");
    expect(created.Sublevel).toBe(1);
    const ref = created.ParentRef as Record<string, unknown>;
    expect(ref.ListID).toBe(ACME_LIST_ID);
    expect(ref.FullName).toBe("Acme Corporation");
  });

  it("multi-level: adding a sub-job under the audit chains Sublevel to 2", async () => {
    const created = await session.addEntity("Customer", {
      Name: "Wrap-up",
      ParentRef: { ListID: ACME_AUDIT_LIST_ID },
    });
    expect(created.FullName).toBe("Acme Corporation:2024 Audit:Wrap-up");
    expect(created.Sublevel).toBe(2);
    const ref = created.ParentRef as Record<string, unknown>;
    expect(ref.FullName).toBe("Acme Corporation:2024 Audit");
  });

  it("no ParentRef → top-level customer with Sublevel 0", async () => {
    const created = await session.addEntity("Customer", { Name: "New Top Client" });
    expect(created.Sublevel).toBe(0);
    expect(created.FullName).toBe("New Top Client");
    expect("ParentRef" in created).toBe(false);
  });

  it("unknown ParentRef.ListID rejects with statusCode 3120 BEFORE persist", async () => {
    await expect(
      session.addEntity("Customer", {
        Name: "Orphan",
        ParentRef: { ListID: "bogus-parent-9999" },
      })
    ).rejects.toMatchObject({ statusCode: 3120 });

    // Confirm the doomed entity did not leak into the store.
    const rows = await session.queryEntity("Customer", {});
    expect(rows.some((r) => (r as Record<string, unknown>).Name === "Orphan")).toBe(false);
  });
});

// =============================================================================
// Layer 3 — Tool surface: qb_customer_jobs
// =============================================================================

describe("Layer 3 — qb_customer_jobs default (direct children) + parent context", () => {
  it("by parentListId: returns Acme's 3 seeded direct jobs + parent context", async () => {
    const { payload, isError } = await call("qb_customer_jobs", {
      parentListId: ACME_LIST_ID,
    });
    expect(isError).toBe(false);
    expect(payload.recursive).toBe(false);
    const parent = payload.parent as Record<string, unknown>;
    expect(parent.listId).toBe(ACME_LIST_ID);
    expect(parent.fullName).toBe("Acme Corporation");
    expect(parent.balance).toBe(15000); // parent holds the consolidated AR

    const jobs = payload.jobs as Record<string, unknown>[];
    const seededJobNames = new Set([
      "Acme Corporation:2024 Audit",
      "Acme Corporation:2024 Tax Prep",
      "Acme Corporation:Q3 Review",
    ]);
    const seededHits = jobs.filter((j) => seededJobNames.has(String(j.FullName)));
    expect(seededHits).toHaveLength(3);

    // Direct-children-only — the sub-sub Fieldwork Phase 1 must NOT appear.
    expect(jobs.some((j) => j.FullName === "Acme Corporation:2024 Audit:Fieldwork Phase 1"))
      .toBe(false);
  });

  it("by parentName: resolves the same parent context as parentListId", async () => {
    const byName = await call("qb_customer_jobs", { parentName: "Acme Corporation" });
    expect(byName.isError).toBe(false);
    const parent = byName.payload.parent as Record<string, unknown>;
    expect(parent.listId).toBe(ACME_LIST_ID);
    expect(parent.fullName).toBe("Acme Corporation");
  });

  it("Sublevel-then-FullName sort: all returned jobs are direct children (Sublevel === parent + 1)", async () => {
    const { payload } = await call("qb_customer_jobs", { parentListId: ACME_LIST_ID });
    const jobs = payload.jobs as Record<string, unknown>[];
    for (const j of jobs) {
      expect(j.Sublevel).toBe(1);
    }
    // Alphabetical within the level.
    const names = jobs.map((j) => String(j.FullName));
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it("nested parent: jobs of the Audit engagement → Fieldwork Phase 1 (Sublevel 2)", async () => {
    const { payload } = await call("qb_customer_jobs", { parentListId: ACME_AUDIT_LIST_ID });
    const jobs = payload.jobs as Record<string, unknown>[];
    const fieldwork = jobs.find(
      (j) => j.FullName === "Acme Corporation:2024 Audit:Fieldwork Phase 1"
    );
    expect(fieldwork).toBeDefined();
    expect(fieldwork?.Sublevel).toBe(2);
  });
});

describe("Layer 3 — qb_customer_jobs recursive walk", () => {
  it("recursive:true under Acme picks up direct jobs AND the sub-sub Fieldwork Phase 1", async () => {
    const { payload } = await call("qb_customer_jobs", {
      parentListId: ACME_LIST_ID,
      recursive: true,
    });
    expect(payload.recursive).toBe(true);
    const jobs = payload.jobs as Record<string, unknown>[];
    const fns = jobs.map((j) => String(j.FullName));
    expect(fns).toContain("Acme Corporation:2024 Audit");
    expect(fns).toContain("Acme Corporation:2024 Tax Prep");
    expect(fns).toContain("Acme Corporation:Q3 Review");
    expect(fns).toContain("Acme Corporation:2024 Audit:Fieldwork Phase 1");

    // Excludes parent itself.
    expect(fns).not.toContain("Acme Corporation");

    // Sort: Sublevel ASC then FullName — direct jobs (level 1) before sub-sub (level 2).
    const levels = jobs.map((j) => Number(j.Sublevel ?? 0));
    const levelsSorted = [...levels].sort((a, b) => a - b);
    expect(levels).toEqual(levelsSorted);
  });

  it("recursive:true does NOT bleed into a sibling top-level customer's jobs", async () => {
    const { payload } = await call("qb_customer_jobs", {
      parentListId: ACME_LIST_ID,
      recursive: true,
    });
    const jobs = payload.jobs as Record<string, unknown>[];
    // Global / TechStart have no jobs in seed, but the prefix check must still
    // refuse to pick them up.
    expect(jobs.some((j) => String(j.FullName).startsWith("Global"))).toBe(false);
    expect(jobs.some((j) => String(j.FullName).startsWith("TechStart"))).toBe(false);
  });

  it("recursive:true on a leaf engagement returns an empty array (no children)", async () => {
    // Tax Prep has no children in seed.
    const { payload, isError } = await call("qb_customer_jobs", {
      parentListId: ACME_TAX_LIST_ID,
      recursive: true,
    });
    expect(isError).toBe(false);
    expect(payload.count).toBe(0);
    expect((payload.jobs as unknown[])).toEqual([]);
  });
});

describe("Layer 3 — qb_customer_jobs validation paths", () => {
  it("both parentListId AND parentName → 3120", async () => {
    const { payload, isError } = await call("qb_customer_jobs", {
      parentListId: ACME_LIST_ID,
      parentName: "Acme Corporation",
    });
    expect(isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(payload.statusCode).toBe(3120);
  });

  it("neither parentListId NOR parentName → 3120", async () => {
    const { payload, isError } = await call("qb_customer_jobs", {});
    expect(isError).toBe(true);
    expect(payload.statusCode).toBe(3120);
  });

  it("unknown parentListId → 3120 (pre-flight, NOT silent empty array)", async () => {
    const { payload, isError } = await call("qb_customer_jobs", {
      parentListId: "bogus-customer-9999",
    });
    expect(isError).toBe(true);
    expect(payload.statusCode).toBe(3120);
    expect(String(payload.statusMessage)).toContain("bogus-customer-9999");
  });

  it("unknown parentName → 3120 (pre-flight)", async () => {
    const { payload, isError } = await call("qb_customer_jobs", {
      parentName: "Does Not Exist LLC",
    });
    expect(isError).toBe(true);
    expect(payload.statusCode).toBe(3120);
    expect(String(payload.statusMessage)).toContain("Does Not Exist LLC");
  });
});

describe("Layer 3 — qb_customer_jobs includeInactive flag", () => {
  it("default excludes inactive jobs; includeInactive:true surfaces them", async () => {
    // Real QB CustomerAddRq always creates customers active — IsActive is set
    // via CustomerModRq, not on add. The sim mirrors (handleAdd hardcodes
    // IsActive: true on creation). To exercise the inactive path: create the
    // job active, then deactivate via modifyEntity.
    const created = await session.addEntity("Customer", {
      Name: "Closed Engagement",
      ParentRef: { ListID: ACME_LIST_ID },
    });
    const inactiveListId = String((created as Record<string, unknown>).ListID);
    const editSequence = String((created as Record<string, unknown>).EditSequence);
    await session.modifyEntity("Customer", {
      ListID: inactiveListId,
      EditSequence: editSequence,
      IsActive: false,
    });

    const defaultRes = await call("qb_customer_jobs", { parentListId: ACME_LIST_ID });
    const defaultNames = (defaultRes.payload.jobs as Record<string, unknown>[]).map((j) =>
      String(j.FullName)
    );
    expect(defaultNames).not.toContain("Acme Corporation:Closed Engagement");

    const inclusiveRes = await call("qb_customer_jobs", {
      parentListId: ACME_LIST_ID,
      includeInactive: true,
    });
    const inclusiveNames = (inclusiveRes.payload.jobs as Record<string, unknown>[]).map((j) =>
      String(j.FullName)
    );
    expect(inclusiveNames).toContain("Acme Corporation:Closed Engagement");

    // Clean up so subsequent tests aren't affected by extra rows.
    await session.deleteEntity("Customer", inactiveListId);
  });
});

// =============================================================================
// Layer 3 — Tool surface: qb_customer_list hierarchy post-filters
// =============================================================================

describe("Layer 3 — qb_customer_list hierarchy post-filters", () => {
  it("default (no filters) includes both top-level and sub-customers", async () => {
    const { payload, isError } = await call("qb_customer_list", {});
    expect(isError).toBe(false);
    const customers = payload.customers as Record<string, unknown>[];
    expect(customers.some((c) => c.FullName === "Acme Corporation")).toBe(true);
    expect(customers.some((c) => c.FullName === "Acme Corporation:2024 Audit")).toBe(true);
  });

  it("parentListID: only direct children of Acme (3 seeded jobs)", async () => {
    const { payload } = await call("qb_customer_list", {
      parentListID: ACME_LIST_ID,
    });
    const customers = payload.customers as Record<string, unknown>[];
    const seededHits = customers.filter((c) => {
      const ref = c.ParentRef as Record<string, unknown> | undefined;
      return ref?.ListID === ACME_LIST_ID;
    });
    expect(seededHits.length).toBeGreaterThanOrEqual(3);

    // Sub-sub Fieldwork has ParentRef → Audit, not Acme — must NOT appear under parentListID(Acme).
    expect(
      customers.some((c) => c.FullName === "Acme Corporation:2024 Audit:Fieldwork Phase 1")
    ).toBe(false);

    // Top-level Acme/Global/TechStart must NOT appear either.
    expect(customers.some((c) => c.FullName === "Acme Corporation")).toBe(false);
  });

  it("jobOnly:true excludes top-level customers, keeps every sub-customer (Sublevel > 0)", async () => {
    const { payload } = await call("qb_customer_list", { jobOnly: true });
    const customers = payload.customers as Record<string, unknown>[];
    expect(customers.length).toBeGreaterThanOrEqual(4);
    for (const c of customers) {
      // Every returned row carries a ParentRef.
      expect(c.ParentRef).toBeDefined();
    }
    expect(customers.some((c) => c.FullName === "Acme Corporation")).toBe(false);
    expect(customers.some((c) => c.FullName === "Global Industries")).toBe(false);
    // Sub-sub Fieldwork IS a sub-customer (Sublevel 2) — must appear.
    expect(
      customers.some((c) => c.FullName === "Acme Corporation:2024 Audit:Fieldwork Phase 1")
    ).toBe(true);
  });

  it("parentListID + jobOnly AND-combine (every direct child IS a sub-customer)", async () => {
    const { payload } = await call("qb_customer_list", {
      parentListID: ACME_LIST_ID,
      jobOnly: true,
    });
    const customers = payload.customers as Record<string, unknown>[];
    for (const c of customers) {
      const ref = c.ParentRef as Record<string, unknown>;
      expect(ref.ListID).toBe(ACME_LIST_ID);
      expect(Number(c.Sublevel)).toBeGreaterThan(0);
    }
  });

  it("paginate:true threads hierarchy filters through the iterator path", async () => {
    // Pagination + post-filter is a documented combo with a caveat (matches
    // past first batch can be missed). Pin that under the small seed it
    // still applies the filter on the returned batch correctly.
    const { payload } = await call("qb_customer_list", {
      paginate: true,
      jobOnly: true,
    });
    const customers = payload.customers as Record<string, unknown>[];
    for (const c of customers) {
      expect(c.ParentRef).toBeDefined();
    }
    expect(payload.iteratorRemainingCount).toBe(0);
    expect(typeof payload.iteratorID).toBe("string");
  });
});

// =============================================================================
// Layer 3 — Tool surface: qb_customer_add with parentListId
// =============================================================================

describe("Layer 3 — qb_customer_add with parentListId creates a sub-customer", () => {
  it("parentListId on add → derived FullName + Sublevel + hydrated ParentRef", async () => {
    const { payload, isError } = await call("qb_customer_add", {
      name: "Special Project",
      parentListId: ACME_LIST_ID,
    });
    expect(isError).toBe(false);
    expect(payload.success).toBe(true);
    const customer = payload.customer as Record<string, unknown>;
    expect(customer.Name).toBe("Special Project");
    expect(customer.FullName).toBe("Acme Corporation:Special Project");
    expect(customer.Sublevel).toBe(1);
    const ref = customer.ParentRef as Record<string, unknown>;
    expect(ref.ListID).toBe(ACME_LIST_ID);
    expect(ref.FullName).toBe("Acme Corporation");
  });

  it("creating a job under an existing job chains Sublevel to 2", async () => {
    const { payload } = await call("qb_customer_add", {
      name: "Phase 2 Substantive Testing",
      parentListId: ACME_AUDIT_LIST_ID,
    });
    const customer = payload.customer as Record<string, unknown>;
    expect(customer.FullName).toBe(
      "Acme Corporation:2024 Audit:Phase 2 Substantive Testing"
    );
    expect(customer.Sublevel).toBe(2);
    const ref = customer.ParentRef as Record<string, unknown>;
    expect(ref.FullName).toBe("Acme Corporation:2024 Audit");
  });

  it("unknown parentListId → 3120 via the tool's error envelope", async () => {
    const { payload, isError } = await call("qb_customer_add", {
      name: "Orphan Job",
      parentListId: "bogus-9999",
    });
    expect(isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(payload.statusCode).toBe(3120);
  });

  it("no parentListId → top-level customer (Sublevel 0, no ParentRef)", async () => {
    const { payload, isError } = await call("qb_customer_add", {
      name: "Brand New Client Inc",
    });
    expect(isError).toBe(false);
    const customer = payload.customer as Record<string, unknown>;
    expect(customer.Sublevel).toBe(0);
    expect("ParentRef" in customer).toBe(false);
  });

  it("idempotencyKey replay returns the SAME sub-customer (FullName + Sublevel preserved)", async () => {
    const key = "vitest-customer-jobs-idem-1";
    const first = await call("qb_customer_add", {
      name: "Idempotent Job",
      parentListId: ACME_LIST_ID,
      idempotencyKey: key,
    });
    const second = await call("qb_customer_add", {
      name: "Idempotent Job",
      parentListId: ACME_LIST_ID,
      idempotencyKey: key,
    });
    expect((first.payload.customer as Record<string, unknown>).ListID).toBe(
      (second.payload.customer as Record<string, unknown>).ListID
    );
    expect(second.payload.idempotentReplay).toBe(true);
  });
});

// =============================================================================
// Layer 3 — Round-trip: qb_customer_jobs picks up tool-created sub-customers
// =============================================================================

describe("Layer 3 — round-trip: jobs created via qb_customer_add show up under qb_customer_jobs", () => {
  it("add then list under same parent returns the new job", async () => {
    // Use a unique parent ListID — TechStart — so the test is isolated from
    // mutations in earlier blocks that targeted Acme.
    const newJobName = "Q4 Implementation";
    await call("qb_customer_add", {
      name: newJobName,
      parentListId: "80000003-1234567890", // TechStart Solutions
    });

    const { payload } = await call("qb_customer_jobs", {
      parentListId: "80000003-1234567890",
    });
    const parent = payload.parent as Record<string, unknown>;
    expect(parent.fullName).toBe("TechStart Solutions");

    const jobs = payload.jobs as Record<string, unknown>[];
    const match = jobs.find((j) => j.FullName === `TechStart Solutions:${newJobName}`);
    expect(match).toBeDefined();
    expect(match?.Sublevel).toBe(1);
  });
});

// keep ts happy about unused locals
void ACME_Q3_LIST_ID;
