const fs = require('fs');
const os = require('os');

/** Read and trim a file that may not exist; returns null if missing or unreadable. */
function readTrimmed(file) {
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    return s || null;
  } catch (_) {
    return null;
  }
}

/**
 * Load runtime config. No longer requires CODER_TOKEN/CODER_URL at startup —
 * auth is resolved lazily via the returned getAuth(), re-read on every call,
 * so `coder login` takes effect without restarting the service.
 */
function loadConfig(env = process.env) {
  const port = parseInt(env.PORT, 10) || 8080;
  // On attach, turn off the tmux bottom status bar for the claude session so the terminal reads more like a dark code card in the Claude App.
  const claudeCmd = env.CLAUDE_CMD || 'tmux new-session -A -s claude /home/coder/.start-claude.sh \\; set -t claude status off';

  /** Re-resolve auth on every call (no caching); env takes precedence, then the files written by `coder login`. */
  function getAuth() {
    const coderConfigDir = env.CODERV2_CONFIG_DIR || (os.homedir() + '/.config/coderv2');
    const token = env.CODER_TOKEN || readTrimmed(`${coderConfigDir}/session`);
    const url = env.CODER_URL || readTrimmed(`${coderConfigDir}/url`);
    if (!token || !url) {
      throw Object.assign(new Error('not logged in to Coder — run `coder login` in the workspace terminal'), {
        code: 'NOT_LOGGED_IN',
      });
    }
    return {
      coderUrl: url.replace(/\/$/, ''),
      coderHost: new URL(url).host,
      token,
    };
  }

  return { port, claudeCmd, getAuth };
}
module.exports = { loadConfig };
