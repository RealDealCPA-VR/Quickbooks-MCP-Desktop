# Project Operating System — QuickBooks Desktop MCP

## Purpose

This document defines the operating system for AI-assisted development on the QuickBooks Desktop MCP server.

The goal is not just to produce code quickly. The goal is to produce code that stays coherent, verifiable, maintainable, and transferable across many AI sessions.

This system assumes AI is powerful but not self-governing. AI can accelerate implementation, but without structure it will drift, duplicate logic, break prior work, and erode architectural consistency over time.

This operating system exists to prevent that.

---

## Core Philosophy

This codebase is built using **AI-assisted engineering, not AI-led improvisation**.

That means:

* AI is a contributor, not the owner of the codebase
* continuity must live in files, not in model memory
* verification is required before expansion
* architecture should remain stable across sessions
* human intent controls the system, even when AI writes most of the code

The working model is simple:

> Treat each AI session like a replaceable contractor that must read the brief, verify prior work, complete one bounded task, and leave clean state for the next contractor.

---

## Project Snapshot

* **What it is** — A Model Context Protocol (MCP) server that exposes QuickBooks Desktop operations as tools an LLM can call.
* **Wire protocol** — QBXML (Intuit's XML format), built and parsed in `src/qbxml/`.
* **Two modes** — `live` (Windows COM via QBXMLRP2, currently stubbed) and `simulation` (in-memory store, default everywhere else).
* **Transport** — stdio MCP server bound in [src/index.ts](src/index.ts).
* **Single user** — This is a personal tool. The bar is "works flawlessly," not "ships to customers."

---

## Stable Code Conventions

These are the default implementation conventions for this codebase.

* TypeScript strict mode, ES2022, ESM modules (`"type": "module"`), `Node16` module resolution
* Always use `.js` extensions on relative imports (Node16 ESM requirement)
* MCP tools registered via `server.tool(name, description, zodSchema, handler)` — never bypass the SDK
* Zod schemas for every tool input — describe every field with `.describe()`
* Tool handlers return `{ content: [{ type: "text" as const, text: JSON.stringify(...) }] }` (with `isError: true` on failure)
* One file per entity domain in `src/tools/` (e.g. `customers.ts`, `bills.ts`), each exporting `register<Domain>Tools(server, getSession)`
* Register new tool modules in [src/index.ts](src/index.ts) and update the `instructions` block in the same file
* Session lifecycle goes through `QBSessionManager` only — tools call `session.queryEntity / addEntity / modifyEntity / deleteEntity / runReport`, never construct QBXML directly
* QBXML construction lives in [src/qbxml/builder.ts](src/qbxml/builder.ts); parsing in [src/qbxml/parser.ts](src/qbxml/parser.ts) — extend these instead of reimplementing
* When a parsed response can be a single object or an array of one, register the `*Ret` element name in `arrayElements` in [src/qbxml/parser.ts](src/qbxml/parser.ts)
* Simulation store ([src/session/simulation-store.ts](src/session/simulation-store.ts)) is the dev source of truth — every new request type must be handled there in addition to the live path
* Transaction entities (Invoice, Bill, ReceivePayment, Estimate, SalesReceipt, CreditMemo, PurchaseOrder, JournalEntry, Deposit, Transfer, Check, BillPaymentCheck, BillPaymentCreditCard, SalesOrder, CreditCardCharge, CreditCardCredit, TimeTracking, SalesTaxPaymentCheck, InventoryAdjustment, StatementCharge, VehicleMileage) use `TxnID` + `TxnDelRq`. List entities use `ListID` + `ListDelRq`. Keep the two arrays in [builder.ts](src/qbxml/builder.ts), [manager.ts](src/session/manager.ts), and [simulation-store.ts](src/session/simulation-store.ts) in sync.
* Item types are not generic — real QB requires `ItemServiceQueryRq`, `ItemInventoryAddRq`, etc. Do not invent a generic `ItemQueryRq`.
* `npm run build` (tsc) must pass before any task is marked complete. `npm run dev` (tsx) for local iteration.
* No new dependencies without a note in `DECISIONS.md`.

These conventions should be treated as defaults unless a documented decision explicitly changes them.

---

## Required Project Files

The following markdown files make up the operating system.

### 1. `HANDOFF.md`

Used for short-term session continuity.

Purpose:

* tell the next agent what was done
* define what must be verified first
* point to the exact next task
* preserve small but important context

### 2. `todo.md`

Used for ordered implementation work.

Purpose:

* define the task queue
* show what is completed and what is not
* keep execution bounded and sequential
* prevent drift and random feature jumping

### 3. `ARCHITECTURE.md`

Used for stable system design rules.

Purpose:

* define major structural decisions (transport, QBXML round-trip, two-mode session, tool registration)
* preserve system boundaries (tools never touch XML, simulation never leaks into live)
* prevent silent architectural drift
* explain how the system is supposed to work at a high level

This file should change rarely.

### 4. `DECISIONS.md`

Used for major decisions and tradeoffs.

Purpose:

* document why something changed (e.g. switching to per-type Item requests, choosing `winax` vs. `node-activex`)
* record alternatives considered
* explain downstream consequences
* preserve reasoning across sessions

### 5. `REQUIREMENTS.md`

Used for product-level truth.

Purpose:

* define what the server must do for the operator (the user)
* separate product requirements ("payments must close out invoices") from implementation tasks ("add `AppliedToTxnAdd` to `qb_payment_receive`")
* keep the build aligned to real workflows

### 6. `REGRESSION_CHECKLIST.md`

Used to reduce silent breakage.

Purpose:

* verify that current work did not damage prior work
* enforce build, tool-registration, simulation-store, and round-trip XML sanity checks

### 7. `ACCEPTANCE_CRITERIA.md`

Used to define what "done" means per task.

Purpose:

* prevent premature task completion
* define working behavior clearly
* force task completion to be outcome-based, not effort-based

---

## File Roles by Time Horizon

### Short-Term Memory

These guide the next session directly:

* `HANDOFF.md`
* `todo.md`

### Medium-Term Build Control

These govern execution quality over time:

* `REGRESSION_CHECKLIST.md`
* `ACCEPTANCE_CRITERIA.md`

### Long-Term System Memory

These protect coherence across the life of the project:

* `ARCHITECTURE.md`
* `DECISIONS.md`
* `REQUIREMENTS.md`

---

## Agent Session Lifecycle

Every AI session must follow this lifecycle.

## 1. PICKUP — Read State First

Before writing any code, read in this order:

1. `HANDOFF.md`
2. `todo.md`
3. `ARCHITECTURE.md` if the task touches QBXML envelope, session lifecycle, mode switching, or tool-registration boundaries
4. `DECISIONS.md` if the task touches an area that has been previously debated (item subtypes, COM library choice, simulation fidelity tradeoffs, etc.)
5. `REQUIREMENTS.md` if the task affects what an exposed tool must do for the operator

### Mandatory Verification Rule

If `HANDOFF.md` includes a `Verify Before Continuing` section, those checks are the top priority.

Do not begin new work until verification is complete.

If prior work is broken:

* fix it first
* update the handoff state
* only then continue with new implementation

---

## 2. WORK — Implement the Next Bounded Task

Work must be picked up from:

* `## Next Task` in `HANDOFF.md`, or
* the next unchecked item in `todo.md`

### Working Rules

* Work sequentially within the current phase of `todo.md`
* Keep changes focused — one logical fix or one logical tool per step
* Reuse existing patterns before introducing new ones (look at neighboring tool files first)
* When you add a tool: register it in [src/index.ts](src/index.ts), handle the request in the simulation store, update the `instructions` string, and add it to the README tool table
* When you add a new QBXML request type: extend the builder if structure differs, register response `*Ret` names in the parser's `arrayElements`, and add a simulation handler
* Test continuously — run `npm run build` after each meaningful change; run `npm run dev` and exercise the tool through an MCP client when behavior matters
* Do not wander into unrelated cleanup unless it blocks the task

### Architectural Discipline

If a task requires changing an established architectural pattern (e.g. introducing a different transport, splitting the session manager, abandoning the single-store simulation):

* do not silently drift
* update `ARCHITECTURE.md` intentionally
* record the decision in `DECISIONS.md`

### Requirements Discipline

If implementation reveals that a requirement should change (e.g. the operator actually needs payments to allow partial application across multiple invoices):

* update `REQUIREMENTS.md`
* do not let implementation become the hidden source of product truth

---

## 3. VERIFY — Confirm the Work Actually Functions

Before marking anything complete, verify the implementation against:

* the relevant acceptance criteria
* the regression checklist
* any handoff-specific verification items

### Minimum Verification Standard

At a minimum, confirm:

* `npm run build` passes (no TypeScript errors)
* the tool is registered and discoverable (server starts and lists it)
* the tool produces correct simulation output for the happy path and at least one error path
* QBXML built by the tool round-trips through the parser without losing fields
* no obvious regressions were introduced in adjacent tools that share helpers
* existing conventions were followed
* the system still makes sense structurally

### Non-Negotiable Rule

Never mark a task complete because the code "looks done."

A task is complete only when the behavior is actually working to the defined standard.

For the live-mode work specifically: simulation passing is necessary but not sufficient. Live work cannot be marked complete until exercised on a Windows machine with QuickBooks Desktop installed. If you cannot do that in-session, leave the task as `partial` in `HANDOFF.md` with the exact verification steps spelled out.

---

## 4. HANDOFF — Write State Before Stopping

When the session reaches a natural stopping point, write state before ending.

A natural stopping point usually means:

* a logical task is complete
* a phase boundary in `todo.md` was reached
* useful context is starting to compress
* enough work was done that the next session could lose continuity without a written handoff

### Required Handoff Actions

1. Update `todo.md`
   * check off only what is fully working
   * leave partial work unchecked, and note the partial state inline if helpful

2. Update `HANDOFF.md`
   * write a fresh handoff with the required sections (template below)

3. Record major design changes
   * update `DECISIONS.md` if a meaningful choice was made (e.g. picked `winax` over `node-activex`, decided to split Item store by subtype)
   * update `ARCHITECTURE.md` if a stable structural rule changed

4. Ensure verification state is clear
   * document anything the next session must confirm first
   * if `npm run build` is failing for any reason, say so explicitly

### Required Handoff Template

```markdown
# Handoff State

## Last Session Summary
- <What was accomplished>
- <What was accomplished>
- <Any important fix or decision>

## Verify Before Continuing
- [ ] Check 1: <what to verify and how, e.g. "run npm run build — must pass">
- [ ] Check 2: <e.g. "run npm run dev, call qb_invoice_create with a 2-line invoice, confirm Subtotal returned">

## Next Task
<The exact next todo.md item to work on, with its phase number>

## Context Notes
- <Gotcha — e.g. "fast-xml-parser strips empty elements; bills with zero lines need a sentinel">
- <Pattern to follow — e.g. "follow tools/invoices.ts:108-122 shape for line-item arrays">
- <Important file or function reference — e.g. "QBXMLRequestBody type lives at src/types/qbxml.ts:45">
```

### Session Closing Rule

Always leave the project in a state where the next agent can pick up in under two minutes of reading.

---

## Task Completion Standard

A task is done only when:

* implementation is complete
* behavior works as intended (verified against simulation; live mode requires Windows verification)
* acceptance criteria are satisfied
* no obvious regressions were introduced
* code follows project conventions
* `npm run build` passes unless the task explicitly cannot be build-verified yet

If a task is partially done:

* leave it unchecked in `todo.md`
* describe the partial state in `HANDOFF.md`

---

## Required Verification Layers

### Layer 1: Local Task Verification

Verify the specific tool or module you changed.

Examples:

* the new tool appears in the MCP server's tool list
* calling the tool with a valid input returns a structured success payload
* calling the tool with an invalid input returns `isError: true` with a useful message
* the simulation store handles the new request type
* a new QBXML element parses back to the expected JS shape

### Layer 2: Regression Verification

Verify that the new change did not silently damage existing behavior.

Examples:

* the tools that share `session.queryEntity` / `addEntity` / etc. still work
* prior simulation seed data still loads and is queryable
* `qb_company_info`, `qb_session_connect`, `qb_session_disconnect` still respond
* invoices created in earlier flows still list correctly

### Layer 3: Structural Verification

Verify that the code still matches the intended architecture.

Examples:

* tool handlers do not bypass the session manager to build XML directly
* simulation logic did not leak into live-mode code paths (or vice versa)
* new tool location follows the `src/tools/<domain>.ts` convention
* zod schemas describe every input field
* QBXML element names match Intuit's spec, not invented names

---

## Acceptance Criteria Rules

Every meaningful task should have explicit acceptance criteria recorded in `ACCEPTANCE_CRITERIA.md`.

A good acceptance criterion is:

* observable
* behavioral
* testable
* specific enough to prevent ambiguity

### Weak Example

* Add bill update tool

### Strong Example

* `qb_bill_update` is registered and listed by the MCP server
* Calling it with valid `txnId` + `editSequence` + new fields returns the modified bill with updated `TimeModified`
* Calling it with a stale `editSequence` returns `isError: true` with statusCode `3170`
* Calling it with `expenseLines: [{accountName, amount}]` updates the expense allocation; the resulting bill's lines round-trip through the parser
* `qb_bill_list` reflects the updated bill on the next call
* `npm run build` passes
* README bill table now lists the tool

If criteria change during implementation, update the source of truth instead of silently moving the goalposts.

---

## Architecture Governance Rules

The architecture should remain stable unless intentionally changed.

### Rules

* do not silently create new patterns when existing ones work
* do not move logic across layers (tool ↔ session manager ↔ qbxml ↔ simulation store) without reason
* do not let `live` and `simulation` paths diverge in observable behavior — both should produce QBXML responses with the same shape
* do not let convenience today become structural confusion tomorrow

### Update `ARCHITECTURE.md` When:

* the QBXML envelope structure or version bumps
* the session manager grows a new responsibility (e.g. transaction batching, retry, caching)
* a new transport is added (HTTP, websocket) alongside stdio
* simulation store storage strategy changes (e.g. switching from `Map` to a real embedded DB)
* a new top-level subsystem is introduced

---

## Decision Logging Rules

Not every small implementation choice needs to be logged.

Use `DECISIONS.md` when:

* a meaningful technical tradeoff was made (e.g. `winax` vs. `node-activex` for COM)
* an old pattern was rejected in favor of a new one (e.g. abandoning generic `ItemQueryRq` in favor of per-subtype requests)
* a constraint forced an unusual implementation (e.g. iterator pagination because real QB caps at ~500 rows)
* future agents would otherwise repeat the same debate

A decision log entry should answer:

* what was chosen
* why it was chosen
* what alternatives were rejected
* what tradeoffs now exist

---

## Requirements Governance Rules

`REQUIREMENTS.md` is the product truth, not `todo.md`.

### Important Distinction

* `REQUIREMENTS.md` = what the system must do for the operator (e.g. "the operator can apply a payment to multiple open invoices and the AR aging report reflects the change")
* `todo.md` = how current implementation work is sequenced (e.g. "Phase 3 item 5 — add `AppliedToTxnAdd` support")

Do not confuse the two.

If feature work changes product behavior:

* reflect that in `REQUIREMENTS.md`
* do not let code become the only place where behavior is defined

---

## Regression Checklist Minimum Contents

The checklist should cover at least:

### Build / Compile

* `npm run build` passes
* no new TypeScript errors
* no missing `.js` extensions on relative imports

### Server Startup

* `npm run dev` boots without throwing
* simulation banner prints when expected
* all expected tools appear in the tool list

### Tool Surface

* each changed tool returns a well-formed response for the happy path
* each changed tool returns `isError: true` for at least one invalid input
* tools that depend on session state still work after `qb_session_disconnect` + auto-reconnect

### QBXML Round-Trip

* requests built by `builder.ts` parse cleanly back through `parser.ts`
* multi-element responses (e.g. multiple `CustomerRet`) come back as arrays, not single objects
* status codes (0 / 1 / 3xxx / 5xx) are mapped correctly

### Simulation Store

* seed data still loads
* CRUD on every entity touched still works end-to-end
* filters that were supposed to apply, apply (no silent return-everything)

### Prior Tool Verification

* a tool from an unrelated domain (e.g. `qb_account_list`) still works after your changes
* no silent behavior changes were introduced in shared helpers

### Handoff Readiness

* `todo.md` updated truthfully
* `HANDOFF.md` updated clearly
* partial work documented

---

## What This Operating System Prevents

When followed correctly, this operating system reduces:

* context loss across sessions
* feature stacking on a broken simulation
* silent divergence between `live` and `simulation` behavior
* random architectural drift
* checkbox inflation without working behavior
* undocumented design choices
* AI hallucinated continuity
* hidden regressions
* codebase entropy over time

---

## What This Operating System Does Not Do

This system does not replace:

* human judgment
* architectural thinking
* product prioritization
* security awareness (this server has full read/write access to the operator's books)
* actual verification

It is a control framework, not a substitute for engineering.

---

## Operating Principle for AI Usage

Use AI aggressively for:

* implementation speed
* refactoring assistance
* pattern matching across the tool files
* boilerplate generation (new tool scaffolds, zod schemas)
* structured debugging
* documentation support

Do not rely on AI alone for:

* architectural truth
* task completion truth
* verification truth
* product truth
* continuity truth
* confirming live-mode behavior against a real QuickBooks Desktop instance

Those must be externalized into the project system or executed by you on a real Windows + QB box.

---

## Practical Summary

The loose builder says:

> Let the AI build and we'll fix it later.

This operating system says:

> Let the AI build inside a controlled environment where architecture, continuity, verification, and handoff are explicit.

That is the difference between generating code and building a system.

---

## Final Standard

Every session should leave the project in a state where:

* the current work is understandable
* the next step is obvious
* the architecture is still coherent
* the prior work is still trusted
* the next agent can resume quickly without guessing

If that standard is met repeatedly, the codebase can scale across many AI sessions without collapsing into improvisational sludge.
