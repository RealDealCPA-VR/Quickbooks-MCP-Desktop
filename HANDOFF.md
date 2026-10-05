# Handoff State

> **Update (later on 2026-10-05): #106 control page redesign + crash recovery.**
> - **Control page:** a 5-tab page: Overview pipeline + actions, Company files, Access grid, Activity, Storage & security.
> - **Health:** `qb_health`, built on [src/util/qb-health.ts](src/util/qb-health.ts) + `scripts/qb-health.ps1`.
> - **Recovery:** `qb_session_recover` and `QBSessionManager.recover()`. Reads auto-retry after a crash; writes get 9011. Recovery refuses with 9010 while File Doctor runs, a dialog is open, or QB is hung; force-close happens only with permission.
> - **Activity:** `activity.log` ([src/util/activity-log.ts](src/util/activity-log.ts)).
> - **Status codes:** 9010/9011 added to qb-status-codes, SKILL.md, README and the instructions block.
> - **Totals:** 154 tools; 65 files / 1816 tests green.
> - **Also fixed live today:** the auto-fill now presses QuickBooks' custom OK button (mouse-click fallback); switching closes QB *before* asking the SDK for the next file (this avoided the 80070057 dialog); `file-not-found` is checked before anything closes; a rejected login keeps waiting so a human can type.
> - **Docs:**
>   - The README was rewritten as a product page: hero, highlights, mermaid diagram, quick start, control page with screenshots, multi-company, remote agents, crash recovery, security, merged config table (stale "live mode errors until Phase 7" text fixed), troubleshooting.
>   - The 154-tool reference moved verbatim to [docs/TOOLS.md](docs/TOOLS.md).
>   - The screenshots in `docs/images/` come from `node scripts/demo-control-page.mjs [port] --root <folder> --exit-after <s>`, which uses made-up data only. The repo is PUBLIC, so never screenshot real client files, devices, IPs or logins.
> - **Next live checks:** #106, close QB with its X during an agent session and then run a report; #105, a second tailnet device. Steps are in ACCEPTANCE_CRITERIA Items 105/106.
> - **Gotcha:** never use shell one-liners (`node -e` / `sed`) to write regexes containing backslashes into TS. They were silently corrupted three times today; use the Edit tool.


_Last updated: 2026-10-05 (second session of the day)._

This session built **Phase 20 #105**:
- a local **logins web page** that starts with the MCP server;
- **remote MCP for agents on other tailnet devices**, with **per-company-file authorization pinned to the device's tailnet address + Tailscale node**.

The server uses saved logins itself, so agents never receive passwords (the operator chose this). The Windows popup from earlier today is gone. SKILL.md is updated for agents.

Status: build green; **64 test files / 1787 tests passing** with `QB_UI_TESTS=1`; still **152 tools**.

## Last Session Summary

- **Operator decisions (AskUserQuestion, 2026-10-05):**
  1. The server uses credentials itself, not returning them to the agent.
  2. Tailnet authorization governs remote agents (MCP over HTTP) **and** the page.
  3. The webpage replaces the popup.

  All three are recorded in DECISIONS.md, top entry.
- **New modules:**
  - [src/web/server.ts](src/web/server.ts): `node:http` server serving the page, `/api/*` and `/mcp` (SDK `StreamableHTTPServerTransport`, one McpServer per session).
  - [src/web/admin-page.ts](src/web/admin-page.ts): self-contained HTML/JS; light and dark; renders with textContent only.
  - [src/util/tailnet.ts](src/util/tailnet.ts): `tailscale ip`, `whois --json` and `status --json`, with an injectable runner.
  - [src/util/caller-authorization.ts](src/util/caller-authorization.ts): identities, rules, and `installAuthorizationGuard`.
  - [scripts/qb-dpapi-protect.ps1](scripts/qb-dpapi-protect.ps1): reads base64 on stdin, writes a DPAPI blob.
- **Changed modules:**
  - [src/util/qb-credentials.ts](src/util/qb-credentials.ts): store v2 with `authorizedPeers`, atomic write, `upsertLogin` / `removeEntry` / `addAuthorizedPeer` / `removeAuthorizedPeer`, `protectPassword`. The popup code is gone.
  - [src/tools/company-credentials.ts](src/tools/company-credentials.ts): `_edit` returns or opens the page URL; `_list` includes authorizations.
  - [src/index.ts](src/index.ts): `createMcpServer(identity)` factory; `main()` starts stdio plus the web server; new instructions bullets.
  - `qb-status-codes.ts`: adds 9009.
- **Removed:** `scripts/qb-credentials-dialog.ps1`.
- **Verified live on this PC (simulation mode, temp store, port 8799; your real store untouched):**
  - the banner shows both URLs;
  - the page answers on `127.0.0.1` and this PC's tailnet IP;
  - the API without its header gets 403;
  - a real DPAPI save leaves no plaintext on disk (328-char ciphertext);
  - a user-name change keeps the password;
  - a real whois authorization of another of the operator's tailnet devices pinned its node StableID;
  - an MCP client over HTTP via both addresses saw 152 tools with no leak;
  - the stdio `qb_company_credentials_edit` returned the `?file=` URL.
- **Screenshots** (headless Edge) were checked at 1100px light and 520px dark.

## Verify Before Continuing

- [ ] `npm run build` → exit 0.
- [ ] `npm test` passes. `QB_UI_TESTS=1 npx vitest run` → 1787 tests pass; these open OFF-SCREEN windows titled "AUTOFILL TEST - DO NOT TYPE HERE".
- [ ] Start the server (Claude Desktop restart, or `QB_HTTP_ONLY=1 node dist/index.js`). The banner prints `Logins page: http://127.0.0.1:8765/  http://<tailnet IP>:8765/`, and the page opens in a browser.
- [ ] **(Operator, live) #105 open criterion:**
  1. On another tailnet device, add the MCP server `{ "type": "http", "url": "http://<host tailnet IP>:8765/mcp" }`.
  2. Call `qb_company_list`: it should show nothing authorized and return 9009 on data tools.
  3. Authorize that device for one file on the page.
  4. `qb_company_list` now shows the file, and `qb_company_open` works.
- [ ] **(Operator, live) #93 still open:** a password-protected `.qbw` with a saved login → `qb_company_open({companyFile, closeCurrentCompany:true})` → `loginAutofill:"filled"`. See ACCEPTANCE_CRITERIA Item 93.
- [ ] Windows Firewall: a first bind on the tailnet IP may raise a firewall prompt for node.exe. Allow it on the Tailscale (private) network only.

## Next Task

Operator-run live checks for **#105** and **#93** (steps above). Then the review backlog in todo.md Phase 20, starting with **#94: parser numeric coercion** and **#95/#96** (Add/Mod element order and names). Phase 19 #92 (installer) is still gated on the signing-cert decision.

## Context Notes

- **Every tool is guarded automatically for remote callers.** `installAuthorizationGuard` wraps `server.tool` and must run before the `register*Tools` calls (it does, inside `createMcpServer`).
  - A new tool needs nothing special unless it should be callable without an authorized active file. In that case add it to `ALWAYS_ALLOWED` **and** make sure it exposes no company data, or filter its output in `filterResult`.
- **One QB session is shared by all callers.** That's why remote calls are checked against the file active *at call time*, not "the file this agent opened". Concurrent multi-file use is out of scope (F13.4).
- **Identity:**
  - Loopback and this PC's own tailnet IP are `local` (unrestricted).
  - Other 100.64/10 addresses go through `tailscale whois` (60s cache; `clearWhoisCache()` for tests).
  - Page admins are `local` plus devices of the same Tailscale login as this PC (never `tagged-devices`) plus `QB_WEB_ADMINS`. On a single-owner tailnet every device is therefore a page admin; per-file MCP authorization is separate.
- **Test seams:**
  - `startWebServer({ port: 0, listenHosts: ["127.0.0.1"], tailscale: fakeRunner, protect: fakeProtect, identifyCaller })`. `identifyCaller` lets tests act as remote devices from loopback (see tests/company-credentials.test.ts, which drives a real SDK `Client` over HTTP).
  - `upsertLogin(..., { protect })` avoids PowerShell.
- **Port collisions:** if 8765 is busy (e.g. a second MCP process), the page and `/mcp` are skipped with a stderr note. Stdio MCP still works, and both processes share the same store.
- **Store compatibility:** v1 files (popup era) load fine. The autofill script reads `entries[].companyFile/username/password` only, so it is unaffected by v2.
- **PowerShell helpers:**
  - They must stay pure ASCII (a test enforces this).
  - Pass secrets via stdin as base64, never as argv.
  - In 5.1, `ConvertFrom-Json` emits arrays as one object.
  - Exceptions inside WinForms handlers are swallowed.
- **Never put a fake "QuickBooks login" window on the operator's screen**, and **never probe real client books** (blocked as production reads). Both apply from earlier today.
- **Carried gotchas:**
  - Live mode needs Node v20.20.2 at `C:\nvm4w\nodejs\node.exe`.
  - statusCodes 9001-9009; 9007 has 6 reasons.
  - `*Core` methods gate dry-run and read-only.
  - The sim dispatch-order rule still applies.
