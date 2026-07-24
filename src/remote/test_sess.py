#!/usr/bin/env python3
"""Tests for sess.py (the remote session enumerator).

Runs the real script against a temp HOME full of fixture transcripts and checks the emitted
##SESSIONS## JSON. Covers the logic that has actually broken before: resume-chain dedup,
fork keep-both, first-user-message titles, and names.json overrides.

Run: python3 src/remote/test_sess.py
"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SESS = os.path.join(HERE, 'sess.py')


def write_session(root, slug, sid, cwd, user_text, asst_ids, mtime):
    d = os.path.join(root, '.claude', 'projects', slug)
    os.makedirs(d, exist_ok=True)
    lines = [json.dumps({'type': 'user', 'cwd': cwd, 'message': {'role': 'user', 'content': user_text}})]
    for i in asst_ids:
        lines.append(json.dumps({'type': 'assistant', 'cwd': cwd,
                                 'message': {'id': i, 'role': 'assistant', 'content': [{'type': 'text', 'text': 'ok'}]}}))
    p = os.path.join(d, sid + '.jsonl')
    with open(p, 'w') as f:
        f.write('\n'.join(lines) + '\n')
    os.utime(p, (mtime, mtime))


def run(root, forks=None, names=None):
    if forks is not None or names is not None:
        os.makedirs(os.path.join(root, '.switcher'), exist_ok=True)
    if forks is not None:
        with open(os.path.join(root, '.switcher', 'forks.json'), 'w') as f:
            json.dump(forks, f)
    if names is not None:
        with open(os.path.join(root, '.switcher', 'names.json'), 'w') as f:
            json.dump(names, f)
    env = dict(os.environ, HOME=root, LIST_ONLY='1')
    out = subprocess.run([sys.executable, SESS], env=env, capture_output=True, text=True, timeout=30).stdout
    line = next(l for l in out.splitlines() if '##SESSIONS##' in l)
    return json.loads(line.split('##SESSIONS##', 1)[1])


def test_title_from_first_user_message():
    with tempfile.TemporaryDirectory() as root:
        # cwd == HOME (the temp root here) => project "~" and this is the (protected) main session
        write_session(root, '-home', 'a', root, 'hello world', ['m1', 'm2'], 1000)
        s = run(root, forks={})
        assert len(s) == 1 and s[0]['title'] == 'hello world', s
        assert s[0]['project'] == '~' and s[0]['main'] is True, s
    print('ok: title from first user message; home cwd => project ~ and main')


def test_resume_chain_collapses_to_newest_superset():
    with tempfile.TemporaryDirectory() as root:
        write_session(root, '-home-coder-proj', 'c1', '/home/coder/proj', 'start', ['x1', 'x2'], 1000)
        write_session(root, '-home-coder-proj', 'c2', '/home/coder/proj', 'start', ['x1', 'x2', 'x3'], 2000)
        s = run(root, forks={})
        assert [x['id'] for x in s] == ['c2'], s  # c1 is a subset of c2 => dropped
        assert s[0]['project'] == 'proj', s
    print('ok: resume-chain collapses (subset dropped)')


def test_fork_and_parent_both_kept():
    with tempfile.TemporaryDirectory() as root:
        write_session(root, '-home-coder-fk', 'par', '/home/coder/fk', 'q', ['p1', 'p2'], 1000)
        write_session(root, '-home-coder-fk', 'frk', '/home/coder/fk', 'q', ['p1', 'p2', 'p3'], 2000)
        s = run(root, forks={'frk': 'par'})  # frk marked as a fork
        assert sorted(x['id'] for x in s) == ['frk', 'par'], s  # fork must not cover its parent
    print('ok: marked fork + parent both survive')


def test_unmarked_superset_collapses_like_resume():
    with tempfile.TemporaryDirectory() as root:
        write_session(root, '-home-coder-fk', 'par', '/home/coder/fk', 'q', ['p1', 'p2'], 1000)
        write_session(root, '-home-coder-fk', 'frk', '/home/coder/fk', 'q', ['p1', 'p2', 'p3'], 2000)
        s = run(root, forks={})  # not marked => treated as a resume-chain
        assert [x['id'] for x in s] == ['frk'], s
    print('ok: unmarked superset collapses (resume semantics)')


def test_legacy_array_forks_json_is_tolerated():
    with tempfile.TemporaryDirectory() as root:
        write_session(root, '-home-coder-fk', 'par', '/home/coder/fk', 'q', ['p1', 'p2'], 1000)
        write_session(root, '-home-coder-fk', 'frk', '/home/coder/fk', 'q', ['p1', 'p2', 'p3'], 2000)
        s = run(root, forks=['frk'])  # legacy list form (should still mark frk a fork)
        assert sorted(x['id'] for x in s) == ['frk', 'par'], s
    print('ok: legacy array forks.json still works')


def test_names_json_overrides_title():
    with tempfile.TemporaryDirectory() as root:
        write_session(root, '-home-coder', 'a', '/home/coder', 'hello', ['m1'], 1000)
        s = run(root, forks={}, names={'a': 'Renamed'})
        assert s[0]['title'] == 'Renamed', s
    print('ok: names.json overrides the derived title')


def test_system_wrapper_first_message_is_skipped():
    with tempfile.TemporaryDirectory() as root:
        d = os.path.join(root, '.claude', 'projects', '-home-coder')
        os.makedirs(d)
        lines = [
            json.dumps({'type': 'user', 'cwd': '/home/coder', 'message': {'role': 'user', 'content': '<command-name>/clear</command-name>'}}),
            json.dumps({'type': 'user', 'cwd': '/home/coder', 'message': {'role': 'user', 'content': 'real question here'}}),
            json.dumps({'type': 'assistant', 'cwd': '/home/coder', 'message': {'id': 'm1', 'role': 'assistant', 'content': [{'type': 'text', 'text': 'ok'}]}}),
        ]
        with open(os.path.join(d, 'a.jsonl'), 'w') as f:
            f.write('\n'.join(lines) + '\n')
        s = run(root, forks={})
        assert s[0]['title'] == 'real question here', s  # skipped the <command-…> wrapper
    print('ok: leading system/command wrapper skipped for title')


if __name__ == '__main__':
    tests = [v for k, v in sorted(globals().items()) if k.startswith('test_')]
    for t in tests:
        t()
    print('\nALL %d PASS' % len(tests))
