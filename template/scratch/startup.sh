#!/usr/bin/env bash
# scratch workspace startup (runs every start, idempotent). No switcher service —
# this box is for doing work. Just prepare the claude launcher + git identity.
# (code-server is started by its own coder_script; claude auth comes from the
# claude-token secret CLAUDE_CODE_OAUTH_TOKEN, injected automatically.)
set -uo pipefail
log() { echo "[startup] $*"; }

# git identity from Coder owner
[ -n "${CODER_OWNER_NAME:-}" ]  && git config --global user.name  "${CODER_OWNER_NAME}"  || true
[ -n "${CODER_OWNER_EMAIL:-}" ] && git config --global user.email "${CODER_OWNER_EMAIL}" || true
git config --global init.defaultBranch main || true
git config --global pull.rebase false || true

mkdir -p /home/coder/projects

# claude launcher: bypass mode, cwd /home/coder, opus, claude-hud statusline, skip first-run wizard.
# The switcher's PTY command attaches `tmux new-session -A -s claude /home/coder/.start-claude.sh`.
cat >/home/coder/.start-claude.sh <<'EOSH'
#!/usr/bin/env bash
cd /home/coder
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
CJ="$HOME/.claude.json"; [ -f "$CJ" ] || echo '{}' >"$CJ"
jq '.hasCompletedOnboarding = true | .projects["/home/coder"] = ((.projects["/home/coder"] // {}) + {hasTrustDialogAccepted:true, hasCompletedProjectOnboarding:true})' "$CJ" >"$CJ.tmp" 2>/dev/null && mv "$CJ.tmp" "$CJ"
mkdir -p "$HOME/.claude"; SJ="$HOME/.claude/settings.json"; [ -f "$SJ" ] || echo '{}' >"$SJ"
jq '. + {skipDangerousModePermissionPrompt:true, theme:"dark", model:"opus[1m]", autoUpdates:false, statusLine:{type:"command", command:"node /opt/claude-hud/dist/index.js"}}' "$SJ" >"$SJ.tmp" 2>/dev/null && mv "$SJ.tmp" "$SJ"
for _i in $(seq 1 30); do command -v claude >/dev/null 2>&1 && break; sleep 1; done
if compgen -G "$HOME/.claude/projects/-home-coder/*.jsonl" >/dev/null 2>&1; then
  jq 'del(.projects["/home/coder"].lastSessionId)' "$CJ" >"$CJ.tmp" 2>/dev/null && mv "$CJ.tmp" "$CJ"
  exec claude --dangerously-skip-permissions --continue
else
  exec claude --dangerously-skip-permissions
fi
EOSH
chmod +x /home/coder/.start-claude.sh
log "wrote /home/coder/.start-claude.sh (claude bypass @ /home/coder)"

# Tell claude about the two proxied ports + their public URLs (user-global memory, always loaded).
mkdir -p /home/coder/.claude
cat >/home/coder/.claude/CLAUDE.md <<EOF
# scratch workspace — networking (important)

This workspace exposes exactly **two ports** through Coder's public wildcard domain.
When you run a dev server, use these ports so it is reachable from the browser:

- **Web / frontend → port 3000** → public URL: ${WEB_PUBLIC_URL:-https://web--scratch--<owner>.coder.gmaster888.com}
- **API / backend → port 8000** → public URL: ${API_PUBLIC_URL:-https://api--scratch--<owner>.coder.gmaster888.com}

Bind to localhost:3000 / localhost:8000 (Coder proxies them). **Other ports are NOT
proxied** (no public URL), so prefer 3000/8000. Opening these URLs requires the owner to
be logged into Coder. These links also appear in the "Workspaces 切换器" quick-links.
EOF
log "wrote /home/coder/.claude/CLAUDE.md (port + public-url guidance)"

cat <<'EOF'

==============================================================================
  scratch workspace ready — a blank box for new projects.

  Tools: node, python3, ripgrep, uv/uvx, claude (bypass, opus, claude-hud), code-server.
  Open it from the "Workspaces 切换器" (?ws=scratch) for claude, or the
  "VS Code (Web)" app to edit. Pre-wired quick-links: Web (:3000), API (:8000)
  — run a dev server on those ports and click the link in the switcher.
==============================================================================
EOF
