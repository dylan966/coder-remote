#!/usr/bin/env bash
# Auto-renew the hub's Coder user token so it never hits the server's 7-day cap.
# Run daily by a coder_script cron: while the current session is still valid, mint a
# fresh 168h token, re-login with it, and overwrite the switcher-token secret so a
# later restart also picks up a fresh token. As long as the hub isn't offline > 7 days,
# the token never lapses. (Offline > 7 days -> all tokens expire -> re-set the secret once.)
#
# NEVER echo the token value.
set -uo pipefail
log() { echo "[token-refresh] $*"; }

command -v coder >/dev/null 2>&1 || { log "coder CLI missing; skip"; exit 0; }

# Need a valid session to mint. If not logged in (e.g. this runs on boot before
# startup.sh, run_on_start=true), bootstrap the login from the SWITCHER_TOKEN secret first.
if ! coder whoami >/dev/null 2>&1; then
  if [ -n "${SWITCHER_TOKEN:-}" ] && [ -n "${CODER_URL:-}" ]; then
    coder login "${CODER_URL}" --token "${SWITCHER_TOKEN}" >/dev/null 2>&1 \
      && log "bootstrapped login from SWITCHER_TOKEN" \
      || { log "bootstrap login failed (token expired?); skip"; exit 0; }
  else
    log "not authenticated and no SWITCHER_TOKEN; skip"; exit 0
  fi
fi

NEW=$(coder tokens create --lifetime 168h --name switcher-auto 2>/dev/null | tail -1 | tr -d '[:space:]')
if [ -z "${NEW}" ]; then log "token mint failed; keeping current token"; exit 0; fi
NEWID="${NEW%%-*}"

if coder login "${CODER_URL:-}" --token "${NEW}" >/dev/null 2>&1; then
  log "re-logged in with fresh token"
else
  log "re-login failed; keeping current"; unset NEW; exit 0
fi

if printf %s "${NEW}" | coder secret update switcher-token >/dev/null 2>&1; then
  log "switcher-token secret updated"
else
  log "secret update failed (session still refreshed; will retry next run)"
fi
unset NEW

# Tidy: remove older auto-minted tokens (they self-expire in 7 days anyway), keep the new one.
for id in $(coder tokens ls 2>/dev/null | awk '$2=="switcher-auto"{print $1}'); do
  [ "${id}" = "${NEWID}" ] && continue
  coder tokens remove "${id}" >/dev/null 2>&1 || true
done

log "done"
