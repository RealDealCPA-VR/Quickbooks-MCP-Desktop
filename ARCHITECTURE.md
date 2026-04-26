# Architecture

This document defines the stable structural rules of the QuickBooks Desktop MCP server. Update only when a structural rule intentionally changes — and when you do, log the change in `DECISIONS.md`.

---

## System at a Glance

```
┌──────────────────┐    JSON-RPC over stdio     ┌──────────────────────────────────────────┐
│  MCP client      │ ◄────────────────────────► │  QuickBooks Desktop MCP Server (this)    │
│  (Claude, etc.)  │                            │                                          │
└──────────────────┘                            │  ┌────────────────────────────────────┐  │
                                                │  │ Tool layer (src/tools/*.ts)         │  │
                                                │  │ — zod-validated handlers            │  │
                                                │  │ — one file per entity domain        │  │
                                                │  └──────────────┬─────────────────────┘  │
                                                │                 │                         │
                                                │                 ▼                         │
                                                │  ┌────────────────────────────────────┐  │
                                                │  │ Session manager                     │  │
                                                │  │ (src/session/manager.ts)            │  │
                                                │  │ — queryEntity / addEntity / etc.    │  │
                                                │  │ — mode switch (live | simulation)   │  │
                                                │  └────────┬───────────────────┬────────┘  │
                                                │           │                   │           │
                                                │           ▼                   ▼           │
                                                │  ┌──────────────┐   ┌──────────────────┐  │
                                                │  │ QBXML        │   │ Simulation store │  │
                                                │  │ builder +    │   │ (in-memory Maps) │  │
                                                │  │ parser       │   │ src/session/     │  │
                                                │  │ src/qbxml/   │   │ simulation-      │  │
                                                │  └──────┬───────┘   │ store.ts         │  │
                                                │         │           └──────────────────┘  │
                                                │         ▼                                  │
                                                │  ┌────────────────────────────────────┐   │
                                                │  │ LIVE: QBXMLRP2 COM (Windows only)  │   │
                                                │  │ — currently stubbed                 │   │
                                                │  └────────────────────────────────────┘   │
                                                └──────────────────────────────────────────┘
```

---

## Module Boundaries

The codebase has four layers. Each layer has one responsibility. Crossing layers is the most common form of drift — don't.

| Layer | Path | Responsibility | Must NOT do |
|---|---|---|---|
| **Tool** | `src/tools/*.ts` | Validate input with zod, translate to entity-shaped data, call session manager, format response for MCP. | Construct QBXML strings. Read/write the simulation store directly. Hold persistent state. |
| **Session** | `src/session/manager.ts` | Manage connection lifecycle. Dispatch QBXML requests to live or simulation. Provide entity-level helpers (`queryEntity`, `addEntity`, `modifyEntity`, `deleteEntity`, `runReport`). | Know about specific tools. Validate user input. Format MCP responses. |
| **QBXML** | `src/qbxml/builder.ts`, `src/qbxml/parser.ts` | Serialize structured requests to QBXML strings. Parse QBXML responses to structured objects. | Hold state. Decide which entities are transactions vs. lists (that's a shared concern — see invariant below). Talk to the simulation store. |
| **Simulation** | `src/session/simulation-store.ts` | In-memory implementation of the QBXML protocol for dev. Seed realistic data. Process Query/Add/Mod/Del requests with the same response shape live mode would produce. | Be imported by tools. Diverge in behavior from what live mode would produce. |
| **Types** | `src/types/qbxml.ts` | Shared type definitions for connection config, QBXML envelope, and entity shapes. | Contain runtime logic. |
| **Entrypoint** | `src/index.ts` | Construct the MCP server, register every tool module, expose the operator-facing `instructions` blurb, start the stdio transport. | Implement tool logic. Construct session managers per-tool (one shared lazy instance). |

### Boundary Invariants

These rules are non-negotiable unless explicitly changed via `DECISIONS.md`.

1. **Tools never see XML.** They speak in JS objects to the session manager. If a tool needs to construct an unusual QBXML shape, extend the builder, don't inline a string.
2. **Simulation and live must be observationally identical.** A tool can't tell which mode it's running in by reading the response. If you change the simulation, change live (or stub the change) so they stay in sync.
3. **One session manager instance per process.** Created lazily in [src/index.ts:112-117](src/index.ts#L112-L117) and shared via `getSessionManager`. Tools receive `getSession: () => QBSessionManager`, never construct their own.
4. **Tool registration is centralized.** Every `register*Tools(server, getSession)` call lives in [src/index.ts](src/index.ts). Adding a tool module means adding the import and the call there — and updating the `instructions` block in the same file.
5. **Transaction-vs-List classification is a shared constant in three places** ([builder.ts:115-131](src/qbxml/builder.ts#L115-L131), [manager.ts:200-203](src/session/manager.ts#L200-L203), [simulation-store.ts:359-366](src/session/simulation-store.ts#L359-L366)). Until extracted, all three must be updated together when a new transaction type is added. Extracting to a shared constant is a deferred refactor — see `DECISIONS.md`.
6. **Parser `arrayElements` is the contract** for which response elements collapse to single objects vs. always-arrays. New `*Ret` element names must be registered in [src/qbxml/parser.ts:27-61](src/qbxml/parser.ts#L27-L61) or downstream code will break on single-element responses.
7. **Item types are not generic.** Real QBXML uses `ItemServiceQueryRq`, `ItemInventoryAddRq`, etc. — there is no generic `ItemQueryRq`. The four `qb_item_*` tools take an `itemType` arg (`Service` / `Inventory` / `NonInventory` / `OtherCharge` / `Group`) and route to `Item<Subtype>*Rq` accordingly; `qb_item_list` fans out across all five subtypes when `itemType` is omitted.

---

## Data Flow

### A typical tool call (read path)

1. MCP client invokes a tool over stdio (e.g. `qb_customer_list`).
2. MCP SDK validates input against the tool's zod schema.
3. Tool handler in `src/tools/customers.ts` translates parameters into a QBXML filter object (e.g. `{ NameFilter: { MatchCriterion: "Contains", Name: "Acme" } }`).
4. Handler calls `session.queryEntity("Customer", filters)`.
5. Session manager calls `buildQueryRequest` → produces a QBXML string.
6. **Mode branch:**
   - **Simulation:** `simulationStore.processRequest(xml)` parses the request with `fast-xml-parser`, applies filters, returns a structured `QBXMLResponse`.
   - **Live (currently stubbed):** would call `QBXMLRP2.RequestProcessor.ProcessRequest(ticket, xml)` → response XML → `parseQBXMLResponse`.
7. Session manager extracts the entity array via `extractResponseData` + `flattenEntityArray`.
8. Tool handler wraps the array in `{ count, customers }` and returns as MCP text content.

### A typical tool call (write path)

Same as read, but step 5 calls `buildAddRequest` / `buildModRequest` / `buildDeleteRequest`, and the simulation store's `handleAdd` / `handleMod` / `handleListDel` / `handleTxnDel` mutates the in-memory store and returns the persisted entity.

### Session lifecycle

* Session is opened lazily on the first `sendRequest` call (or explicitly via `qb_session_connect`).
* Single session per process.
* Closed explicitly via `qb_session_disconnect` or implicitly when the process exits.
* In simulation mode the "session" is a synthetic ticket; in live mode it's a real QBXMLRP2 ticket.

---

## Operating Modes

| Mode | Trigger | Behavior |
|---|---|---|
| **Simulation** | Default everywhere. Forced when `process.platform !== "win32"` or `QB_LIVE` is unset. | All requests served from in-memory `SimulationStore`. Seed data preloaded. Safe for dev/tests. |
| **Live** | `process.platform === "win32"` AND `QB_LIVE=1` AND `QB_SIMULATION !== "true"`. **Currently stubbed — throws.** | Would talk to QuickBooks Desktop via QBXMLRP2 COM. Implementation pending (Phase 7 of `todo.md`). |

The mode is detected once in the session manager constructor and is immutable for the process lifetime.

> ⚠️ The `QB_SIMULATION=false` case on Windows without `QB_LIVE=1` currently still simulates. This is a known semantics bug captured as Phase 6 item 23 in `todo.md`.

---

## Tool Conventions

Every tool follows this shape:

```ts
server.tool(
  "qb_<domain>_<verb>",                              // snake_case, qb_ prefix, verb is list|add|update|delete|<custom>
  "Imperative description of what the tool does.",   // ends in a period
  {
    paramName: z.string().optional().describe("..."), // every field has .describe()
  },
  async (args) => {
    const session = getSession();
    // ... translate args to entity data ...
    const result = await session.<queryEntity|addEntity|...>(...);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ /* structured result */ }, null, 2),
      }],
    };
  }
);
```

Error responses use `isError: true`:

```ts
return {
  content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "..." }) }],
  isError: true,
};
```

---

## Persistence

* **Simulation:** in-memory `Map<string, EntityStore>`, where `EntityStore = Map<id, StoredEntity>`. Lost on process exit. Seeded on construction.
* **Live:** persistence is QuickBooks Desktop's `.qbw` file. The MCP server is stateless beyond the session ticket.

There is no project-side persistent storage today. If we ever need to cache live responses or persist a request log, that's a new subsystem and requires an `ARCHITECTURE.md` update.

---

## Configuration

All configuration is environment-variable driven and resolved once in [src/index.ts:56-62](src/index.ts#L56-L62) into a `QBConnectionConfig` object passed to the session manager. The full list lives in `README.md`. New env vars must be documented in both `README.md` and `.env.example` (once that file exists per Phase 8 item 32).

---

## Build & Runtime

* TypeScript compiled with `tsc` (config in [tsconfig.json](tsconfig.json)) to `dist/`.
* `target: ES2022`, `module: Node16`, `moduleResolution: Node16`, `strict: true`.
* ESM modules — all relative imports must include the `.js` extension.
* Runtime: Node.js (no specific minimum pinned yet; `@types/node: ^22` suggests Node 22+ is the dev target).

---

## What This Architecture Does Not Yet Cover

These are deferred subsystems. When introduced, they require an architecture update:

* **HTTP / WebSocket transport** alongside stdio.
* **Persistent caching** of live responses.
* **Iterator-based pagination** for large queries (Phase 6 item 27).
* **Multi-company-file** support (one process serving multiple `.qbw` files).
* **A real test harness** (Phase 8 item 31). When added, define where tests live, how they boot the server, and how they isolate the simulation store.
