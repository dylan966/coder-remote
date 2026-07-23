// smoke/end2end.smoke.js
const WebSocket = require('ws');
(async () => {
  const list = await (await fetch('http://localhost:8080/api/workspaces')).json();
  const w = (list.workspaces || []).find((x) => x.status === 'running' && x.agentId);
  if (!w) { console.log('no running workspace, skipping'); process.exit(0); }
  const fe = new WebSocket(`ws://localhost:8080/api/pty?ws=${encodeURIComponent(w.name)}`);
  let got = '';
  fe.on('open', () => setTimeout(() => fe.send(JSON.stringify({ data: 'echo SMOKE_END2END_771\r' })), 1500));
  fe.on('message', (m) => { got += m.toString(); if (got.includes('SMOKE_END2END_771')) { console.log('✅ end-to-end PTY bridge passed (', w.name, ')'); process.exit(0); } });
  setTimeout(() => { console.error('❌ no echo seen'); process.exit(1); }, 8000);
})().catch((e) => { console.error(e); process.exit(1); });
