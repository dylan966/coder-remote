const { test } = require('node:test');
const assert = require('node:assert');
const { buildPtyUrl, encodeMsg } = require('../src/protocol');

test('buildPtyUrl builds the correct wss endpoint', () => {
  const u = buildPtyUrl({ coderHost: 'coder.x.com', agentId: 'AID', reconnect: 'RID', width: 100, height: 30 });
  assert.equal(u, 'wss://coder.x.com/api/v2/workspaceagents/AID/pty?reconnect=RID&width=100&height=30');
});

test('encodeMsg returns binary JSON', () => {
  const b = encodeMsg({ data: 'Y' });
  assert.ok(Buffer.isBuffer(b));
  assert.equal(b.toString('utf8'), '{"data":"Y"}');
});
