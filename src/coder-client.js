const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const WebSocket = require('ws');
const { buildPtyUrl, encodeMsg } = require('./protocol');

/**
 * Create a Coder client: wraps REST (workspaces/build) + PTY WebSocket connections.
 * `getAuth` is re-invoked on every api()/openPty() call (not cached),
 * so the session token written by `coder login` is usable immediately after login, without restarting the process.
 */
function makeClient(getAuth) {
  async function api(path, opts = {}) {
    const { coderUrl, token } = getAuth();
    const res = await fetch(`${coderUrl}${path}`, {
      ...opts,
      headers: { 'Coder-Session-Token': token, 'content-type': 'application/json', ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error(`coder ${path} -> ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  // IDE/terminal apps to omit from the quick-links (we only surface service links).
  const SKIP_APP_SLUGS = new Set([
    'code-server', 'cursor', 'vscode', 'vscode-desktop', 'jetbrains', 'jetbrains-gateway',
    'zed', 'claude', 'claude-code', 'switcher', 'control', 'web-terminal',
  ]);

  /** List all workspaces of the current user (owner:me), each with its agentId (the first agent)
   *  and its service quick-links (apps: [{name, url}]). */
  async function listWorkspaces() {
    const { coderHost } = getAuth();
    const d = await api('/api/v2/workspaces?q=owner:me');
    return (d.workspaces || []).map((w) => {
      let agentId = null;
      const apps = [];
      const wsl = (w.name || '').toLowerCase();
      const owner = (w.owner_name || '').toLowerCase();
      for (const r of (w.latest_build?.resources || []))
        for (const a of (r.agents || [])) {
          agentId = agentId || a.id;
          for (const app of (a.apps || [])) {
            if (app.hidden || app.command || SKIP_APP_SLUGS.has(app.slug)) continue; // hidden / terminal-launch / IDE
            let url = null;
            if (app.subdomain) url = `https://${app.slug}--${wsl}--${owner}.${coderHost}`;   // wildcard subdomain app
            else if (app.external && /^https?:\/\//.test(app.url || '')) url = app.url;       // plain external http link
            if (!url) continue; // skip path-based / non-http (rare for service links)
            apps.push({ name: app.display_name || app.slug, url });
          }
        }
      return { name: w.name, status: w.latest_build?.status || 'unknown', agentId, apps };
    });
  }

  /** Find a workspace by name and trigger a start build. */
  async function startWorkspace(name) {
    const d = await api('/api/v2/workspaces?q=owner:me');
    const w = (d.workspaces || []).find((x) => x.name === name);
    if (!w) throw new Error(`no workspace ${name}`);
    await api(`/api/v2/workspaces/${w.id}/builds`, {
      method: 'POST', body: JSON.stringify({ transition: 'start' }),
    });
  }

  /** Open a PTY WebSocket connection (with an auto reconnect id); returns a handle to send/listen/close. */
  function openPty({ agentId, width = 100, height = 30, command }) {
    const { coderHost, token } = getAuth();
    const reconnect = crypto.randomUUID();
    const url = buildPtyUrl({ coderHost, agentId, reconnect, width, height });
    const sock = new WebSocket(url, { headers: { 'Coder-Session-Token': token } });
    const send = (obj) => { if (sock.readyState === WebSocket.OPEN) sock.send(encodeMsg(obj)); };
    // Always attach a default error listener so that, if the consumer hasn't registered onError,
    // an unhandled 'error' event doesn't throw and crash the whole process.
    sock.on('error', (err) => { console.error('[coder-client] PTY socket error:', err.message); });
    sock.on('open', () => {
      send({ height, width });
      if (command) send({ data: command + '\r' });
    });
    return {
      sock,
      send,
      // StringDecoder buffers incomplete multi-byte sequences across frames (otherwise multi-byte chars landing on a frame boundary get garbled),
      onData: (cb) => { const dec = new StringDecoder('utf8'); sock.on('message', (m) => cb(dec.write(Buffer.isBuffer(m) ? m : Buffer.from(m)))); },
      onClose: (cb) => sock.on('close', cb),
      close: () => sock.close(),
      onError: (cb) => sock.on('error', cb),
    };
  }

  return { listWorkspaces, startWorkspace, openPty };
}
module.exports = { makeClient };
