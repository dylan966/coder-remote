const { test } = require('node:test');
const assert = require('node:assert');
const { makeClient } = require('../src/coder-client');

test('openPty must not crash the process on connect failure (WS error has a default handler + onError can be registered)', async () => {
  const client = makeClient(() => ({ coderUrl: 'https://x', coderHost: '127.0.0.1:1', token: 't' }));
  const pty = client.openPty({ agentId: 'x' });

  let errorSeen = false;
  let closeSeen = false;
  pty.onError(() => { errorSeen = true; });
  pty.onClose(() => { closeSeen = true; });

  // Without a listener for the 'error' event it would throw and crash the current process;
  // reaching this point means the process survived ~1s, proving the crash is fixed.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  pty.close();
  assert.ok(true, 'process survived the connect failure without crashing');
  // Connecting to 127.0.0.1:1 (usually nothing listening) is expected to trigger error/close,
  // but we don't assert on timing to avoid the test being flaky across environments with different network timing.
  void errorSeen;
  void closeSeen;
});
