# template/ —— Coder template for the coder-remote hub

Deploys **this repo's** coder-switcher as an always-on, lightweight workspace: one page
to view/switch all your Coder workspaces and enter each one's `claude` session.
**Mobile bubble chat + PWA + Web Push**, still a terminal on desktop.

App code lives at the repo root (`src/` `public/`); this directory is just the template
that deploys it. On startup the hub does `git clone` from GitHub and `npm ci` to start
the service —— **app changes only need a push to GitHub + `coder restart coder-remote`,
no need to re-push the template**.

## Architecture notes

- **Backend proxy**: all Coder calls (REST + PTY/chat WebSocket + `coder ssh`) are made
  server-side inside the hub; the browser only talks to the hub over the same origin ->
  unaffected by Coder not allowing CORS.
- **Auth**: `coder_app share=owner` —— only the logged-in owner can open it. The app acts
  with the owner's token and lists the owner's workspaces, so it stays owner-only (sharing
  it would let others drive the owner's workspaces). Keep it in this template/subdomain
  form; don't expose it bare to the public internet.
- **HTTPS**: the subdomain app has TLS built in -> PWA / Service Worker / Web Push /
  voice all work.
- **token**: the hub needs a **user API token** (not an agent token) to list/control all
  your workspaces. Injected as `SWITCHER_TOKEN` via `coder secret` (CODER_* env names are
  reserved, so startup.sh maps it to `CODER_TOKEN`), never checked into code/git.

## One-time setup (run on Mac, connected to coder.gmaster888.com)

```bash
# 1. Push the template (run from repo root, -d points to this directory)
coder templates push coder-remote -d template --yes

# 2. Create the workspace
coder create --template coder-remote coder-remote --yes

# 3. Generate a user token and inject it as a secret (injected into all your workspaces' agent env)
coder tokens create --lifetime 168h        # 168h is the server's max token lifetime
printf %s '<paste the token from the previous step>' | coder secret create switcher-token --env SWITCHER_TOKEN

# 4. Always-on: disable auto-stop
coder schedule stop coder-remote manual

# 5. Make the hub log in again and start the service
coder restart coder-remote
```

Once done, open the **"Workspace Switcher"** app in the top right of the workspace page
(you can "Add to Home Screen" to install it as a PWA).

## Updating the app code

```bash
# Make changes at repo root -> push to GitHub
git push
# Have the hub pull the latest and restart the service
coder restart coder-remote          # or from inside the workspace: cd ~/coder-remote && git pull && tmux kill-session -t switcher && re-run
```

## Troubleshooting

```bash
coder ssh coder-remote
tmux ls; tmux attach -t switcher     # service process
tail -f /tmp/switcher.log            # runtime log
tail -f /tmp/switcher-npm.log        # dependency install log
echo "$CODER_URL / ${SWITCHER_TOKEN:+token set}"   # whether env injection took effect
```

- App shows `not_logged_in` on open -> the `switcher-token` secret isn't set or hasn't
  taken effect; recheck steps 3/5.
- WebSocket won't connect -> confirm you're using the subdomain URL
  (`switcher--coder-remote--<you>.coder.gmaster888.com`); the switcher's Origin allowlist
  permits coderHost and its subdomains.

## Files

| File | Purpose |
|---|---|
| `main.tf` | Self-contained: agent (injects CODER_URL) + switcher coder_app (subdomain/owner) + lightweight image + container |
| `startup.sh` | clone/pull this repo -> npm ci -> `coder login` -> start `node src/server.js` via tmux |
| `build/Dockerfile` | debian-slim + Node20 + git + coder CLI (no JDK/Maven/python) |
| `token-refresh.sh` | run daily by a `coder_script` cron: mints a fresh 168h token, re-logins, updates the secret — so the token never hits the server's 7-day cap |

## Token auto-renewal

The server caps token lifetime at 168h (7 days). A `coder_script` cron (`token-refresh.sh`)
runs daily inside the hub: while the current session is valid it mints a fresh token,
re-logins, and overwrites the `switcher-token` secret. So the token is self-renewing and
needs no manual attention — **unless the hub is offline for more than 7 days**, in which case
all tokens expire and you re-run the one-time step 3 above (create token + set secret + restart).
