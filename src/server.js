const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { loadConfig } = require('./config');
const { makeClient } = require('./coder-client');
const { parseRecord } = require('./transcript');
const { makeTurnDetector } = require('./turn');
const push = require('./push');

const UPLOAD_DIR = '/home/coder/.switcher-uploads'; // upload landing directory inside the target workspace

/** Read the request body; reject once it exceeds limit bytes. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { req.destroy(); reject(new Error('too large')); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
/** Promise version of execFile. */
function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => execFile(cmd, args, opts, (e, so, se) => (e ? reject(Object.assign(e, { stderr: se })) : resolve(so))));
}

const config = loadConfig();
const client = makeClient(config.getAuth);
const PUB = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(PUB, path.normalize(p));
  if (!file.startsWith(PUB)) { res.statusCode = 403; return res.end('forbidden'); }
  fs.readFile(file, (e, buf) => {
    if (e) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
    // App files (html/js/css) must never be served stale — otherwise an old app.js keeps
    // an already-fixed bug alive in the browser. Third-party vendor assets are versioned
    // and rarely change, so let them cache.
    res.setHeader('cache-control', p.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache');
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const json = (o, code = 200) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (e) { return json({ error: 'bad request' }, 400); }
  try {
    if (u.pathname === '/api/workspaces') {
      const self = process.env.SWITCHER_SELF; // the hub's own workspace — hide it from the list
      const list = await client.listWorkspaces();
      return json({ workspaces: self ? list.filter((w) => w.name !== self) : list });
    }
    if (u.pathname === '/api/start' && req.method === 'POST') { await client.startWorkspace(u.searchParams.get('ws')); return json({ ok: true }); }
    if (u.pathname === '/api/sessions') { // enumerate a workspace's sessions once (grouped-by-project data for the sidebar tree)
      const wsName = u.searchParams.get('ws');
      if (!wsName) return json({ error: 'missing ws' }, 400);
      try {
        // Cheap signature (file count + newest mtime) first: the full scan reads every transcript
        // line, so skip it when nothing changed since last time (repeated sidebar expands / refresh).
        let sig = '';
        try { sig = (await execFileP('coder', ['ssh', wsName, '--', "ls ~/.claude/projects/*/*.jsonl 2>/dev/null | wc -l; find ~/.claude/projects -name '*.jsonl' -printf '%T@\\n' 2>/dev/null | sort -rn | head -1"], { timeout: 15000 })).replace(/\s+/g, ' ').trim(); } catch (_) {}
        const cached = enumCache.get(wsName);
        if (sig && cached && cached.sig === sig) return json({ sessions: cached.listing });
        await ensureSessPy(wsName);
        maybeReap(wsName);
        const out = await execFileP('coder', ['ssh', wsName, '--', 'LIST_ONLY=1 python3 ~/.switcher/sess.py'], { timeout: 25000, maxBuffer: 8 * 1024 * 1024 });
        const line = (out || '').split('\n').find((l) => l.indexOf('##SESSIONS##') >= 0);
        const listing = line ? JSON.parse(line.slice(line.indexOf('##SESSIONS##') + 12)) : [];
        if (sig) enumCache.set(wsName, { sig, listing });
        return json({ sessions: listing });
      } catch (e) { return json({ sessions: [], error: String(e.message || e) }); }
    }
    if (u.pathname === '/api/upload' && req.method === 'POST') {
      // receive base64 → temp file → coder cp into the target workspace's ~/.switcher-uploads/, returning the absolute path inside the workspace.
      const wsName = u.searchParams.get('ws');
      if (!wsName) return json({ error: 'missing ws' }, 400);
      let b; try { b = JSON.parse(await readBody(req, 8 * 1024 * 1024)); } catch (_) { return json({ error: 'bad request' }, 400); }
      const buf = Buffer.from(b.dataB64 || '', 'base64');
      if (!buf.length) return json({ error: 'empty file' }, 400);
      const ext = (path.extname(String(b.name || '')).match(/^\.[A-Za-z0-9]{1,8}$/) || ['.bin'])[0];
      const id = crypto.randomUUID();
      const dest = `${UPLOAD_DIR}/${id}${ext}`;
      // write via coder ssh stdin (stdin on the node side is a pipe, not a tty → no remote PTY allocated → binary-safe, no argument-length limit).
      await execFileP('coder', ['ssh', wsName, '--', 'mkdir', '-p', UPLOAD_DIR], { timeout: 20000 });
      await new Promise((resolve, reject) => {
        const c = execFile('coder', ['ssh', wsName, '--', `base64 -d > ${dest}`], { timeout: 60000 }, (e, so, se) => (e ? reject(Object.assign(e, { stderr: se })) : resolve()));
        c.on('error', reject);
        c.stdin.end(buf.toString('base64'));
      });
      return json({ path: dest, name: b.name || `${id}${ext}` });
    }
    if (u.pathname === '/api/attachment' && req.method === 'GET') {
      // read the uploaded attachment bytes back from the target workspace (restricted to UPLOAD_DIR, preventing arbitrary file reads).
      const wsName = u.searchParams.get('ws');
      const p = u.searchParams.get('path') || '';
      if (!wsName || !p.startsWith(UPLOAD_DIR + '/') || p.includes('..')) return json({ error: 'bad path' }, 400);
      const out = await execFileP('coder', ['ssh', wsName, '--', 'base64', p], { maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
      const buf = Buffer.from(out, 'base64');
      res.setHeader('content-type', MIME[path.extname(p).toLowerCase()] || 'application/octet-stream');
      res.setHeader('cache-control', 'private, max-age=3600');
      return res.end(buf);
    }
    if (u.pathname === '/api/files' && req.method === 'GET') {
      // for @-file completion: list files under the workspace $HOME in one shot (relative paths, capped at 2000), filtered client-side.
      // the command is fixed with no user input concatenated → no injection risk. skips large directories like node_modules/.git/.cache.
      const wsName = u.searchParams.get('ws');
      if (!wsName) return json({ error: 'missing ws' }, 400);
      const cmd = "cd \"$HOME\" && find . -maxdepth 5 -type f " +
        "-not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.cache/*' -not -path '*/.switcher-uploads/*' " +
        "2>/dev/null | sed 's#^\\./##' | head -2000";
      let out = '';
      try { out = await execFileP('coder', ['ssh', wsName, '--', cmd], { maxBuffer: 8 * 1024 * 1024, timeout: 25000 }); } catch (_) { out = ''; }
      const files = out.split('\n').map((s) => s.trim()).filter(Boolean);
      return json({ files });
    }
    if (u.pathname === '/api/session/rename' && req.method === 'POST') {
      const wsName = u.searchParams.get('ws');
      let b; try { b = JSON.parse(await readBody(req, 64 * 1024)); } catch (_) { return json({ error: 'bad request' }, 400); }
      const id = /^[0-9a-fA-F-]{8,}$/.test(b.id || '') ? b.id : '';
      if (!wsName || !id) return json({ error: 'bad params' }, 400);
      const nb = Buffer.from(String(b.name || ''), 'utf8').toString('base64'); // name is arbitrary → base64
      const cmd = `mkdir -p ~/.switcher; F=~/.switcher/names.json; [ -f "$F" ] || echo '{}' >"$F"; ` +
        `N=$(printf %s '${nb}' | base64 -d); jq --arg i '${id}' --arg n "$N" '.[$i]=$n' "$F" >"$F.t" && mv "$F.t" "$F"`;
      await execFileP('coder', ['ssh', wsName, '--', cmd], { timeout: 20000 });
      enumCache.delete(wsName); // a rename doesn't change any transcript file, so the signature won't; drop it
      return json({ ok: true });
    }
    if (u.pathname === '/api/session/delete' && req.method === 'POST') {
      const wsName = u.searchParams.get('ws');
      let b; try { b = JSON.parse(await readBody(req, 64 * 1024)); } catch (_) { return json({ error: 'bad request' }, 400); }
      const id = /^[0-9a-fA-F-]{8,}$/.test(b.id || '') ? b.id : '';
      if (!wsName || !id) return json({ error: 'bad params' }, 400);
      const t8 = id.replace(/[^0-9a-fA-F]/g, '').slice(0, 8);
      // SIGKILL the claude in the session's tmux pane BEFORE removing the transcript, else the dying
      // process rewrites the file and the session "comes back". We kill by the pane's process GROUP
      // (pid-based, never by matching the id in a cmdline — that would also match THIS delete command
      // and kill our own shell). SIGKILL means no shutdown-write. The per-session tmux is cl-<id8>
      // (clf-<id8> swept too for legacy). Then rm + drop from names/forks.
      const cmd = `set +e; ID='${id}'; ` +
        `for T in "cl-${t8}" "clf-${t8}"; do ` +
        `PID=$(tmux list-panes -t "$T" -F '#{pane_pid}' 2>/dev/null | head -1); ` +
        `if [ -n "$PID" ]; then PGID=$(ps -o pgid= -p "$PID" 2>/dev/null | tr -d ' '); [ -n "$PGID" ] && kill -9 -"$PGID" 2>/dev/null; fi; ` +
        `tmux kill-session -t "$T" 2>/dev/null; done; ` +
        `sleep 0.3; rm -f ~/.claude/projects/*/"$ID".jsonl 2>/dev/null; ` +
        `NF=~/.switcher/names.json; [ -f "$NF" ] && jq --arg i "$ID" 'del(.[$i])' "$NF" >"$NF.t" 2>/dev/null && mv "$NF.t" "$NF"; ` +
        `FK=~/.switcher/forks.json; [ -f "$FK" ] && jq --arg i "$ID" 'if type==\"object\" then del(.[$i]) else . end' "$FK" >"$FK.t" 2>/dev/null && mv "$FK.t" "$FK"; true`;
      await execFileP('coder', ['ssh', wsName, '--', cmd], { timeout: 20000 });
      enumCache.delete(wsName);
      return json({ ok: true });
    }
    if (u.pathname === '/api/session/markfork' && req.method === 'POST') {
      // Record {forkId: parentId}. Drives dedup (a fork never covers its parent — see SESS_PY) and
      // lets delete resolve relationships. The switcher chooses the fork's id up front (--session-id),
      // so this can be called at fork time — no adopt-guessing.
      const wsName = u.searchParams.get('ws');
      let b; try { b = JSON.parse(await readBody(req, 64 * 1024)); } catch (_) { return json({ error: 'bad request' }, 400); }
      const id = /^[0-9a-fA-F-]{8,}$/.test(b.id || '') ? b.id : '';
      const parent = /^[0-9a-fA-F-]{8,}$/.test(b.parent || '') ? b.parent : '';
      if (!wsName || !id || !parent) return json({ error: 'bad params' }, 400);
      const cmd = `mkdir -p ~/.switcher; F=~/.switcher/forks.json; [ -f "$F" ] || echo '{}' >"$F"; ` +
        `jq --arg i '${id}' --arg p '${parent}' 'if type==\"object\" then . else {} end | .[$i]=$p' "$F" >"$F.t" && mv "$F.t" "$F"`;
      await execFileP('coder', ['ssh', wsName, '--', cmd], { timeout: 20000 });
      enumCache.delete(wsName);
      return json({ ok: true });
    }
    if (u.pathname === '/api/push/key') return json({ key: push.getPublicKey(), enabled: push.isEnabled() });
    if (u.pathname === '/api/push/subscribe' && req.method === 'POST') {
      let b; try { b = JSON.parse(await readBody(req, 64 * 1024)); } catch (_) { return json({ error: 'bad request' }, 400); }
      const ok = push.subscribe(b.ws, b.sub);
      return json({ ok });
    }
    if (u.pathname === '/api/push/unsubscribe' && req.method === 'POST') {
      let b; try { b = JSON.parse(await readBody(req, 64 * 1024)); } catch (_) { return json({ error: 'bad request' }, 400); }
      return json({ ok: push.unsubscribe(b.endpoint) });
    }
    return serveStatic(req, res);
  } catch (e) {
    if (e && e.code === 'NOT_LOGGED_IN') {
      return json({ error: 'not_logged_in', hint: 'run in the workspace terminal: coder login' }, 401);
    }
    json({ error: String(e.message || e) }, 500);
  }
});

const { WebSocketServer } = require('ws');
function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser clients (e.g. smoke scripts) send no Origin
  let hostname;
  try { ({ hostname } = new URL(origin)); } catch (_) { return false; } // unparseable Origin is treated as untrusted
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  let coderHost;
  try { ({ coderHost } = config.getAuth()); } catch (_) { return false; } // can't confirm coderHost when not logged in; reject non-local Origins
  return hostname === coderHost || hostname.endsWith('.' + coderHost);
}
// both WS endpoints use noServer + manual routing (multiple path-based WSS on the same server would fight over upgrade).
const ptyWss = new WebSocketServer({ noServer: true });
const chatWss = new WebSocketServer({ noServer: true });
ptyWss.on('error', (e) => console.error('pty wss error', e.message));
chatWss.on('error', (e) => console.error('chat wss error', e.message));

server.on('upgrade', (req, socket, head) => {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (_) { socket.destroy(); return; }
  if (!isAllowedOrigin(req.headers.origin)) { socket.destroy(); return; }
  if (u.pathname === '/api/pty') ptyWss.handleUpgrade(req, socket, head, (ws) => ptyWss.emit('connection', ws, req));
  else if (u.pathname === '/api/chat') chatWss.handleUpgrade(req, socket, head, (ws) => chatWss.emit('connection', ws, req));
  else socket.destroy();
});

// look up a workspace's agentId by name; on failure close the frontend WS and return null.
async function resolveAgent(fe, name) {
  const list = await client.listWorkspaces();
  const w = list.find((x) => x.name === name);
  if (!w || !w.agentId) { fe.close(1011, 'no agent'); return null; }
  return w.agentId;
}

// /api/pty: terminal attaches to the claude tmux session (both the desktop terminal and mobile chat input go through this).
// Self-contained per-session claude launcher (env-driven, base64'd through the PTY like SESS_PY).
// Works on any workspace without relying on its own .start-claude.sh. Only used for opening a
// SPECIFIC session / create / fork; the default (main) click keeps using config.claudeCmd.
const LAUNCH_SH = fs.readFileSync(path.join(__dirname, 'remote/launch.sh'), 'utf8'); // self-contained per-session claude launcher (env-driven)
const LAUNCH_B64 = Buffer.from(LAUNCH_SH, 'utf8').toString('base64');

/** Build the PTY tmux command. `session` is the session's OWN id; the tmux is always cl-<id8>, so
 *  reopening attaches the same claude (new-session -A). mode: 'open' (default) → --resume <id>;
 *  'new' → --session-id <id> (fresh, our chosen id); 'fork' → --resume <resume> --fork-session
 *  --session-id <id>. No session/cwd → the workspace's own launcher (main, unchanged). */
function ptyCommand({ session, cwd, mode, resume, nameB64 }) {
  const sid = /^[0-9a-fA-F-]{8,}$/.test(session || '') ? session : '';
  if (!sid && !cwd) return config.claudeCmd; // main / default click — untouched
  const safeCwd = /^\/[A-Za-z0-9._/-]+$/.test(cwd || '') ? cwd : '';       // validated abs path
  const sid8 = sid.replace(/[^0-9a-fA-F]/g, '').slice(0, 8);
  const parent = /^[0-9a-fA-F-]{8,}$/.test(resume || '') ? resume : '';
  const tmux = sid ? ('cl-' + sid8) : (safeCwd ? 'cln-' + safeCwd.replace(/[^A-Za-z0-9]/g, '').slice(-14) : 'claude');
  const nb = /^[A-Za-z0-9+/=]+$/.test(nameB64 || '') ? nameB64 : '';       // base64 charset only
  const exportsBlk = [
    safeCwd && `export SC_CWD='${safeCwd}'`,
    mode === 'fork' && parent && `export SC_RESUME='${parent}'`,           // fork resumes the parent
    mode === 'fork' && 'export SC_FORK=1',
    (mode === 'new' || mode === 'fork') && sid && `export SC_SID='${sid}'`, // create/fork under our chosen id
    !(mode === 'new' || mode === 'fork') && sid && `export SC_RESUME='${sid}'`, // open → resume itself
    nb && `export SC_NAME_B64='${nb}'`,
  ].filter(Boolean).join('\n');
  const b64 = Buffer.from(exportsBlk + '\n' + LAUNCH_SH, 'utf8').toString('base64');
  return `tmux new-session -A -s ${tmux} bash -lc "printf %s '${b64}' | base64 -d | bash" \\; set -t ${tmux} status off`;
}

ptyWss.on('connection', async (fe, req) => {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (e) { fe.close(1008); return; }
  const name = u.searchParams.get('ws');
  const width = parseInt(u.searchParams.get('width'), 10) || 100;
  const height = parseInt(u.searchParams.get('height'), 10) || 30;
  const session = u.searchParams.get('session');
  const cwd = u.searchParams.get('cwd');
  const mode = u.searchParams.get('mode');    // 'new' | 'fork' | (default) 'open'
  const resume = u.searchParams.get('resume'); // fork: the parent id to resume from
  const nameB64 = u.searchParams.get('name'); // base64 display name (create/fork)

  let pty = null;
  let feClosed = false;
  const closePty = () => { try { pty && pty.close(); } catch (_) {} };
  fe.on('error', closePty);
  fe.on('close', () => { feClosed = true; closePty(); });

  try {
    const agentId = await resolveAgent(fe, name);
    if (!agentId || feClosed) return;
    maybeReap(name);
    pty = client.openPty({ agentId, width, height, command: ptyCommand({ session, cwd, mode, resume, nameB64 }) });
    pty.onError(() => { try { fe.close(1011); } catch (_) {} });
    pty.onData((s) => { if (fe.readyState === fe.OPEN) fe.send(s); });     // Coder → frontend (text)
    pty.onClose(() => fe.close());
    fe.on('message', (m) => { try { pty.send(JSON.parse(m.toString('utf8'))); } catch (e) { console.error('bad pty msg', e.message); } }); // frontend → Coder (JSON)
  } catch (e) {
    if (e && e.code === 'NOT_LOGGED_IN') { fe.close(4001, 'not_logged_in'); return; }
    fe.close(1011, String(e.message || e));
  }
});

// Remote Python: enumerate sessions under ~/.claude/projects (take the title, dedup by subset of assistant message.id),
// print a single ##SESSIONS##<json> line, then exec tail -F on the selected session file (given by env SESSION, otherwise the latest).
// Subset dedup: resume opens a new file and replays old messages; drop files whose id set is a subset of another's, fixing "picked the wrong session" for good.
const SESS_PY = fs.readFileSync(path.join(__dirname, 'remote/sess.py'), 'utf8'); // remote session enumerator (see src/remote/sess.py + test_sess.py)
const SESS_PY_B64 = Buffer.from(SESS_PY, 'utf8').toString('base64');
// Write SESS_PY to a file on the target via `coder ssh` (arg, not PTY stdin — no MAX_CANON
// 4096-byte line limit). The PTY then just runs the short `python3 ~/.switcher/sess.py`.
// (Piping the whole base64 as one PTY line truncated it once SESS_PY grew past ~4KB.)
async function ensureSessPy(ws) {
  await execFileP('coder', ['ssh', ws, '--', `mkdir -p ~/.switcher && printf %s '${SESS_PY_B64}' | base64 -d > ~/.switcher/sess.py`], { timeout: 20000 });
}

// Opportunistic idle-reaper: kill per-session tmuxes (cl-/clf-/cln-) that have no client attached
// and have been idle > 3h, on any workspace the switcher touches. Throttled to once / 30 min per ws,
// fire-and-forget so it never slows a request. The main "claude" session is never touched.
const reapAt = new Map();    // ws -> last-reap epoch ms
const enumCache = new Map(); // ws -> {sig, listing} — /api/sessions cache, keyed by a cheap file signature
function maybeReap(ws) {
  if (!ws) return;
  const now = Date.now();
  if (now - (reapAt.get(ws) || 0) < 30 * 60 * 1000) return;
  reapAt.set(ws, now);
  const cmd = `now=$(date +%s); tmux ls -F '#{session_name} #{session_attached} #{session_activity}' 2>/dev/null | ` +
    `while read n a act; do case "$n" in cl-*|clf-*|cln-*) [ "$a" = 0 ] && [ $((now-act)) -gt 10800 ] && tmux kill-session -t "$n" 2>/dev/null;; esac; done; true`;
  execFileP('coder', ['ssh', ws, '--', cmd], { timeout: 20000 }).catch(() => {});
}
// session id allows only hex digits and hyphens; validate before interpolating into env, to prevent injection.
function chatCommand(sessionId, fresh) {
  const s = /^[0-9a-fA-F-]{8,}$/.test(sessionId || '') ? sessionId : '';
  const f = fresh ? '1' : '';
  return `SESSION='${s}' FRESH='${f}' python3 ~/.switcher/sess.py`;
}

// /api/chat: tail the target workspace's claude transcript, parse it line by line into bubble events, and forward them to the frontend.
// How many active chat windows (/api/chat connections) each workspace currently has.
// >0 means "you have this ws's chat open" → the background watcher stops sending Web Push (leaving it to the frontend's local notification, to avoid duplicates / interrupting while you're watching).
const liveChats = new Map();
const chatInc = (ws) => { if (ws) liveChats.set(ws, (liveChats.get(ws) || 0) + 1); };
const chatDec = (ws) => { if (!ws) return; const n = (liveChats.get(ws) || 0) - 1; if (n > 0) liveChats.set(ws, n); else liveChats.delete(ws); };

chatWss.on('connection', async (fe, req) => {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (e) { fe.close(1008); return; }
  const name = u.searchParams.get('ws');
  const session = u.searchParams.get('session');
  const fresh = u.searchParams.get('fresh');

  let pty = null;
  let feClosed = false;
  let buf = '';
  const closePty = () => { try { pty && pty.close(); } catch (_) {} };
  chatInc(name);
  fe.on('error', closePty);
  fe.on('close', () => { feClosed = true; chatDec(name); closePty(); });

  try {
    const agentId = await resolveAgent(fe, name);
    if (!agentId || feClosed) return;
    try { await ensureSessPy(name); } catch (_) {} // write the enumerator file (best-effort)
    if (feClosed) return;
    pty = client.openPty({ agentId, width: 200, height: 50, command: chatCommand(session, fresh) });
    pty.onError(() => { try { fe.close(1011); } catch (_) {} });
    pty.onClose(() => fe.close());
    const send = (obj) => { if (fe.readyState === fe.OPEN) fe.send(JSON.stringify(obj)); };
    pty.onData((s) => {
      buf += s;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '').trim();
        buf = buf.slice(i + 1);
        // use indexOf rather than startsWith: the command line echoed by the interactive shell may have no trailing newline,
        // which can glue ##SESSIONS## to the start of the same line, so search for the marker within the whole line.
        const sm = line.indexOf('##SESSIONS##');
        if (sm >= 0) {
          try { send({ kind: 'sessions', list: JSON.parse(line.slice(sm + 12)) }); } catch (_) {}
          continue;
        }
        if (line.indexOf('##NO_TRANSCRIPT##') >= 0) { send({ kind: 'sessions', list: [] }); continue; }
        if (!line || line[0] !== '{') continue;           // skip shell echoes/prompts/non-JSON
        let rec;
        try { rec = JSON.parse(line); } catch (_) { continue; }
        for (const ev of parseRecord(rec)) send(ev);
      }
    });
  } catch (e) {
    if (e && e.code === 'NOT_LOGGED_IN') { fe.close(4001, 'not_logged_in'); return; }
    fe.close(1011, String(e.message || e));
  }
});

// ---------- Web Push background watcher ----------
// For each workspace "with subscriptions", start a transcript tail; when a turn is detected as complete (silence for a while after an assistant message),
// push to that ws's subscriptions. Only this mechanism can wake up when the app is fully closed (foreground local notifications go through chat.js).
const WARM_MS = 4000;   // the replay burst right after connecting: during this window only record state, don't push
const DONE_MS = 7000;   // how long of silence after the last event counts as "turn complete"
const watchers = new Map(); // ws -> { pty, doneTimer, det, stopped }

async function agentIdOf(name) {
  const list = await client.listWorkspaces();
  const w = list.find((x) => x.name === name);
  return w && w.agentId ? w.agentId : null;
}

function stopWatcher(ws) {
  const w = watchers.get(ws);
  if (!w) return;
  w.stopped = true; clearTimeout(w.doneTimer);
  try { w.pty && w.pty.close(); } catch (_) {}
  watchers.delete(ws);
}

async function startWatcher(ws) {
  if (watchers.has(ws)) return;
  const w = { pty: null, doneTimer: null, det: makeTurnDetector(), stopped: false };
  watchers.set(ws, w);
  let agentId;
  try { agentId = await agentIdOf(ws); } catch (_) { agentId = null; }
  if (w.stopped) return;
  if (!agentId) { watchers.delete(ws); return; } // ws may have stopped; retry on the next resync
  let buf = '';
  const fireDone = () => {
    const p = w.det.fire();
    if (!p) return;
    if ((liveChats.get(ws) || 0) > 0) return; // you have this ws's chat window open → no push (the frontend local notification handles it)
    push.notify(ws, { title: 'Claude · ' + (p.title || ws), body: p.text || 'Turn complete', tag: 'turn-' + ws, url: '/?ws=' + encodeURIComponent(ws) });
  };
  try {
    try { await ensureSessPy(ws); } catch (_) {} // write the enumerator file before tailing
    if (w.stopped) return;
    w.pty = client.openPty({ agentId, width: 200, height: 50, command: chatCommand(null, false) });
    w.pty.onError(() => {});
    w.pty.onClose(() => { if (!w.stopped) { watchers.delete(ws); } }); // resync will restart it
    setTimeout(() => { w.det.warmUp(); }, WARM_MS);
    w.pty.onData((s) => {
      buf += s; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '').trim();
        buf = buf.slice(i + 1);
        if (!line || line[0] !== '{') continue;
        let rec; try { rec = JSON.parse(line); } catch (_) { continue; }
        for (const ev of parseRecord(rec)) {
          if (w.det.feed(ev)) { clearTimeout(w.doneTimer); w.doneTimer = setTimeout(fireDone, DONE_MS); }
        }
      }
    });
  } catch (_) { watchers.delete(ws); }
}

function syncWatchers() {
  if (!push.isEnabled()) return;
  const want = new Set(push.wsWithSubs());
  for (const ws of watchers.keys()) if (!want.has(ws)) stopWatcher(ws);
  for (const ws of want) if (!watchers.has(ws)) startWatcher(ws);
}
push.onSubsChange(syncWatchers);
if (push.isEnabled()) { syncWatchers(); setInterval(syncWatchers, 60000); } // fallback: rebuild after restart/disconnect

server.listen(config.port, () => console.log(`switcher on :${config.port}`));
module.exports = { server };
