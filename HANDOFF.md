# Handoff State

> **Update 2026-10-07 (later): #112 open items closed (live check pending).**
> - `qb_company_open({ workstation })`, `qb_workstation_list`, `qb_workstation_use` ([src/tools/workstations.ts](src/tools/workstations.ts)); the choice is per agent connection (`HubSessions.contextFor`).
> - 9008 now carries `heldBy` (hub session with the exact file, else QuickBooks' title bar on another workstation).
> - Fix: "in use by another user" without `launchIfClosed` is 9008, not -1.
> - SKILL.md / TOOLS.md / README updated. 69 files / 1847 passed (the 5 Windows-only failures, as before).

> **Update 2026-10-07: hub + connector made production-shaped (#110-#112), merged to master.**
> - **Several workstations at once** ([src/hub/sessions.ts](src/hub/sessions.ts)): per-workstation sessions; agents on a workstation use their own PC; others use the default.
> - **File server:** connectors report mapped drives as UNC ([src/connector/unc-host.ts](src/connector/unc-host.ts), `toUncPath`).
> - **Import saved logins** ([src/hub/import-logins.ts](src/hub/import-logins.ts), [src/connector/login-export.ts](src/connector/login-export.ts), `scripts/qb-dpapi-unprotect.ps1`).
> - **One-line installer** ([src/hub/installer.ts](src/hub/installer.ts)): `/connector/install.ps1` + `/connector/package.tgz` (packed in the hub image).
> - **Verified:** 69 files / 1843 passed (the 5 Windows-only failures, as before); all .ps1 files parse in pwsh; on the tower, the hub served the installer and package, and a connector installed from that package registered.
> - **Verify first (Windows, live):** ACCEPTANCE_CRITERIA Items 111, 110, 109 (in that order): install line → Available → login import / save → agent opens a file (autofill) → P&L → second workstation → each agent hits its own PC.
> - **Next:** #112 leftovers (`workstation` arg, 9008 holder), then live fixes from the Windows run.

> **Update 2026-10-06 (latest): #110 hub + connector built and deployed on the tower; live Windows check pending.** Branch `feat/connector-phase1`.
> - **Hub:** `QB_HUB=1`, Docker in [deploy/hub/](deploy/hub/) (runs on the office Linux box, :8765, tailnet + loopback). Always up; the control page lists **Workstations** and gives the PowerShell line to enable one. `deploy/hub/.env` pins `QB_CONNECTOR_PACKAGE` to this branch until it merges.
> - **Connector:** `quickbooks-desktop-mcp-connector` ([src/connector/](src/connector/)), port 8766; checks in every 30 s; serves QBHost + COM + autofill to the hub only.
> - **Verified:** `tests/hub-connector.test.ts` (10) + full suite 1835 passed (5 Windows-only failures, as on master). On the tower: a real connector registered, showed Available / In use; Browse and MCP `qb_health` went through it; it was then removed.
> - **Verify first (Windows, live):** ACCEPTANCE_CRITERIA Item 110: enable a workstation from the page's line, save a login, open a file through an agent (autofill on the real dialog), P&L, switch, stop the connector → Offline/9012.
> - **Next:** the UNC mapping for mapped drive letters (#110 last box), then #111 (installer + at-logon task + firewall + `vr` login/grant import), #112 (several workstations at once).
> - **Gotchas:** HubHost forwarders are `async` on purpose (no-workstation must reject, not throw). The connector's `requestTimeout = 0` and the hub client uses node:http: QuickBooks calls can take 10 min, past fetch/undici's 5-min headers limit.

> **Update 2026-10-06 (latest): new direction, hub + connector. Phase 1 (#109) built, live smoke pending.**
> - **Direction:** the operator wants the server on the office Linux box (hub) and only a thin connector on each QB workstation. Full design, operator answers and phases: [docs/CONNECTOR_DESIGN.md](docs/CONNECTOR_DESIGN.md). Decision logged in DECISIONS.md (reverses the qb-bridge rejection). Phase 21 in todo.md (#109-#112).
> - **#109 built:** [src/session/qb-host.ts](src/session/qb-host.ts) (`QBHost`, `localQBHost`); the manager's machine seams default to the host and are awaited; the page and `qb_health` / `qb_company_list` use `session.getHost()`. Tests: `tests/qb-host.test.ts`; 68 files / 1825 passed (only the 5 Windows-only tests fail on Linux, as on master). Smoke in simulation over HTTP is fine.
> - **Verify first (Windows, live):** ACCEPTANCE_CRITERIA Item 109: open a file, P&L, switch, Browse → Drives. Same behavior as before.
> - **Next task:** #110, the connector + `RemoteQBHost` + hub-held vault + UNC identity + 9012, single workstation.
> - **Gotcha:** existing tests replace the manager seams with sync functions via `(mgr as any).xImpl = ...`. Keep every call site `await`-ing the seam so both sync stubs and the async host work.

> **Update 2026-10-06 (later): #108 company-file picker, built + sim/demo-verified, live check pending.**
> - **What:** the Company files form gains a **Browse…** button. It opens an inline picker: this computer's drives (local, network, removable) → folders → `.qbw` files. Clicking a file fills the path. It starts at the typed file's folder, then the last folder browsed, then `QB_COMPANY_ROOT`, then the drive list.
> - **Code:** [src/util/fs-browse.ts](src/util/fs-browse.ts) (`defaultDriveLister` uses PowerShell `[System.IO.DriveInfo]::GetDrives()` with an 8 s limit and falls back to probing C:–Z:; `browseDirectory` returns folders + `.qbw` only). `POST /api/browse` in [src/web/server.ts](src/web/server.ts) (`{path:""}` → drives) is admin-only like every `/api/*`. Picker UI in [src/web/admin-page.ts](src/web/admin-page.ts). `listDrives` is a new test seam.
> - **Verified:** `npm run build` green; 67 files / 1821 passed. On Linux, 5 tests in com-isolation + qb-desktop-launch fail; they are Windows-only and fail identically on master. Demo page (`scripts/demo-control-page.mjs`) clicked through in headless Chrome: open → folder → pick file fills the form and recognizes the saved login; drive list; 520px width.
> - **Verify live (Windows):** open the picker → **Drives** lists every drive letter incl. mapped network drives (with labels); a disconnected network drive shows "not ready" and doesn't hang the list; browse to a client folder and pick a `.qbw`. See ACCEPTANCE_CRITERIA Item 108.
> - **Gotcha:** mapped drive letters are per Windows logon. If the server ever runs as a service under another account, the user's mapped drives won't appear. Type the UNC path (`\\server\share`) in the picker's path box instead.

> **Update 2026-10-06: #107 done, #106 now fully live-verified.**
> - QBXMLRP2 runs in a forked helper ([src/session/com-worker.ts](src/session/com-worker.ts) via [com-worker-client.ts](src/session/com-worker-client.ts)), so a QuickBooks crash can't segfault the server any more (it did on 2026-10-05).
> - Per-call time limits. "The ticket parameter is invalid." is now recognized as QB-gone, plus a health-probe fallback for unknown wording.
> - Idle release after `QB_IDLE_RELEASE_MINUTES` (default 10), so the operator can close QuickBooks.
> - Live results:
>   - mid-session kill → recovered, P&L returned in 36 s, server up;
>   - idle release observed;
>   - cold start through the helper → 84 s.
> - Totals: 66 files / 1825 tests. Still open: #105 (an agent on a second tailnet device) and #93 (a password-protected file through the full switch, already mostly shown live).
> - Test gotcha: suites that build a live-mode manager must stub `healthImpl` or set `autoRecover = false`. Otherwise the recovery safety net calls the REAL health probe and the result depends on whether QuickBooks is running on the machine.


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
