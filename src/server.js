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
ptyWss.on('connection', async (fe, req) => {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (e) { fe.close(1008); return; }
  const name = u.searchParams.get('ws');
  const width = parseInt(u.searchParams.get('width'), 10) || 100;
  const height = parseInt(u.searchParams.get('height'), 10) || 30;

  let pty = null;
  let feClosed = false;
  const closePty = () => { try { pty && pty.close(); } catch (_) {} };
  fe.on('error', closePty);
  fe.on('close', () => { feClosed = true; closePty(); });

  try {
    const agentId = await resolveAgent(fe, name);
    if (!agentId || feClosed) return;
    pty = client.openPty({ agentId, width, height, command: config.claudeCmd });
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
const SESS_PY = `
import json, os, glob, sys
base = os.path.expanduser('~/.claude/projects')
want = os.environ.get('SESSION', '').strip()
out = []
for f in glob.glob(base + '/*/*.jsonl'):
    if os.sep + 'subagents' + os.sep in f: continue
    ai = cust = lp = cwd = None; ids = set(); n = 0
    try:
        with open(f, encoding='utf-8', errors='replace') as fh:
            for line in fh:
                line = line.strip()
                if not line or line[0] != '{': continue
                try: o = json.loads(line)
                except Exception: continue
                t = o.get('type')
                if t == 'ai-title': ai = o.get('aiTitle') or ai
                elif t == 'custom-title': cust = o.get('customTitle') or cust
                elif t == 'last-prompt': lp = o.get('lastPrompt') or lp
                elif t == 'user' or t == 'assistant':
                    n += 1
                    if o.get('cwd'): cwd = o.get('cwd')   # claude records the cwd on each turn → project
                    if t == 'assistant':
                        mid = (o.get('message') or {}).get('id')
                        if mid: ids.add(mid)
    except Exception: continue
    if n == 0: continue
    title = cust or ai or lp or '(untitled)'
    if len(title) > 60: title = title[:57] + '...'
    out.append({'id': os.path.basename(f)[:-6], 'title': title, 'n': n, 'mtime': os.path.getmtime(f), 'cwd': cwd or '', '_ids': sorted(ids), '_f': f})
out.sort(key=lambda s: len(s['_ids']))
keep = []
for i, s in enumerate(out):
    si = set(s['_ids']); covered = False
    if si:
        for j in range(i + 1, len(out)):
            if si.issubset(set(out[j]['_ids'])): covered = True; break
    if not covered: keep.append(s)
keep.sort(key=lambda s: s['mtime'], reverse=True)
files = {s['id']: s['_f'] for s in keep}
# switcher-side display-name overrides (claude has no post-hoc rename CLI)
names = {}
try:
    with open(os.path.expanduser('~/.switcher/names.json')) as nf: names = json.load(nf)
except Exception: names = {}
home = os.path.expanduser('~')
# main = newest session whose cwd == $HOME (the default click-in), else newest overall; can't be deleted.
home_sess = [s for s in keep if s.get('cwd') == home]
pool = home_sess if home_sess else keep
main_id = max(pool, key=lambda s: s['mtime'])['id'] if pool else None
def _proj(c):
    if not c: return '(unknown)'
    if c == home: return '~'
    return os.path.basename(c.rstrip('/')) or c
listing = [{'id': s['id'], 'title': names.get(s['id']) or s['title'], 'n': s['n'], 'mtime': int(s['mtime']),
            'cwd': s.get('cwd', ''), 'project': _proj(s.get('cwd', '')), 'main': s['id'] == main_id} for s in keep]
print('##SESSIONS##' + json.dumps(listing, ensure_ascii=False)); sys.stdout.flush()
target = files.get(want) if want else None
if os.environ.get('FRESH'):  # new session: follow the "latest" file (even if it has no messages yet)
    allf = [g for g in glob.glob(base + '/*/*.jsonl') if os.sep + 'subagents' + os.sep not in g]
    if allf: target = max(allf, key=os.path.getmtime)
if not target and keep: target = keep[0]['_f']
if not target:
    print('##NO_TRANSCRIPT##'); sys.stdout.flush(); sys.exit(0)
sys.stdout.flush()
os.execvp('tail', ['tail', '-n', '1500', '-F', target])  # only pull the last 1500 lines, so very long sessions aren't too heavy to start
`;
const SESS_PY_B64 = Buffer.from(SESS_PY, 'utf8').toString('base64');
// session id allows only hex digits and hyphens; validate before interpolating into env, to prevent injection.
function chatCommand(sessionId, fresh) {
  const s = /^[0-9a-fA-F-]{8,}$/.test(sessionId || '') ? sessionId : '';
  const f = fresh ? '1' : '';
  return `printf %s '${SESS_PY_B64}' | base64 -d | SESSION='${s}' FRESH='${f}' python3`;
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
