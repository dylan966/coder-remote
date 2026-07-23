const { test } = require('node:test');
const assert = require('node:assert');
const { parseRecord, contentToText } = require('../src/transcript');

test('skips metadata types', () => {
  for (const t of ['mode', 'permission-mode', 'file-history-snapshot', 'attachment', 'system', 'last-prompt']) {
    assert.deepEqual(parseRecord({ type: t, sessionId: 'x' }), []);
  }
});

test('ai-title becomes a title event', () => {
  assert.deepEqual(parseRecord({ type: 'ai-title', aiTitle: 'Check ports' }), [{ kind: 'title', title: 'Check ports' }]);
});

test('user string → user bubble', () => {
  assert.deepEqual(parseRecord({ type: 'user', message: { role: 'user', content: 'Which port services are you running right now' } }),
    [{ kind: 'user', text: 'Which port services are you running right now' }]);
});

test('empty user string → skipped', () => {
  assert.deepEqual(parseRecord({ type: 'user', message: { role: 'user', content: '   ' } }), []);
});

test('user array with tool_result → tool_result event', () => {
  const rec = { type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_017g', is_error: true, content: 'Exit code 127\nss: command not found' },
  ] } };
  assert.deepEqual(parseRecord(rec), [{ kind: 'tool_result', id: 'toolu_017g', isError: true, text: 'Exit code 127\nss: command not found', result: null }]);
});

test('tool_result carries structured toolUseResult', () => {
  const rec = { type: 'user', toolUseResult: { stdout: 'ok', stderr: '' }, message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
  ] } };
  assert.deepEqual(parseRecord(rec), [{ kind: 'tool_result', id: 't1', isError: false, text: 'ok', result: { stdout: 'ok', stderr: '' } }]);
});

test('isMeta records are skipped', () => {
  assert.deepEqual(parseRecord({ type: 'user', isMeta: true, message: { role: 'user', content: 'internal' } }), []);
});

test('system-reminder / caveat prefixes are skipped', () => {
  assert.deepEqual(parseRecord({ type: 'user', message: { role: 'user', content: '<system-reminder>x</system-reminder>' } }), []);
  assert.deepEqual(parseRecord({ type: 'user', message: { role: 'user', content: '<local-command-caveat>Caveat: ...' } }), []);
});

test('local slash command parses to /name args', () => {
  const s = '<command-name>/model</command-name><command-message>model</command-message><command-args>opus</command-args>';
  assert.deepEqual(parseRecord({ type: 'user', message: { role: 'user', content: s } }), [{ kind: 'user', text: '/model opus', slash: true }]);
});

test('local command output ANSI stripped → cmd_out', () => {
  const s = '<local-command-stdout>Set model to \x1b[1mOpus\x1b[22m done</local-command-stdout>';
  assert.deepEqual(parseRecord({ type: 'user', message: { role: 'user', content: s } }), [{ kind: 'cmd_out', text: 'Set model to Opus done' }]);
});

test('attached_files stripped into attach event (with paths)', () => {
  const s = 'What is this\n\n<attached_files>\nUser attached 1 file(s). Use Read to read them.\n1. /home/coder/.switcher-uploads/x.jpg (original: image.jpg)\n</attached_files>';
  assert.deepEqual(parseRecord({ type: 'user', message: { role: 'user', content: s } }), [
    { kind: 'user', text: 'What is this' },
    { kind: 'attach', files: [{ path: '/home/coder/.switcher-uploads/x.jpg', name: 'image.jpg' }] },
  ]);
});

test('image block embedded in tool_result → inline image event', () => {
  const rec = { type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't1', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ] },
  ] } };
  assert.deepEqual(parseRecord(rec), [
    { kind: 'tool_result', id: 't1', isError: false, text: '', result: null },
    { kind: 'image', mediaType: 'image/png', data: 'AAAA', ofToolUse: 't1' },
  ]);
});

test('custom-title → title', () => {
  assert.deepEqual(parseRecord({ type: 'custom-title', customTitle: 'My session' }), [{ kind: 'title', title: 'My session' }]);
});

test('assistant text block → assistant bubble with model', () => {
  const rec = { type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [
    { type: 'text', text: 'Let me check which ports the system is listening on.' },
  ] } };
  assert.deepEqual(parseRecord(rec), [{ kind: 'assistant_text', text: 'Let me check which ports the system is listening on.', model: 'claude-sonnet-5' }]);
});

test('assistant empty thinking skipped, tool_use kept', () => {
  const rec = { type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [
    { type: 'thinking', thinking: '', signature: 'abc' },
    { type: 'tool_use', id: 'toolu_017g', name: 'Bash', input: { command: 'ss -ltn', description: 'List ports' } },
  ] } };
  assert.deepEqual(parseRecord(rec), [
    { kind: 'tool_use', id: 'toolu_017g', name: 'Bash', input: { command: 'ss -ltn', description: 'List ports' } },
  ]);
});

test('assistant non-empty thinking → thinking event', () => {
  const rec = { type: 'assistant', message: { role: 'assistant', model: 'm', content: [
    { type: 'thinking', thinking: 'Let me think' },
  ] } };
  assert.deepEqual(parseRecord(rec), [{ kind: 'thinking', model: 'm' }]);
});

test('contentToText handles strings and arrays', () => {
  assert.equal(contentToText('hi'), 'hi');
  assert.equal(contentToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
  assert.equal(contentToText([{ type: 'tool_result', content: 'x' }]), '');
});

test('bad input does not throw', () => {
  assert.deepEqual(parseRecord(null), []);
  assert.deepEqual(parseRecord({ type: 'assistant' }), []);
  assert.deepEqual(parseRecord({ type: 'user', message: { content: 42 } }), []);
});
