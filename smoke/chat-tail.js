#!/usr/bin/env node
// smoke/chat-tail.js — B spike: prove the "locate → tail → parse → bubble" pipeline.
// Usage: node smoke/chat-tail.js <workspace-name>
// Requires: the coder CLI installed locally and already logged in via coder login. It ssh's into the target workspace,
// finds the latest Claude Code transcript, tail -F's it, and prints each parsed line as a chat bubble.
const { spawn } = require('child_process');
const readline = require('readline');
const { parseRecord } = require('../src/transcript');

const ws = process.argv[2];
if (!ws) { console.error('Usage: node smoke/chat-tail.js <workspace-name>'); process.exit(1); }

// Remote: locate the .jsonl with the newest mtime under ~/.claude/projects/*/, print it to stderr, then tail -F.
const remote = [
  'f=$(find "$HOME/.claude/projects" -name "*.jsonl" -printf "%T@ %p\\n" 2>/dev/null | sort -rn | head -1 | cut -d" " -f2-)',
  'if [ -z "$f" ]; then echo "NO_TRANSCRIPT" >&2; exit 1; fi',
  'echo "TAILING: $f" >&2',
  'exec tail -n +1 -F "$f"',
].join('; ');

const C = { user: '\x1b[36m', asst: '\x1b[32m', tool: '\x1b[33m', res: '\x1b[35m', dim: '\x1b[90m', off: '\x1b[0m' };
function render(ev) {
  switch (ev.kind) {
    case 'title': console.log(`${C.dim}— title: ${ev.title} —${C.off}`); break;
    case 'user': console.log(`\n${C.user}👤 You${C.off}  ${ev.text}`); break;
    case 'assistant_text': console.log(`\n${C.asst}🤖 ${ev.model || 'claude'}${C.off}  ${ev.text}`); break;
    case 'thinking': console.log(`${C.dim}🤔 (thinking…)${C.off}`); break;
    case 'tool_use': {
      const inp = JSON.stringify(ev.input);
      console.log(`${C.tool}🔧 ${ev.name}${C.off} ${C.dim}${inp.slice(0, 120)}${C.off}`);
      break;
    }
    case 'tool_result': {
      const tag = ev.isError ? `${C.res}↩︎ result[error]` : `${C.res}↩︎ result`;
      console.log(`${tag}${C.off} ${C.dim}${(ev.text || '').replace(/\n/g, ' ').slice(0, 120)}${C.off}`);
      break;
    }
  }
}

const child = spawn('coder', ['ssh', ws, '--', remote], { stdio: ['ignore', 'pipe', 'inherit'] });
const rl = readline.createInterface({ input: child.stdout });
let n = 0, bad = 0;
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let rec;
  try { rec = JSON.parse(line); } catch { bad++; return; }
  n++;
  for (const ev of parseRecord(rec)) render(ev);
});
child.on('close', (code) => { console.log(`\n${C.dim}[done] parsed ${n} lines, ${bad} non-JSON lines, exit=${code}${C.off}`); });
process.on('SIGINT', () => { child.kill(); process.exit(0); });
