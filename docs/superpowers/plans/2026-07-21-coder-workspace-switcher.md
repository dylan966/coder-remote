# Coder Workspace Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A web page running in an always-on Coder workspace that lets me view/switch between all my workspaces on a single page, with the main area attaching to each workspace's `claude` tmux session, and mobile support.

**Architecture:** The frontend (a single-page xterm.js app) only talks to the backend over the same origin; the backend (Node) holds a single Coder API token and proxies the Coder REST API (list/start) plus the reconnecting-PTY websocket on the server side, bypassing Coder's CORS/frame-ancestors restrictions.

**Tech Stack:** Node ≥20 (built-ins only + `ws`), frontend xterm.js (`@xterm/xterm` + `@xterm/addon-fit`), tests via `node --test` (no extra dependencies).

## Global Constraints

- Node ≥ 20 (both local machine and target workspace run v20.20.2).
- Backend has a single runtime dependency, `ws`; tests use only the built-in `node:test`.
- Coder PTY protocol (verified by spike, do not change): endpoint `wss://{coderHost}/api/v2/workspaceagents/{agentID}/pty?reconnect={uuid}&width={w}&height={h}`; auth via HTTP header `Coder-Session-Token: {token}`; client→server = JSON `{data?,height?,width?}` sent as **binary frames**; server→client = raw PTY text.
- Command to enter the session: `tmux new-session -A -s claude` (reuses the workspace's existing claude session).
- Token is read only from the `CODER_TOKEN` env var, never hardcoded or committed to git; `CODER_URL` likewise comes from the environment.
- Single-user; no multi-user/auth layer (relies on coder_app share=owner).

---

## File Structure

- `src/config.js` — reads and validates environment (CODER_URL / CODER_TOKEN / PORT / CLAUDE_CMD).
- `src/protocol.js` — pure functions: PTY URL construction, binary JSON encoding. Unit-testable offline.
- `src/coder-client.js` — Coder REST (listWorkspaces/startWorkspace/getAgentId) + openPty (websocket connection).
- `src/server.js` — http static file server + `/api/workspaces` + `/api/start` + `WS /api/pty` bridge.
- `src/fuzzy.js` — pure function: command palette fuzzy matching. Unit-testable offline.
- `public/index.html` / `public/app.js` / `public/style.css` — frontend.
- `public/vendor/` — xterm dist files (copied in via npm).
- `test/*.test.js` — unit tests (protocol, fuzzy, config); `test/smoke.js` — end-to-end smoke test (gated on env).
- `.env.example`, `README.md`, deployment snippet.

---

### Task 1: Config module + project scripts

**Files:**
- Create: `src/config.js`
- Create: `.env.example`
- Test: `test/config.test.js`
- Modify: `package.json` (scripts + type)

**Interfaces:**
- Produces: `loadConfig(env) -> {coderUrl, coderHost, token, port, claudeCmd}`; throws `Error` if `CODER_URL`/`CODER_TOKEN` is missing.

- [ ] **Step 1: Write failing test**

```js
// test/config.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { loadConfig } = require('../src/config');

test('loadConfig parses required fields + defaults', () => {
  const c = loadConfig({ CODER_URL: 'https://coder.x.com', CODER_TOKEN: 'tok' });
  assert.equal(c.coderUrl, 'https://coder.x.com');
  assert.equal(c.coderHost, 'coder.x.com');
  assert.equal(c.token, 'tok');
  assert.equal(c.port, 8080);
  assert.match(c.claudeCmd, /tmux new-session -A -s claude/);
});

test('loadConfig throws when token is missing', () => {
  assert.throws(() => loadConfig({ CODER_URL: 'https://coder.x.com' }), /CODER_TOKEN/);
});
```

- [ ] **Step 2: Run test, confirm failure**

Run: `node --test test/config.test.js`
Expected: FAIL (Cannot find module '../src/config')

- [ ] **Step 3: Implement**

```js
// src/config.js
function loadConfig(env = process.env) {
  const coderUrl = env.CODER_URL;
  const token = env.CODER_TOKEN;
  if (!coderUrl) throw new Error('missing CODER_URL');
  if (!token) throw new Error('missing CODER_TOKEN');
  return {
    coderUrl: coderUrl.replace(/\/$/, ''),
    coderHost: new URL(coderUrl).host,
    token,
    port: parseInt(env.PORT, 10) || 8080,
    claudeCmd: env.CLAUDE_CMD || 'tmux new-session -A -s claude',
  };
}
module.exports = { loadConfig };
```

- [ ] **Step 4: Run test, confirm pass**

Run: `node --test test/config.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Write .env.example + package.json scripts**

```
# .env.example
CODER_URL=https://coder.gmaster888.com
CODER_TOKEN=          # coder tokens create --lifetime 720h
PORT=8080
```

Add to package.json: `"scripts": { "start": "node src/server.js", "test": "node --test", "smoke": "node test/smoke.js" }` (keep the existing `dependencies.ws`).

- [ ] **Step 6: Commit**

```bash
git add src/config.js test/config.test.js .env.example package.json
git commit -m "feat(config): environment config module + project scripts"
```

---

### Task 2: PTY protocol pure functions (locking in spike conclusions)

**Files:**
- Create: `src/protocol.js`
- Test: `test/protocol.test.js`

**Interfaces:**
- Produces:
  - `buildPtyUrl({coderHost, agentId, reconnect, width, height}) -> string` (wss URL)
  - `encodeMsg({data?, height?, width?}) -> Buffer` (binary JSON, fed to ws.send)

- [ ] **Step 1: Write failing test**

```js
// test/protocol.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildPtyUrl, encodeMsg } = require('../src/protocol');

test('buildPtyUrl assembles the correct wss endpoint', () => {
  const u = buildPtyUrl({ coderHost: 'coder.x.com', agentId: 'AID', reconnect: 'RID', width: 100, height: 30 });
  assert.equal(u, 'wss://coder.x.com/api/v2/workspaceagents/AID/pty?reconnect=RID&width=100&height=30');
});

test('encodeMsg returns binary JSON', () => {
  const b = encodeMsg({ data: 'Y' });
  assert.ok(Buffer.isBuffer(b));
  assert.equal(b.toString('utf8'), '{"data":"Y"}');
});
```

- [ ] **Step 2: Run test, confirm failure**

Run: `node --test test/protocol.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement**

```js
// src/protocol.js
function buildPtyUrl({ coderHost, agentId, reconnect, width, height }) {
  return `wss://${coderHost}/api/v2/workspaceagents/${agentId}/pty` +
    `?reconnect=${reconnect}&width=${width}&height=${height}`;
}
function encodeMsg(obj) {
  return Buffer.from(JSON.stringify(obj));
}
module.exports = { buildPtyUrl, encodeMsg };
```

- [ ] **Step 4: Run test, confirm pass**

Run: `node --test test/protocol.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/protocol.js test/protocol.test.js
git commit -m "feat(protocol): PTY URL + binary JSON encoding (spike-verified)"
```

---

### Task 3: coder-client (REST + openPty)

**Files:**
- Create: `src/coder-client.js`
- Test (integration, gated): `test/coder-client.smoke.js`

**Interfaces:**
- Consumes: `config` (Task1), `buildPtyUrl`/`encodeMsg` (Task2), `ws`.
- Produces:
  - `listWorkspaces() -> Promise<[{name, status, agentId|null}]>`
  - `startWorkspace(name) -> Promise<void>`
  - `openPty({agentId, width, height, command}) -> { sock, send(obj), onData(cb), onClose(cb), close() }` (sock is the underlying ws)

- [ ] **Step 1: Implement REST + openPty** (this task depends on a real Coder network; implement first, then verify with a smoke test)

```js
// src/coder-client.js
const crypto = require('crypto');
const WebSocket = require('ws');
const { buildPtyUrl, encodeMsg } = require('./protocol');

function makeClient(config) {
  const H = { 'Coder-Session-Token': config.token };

  async function api(path, opts = {}) {
    const res = await fetch(`${config.coderUrl}${path}`, {
      ...opts, headers: { ...H, 'content-type': 'application/json', ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error(`coder ${path} -> ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  // All my workspaces + each one's agentId (take the first agent).
  async function listWorkspaces() {
    const d = await api('/api/v2/workspaces?q=owner:me');
    return (d.workspaces || []).map((w) => {
      let agentId = null;
      for (const r of (w.latest_build?.resources || []))
        for (const a of (r.agents || [])) { agentId = agentId || a.id; }
      return { name: w.name, status: w.latest_build?.status || 'unknown', agentId };
    });
  }

  async function startWorkspace(name) {
    const d = await api('/api/v2/workspaces?q=owner:me');
    const w = (d.workspaces || []).find((x) => x.name === name);
    if (!w) throw new Error(`no workspace ${name}`);
    await api(`/api/v2/workspaces/${w.id}/builds`, {
      method: 'POST', body: JSON.stringify({ transition: 'start' }),
    });
  }

  function openPty({ agentId, width = 100, height = 30, command }) {
    const reconnect = crypto.randomUUID();
    const url = buildPtyUrl({ coderHost: config.coderHost, agentId, reconnect, width, height });
    const sock = new WebSocket(url, { headers: H });
    const send = (obj) => { if (sock.readyState === WebSocket.OPEN) sock.send(encodeMsg(obj)); };
    sock.on('open', () => {
      send({ height, width });
      if (command) send({ data: command + '\r' });
    });
    return {
      sock,
      send,
      onData: (cb) => sock.on('message', (m) => cb(m.toString('utf8'))),
      onClose: (cb) => sock.on('close', cb),
      close: () => sock.close(),
    };
  }

  return { listWorkspaces, startWorkspace, openPty };
}
module.exports = { makeClient };
```

- [ ] **Step 2: Write smoke test script (gated on env)**

```js
// test/coder-client.smoke.js
const { loadConfig } = require('../src/config');
const { makeClient } = require('../src/coder-client');
(async () => {
  const c = makeClient(loadConfig());
  const list = await c.listWorkspaces();
  console.log('workspaces:', list.map((w) => `${w.name}(${w.status})`).join(', '));
  const running = list.find((w) => w.status === 'running' && w.agentId);
  if (!running) { console.log('No running workspace, skipping PTY smoke test'); process.exit(0); }
  const pty = c.openPty({ agentId: running.agentId, command: 'echo SMOKE_OK_4823' });
  let got = '';
  pty.onData((s) => { got += s; if (got.includes('SMOKE_OK_4823')) { console.log('✅ PTY smoke test passed (', running.name, ')'); pty.close(); process.exit(0); } });
  setTimeout(() => { console.error('❌ No echo seen within 6s'); process.exit(1); }, 6000);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Run smoke test (needs a real token)**

Run: `CODER_URL=https://coder.gmaster888.com CODER_TOKEN=$TOK node test/coder-client.smoke.js`
Expected: prints the workspace list + `✅ PTY smoke test passed`

- [ ] **Step 4: Commit**

```bash
git add src/coder-client.js test/coder-client.smoke.js
git commit -m "feat(coder-client): REST list/start + PTY connection"
```

---

### Task 4: Backend — static file server + REST routes

**Files:**
- Create: `src/server.js`
- Create: `public/index.html` (placeholder, completed in Task6)

**Interfaces:**
- Consumes: `loadConfig`, `makeClient`.
- Produces: HTTP `GET /api/workspaces -> {workspaces:[...]}`; `POST /api/start?ws=NAME -> {ok:true}`; static file serving from `public/`. WS route added in Task5.

- [ ] **Step 1: Implement http server (REST + static)**

```js
// src/server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { makeClient } = require('./coder-client');

const config = loadConfig();
const client = makeClient(config);
const PUB = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(PUB, path.normalize(p));
  if (!file.startsWith(PUB)) { res.statusCode = 403; return res.end('forbidden'); }
  fs.readFile(file, (e, buf) => {
    if (e) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o, code = 200) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  try {
    if (u.pathname === '/api/workspaces') return json({ workspaces: await client.listWorkspaces() });
    if (u.pathname === '/api/start' && req.method === 'POST') { await client.startWorkspace(u.searchParams.get('ws')); return json({ ok: true }); }
    return serveStatic(req, res);
  } catch (e) { json({ error: String(e.message || e) }, 500); }
});

server.listen(config.port, () => console.log(`switcher on :${config.port}`));
module.exports = { server };
```

- [ ] **Step 2: Placeholder index.html**

```html
<!doctype html><meta charset=utf-8><title>Workspaces</title><body>switcher up</body>
```

- [ ] **Step 3: Manual verification**

Run: `CODER_URL=... CODER_TOKEN=$TOK node src/server.js`, then in another terminal: `curl -s localhost:8080/api/workspaces | head -c 200`
Expected: returns `{"workspaces":[...]}`; `curl localhost:8080/` returns the placeholder HTML.

- [ ] **Step 4: Commit**

```bash
git add src/server.js public/index.html
git commit -m "feat(server): static file server + /api/workspaces + /api/start"
```

---

### Task 5: Backend — WS /api/pty bridge

**Files:**
- Modify: `src/server.js` (add ws server)
- Modify: `package.json` (ws already a dependency)

**Interfaces:**
- Consumes: `client.openPty`, `ws`.
- Produces: `WS /api/pty?ws=NAME&width=&height=`: frontend connects to it; backend looks up the agentId by name, opens a Coder PTY (command=claudeCmd); the frontend's binary JSON messages pass through to Coder, and Coder's output is forwarded to the frontend.

- [ ] **Step 1: Add WebSocketServer bridge**

Insert before `server.listen` in `src/server.js`:

```js
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ server, path: '/api/pty' });
wss.on('connection', async (fe, req) => {
  const u = new URL(req.url, 'http://x');
  const name = u.searchParams.get('ws');
  const width = parseInt(u.searchParams.get('width'), 10) || 100;
  const height = parseInt(u.searchParams.get('height'), 10) || 30;
  try {
    const list = await client.listWorkspaces();
    const w = list.find((x) => x.name === name);
    if (!w || !w.agentId) { fe.close(1011, 'no agent'); return; }
    const pty = client.openPty({ agentId: w.agentId, width, height, command: config.claudeCmd });
    pty.onData((s) => { if (fe.readyState === fe.OPEN) fe.send(s); });     // Coder → frontend (text)
    pty.onClose(() => fe.close());
    fe.on('message', (m) => { try { pty.send(JSON.parse(m.toString('utf8'))); } catch (_) {} }); // frontend → Coder (JSON)
    fe.on('close', () => pty.close());
  } catch (e) { fe.close(1011, String(e.message || e)); }
});
```

Frontend convention: what the frontend sends to `/api/pty` is **JSON text** `{data|height|width}`; the backend parses it and uses `pty.send` (which internally re-encodes it into the binary format Coder expects). Coder→frontend is text, passed straight through.

- [ ] **Step 2: End-to-end smoke test**

> Note: put the smoke script under `smoke/` (**not** `test/`), otherwise `node --test` will pick it up as a unit test and turn `npm test` red when there's no token.

```js
// smoke/end2end.smoke.js
const WebSocket = require('ws');
(async () => {
  const list = await (await fetch('http://localhost:8080/api/workspaces')).json();
  const w = (list.workspaces || []).find((x) => x.status === 'running' && x.agentId);
  if (!w) { console.log('No running workspace, skipping'); process.exit(0); }
  const fe = new WebSocket(`ws://localhost:8080/api/pty?ws=${encodeURIComponent(w.name)}`);
  let got = '';
  fe.on('open', () => setTimeout(() => fe.send(JSON.stringify({ data: 'echo SMOKE_END2END_771\r' })), 1500));
  fe.on('message', (m) => { got += m.toString(); if (got.includes('SMOKE_END2END_771')) { console.log('✅ End-to-end PTY bridge passed (', w.name, ')'); process.exit(0); } });
  setTimeout(() => { console.error('❌ No echo seen'); process.exit(1); }, 8000);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Run smoke test**

Run: (start the server first) `node smoke/end2end.smoke.js`
Expected: `✅ End-to-end PTY bridge passed`

- [ ] **Step 4: Commit**

```bash
git add src/server.js smoke/end2end.smoke.js
git commit -m "feat(server): /api/pty frontend<->Coder PTY bridge + end-to-end smoke test"
```

---

### Task 6: Frontend — terminal + connect to a single workspace

**Files:**
- Modify: `public/index.html`
- Create: `public/app.js`, `public/style.css`
- Create: `public/vendor/` (copy xterm dist)
- Modify: `package.json` (devDep install xterm to grab dist)

**Interfaces:**
- Consumes: `WS /api/pty`, `/api/workspaces`.
- Produces: opening the page → xterm terminal connects to a running workspace, shows the claude session, accepts input. Resize uses addon-fit, sends `{height,width}`.

- [ ] **Step 1: Fetch xterm dist**

```bash
npm install --save-dev @xterm/xterm @xterm/addon-fit
mkdir -p public/vendor
cp node_modules/@xterm/xterm/lib/xterm.js public/vendor/
cp node_modules/@xterm/xterm/css/xterm.css public/vendor/
cp node_modules/@xterm/addon-fit/lib/addon-fit.js public/vendor/
```

- [ ] **Step 2: index.html**

```html
<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Workspaces</title>
<link rel=stylesheet href="/vendor/xterm.css"><link rel=stylesheet href="/style.css">
</head><body>
<div id=app><aside id=side><input id=search placeholder="Search workspaces (Ctrl/Cmd+K)"><ul id=list></ul></aside>
<main id=main><div id=term></div></main></div>
<script src="/vendor/xterm.js"></script><script src="/vendor/addon-fit.js"></script>
<script src="/app.js"></script></body></html>
```

- [ ] **Step 3: app.js — terminal connection (single workspace)**

```js
// public/app.js
const { Terminal } = window;                       // xterm is attached globally
const FitAddon = window.FitAddon.FitAddon;

function connect(wsName) {
  const term = new Terminal({ cursorBlink: true, fontSize: 14 });
  const fit = new FitAddon(); term.loadAddon(fit);
  term.open(document.getElementById('term')); fit.fit();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/api/pty?ws=${encodeURIComponent(wsName)}&width=${term.cols}&height=${term.rows}`);
  sock.onmessage = (e) => term.write(e.data);
  term.onData((d) => sock.readyState === 1 && sock.send(JSON.stringify({ data: d })));
  const doFit = () => { fit.fit(); sock.readyState === 1 && sock.send(JSON.stringify({ height: term.rows, width: term.cols })); };
  window.addEventListener('resize', doFit);
  return { term, sock, dispose: () => { sock.close(); term.dispose(); window.removeEventListener('resize', doFit); } };
}

// Temporary: connect to the first running workspace (Task7 replaces this with list clicks)
fetch('/api/workspaces').then((r) => r.json()).then((d) => {
  const w = (d.workspaces || []).find((x) => x.status === 'running');
  if (w) connect(w.name);
});
window.__connect = connect;
```

- [ ] **Step 4: Minimal style.css**

```css
* { box-sizing: border-box; } html,body,#app { height:100%; margin:0; }
#app { display:flex; } #side { width:240px; border-right:1px solid #333; padding:8px; overflow:auto; background:#0b1021; color:#cbd5e1; }
#main { flex:1; min-width:0; } #term { height:100%; }
#search { width:100%; padding:6px; margin-bottom:8px; }
#list { list-style:none; padding:0; margin:0; } #list li { padding:6px 8px; border-radius:6px; cursor:pointer; }
#list li:hover, #list li.active { background:#1e293b; }
```

- [ ] **Step 5: Manual verification**

Start the server, open `localhost:8080` in a browser → see a workspace's claude session, able to type.

- [ ] **Step 6: Commit**

```bash
git add public package.json package-lock.json
git commit -m "feat(frontend): xterm terminal connects to a single workspace's claude session"
```

---

### Task 7: Frontend — workspace list + switching (session keep-alive)

**Files:**
- Modify: `public/app.js`

**Interfaces:**
- Consumes: Task6's `connect`.
- Produces: sidebar renders all workspaces + status dots; click to switch; each connected workspace's terminal DOM is kept (hidden, not destroyed), so switching back doesn't drop the connection.

- [ ] **Step 1: Refactor app.js into list + multi-terminal keep-alive**

```js
// public/app.js
const Terminal = window.Terminal;
const FitAddon = window.FitAddon.FitAddon;
const sessions = new Map();   // name -> {el, term, sock, fit}
let active = null;

function makeSession(name) {
  const el = document.createElement('div'); el.className = 'termpane'; el.style.height = '100%'; el.style.display = 'none';
  document.getElementById('main').appendChild(el);
  const term = new Terminal({ cursorBlink: true, fontSize: 14 });
  const fit = new FitAddon(); term.loadAddon(fit); term.open(el);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/api/pty?ws=${encodeURIComponent(name)}&width=80&height=24`);
  sock.onmessage = (e) => term.write(e.data);
  term.onData((d) => sock.readyState === 1 && sock.send(JSON.stringify({ data: d })));
  const s = { el, term, sock, fit }; sessions.set(name, s); return s;
}

function activate(name) {
  if (active) sessions.get(active).el.style.display = 'none';
  const s = sessions.get(name) || makeSession(name);
  s.el.style.display = 'block'; active = name;
  s.fit.fit(); s.term.focus();
  if (s.sock.readyState === 1) s.sock.send(JSON.stringify({ height: s.term.rows, width: s.term.cols }));
  renderList();
}

let workspaces = [];
function renderList(filter = '') {
  const ul = document.getElementById('list'); ul.innerHTML = '';
  workspaces.filter((w) => w.name.toLowerCase().includes(filter.toLowerCase())).forEach((w) => {
    const li = document.createElement('li'); li.textContent = (w.status === 'running' ? '● ' : '○ ') + w.name;
    if (w.name === active) li.className = 'active';
    li.onclick = () => w.status === 'running' ? activate(w.name) : startAndAttach(w.name);
    ul.appendChild(li);
  });
}

async function startAndAttach(name) { await fetch('/api/start?ws=' + encodeURIComponent(name), { method: 'POST' }); pollThenAttach(name); }
function pollThenAttach(name) {
  const t = setInterval(async () => {
    const d = await (await fetch('/api/workspaces')).json(); workspaces = d.workspaces || [];
    const w = workspaces.find((x) => x.name === name);
    if (w && w.status === 'running' && w.agentId) { clearInterval(t); activate(name); } renderList();
  }, 3000);
}

async function refresh() { const d = await (await fetch('/api/workspaces')).json(); workspaces = d.workspaces || []; renderList(document.getElementById('search').value); }
document.getElementById('search').addEventListener('input', (e) => renderList(e.target.value));
refresh(); setInterval(refresh, 10000);
```

- [ ] **Step 2: Manual verification**

Start server → sidebar lists all workspaces, click between two different ones repeatedly, neither session is lost.

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat(frontend): workspace list + switching + session keep-alive"
```

---

### Task 8: Command palette (Ctrl/Cmd+K) + fuzzy search

**Files:**
- Create: `src/fuzzy.js`
- Test: `test/fuzzy.test.js`
- Modify: `public/app.js` (bring in fuzzy; shortcut focuses search, Enter jumps to first result)

**Interfaces:**
- Produces: `fuzzyRank(items, query) -> items` (sorted by match quality, non-matches removed); frontend `Ctrl/Cmd+K` focuses search, `Enter` activates the top-ranked result.

- [ ] **Step 1: Write failing test**

```js
// test/fuzzy.test.js
const { test } = require('node:test'); const assert = require('node:assert');
const { fuzzyRank } = require('../src/fuzzy');
test('subsequence match + removes non-matches', () => {
  const r = fuzzyRank(['alpha', 'beta', 'backend'], 'ba');
  assert.deepEqual(r, ['beta', 'backend']);  // both contain the b..a subsequence; alpha is removed since it only has a..a, not ba
});
test('empty query returns items unchanged', () => { assert.deepEqual(fuzzyRank(['x', 'y'], ''), ['x', 'y']); });
```

- [ ] **Step 2: Run test, confirm failure**

Run: `node --test test/fuzzy.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement**

```js
// src/fuzzy.js
function score(s, q) {
  s = s.toLowerCase(); q = q.toLowerCase(); let i = 0, sc = 0;
  for (const ch of s) { if (i < q.length && ch === q[i]) { i++; sc += 2; } }
  return i === q.length ? sc - s.length * 0.01 : -1;   // must match every query character (subsequence)
}
function fuzzyRank(items, q) {
  if (!q) return items.slice();
  return items.map((x) => [x, score(x, q)]).filter(([, v]) => v >= 0)
    .sort((a, b) => b[1] - a[1]).map(([x]) => x);
}
module.exports = { fuzzyRank, score };
```

- [ ] **Step 4: Run test, confirm pass**

Run: `node --test test/fuzzy.test.js`
Expected: PASS

- [ ] **Step 5: Wire up frontend** (add browser version of fuzzy + shortcut at top of app.js)

Add to the top of `public/app.js` (copy of the fuzzy logic, since the browser has no require):

```js
function fuzzyRank(items, q){ if(!q) return items.slice();
  const score=(s)=>{s=s.toLowerCase();const t=q.toLowerCase();let i=0,sc=0;for(const c of s){if(i<t.length&&c===t[i]){i++;sc+=2;}}return i===t.length?sc-s.length*0.01:-1;};
  return items.map(x=>[x,score(x)]).filter(([,v])=>v>=0).sort((a,b)=>b[1]-a[1]).map(([x])=>x); }
```

Change `renderList` to sort using `fuzzyRank(workspaces.map(w=>w.name), filter)`; add:

```js
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); document.getElementById('search').focus(); }
});
document.getElementById('search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const first = document.querySelector('#list li'); if (first) first.click(); }
});
```

- [ ] **Step 6: Commit**

```bash
git add src/fuzzy.js test/fuzzy.test.js public/app.js
git commit -m "feat(palette): fuzzy search + Ctrl/Cmd+K command palette"
```

---

### Task 9: Mobile responsiveness

**Files:**
- Modify: `public/style.css`, `public/index.html` (add hamburger button), `public/app.js` (drawer open/close + keyboard summon)

**Interfaces:**
- Produces: narrow screens (≤768px) turn the sidebar into a drawer (collapsed by default, hamburger opens it); selecting a workspace auto-collapses the drawer; tapping the terminal summons the soft keyboard.

- [ ] **Step 1: Add hamburger to index.html**

Add before `<main>`: `<button id=menu aria-label=menu>☰</button>`

- [ ] **Step 2: Add media query to style.css**

```css
#menu { display:none; position:fixed; top:8px; left:8px; z-index:10; padding:6px 10px; }
@media (max-width:768px){
  #menu { display:block; }
  #side { position:fixed; z-index:9; height:100%; transform:translateX(-100%); transition:transform .2s; }
  #app.open #side { transform:none; }
  #main { width:100%; } #term { padding-top:40px; }
}
```

- [ ] **Step 3: app.js drawer open/close + collapse on select + keyboard summon**

```js
const app = document.getElementById('app');
document.getElementById('menu').onclick = () => app.classList.toggle('open');
// At the end of activate(): if (window.innerWidth <= 768) app.classList.remove('open');
// Focus the terminal on tap (to summon the soft keyboard): in makeSession, el.addEventListener('click', () => s.term.focus());
```

(Merge these three spots into the existing functions per the comments.)

- [ ] **Step 4: Manual verification**

In browser devtools, switch to a mobile viewport: drawer opens/closes, collapses on selection, terminal accepts input.

- [ ] **Step 5: Commit**

```bash
git add public
git commit -m "feat(mobile): drawer sidebar + mobile layout + keyboard summon"
```

---

### Task 10: Deployment snippet + README

**Files:**
- Create: `README.md`
- Create: `deploy/coder_app.tf.snippet`

**Interfaces:**
- Produces: deployment instructions (pick an always-on workspace, inject the token secret, add coder_app).

- [ ] **Step 1: README**

```md
# Coder Workspace Switcher
Single page to view/switch all workspaces, entering each one's claude session. Mobile supported.
## Run
CODER_URL=... CODER_TOKEN=... npm start   # :8080
## Test
npm test           # unit tests (protocol/fuzzy/config)
npm run smoke      # end-to-end (needs server running + a real token)
## Deploy (always-on workspace + coder_app)
See deploy/coder_app.tf.snippet; create the token with `coder secret create switcher-token --env CODER_TOKEN`.
```

- [ ] **Step 2: coder_app snippet**

```hcl
# deploy/coder_app.tf.snippet — add to the template hosting the workspace
resource "coder_app" "switcher" {
  agent_id     = coder_agent.main.id
  slug         = "switcher"
  display_name = "Workspace Switcher"
  url          = "http://localhost:8080"
  subdomain    = true
  share        = "owner"
  order        = -20
  healthcheck { url = "http://localhost:8080/api/workspaces"; interval = 10; threshold = 30 }
}
# startup: inject CODER_TOKEN (coder secret) + CODER_URL, run `npm start` in the background.
```

- [ ] **Step 3: Commit**

```bash
git add README.md deploy/coder_app.tf.snippet
git commit -m "docs: README + coder_app deployment snippet"
```

---

## Self-Review

- **Spec coverage**: architecture (T4/T5), PTY mechanism (T2/T3/T5), list/lifecycle (T3/T7), UI + command palette (T6/T7/T8), mobile (T9), auth (config token + coder_app share=owner, T1/T10), testing (T1/T2/T8 unit + T3/T5 smoke), deployment (T10). All covered by tasks.
- **Placeholders**: no TBD/TODO; every code step has complete code.
- **Type consistency**: `openPty` returns `{sock,send,onData,onClose,close}` (T3), used consistently in T5; frontend→backend = JSON text `{data|height|width}`, backend→Coder = binary (T5 bridge makes the conversion explicit); `fuzzyRank(items,q)` consistent between frontend and backend in T8.
- **Known trade-off**: the frontend fuzzy logic is duplicated from `src/fuzzy.js` (browser has no require); acceptable for now, can be extracted into a shared module later if a build step is introduced.
