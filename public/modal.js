// public/modal.js — small in-app modal (prompt / confirm) matching the app's warm UI.
// Replaces native prompt()/confirm() so inputs follow the shared style. Self-injects its CSS once;
// exposes window.uiPrompt(opts) -> Promise<string|null> and window.uiConfirm(opts) -> Promise<bool>.
(function () {
  if (window.uiPrompt) return; // idempotent if included twice
  const CSS = `
  #uimodal { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px;
    background: rgba(20,18,14,.34); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }
  #uimodal .card { width: 100%; max-width: 360px; background: var(--card); border: 1px solid var(--border); border-radius: 16px;
    box-shadow: 0 10px 40px rgba(50,45,35,.22); padding: 18px 18px 14px; }
  #uimodal .t { font-family: var(--serif); font-size: 16px; font-weight: 600; color: var(--text); margin: 0 0 4px; }
  #uimodal .m { font-size: 13.5px; color: var(--muted); line-height: 1.5; margin: 2px 0 0; overflow-wrap: anywhere; }
  #uimodal input { width: 100%; margin-top: 12px; padding: 10px 13px; border-radius: 11px; background: var(--bg);
    border: 1px solid var(--border); color: var(--text); font: 15px var(--sans); outline: none; }
  #uimodal input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak); }
  #uimodal .err { color: #b4472e; font-size: 12px; margin-top: 6px; min-height: 0; }
  #uimodal .btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  #uimodal button { font: 500 14px var(--sans); border-radius: 999px; padding: 8px 18px; cursor: pointer; border: 1px solid var(--border); }
  #uimodal .cancel { background: transparent; color: var(--muted); }
  #uimodal .cancel:hover { background: var(--bg); }
  #uimodal .ok { background: var(--accent); color: #fff; border-color: var(--accent); }
  #uimodal .ok:hover { filter: brightness(1.04); }
  #uimodal .ok.danger { background: #b4472e; border-color: #b4472e; }`;

  function ensureCss() {
    if (document.getElementById('uimodal-css')) return;
    const s = document.createElement('style'); s.id = 'uimodal-css'; s.textContent = CSS; document.head.appendChild(s);
  }

  // Shared shell: builds the overlay, wires Enter/Esc/backdrop, resolves via done().
  function open(build) {
    ensureCss();
    return new Promise((resolve) => {
      const ov = document.createElement('div'); ov.id = 'uimodal';
      const card = document.createElement('div'); card.className = 'card'; ov.appendChild(card);
      let settled = false;
      const done = (v) => { if (settled) return; settled = true; document.removeEventListener('keydown', onKey, true); ov.remove(); resolve(v); };
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); done(ctx.cancelValue); }
        else if (e.key === 'Enter' && !e.shiftKey && ctx.onEnter) { e.preventDefault(); ctx.onEnter(); }
      }
      const ctx = { cancelValue: null, onEnter: null };
      build(card, done, ctx);
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(ctx.cancelValue); });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(ov);
      if (ctx.focus) setTimeout(() => { try { ctx.focus.focus(); ctx.focus.select && ctx.focus.select(); } catch (_) {} }, 20);
    });
  }

  // uiPrompt({title, message?, value?, placeholder?, ok?, validate?}) -> Promise<string|null>
  window.uiPrompt = function (opts) {
    opts = opts || {};
    return open((card, done, ctx) => {
      if (opts.title) { const t = document.createElement('div'); t.className = 't'; t.textContent = opts.title; card.appendChild(t); }
      if (opts.message) { const m = document.createElement('div'); m.className = 'm'; m.textContent = opts.message; card.appendChild(m); }
      const inp = document.createElement('input'); inp.value = opts.value || ''; if (opts.placeholder) inp.placeholder = opts.placeholder; card.appendChild(inp);
      const err = document.createElement('div'); err.className = 'err'; card.appendChild(err);
      const btns = document.createElement('div'); btns.className = 'btns';
      const cancel = document.createElement('button'); cancel.className = 'cancel'; cancel.textContent = 'Cancel';
      const ok = document.createElement('button'); ok.className = 'ok'; ok.textContent = opts.ok || 'OK';
      btns.appendChild(cancel); btns.appendChild(ok); card.appendChild(btns);
      const submit = () => {
        const v = inp.value.trim();
        if (opts.validate) { const msg = opts.validate(v); if (msg) { err.textContent = msg; return; } }
        done(v);
      };
      cancel.onclick = () => done(null);
      ok.onclick = submit;
      ctx.onEnter = submit; ctx.cancelValue = null; ctx.focus = inp;
    });
  };

  // uiConfirm({title, message?, ok?, danger?}) -> Promise<bool>
  window.uiConfirm = function (opts) {
    opts = opts || {};
    return open((card, done, ctx) => {
      if (opts.title) { const t = document.createElement('div'); t.className = 't'; t.textContent = opts.title; card.appendChild(t); }
      if (opts.message) { const m = document.createElement('div'); m.className = 'm'; m.textContent = opts.message; card.appendChild(m); }
      const btns = document.createElement('div'); btns.className = 'btns';
      const cancel = document.createElement('button'); cancel.className = 'cancel'; cancel.textContent = opts.cancel || 'Cancel';
      const ok = document.createElement('button'); ok.className = 'ok' + (opts.danger ? ' danger' : ''); ok.textContent = opts.ok || 'OK';
      btns.appendChild(cancel); btns.appendChild(ok); card.appendChild(btns);
      cancel.onclick = () => done(false);
      ok.onclick = () => done(true);
      ctx.onEnter = () => done(true); ctx.cancelValue = false; ctx.focus = ok;
    });
  };
})();
