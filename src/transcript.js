// src/transcript.js
// Normalize a single Claude Code session transcript (JSONL) record into chat bubble events.
// Pure function, no I/O — easy to unit test. Based on the Claude Code 2.1.x transcript format.

// These top-level types are metadata; they don't go into the chat stream.
const SKIP_TYPES = new Set([
  'mode', 'permission-mode', 'file-history-snapshot', 'file-history-delta',
  'attachment', 'system', 'last-prompt', 'queue-operation',
]);

// User strings starting with these are internal/injected content; not displayed.
const SKIP_PREFIXES = [
  '<system-reminder>', '<local-command-caveat>', 'Caveat:', '[Request interrupted',
];

/** Strip ANSI escape sequences (common in command output). */
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/** Concatenate the plain text from content (a string or a block array). */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/** Convert an image content block to an image event (base64); returns null if no data. */
function imgEvent(b) {
  const src = b && b.source;
  if (src && src.type === 'base64' && src.data) return { kind: 'image', mediaType: src.media_type || 'image/png', data: src.data };
  return null;
}

/** Parse a user string content: local slash command / command output / plain text / skip. */
function parseUserString(str) {
  const s = str;
  if (SKIP_PREFIXES.some((p) => s.startsWith(p))) return [];
  const name = s.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (name) {
    const args = s.match(/<command-args>([\s\S]*?)<\/command-args>/);
    const a = args && args[1].trim();
    return [{ kind: 'user', text: name[1].trim() + (a ? ' ' + a : ''), slash: true }];
  }
  const out = s.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
  if (out) { const t = stripAnsi(out[1]).trim(); return t ? [{ kind: 'cmd_out', text: t }] : []; }
  if (s.indexOf('<attached_files>') >= 0) { // Attachment block we sent ourselves: don't show the raw text, turn it into an attach event (with paths; the frontend can fetch thumbnails)
    const files = [...s.matchAll(/^\s*\d+\.\s+(\S+)\s+\(original:\s*([^)]*)\)/gm)].map((m) => ({ path: m[1], name: m[2].trim() }));
    const clean = s.replace(/<attached_files>[\s\S]*?<\/attached_files>/g, '').trim();
    const ev = [];
    if (clean) ev.push({ kind: 'user', text: clean });
    ev.push({ kind: 'attach', files });
    return ev;
  }
  return s.trim() ? [{ kind: 'user', text: s }] : [];
}

/**
 * Parse one transcript record, returning an array of normalized bubble events ([] if skipped).
 * Event shapes:
 *   { kind:'title', title }
 *   { kind:'user', text, slash? }
 *   { kind:'cmd_out', text }                 // local command output (ANSI stripped)
 *   { kind:'assistant_text', text, model }
 *   { kind:'thinking', model }               // only when there is non-empty thinking text
 *   { kind:'tool_use', id, name, input }
 *   { kind:'tool_result', id, isError, text, result }  // result = on-disk toolUseResult (structured)
 */
function parseRecord(rec) {
  if (!rec || typeof rec !== 'object') return [];
  const type = rec.type;

  if (type === 'ai-title' && rec.aiTitle) return [{ kind: 'title', title: rec.aiTitle }];
  if (type === 'custom-title' && rec.customTitle) return [{ kind: 'title', title: rec.customTitle }];
  if (SKIP_TYPES.has(type)) return [];
  if (rec.isMeta) return [];

  const msg = rec.message;
  if (!msg || typeof msg !== 'object') return [];
  const content = msg.content;

  if (type === 'user') {
    if (typeof content === 'string') return parseUserString(content);
    if (Array.isArray(content)) {
      const out = [];
      // A user record usually carries one tool_result; toolUseResult (structured) is its sibling field.
      const single = content.filter((b) => b && b.type === 'tool_result').length === 1;
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_result') {
          out.push({
            kind: 'tool_result',
            id: b.tool_use_id,
            isError: !!b.is_error,
            text: contentToText(b.content),
            result: single ? (rec.toolUseResult || null) : null,
          });
          // Read images etc: image blocks embedded in tool_result → inline display (Claude's screenshots go through here)
          if (Array.isArray(b.content)) for (const cb of b.content) if (cb && cb.type === 'image') { const e = imgEvent(cb); if (e) { e.ofToolUse = b.tool_use_id; out.push(e); } }
        } else if (b.type === 'image') {
          const e = imgEvent(b); if (e) out.push(e);
        } else if (b.type === 'text' && b.text && b.text.trim()) {
          out.push(...parseUserString(b.text));
        }
      }
      return out;
    }
    return [];
  }

  if (type === 'assistant') {
    if (!Array.isArray(content)) return [];
    const model = msg.model;
    const out = [];
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        out.push({ kind: 'assistant_text', text: b.text, model });
      } else if (b.type === 'thinking' && b.thinking && b.thinking.trim()) {
        out.push({ kind: 'thinking', model });
      } else if (b.type === 'tool_use') {
        out.push({ kind: 'tool_use', id: b.id, name: b.name, input: b.input || {} });
      } else if (b.type === 'image') {
        const e = imgEvent(b); if (e) out.push(e);
      }
    }
    return out;
  }

  return [];
}

module.exports = { parseRecord, contentToText, stripAnsi, SKIP_TYPES };
