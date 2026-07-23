# Mobile Claude Chat View (Option B Hybrid Architecture) + Enhancements — Design Document

Date: 2026-07-22
Status: Implemented and deployed/verified on switcher-host (real-device push delivery pending final user acceptance)

## Goal

Chat with the workspace's `claude` session on mobile the way you would in the Claude App: a **bubble-style chat UI**,
while **desktop remains a terminal** (xterm/PTY). Key constraint: mobile and desktop **must be the same conversation** —
mobile isn't a separate headless claude instance; it reads the same session's transcript and writes to the same tmux `claude` PTY.

Not doing: converting desktop to bubbles too; app-level login auth (#1, explicitly out of scope this round); multi-user.

## Core architecture: read the transcript + write to the same PTY (not rewritten as headless)

Split the two directions of conversation state into two separate channels, which naturally guarantees "the same conversation":

- **Read (render bubbles)**: tail the target workspace's Claude transcript JSONL
  (`~/.claude/projects/<slug>/<session>.jsonl`), `parseRecord` each line into bubble events pushed to the frontend.
- **Write (send messages)**: the frontend writes input via `WS /api/pty` into that workspace's existing
  `claude` tmux session (the same PTY the desktop terminal uses). Multi-line input/attachments use **bracketed
  paste mode** (`\x1b[200~…\x1b[201~`) to avoid the TUI submitting prematurely.

This way, there's no need to introduce the Agent SDK or a headless rewrite — the desktop terminal and the mobile chat share the same session file and the same input channel.

## Component boundaries

- `src/transcript.js` — **pure-function** parser: one transcript record → an array of bubble events. No I/O, covered by unit tests.
  Events: `title / user(+slash) / cmd_out / assistant_text / thinking / tool_use / tool_result / image(+ofToolUse) / attach`.
- `src/turn.js` — **pure state machine**: determines "this turn's reply has ended" from the event stream (replay warm-up
  suppression + user-question arming + assistant-wrap-up trigger). Timing is left to the caller for deterministic unit tests.
- `src/push.js` — Web Push wrapper: VAPID keys, subscription persistence, sending; degrades to `enabled=false` no-op if `web-push` is missing.
- `src/server.js` — http + ws routing: `/api/chat` (tail→parse→forward), `/api/pty`, `/api/upload`,
  `/api/attachment`, `/api/files`, `/api/push/*`, plus the Web Push background watcher.
- `src/coder-client.js` — Coder REST + PTY websocket; `onData` uses `StringDecoder` to buffer across frames for multi-byte characters (so CJK text doesn't get mangled).
- `public/chat.html` / `public/chat.js` — mobile bubble view (embedded in index.html via iframe on phones).
- `public/sw.js` / `public/manifest.json` / `public/icon.svg` — PWA: installable, `push` / `notificationclick`.

## Session enumeration and de-duplication (SESS_PY)

When `/api/chat` connects, it first runs a chunk of remote Python (inlined as base64, controlled by `SESSION`/`FRESH` env vars):

1. Glob `~/.claude/projects/*/*.jsonl` (skipping subagents), extract a title (custom/ai/last-prompt), count, and collect the set of assistant `message.id`s.
2. **Subset de-duplication**: resuming opens a new file that replays old messages; drop any file whose id set is a subset of another's, fixing the "picked the wrong session" problem at the root.
3. Print a `##SESSIONS##<json>` line (frontend locates it via `indexOf`, to avoid shell echo contamination), then `tail -n 1500 -F` the target file
   (only pulls the most recent 1500 lines, so very long sessions aren't too heavy on initial load). Prints `##NO_TRANSCRIPT##` if there's no file.

Before splicing the `session id` into an env var, it's validated against `/^[0-9a-fA-F-]{8,}$/` to prevent injection.

## Enhancements implemented

| # | Item | Approach |
|---|---|---|
| 2 | Mobile reconnect | chat/pty WS reconnects with exponential backoff (capped at 15s); an intentional switch/new-session is marked `_intentional` to skip reconnect; after reconnecting, `pendingReset` waits for the first message to arrive before clearing the screen, so replay doesn't duplicate |
| 3 | Empty state when claude isn't running | when the session list is empty, insert a guidance prompt in the chat area (de-duplication guard); removed once a session exists |
| 4 | Stop/interrupt | shows a "Stop" button when claude is busy (typing); tapping sends ESC (`\x1b`) to the PTY |
| 5 | Slash `/` + `@file` autocomplete | `/` at the start opens a command menu (static list, filtered locally); `@` at the start of a word opens a file menu (`/api/files` pulls a one-time cache of files under `$HOME`, filtered locally by substring); arrow keys/Enter/Tab/Esc + tap |
| 6 | Voice input | Web Speech API (zh-CN) recognizes speech and fills the input box; hides the mic if unsupported |
| 7 | Web Push | VAPID + web-push; `/api/push/key|subscribe|unsubscribe`; SW `push` event; server-side watcher detects end-of-turn and pushes a notification (wakes the app even when closed) |
| 8 | Image de-duplication | reads tool_use entries in the upload directory → records their id; inline images with a matching `ofToolUse` are skipped (the image you sent is already shown in the bubble) |
| 9 | Only pull recent lines for very long sessions | `tail -n 1500` |
| 10 | No mangled CJK across frames | `coder-client`'s `onData` buffers incomplete multi-byte sequences using `StringDecoder('utf8')` |

Also done: soft keyboard dismisses after sending; can start a new session from the switcher; scrolls to bottom by default + a one-tap "scroll to bottom" button; sent images/claude screenshots shown inline; PWA icon and copy.

## Web Push background watcher (#7 key design)

Foreground local notifications (chat.js's `maybeNotify`) only work while the page is open; **Web Push is what wakes the app when fully closed**.

- Each workspace with an active subscription runs a transcript tail (reusing `chatCommand`); subscriptions added/removed trigger a rebuild via `onSubsChange`, with a 60s fallback resync.
- **Replay suppression**: for `WARM_MS` (4s) after connecting, only title/body are updated, not armed (otherwise the last turn in history would be mistaken for one that just finished).
- After warm-up: a genuine user question (non-slash) arms it; each event resets a `DONE_MS` (7s) silence timer; when it elapses, if still armed and the last event is an assistant message → push once and disarm (doesn't push if stopped at a tool call).
- **Suppression while viewing**: the server tracks the count of active `/api/chat` connections per workspace (`liveChats`, +1 on connect / -1 on close); before pushing, if that workspace has an active chat window open (>0), it **skips the Web Push** — since you're already looking at it, the frontend's local notification handles it instead (it doesn't pop while visible, only in the background), satisfying "don't notify while I'm watching" without double notifications from both local and push. Only pushes for real when no window is open (no active connections).
- Expired endpoints (404/410) are automatically removed from the subscription table.

## Tests

- `test/transcript.test.js` (29): parser coverage for each record type, slash, cmd_out, attach, inline image `ofToolUse`, isMeta, malformed input.
- `test/turn.test.js` (7): warm-up suppression, wrap-up trigger, fires only once, doesn't fire while stopped at a tool call, fires after a tool round-trip completes, slash doesn't arm, title doesn't reset the timer.
- Post-deploy verification via Playwright (mobile viewport): session list/switching, bubble replay, stop-button show/hide, reconnect doesn't duplicate, empty-state prompt, voice button visibility, `/` and `@` autocomplete filtering and insertion; zero console errors.

## Security

- Path validation: `/api/attachment` only allows the `UPLOAD_DIR` prefix and blocks `..`; session id is regex-whitelisted; `/api/files` uses a fixed command with no user input concatenated in.
- Uploads are written via `coder ssh`'s stdin (non-TTY), binary-safe with no argument length limit.
- WS upgrade validates Origin (localhost or coderHost and its subdomains).
- **App-level auth (#1) is out of scope this round**: currently relies on `coder_app share=owner` (only someone logged into my Coder account can open it). A public-facing deployment would need an additional layer.

## Known limitations

- Real-device Web Push delivery requires real notification permission + a reachable push service; headless browsers can't grant permission, so delivery verification is left for real-device acceptance testing.
- `@file` listing is relative to `$HOME` (not the current session's cwd); some paths may not resolve when claude's cwd isn't `$HOME` (YAGNI — can be narrowed to the session's cwd later).

## Deployment

Changed files are pushed to `switcher-host:~/switcher` via `tar → base64 → (printf args) → coder ssh` (avoiding `coder ssh` PTY echo corrupting binary stdin), verified with `md5sum`, then **only the `switcher` tmux session is restarted** (never touches the `claude` session). `web-push` is already installed in the remote `~/switcher/node_modules`.
