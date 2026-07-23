# scratch —— blank claude work workspace

A general-purpose workspace for starting new projects. Full toolchain, no switcher
service (that lives in the `coder-remote` hub). Reach it via the switcher
(`?ws=scratch`) for claude, or the **VS Code (Web)** app to edit.

**Image**: Node 20 + python3 + build-essential + ripgrep + uv/uvx + claude-code +
claude-hud + code-server + coder CLI.

**Apps**:
- **VS Code (Web)** — code-server on :13337
- **Claude Code** — terminal app (`tmux … .start-claude.sh`, bypass + opus + claude-hud)
- **Web (:3000)** / **API (:8000)** — pre-wired subdomain quick-links; run a dev server
  on the port and click the link (also shows in the switcher's quick-links).

**claude**: bypass mode, model `opus[1m]`, cwd `/home/coder`, first-run wizard skipped.
Auth uses your existing `claude-token` secret (`CLAUDE_CODE_OAUTH_TOKEN`) — no extra setup.

## One-time setup (run on Mac)

```bash
coder templates push scratch -d template/scratch --yes
coder create --template scratch scratch --yes
```

Then open it from the switcher, or the workspace's app buttons in Coder.
