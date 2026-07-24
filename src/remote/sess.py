
import json, os, glob, sys
base = os.path.expanduser('~/.claude/projects')
want = os.environ.get('SESSION', '').strip()
def _utext(o):
    m = o.get('message') or {}; c = m.get('content')
    if isinstance(c, str): return c.strip()
    if isinstance(c, list):
        for p in c:
            if isinstance(p, dict) and p.get('type') == 'text': return (p.get('text') or '').strip()
    return ''
out = []
for f in glob.glob(base + '/*/*.jsonl'):
    if os.sep + 'subagents' + os.sep in f: continue
    ai = cust = cwd = fu = None; ids = set(); n = 0
    try:
        with open(f, encoding='utf-8', errors='replace') as fh:
            for line in fh:
                line = line.strip()
                if not line or line[0] != '{': continue
                try: o = json.loads(line)
                except Exception: continue
                t = o.get('type')
                if t == 'ai-title': ai = o.get('aiTitle') or ai
                elif t == 'custom-title': cust = o.get('customTitle') or cust
                elif t == 'user' or t == 'assistant':
                    n += 1
                    if o.get('cwd') and cwd is None: cwd = o.get('cwd')   # first turn's cwd = where the session was launched → project (not where claude wandered to later)
                    # claude stores no title in the transcript, so fall back to the first real user
                    # prompt (skip system/command wrappers and the resume caveat) — like claude's own list.
                    if t == 'user' and fu is None and not o.get('isMeta'):
                        tx = _utext(o)
                        if tx and tx[0] != '<' and not tx.startswith('Caveat:'): fu = tx
                    if t == 'assistant':
                        mid = (o.get('message') or {}).get('id')
                        if mid: ids.add(mid)
    except Exception: continue
    if n == 0: continue
    title = cust or ai or fu or '(untitled)'
    title = ' '.join(title.split())
    if len(title) > 60: title = title[:57] + '...'
    out.append({'id': os.path.basename(f)[:-6], 'title': title, 'n': n, 'mtime': os.path.getmtime(f), 'cwd': cwd or '', '_ids': sorted(ids), '_f': f})
# Dedup resume-chains: resuming a session replays its messages into a new file, so the old file's
# id-set is a subset of the new one — drop the subset (keep the live continuation).
# BUT a fork ALSO copies its parent's ids then diverges, and there both branches are real. Since the
# transcript doesn't distinguish the two, the switcher records the ids of forks it creates; a fork is
# never allowed to "cover" (drop) another session, so a fork and its parent both survive.
forks = set()
try:
    with open(os.path.expanduser('~/.switcher/forks.json')) as ff: _fk = json.load(ff)
    forks = set(_fk.keys()) if isinstance(_fk, dict) else set(_fk)
except Exception: forks = set()
out.sort(key=lambda s: len(s['_ids']))
keep = []
for i, s in enumerate(out):
    si = set(s['_ids']); covered = False
    if si:
        for j in range(i + 1, len(out)):
            if out[j]['id'] in forks: continue
            if si.issubset(set(out[j]['_ids'])): covered = True; break
    if not covered: keep.append(s)
keep.sort(key=lambda s: s['mtime'], reverse=True)
files = {s['id']: s['_f'] for s in keep}
# switcher-side display-name overrides (claude has no post-hoc rename CLI)
names = {}
try:
    with open(os.path.expanduser('~/.switcher/names.json')) as nf: names = json.load(nf)
except Exception: names = {}
home = os.path.expanduser('~')
# main = newest session whose cwd == $HOME (the default click-in), else newest overall; can't be deleted.
home_sess = [s for s in keep if s.get('cwd') == home]
pool = home_sess if home_sess else keep
main_id = max(pool, key=lambda s: s['mtime'])['id'] if pool else None
def _proj(c):
    if not c: return '(unknown)'
    if c == home: return '~'
    return os.path.basename(c.rstrip('/')) or c
listing = [{'id': s['id'], 'title': names.get(s['id']) or s['title'], 'n': s['n'], 'mtime': int(s['mtime']),
            'cwd': s.get('cwd', ''), 'project': _proj(s.get('cwd', '')), 'main': s['id'] == main_id} for s in keep]
print('##SESSIONS##' + json.dumps(listing, ensure_ascii=False)); sys.stdout.flush()
if os.environ.get('LIST_ONLY'): sys.exit(0)  # enumerate-only (for /api/sessions); skip the tail
target = files.get(want) if want else None
if os.environ.get('FRESH'):  # new session: follow the "latest" file (even if it has no messages yet)
    allf = [g for g in glob.glob(base + '/*/*.jsonl') if os.sep + 'subagents' + os.sep not in g]
    if allf: target = max(allf, key=os.path.getmtime)
if not target and keep: target = keep[0]['_f']
if not target:
    print('##NO_TRANSCRIPT##'); sys.stdout.flush(); sys.exit(0)
sys.stdout.flush()
os.execvp('tail', ['tail', '-n', '1500', '-F', target])  # only pull the last 1500 lines, so very long sessions aren't too heavy to start
