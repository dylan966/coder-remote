#!/usr/bin/env bash
# Agent startup script for the coder-remote hub (runs on every start, idempotent).
# clone/pull this repo (app lives at repo root) -> npm install deps -> coder login
# (using the injected token) -> start the service via tmux.
#
# Env vars it depends on (injected by main.tf's agent env / coder secret):
#   CODER_URL    the workspace's access_url (injected by main.tf)
#   CODER_TOKEN  user API token -- one-time: coder secret create switcher-token --env CODER_TOKEN
#   SWITCHER_REPO (optional) override the default git source (public repo, HTTPS clone needs no auth)
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

# ---- 3. coder CLI login (switcher's upload/attachment/files go through `coder ssh`) ----
# The switcher backend talks to Coder REST/PTY directly via the CODER_TOKEN env var;
# but the `coder ssh` it shells out to needs the CLI to already be logged in.
if [ -n "${CODER_URL:-}" ] && [ -n "${CODER_TOKEN:-}" ]; then
    coder login "${CODER_URL}" --token "${CODER_TOKEN}" >/dev/null 2>&1 \
        && log "coder CLI logged in to ${CODER_URL}" \
        || log "WARN: coder login failed (token not set? run coder secret create switcher-token --env CODER_TOKEN first)"
else
    log "WARN: missing CODER_URL / CODER_TOKEN -- switcher can't call Coder, set the switcher-token secret then restart"
fi

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
    coder tokens create --lifetime 8760h        # generate a long-lived user token, copy the output
    printf %s '<paste token>' | coder secret create switcher-token --env CODER_TOKEN
    coder restart coder-remote                   # make the hub log in again and start the service

  Always-on (disable auto-stop):
    coder schedule stop coder-remote manual

  Troubleshooting:
    tmux ls / tmux attach -t switcher            # service process
    tail -f /tmp/switcher.log                     # runtime log
    tail -f /tmp/switcher-npm.log                 # dependency install log
==============================================================================
EOF
