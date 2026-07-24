# Session launch model (how sessions run, enumerate, and get cleaned up)

This describes the *implemented* behavior (the current source of truth), not the original plan
(`docs/superpowers/specs/2026-07-23-session-model-design.md`, which is historical).

A **session** is one Claude conversation = one `~/.claude/projects/<cwd-slug>/<id>.jsonl` transcript.
A **project** is a directory (Claude's cwd); its name is the cwd basename (`~` for `$HOME`).
The switcher hub opens sessions on *other* workspaces over `coder ssh` / a Coder reconnecting PTY.

## Deterministic ids — the core rule

The switcher **chooses the session id up front** (a UUID) and passes it to Claude, instead of
letting Claude assign one and then guessing which new transcript resulted. This is what keeps the
tree row, the tmux, and the transcript in lockstep. Launch commands (`src/remote/launch.sh`,
driven by `SC_*` env):

| Action | claude flags | env |
|---|---|---|
| open existing | `--resume <id>` | `SC_RESUME=<id>` |
| new | `--session-id <uuid>` | `SC_SID=<uuid>` |
| fork | `--resume <parent> --fork-session --session-id <uuid>` | `SC_RESUME=<parent>`, `SC_FORK=1`, `SC_SID=<uuid>` |
| main (default click) | `config.claudeCmd` (`--continue`) | — (shared `claude` tmux) |

Because the id is known before launch, the frontend keys the pane/tree row by it immediately; the
"starting…" provisional row is just the same key before the transcript exists (a session has no
transcript until its first turn, so `SESS_PY` can't enumerate it yet).

## tmux naming & lifecycle (`ptyCommand` in `src/server.js`)

- Every non-main session runs in `tmux new-session -A -s cl-<id8>` (`id8` = first 8 hex of the id).
- `-A` = attach-or-create: **reopening a session attaches the same live claude** instead of starting
  a second one (which would corrupt the shared transcript). `--resume`/`--session-id` only run when
  the tmux is created fresh — i.e. resume happens on (re)attach only.
- main is the shared `claude` tmux (mobile chat + desktop terminal are the same conversation).
- Legacy `cln-<cwdkey>` / `clf-<parentid8>` names may exist from older versions; delete + the reaper
  still sweep them, but new launches never create them.

**Idle reaper** (`maybeReap`): on any workspace the switcher touches (enumerate / open pty),
throttled to once / 30 min per ws, it kills `cl-/clf-/cln-` tmuxes with **no client attached and
idle > 3h**. The main `claude` session is never touched. Fire-and-forget.

**Desktop pane cap** (`public/app.js`): at most 6 resident terminal panes (LRU); retired panes
reattach cleanly on reopen (that's what `-A` buys us), so no data loss.

## Enumeration, dedup, titles (`src/remote/sess.py`)

`/api/sessions` runs `sess.py` on the target, which scans `~/.claude/projects/*/*.jsonl` and prints
one `##SESSIONS##<json>` line. Server-side it's cached by a cheap signature (file count + newest
mtime); the full scan only re-runs when that changes. `rename`/`markfork`/`delete` bust the cache.

- **title**: `custom-title` → `ai-title` (Claude's own) → **first real user message** (skipping
  `<command-…>` wrappers and the resume `Caveat:` preamble) → `(untitled)`. Overridable per id via
  `~/.switcher/names.json`.
- **project cwd**: taken from the session's *first* turn (where it was launched), not the last.
- **main**: newest session whose cwd is `$HOME`, else newest overall. Protected (not deletable);
  hidden from the sidebar tree (clicking the workspace opens it).
- **dedup**: resuming replays old messages into a new file, so an old file's assistant-message-id
  set is a **subset** of the newer one → drop the subset (keep the live continuation). BUT a **fork**
  is also a subset+diverge of its parent, and there both are real. The transcript can't tell them
  apart, so forks the switcher creates are recorded in `~/.switcher/forks.json` (`{forkId: parentId}`,
  legacy array form tolerated); a recorded fork is **never allowed to cover (drop) another session**.

Tests: `src/remote/test_sess.py` (run via `npm test`, alongside `node --test`) covers resume-chain
collapse, fork keep-both, legacy forks.json, first-user-message titles + wrapper skip, name override.

## HTTP endpoints (session-related)

- `GET  /api/sessions?ws=` — enumerate (grouped listing for the tree). Signature-cached.
- `POST /api/session/rename?ws=` `{id,name}` — display-name override → `names.json`.
- `POST /api/session/delete?ws=` `{id}` — kill `cl-<id8>` + `pkill -f <id>` (matches `--resume`/
  `--session-id`) **before** removing the transcript, so a live claude can't rewrite it back; then
  drop it from `names.json`/`forks.json`.
- `POST /api/session/markfork?ws=` `{id,parent}` — record a fork (called at fork creation; ids are
  known up front, no adopt round-trip).
- `WS   /api/pty?ws=&session=&mode=&resume=&cwd=&name=` — terminal PTY. `mode` = `new`|`fork`|(open).

## Statelessness

The hub holds no conversation state — those live in the work workspaces. Hub-local state is only the
VAPID keypair (`~/.switcher/vapid.json`, regenerated if lost; frontend re-subscribes with the new key
silently) and push subscriptions (`subs.json`, self-heal on next app open). Deleting/recreating the
hub loses nothing: it re-enumerates every workspace's sessions over SSH.
