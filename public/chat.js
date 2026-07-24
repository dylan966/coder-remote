// public/chat.js — mobile bubble view for the B spike. Reads /api/chat to render, writes input to /api/pty.
const params = new URLSearchParams(location.search);
const wsName = params.get('ws');
const log = document.getElementById('log');
const dot = document.getElementById('dot');
document.getElementById('ws').textContent = wsName || '(missing ws param)';

// ---------- markdown-lite ----------
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
}
function splitRow(line) { return line.trim().replace(/^\||\|$/g, '').split('|').map((s) => s.trim()); }
function isSep(line) { return line && line.includes('|') && /^\s*\|?[\s:|-]*-{2,}[\s:|-]*$/.test(line); }
function mdToHtml(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  let html = '', i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      i++; const code = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
      i++; html += '<pre><code>' + esc(code.join('\n')) + '</code></pre>'; continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { html += `<h${h[1].length}>` + inline(h[2]) + `</h${h[1].length}>`; i++; continue; }
    // Horizontal rule: a standalone line of --- / *** / ___ (3+, spaces allowed) → thin divider, not a text dash
    if (/^([-*_])\1{2,}$/.test(line.replace(/\s+/g, ''))) { html += '<hr>'; i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && isSep(lines[i + 1])) {
      const header = splitRow(line); i += 2; const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
      html += '<table><thead><tr>' + header.map((c) => '<th>' + inline(c) + '</th>').join('') +
        '</tr></thead><tbody>' + rows.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table>'; continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; }
      html += '<ul>' + items.map((it) => '<li>' + inline(it) + '</li>').join('') + '</ul>'; continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^```|^#{1,3}\s|^\s*[-*]\s/.test(lines[i]) && !/^([-*_])\1{2,}$/.test(lines[i].replace(/\s+/g, '')) && !(lines[i].includes('|') && i + 1 < lines.length && isSep(lines[i + 1]))) {
      para.push(lines[i]); i++;
    }
    html += '<p>' + inline(para.join('\n')).replace(/\n/g, '<br>') + '</p>';
  }
  return html;
}

// ---------- render ----------
function atBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 80; }
function toBottom() { log.scrollTop = log.scrollHeight; }
let stick = true; // Stick-to-bottom: follow the latest message by default; pause when the user scrolls up, resume on scroll back to bottom
const toBtn = document.getElementById('tobottom');
function updateToBtn() { toBtn.classList.toggle('show', !atBottom()); }
log.addEventListener('scroll', () => { stick = atBottom(); updateToBtn(); });
// Async-loaded images grow the content → re-scroll to bottom when stuck (load doesn't bubble, use capture)
log.addEventListener('load', (e) => { if (e.target && e.target.tagName === 'IMG') { if (stick) toBottom(); updateToBtn(); } }, true);
toBtn.addEventListener('click', () => { stick = true; toBottom(); updateToBtn(); });

// Typing indicator: always pinned to the bottom, appears (debounced) while sending/tools run, disappears once the assistant speaks.
// Also drives the "stop" button: shown while Claude is busy (typing), can send ESC to interrupt.
const stopBtn = document.getElementById('stopbtn');
stopBtn.addEventListener('click', () => { try { if (pty && pty.readyState === 1) pty.send(JSON.stringify({ data: '\x1b' })); } catch (_) {} });
let typingEl = null, typingTimer = null;
function showTyping() {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    const near = atBottom();
    if (!typingEl) { typingEl = document.createElement('div'); typingEl.className = 'typing'; typingEl.innerHTML = '<span></span><span></span><span></span>'; }
    log.appendChild(typingEl);
    stopBtn.classList.add('show');
    if (near) log.scrollTop = log.scrollHeight;
  }, 350);
}
function hideTyping() { clearTimeout(typingTimer); if (typingEl && typingEl.parentNode) typingEl.remove(); stopBtn.classList.remove('show'); }

// add() keeps typing always at the very bottom (new content is inserted before it).
function add(el) {
  if (typingEl && typingEl.parentNode === log) log.insertBefore(el, typingEl);
  else log.appendChild(el);
}
function bubble(cls, html) {
  const row = document.createElement('div'); row.className = 'row ' + cls;
  const b = document.createElement('div'); b.className = 'bub'; b.innerHTML = html;
  row.appendChild(b); add(row);
}

const stepById = new Map();
const uploadReadIds = new Set(); // tool_use ids that Read our upload dir → skip their inline images (images you sent already show in the bubble)
function shortArg(input) {
  if (!input) return '';
  const a = input.command || input.description || input.file_path || input.path || input.pattern || '';
  return String(a).replace(/\s+/g, ' ').trim();
}
const HEAVY_INPUT = ['old_string', 'new_string', 'oldString', 'newString', 'content', 'file_text', 'edits'];
function makeStep(ev) {
  const step = document.createElement('div'); step.className = 'step';
  const head = document.createElement('div'); head.className = 'step-head';
  head.innerHTML = '<b>⚙ ' + esc(ev.name || 'tool') + '</b><span class=cmd>' + esc(shortArg(ev.input)) + '</span><span class=chev>▸</span>';
  const detail = document.createElement('div'); detail.className = 'detail';
  const shown = { ...(ev.input || {}) };
  for (const k of HEAVY_INPUT) delete shown[k];   // Large fields (old/new content) aren't put in the input; leave them to the diff below
  if (Object.keys(shown).length) detail.innerHTML = '<div class=lbl>Input</div><pre>' + esc(JSON.stringify(shown, null, 2)) + '</pre>';
  step.appendChild(head); step.appendChild(detail);
  step.addEventListener('click', () => step.classList.toggle('open'));
  add(step);
  if (ev.id) stepById.set(ev.id, step);
}
function basename(p) { return String(p || '').split('/').pop(); }
function renderDiff(patch) {
  let h = '<div class=diff>';
  for (const hunk of patch) for (const ln of (hunk.lines || [])) {
    const c = ln[0]; const cls = c === '+' ? 'add' : (c === '-' ? 'del' : 'ctx');
    h += '<div class="dl ' + cls + '">' + esc(ln || ' ') + '</div>';
  }
  return h + '</div>';
}
// Render from the on-disk structured toolUseResult: Edit/Write→diff, Bash→stdout; otherwise fall back to plain text.
function resultBody(ev) {
  const r = ev.result;
  if (r && Array.isArray(r.structuredPatch) && r.structuredPatch.length)
    return '<div class=lbl>' + esc(basename(r.filePath)) + '</div>' + renderDiff(r.structuredPatch);
  if (r && typeof r.stdout === 'string') {
    const out = (ev.isError && r.stderr) ? r.stderr : (r.stdout || r.stderr || '(no output)');
    return '<div class=res><div class=lbl>' + (ev.isError ? 'Result (error)' : 'Result') + '</div><pre>' + esc(out.slice(0, 4000)) + '</pre></div>';
  }
  return '<div class=res><div class=lbl>' + (ev.isError ? 'Result (error)' : 'Result') + '</div><pre>' + esc((ev.text || '').slice(0, 4000)) + '</pre></div>';
}
function fillResult(ev) {
  const html = resultBody(ev);
  const step = ev.id && stepById.get(ev.id);
  if (step) {
    if (ev.isError) step.classList.add('err');
    step.querySelector('.detail').insertAdjacentHTML('beforeend', html);
  } else {
    const d = document.createElement('div'); d.className = 'step' + (ev.isError ? ' err' : '');
    d.innerHTML = '<div class=step-head><b>↩︎</b><span class=cmd>' + (ev.isError ? 'Result (error)' : 'Result') + '</span><span class=chev>▸</span></div><div class=detail>' + html + '</div>';
    d.addEventListener('click', () => d.classList.toggle('open'));
    add(d);
  }
}
function render(ev) {
  switch (ev.kind) {
    case 'title': {
      document.title = 'Chat · ' + ev.title;
      if (ev.title && !freshMode && !currentIsMain) sessbtn.textContent = ev.title + ' ▾';   // live title (only when the switcher is shown, i.e. non-main)
      break;
    }
    case 'user':
      if (ev.slash) { const d = document.createElement('div'); d.className = 'slashcmd'; d.textContent = ev.text; add(d); }
      else { bubble('user', esc(ev.text).replace(/\n/g, '<br>')); showTyping(); }
      break;
    case 'cmd_out': { const d = document.createElement('div'); d.className = 'cmdout'; d.innerHTML = '<pre>' + esc(ev.text.slice(0, 2000)) + '</pre>'; add(d); break; }
    case 'attach': {
      const d = document.createElement('div'); d.className = 'attrow';
      const files = ev.files || [];
      d.innerHTML = (files.length ? files : [{ name: 'Attachment' }]).map((f) => {
        if (f.path && /\.(png|jpe?g|gif|webp)$/i.test(f.name || f.path))
          return '<img class=thumb src="/api/attachment?ws=' + encodeURIComponent(wsName) + '&path=' + encodeURIComponent(f.path) + '" alt="' + esc(f.name || '') + '">';
        return '<span class=attpill>📎 ' + esc(f.name || 'Attachment') + '</span>';
      }).join('');
      add(d); break;
    }
    case 'image': {
      if (ev.ofToolUse && uploadReadIds.has(ev.ofToolUse)) break; // Images you sent already show in the bubble; don't duplicate inline
      const d = document.createElement('div'); d.className = 'imgrow';
      d.innerHTML = '<img class=chatimg src="data:' + esc(ev.mediaType || 'image/png') + ';base64,' + ev.data + '">';
      add(d); break;
    }
    case 'assistant_text': hideTyping(); bubble('asst', mdToHtml(ev.text)); maybeNotify(); break;
    case 'thinking': showTyping(); break;
    case 'tool_use':
      if (ev.id && /\.switcher-uploads/.test(JSON.stringify(ev.input || {}))) uploadReadIds.add(ev.id);
      makeStep(ev); showTyping(); break;
    case 'tool_result': fillResult(ev); showTyping(); break;
  }
}

// ---------- sessions: project → session tree ----------
const sessbtn = document.getElementById('sessbtn');
const sesspanel = document.getElementById('sesspanel');
let sessions = [];
const _q = new URLSearchParams(location.search);
let currentSession = _q.get('session') || null;
let currentCwd = '';
let currentIsMain = !currentSession;   // default click = main session (shares the "claude" tmux with the desktop terminal)
let freshMode = false;                 // create/fork: follow the newest session file until it's adopted
let ptyExtra = {};                     // {cwd, fork} for the create/fork PTY launch
let freshSeen = null;                  // session ids present at fork time (to pick the NEW one, not the parent)
// The sidebar's "New session" / provisional row deep-links here with a fresh cwd (and fork id):
// enter freshMode so this chat launches/follows that session rather than the workspace's main.
if (_q.get('freshcwd')) {
  currentSession = null; currentIsMain = false; freshMode = true; currentCwd = _q.get('freshcwd');
  ptyExtra = _q.get('forkid') ? { cwd: currentCwd, fork: _q.get('forkid') } : { cwd: currentCwd };
}

function closePanel() { sesspanel.classList.remove('show'); }
sessbtn.addEventListener('click', (e) => { e.stopPropagation(); if (sesspanel.classList.contains('show')) closePanel(); else { buildPanel(); sesspanel.classList.add('show'); } });
document.addEventListener('click', closePanel);
sesspanel.addEventListener('click', (e) => e.stopPropagation());

function resetChat() {
  log.innerHTML = ''; stepById.clear(); uploadReadIds.clear();
  if (typingEl && typingEl.parentNode) typingEl.remove();
  typingEl = null; clearTimeout(typingTimer); stick = true;
}
function reconnectAll() { closeChat(); closePty(); resetChat(); openChat(); openPty(); }

function curLabel() {
  if (freshMode) return 'new…';
  const c = sessions.find((s) => s.id === currentSession);
  return c ? c.title : (currentIsMain ? 'main' : (currentSession || 'session'));
}
// The top switcher shows only on a NON-main session — main is the default (opened from the sidebar),
// so switching away from it belongs in the sidebar tree, not a top-bar dropdown.
function updateSessBtn() {
  sessbtn.hidden = currentIsMain && !freshMode;
  if (!sessbtn.hidden) sessbtn.textContent = curLabel() + ' ▾';
}
function renderSessions(list) {
  sessions = list || [];
  if (!sessions.length) {
    if (!log.querySelector('.empty')) { const h = document.createElement('div'); h.className = 'cmdout empty'; h.innerHTML = '<pre>This workspace has no conversations yet.\nJust send a message to start one.</pre>'; add(h); }
    updateSessBtn();
    if (sesspanel.classList.contains('show')) buildPanel();
    return;
  }
  const e = log.querySelector('.empty'); if (e) e.remove();
  // adopt the new session only once it appears with our target cwd (a fresh session with no
  // messages yet isn't enumerated). Until then stay in freshMode (chat follows the newest file).
  if (freshMode) {
    const isFork = !!ptyExtra.fork;
    const nw = isFork
      ? sessions.find((s) => s.cwd === currentCwd && s.id !== ptyExtra.fork && (!freshSeen || !freshSeen.has(s.id)))
      : sessions.find((s) => s.cwd === currentCwd);
    if (nw) {
      if (isFork) { try { fetch('/api/session/markfork?ws=' + encodeURIComponent(wsName), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: nw.id, parent: ptyExtra.fork }) }); } catch (_) {} }
      currentSession = nw.id; currentIsMain = !!nw.main; freshMode = false; ptyExtra = {}; freshSeen = null;
    }
  }
  if (!currentSession) { const m = sessions.find((s) => s.main) || sessions[0]; currentSession = m.id; currentCwd = m.cwd; currentIsMain = !!m.main; }
  updateSessBtn();
  if (sesspanel.classList.contains('show')) buildPanel();
}
function buildPanel() {
  sesspanel.innerHTML = '';
  const nw = document.createElement('div'); nw.className = 'sp-new'; nw.textContent = '＋ New session'; nw.addEventListener('click', onNew); sesspanel.appendChild(nw);
  const groups = {};
  sessions.filter((s) => !s.main).forEach((s) => { const p = s.project || '~'; (groups[p] = groups[p] || []).push(s); }); // main lives in the sidebar
  Object.keys(groups).forEach((proj) => {
    const h = document.createElement('div'); h.className = 'sp-proj'; h.textContent = proj; sesspanel.appendChild(h);
    groups[proj].forEach((s) => sesspanel.appendChild(sessRow(s)));
  });
}
function iconBtn(label, title, fn) { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = title; b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; }
function sessRow(s) {
  const row = document.createElement('div'); row.className = 'sp-sess' + (s.id === currentSession ? ' cur' : '');
  const nm = document.createElement('span'); nm.className = 'sp-name'; nm.textContent = s.title + (s.main ? ' ·main' : '');
  nm.addEventListener('click', () => { switchSession(s); closePanel(); });
  row.appendChild(nm);
  const acts = document.createElement('span'); acts.className = 'sp-acts';
  acts.appendChild(iconBtn('⑂', 'fork', () => forkSession(s)));
  acts.appendChild(iconBtn('✎', 'rename', () => renameSession(s)));
  if (!s.main) acts.appendChild(iconBtn('🗑', 'delete', () => deleteSession(s)));
  row.appendChild(acts);
  return row;
}
function switchSession(s) {
  if (s.id === currentSession && !freshMode) return;
  currentSession = s.id; currentCwd = s.cwd || ''; currentIsMain = !!s.main; freshMode = false; ptyExtra = {};
  reconnectAll();
}
async function onNew() {
  const proj = await uiPrompt({
    title: 'New session', message: 'Creates ~/<name> and starts a new session.', placeholder: 'project name', ok: 'Create',
    validate: (v) => (!v ? 'Enter a project name' : (!/^[A-Za-z0-9._-]+$/.test(v) ? 'Letters / digits / . _ - only' : '')),
  });
  if (!proj) return;
  closePanel();
  currentSession = null; currentIsMain = false; freshMode = true; currentCwd = '/home/coder/' + proj; ptyExtra = { cwd: currentCwd };
  reconnectAll();
  setTimeout(() => { closeChat(); openChat(); }, 2500); // re-enumerate to adopt the new session
}
function forkSession(s) {
  closePanel();
  freshSeen = new Set(sessions.map((x) => x.id)); // remember pre-fork ids so we adopt the NEW branch, not the parent
  currentSession = null; currentIsMain = false; freshMode = true; currentCwd = s.cwd || ''; ptyExtra = { cwd: s.cwd, fork: s.id };
  reconnectAll();
  setTimeout(() => { closeChat(); openChat(); }, 2500);
}
async function renameSession(s) {
  const nm = await uiPrompt({ title: 'Rename session', value: s.title, ok: 'Save', validate: (v) => (v ? '' : 'Enter a name') });
  if (!nm) return;
  try { await fetch('/api/session/rename?ws=' + encodeURIComponent(wsName), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: s.id, name: nm }) }); } catch (_) {}
  closeChat(); openChat(); // re-enumerate to pick up the new name
}
async function deleteSession(s) {
  if (s.main) return;
  if (!await uiConfirm({ title: 'Delete session', message: 'Delete "' + s.title + '"? This removes its transcript.', ok: 'Delete', danger: true })) return;
  try { await fetch('/api/session/delete?ws=' + encodeURIComponent(wsName), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: s.id }) }); } catch (_) {}
  closePanel();
  if (s.id === currentSession) { const m = sessions.find((x) => x.main); currentSession = m ? m.id : null; currentCwd = m ? m.cwd : ''; currentIsMain = !!(m && m.main); freshMode = false; ptyExtra = {}; reconnectAll(); }
  else { closeChat(); openChat(); }
}

// ---------- Quick links (this workspace's frontend/backend/service entrypoints) ----------
// Rendered as text pills at the bottom (above the input) — no top-bar icon.
let appsCache = null;
async function loadApps() {
  if (appsCache) return appsCache;
  try {
    const j = await fetch('/api/workspaces').then((r) => r.json());
    const w = (j.workspaces || []).find((x) => x.name === wsName);
    appsCache = (w && w.apps) || [];
  } catch (_) { appsCache = []; }
  return appsCache;
}
(async () => {
  const apps = await loadApps();
  const row = document.getElementById('linksrow');
  if (!row || !apps.length) return;
  row.innerHTML = apps.map((a) => '<a href="' + a.url + '" target="_blank" rel="noopener">' + esc(a.name) + '</a>').join('');
})();

// ---------- Notifications (only fire when the page is hidden, debounced; most useful when installed as a PWA in the background) ----------
function ensureNotifyPerm() {
  if (!window.Notification) return;
  if (Notification.permission === 'granted') { ensurePush(); return; }
  if (Notification.permission === 'default') {
    try { Notification.requestPermission().then((p) => { if (p === 'granted') ensurePush(); }); } catch (_) {}
  }
}
// Web Push subscription: get the VAPID public key → pushManager.subscribe → report to the server (bound to the current ws).
// With it, the server can push "reply finished" even when the app is fully closed. Idempotent, safe to call repeatedly.
function urlB64ToUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const s = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s); const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
let pushDone = false;
async function ensurePush() {
  if (pushDone) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (!(window.Notification && Notification.permission === 'granted')) return;
  try {
    const meta = await fetch('/api/push/key').then((r) => r.json());
    if (!meta.enabled || !meta.key) return;
    const reg = await navigator.serviceWorker.ready;
    const want = urlB64ToUint8(meta.key);
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      // The hub may have been recreated with a fresh VAPID key. A subscription is bound to the key
      // it was made with, so a stale one silently fails (VAPID mismatch). If the key changed, drop
      // it and re-subscribe with the current key — silent, no permission prompt (already granted).
      const cur = new Uint8Array(sub.options.applicationServerKey || []);
      const same = cur.length === want.length && cur.every((b, i) => b === want[i]);
      if (!same) { try { await sub.unsubscribe(); } catch (_) {} sub = null; }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
    await fetch('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ws: wsName, sub }) });
    pushDone = true;
  } catch (_) { /* user denied / unsupported, stay silent */ }
}
if (wsName) ensurePush(); // If already granted, re-subscribe directly (bound to this ws)
let notifyTimer = null;
function maybeNotify() {
  if (!(window.Notification && Notification.permission === 'granted')) return;
  if (document.visibilityState === 'visible') return; // Don't disturb while it's being viewed
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    const title = (typeof curLabel === 'function' ? curLabel() : '') || wsName;
    const opts = { body: 'Claude has a new reply', tag: 'chat-' + wsName, renotify: true, icon: '/icon.svg' };
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.ready) navigator.serviceWorker.ready.then((reg) => reg.showNotification('🔔 ' + title, opts)).catch(() => {});
      else new Notification('🔔 ' + title, opts);
    } catch (_) {}
  }, 1000);
}

// ---------- wiring (with auto-reconnect on disconnect) ----------
const proto = location.protocol === 'https:' ? 'wss' : 'ws';
let chat, pty;
let chatTimer = null, chatBackoff = 1000;
let pendingReset = false; // Reconnect after drop: wait for the first replayed message before clearing, to avoid flicker / duplicate bubbles
// The chat server replays the entire transcript on every connection, so after reconnecting we must clear before rendering.
function closeChat() { clearTimeout(chatTimer); if (chat) { chat._intentional = true; try { chat.close(); } catch (_) {} } }
function openChat() {
  clearTimeout(chatTimer);
  let url = `${proto}://${location.host}/api/chat?ws=${encodeURIComponent(wsName)}`;
  if (currentSession) url += '&session=' + encodeURIComponent(currentSession);
  if (freshMode) url += '&fresh=1';
  chat = new WebSocket(url); chat._intentional = false;
  chat.onopen = () => { dot.classList.add('on'); chatBackoff = 1000; };
  chat.onmessage = (e) => {
    if (pendingReset) { resetChat(); pendingReset = false; }
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.kind === 'sessions') { renderSessions(ev.list); return; }
    render(ev); if (stick) toBottom(); updateToBtn();
  };
  chat.onclose = () => {
    dot.classList.remove('on');
    if (chat._intentional) return;      // Manual switch / new session, don't auto-reconnect
    pendingReset = true;
    chatTimer = setTimeout(openChat, chatBackoff);
    chatBackoff = Math.min(chatBackoff * 2, 15000); // Exponential backoff, capped at 15s
  };
  chat.onerror = () => {}; // Let onclose handle reconnection uniformly
}
let ptyTimer = null, ptyBackoff = 1000;
function closePty() { clearTimeout(ptyTimer); if (pty) { pty._intentional = true; try { pty.close(); } catch (_) {} } }
function openPty() {
  clearTimeout(ptyTimer);
  let url = `${proto}://${location.host}/api/pty?ws=${encodeURIComponent(wsName)}&width=80&height=24`;
  if (!currentIsMain) {
    // non-main session: attach its own tmux (resume / create / fork). Main stays param-less →
    // the shared "claude" tmux, so mobile chat and the desktop terminal are the same conversation.
    if (ptyExtra.fork) url += '&session=' + encodeURIComponent(ptyExtra.fork) + '&fork=1';
    else if (currentSession) url += '&session=' + encodeURIComponent(currentSession);
    const cw = ptyExtra.cwd || currentCwd;
    if (cw) url += '&cwd=' + encodeURIComponent(cw);
  }
  pty = new WebSocket(url); pty._intentional = false;
  pty.onopen = () => { ptyBackoff = 1000; };
  pty.onmessage = () => {}; // Used only to send input; terminal output is ignored (bubbles come from the transcript)
  pty.onclose = () => { if (pty._intentional) return; ptyTimer = setTimeout(openPty, ptyBackoff); ptyBackoff = Math.min(ptyBackoff * 2, 15000); };
  pty.onerror = () => {};
}
if (wsName) { openChat(); openPty(); }

// ---------- compose ----------
const msg = document.getElementById('msg');
function grow() {
  msg.style.height = 'auto';
  msg.style.height = Math.min(msg.scrollHeight, 104) + 'px';
  msg.style.overflowY = msg.scrollHeight > 104 ? 'auto' : 'hidden'; // Only show the scrollbar once past the max height
}
msg.addEventListener('input', () => { grow(); updateAc(); });

// ---------- Autocomplete: typing / at the start opens the command menu, @ anywhere opens the file menu ----------
const ac = document.getElementById('ac');
const SLASH_CMDS = [
  ['/clear', 'Clear the conversation, start fresh'], ['/compact', 'Compact history, save context'], ['/model', 'Switch model'],
  ['/resume', 'Resume a past session'], ['/cost', 'This session usage / cost'], ['/review', 'Code review'],
  ['/init', 'Generate CLAUDE.md'], ['/status', 'Status'], ['/mcp', 'MCP servers'], ['/agents', 'Subagents'],
  ['/config', 'Settings'], ['/help', 'Help'],
];
let fileCache = null, fileLoading = null;
function loadFiles() {
  if (fileCache) return Promise.resolve(fileCache);
  if (!fileLoading) fileLoading = fetch('/api/files?ws=' + encodeURIComponent(wsName))
    .then((r) => r.json()).then((j) => (fileCache = j.files || [])).catch(() => (fileCache = []));
  return fileLoading;
}
let acMode = null, acItems = [], acSel = 0, acStart = 0; // acStart: start of the token (incl. trigger char) within msg.value
function hideAc() { ac.classList.remove('show'); ac.innerHTML = ''; acMode = null; acItems = []; }
function renderAc() {
  ac.innerHTML = '';
  acItems.slice(0, 60).forEach((it, i) => {
    const el = document.createElement('div'); el.className = 'item' + (i === acSel ? ' sel' : '');
    el.innerHTML = acMode === 'slash'
      ? '<span class=k>' + esc(it.k) + '</span><span class=d>' + esc(it.d) + '</span>'
      : '<span class=p>' + esc(it.k) + '</span>';
    el.addEventListener('mousedown', (e) => { e.preventDefault(); pickAc(i); }); // mousedown: fire before the textarea loses focus
    ac.appendChild(el);
  });
  ac.classList.toggle('show', acItems.length > 0);
  const sel = ac.children[acSel]; if (sel) sel.scrollIntoView({ block: 'nearest' });
}
function pickAc(i) {
  const it = acItems[i]; if (!it) return;
  const before = msg.value.slice(0, acStart);
  const after = msg.value.slice(msg.selectionStart);
  const insert = it.k + ' ';
  msg.value = before + insert + after;
  const pos = (before + insert).length; msg.setSelectionRange(pos, pos);
  hideAc(); grow(); msg.focus();
}
function updateAc() {
  const pre = msg.value.slice(0, msg.selectionStart);
  let m;
  if ((m = pre.match(/^\/(\S*)$/))) {                 // Whole input starts with / → command completion
    acMode = 'slash'; acStart = 0;
    const q = m[1].toLowerCase();
    acItems = SLASH_CMDS.filter((c) => c[0].slice(1).toLowerCase().startsWith(q)).map((c) => ({ k: c[0], d: c[1] }));
    acSel = 0; renderAc();
  } else if ((m = pre.match(/(^|\s)@([^\s@]*)$/))) {    // @ at word start → file completion
    acMode = 'file'; acStart = msg.selectionStart - (m[2].length + 1);
    const q = m[2].toLowerCase();
    loadFiles().then((files) => {
      if (acMode !== 'file') return; // May have switched away in the meantime
      acItems = (q ? files.filter((f) => f.toLowerCase().includes(q)) : files).slice(0, 60).map((f) => ({ k: '@' + f }));
      acSel = 0; renderAc();
    });
  } else hideAc();
}
msg.addEventListener('blur', () => setTimeout(hideAc, 150)); // Close the menu when the keyboard hides (leave time for mousedown to select)
// ---------- Attachments (images/files) ----------
const attsEl = document.getElementById('atts');
let atts = []; // { name, path|null }
function fileToB64(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
}
function renderAtts() {
  attsEl.innerHTML = '';
  atts.forEach((a, i) => {
    const el = document.createElement('div'); el.className = 'att' + (a.path ? '' : ' up');
    el.innerHTML = '<span class=nm>' + esc(a.name) + '</span>' + (a.path ? '<button class=x aria-label=Remove>×</button>' : '<span>…</span>');
    if (a.path) el.querySelector('.x').onclick = () => { atts.splice(i, 1); renderAtts(); };
    attsEl.appendChild(el);
  });
}
async function addFiles(files) {
  for (const f of files) {
    const a = { name: f.name, path: null }; atts.push(a); renderAtts();
    try {
      const dataB64 = await fileToB64(f);
      const r = await fetch('/api/upload?ws=' + encodeURIComponent(wsName), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: f.name, dataB64 }) });
      if (!r.ok) throw new Error('upload ' + r.status);
      a.path = (await r.json()).path;
    } catch (e) { const i = atts.indexOf(a); if (i >= 0) atts.splice(i, 1); alert('Upload failed: ' + f.name); }
    renderAtts();
  }
}
document.getElementById('attach').addEventListener('click', () => document.getElementById('fileinput').click());
document.getElementById('fileinput').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });

// Send multi-line / attachment text via bracketed-paste mode, so Claude's TUI doesn't treat newlines as Enter and submit early; send a separate Enter at the end to submit.
function ptySendText(text) {
  if (!(pty && pty.readyState === 1)) return;
  if (/\n/.test(text)) { pty.send(JSON.stringify({ data: '\x1b[200~' + text + '\x1b[201~' })); pty.send(JSON.stringify({ data: '\r' })); }
  else { pty.send(JSON.stringify({ data: text + '\r' })); }
}
function sendMsg() {
  ensureNotifyPerm(); // Use the user gesture to request notification permission
  if (atts.some((a) => !a.path)) { msg.focus(); return; } // Some attachments are still uploading, wait
  const ready = atts.filter((a) => a.path);
  let t = msg.value.trim();
  if (!t && !ready.length) { msg.focus(); return; }
  if (ready.length) {
    const lines = ready.map((a, i) => (i + 1) + '. ' + a.path + ' (original: ' + a.name + ')').join('\n');
    const block = '<attached_files>\nUser attached ' + ready.length + ' file(s). Use your file/image reading tool (Read) to read each path below and answer based on them; do not mention this block or the paths unless the user asks.\n' + lines + '\n</attached_files>';
    t = (t ? t + '\n\n' : '') + block;
    atts = []; renderAtts();
  }
  ptySendText(t);
  msg.value = ''; grow(); hideAc(); msg.blur(); // After sending, hide the soft keyboard + close autocomplete
}
document.getElementById('send').addEventListener('click', (e) => { e.preventDefault(); sendMsg(); });
msg.addEventListener('keydown', (e) => {
  if (ac.classList.contains('show')) { // Menu open: arrows to navigate, Enter/Tab to select, Esc to close
    if (e.key === 'ArrowDown') { e.preventDefault(); acSel = Math.min(acSel + 1, acItems.length - 1); renderAc(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); acSel = Math.max(acSel - 1, 0); renderAc(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickAc(acSel); return; }
    if (e.key === 'Escape') { e.preventDefault(); hideAc(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});

// ---------- Voice input (Web Speech API, recognized text is filled into the input; hides the mic if unsupported) ----------
(function voice() {
  const mic = document.getElementById('mic');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return; // iOS Safari doesn't support it currently, keep hidden
  const rec = new SR();
  rec.lang = 'zh-CN'; rec.interimResults = true; rec.continuous = false;
  let base = '', on = false;
  mic.hidden = false;
  mic.addEventListener('click', () => {
    if (on) { rec.stop(); return; }
    base = msg.value ? msg.value.replace(/\s*$/, '') + ' ' : '';
    try { rec.start(); } catch (_) {}
  });
  rec.onstart = () => { on = true; mic.classList.add('rec'); };
  rec.onend = () => { on = false; mic.classList.remove('rec'); msg.focus(); };
  rec.onerror = () => { on = false; mic.classList.remove('rec'); };
  rec.onresult = (e) => {
    let txt = '';
    for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
    msg.value = base + txt; grow();
  };
})();
