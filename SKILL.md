# QuickBooks Desktop MCP — Agent Usage Guide

A companion document for any AI agent connected to this Model Context Protocol server. Read this first before issuing tool calls — it covers the patterns that distinguish a competent agent from one that duplicates invoices, breaks reconciliations, or silently writes the wrong year's data.

This guide is server-agnostic. Drop it into Claude, GPT, opencode, Cursor, or any other agent runtime that speaks MCP — the patterns below apply identically.

---

## What this server is

A read/write bridge between an LLM agent and **QuickBooks Desktop** (the on-premise Windows accounting application — not QuickBooks Online, which has a different API). The server exposes **154 tools** covering:

- **Records** — Customer / Vendor / Account / Item / Employee / Class / Terms (CRUD)
- **Transactions** — Invoice / Bill / Check / Deposit / Transfer / Journal Entry / Estimate / Sales Order / Purchase Order / Sales Receipt / Credit Memo / Statement Charge / Inventory Adjustment / Time Tracking / Vehicle Mileage / Credit Card Charge/Credit / Sales Tax Payment (full CRUD where the SDK allows)
- **Reports** — P&L, Balance Sheet, Statement of Cash Flows, Trial Balance, General Ledger, AR/AP Aging, Sales by Customer/Item, Expenses by Vendor, Customer/Vendor Balance Detail, Tax Line Mapping, Audit Log, W-2 Summary
- **Workflows** — 1099 prep, bank reconciliation, engagement profitability, client packet (tax-prep workpaper bundle), invoice/bill/JE write-off, payment application, transaction memo search
- **Session management** — connection lifecycle, company-file switching (close one file, open another, auto-login from saved logins), per-device file authorization for remote tailnet agents, read-only mode, MCP-side caching, host info, closing-date inspection

Operating modes:
- **live** — talks to a running QuickBooks Desktop instance via QBXMLRP2 (Windows-only)
- **simulation** — in-memory mock store that mirrors live wire shapes (any platform; default off-Windows)

`qb_session_status` reports which mode is active. Most observable behavior is identical — the simulation is faithful enough that workflows tested in sim work in live with no code changes — but a few sim limitations are called out at the bottom of this doc.

---

## When to use this server

**Use it when** the user wants to read or modify QB Desktop bookkeeping data: list records, run reports, classify transactions, prep workpapers, reconcile bank statements, file 1099s/W-2s, look up balances, audit history.

**Do not use it when** the task doesn't touch QB. This server has full read/write access to the operator's books — calling tools "to see what happens" can create duplicate invoices, break prior reconciliations, or corrupt period balances. Treat every mutation as load-bearing.

---

## Quick start (4 steps)

1. **Confirm connection.** Call `qb_session_status` (zero wire I/O) — confirms `connected: true`, surfaces mode, companyFile, readOnly state, cached host info, and recent transient-retry stats.
2. **Confirm scope.** Call `qb_company_info` — confirms which `.qbw` file the operator has open. If it's the wrong file, follow **Opening a company file** below.
3. **Remote agent?** If you reached the server over the tailnet (`http://<host>:8765/mcp`), you may use only the company files the operator authorized for your device. Call `qb_company_list` first: it lists exactly those files.
4. **Read the patterns below before mutating.** Status codes, idempotency, dry-run, read-only, editSequence — each is non-obvious and each is necessary.

---

## Connecting, company files, logins and authorization

### How agents connect

| You are | Connect via | What you may touch |
|---|---|---|
| The MCP host on the computer running QuickBooks (e.g. Claude Desktop) | stdio (the host's config launches the server) | Every company file |
| An agent on **another device on the operator's tailnet** | Streamable HTTP at `http://<host's tailnet IP>:8765/mcp` (the server prints the exact URL at startup; the operator can read it on the logins page) | Only the company files the operator authorized for **your device** |

Remote identity is your device's tailnet address, confirmed with `tailscale whois` and pinned to the device's node. You cannot claim another identity, and you cannot reuse another device's MCP session. Nothing on the server is reachable from the LAN or the internet: it listens only on `127.0.0.1` and the tailnet address.

### The logins page (operator-facing)

The server runs a local web page alongside MCP: `http://127.0.0.1:8765/` on the host, or `http://<tailnet IP>:8765/` from the operator's own tailnet devices. On it the operator:

- enters each company file's **QuickBooks user name and password** once (files under `QB_COMPANY_ROOT` are pre-listed);
- sees saved logins pre-filled on later visits ("Already saved — nothing to re-enter"), changes them as needed, and saves; the new login **overwrites** the old one;
- **authorizes tailnet devices per company file** (pick a device or type its 100.x address).

Logins are stored on the host computer, encrypted for the operator's Windows account, and picked up automatically on the next tool call. No restart is needed.

**You never see or handle passwords.** No tool returns one. The server uses the saved login itself when it opens a file in QuickBooks.

- `qb_company_credentials_list` → which files have a saved login: `username`, `hasPassword`, `authorizedPeers`.
- `qb_company_credentials_edit({ companyFile? })` → the page URL. For the local agent it also opens the page in the operator's browser, pre-selecting `companyFile`.
- **Never ask the operator to type a QuickBooks password into the chat.** If a login is missing or wrong, call `qb_company_credentials_edit` and ask them to fix it on the page.

### Opening a company file

```
qb_company_list({ depth: 3 })            // files you may use; hasSavedLogin per file
qb_company_open({ companyFile, closeCurrentCompany: true })
qb_company_info()                        // confirm you're in the right book
```

- If QuickBooks already has the requested file open, `qb_company_open` just attaches.
- `closeCurrentCompany: true` is how you go **from one company file to another**:
  1. The server closes QuickBooks gracefully. It is never force-killed.
  2. It relaunches QuickBooks on the new file.
  3. It types the saved login into QuickBooks' login window.
  4. It attaches. This takes up to about 90 seconds.
- Without `closeCurrentCompany`, a different open file returns `9007 file-conflict`. Use `launchIfClosed: true` alone when QuickBooks isn't running.
- The success response carries:
  - `closedPreviousQuickBooks: true` when the previous company was closed;
  - `loginAutofill`:
    - `filled`: the login was used;
    - `not-needed`: QB didn't ask;
    - `no-credentials`: nothing saved for the file;
    - `no-login-window`: QB never showed a login window. Treat it as a problem only if the open then timed out.
- **Closing QuickBooks interrupts the operator if they are working in it.** Before `closeCurrentCompany: true`, check `qb_company_info`, and if a different file is open, confirm with the operator that it's OK to switch.
- The first time this app opens a given file, a QuickBooks Admin must approve the **Application Certificate** prompt in the QuickBooks window. The server never answers it. A timeout on a never-before-used file usually means that prompt is waiting.

| Failure | Meaning | What to do |
|---|---|---|
| `9007` reason `file-conflict` | QB has a different file open | Retry with `closeCurrentCompany: true` (after confirming with the operator) |
| `9007` reason `close-failed` | QB showed a prompt while closing (unsaved form, backup reminder); the message names the open QB windows | Ask the operator to answer it in QuickBooks, then retry |
| `9007` reason `login-rejected` | QB refused the saved login (submitted once, never retried) | `qb_company_credentials_edit({ companyFile })` → operator fixes it → retry |
| `9007` reason `launch-timeout` | QB didn't attach in time: login window with no saved login, certificate prompt, upgrade prompt | Read the message. If it mentions the login, send the operator to the logins page |
| `9007` reason `no-executable` | QuickBooks Desktop not found | Operator sets `QB_DESKTOP_EXE` |
| `9008` | File locked by another user (multi-user) | Wait. Don't retry in a loop |
| `9009` | **Your device isn't authorized for that file** (or no specific file is selected yet) | `qb_company_list` to see your files, then `qb_company_open` one of them. For another file, ask the operator to authorize your device on the logins page. Never try to work around it |

### On a hub: which workstation's QuickBooks you are using

When the server is an office **hub** (QuickBooks runs on workstations that run the connector), two extra tools exist:

- `qb_workstation_list`: every workstation (online, default, `usedByYou`, `ownPc`, the open company file) and which one your requests go to.
- `qb_workstation_use({ workstation })`: send your requests to that workstation for the rest of your connection; `'default'` returns to automatic routing.

Automatic routing: your own PC's QuickBooks when your PC is an online workstation, otherwise the default workstation. Each workstation has its own open company file.

The books live on a file server, so the same company file can be opened from any workstation, but only one at a time unless QuickBooks is in multi-user mode. If `qb_company_open` returns **9008** with `heldBy`, that workstation already has the file open: retry with `qb_company_open({ companyFile, workstation: heldBy })` rather than waiting. Company files are UNC paths (`\\server\share\...`): use them exactly as `qb_company_list` returns them.

### When QuickBooks crashes, freezes, or File Doctor runs

QuickBooks Desktop on the operator's computer is not always stable. It can crash, freeze on a big report, stop on a dialog, or hand off to **File Doctor**. Build around that:

1. **Reads recover by themselves.** If QuickBooks disappears in the middle of a query or report, the server reconnects to the same company file (starting QuickBooks and logging in with the saved login if needed) and retries the read **once**. You just get the result, a little slower.
2. **Writes are never repeated automatically.** If QuickBooks dies during an add, update or delete, you get **statusCode 9011**: the server reconnected, but the write may or may not have been saved. **Look the record up** (list or query) before retrying, and always pass an `idempotencyKey` on creates, so a retry that was in fact saved replays instead of duplicating. Replay protection survives the reconnect.
3. **When something still fails, call `qb_health` before anything else.** It reports:
   - `state`: `ready` | `login` | `dialog` | `not-responding` | `file-doctor` | `crashed` | `starting` | `not-running`;
   - a plain summary and the `recommendedAction`;
   - the titles of any QuickBooks dialogs on screen;
   - this server's session (connected file, last error, last recovery);
   - recent activity.
4. **Then act on the state:**

| `qb_health.state` | Meaning | What you do |
|---|---|---|
| `ready` | QuickBooks is fine | Retry. If requests still fail, call `qb_session_recover` |
| `not-running` / `crashed` | QuickBooks is gone | `qb_session_recover`. It reopens the same file and logs in |
| `dialog` | A QuickBooks window needs an answer (error box, backup reminder, update) | Tell the operator **exactly** what the dialog says (`dialogs`). Wait for them, then `qb_session_recover` |
| `login` | QuickBooks is at its login window | During an open the server fills it in. Otherwise check the saved login on the logins page (`qb_company_credentials_edit`) |
| `file-doctor` | File Doctor / Tool Hub is repairing the file | **Wait.** Never reopen a file mid-repair; `qb_session_recover` refuses (9010) until File Doctor is closed. Then recover |
| `not-responding` | QuickBooks is frozen | Wait a minute (big reports freeze QuickBooks). If it stays frozen, **ask the operator** before `qb_session_recover({ forceCloseHungQuickBooks: true })`: it kills QuickBooks and loses any unsaved form |

5. **The server lets go of QuickBooks after 10 idle minutes** so the operator can close it. Your next request reconnects automatically (a few seconds, or about a minute if QuickBooks has to start). That isn't an error; don't report it as one.
6. **No call hangs forever.** A QuickBooks call that runs past the time limit (10 min by default) is stopped and handled like a frozen QuickBooks.
7. **statusCode 9010** means "QuickBooks needs a person". Its `reason` (`file-doctor`, `dialog`, `not-responding`, `crashed`, `recovery-failed`) and `recommendedAction` say what to tell the operator. Don't loop on it: one recover attempt after the operator acts is enough.

The operator sees the same picture live on the logins page (Overview tab), and can press **Reconnect**, **Open in QuickBooks**, or **Force close** there.

As a remote agent, **every** data tool is checked against the file that is open *at that moment*. QuickBooks has one open file shared by all agents, so if someone else switched files, your next call can return 9009. Re-open your file with `qb_company_open` and continue.

---

## Critical patterns

### 1. `editSequence` is required on every update

QB Desktop uses optimistic concurrency. Every list response carries `EditSequence` on every row. To update or delete an entity, pass that exact `EditSequence` along with the `ListID` (lists) or `TxnID` (transactions). If the entity was modified between your read and your write, QB rejects with **statusCode 3170**.

**Pattern:**
```
qb_invoice_list({ txnId: "..." }) → returns invoice with editSequence
qb_invoice_update({ txnId, editSequence, ...changes })
```

Never cache an `editSequence` across user prompts. Re-list immediately before any mutation.

### 2. Idempotency keys on every create

Every `*_create` / `*_add` tool accepts an optional `idempotencyKey: string`:

- **Same key + same payload** → returns the original result with `idempotentReplay: true`. Safe to retry on network/timeout.
- **Same key + different payload** → returns **statusCode 9002**. Use a fresh key for new requests.
- **No key** → at-least-once delivery. A timeout retry can create a duplicate.

Use a UUID per logical operation when you're driving non-trivial workflows. The cache is per-session, per-company-file, and clears on `qb_company_open`. Failed creates are not cached — retry can fix the underlying problem without being shadowed by a stale failure.

Batch tools (`qb_invoice_batch_create`, `qb_sales_receipt_batch_create`, `qb_journal_entry_batch_create`) fingerprint the entire entries list and only cache fully-successful batches.

### 3. Dry-run before risky mutations

Every mutation tool accepts `dryRun: true`. The server validates the payload, runs the operation against a sim snapshot, restores the snapshot, and returns the preview — no commit, no wire I/O in live mode (the live response carries just the built QBXML envelope plus `previewSupported: false`).

Use dry-run when:
- You're about to mutate something the user described in natural language and you want to confirm field mapping.
- The mutation has compounding side effects (e.g. creating an invoice moves Customer.Balance; deleting one reverses it; a stale call could double-count).
- You're scripting a batch and want to verify the first entry's shape before running all N.

**Exception**: 11 composite tools don't support dryRun yet (the carry list — `qb_invoice_write_off`, the four batch/duplicate flows, the two convert-to-invoice flows, `qb_bill_pay`). These return **statusCode 9006** if you pass `dryRun: true`.

### 4. Read-only sessions

`qb_session_connect({ readOnly: true })` flips a flag that gates every mutation tool. Under read-only:
- Every `*_add` / `*_update` / `*_delete` / `*_apply` / `*_pay` / `*_make_inactive` / `*_convert_to_invoice` / `batch_create` returns **statusCode 9001** before any QBXML envelope is built.
- Every read (queries, reports, `qb_raw_query`) works normally.
- `qb_company_open` and `qb_company_list` are unaffected (file-switching is a session-level operation, not a mutation against the books).

Use it for diagnostic and exploratory work where you must not modify the books. Toggle off via `qb_session_connect()` with no arg (defaults to writable) — no disconnect needed.

### 5. MCP-side caching on 5 stable lookups

`Account`, `Customer`, `Item` (per subtype), `Terms` (per subtype), and `Class` lists are cached for **5 minutes** by default. Repeated unfiltered calls within that window return from cache with `fromCache: true` and zero wire I/O.

**Cache hits only on unfiltered calls.** Any filter arg (`nameFilter`, `listId`, `accountType`, `parentListID`, `jobOnly`, `includeCustomFields`, `paginate`, `iteratorID`, `activeOnly: false`) bypasses cache.

After an out-of-band edit in QB Desktop's UI:
```
qb_cache_invalidate({ entity: 'Customer' })   // clears the Customer slot
qb_cache_invalidate({ entity: 'Item' })       // clears all 5 Item subtypes
qb_cache_invalidate({})                       // clears every cached domain
```

Per-call escape hatch: pass `useCache: false` on any list tool to force a fresh wire fetch without invalidating the cache.

Cache is per-session, per-company-file, and clears automatically on `qb_company_open`.

### 6. Pagination

7 list tools are paginated (real QB caps each `*QueryRq` at ~500 rows): `qb_customer_list`, `qb_vendor_list`, `qb_account_list`, `qb_employee_list`, `qb_invoice_list`, `qb_bill_list`, `qb_item_list`.

Three modes:
- **Default** — unpaginated. Best for small reads (~few hundred rows). Hits the cache when eligible.
- **`paginate: true`** — caller-driven iterator pagination. Response carries `iteratorRemainingCount` + `iteratorID`. Pass the `iteratorID` back to continue until `iteratorRemainingCount === 0`.
- **`autoExhaust: true`** — server-side iterator exhaustion in one call. Best for large reads (~thousands of rows). Capped by `maxBatches` (default 20 ≈ 10k rows); cap-hit returns the partial result + `iteratorID` for caller-driven resumption.

`autoExhaust` is usually what you want for any "give me everything" call. It bypasses the cache READ (explicit "go to QB and pull fresh" intent) but populates the cache on completion, so the next plain call can hit cache.

`qb_item_list` rejects `paginate` / `autoExhaust` without `itemType` — QBXML iterators are scoped to a single subtype request.

### 7. Status codes — reference table

The server returns a structured error shape on every failure: `{ success: false, statusCode, statusMessage, humanReadable?, hint? }`. Common codes:

| Code | Meaning | Typical fix |
|------|---------|-------------|
| 0    | Success | — |
| 1    | Info / empty result | Not an error — just empty data |
| 500  | Not found | Bad ListID / TxnID / FullName |
| 3000 | Invalid object identifier | Malformed reference |
| 3030 | Invalid amount | JE imbalance, negative invoice total, etc. |
| 3110 | Invalid enum value | Bad AccountType, PaidStatus, etc. |
| 3120 | Missing required field / invalid argument | Read the `hint.schemaOrder` if present |
| 3170 | Modify failed (usually stale editSequence) | Re-list to get fresh editSequence |
| 3260 | Insufficient permission / can't delete with history | Use `*_make_inactive` instead of `*_delete` |
| 9001 | Read-only session blocked the mutation | Reconnect with `readOnly: false` |
| 9002 | Idempotency key conflict | Use a fresh key for a different payload |
| 9003 | QB edition doesn't support this | Pro/Premier rejected an Enterprise-only call |
| 9004 | Payroll subscription required or not active | Out-of-scope without subscription |
| 9005 | QBXML SDK has no write path for this | Document the manual UI step instead |
| 9006 | Dry-run not supported in this mode | Composite outlier — run for real or refactor |
| 9007 | Company-file open/switch failed (`reason`: file-conflict, close-failed, login-rejected, launch-timeout, launch-spawn-failed, no-executable) | See **Opening a company file** |
| 9008 | Company file in use by another user or workstation | On a hub, read `heldBy` and retry `qb_company_open` with `workstation` set to it; otherwise wait for release; don't loop |
| 9009 | This device isn't authorized for that company file (remote agents) | `qb_company_list` → open an authorized file, or ask the operator to authorize it |
| 9010 | QuickBooks needs a person (`reason`: file-doctor, dialog, not-responding, crashed, recovery-failed) | `qb_health`, tell the operator what's on screen, then `qb_session_recover` once |
| 9011 | QuickBooks crashed during a WRITE; the server reconnected | Look the record up before retrying; retry with the same `idempotencyKey` |
| 9012 | Hub: the workstation isn't available (`reason`: no-workstation, workstation-offline, unknown-workstation, not-a-hub) | `qb_workstation_list`; pick an online one with `qb_workstation_use`, or tell the operator to start that PC's connector |
| -1   | QBXML parse error | Usually schema-order — read `hint` field |

When `hint` is present, it carries `kind` + `field` + `schemaOrder` candidates. Use it before retrying.

### 8. Money math is integer-cent, but the wire is decimal

QB's wire format is decimal (e.g. `"99.99"`). The server returns numbers. JS floating-point gives you 0.1 + 0.2 = 0.30000000000000004. For batch JE balance checks the server uses a cent-tolerance comparison; for your own math, prefer integer cents or `toFixed(2)` for any display value.

### 9. Workflow prompts (MCP `prompts/list`)

The server also exposes pre-built workflows via the standard MCP `prompts/list` + `prompts/get` API. Hosts typically surface these as slash commands or workflow templates. Available prompts:

- `month_end_close` — bank/CC rec → P&L → AR/AP → BS → SCF
- `credit_card_qb_batch` — bulk-categorize a CC statement into an atomic JE batch
- `trial_balance_workup` — TB + four cross-checks (BS reconcile, AR match, AP match, NI plug)
- `cc_statement_validator` — three-way CC statement reconciliation
- `w2_prep` — January W-2 prep + payroll reconciliation

Each prompt seeds the conversation with a structured workflow that references the right tools in order. Use these when the user asks for the workflow by name; they're more reliable than recreating the sequence from scratch.

---

## Common workflows (cheat sheet)

### "Show me everything for customer X in March"
```
qb_transaction_list({ customerName: "X", fromDate: "2026-03-01", toDate: "2026-03-31", includeLineItems: true })
```
Returns invoices + sales receipts + payments + credit memos + statement charges sorted chronologically with a `TxnType` tag on each row.

### "Show me every line that posted to account Y in Q1"
```
qb_transaction_list_by_account({ accountName: "Y", fromDate: "2026-01-01", toDate: "2026-03-31" })
```
Returns line-level postings with per-row running balance.

### "Search for any transaction mentioning 'audit fee' in memo"
```
qb_transaction_memo_search({ query: "audit fee", fromDate: "2026-01-01", toDate: "2026-12-31" })
```
At least one of `{customer scope, vendor scope, fromDate, toDate}` is required — no-bound rejects to prevent scanning the entire books.

### "What's the trial balance as of 2026-03-31?"
```
qb_trial_balance_export({ asOfDate: "2026-03-31", basis: "Accrual" })
```
Returns one row per non-zero posting account with debits/credits split by natural-balance side + four reconciliation cross-checks.

### "Bulk-create 50 monthly retainer invoices"
1. Build the entries array, each with the same shape as `qb_invoice_create`.
2. `qb_invoice_batch_create({ invoices: [...], idempotencyKey: "<uuid>" })`.
3. Returns `{ success, count, invoices: [...{status: 'posted'|'rolled-back'|'orphaned'|'failed'|'skipped'}] }`. Atomic — mid-wire failure triggers compensating delete in reverse post order.

### "Write off this stale invoice"
```
qb_invoice_write_off({ txnId, writeOffAccount: "Bad Debt", memo: "..." })
```
Single call. Internally posts a $0 ReceivePayment with `DiscountAmount = BalanceRemaining` against the named write-off account. Same mechanism as QB Desktop's "Discounts and Credits" dialog.

### "Run month-end close for last month"
Use the `month_end_close` MCP prompt, or sequence manually:
1. `qb_uncleared_transactions` + `qb_cleared_status_update` per bank account
2. `qb_reconciliation_discrepancy` to catch broken prior recs
3. `qb_pnl_report` for the period
4. `qb_ar_aging`, `qb_ap_aging` as of period end
5. `qb_balance_sheet_report` + `qb_statement_of_cash_flows`
6. `qb_trial_balance_export` for the workpaper

### "Prep 1099s for last tax year"
```
qb_1099_summary({ taxYear: 2025, formType: "NEC" })
```
For each vendor above threshold (default $600), drill in with `qb_1099_detail({ vendorListId, taxYear: 2025 })`.

---

## What to avoid

- **Retrying a write blindly after 9011 or a crash.** Check first; use idempotency keys.
- **Hammering a broken QuickBooks.** After a failure call `qb_health` once and follow `recommendedAction`. Don't loop retries or recovers.
- **Force-closing QuickBooks without the operator's OK.**
- **Asking for QuickBooks passwords in chat.** Never. Logins go on the logins page (`qb_company_credentials_edit`); the server applies them itself.
- **Switching company files without checking first.** `closeCurrentCompany: true` closes the QuickBooks window the operator may be working in. Confirm before switching away from a file someone has open.
- **Probing files you aren't authorized for** (remote agents). A 9009 is a decision by the operator, not an error to route around.
- **`qb_closing_date_set`** is an informational stub. The QBXML SDK has no write path for company preferences at any version. Always returns 9005 with explicit QB Desktop UI navigation steps (Edit → Preferences → Accounting → Company Preferences). Don't call it expecting a write.
- **Memorized transactions** — the SDK doesn't expose them. For recurring workflows, use `qb_invoice_duplicate` / `qb_bill_duplicate` / `qb_journal_entry_duplicate` / `qb_sales_receipt_duplicate`. Each reads a source transaction by `sourceTxnId` and submits a fresh add with operator-supplied overrides.
- **Hard-deleting accounts with transaction history** — QB rejects with 3260. Use `qb_account_make_inactive` (flips `IsActive: false`; account hides from default list view, history preserved).
- **Retrying mutations without idempotency keys.** A network timeout on `qb_invoice_create` followed by a naive retry creates two invoices. Always pass `idempotencyKey` on retry-prone flows.
- **Calling `qb_audit_log` on non-Enterprise editions** — rejects with 9003. Check `qb_host_query` for `edition === "Enterprise"` or `edition === "EnterpriseAccountant"` before attempting.
- **Calling `qb_w2_summary` without a payroll subscription** — rejects with 9004. The summary aggregates real wire-side data; sim mode has seeded employees but real QB returns nothing without an active subscription.

---

## Simulation-mode caveats

In simulation mode, most behavior is identical to live, but a few differences exist by design:

- **Balance Sheet AS/LI/EQ** come from `Account.Balance` (current snapshot). `asOfDate` is advisory for those sections. The P&L walk IS date-bounded in both modes.
- **`qb_transaction_list_by_account`** emits line-level postings only — implicit AR/AP/Bank counter-postings aren't materialized. Live QB returns the full posting tree.
- **Iterator state isn't cross-call** — sim's `Continue` returns empty + no metadata. Single-batch behavior matches live; multi-batch testing requires mocked spies.
- **1099 aggregation** doesn't honor QB Preferences' per-account 1099 box mapping. Every payment to an eligible vendor counts toward the threshold. Strict box-by-box reporting requires live + the real Form1099 wizard.
- **`qb_company_open`** in sim resets the in-memory store to fresh seed — real QB persists per-file, sim doesn't. The response carries `simulationStoreReset: true` to signal this.

The architecture commits to behavioral parity wherever the gap doesn't introduce a fundamentally different shape. If something works in sim, it should work in live; if it fails in live in a way sim didn't catch, that's a bug worth reporting.

---

## Further reading

| File | What it covers |
|------|----------------|
| `README.md` | Setup, MCP host configuration, the control page, multi-company, remote agents, crash recovery, security |
| `docs/TOOLS.md` | Every tool and its arguments |
| `HANDOFF.md` | Current implementation state — useful if you're a coding agent extending the server |
| `CLAUDE.md` | Project governance — operating system for AI-assisted development |
| `DECISIONS.md` | Architectural decision log — read before changing a load-bearing pattern |
| `REQUIREMENTS.md` | Product-level requirements (what the server must do for the operator) |
| In-server `instructions` (sent via MCP on connect) | Category-by-category tool descriptions — auto-loaded by the MCP host |

The in-server `instructions` block (see `src/index.ts`) is what an MCP host loads into the conversation automatically. This `SKILL.md` is the human-readable companion — read it once, then trust the in-server instructions for per-tool detail during the actual workflow.
