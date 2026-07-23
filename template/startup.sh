#!/usr/bin/env bash
# Agent startup script for the coder-remote hub (runs on every start, idempotent).
# clone/pull this repo (app lives at repo root) -> npm install deps -> coder login
# (using the injected token) -> start the service via tmux.
#
# Env vars it depends on (injected by main.tf's agent env / coder secret):
#   CODER_URL      the workspace's access_url (injected by main.tf)
#   SWITCHER_TOKEN user API token -- one-time: coder secret create switcher-token --env SWITCHER_TOKEN
#                  (CODER_* env names are reserved by Coder, so the secret uses SWITCHER_TOKEN)
#   SWITCHER_REPO  (optional) override the default git source (public repo, HTTPS clone needs no auth)
set -uo pipefail
log() { echo "[startup] $*"; }
cd /home/coder

REPO="${SWITCHER_REPO:-https://github.com/dylan966/coder-remote.git}"
APP=/home/coder/coder-remote

# ---- 1. Fetch the code (clone on first run, fast-forward pull after; skip if local changes) ----
if [ -d "${APP}/.git" ]; then
    log "pull ${APP}"
    git -C "${APP}" pull --ff-only 2>/dev/null || log "WARN: pull skipped (local changes?)"
else
    log "clone ${REPO} -> ${APP}"
    git clone "${REPO}" "${APP}" || { log "ERROR: clone failed"; exit 0; }
fi
cd "${APP}"

# ---- 2. Install deps (npm ci when a lockfile exists, otherwise fall back to npm install) ----
if [ -f package-lock.json ]; then
    npm ci --no-audit --no-fund >/tmp/switcher-npm.log 2>&1 || npm install --no-audit --no-fund >>/tmp/switcher-npm.log 2>&1
else
    npm install --no-audit --no-fund >/tmp/switcher-npm.log 2>&1
fi
log "npm deps ready (log: /tmp/switcher-npm.log)"

# ---- 3. coder CLI login ----
# Log in with the injected SWITCHER_TOKEN, writing the coder session file. We deliberately
# do NOT export CODER_TOKEN: the switcher config (config.js) reads the session file, so the
# daily token-refresh's `coder login` keeps the running server on a fresh token with no
# restart. (config.js prefers env.CODER_TOKEN if set — leaving it unset is what enables this.)
# The `coder ssh` the switcher shells out to also uses this same login session.
TOKEN="${SWITCHER_TOKEN:-${CODER_TOKEN:-}}"
if [ -n "${CODER_URL:-}" ] && [ -n "${TOKEN}" ]; then
    coder login "${CODER_URL}" --token "${TOKEN}" >/dev/null 2>&1 \
        && log "coder CLI logged in to ${CODER_URL}" \
        || log "WARN: coder login failed (token unset/expired? run coder secret create switcher-token --env SWITCHER_TOKEN)"
else
    log "WARN: missing CODER_URL / token -- switcher can't call Coder, set the switcher-token secret then restart"
fi
unset TOKEN

# ---- 3b. claude workspace (this hub also serves ?ws=coder-remote as a claude session) ----
# The switcher's PTY command (config.claudeCmd) attaches `tmux new-session -A -s claude
# /home/coder/.start-claude.sh`, so provide that launcher: it runs claude in bypass mode
# under /home/coder/projects/init. Auth comes from the claude-token secret
# (CLAUDE_CODE_OAUTH_TOKEN), injected automatically since this is the owner's workspace.
mkdir -p /home/coder/projects/init
cat >/home/coder/.start-claude.sh <<'EOSH'
#!/usr/bin/env bash
cd /home/coder/projects/init
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
# Pre-trust the folder + skip the dangerous-mode prompt so unattended launch doesn't hang.
CJ="$HOME/.claude.json"; [ -f "$CJ" ] || echo '{}' >"$CJ"
# hasCompletedOnboarding skips the global first-run wizard (theme picker etc.);
# the project block pre-trusts the folder. Both are needed for an unattended launch.
jq '.hasCompletedOnboarding = true | .projects["/home/coder/projects/init"] = ((.projects["/home/coder/projects/init"] // {}) + {hasTrustDialogAccepted:true, hasCompletedProjectOnboarding:true})' "$CJ" >"$CJ.tmp" 2>/dev/null && mv "$CJ.tmp" "$CJ"
mkdir -p "$HOME/.claude"; SJ="$HOME/.claude/settings.json"; [ -f "$SJ" ] || echo '{}' >"$SJ"
jq '. + {skipDangerousModePermissionPrompt:true, theme:"dark"}' "$SJ" >"$SJ.tmp" 2>/dev/null && mv "$SJ.tmp" "$SJ"
for _i in $(seq 1 30); do command -v claude >/dev/null 2>&1 && break; sleep 1; done
# Resume the latest conversation if any, else start fresh. Always bypass permissions.
if compgen -G "$HOME/.claude/projects/-home-coder-projects-init/*.jsonl" >/dev/null 2>&1; then
  exec claude --dangerously-skip-permissions --continue
else
  exec claude --dangerously-skip-permissions
fi
EOSH
chmod +x /home/coder/.start-claude.sh
log "wrote /home/coder/.start-claude.sh (claude bypass @ /home/coder/projects/init)"

# ---- 4. Start the service (tmux, idempotent: skip if :8080 already in use) ----
if ss -tln 2>/dev/null | grep -q ':8080'; then
    log "switcher already on :8080, skipping start"
else
    tmux kill-session -t switcher 2>/dev/null || true
    tmux new-session -d -s switcher "cd ${APP} && PORT=8080 node src/server.js >/tmp/switcher.log 2>&1"
    log "switcher started on :8080 (log: /tmp/switcher.log)"
fi

cat <<'EOF'

==============================================================================
  coder-remote hub ready.

  Open the "Workspace Switcher" app (top right, subdomain HTTPS) to view/switch
  all workspaces and enter each one's claude session from mobile or desktop.

  One-time setup (run once in your local terminal, injected into all your workspaces):
    coder tokens create --lifetime 168h         # 168h = server max; copy the output
    printf %s '<paste token>' | coder secret create switcher-token --env SWITCHER_TOKEN
    coder restart coder-remote                   # make the hub log in again and start the service

  Always-on (disable auto-stop):
    coder schedule stop coder-remote manual

  Troubleshooting:
    tmux ls / tmux attach -t switcher            # service process
    tail -f /tmp/switcher.log                     # runtime log
    tail -f /tmp/switcher-npm.log                 # dependency install log
==============================================================================
EOF
