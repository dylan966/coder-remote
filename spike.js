#!/usr/bin/env node
// Spike: verify that the backend (Node) can connect to Coder's reconnecting-PTY websocket, authenticate, and send/receive.
// Usage: CODER_URL=... TOKEN=... AGENT=... node spike.js
const WebSocket = require('ws');
const crypto = require('crypto');

const BASE = (process.env.CODER_URL || 'https://coder.gmaster888.com').replace(/^http/, 'ws');
const TOKEN = process.env.TOKEN;
const AGENT = process.env.AGENT;
if (!TOKEN || !AGENT) { console.error('need TOKEN and AGENT env'); process.exit(2); }

const reconnect = crypto.randomUUID();
const url = `${BASE}/api/v2/workspaceagents/${AGENT}/pty?reconnect=${reconnect}&width=100&height=30`;
console.log('[spike] connecting:', url.replace(TOKEN, '***'));

const ws = new WebSocket(url, { headers: { 'Coder-Session-Token': TOKEN } });
let got = '';
let sawMarker = false;

// Coder reconnecting-pty protocol (empirically): client→server = JSON {data?,height?,width?} sent as [binary] frames.
const sendMsg = (obj) => ws.send(Buffer.from(JSON.stringify(obj)));
ws.on('open', () => {
  console.log('[spike] OPEN ✓ (websocket connected and authenticated)');
  sendMsg({ height: 30, width: 100 });
  setTimeout(() => { console.log('[spike] sending binary JSON input'); sendMsg({ data: 'echo SPIKE_MARKER_9271\r' }); }, 1200);
});
ws.on('message', (m) => {
  const s = m.toString('utf8');
  got += s;
  if (got.includes('SPIKE_MARKER_9271') && got.match(/SPIKE_MARKER_9271[\s\S]*SPIKE_MARKER_9271|9271\r?\n/)) {
    if (!sawMarker) { sawMarker = true; console.log('[spike] received command echo ✓ bidirectional channel established'); }
  }
});
ws.on('unexpected-response', (req, res) => {
  console.error('[spike] HTTP', res.statusCode, '(auth/endpoint problem)');
  let b = ''; res.on('data', d => b += d); res.on('end', () => { console.error('[spike] body:', b.slice(0, 300)); process.exit(1); });
});
ws.on('error', (e) => { console.error('[spike] ERROR', e.message); process.exit(1); });

setTimeout(() => {
  console.log('---- full output preview (up to 1500) ----');
  console.log(JSON.stringify(got.slice(0, 1500)));
  console.log('----');
  console.log(sawMarker ? '✅ SPIKE PASS: connect + auth + command echo all work' : (got ? '⚠️ connected with output, but marker echo not confirmed (possibly message format/command not executed; check the preview and adjust)' : '❌ connected but received no output'));
  ws.close(); process.exit(sawMarker ? 0 : 3);
}, 6000);
