const { loadConfig } = require('../src/config');
const { makeClient } = require('../src/coder-client');
(async () => {
  const c = makeClient(loadConfig().getAuth);
  const list = await c.listWorkspaces();
  console.log('workspaces:', list.map((w) => `${w.name}(${w.status})`).join(', '));
  const running = list.find((w) => w.status === 'running' && w.agentId);
  if (!running) { console.log('no running workspace, skipping PTY smoke test'); process.exit(0); }
  const pty = c.openPty({ agentId: running.agentId, command: 'echo SMOKE_OK_4823' });
  let got = '';
  pty.onData((s) => { got += s; if (got.includes('SMOKE_OK_4823')) { console.log('✅ PTY smoke test passed (', running.name, ')'); pty.close(); process.exit(0); } });
  setTimeout(() => { console.error('❌ no echo within 6s'); process.exit(1); }, 6000);
})().catch((e) => { console.error(e); process.exit(1); });
