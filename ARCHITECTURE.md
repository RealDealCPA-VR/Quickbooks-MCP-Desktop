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
* **Company switching (live).** `switchCompanyFile` closes the SDK session, then tries `BeginSession` on the new file. On failure, `attemptLaunchAndAttach` may (a) gracefully close QB Desktop (`closeCurrentCompany`; WM_CLOSE to the `MauiFrame` window via `scripts/qb-close-desktop.ps1`, never a kill), (b) spawn QB on the `.qbw`, (c) start `scripts/qb-login-autofill.ps1` to fill QB's login window from the vault, and (d) poll `openSession` on `QB_LAUNCH_POLL_MS` (90s). The exe is resolved before anything is closed. If QB is running and the caller didn't allow a close, it never spawns a second QB instance; it only polls.

### QBHost: the QuickBooks machine behind one interface (added 2026-10-06)

* [src/session/qb-host.ts](src/session/qb-host.ts) defines `QBHost`: the COM handle factory, QB running / exe / launch / graceful close / force close, health, file exists, `.qbw` discovery, drives, browse, saved-login check and login autofill. All of it is async.
* `localQBHost` is this PC (the original behavior). `QBSessionManager(config, host = localQBHost)` takes its machine seams (`rpFactory`, `spawnImpl`, `isQBRunningImpl`, ...) from the host; `getHost()` exposes it.
* **Rule:** the web page and tools reach the QuickBooks machine only through `session.getHost()`, never by importing `qb-desktop-launch` / `qb-health` / `company-files` / `fs-browse` directly. This is the seam where the remote connector plugs in (docs/CONNECTOR_DESIGN.md).

### Out-of-process COM + idle release (added 2026-10-06)

* **QBXMLRP2 runs in a helper process.** [src/session/com-worker.ts](src/session/com-worker.ts) is the ONLY code that loads `winax`.
  * The session manager talks to it through [com-worker-client.ts](src/session/com-worker-client.ts) (`WorkerRequestProcessor`): the same five methods (`OpenConnection2`, `BeginSession`, `ProcessRequest`, `EndSession`, `CloseConnection`), async, over Node IPC.
  * There is one helper per live session, forked with the server's own Node (20).
* **Why:** after QuickBooks was ended in Task Manager, a COM call segfaulted the whole MCP server (exit 139), live on 2026-10-05.
  * Now a native crash kills only the helper. Pending calls reject with "QuickBooks COM helper exited…", which `isQuickBooksGoneError` classifies as QB-gone, so recovery forks a new helper.
* **Time limits** per call (`COM_TIMEOUTS`): open 2 min, begin 5 min, process 10 min (`QB_COM_TIMEOUT_MS`).
  * Past the limit, the helper is killed and the call fails with "did not answer within…".
  * Recovery's health check then tells a frozen QB (9010) from a gone one.
* **Idle release.** After `QB_IDLE_RELEASE_MINUTES` (default 10, 0 = never) with no requests, the manager ends the session.
  * While a session is held, QuickBooks refuses to close ("another application is using it"), observed live.
  * The next request reconnects through `ensureLiveSession`.
* **Tests** fork `tests/fixtures/fake-com-worker.mjs`, which crashes or hangs on cue. Live verification is in ACCEPTANCE_CRITERIA Item 107.

### Crash recovery, health and activity (added 2026-10-05)

* **Health** ([src/util/qb-health.ts](src/util/qb-health.ts) + `scripts/qb-health.ps1`, read-only).
  * Inputs: QBW processes (responding?), their visible windows, File Doctor / Tool Hub processes, and WerFault windows mentioning QuickBooks.
  * `interpretHealth` turns these into one `state` plus a summary and a recommended action. Cached 3 s.
* **Recovery** (`QBSessionManager.recover`):
  * checks health first;
  * refuses (9010) on `file-doctor` or `dialog`;
  * rechecks `not-responding` after 10 s, and force-kills only with `forceCloseHungQuickBooks`;
  * drops the dead ticket, then re-runs the open path for the SAME file (`switchCompanyFileInner` with `preserveIdempotency`).
* **Request path** (`sendRequest`):
  * a QB-gone error (RPC unavailable, disconnected, could not start…) triggers `recover()`, then **reads** are retried once and **writes** throw 9011 (`isWriteRequest`);
  * a modal-dialog error throws 9010 `dialog` with the on-screen titles;
  * with no session, QB not running and a saved login, it starts QB on the file itself rather than an SDK unattended open (which pops error 80070057 for password-protected files).
* **Serialization:** `runExclusive` makes company switches and recoveries mutually exclusive, and requests wait for one in flight.
* **Activity** ([src/util/activity-log.ts](src/util/activity-log.ts)):
  * the ring buffer holds 300 events, plus JSON lines in `activity.log` beside the credential store (trimmed at 1 MB);
  * written by the manager (sessions, switches, recoveries), the web API (login and access changes, jobs), and the authorization guard (refused calls);
  * it never contains secrets.
* **Web control:** `/api/state` adds health, session diagnostics, activity, storage, connected agents and the current job. Background jobs (`/api/session/reconnect`, `/api/session/open`, `/api/quickbooks/force-close` with typed confirm and frozen-only) run one at a time.

### Credential store + local web server (added 2026-10-05)

* **Why it exists:** QBXMLRP2 cannot pass a QB user name/password, so logging into a password-protected file means filling in QB's own login dialog. The operator also wants agents on other tailnet devices to use specific files.
* **Store:** `%APPDATA%\quickbooks-desktop-mcp\credentials.json` (`QB_CREDENTIALS_FILE` overrides).
  * Format: `{version:2, entries:[{companyFile, username, password:<DPAPI base64>, updatedAt, authorizedPeers:[{address, nodeId, nodeName, loginName, addedAt}]}]}`. Version-1 files load unchanged.
  * Saves are atomic (temp file + rename) and serialized in-process.
  * It is re-read on every use, so page edits apply to the next tool call with no restart.
* **Web server** ([src/web/server.ts](src/web/server.ts)) starts with the MCP process (`QB_WEB=0` disables it). It listens on `127.0.0.1:8765` and this machine's tailnet IPv4, **never 0.0.0.0**.
  * `GET /`: the logins page ([src/web/admin-page.ts](src/web/admin-page.ts)).
  * `/api/*`: page JSON.
  * `/mcp`: MCP Streamable HTTP for remote agents.
  * Defenses: a Host allowlist (DNS rebinding); `X-QB-Admin` + JSON content type + an Origin check on the API; no CORS; a 64 KB body cap; CSP `default-src 'none'`.
  * If the port is taken (another instance), the page is skipped and stdio MCP continues. `QB_HTTP_ONLY=1` runs without stdio.
* **Caller identity** ([src/util/caller-authorization.ts](src/util/caller-authorization.ts), [src/util/tailnet.ts](src/util/tailnet.ts)):
  * `local`: stdio, loopback HTTP, or this machine's own tailnet IP. Unrestricted.
  * `tailnet`: any other 100.64/10 address, identified by `tailscale whois` (StableID, node name, owner login; cached 60s).
  * Page/API admins: `local`, devices of the same Tailscale login as this machine (never `tagged-devices`), and `QB_WEB_ADMINS`.
* **One McpServer per caller.** `createMcpServer(identity)` in [src/index.ts](src/index.ts) builds a server per stdio host and per HTTP session.
  * `installAuthorizationGuard` wraps `server.tool` *before* the register calls. For a tailnet caller every handler first checks the target (`qb_company_open`) or the currently active company file against the store; a failure returns `statusCode 9009`.
  * `qb_company_list` / `qb_company_credentials_list` output is filtered to the caller's files.
  * An HTTP session is bound to the identity that created it.
  * All instances share the single `QBSessionManager`, which is why the check is against the file active at call time.
* **Who touches plaintext passwords:**
  * The browser → `POST /api/logins` → Node (in memory, only for the save) → `scripts/qb-dpapi-protect.ps1` (stdin, base64) encrypts.
  * `scripts/qb-login-autofill.ps1` (Win32 `WM_SETTEXT` / `BM_CLICK`) decrypts at the moment of need.
  * No tool or API response contains a password or ciphertext.
* **Invariants:**
  * Never return a password to a tool caller.
  * Never request secrets via MCP elicitation.
  * Never bind beyond loopback + tailnet.
  * New tools are covered by the guard automatically because it wraps `server.tool`. Only add a tool to `ALWAYS_ALLOWED` if it exposes no company data, or filters its output.
* **PowerShell helpers are Windows PowerShell 5.1 scripts and must stay pure ASCII.** 5.1 reads BOM-less files as ANSI. A test enforces this.

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

The only project-side persistent storage is the credential store (see Session lifecycle → Credential store + local web server). If we ever need to cache live responses or persist a request log, that's a new subsystem and requires an `ARCHITECTURE.md` update.

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
