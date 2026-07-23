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

  /** List all workspaces of the current user (owner:me), each with its agentId (the first agent). */
  async function listWorkspaces() {
    const d = await api('/api/v2/workspaces?q=owner:me');
    return (d.workspaces || []).map((w) => {
      let agentId = null;
      for (const r of (w.latest_build?.resources || []))
        for (const a of (r.agents || [])) { agentId = agentId || a.id; }
      return { name: w.name, status: w.latest_build?.status || 'unknown', agentId };
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
