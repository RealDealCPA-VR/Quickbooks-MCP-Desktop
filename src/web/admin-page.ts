/**
 * The local "QuickBooks MCP" control page, served by src/web/server.ts at
 * GET /. Self-contained HTML/CSS/JS (no external requests, works offline on
 * the tailnet). Tabs:
 *   Overview            live pipeline (agents → server → QuickBooks), health,
 *                       recovery actions, background job, recent activity
 *   Company files       add / change logins, open a file in QuickBooks
 *   Access              file × tailnet-device grid (click to grant/revoke)
 *   Activity            filterable timeline
 *   Storage & security  where things live, what is encrypted, who sees what
 * All data comes from /api/state and is rendered with textContent, never
 * innerHTML, because paths and names are untrusted text.
 * NOTE: this is a String.raw template: the page JS must not use backticks
 * or dollar-brace sequences.
 */

export const ADMIN_PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QuickBooks MCP Control</title>
<style>
  :root {
    --bg: #f4f6f9; --panel: #ffffff; --panel2: #f8fafc; --text: #1b2230; --muted: #5d6b7c; --border: #dfe4ea;
    --accent: #1f6feb; --accent-text: #ffffff; --chip: #eef2f7;
    --ok: #1a7f37; --ok-bg: #e6f4ea; --warn: #9a6700; --warn-bg: #fff4d6; --bad: #b42318; --bad-bg: #fdecea; --info: #0b5cad; --info-bg: #e8f1fd; --idle: #6b7280; --idle-bg: #eef0f3;
    --shadow: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1318; --panel: #171d25; --panel2: #1c232d; --text: #e6e9ee; --muted: #9aa6b5; --border: #2a3441;
      --accent: #4c8dff; --accent-text: #0b1220; --chip: #233041;
      --ok: #6fd391; --ok-bg: #12301f; --warn: #f2c46d; --warn-bg: #33270f; --bad: #f4a3a3; --bad-bg: #3a1717; --info: #8ab8ff; --info-bg: #13243d; --idle: #9aa6b5; --idle-bg: #222a35;
      --shadow: none;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body { background: var(--bg); color: var(--text); font: 14.5px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header.top { background: var(--panel); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 5; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 0 16px; }
  .topline { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0 8px; flex-wrap: wrap; }
  .brand { display: flex; align-items: center; gap: 10px; }
  .logo { width: 30px; height: 30px; border-radius: 8px; background: var(--accent); color: var(--accent-text); display: grid; place-items: center; font-weight: 700; font-size: 13px; }
  .brand h1 { font-size: 17px; margin: 0; }
  .brand p { margin: 0; color: var(--muted); font-size: 12.5px; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .chip { display: inline-flex; align-items: center; gap: 6px; background: var(--chip); border-radius: 999px; padding: 2px 10px; font-size: 12.5px; max-width: 100%; overflow-wrap: anywhere; }
  .chip.ok { background: var(--ok-bg); color: var(--ok); } .chip.warn { background: var(--warn-bg); color: var(--warn); }
  .chip.bad { background: var(--bad-bg); color: var(--bad); } .chip.info { background: var(--info-bg); color: var(--info); }
  nav.tabs { display: flex; gap: 2px; overflow-x: auto; }
  nav.tabs button { border: none; background: none; color: var(--muted); padding: 10px 14px; font: inherit; font-weight: 600; cursor: pointer; border-bottom: 2px solid transparent; white-space: nowrap; border-radius: 0; }
  nav.tabs button[aria-selected=true] { color: var(--text); border-bottom-color: var(--accent); }
  nav.tabs .count { background: var(--chip); border-radius: 999px; padding: 0 7px; font-size: 11.5px; margin-left: 4px; }
  main { padding: 18px 0 64px; }
  section.tab { display: none; } section.tab.active { display: block; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 18px; margin-bottom: 16px; box-shadow: var(--shadow); min-width: 0; }
  .panel h2 { font-size: 15.5px; margin: 0 0 4px; }
  .panel .lead { color: var(--muted); margin: 0 0 14px; font-size: 13.5px; }
  .grid2 { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; }
  .grid2 > * { min-width: 0; }
  .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
  .tile { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px; box-shadow: var(--shadow); }
  .tile .k { color: var(--muted); font-size: 12.5px; }
  .tile .v { font-size: 24px; font-weight: 700; line-height: 1.2; margin-top: 2px; }
  .tile .s { color: var(--muted); font-size: 12.5px; }
  .hero { display: flex; gap: 14px; align-items: flex-start; border-radius: 12px; padding: 16px; margin-bottom: 14px; }
  .hero .icon { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; font-weight: 800; font-size: 15px; flex: none; }
  .hero h3 { margin: 0; font-size: 17px; }
  .hero p { margin: 4px 0 0; }
  .tone-ok { background: var(--ok-bg); } .tone-ok .icon { background: var(--ok); color: var(--panel); }
  .tone-warn { background: var(--warn-bg); } .tone-warn .icon { background: var(--warn); color: var(--panel); }
  .tone-bad { background: var(--bad-bg); } .tone-bad .icon { background: var(--bad); color: var(--panel); }
  .tone-info { background: var(--info-bg); } .tone-info .icon { background: var(--info); color: var(--panel); }
  .tone-idle { background: var(--idle-bg); } .tone-idle .icon { background: var(--idle); color: var(--panel); }
  .pipe { display: grid; grid-template-columns: 1fr auto 1fr auto 1fr; align-items: stretch; gap: 8px; margin: 4px 0 14px; }
  .node { border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: var(--panel2); min-width: 0; }
  .node .t { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; font-weight: 700; }
  .node .h { font-weight: 700; margin: 4px 0 2px; display: flex; align-items: center; gap: 6px; }
  .node .d { color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex: none; background: var(--idle); }
  .dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); } .dot.bad { background: var(--bad); } .dot.info { background: var(--info); }
  .arrow { align-self: center; color: var(--muted); font-size: 20px; }
  button { font: inherit; border-radius: 8px; border: 1px solid var(--border); background: var(--panel); color: var(--text); padding: 7px 14px; cursor: pointer; }
  button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); font-weight: 600; }
  button.danger { color: var(--bad); border-color: var(--bad); background: var(--panel); }
  button.link { border: none; background: none; color: var(--accent); padding: 2px 4px; }
  button:disabled { opacity: .5; cursor: default; }
  button:focus-visible, input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .row > input:not([type=checkbox]), .row > select { flex: 1 1 180px; min-width: 0; }
  form.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; }
  .full { grid-column: 1 / -1; }
  label.f { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; }
  input[type=text], input[type=password], select { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font: inherit; }
  .hint { color: var(--muted); font-size: 12.5px; margin-top: 4px; }
  .banner { border-radius: 9px; padding: 10px 12px; margin: 0 0 12px; font-size: 13.5px; }
  .banner.ok { background: var(--ok-bg); color: var(--ok); } .banner.warn { background: var(--warn-bg); color: var(--warn); }
  .banner.err { background: var(--bad-bg); color: var(--bad); } .banner.info { background: var(--info-bg); color: var(--info); }
  .hidden { display: none !important; }
  .picker { border: 1px solid var(--border); border-radius: 10px; margin-top: 8px; background: var(--panel2); overflow: hidden; }
  .picker .bar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 8px; border-bottom: 1px solid var(--border); }
  .picker .bar input { flex: 1 1 200px; min-width: 0; }
  .picker .where { padding: 6px 10px 0; color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
  .picker .list { max-height: 300px; overflow-y: auto; padding: 6px; }
  .picker .item { display: flex; width: 100%; gap: 10px; align-items: center; text-align: left; border: none; border-radius: 7px; background: none; padding: 7px 9px; }
  .picker .item:hover, .picker .item:focus-visible { background: var(--chip); }
  .picker .item .n { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .picker .item .m { color: var(--muted); font-size: 12px; white-space: nowrap; }
  .picker .item.qbw .n { font-weight: 600; color: var(--accent); }
  .picker .ico { width: 18px; flex: none; text-align: center; color: var(--muted); }
  code { font: 12.5px ui-monospace, Consolas, monospace; background: var(--chip); padding: 1px 6px; border-radius: 5px; overflow-wrap: anywhere; }
  .muted { color: var(--muted); } .small { font-size: 12.5px; }
  .empty { color: var(--muted); font-style: italic; }
  .file { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
  .file > * { min-width: 0; }
  .file h3 { margin: 0; font-size: 15px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .file .path { color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
  .facts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; overflow-wrap: anywhere; }
  th { font-size: 12px; color: var(--muted); font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
  caption { caption-side: bottom; padding: 10px; text-align: left; }
  .scroll { overflow-x: auto; }
  table.matrix { width: auto; min-width: 100%; }
  table.matrix th, table.matrix td { overflow-wrap: normal; word-break: normal; }
  table.matrix th:first-child, table.matrix td:first-child { min-width: 240px; max-width: 320px; position: sticky; left: 0; background: var(--panel); z-index: 1; overflow-wrap: anywhere; }
  table.matrix th.dev { text-align: center; min-width: 140px; text-transform: none; letter-spacing: 0; font-size: 12.5px; color: var(--text); }
  table.matrix td.cell { text-align: center; vertical-align: middle; }
  .grant { width: 36px; height: 30px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel2); cursor: pointer; font-weight: 700; padding: 0; }
  .grant.on { background: var(--ok-bg); color: var(--ok); border-color: var(--ok); }
  .grant.local { cursor: default; background: var(--info-bg); color: var(--info); border-color: transparent; opacity: 1; }
  .ev { display: grid; grid-template-columns: 92px 14px 1fr; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); }
  .ev .when { color: var(--muted); font-size: 12px; padding-top: 2px; }
  .ev .msg { overflow-wrap: anywhere; }
  .ev .det { color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
  .lvl { width: 12px; height: 12px; border-radius: 50%; margin-top: 5px; background: var(--idle); }
  .lvl.success { background: var(--ok); } .lvl.warn { background: var(--warn); } .lvl.error { background: var(--bad); } .lvl.info { background: var(--info); }
  .filters { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
  .filters button[aria-pressed=true] { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
  pre.json { background: var(--panel2); border: 1px solid var(--border); border-radius: 10px; padding: 12px; overflow: auto; max-height: 360px; margin: 0; font: 12.5px ui-monospace, Consolas, monospace; }
  .spinner { width: 15px; height: 15px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; display: inline-block; vertical-align: -2px; margin-right: 8px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  .kv { display: grid; grid-template-columns: 150px 1fr; gap: 6px 12px; font-size: 13.5px; margin: 0; }
  .kv dt { color: var(--muted); } .kv dd { margin: 0; overflow-wrap: anywhere; }
  @media (max-width: 860px) { .grid2 { grid-template-columns: 1fr; } .tiles { grid-template-columns: repeat(2, 1fr); } .pipe { grid-template-columns: 1fr; } .arrow { transform: rotate(90deg); justify-self: center; } }
  @media (max-width: 560px) { form.grid { grid-template-columns: 1fr; } .kv { grid-template-columns: 1fr; } .ev { grid-template-columns: 70px 12px 1fr; } .file { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header class="top">
  <div class="wrap">
    <div class="topline">
      <div class="brand">
        <div class="logo" aria-hidden="true">QB</div>
        <div><h1>QuickBooks MCP control</h1><p>Logins, access and live status for the agents using QuickBooks on this computer</p></div>
      </div>
      <div class="chips" id="topChips"></div>
    </div>
    <nav class="tabs" role="tablist">
      <button role="tab" data-tab="overview" aria-selected="true">Overview</button>
      <button role="tab" data-tab="files" aria-selected="false">Company files <span class="count" id="cntFiles">0</span></button>
      <button role="tab" data-tab="access" aria-selected="false">Access</button>
      <button role="tab" data-tab="activity" aria-selected="false">Activity</button>
      <button role="tab" data-tab="storage" aria-selected="false">Storage &amp; security</button>
    </nav>
  </div>
</header>

<main class="wrap">
  <div id="fatal" class="banner err hidden"></div>
  <div id="toast" class="banner hidden" role="status"></div>

  <section class="tab active" id="tab-overview">
    <div id="jobBox" class="banner info hidden" role="status"></div>
    <div class="panel">
      <div id="hero" class="hero tone-idle"><div class="icon" id="heroIcon">?</div><div><h3 id="heroTitle">Checking QuickBooks...</h3><p id="heroText" class="muted"></p><div class="facts" id="heroDialogs"></div></div></div>
      <div class="pipe" id="pipe"></div>
      <div class="row">
        <button class="primary" id="btnReconnect" type="button">Reconnect</button>
        <select id="openSelect" aria-label="Company file to open"></select>
        <button id="btnOpen" type="button">Open in QuickBooks</button>
        <button id="btnDisconnect" type="button">Disconnect</button>
        <button id="btnForce" class="danger hidden" type="button">Force close QuickBooks</button>
      </div>
      <p class="hint">Reconnect reopens the same company file, starting QuickBooks and logging in if needed. After a crash, agents' read requests do this by themselves. Writes are never repeated automatically.</p>
    </div>
    <div class="tiles" id="tiles"></div>
    <div class="grid2">
      <div class="panel"><h2>Recent activity</h2><p class="lead">What the server just did. <button class="link" type="button" data-goto="activity">See everything</button></p><div id="recent"></div></div>
      <div class="panel"><h2>Connections</h2><p class="lead">How agents reach this server.</p><div id="connections"></div></div>
    </div>
  </section>

  <section class="tab" id="tab-files">
    <div class="panel" id="editor">
      <h2 id="editorTitle">Add a login</h2>
      <p class="lead">Enter each company file's QuickBooks login once. The server uses it to log into QuickBooks when an agent opens the file. Agents never see it.</p>
      <div id="already" class="banner ok hidden"></div>
      <div id="formMsg" class="banner hidden"></div>
      <form class="grid" id="loginForm" autocomplete="off">
        <div class="full">
          <label class="f" for="companyFile">Company file (.qbw)</label>
          <div class="row" style="flex-wrap:nowrap">
            <input type="text" id="companyFile" list="fileOptions" placeholder="C:\Clients\Acme Bakery\Acme Bakery.qbw" spellcheck="false" required>
            <button type="button" id="browseBtn" aria-expanded="false" aria-controls="picker">Browse&hellip;</button>
          </div>
          <datalist id="fileOptions"></datalist>
          <div class="picker hidden" id="picker" role="region" aria-label="Choose a company file on this computer">
            <div class="bar">
              <button type="button" id="pkDrives">Drives</button>
              <button type="button" id="pkUp" aria-label="Up one folder">Up</button>
              <input type="text" id="pkPath" aria-label="Folder path" placeholder="Type or paste a folder, e.g. D:\Clients" spellcheck="false">
              <button type="button" id="pkGo">Go</button>
              <button type="button" id="pkClose" class="link">Close</button>
            </div>
            <div class="where" id="pkWhere"></div>
            <div class="list" id="pkList"></div>
          </div>
          <div class="hint">Full path as this computer sees it. Use <b>Browse</b> to pick from this computer's drives and folders, choose from the list, or paste a path.</div>
        </div>
        <div>
          <label class="f" for="username">QuickBooks user name</label>
          <input type="text" id="username" placeholder="Admin" spellcheck="false" required>
        </div>
        <div>
          <label class="f" for="password">Password</label>
          <div class="row" style="flex-wrap:nowrap">
            <input type="password" id="password" autocomplete="new-password" spellcheck="false">
            <button type="button" id="togglePw" aria-label="Show password">Show</button>
          </div>
          <div class="hint" id="pwHint">Leave blank if this QuickBooks user has no password.</div>
          <label class="row hint" style="margin-top:6px"><input type="checkbox" id="clearPw"> Remove the saved password (user has none)</label>
        </div>
        <div class="full row">
          <button type="submit" class="primary" id="saveBtn">Save login</button>
          <button type="button" id="resetBtn">Clear form</button>
        </div>
      </form>
    </div>
    <div class="panel"><h2>Saved company files</h2><p class="lead">Every file with a saved login or device access.</p><div id="saved"></div></div>
    <div class="panel"><h2>Found on this computer without a login</h2><p class="lead" id="discLead"></p><div id="discovered"></div></div>
  </section>

  <section class="tab" id="tab-access">
    <div class="panel">
      <h2>Who can use which company file</h2>
      <p class="lead">Click a cell to give a tailnet device access to a file, or to take it away. Changes apply to the device's next request.</p>
      <div class="grid2" style="margin-bottom:14px">
        <dl class="kv small">
          <dt>This computer</dt><dd>Agents here (Claude Desktop, or http://127.0.0.1) can use <b>every</b> file.</dd>
          <dt>Tailnet devices</dt><dd>Only the files ticked below. Each device is recognized by its tailnet address, checked against its Tailscale identity, so another machine can't borrow the address.</dd>
          <dt>Not ticked</dt><dd>The device's agent is told "not authorized" (status 9009) and never sees the file in its lists.</dd>
        </dl>
        <dl class="kv small" id="adminInfo"></dl>
      </div>
      <div class="scroll"><table class="matrix" id="matrix"></table></div>
      <div class="row" style="margin-top:12px">
        <input type="text" id="extraAddr" placeholder="Device not listed? Its tailnet address, e.g. 100.101.102.103" spellcheck="false">
        <select id="extraFile" aria-label="Company file"></select>
        <button type="button" id="extraAdd">Give access</button>
      </div>
    </div>
  </section>

  <section class="tab" id="tab-activity">
    <div class="panel">
      <h2>Activity</h2>
      <p class="lead">Newest first. Kept on this computer and survives restarts. It never contains passwords or company data.</p>
      <div class="filters" id="filters"></div>
      <div id="timeline"></div>
    </div>
  </section>

  <section class="tab" id="tab-storage">
    <div class="grid2">
      <div class="panel"><h2>Where everything is kept</h2><p class="lead">All on this computer. Nothing is sent anywhere else.</p><dl class="kv" id="where"></dl></div>
      <div class="panel"><h2>How passwords are protected</h2><p class="lead">What happens after you click Save.</p><ol class="small" style="margin:0;padding-left:18px;line-height:1.7">
        <li>The password goes from this page to the server on this computer only.</li>
        <li>It is encrypted right away with <b>Windows DPAPI</b>, locked to your Windows account on this PC. Copied to another computer or account, it can't be read.</li>
        <li>Only the encrypted text is written to disk. The typed password is not kept.</li>
        <li>When an agent opens the file, the server decrypts it just long enough to type it into QuickBooks' login window.</li>
        <li>Agents only learn the <b>user name</b> and <b>whether a password is saved</b>. No tool, log or page shows the password.</li>
      </ol></div>
    </div>
    <div class="panel"><h2>What is stored for each company file</h2><div class="scroll"><table id="storeTable"></table></div></div>
    <div class="panel"><h2>The logins file, with secrets hidden</h2><p class="lead">What <code id="vaultName">credentials.json</code> holds, with each encrypted password replaced by a placeholder.</p><pre class="json" id="redacted"></pre></div>
  </section>
</main>

<script>
(function () {
  "use strict";
  var state = null, lastFetch = 0, activityFilter = "all", toastTimer = null, timer = null;
  var $ = function (id) { return document.getElementById(id); };
  var norm = function (p) { return String(p || "").trim().replace(/\//g, "\\").toLowerCase(); };
  var base = function (p) { var s = String(p || "").split(/[\\/]/).pop() || String(p || ""); return s.replace(/\.qbw$/i, ""); };
  var fmt = function (iso) { if (!iso) return ""; var d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString(); };
  function ago(iso) {
    if (!iso) return "never";
    var s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 5) return "just now"; if (s < 60) return s + "s ago"; if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago"; return Math.round(s / 86400) + " d ago";
  }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function chip(text, tone) { return el("span", text, "chip" + (tone ? " " + tone : "")); }
  function dot(tone) { return el("span", null, "dot " + (tone || "")); }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function btn(text, cls, onclick) { var b = el("button", text, cls); b.type = "button"; b.onclick = onclick; return b; }
  function toast(msg, kind) {
    var t = $("toast"); t.textContent = msg; t.className = "banner " + (kind || "ok");
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = "banner hidden"; }, 7000);
  }
  function api(path, body) {
    return fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json", "X-QB-Admin": "1" } : { "X-QB-Admin": "1" },
      body: body ? JSON.stringify(body) : undefined, credentials: "same-origin", cache: "no-store"
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ("Request failed (" + r.status + ")"));
        return j;
      });
    });
  }

  function showTab(name) {
    document.querySelectorAll("nav.tabs button").forEach(function (b) { b.setAttribute("aria-selected", String(b.dataset.tab === name)); });
    document.querySelectorAll("section.tab").forEach(function (s) { s.classList.toggle("active", s.id === "tab-" + name); });
    try { localStorage.setItem("qbmcp.tab", name); } catch (e) {}
  }
  document.querySelectorAll("nav.tabs button").forEach(function (b) { b.onclick = function () { showTab(b.dataset.tab); }; });
  document.querySelectorAll("[data-goto]").forEach(function (b) { b.onclick = function () { showTab(b.dataset.goto); }; });

  var HEALTH = {
    ready: ["ok", "OK", "Ready"], login: ["info", "...", "At its login window"], starting: ["info", "...", "Starting"],
    "not-running": ["idle", "off", "Not running"], dialog: ["warn", "!", "Waiting on a dialog"],
    "not-responding": ["bad", "!", "Not responding"], "file-doctor": ["warn", "FD", "File Doctor running"],
    crashed: ["bad", "X", "Crashed"], unsupported: ["idle", "?", "Unknown"]
  };
  function findSaved(path) { var k = norm(path); return (state.entries || []).filter(function (e) { return norm(e.companyFile) === k; })[0] || null; }
  function allFiles() {
    var seen = {}, out = [];
    (state.entries || []).concat(state.discovered || []).forEach(function (x) { var k = norm(x.companyFile); if (!seen[k]) { seen[k] = 1; out.push(x.companyFile); } });
    return out;
  }

  function renderTop() {
    var c = clear($("topChips")), me = state.me;
    c.appendChild(chip(state.simulationMode ? "Simulation mode" : "Live QuickBooks", state.simulationMode ? "warn" : "ok"));
    c.appendChild(chip(me.kind === "local" ? "You: this computer" : "You: " + me.nodeName + " (" + me.address + ")"));
    var u = chip("Updated just now"); u.id = "updChip"; c.appendChild(u);
    $("cntFiles").textContent = String((state.entries || []).length);
  }

  function renderHero() {
    var h = state.health, t = HEALTH[h.state] || HEALTH.unsupported, sess = state.session || {};
    var title = h.summary;
    if (h.state === "ready" && sess.connected) title = "All good: agents are connected to " + base(sess.companyFile).replace(/\.+$/, "") + ".";
    else if (h.state === "ready") title = h.summary + " The server connects on the next agent request.";
    $("hero").className = "hero tone-" + t[0];
    $("heroIcon").textContent = t[1];
    $("heroTitle").textContent = title;
    $("heroText").textContent = h.recommendedAction === "None." ? "Nothing needs your attention." : h.recommendedAction;
    var dd = clear($("heroDialogs"));
    (h.dialogs || []).forEach(function (d) { dd.appendChild(chip("QuickBooks window: " + d, "warn")); });
    if (sess.lastError && (!sess.lastRecovery || sess.lastError.at > sess.lastRecovery.at)) dd.appendChild(chip("Last error " + ago(sess.lastError.at) + ": " + sess.lastError.message.slice(0, 140), "bad"));
    $("btnForce").classList.toggle("hidden", !(h.state === "not-responding" || h.state === "crashed"));
  }

  function node(title, tone, head, lines) {
    var n = el("div", null, "node"); n.appendChild(el("div", title, "t"));
    var hh = el("div", null, "h"); hh.appendChild(dot(tone)); hh.appendChild(el("span", head)); n.appendChild(hh);
    lines.forEach(function (d) { n.appendChild(el("div", d, "d")); }); return n;
  }
  function renderPipe() {
    var p = clear($("pipe")), a = state.agents || { stdio: false, http: [] }, s = state.session || {}, h = state.health;
    var n = (a.stdio ? 1 : 0) + a.http.length, lines = [];
    if (a.stdio) lines.push("Claude Desktop / local host (stdio)");
    a.http.forEach(function (x) { lines.push(x.caller + ", active " + ago(x.lastSeenAt)); });
    if (!lines.length) lines.push("No agents connected right now");
    p.appendChild(node("Agents", n ? "ok" : "", n + " connected", lines));
    p.appendChild(el("div", "\u2192", "arrow"));
    p.appendChild(node("This server", s.operationInProgress ? "info" : s.connected ? "ok" : "", s.operationInProgress ? "Working..." : s.connected ? "Connected to QuickBooks" : "Not connected", [
      "Company file: " + (s.companyFile ? base(s.companyFile) : "whatever QuickBooks has open"),
      "Last request: " + ago(s.lastRequestAt),
      "Reconnect after crashes: " + (s.autoRecover ? "automatic" : "off") + (s.recoveryCount ? " (" + s.recoveryCount + " so far)" : ""),
      s.idleReleaseMinutes ? "Lets go of QuickBooks after " + s.idleReleaseMinutes + " idle min, so you can close it" + (s.lastIdleReleaseAt ? " (last " + ago(s.lastIdleReleaseAt) + ")" : "") : "Holds QuickBooks until disconnected"
    ]));
    p.appendChild(el("div", "\u2192", "arrow"));
    var t = HEALTH[h.state] || HEALTH.unsupported, ql = [h.openCompanyTitle ? "Open: " + h.openCompanyTitle : "No company file open"];
    ((h.raw && h.raw.quickbooks) || []).forEach(function (q) { ql.push("Process " + q.pid + (q.responding ? ", responding" : ", NOT responding") + (q.startedAt ? ", started " + ago(q.startedAt) : "")); });
    ((h.raw && h.raw.fileDoctor) || []).forEach(function (f) { ql.push("File Doctor / Tool Hub: " + (f.title || f.name)); });
    p.appendChild(node("QuickBooks", t[0] === "idle" ? "" : t[0], t[2], ql));
  }

  function renderJob() {
    var j = state.job, b = $("jobBox");
    var busy = !!(j && j.status === "running");
    ["btnReconnect", "btnOpen", "btnForce"].forEach(function (id) { $(id).disabled = busy; });
    if (!j || (!busy && Date.now() - new Date(j.finishedAt).getTime() > 120000)) { b.className = "banner info hidden"; return; }
    clear(b);
    if (busy) { b.className = "banner info"; b.appendChild(el("span", null, "spinner")); b.appendChild(document.createTextNode(j.label + "... (" + ago(j.startedAt).replace(" ago", "") + "). QuickBooks may take a minute or two.")); }
    else { b.className = "banner " + (j.status === "succeeded" ? "ok" : "err"); b.textContent = (j.status === "succeeded" ? "Done: " : "Didn't work: ") + j.label + ". " + (j.message || ""); }
  }

  function tile(k, v, s) { var t = el("div", null, "tile"); t.appendChild(el("div", k, "k")); t.appendChild(el("div", v, "v")); t.appendChild(el("div", s, "s")); return t; }
  function renderTiles() {
    var t = clear($("tiles")), e = state.entries || [], s = state.session || {}, a = state.agents || { stdio: false, http: [] };
    var logins = e.filter(function (x) { return x.username; }), pw = logins.filter(function (x) { return x.hasPassword; }).length;
    var devs = {}; e.forEach(function (x) { x.authorizedPeers.forEach(function (p) { devs[p.address] = 1; }); });
    var missing = (state.discovered || []).filter(function (d) { var x = findSaved(d.companyFile); return !(x && x.username); }).length;
    t.appendChild(tile("Company files with a login", String(logins.length), pw + " with a password" + (missing ? ", " + missing + " found without one" : "")));
    t.appendChild(tile("Tailnet devices with access", String(Object.keys(devs).length), "across " + e.filter(function (x) { return x.authorizedPeers.length; }).length + " company files"));
    t.appendChild(tile("Agents connected", String((a.stdio ? 1 : 0) + a.http.length), a.http.length + " over the tailnet / HTTP"));
    t.appendChild(tile("Automatic reconnects", String(s.recoveryCount || 0), s.lastRecovery ? (s.lastRecovery.ok ? "last one worked, " : "last one FAILED, ") + ago(s.lastRecovery.at) : "none needed yet"));
  }

  function evRow(e) {
    var r = el("div", null, "ev"), w = el("div", ago(e.at), "when"); w.title = fmt(e.at); r.appendChild(w);
    r.appendChild(el("div", null, "lvl " + e.level));
    var m = el("div"); m.appendChild(el("div", e.message, "msg"));
    var det = [e.category, e.detail].filter(Boolean).join(" \u00b7 "); if (det) m.appendChild(el("div", det, "det"));
    r.appendChild(m); return r;
  }
  function renderRecent() {
    var r = clear($("recent")), ev = (state.activity || []).slice(0, 8);
    if (!ev.length) { r.appendChild(el("p", "Nothing yet.", "empty")); return; }
    ev.forEach(function (e) { r.appendChild(evRow(e)); });
  }
  function copyRow(label, value) {
    var row = el("div", null, "row"); row.style.marginBottom = "8px";
    row.appendChild(el("span", label, "small muted")); row.appendChild(el("code", value));
    row.appendChild(btn("Copy", "", function () {
      if (navigator.clipboard) navigator.clipboard.writeText(value).then(function () { toast("Copied " + value); }, function () { toast(value, "info"); });
      else toast(value, "info");
    }));
    return row;
  }
  function renderConnections() {
    var c = clear($("connections")), a = state.agents || { stdio: false, http: [] };
    c.appendChild(el("p", a.stdio ? "Claude Desktop (or another local host) is connected over stdio." : "This server runs without a local stdio host (HTTP only).", "small"));
    (state.mcpUrls || []).forEach(function (u) { c.appendChild(copyRow("Remote agents:", u)); });
    c.appendChild(copyRow("This page:", location.origin + "/"));
    c.appendChild(el("p", "A remote agent only sees the company files ticked for its device on the Access tab.", "hint"));
  }

  function syncForm() {
    var e = findSaved($("companyFile").value);
    if (e && e.username) {
      $("editorTitle").textContent = "Change the login for " + base(e.companyFile);
      var b = $("already"); b.className = "banner ok";
      b.textContent = "Already saved: user \u201c" + e.username + "\u201d" + (e.hasPassword ? " with a password" : " with no password") + (e.updatedAt ? " (last changed " + fmt(e.updatedAt) + ")" : "") + ". Nothing to re-enter. Change only what is different; saving replaces the old login.";
      if (!$("username").dataset.touched) $("username").value = e.username;
      $("password").placeholder = e.hasPassword ? "Saved. Leave blank to keep it" : "";
      $("pwHint").textContent = e.hasPassword ? "Type a new password only if it changed." : "Leave blank if this QuickBooks user has no password.";
      $("saveBtn").textContent = "Save changes";
    } else {
      $("editorTitle").textContent = "Add a login"; $("already").className = "banner hidden";
      $("password").placeholder = ""; $("pwHint").textContent = "Leave blank if this QuickBooks user has no password."; $("saveBtn").textContent = "Save login";
    }
  }
  function fillForm(path) {
    $("companyFile").value = path; $("username").value = ""; delete $("username").dataset.touched;
    $("password").value = ""; $("clearPw").checked = false; $("formMsg").className = "banner hidden";
    syncForm(); showTab("files"); $("editor").scrollIntoView({ behavior: "smooth", block: "start" });
    ($("username").value ? $("password") : $("username")).focus();
  }
  function openFile(path) {
    if (!confirm("Open " + base(path) + " in QuickBooks?\n\nIf QuickBooks has another company file open, it is closed normally first, as if you clicked X. If QuickBooks asks you something, answer it.")) return;
    api("/api/session/open", { companyFile: path }).then(function () { showTab("overview"); load(); }).catch(function (e) { toast(e.message, "err"); });
  }
  function renderSaved() {
    var box = clear($("saved")), active = norm(state.activeCompanyFile), sess = state.session || {};
    if (!(state.entries || []).length) { box.appendChild(el("p", "No logins saved yet. Add one above.", "empty")); return; }
    state.entries.forEach(function (e) {
      var f = el("div", null, "file"), left = el("div"), h = el("h3", base(e.companyFile));
      if (norm(e.companyFile) === active) h.appendChild(chip(sess.connected ? "Open now" : "Current file", sess.connected ? "ok" : "info"));
      left.appendChild(h); left.appendChild(el("div", e.companyFile, "path"));
      var facts = el("div", null, "facts");
      facts.appendChild(e.username ? chip("User: " + e.username, "info") : chip("No login saved", "warn"));
      if (e.username) facts.appendChild(e.hasPassword ? chip("Password saved (encrypted)", "ok") : chip("No password"));
      facts.appendChild(chip(e.authorizedPeers.length ? e.authorizedPeers.length + " tailnet device" + (e.authorizedPeers.length === 1 ? "" : "s") : "This computer only"));
      if (e.updatedAt) facts.appendChild(chip("Changed " + ago(e.updatedAt)));
      left.appendChild(facts); f.appendChild(left);
      var act = el("div", null, "row");
      act.appendChild(btn("Open in QuickBooks", "", function () { openFile(e.companyFile); }));
      act.appendChild(btn("Change login", "", function () { fillForm(e.companyFile); }));
      act.appendChild(btn("Delete", "danger", function () {
        if (confirm("Delete the saved login and device access for " + base(e.companyFile) + "?")) api("/api/logins/delete", { companyFile: e.companyFile }).then(function () { toast("Deleted " + base(e.companyFile)); load(); }).catch(function (x) { toast(x.message, "err"); });
      }));
      f.appendChild(act); box.appendChild(f);
    });
  }
  function renderDiscovered() {
    var box = clear($("discovered"));
    $("discLead").textContent = state.discoveryRoot ? "Searched " + state.discoveryRoot + " (3 folders deep)." : "Set QB_COMPANY_ROOT in the MCP server's settings to list company files automatically.";
    var list = (state.discovered || []).filter(function (d) { var s = findSaved(d.companyFile); return !(s && s.username); });
    if (state.discoveryRoot && !list.length) { box.appendChild(el("p", "Every company file found has a login.", "empty")); return; }
    list.forEach(function (d) {
      var f = el("div", null, "file"), left = el("div");
      left.appendChild(el("h3", d.displayName)); left.appendChild(el("div", d.companyFile, "path")); f.appendChild(left);
      f.appendChild(btn("Add login", "primary", function () { fillForm(d.companyFile); }));
      box.appendChild(f);
    });
  }
  function renderSelects() {
    var dl = clear($("fileOptions")), files = allFiles();
    files.forEach(function (p) { var o = document.createElement("option"); o.value = p; dl.appendChild(o); });
    [["openSelect", "Choose a company file to open"], ["extraFile", "Choose a company file"]].forEach(function (pair) {
      var s = $(pair[0]), keep = s.value; clear(s);
      var first = el("option", pair[1]); first.value = ""; s.appendChild(first);
      files.forEach(function (p) { var o = el("option", base(p)); o.value = p; s.appendChild(o); });
      s.value = keep;
    });
  }

  function renderAccess() {
    var t = clear($("matrix")), files = allFiles(), peers = (state.peers || []).filter(function (p) { return !p.isSelf; });
    var known = {}; peers.forEach(function (p) { known[p.address] = 1; });
    (state.entries || []).forEach(function (e) { e.authorizedPeers.forEach(function (p) { if (!known[p.address]) { known[p.address] = 1; peers.push({ address: p.address, nodeName: p.nodeName || p.address, loginName: p.loginName || "", online: false, missing: true }); } }); });
    var ai = clear($("adminInfo")), adm = state.admins || { ownerLogin: null, extra: [] };
    ai.appendChild(el("dt", "Can use this page")); ai.appendChild(el("dd", "This computer" + (adm.ownerLogin ? ", and any tailnet device signed in as " + adm.ownerLogin : "") + (adm.extra.length ? ", plus " + adm.extra.join(", ") : "") + "."));
    ai.appendChild(el("dt", "Remote agents use")); ai.appendChild(el("dd", (state.mcpUrls || []).join("  ") || "(tailnet not available)"));
    if (!files.length) { t.appendChild(el("caption", "No company files yet. Add a login on the Company files tab.", "empty")); return; }
    var thead = el("thead"), hr = el("tr");
    hr.appendChild(el("th", "Company file"));
    var lc = el("th", null, "dev"); lc.appendChild(el("div", "This computer")); lc.appendChild(el("div", "always allowed", "small muted")); hr.appendChild(lc);
    peers.forEach(function (p) {
      var th = el("th", null, "dev"), top = el("div", null, "row"); top.style.justifyContent = "center";
      top.appendChild(dot(p.missing ? "bad" : p.online ? "ok" : "")); top.appendChild(el("span", p.nodeName)); th.appendChild(top);
      th.appendChild(el("div", p.address + (p.missing ? " (not on the tailnet now)" : p.online ? "" : " (offline)"), "small muted"));
      if (p.loginName) th.appendChild(el("div", p.loginName, "small muted"));
      hr.appendChild(th);
    });
    thead.appendChild(hr); t.appendChild(thead);
    var tb = el("tbody");
    files.forEach(function (f) {
      var e = findSaved(f), tr = el("tr"), name = el("td");
      name.appendChild(el("div", base(f))); name.appendChild(el("div", e && e.username ? "Login: " + e.username : "No login saved", "small muted")); tr.appendChild(name);
      var lcell = el("td", null, "cell"), lb = el("button", "\u2713", "grant local"); lb.type = "button"; lb.disabled = true; lb.title = "Agents on this computer can always use every file"; lcell.appendChild(lb); tr.appendChild(lcell);
      peers.forEach(function (p) {
        var granted = !!(e && e.authorizedPeers.some(function (x) { return x.address === p.address; }));
        var td = el("td", null, "cell"), b = el("button", granted ? "\u2713" : "", "grant" + (granted ? " on" : "")); b.type = "button";
        b.setAttribute("aria-pressed", String(granted));
        b.setAttribute("aria-label", (granted ? "Remove " : "Give ") + p.nodeName + " access to " + base(f));
        b.title = granted ? "Click to remove access" : "Click to give access";
        b.onclick = function () {
          b.disabled = true;
          api(granted ? "/api/authorizations/delete" : "/api/authorizations", { companyFile: f, address: p.address })
            .then(function () { toast((granted ? "Removed " + p.nodeName + "'s access to " : "Gave " + p.nodeName + " access to ") + base(f)); load(); })
            .catch(function (x) { b.disabled = false; toast(x.message, "err"); });
        };
        td.appendChild(b); tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    if (!peers.length) t.appendChild(el("caption", "No other tailnet devices found. Is Tailscale running?", "empty"));
  }

  var FILTERS = [["all", "Everything"], ["problems", "Problems"], ["sessions", "Sessions & switching"], ["recovery", "Crashes & recovery"], ["logins", "Logins & access"], ["agents", "Agents"]];
  function matches(e) {
    switch (activityFilter) {
      case "problems": return e.level === "error" || e.level === "warn";
      case "sessions": return e.category === "session" || e.category === "switch" || e.category === "login";
      case "recovery": return e.category === "recovery" || e.category === "health";
      case "logins": return e.category === "logins" || e.category === "access";
      case "agents": return e.category === "agent";
      default: return true;
    }
  }
  function renderActivity() {
    var f = clear($("filters"));
    FILTERS.forEach(function (x) { var b = btn(x[1], "", function () { activityFilter = x[0]; renderActivity(); }); b.setAttribute("aria-pressed", String(activityFilter === x[0])); f.appendChild(b); });
    var tl = clear($("timeline")), ev = (state.activity || []).filter(matches);
    if (!ev.length) { tl.appendChild(el("p", "Nothing here yet.", "empty")); return; }
    ev.forEach(function (e) { tl.appendChild(evRow(e)); });
  }

  function kv(dl, k, v, mono) { dl.appendChild(el("dt", k)); var d = el("dd"); if (mono) d.appendChild(el("code", v)); else d.textContent = v; dl.appendChild(d); }
  function sizeOf(b) { return b == null ? "" : b < 1024 ? b + " bytes" : (b / 1024).toFixed(1) + " KB"; }
  function renderStorage() {
    var w = clear($("where")), st = state.storage || {}, c = st.credentials || {}, a = st.activityLog || {};
    kv(w, "Logins file", c.path || state.vaultPath, true);
    kv(w, "", c.exists ? sizeOf(c.sizeBytes) + ", changed " + fmt(c.modifiedAt) + ", " + (state.entries || []).length + " company files" : "Not created yet: it appears when you save the first login.");
    kv(w, "Activity log", a.path || "", true);
    kv(w, "", a.exists ? sizeOf(a.sizeBytes) + ", changed " + fmt(a.modifiedAt) + " (trimmed automatically at 1 MB)" : "Not created yet.");
    kv(w, "QuickBooks data", "Stays in your .qbw files. The server reads it through QuickBooks and stores none of it.");
    kv(w, "Network", "Only this computer (127.0.0.1) and your tailnet" + ((state.mcpUrls || []).length ? " (" + state.mcpUrls.map(function (u) { return u.replace(/\/mcp$/, ""); }).join(", ") + ")" : "") + ". Not reachable from your local network or the internet.");
    $("vaultName").textContent = String(c.path || "credentials.json").split(/[\\/]/).pop();
    var t = clear($("storeTable")), hr = el("tr"), th = el("thead"), tb = el("tbody");
    ["Company file", "QuickBooks user", "Password", "Tailnet devices allowed", "Last changed"].forEach(function (h) { hr.appendChild(el("th", h)); });
    th.appendChild(hr); t.appendChild(th);
    (state.entries || []).forEach(function (e) {
      var tr = el("tr"), f = el("td"); f.appendChild(el("div", base(e.companyFile))); f.appendChild(el("div", e.companyFile, "small muted")); tr.appendChild(f);
      tr.appendChild(el("td", e.username || "(none: access only)"));
      tr.appendChild(el("td", e.hasPassword ? "Encrypted with Windows DPAPI (hidden)" : "None saved"));
      tr.appendChild(el("td", e.authorizedPeers.length ? e.authorizedPeers.map(function (p) { return (p.nodeName || "device") + " " + p.address; }).join(", ") : "None (this computer only)"));
      tr.appendChild(el("td", fmt(e.updatedAt)));
      tb.appendChild(tr);
    });
    if (!(state.entries || []).length) { var tr = el("tr"), td = el("td", "Nothing stored yet.", "empty"); td.colSpan = 5; tr.appendChild(td); tb.appendChild(tr); }
    t.appendChild(tb);
    $("redacted").textContent = JSON.stringify({ version: 2, entries: (state.entries || []).map(function (e) {
      return { companyFile: e.companyFile, username: e.username, password: e.hasPassword ? "<encrypted with Windows DPAPI: hidden>" : "", updatedAt: e.updatedAt, authorizedPeers: e.authorizedPeers };
    }) }, null, 2);
  }

  function render() {
    renderTop(); renderHero(); renderPipe(); renderJob(); renderTiles(); renderRecent(); renderConnections();
    renderSaved(); renderDiscovered(); renderSelects(); syncForm(); renderAccess(); renderActivity(); renderStorage();
  }
  function schedule() {
    clearTimeout(timer);
    var busy = state && state.job && state.job.status === "running";
    timer = setTimeout(load, document.hidden ? 30000 : busy ? 2000 : 5000);
  }
  function load() {
    return api("/api/state").then(function (s) {
      state = s; lastFetch = Date.now(); $("fatal").className = "banner err hidden"; render();
    }).catch(function (e) {
      $("fatal").textContent = "Can't reach the QuickBooks MCP server: " + e.message + ". It runs only while the MCP server is running.";
      $("fatal").className = "banner err";
    }).then(schedule);
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });
  setInterval(function () { var u = $("updChip"); if (u && lastFetch) u.textContent = "Updated " + ago(new Date(lastFetch).toISOString()); }, 1000);

  $("btnReconnect").onclick = function () { api("/api/session/reconnect", {}).then(load).catch(function (e) { toast(e.message, "err"); }); };
  $("btnOpen").onclick = function () { var v = $("openSelect").value; if (!v) { toast("Choose a company file first.", "warn"); return; } openFile(v); };
  $("btnDisconnect").onclick = function () { api("/api/session/disconnect", {}).then(function () { toast("Disconnected. QuickBooks stays open; the next agent request reconnects."); load(); }).catch(function (e) { toast(e.message, "err"); }); };
  $("btnForce").onclick = function () {
    var typed = prompt("QuickBooks is frozen. Force closing ends it immediately. Anything typed into an unsaved QuickBooks form is lost; saved transactions are safe.\n\nType FORCE CLOSE to continue.");
    if (typed !== "FORCE CLOSE") return;
    api("/api/quickbooks/force-close", { confirm: "FORCE CLOSE" }).then(load).catch(function (e) { toast(e.message, "err"); });
  };
  $("extraAdd").onclick = function () {
    var addr = $("extraAddr").value.trim(), f = $("extraFile").value;
    if (!addr || !f) { toast("Enter a tailnet address and choose a company file.", "warn"); return; }
    api("/api/authorizations", { companyFile: f, address: addr }).then(function () { $("extraAddr").value = ""; toast("Access granted."); load(); }).catch(function (e) { toast(e.message, "err"); });
  };
  // ---- company-file picker: drives -> folders -> .qbw (POST /api/browse) ----
  var pickerAt = null;
  function sizeLabel(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }
  function pickItem(ico, name, meta, cls, onclick) {
    var b = btn("", "item" + (cls ? " " + cls : ""), onclick);
    b.appendChild(el("span", ico, "ico")); b.appendChild(el("span", name, "n"));
    if (meta) b.appendChild(el("span", meta, "m"));
    return b;
  }
  function showDrives() {
    pickerAt = null; $("pkPath").value = ""; $("pkUp").disabled = true;
    $("pkWhere").textContent = "Drives on the computer running QuickBooks";
    var list = clear($("pkList")); list.appendChild(el("p", "Loading drives\u2026", "empty"));
    api("/api/browse", { path: "" }).then(function (r) {
      clear(list);
      if (!r.drives.length) { list.appendChild(el("p", "No drives found.", "empty")); return; }
      var kinds = { fixed: "Local disk", network: "Network drive", removable: "Removable", cdrom: "Disc drive", other: "Drive" };
      r.drives.forEach(function (d) {
        var meta = (d.label ? d.label + " \u00b7 " : "") + (kinds[d.kind] || "Drive") + (d.ready ? "" : " \u00b7 not ready");
        list.appendChild(pickItem("\u25a4", d.path, meta, "", function () { browseTo(d.path); }));
      });
    }).catch(function (e) { clear(list).appendChild(el("p", e.message, "empty")); });
  }
  function browseTo(dir, quiet) {
    var list = $("pkList");
    return api("/api/browse", { path: dir }).then(function (r) {
      pickerAt = r; $("pkPath").value = r.path; $("pkUp").disabled = false;
      try { localStorage.setItem("qbmcp.browse", r.path); } catch (e) {}
      $("pkWhere").textContent = r.files.length ? r.files.length + " company file" + (r.files.length === 1 ? "" : "s") + " here" : "No company files in this folder. Open a folder below.";
      clear(list);
      r.files.forEach(function (f) {
        var saved = findSaved(f.path);
        var meta = (saved && saved.username ? "login saved \u00b7 " : "") + sizeLabel(f.sizeBytes) + " \u00b7 " + fmt(f.modifiedAt);
        list.appendChild(pickItem("\u25c6", f.name, meta, "qbw", function () { choosePicked(f.path); }));
      });
      r.folders.forEach(function (d) { list.appendChild(pickItem("\u25b8", d.name, "", "", function () { browseTo(d.path); })); });
      if (!r.files.length && !r.folders.length) list.appendChild(el("p", "This folder is empty.", "empty"));
      if (r.truncated) list.appendChild(el("p", "Only the first entries are shown. Type a more specific folder above.", "hint"));
      list.scrollTop = 0;
    }).catch(function (e) {
      if (quiet) throw e;
      toast(e.message, "err");
    });
  }
  function choosePicked(p) {
    $("companyFile").value = p; closePicker(); syncForm();
    ($("username").value ? $("password") : $("username")).focus();
  }
  function closePicker() { $("picker").classList.add("hidden"); $("browseBtn").setAttribute("aria-expanded", "false"); }
  function openPicker() {
    $("picker").classList.remove("hidden"); $("browseBtn").setAttribute("aria-expanded", "true");
    // Start where the typed file lives, else the last folder browsed, else the discovery root, else the drive list.
    var typed = $("companyFile").value.trim(), last = null;
    try { last = localStorage.getItem("qbmcp.browse"); } catch (e) {}
    var starts = [];
    if (/[\\/]/.test(typed)) starts.push(typed.replace(/[\\/][^\\/]*$/, "") || typed);
    if (last) starts.push(last);
    if (state && state.discoveryRoot) starts.push(state.discoveryRoot);
    (function next() {
      if (!starts.length) { showDrives(); return; }
      browseTo(starts.shift(), true).catch(next);
    })();
  }
  $("browseBtn").onclick = function () { if ($("picker").classList.contains("hidden")) openPicker(); else closePicker(); };
  $("pkClose").onclick = closePicker;
  $("pkDrives").onclick = showDrives;
  $("pkUp").onclick = function () { if (pickerAt && pickerAt.parent) browseTo(pickerAt.parent); else showDrives(); };
  $("pkGo").onclick = function () { var v = $("pkPath").value.trim(); if (v) browseTo(v); else showDrives(); };
  $("pkPath").addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); $("pkGo").click(); } });
  $("picker").addEventListener("keydown", function (ev) { if (ev.key === "Escape") { closePicker(); $("browseBtn").focus(); } });
  $("companyFile").addEventListener("input", syncForm);
  $("username").addEventListener("input", function () { this.dataset.touched = "1"; });
  $("togglePw").onclick = function () { var p = $("password"), s = p.type === "text"; p.type = s ? "password" : "text"; this.textContent = s ? "Show" : "Hide"; this.setAttribute("aria-label", s ? "Show password" : "Hide password"); };
  $("resetBtn").onclick = function () { fillForm(""); $("companyFile").focus(); };
  $("loginForm").addEventListener("submit", function (ev) {
    ev.preventDefault(); var b = $("saveBtn"); b.disabled = true;
    var body = { companyFile: $("companyFile").value.trim(), username: $("username").value.trim(), password: $("password").value, clearPassword: $("clearPw").checked };
    api("/api/logins", body).then(function (r) {
      $("password").value = ""; $("password").type = "password"; $("togglePw").textContent = "Show"; $("clearPw").checked = false; delete $("username").dataset.touched;
      var msg = (r.created ? "Saved the login for " : "Updated the login for ") + base(body.companyFile) + "." + (r.created ? "" : r.passwordChanged ? " The new password replaced the old one." : " The saved password was kept.");
      return load().then(function () { var m = $("formMsg"); m.textContent = msg; m.className = "banner ok"; });
    }).catch(function (e) { var m = $("formMsg"); m.textContent = e.message; m.className = "banner err"; }).then(function () { b.disabled = false; });
  });

  var q = new URLSearchParams(location.search).get("file"), startTab = null;
  try { startTab = localStorage.getItem("qbmcp.tab"); } catch (e) {}
  var hashTab = location.hash.replace("#", "");
  if (hashTab && $("tab-" + hashTab)) startTab = hashTab;
  if (startTab && $("tab-" + startTab)) showTab(startTab);
  window.addEventListener("hashchange", function () { var t = location.hash.replace("#", ""); if ($("tab-" + t)) showTab(t); });
  load().then(function () { if (q) fillForm(q); });
})();
</script>
</body>
</html>
`;

export const FORBIDDEN_PAGE_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not allowed</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:40px 16px;background:#f6f7f9;color:#1d2330}
@media (prefers-color-scheme: dark){body{background:#11151b;color:#e6e9ee}}main{max-width:560px;margin:0 auto}</style></head>
<body><main><h1>This device can't manage QuickBooks logins</h1>
<p>Only this computer and the tailnet devices of the account that runs the QuickBooks MCP server can open this page. Ask the operator to add your Tailscale login to <code>QB_WEB_ADMINS</code> if you need access.</p></main></body></html>`;
