const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config');

const tmpDirs = [];
function mkTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-switcher-config-test-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

test('loadConfig resolves default port/claudeCmd and does not require login', () => {
  const c = loadConfig({});
  assert.equal(c.port, 8080);
  assert.equal(c.claudeCmd, 'tmux new-session -A -s claude /home/coder/.start-claude.sh \\; set -t claude status off');
  assert.equal(typeof c.getAuth, 'function');
});

test('loadConfig: env CLAUDE_CMD overrides the default claudeCmd', () => {
  const c = loadConfig({ CLAUDE_CMD: 'echo custom' });
  assert.equal(c.claudeCmd, 'echo custom');
});

test('getAuth: env CODER_URL/CODER_TOKEN take precedence', () => {
  const c = loadConfig({ CODER_URL: 'https://x.com', CODER_TOKEN: 't' });
  assert.deepEqual(c.getAuth(), { coderUrl: 'https://x.com', coderHost: 'x.com', token: 't' });
});

test('getAuth: without env, reads session/url files under CODERV2_CONFIG_DIR', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, 'session'), '  abc123token  \n');
  fs.writeFileSync(path.join(dir, 'url'), 'https://coder.example.com/\n');
  const c = loadConfig({ CODERV2_CONFIG_DIR: dir });
  assert.deepEqual(c.getAuth(), {
    coderUrl: 'https://coder.example.com',
    coderHost: 'coder.example.com',
    token: 'abc123token',
  });
});

test('getAuth: not logged in (files missing) throws NOT_LOGGED_IN', () => {
  const dir = mkTmpDir();
  const c = loadConfig({ CODERV2_CONFIG_DIR: dir });
  assert.throws(() => c.getAuth(), (e) => e.code === 'NOT_LOGGED_IN');
});

test('loadConfig({}) itself does not throw (service must start even when not logged in)', () => {
  assert.doesNotThrow(() => loadConfig({}));
});
