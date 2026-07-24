#!/usr/bin/env bash
set -uo pipefail
CWD="${SC_CWD:-$HOME}"
mkdir -p "$CWD" 2>/dev/null; cd "$CWD" 2>/dev/null || cd "$HOME"
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
CJ="$HOME/.claude.json"; [ -f "$CJ" ] || echo '{}' >"$CJ"
jq --arg d "$CWD" '.hasCompletedOnboarding=true | .projects[$d]=((.projects[$d]//{})+{hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true})' "$CJ" >"$CJ.t" 2>/dev/null && mv "$CJ.t" "$CJ"
mkdir -p "$HOME/.claude"; SJ="$HOME/.claude/settings.json"; [ -f "$SJ" ] || echo '{}' >"$SJ"
jq '. + {skipDangerousModePermissionPrompt:true, theme:(.theme//"dark")}' "$SJ" >"$SJ.t" 2>/dev/null && mv "$SJ.t" "$SJ"
for _i in $(seq 1 30); do command -v claude >/dev/null 2>&1 && break; sleep 1; done
ARGS=(--dangerously-skip-permissions)
if [ -n "${SC_NAME_B64:-}" ]; then N="$(printf %s "$SC_NAME_B64" | base64 -d 2>/dev/null)"; [ -n "$N" ] && ARGS+=(--name "$N"); fi
if [ -n "${SC_RESUME:-}" ]; then ARGS+=(--resume "$SC_RESUME"); [ -n "${SC_FORK:-}" ] && ARGS+=(--fork-session); fi
# SC_SID: run under a caller-chosen session id (create → --session-id only; fork → alongside
# --resume/--fork-session). Lets the switcher know the transcript id upfront (no adopt-guessing).
if [ -n "${SC_SID:-}" ]; then ARGS+=(--session-id "$SC_SID"); fi
exec claude "${ARGS[@]}"
