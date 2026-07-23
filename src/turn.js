// src/turn.js — pure state machine (unit-testable, no timers) that detects "turn complete" from the transcript event stream.
// Background: after the watcher connects, the server replays the entire history (a burst). During warm-up (before warmUp),
// it only updates the title/body; it does not arm or fire, to avoid mistaking the last turn in history for one that "just finished" and pushing by mistake.
// After warm-up: only a real user prompt (not a slash command) "arms" it; after an assistant message it enters silence, timed by the caller,
// which calls fire() when the timer elapses: still armed and the last event is an assistant message → return the push payload and disarm.

function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

/** Create a turn detector. Timing is the caller's responsibility: when feed() returns true, (re)start the silence timer and call fire() when it elapses. */
function makeTurnDetector() {
  let warm = false, armed = false, lastKind = null, title = null, text = '';
  return {
    warmUp() { warm = true; },
    isWarm() { return warm; },
    isArmed() { return armed; },
    /** Feed one bubble event; returns true if there was activity and the caller should reset the silence timer (only after warm-up). */
    feed(ev) {
      if (!ev || !ev.kind) return false;
      if (ev.kind === 'title') { title = ev.title; return false; }        // a title change doesn't count as "activity"
      if (ev.kind === 'assistant_text') { text = norm(ev.text).slice(0, 120); lastKind = 'assistant_text'; }
      else if (ev.kind === 'user' && !ev.slash) { if (warm) armed = true; lastKind = 'user'; }
      else lastKind = ev.kind;
      return warm;
    },
    /** Called when the silence timer elapses: returns { title, text } and disarms if conditions are met, otherwise null. */
    fire() {
      if (armed && lastKind === 'assistant_text') { armed = false; return { title, text }; }
      return null;
    },
  };
}

module.exports = { makeTurnDetector };
