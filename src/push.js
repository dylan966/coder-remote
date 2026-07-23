// src/push.js — Web Push (VAPID) wrapper: keys, subscription persistence, sending.
// If web-push is missing or the keys are unavailable, the whole module degrades to enabled=false; all operations become no-ops and don't affect the main service.
const fs = require('fs');
const path = require('path');
const os = require('os');

let webpush = null;
try { webpush = require('web-push'); } catch (_) { webpush = null; }

const DIR = path.join(os.homedir(), '.switcher');
const VAPID_FILE = path.join(DIR, 'vapid.json');
const SUBS_FILE = path.join(DIR, 'subs.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, val) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(val)); } catch (e) { console.error('[push] write', file, e.message); }
}

let vapid = null;
let enabled = false;
if (webpush) {
  // Generate a VAPID keypair on first boot and persist it locally (~/.switcher/vapid.json).
  // The hub is otherwise stateless; if this file is lost (workspace recreated), a new keypair is
  // generated and the frontend silently re-subscribes to the new key on its next load (key-aware
  // resubscribe in chat.js), so no coder secret is needed and no permission re-prompt occurs.
  vapid = readJson(VAPID_FILE, null);
  if (!vapid || !vapid.publicKey || !vapid.privateKey) {
    try { vapid = webpush.generateVAPIDKeys(); writeJson(VAPID_FILE, vapid); } catch (e) { console.error('[push] vapid gen', e.message); vapid = null; }
  }
  if (vapid) {
    // a mailto placeholder is fine for the subject; browser push services only require it to be present.
    try { webpush.setVapidDetails('mailto:switcher@example.com', vapid.publicKey, vapid.privateKey); enabled = true; } catch (e) { console.error('[push] setVapid', e.message); }
  }
}
if (!enabled) console.log('[push] disabled (web-push not installed or keys unavailable)');

let subs = readJson(SUBS_FILE, []);
if (!Array.isArray(subs)) subs = [];
const changeCbs = [];
function persist() { writeJson(SUBS_FILE, subs); }
function fireChange() { for (const cb of changeCbs) { try { cb(); } catch (_) {} } }

/** Subscription-change (add/remove) callback, used by the server to rebuild watchers. */
function onSubsChange(cb) { changeCbs.push(cb); }
/** VAPID public key (for frontend subscription); returns null when disabled. */
function getPublicKey() { return enabled && vapid ? vapid.publicKey : null; }
function isEnabled() { return enabled; }

/** Record a subscription (dedup by endpoint, updating its ws binding). */
function subscribe(ws, sub) {
  if (!enabled || !ws || !sub || !sub.endpoint) return false;
  subs = subs.filter((s) => s.sub.endpoint !== sub.endpoint);
  subs.push({ ws, sub });
  persist(); fireChange();
  return true;
}
/** Remove a subscription by endpoint. */
function unsubscribe(endpoint) {
  const before = subs.length;
  subs = subs.filter((s) => s.sub.endpoint !== endpoint);
  if (subs.length !== before) { persist(); fireChange(); }
  return before !== subs.length;
}
/** Set of workspace names that currently have subscriptions (deduplicated). */
function wsWithSubs() { return [...new Set(subs.map((s) => s.ws))]; }

/** Push a payload to all subscriptions of a workspace; dead endpoints (404/410) are cleared automatically. */
async function notify(ws, payload) {
  if (!enabled) return;
  const targets = subs.filter((s) => s.ws === ws);
  const body = JSON.stringify(payload);
  const dead = [];
  await Promise.all(targets.map(async (t) => {
    try { await webpush.sendNotification(t.sub, body); }
    catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.push(t.sub.endpoint); else console.error('[push] send', e && e.message); }
  }));
  if (dead.length) { subs = subs.filter((s) => !dead.includes(s.sub.endpoint)); persist(); fireChange(); }
}

module.exports = { isEnabled, getPublicKey, subscribe, unsubscribe, wsWithSubs, notify, onSubsChange };
