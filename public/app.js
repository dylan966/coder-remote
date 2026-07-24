// public/app.js
function fuzzyRank(items, q){ if(!q) return items.slice();
  const score=(s)=>{s=s.toLowerCase();const t=q.toLowerCase();let i=0,sc=0;for(const c of s){if(i<t.length&&c===t[i]){i++;sc+=2;}}return i===t.length?sc-s.length*0.01:-1;};
  return items.map(x=>[x,score(x)]).filter(([,v])=>v>=0).sort((a,b)=>b[1]-a[1]).map(([x])=>x); }

const app = document.getElementById('app');
document.getElementById('menu').onclick = () => app.classList.toggle('open');
{ const scrim = document.getElementById('scrim'); if (scrim) scrim.onclick = () => app.classList.remove('open'); }

const Terminal = window.Terminal;
const FitAddon = window.FitAddon.FitAddon;
// Desktop session model: a "session" is a claude conversation (one ~/.claude/projects/*/<id>.jsonl).
// The terminal is keyed per session (ws + session id), so several sessions of a workspace can stay
// open at once. main = the shared param-less "claude" tmux (same tmux the mobile chat view attaches).
const sessions = new Map();      // sessKey(ws,sid) -> {el, inner, term, sock, fit, opened, ws, sid, cwd, isMain, fork, label}
let active = null;               // active sessKey
let activeWs = null;             // workspace name of the active session
let activeSess = null;           // active session descriptor from the tree (null = plain "main")
const sessCache = new Map();     // ws -> [ {id,title,project,cwd,main,...} ] (enumerated on demand)
const expanded = new Set();      // ws names currently expanded in the sidebar tree (desktop)
// A freshly created/forked session has no transcript until its first turn, so the backend can't
// enumerate it yet. We keep a provisional entry here (per ws) so it stays visible in the tree, and
// adopt it (swap in the real id, reusing its live pane) once it shows up in the enumeration.
const pending = new Map();        // ws -> { key, cwd, project, title, desc, fork?, seen? }
let pendingWs = new URLSearchParams(location.search).get('ws'); // on refresh, auto-open per URL
function sessKey(ws, sid) { return ws + '\n' + (sid || ''); }
function searchVal() { const s = document.getElementById('search'); return s ? s.value : ''; }
function projName(cwd) { if (!cwd) return '(unknown)'; if (cwd === '/home/coder') return '~'; return cwd.replace(/\/+$/, '').split('/').pop() || cwd; }

function notifyDone(s) {
  if (!(window.Notification && Notification.permission === 'granted')) return;
  const key = sessKey(s.ws, s.sid);
  if (key === active && document.hasFocus()) return;
  const label = s.label && s.label !== 'main' ? s.ws + ' · ' + s.label : s.ws;
  new Notification('🔔 ' + label, { body: 'claude activity (done / awaiting input)', tag: 'ws-' + key, renotify: true });
}

function requestNotifPermission() {
  if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
}
requestNotifPermission();
document.addEventListener('click', requestNotifPermission, { once: true });

function renderHdrApps() {
  const el = document.getElementById('hdr-apps'); if (!el) return;
  el.innerHTML = '';
  if (!activeWs) return;
  const w = workspaces.find((x) => x.name === activeWs);
  (w && w.apps || []).forEach((a) => {
    const link = document.createElement('a');
    link.className = 'applink'; link.href = a.url; link.target = '_blank'; link.rel = 'noopener';
    link.textContent = a.name; link.title = a.url;
    el.appendChild(link);
  });
}

// ---- top-right session switcher: switches only among the CURRENT project's sessions ----
function curSessLabel() {
  if (!activeWs) return '';
  if (activeSess && activeSess.fresh) return activeSess.title || 'new…';
  if (activeSess && !activeSess.main) return activeSess.title || 'session';
  return 'main';
}
function activeProject() {
  const list = sessCache.get(activeWs) || [];
  if (activeSess && activeSess.project) return activeSess.project;
  if (activeSess && activeSess.cwd) { const s = list.find((x) => x.cwd === activeSess.cwd); if (s) return s.project || '~'; }
  const m = list.find((x) => x.main); return m ? (m.project || '~') : '~';
}
function currentProjectSessions() {
  const list = sessCache.get(activeWs) || [];
  const proj = activeProject();
  return list.filter((s) => (s.project || '~') === proj);
}
function renderHdrSess() {
  const btn = document.getElementById('hdr-sess'); const menu = document.getElementById('hdr-sessmenu');
  if (!btn || !menu) return;
  // Only shown when the active session is NON-main: main is the default (click the workspace), so
  // switching away from it belongs in the sidebar. On a non-main session this quick-switches among
  // the project's other non-main sessions.
  const onMain = !activeSess || !!activeSess.main;
  const others = currentProjectSessions().filter((s) => !s.main);
  if (!activeWs || isMobile() || onMain || !others.length) { btn.style.display = 'none'; menu.classList.remove('show'); return; }
  btn.style.display = '';
  btn.textContent = curSessLabel() + ' ▾';
}
function updateHdr() {
  const nameEl = document.getElementById('hdr-name');
  const dotEl = document.getElementById('hdr-dot');
  if (!activeWs) { nameEl.textContent = 'No workspace selected'; dotEl.className = 'dot dot-off'; renderHdrApps(); renderHdrSess(); return; }
  nameEl.textContent = activeWs;
  const s = sessions.get(active);
  const open = !!s && s.sock.readyState === 1;
  dotEl.className = 'dot ' + (open ? 'dot-on' : 'dot-off');
  renderHdrApps(); renderHdrSess();
}

// opts: { sid, cwd, isMain, fork, label }. main (isMain) connects to the shared param-less
// "claude" tmux; a non-main session routes &session/&cwd(/&fork) so the backend launches/attaches
// its own cl-<id8> tmux — mirrors the (verified) mobile chat.js PTY model exactly.
function makeSession(ws, opts) {
  opts = opts || {};
  const key = sessKey(ws, opts.isMain ? '' : (opts.fork ? 'fork:' + opts.fork : (opts.sid || (opts.cwd ? 'new:' + opts.cwd : ''))));
  const el = document.createElement('div'); el.className = 'termpane'; el.style.height = '100%'; el.style.display = 'none';
  // xterm renders into a padding-free inner box so FitAddon measures a clean area
  // (opening directly onto the padded .termpane made fit ~half a row too tall → clipped).
  const inner = document.createElement('div'); inner.className = 'terminner'; el.appendChild(inner);
  document.getElementById('termwrap').appendChild(el);
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
    theme: { background: '#262624', foreground: '#e8e6de', cursor: '#d97757', cursorAccent: '#262624', selectionBackground: '#d9775740' },
  });
  // NOTE: do NOT term.open(el) here — the pane is display:none, so xterm would measure
  // a hidden element and cache wrong cell metrics → the terminal renders ~1/4 size until a
  // later re-activate. We open it in activate(), once the pane is visible. (openTerm below.)
  const fit = new FitAddon(); term.loadAddon(fit);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let url = `${proto}://${location.host}/api/pty?ws=${encodeURIComponent(ws)}&width=80&height=24`;
  if (!opts.isMain) {
    if (opts.fork) url += '&session=' + encodeURIComponent(opts.fork) + '&fork=1';
    else if (opts.sid) url += '&session=' + encodeURIComponent(opts.sid);
    if (opts.cwd) url += '&cwd=' + encodeURIComponent(opts.cwd);
  }
  const sock = new WebSocket(url);
  const name = key;
  const s = { el, inner, term, sock, fit, opened: false, ws, sid: opts.isMain ? '' : (opts.sid || ''), cwd: opts.cwd || '', isMain: !!opts.isMain, fork: opts.fork || '', label: opts.label || (opts.isMain ? 'main' : '') };
  sessions.set(key, s);
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
  sock.addEventListener('open', () => { fitSoon(s); updateHdr(); });
  sock.addEventListener('close', () => updateHdr());
  sock.onmessage = (e) => {
    // First byte from the PTY means the tmux/claude side is live — re-send our real size then, so a
    // resize that raced the connect (leaving claude drawing at the initial 80x24 → "1/4 screen") is
    // corrected once. Cheap and idempotent.
    if (!s.sized) { s.sized = true; fitSoon(s); }
    term.write(e.data);
  };
  term.onData((d) => sock.readyState === 1 && sock.send(JSON.stringify({ data: d })));
  term.onBell(() => notifyDone(s));
  el.addEventListener('click', () => s.term.focus());
  return s;
}

// Open the terminal the first time its pane becomes visible (correct cell metrics), then fit.
function openTerm(s) {
  if (s.opened) return;
  s.term.open(s.inner); s.opened = true;
}
// Fit the terminal to its container. Deferred to the next frames so layout has settled
// after display:none -> block (otherwise fit measures a stale/zero size → tiny 1/4 term).
function fitSession(s) {
  if (!s || !s.opened) return;
  try { s.fit.fit(); if (s.sock.readyState === 1) s.sock.send(JSON.stringify({ height: s.term.rows, width: s.term.cols })); } catch (_) {}
}
// rAF (layout) + several delayed passes so the first fit lands even on a slow/cold load or when the
// PTY proxy is laggy (a single early fit can race the connect and leave claude stuck at 80x24).
function fitSoon(s) {
  requestAnimationFrame(() => requestAnimationFrame(() => fitSession(s)));
  [120, 400, 800, 1500].forEach((ms) => setTimeout(() => fitSession(s), ms));
}
// Re-fit whenever the terminal area resizes (window, sidebar toggle, address-bar changes).
try {
  const ro = new ResizeObserver(() => {
    if (isMobile()) return;
    const s = active && sessions.get(active);
    if (s && s.el.style.display !== 'none') fitSession(s);
  });
  ro.observe(document.getElementById('termwrap'));
} catch (_) {}
// Once web fonts are ready, cell metrics may change → re-fit the active terminal.
try { document.fonts && document.fonts.ready.then(() => { const s = active && sessions.get(active); if (s && !isMobile()) fitSession(s); }); } catch (_) {}

function isMobile() { return window.innerWidth <= 768; }

// activate(ws)           → open the workspace's "main" session (shared claude tmux)
// activate(ws, session)  → open a specific session from the tree (main / existing / fresh create-fork)
function activate(ws, sess) {
  activeWs = ws; activeSess = sess || null;
  if (isMobile()) {
    // Mobile: embedded chat-bubble view (chat.html) owns the session tree; the sidebar just picks a ws.
    // key: fresh → its client key; existing non-main → its id; main → '' (so the tree highlights right)
    active = sess && sess.fresh ? sessKey(ws, sess.fork ? 'fork:' + sess.fork : 'new:' + sess.cwd)
      : sessKey(ws, (sess && !sess.main && sess.id) ? sess.id : '');
    const cf = document.getElementById('chatframe');
    let src = '/chat.html?ws=' + encodeURIComponent(ws);
    if (sess && sess.fresh) { src += '&freshcwd=' + encodeURIComponent(sess.cwd); if (sess.fork) src += '&forkid=' + encodeURIComponent(sess.fork); }
    else if (sess && !sess.main && sess.id) src += '&session=' + encodeURIComponent(sess.id);
    if (cf.getAttribute('data-src') !== src) { cf.setAttribute('data-src', src); cf.setAttribute('data-ws', ws); cf.src = src; }
    app.classList.add('showchat');
    app.classList.remove('open'); // close the drawer to reveal the chat
    renderList(searchVal()); updateHdr();
    return;
  }
  // Desktop: per-session terminal. Compute this session's launch options + stable key.
  const isMain = !sess || !!sess.main;
  const fresh = !!(sess && sess.fresh);
  const opts = {
    isMain,
    sid: fresh ? '' : (sess && !sess.main ? sess.id : ''),
    cwd: sess ? (sess.cwd || '') : '',
    fork: fresh && sess.fork ? sess.fork : '',
    label: isMain ? 'main' : (sess && (sess.title || sess.id)) || 'session',
  };
  const key = sessKey(ws, isMain ? '' : (opts.fork ? 'fork:' + opts.fork : (opts.sid || (opts.cwd ? 'new:' + opts.cwd : ''))));
  active = key;
  try {
    const q = '?ws=' + encodeURIComponent(ws) + (opts.sid ? '&session=' + encodeURIComponent(opts.sid) : '');
    history.replaceState(null, '', location.pathname + q);
  } catch (_) {}
  app.classList.remove('showchat');
  const cf = document.getElementById('chatframe');
  cf.removeAttribute('data-ws'); cf.removeAttribute('data-src'); cf.src = 'about:blank';   // disconnect the embedded page
  sessions.forEach((sv, n) => { if (n !== key) sv.el.style.display = 'none'; });
  const s = sessions.get(key) || makeSession(ws, opts);
  s.el.style.display = 'block';
  openTerm(s);  // open now that the pane is visible → correct cell metrics (avoids 1/4-size)
  s.term.focus();
  fitSoon(s);   // defer: pane just switched from display:none, layout not settled yet
  renderList(searchVal()); updateHdr();
  // Pull this workspace's session list (for the tree + top-right switcher) if not cached yet.
  if (!sessCache.has(ws)) loadSessions(ws).then(() => { renderList(searchVal()); updateHdr(); });
}

function fitActiveIfMobile() {
  if (isMobile()) return;                 // mobile uses the chat view, no fit needed
  const s = active && sessions.get(active);
  if (s) s.fit.fit();
}

let lastMobile = isMobile();
window.addEventListener('resize', () => {
  const m = isMobile();
  if (m !== lastMobile) { lastMobile = m; if (activeWs) activate(activeWs, activeSess); } // across breakpoint: switch terminal/chat
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

// Top-right session switcher: a dropdown of the CURRENT project's sessions only (cross-project /
// cross-workspace navigation lives in the sidebar tree). Built on open so it always reflects state.
(function initHdrSess() {
  const btn = document.getElementById('hdr-sess'); const menu = document.getElementById('hdr-sessmenu');
  if (!btn || !menu) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('show')) { menu.classList.remove('show'); return; }
    menu.innerHTML = '';
    const inProj = currentProjectSessions().filter((s) => !s.main); // main lives in the sidebar, not here
    if (!inProj.length) { const it = document.createElement('div'); it.className = 'hs-item'; it.textContent = '(no other sessions)'; menu.appendChild(it); }
    inProj.forEach((s) => {
      const cur = activeSess && activeSess.id === s.id;
      const it = document.createElement('div'); it.className = 'hs-item' + (cur ? ' cur' : '');
      it.textContent = s.title + (s.main ? ' ·main' : '');
      it.onclick = () => { menu.classList.remove('show'); activate(activeWs, s); };
      menu.appendChild(it);
    });
    menu.classList.add('show');
  });
  document.addEventListener('click', () => menu.classList.remove('show'));
  menu.addEventListener('click', (e) => e.stopPropagation());
})();

let workspaces = [];
let stoppedOpen = false; // "Stopped" group collapsed by default
function makeLi(w) {
  const li = document.createElement('li');
  const dot = document.createElement('span');
  dot.className = 'dot ' + (w.status === 'running' ? 'dot-on' : 'dot-off');
  li.appendChild(dot);
  const nm = document.createElement('span'); nm.className = 'ws-name'; nm.textContent = w.name; li.appendChild(nm);
  const cls = [];
  if (w.status !== 'running') cls.push('stopped');
  if (w.name === activeWs) cls.push('active');
  li.className = cls.join(' ');
  // Running workspaces get a caret that expands into their project → session tree (both PC + mobile).
  if (w.status === 'running') {
    const cv = document.createElement('span'); cv.className = 'ws-chev' + (expanded.has(w.name) ? ' open' : ''); cv.textContent = '▸';
    cv.onclick = (e) => { e.stopPropagation(); toggleExpand(w.name); };
    li.appendChild(cv);
  }
  li.onclick = async () => {
    if (w.status !== 'running') { if (await uiConfirm({ title: 'Start workspace', message: `Start "${w.name}"?`, ok: 'Start' })) startAndAttach(w.name); return; }
    // Row = open the workspace's main (default) session. Expansion is ONLY via the ▸ caret, so a
    // plain click never toggles the tree. (On mobile, opening main also closes the drawer.)
    activate(w.name);
  };
  return li;
}
function appendWs(ul, w) {
  ul.appendChild(makeLi(w));
  if (w.status === 'running' && expanded.has(w.name)) sessSubRows(w.name).forEach((r) => ul.appendChild(r));
}
function renderList(filter = '') {
  const ul = document.getElementById('list'); ul.innerHTML = '';
  const byName = new Map(workspaces.map((w) => [w.name, w]));
  const ranked = fuzzyRank(workspaces.map((w) => w.name), filter);

  if (filter) { // when searching, show all matches flat (incl. stopped), no grouping
    ranked.forEach((name) => appendWs(ul, byName.get(name)));
    return;
  }
  const running = ranked.filter((n) => byName.get(n).status === 'running');
  const stopped = ranked.filter((n) => byName.get(n).status !== 'running');
  running.forEach((name) => appendWs(ul, byName.get(name)));
  if (stopped.length) {
    const hdr = document.createElement('li');
    hdr.className = 'group-hdr' + (stoppedOpen ? ' open' : '');
    hdr.innerHTML = '<span>Stopped</span><span class=count>' + stopped.length + '</span><span class=chev>▸</span>';
    hdr.onclick = () => { stoppedOpen = !stoppedOpen; renderList(searchVal()); };
    ul.appendChild(hdr);
    if (stoppedOpen) stopped.forEach((name) => appendWs(ul, byName.get(name)));
  }
}

// ---- sidebar session tree (desktop): workspace → project → session ----
async function toggleExpand(ws) {
  if (expanded.has(ws)) { expanded.delete(ws); renderList(searchVal()); return; }
  expanded.add(ws);
  renderList(searchVal());                                    // shows a "loading…" row if not cached yet
  if (!sessCache.has(ws)) { await loadSessions(ws); renderList(searchVal()); }
}
async function loadSessions(ws, force) {
  if (sessCache.has(ws) && !force) return sessCache.get(ws);
  try {
    const j = await fetch('/api/sessions?ws=' + encodeURIComponent(ws)).then((r) => r.json());
    sessCache.set(ws, j.sessions || []);
  } catch (_) { if (!sessCache.has(ws)) sessCache.set(ws, []); }
  return sessCache.get(ws);
}
async function refreshSessions(ws) { await loadSessions(ws, true); renderList(searchVal()); updateHdr(); }
function subBtn(label, title, fn) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'subact'; b.textContent = label; b.title = title;
  b.onclick = (e) => { e.stopPropagation(); fn(); }; return b;
}
function sessSubRows(ws) {
  const rows = [];
  const list = sessCache.get(ws);
  const nw = document.createElement('li'); nw.className = 'sub sub-new'; nw.textContent = '＋ New session';
  nw.onclick = (e) => { e.stopPropagation(); newSession(ws); }; rows.push(nw);
  if (!list) { const li = document.createElement('li'); li.className = 'sub loading'; li.textContent = 'loading…'; rows.push(li); return rows; }
  // main is NOT listed — clicking the workspace already opens it; only OTHER sessions appear here.
  const groups = {};
  list.filter((s) => !s.main).forEach((s) => { const p = s.project || '~'; (groups[p] = groups[p] || []).push(s); });
  // a just-created/forked session with no transcript yet → show it provisionally so it doesn't vanish.
  const p = pending.get(ws);
  if (p) {
    const already = p.fork ? list.some((s) => s.cwd === p.cwd && !p.seen.has(s.id)) : list.some((s) => s.cwd === p.cwd && !s.main);
    if (!already) { (groups[p.project] = groups[p.project] || []).push({ _pending: true, title: 'starting…', project: p.project, cwd: p.cwd }); }
  }
  Object.keys(groups).forEach((proj) => {
    const h = document.createElement('li'); h.className = 'sub sub-proj'; h.textContent = proj; rows.push(h);
    groups[proj].forEach((s) => rows.push(sessSubRow(ws, s)));
  });
  return rows;
}
function sessSubRow(ws, s) {
  const key = s._pending ? pending.get(ws).key : sessKey(ws, s.id);
  const li = document.createElement('li'); li.className = 'sub sub-sess' + (key === active ? ' active' : '') + (s._pending ? ' pending' : '');
  const nm = document.createElement('span'); nm.className = 'sub-name'; nm.textContent = s.title;
  li.appendChild(nm);
  if (!s._pending) {
    const acts = document.createElement('span'); acts.className = 'sub-acts';
    acts.appendChild(subBtn('⑂', 'fork', () => forkSession(ws, s)));
    acts.appendChild(subBtn('✎', 'rename', () => renameSession(ws, s)));
    acts.appendChild(subBtn('🗑', 'delete', () => deleteSession(ws, s)));
    li.appendChild(acts);
  }
  li.onclick = (e) => { e.stopPropagation(); activate(ws, s._pending ? pending.get(ws).desc : s); };
  return li;
}
async function newSession(ws) {
  const proj = await uiPrompt({
    title: 'New session', message: 'Creates ~/<name> and starts a new session.', placeholder: 'project name', ok: 'Create',
    validate: (v) => (!v ? 'Enter a project name' : (!/^[A-Za-z0-9._-]+$/.test(v) ? 'Letters / digits / . _ - only' : '')),
  });
  if (!proj) return;
  const cwd = '/home/coder/' + proj;
  const desc = { fresh: true, cwd, title: proj };
  pending.set(ws, { key: sessKey(ws, 'new:' + cwd), cwd, project: proj, title: proj, desc });
  activate(ws, desc);
  adoptLoop(ws);
}
function forkSession(ws, s) {
  const desc = { fresh: true, cwd: s.cwd, fork: s.id, title: (s.title || 'session') + ' (fork)' };
  pending.set(ws, { key: sessKey(ws, 'fork:' + s.id), cwd: s.cwd, project: s.project || projName(s.cwd), title: desc.title, fork: s.id, seen: new Set((sessCache.get(ws) || []).map((x) => x.id)), desc });
  activate(ws, desc);
  adoptLoop(ws);
}
// Re-enumerate until the pending session gets a transcript, then adopt it: rebind its live pane to
// the real id so the tree row and the running claude are the same (no orphaned second process).
function adoptLoop(ws) {
  let tries = 0;
  const iv = setInterval(async () => {
    tries++;
    await loadSessions(ws, true);
    const p = pending.get(ws);
    if (!p) { clearInterval(iv); return; }
    const list = sessCache.get(ws) || [];
    const adopted = p.fork ? list.find((s) => s.cwd === p.cwd && !p.seen.has(s.id)) : list.find((s) => s.cwd === p.cwd && !s.main);
    if (adopted) {
      // Rename the launch tmux → cl-<id8> so reopening attaches the same claude (not a second one);
      // also records forks so enumeration keeps both the fork and its parent.
      try { fetch('/api/session/register?ws=' + encodeURIComponent(ws), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: adopted.id, cwd: p.cwd, parent: p.fork || '' }) }); } catch (_) {}
      const pane = sessions.get(p.key); const newKey = sessKey(ws, adopted.id);
      if (pane && !sessions.has(newKey)) { sessions.delete(p.key); pane.sid = adopted.id; pane.isMain = false; pane.label = adopted.title || adopted.id; sessions.set(newKey, pane); }
      if (active === p.key) { active = newKey; activeSess = adopted; }
      pending.delete(ws); clearInterval(iv);
    }
    renderList(searchVal()); updateHdr();
    if (tries >= 16) clearInterval(iv); // ~40s; keep the provisional row if the user never sent a turn
  }, 2500);
}
async function renameSession(ws, s) {
  const nm = await uiPrompt({ title: 'Rename session', value: s.title, ok: 'Save', validate: (v) => (v ? '' : 'Enter a name') });
  if (!nm) return;
  try { await fetch('/api/session/rename?ws=' + encodeURIComponent(ws), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: s.id, name: nm }) }); } catch (_) {}
  refreshSessions(ws);
}
async function deleteSession(ws, s) {
  if (s.main) return;
  if (!await uiConfirm({ title: 'Delete session', message: 'Delete "' + s.title + '"? This removes its transcript.', ok: 'Delete', danger: true })) return;
  try { await fetch('/api/session/delete?ws=' + encodeURIComponent(ws), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: s.id }) }); } catch (_) {}
  const key = sessKey(ws, s.id); const ps = sessions.get(key);
  if (ps) { try { ps.sock.close(); } catch (_) {} try { ps.term.dispose(); } catch (_) {} ps.el.remove(); sessions.delete(key); }
  if (key === active) activate(ws); // its pane was showing → fall back to main
  refreshSessions(ws);
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
  workspaces = ws; renderList(document.getElementById('search').value); updateHdr();
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
