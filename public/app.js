// public/app.js
function fuzzyRank(items, q){ if(!q) return items.slice();
  const score=(s)=>{s=s.toLowerCase();const t=q.toLowerCase();let i=0,sc=0;for(const c of s){if(i<t.length&&c===t[i]){i++;sc+=2;}}return i===t.length?sc-s.length*0.01:-1;};
  return items.map(x=>[x,score(x)]).filter(([,v])=>v>=0).sort((a,b)=>b[1]-a[1]).map(([x])=>x); }

const app = document.getElementById('app');
document.getElementById('menu').onclick = () => app.classList.toggle('open');
{ const scrim = document.getElementById('scrim'); if (scrim) scrim.onclick = () => app.classList.remove('open'); }

const Terminal = window.Terminal;
const FitAddon = window.FitAddon.FitAddon;
const sessions = new Map();   // name -> {el, term, sock, fit}
let active = null;
let pendingWs = new URLSearchParams(location.search).get('ws'); // on refresh, auto-open per URL

function notifyDone(name) {
  if (!(window.Notification && Notification.permission === 'granted')) return;
  if (name === active && document.hasFocus()) return;
  new Notification('🔔 ' + name, { body: 'claude activity (done / awaiting input)', tag: 'ws-' + name, renotify: true });
}

function requestNotifPermission() {
  if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
}
requestNotifPermission();
document.addEventListener('click', requestNotifPermission, { once: true });

function updateHdr(name) {
  if (name !== undefined && name !== active) return;
  const nameEl = document.getElementById('hdr-name');
  const dotEl = document.getElementById('hdr-dot');
  if (!active) { nameEl.textContent = 'No workspace selected'; dotEl.className = 'dot dot-off'; return; }
  nameEl.textContent = active;
  const s = sessions.get(active);
  const open = !!s && s.sock.readyState === 1;
  dotEl.className = 'dot ' + (open ? 'dot-on' : 'dot-off');
}

function makeSession(name) {
  const el = document.createElement('div'); el.className = 'termpane'; el.style.height = '100%'; el.style.display = 'none';
  document.getElementById('termwrap').appendChild(el);
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
    theme: { background: '#262624', foreground: '#e8e6de', cursor: '#d97757', cursorAccent: '#262624', selectionBackground: '#d9775740' },
  });
  const fit = new FitAddon(); term.loadAddon(fit); term.open(el);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/api/pty?ws=${encodeURIComponent(name)}&width=80&height=24`);
  const s = { el, term, sock, fit }; sessions.set(name, s);
  // Copy/paste: claude runs the TUI in mouse mode, so drag-select needs Shift held.
  // Then Cmd/Ctrl+C copies the selection (only when there is one, so Ctrl+C still
  // interrupts otherwise); Cmd/Ctrl+V pastes the clipboard into the PTY.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === 'c' || e.key === 'C') && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection()).catch(() => {}); return false;
    }
    if (mod && (e.key === 'v' || e.key === 'V')) {
      navigator.clipboard.readText().then((t) => { if (t && sock.readyState === 1) sock.send(JSON.stringify({ data: t })); }).catch(() => {}); return false;
    }
    return true;
  });
  sock.addEventListener('open', () => { fitSoon(s); updateHdr(name); });
  sock.addEventListener('close', () => updateHdr(name));
  sock.onmessage = (e) => term.write(e.data);
  term.onData((d) => sock.readyState === 1 && sock.send(JSON.stringify({ data: d })));
  term.onBell(() => notifyDone(name));
  el.addEventListener('click', () => s.term.focus());
  return s;
}

// Fit the terminal to its container. Deferred to the next frames so layout has settled
// after display:none -> block (otherwise fit measures a stale/zero size → tiny 1/4 term).
function fitSession(s) {
  if (!s) return;
  try { s.fit.fit(); if (s.sock.readyState === 1) s.sock.send(JSON.stringify({ height: s.term.rows, width: s.term.cols })); } catch (_) {}
}
function fitSoon(s) { requestAnimationFrame(() => requestAnimationFrame(() => fitSession(s))); }
// Re-fit whenever the terminal area resizes (window, sidebar toggle, address-bar changes).
try {
  const ro = new ResizeObserver(() => {
    if (isMobile()) return;
    const s = active && sessions.get(active);
    if (s && s.el.style.display !== 'none') fitSession(s);
  });
  ro.observe(document.getElementById('termwrap'));
} catch (_) {}

function isMobile() { return window.innerWidth <= 768; }

function activate(name) {
  active = name;
  try { history.replaceState(null, '', location.pathname + '?ws=' + encodeURIComponent(name)); } catch (_) {}
  if (isMobile()) {
    // Mobile: embedded chat-bubble view (chat.html), no terminal; input handled by the chat page's own PTF
    const cf = document.getElementById('chatframe');
    if (cf.getAttribute('data-ws') !== name) { cf.setAttribute('data-ws', name); cf.src = '/chat.html?ws=' + encodeURIComponent(name); }
    app.classList.add('showchat');
    app.classList.remove('open');
    renderList(); updateHdr();
    return;
  }
  // Desktop: regular terminal
  app.classList.remove('showchat');
  const cf = document.getElementById('chatframe');
  cf.removeAttribute('data-ws'); cf.src = 'about:blank';   // disconnect the embedded page
  sessions.forEach((s, n) => { if (n !== name) s.el.style.display = 'none'; });
  const s = sessions.get(name) || makeSession(name);
  s.el.style.display = 'block';
  s.term.focus();
  fitSoon(s);   // defer: pane just switched from display:none, layout not settled yet
  renderList(); updateHdr();
}

function fitActiveIfMobile() {
  if (isMobile()) return;                 // mobile uses the chat view, no fit needed
  const s = active && sessions.get(active);
  if (s) s.fit.fit();
}

let lastMobile = isMobile();
window.addEventListener('resize', () => {
  const m = isMobile();
  if (m !== lastMobile) { lastMobile = m; if (active) activate(active); } // across breakpoint: switch terminal/chat
  else fitActiveIfMobile();
});

// ---- mobile "Claude-app" bar: quick-key row + chat input ----
function sendToActive(data) {
  const s = active && sessions.get(active);
  if (s && s.sock.readyState === 1) s.sock.send(JSON.stringify({ data }));
}

(function initMobileBar() {
  const mkeys = document.getElementById('mkeys');
  const mtext = document.getElementById('mtext');
  const msend = document.getElementById('msend');
  if (!mkeys || !mtext || !msend) return;

  const KEYS = [
    ['Esc', '\x1b'],
    ['↑', '\x1b[A'],
    ['↓', '\x1b[B'],
    ['⏎', '\r'],
    ['Tab', '\t'],
    ['Ctrl-C', '\x03'],
  ];
  KEYS.forEach(([label, seq]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      sendToActive(seq);
      mtext.focus();
    });
    mkeys.appendChild(btn);
  });

  function autoGrow() {
    mtext.style.height = 'auto';
    mtext.style.height = Math.min(mtext.scrollHeight, 96) + 'px';
  }
  mtext.addEventListener('input', autoGrow);

  function sendChat() {
    const t = mtext.value;
    if (t) { sendToActive(t + '\r'); mtext.value = ''; autoGrow(); }
    mtext.focus();
  }
  msend.addEventListener('click', (e) => { e.preventDefault(); sendChat(); });
  mtext.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
})();

let workspaces = [];
let stoppedOpen = false; // "Stopped" group collapsed by default
function makeLi(w) {
  const li = document.createElement('li');
  const dot = document.createElement('span');
  dot.className = 'dot ' + (w.status === 'running' ? 'dot-on' : 'dot-off');
  li.appendChild(dot);
  li.appendChild(document.createTextNode(w.name));
  const cls = [];
  if (w.status !== 'running') cls.push('stopped');
  if (w.name === active) cls.push('active');
  li.className = cls.join(' ');
  li.onclick = () => {
    if (w.status === 'running') return activate(w.name);
    if (confirm(`Start workspace "${w.name}"?`)) startAndAttach(w.name);
  };
  return li;
}
function renderList(filter = '') {
  const ul = document.getElementById('list'); ul.innerHTML = '';
  const byName = new Map(workspaces.map((w) => [w.name, w]));
  const ranked = fuzzyRank(workspaces.map((w) => w.name), filter);

  if (filter) { // when searching, show all matches flat (incl. stopped), no grouping
    ranked.forEach((name) => ul.appendChild(makeLi(byName.get(name))));
    return;
  }
  const running = ranked.filter((n) => byName.get(n).status === 'running');
  const stopped = ranked.filter((n) => byName.get(n).status !== 'running');
  running.forEach((name) => ul.appendChild(makeLi(byName.get(name))));
  if (stopped.length) {
    const hdr = document.createElement('li');
    hdr.className = 'group-hdr' + (stoppedOpen ? ' open' : '');
    hdr.innerHTML = '<span>Stopped</span><span class=count>' + stopped.length + '</span><span class=chev>▸</span>';
    hdr.onclick = () => { stoppedOpen = !stoppedOpen; renderList(document.getElementById('search').value); };
    ul.appendChild(hdr);
    if (stoppedOpen) stopped.forEach((name) => ul.appendChild(makeLi(byName.get(name))));
  }
}

async function getWorkspaces() {
  try {
    const r = await fetch('/api/workspaces');
    const body = await r.json();
    if (r.status === 401 && body.error === 'not_logged_in') return { notLoggedIn: true };
    return body.workspaces || [];
  } catch (e) { console.error(e); return null; }
}

const activePolls = new Set();
const MAX_POLL_ATTEMPTS = 40; // ~2 min at 3s interval

async function startAndAttach(name) { await fetch('/api/start?ws=' + encodeURIComponent(name), { method: 'POST' }); pollThenAttach(name); }
function pollThenAttach(name) {
  if (activePolls.has(name)) return;
  activePolls.add(name);
  let attempts = 0;
  const t = setInterval(async () => {
    attempts++;
    const ws = await getWorkspaces();
    if (ws === null || ws.notLoggedIn) return;
    workspaces = ws;
    const w = workspaces.find((x) => x.name === name);
    if (w && w.status === 'running' && w.agentId) {
      clearInterval(t); activePolls.delete(name); activate(name);
    } else if (attempts >= MAX_POLL_ATTEMPTS) {
      clearInterval(t); activePolls.delete(name);
    }
    renderList();
  }, 3000);
}

function renderNotLoggedIn() {
  const ul = document.getElementById('list'); ul.innerHTML = '';
  const li = document.createElement('li');
  li.className = 'not-logged-in';
  li.textContent = 'Not logged in to Coder — run `coder login` in a workspace terminal; this refreshes automatically once you are logged in';
  ul.appendChild(li);
}

async function refresh() {
  const ws = await getWorkspaces();
  if (ws === null) return;
  if (ws.notLoggedIn) return renderNotLoggedIn();
  workspaces = ws; renderList(document.getElementById('search').value);
  if (pendingWs !== null) { // one-time: on load, auto-open per URL (running only)
    const w = workspaces.find((x) => x.name === pendingWs);
    const target = pendingWs; pendingWs = null;
    if (w && w.status === 'running') activate(target);
  }
}
document.getElementById('search').addEventListener('input', (e) => renderList(e.target.value));
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); document.getElementById('search').focus(); }
});
document.getElementById('search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const first = document.querySelector('#list li'); if (first) first.click(); }
});
refresh(); setInterval(refresh, 10000);
