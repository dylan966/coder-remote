# Coder Workspace Switcher — Design Document

Date: 2026-07-21
Status: Design review passed + core risk spike verified

## Goal

A Warp-style web page: view all my (single-user) Coder workspaces on **one page**, click/search to switch, with the main area going straight into that workspace's **Claude session** (the `claude` tmux session), without dropping the session when switching away. **Mobile support required.**

Not doing: multi-user/multi-tenant, anything beyond workspace switching. (YAGNI)

## Key constraints (established through testing)

- Coder (coder.gmaster888.com) has a site-wide CSP of `frame-ancestors 'self'` → its terminal **cannot be iframed** cross-origin/cross-subdomain.
- The Coder API **does not send CORS allow headers** → the browser **cannot read** the API from an external origin; cross-site requests also can't carry the login cookie.
- Conclusion: a pure static page won't work — **a backend proxy is required** (server-side holds the token and calls Coder; the frontend only talks to this same-origin backend).

## Architecture

Runs inside an **always-on Coder workspace**, exposed via `coder_app` (subdomain, `share=owner`):

- **Frontend**: single page, xterm.js terminal + workspace switcher (sidebar + `Cmd/Ctrl+K` command palette). Mobile-responsive. Talks only to this same-origin backend.
- **Backend** (Node, same origin):
  - Holds a single **Coder API token** (injected via env var through `coder secret`, never in code).
  - `GET /api/workspaces`: proxies the Coder REST API, returns my workspace list + status.
  - `WS /api/pty?ws=<workspace>`: opens a Coder reconnecting-PTY for that workspace, bidirectionally bridged to the frontend's xterm.js.
  - `POST /api/start?ws=<workspace>`: proxies a Coder start build (wakes a stopped workspace).

## Terminal mechanism (core, spike-verified)

The backend connects to Coder's reconnecting-PTY websocket:

- Endpoint: `wss://<coder>/api/v2/workspaceagents/{agentID}/pty?reconnect=<uuid>&width=<w>&height=<h>`
- Auth: HTTP header `Coder-Session-Token: <token>` (server-side connection, no CORS/cookie restrictions).
- **Client→server**: JSON `{data?, height?, width?}`, sent as **binary frames** (text frames are rejected — hit this during the spike).
- **Server→client**: raw PTY output (text frames), fed straight into xterm.js.
- Entering the Claude session: either pass `?command=` in the URL, or send `{data:"tmux new-session -A -s claude\r"}` after connecting, reusing each workspace's existing `claude` tmux session.

The backend wires together the three segments "frontend xterm.js ↔ backend ↔ Coder PTY": frontend input → backend wraps it as binary JSON and sends to Coder; Coder output → backend forwards to the frontend. Resize works the same way, passed through.

## Data flow

1. Frontend loads → `GET /api/workspaces` → renders the list (name + running/stopped).
2. Select a running one → frontend opens `WS /api/pty?ws=X` to the backend → backend opens a Coder PTY for the corresponding agent (command=attach claude) → bidirectional stream.
3. Select a stopped one → `POST /api/start` → poll status → auto-attach once running.
4. Switching workspace = frontend switches to a different PTY (one per workspace, kept alive in the background; tmux is already persistent on the workspace side).

## Frontend UI + mobile

- Desktop: left workspace panel (name + status dot) + right xterm.js; `Cmd/Ctrl+K` command palette with fuzzy search to jump.
- Mobile: workspace panel collapses into a top drawer/dropdown; xterm.js touch scrolling + a dedicated "summon keyboard" input area (handles the mobile soft keyboard specially); font size/spacing adapted.

## Auth and security

- Single user: the backend's one token = me, can open all my workspaces.
- `coder_app share=owner`: only someone logged into my Coder account can open this app (first layer).
- Token stored via `coder secret`, never in code/git.
- No multi-user support (YAGNI).

## Component boundaries

- `backend/coder-client.js`: wraps the Coder REST API + PTY websocket (token, endpoints, binary JSON protocol). Single responsibility, independently testable.
- `backend/server.js`: http + ws routing, bridges frontend ↔ coder-client.
- `frontend/`: xterm.js terminal component, workspace list/command palette, mobile layout. Each component has a single responsibility.

## Test strategy

- Backend `coder-client`: against a real Coder instance + a test workspace, verify listing, PTY connect/send/receive, start.
- Bridge: end-to-end smoke test frontend ↔ backend ↔ Coder (start the service → list → attach one → get a shell prompt → send a command and see the echo).
- Frontend: switching doesn't cross-contaminate sessions, reconnect on disconnect, mobile layout.

## Risks

- ✅ **Resolved** (spike): cross-origin/server-side connection to Coder PTY + auth + binary JSON send/receive — all verified working (see "Terminal mechanism").
- ⏳ **Pending verification**: mobile soft-keyboard input experience; resource usage of keeping multiple PTYs alive concurrently; reconnect behavior (reusing the reconnect UUID); token expiry handling.

## Deployment

- Pick an always-on workspace (or create a lightweight hub workspace) to run this service.
- Add a `coder_app` (subdomain, owner) to the template pointing at the service's port; token injected via `coder secret`.

## Explicitly out of scope (YAGNI)

Multi-user support, anything beyond workspace management, reintroducing old ideas like notifications.
