const { test } = require('node:test');
const assert = require('node:assert');
const { makeTurnDetector } = require('../src/turn');

test('replay during warm-up does not arm; fire returns null', () => {
  const d = makeTurnDetector();
  // simulate history replay: user prompt + assistant reply (both before warmUp)
  d.feed({ kind: 'user', text: 'old question' });
  d.feed({ kind: 'assistant_text', text: 'old answer' });
  assert.equal(d.isArmed(), false);
  assert.equal(d.fire(), null); // not armed → no push
});

test('after warm-up: user prompt → assistant reply → silence → fire returns title and body', () => {
  const d = makeTurnDetector();
  d.feed({ kind: 'title', title: 'history title' }); // set title during warm-up
  d.warmUp();
  assert.equal(d.feed({ kind: 'user', text: 'hello' }), true); // activity after warm-up
  assert.equal(d.isArmed(), true);
  d.feed({ kind: 'assistant_text', text: '  hello there\nhow can I help ' });
  const p = d.fire();
  assert.deepEqual(p, { title: 'history title', text: 'hello there how can I help' }); // body whitespace normalized
});

test('fire triggers only once (disarms)', () => {
  const d = makeTurnDetector();
  d.warmUp();
  d.feed({ kind: 'user', text: 'q' });
  d.feed({ kind: 'assistant_text', text: 'a' });
  assert.ok(d.fire());
  assert.equal(d.fire(), null); // second call no longer triggers
});

test('stopping at a tool call (not wrapped up) does not push', () => {
  const d = makeTurnDetector();
  d.warmUp();
  d.feed({ kind: 'user', text: 'q' });
  d.feed({ kind: 'assistant_text', text: 'let me check' });
  d.feed({ kind: 'tool_use', id: 't1', name: 'Bash', input: {} }); // last event is a tool call
  assert.equal(d.fire(), null); // lastKind not assistant_text → no push
});

test('assistant wraps up after tool round-trip → push', () => {
  const d = makeTurnDetector();
  d.warmUp();
  d.feed({ kind: 'user', text: 'q' });
  d.feed({ kind: 'assistant_text', text: 'checking first' });
  d.feed({ kind: 'tool_use', id: 't1', name: 'Bash', input: {} });
  d.feed({ kind: 'tool_result', id: 't1', text: 'ok' });
  d.feed({ kind: 'assistant_text', text: 'done checking, the answer is 42' });
  const p = d.fire();
  assert.ok(p); assert.equal(p.text, 'done checking, the answer is 42');
});

test('slash command does not arm', () => {
  const d = makeTurnDetector();
  d.warmUp();
  d.feed({ kind: 'user', text: '/clear', slash: true }); // slash is not a real prompt
  d.feed({ kind: 'assistant_text', text: 'cleared' });
  assert.equal(d.fire(), null);
});

test('title event does not reset the silence timer (feed returns false)', () => {
  const d = makeTurnDetector();
  d.warmUp();
  assert.equal(d.feed({ kind: 'title', title: 'x' }), false);
});
