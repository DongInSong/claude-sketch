// node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Project, listProjects, configDir, slugOf } from '../lib/project.js';

// Claude Code reads CLAUDE_CONFIG_DIR for where it keeps everything, and the
// CLI, the desktop app and the IDE extensions are the same binary — so all of
// them honour it. Reading ~/.claude regardless meant claude-sketch reported "no
// sessions" on a machine that was full of them.
test('CLAUDE_CONFIG_DIR decides where the transcripts are looked for', (t) => {
  const was = process.env.CLAUDE_CONFIG_DIR;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cfg-'));
  t.after(() => {
    if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = was;
    fs.rmSync(home, { recursive: true, force: true });
  });

  delete process.env.CLAUDE_CONFIG_DIR;
  assert.equal(configDir(), path.join(os.homedir(), '.claude'), 'default is still ~/.claude');

  process.env.CLAUDE_CONFIG_DIR = home;
  assert.equal(configDir(), home);

  // a transcript sitting under the overridden dir has to be found
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(home, 'projects', slugOf(root));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sess.jsonl'),
    JSON.stringify({ type: 'user', cwd: root, timestamp: '2026-01-01T00:00:00Z',
      message: { content: 'hello' } }) + '\n');

  assert.equal(new Project(root).dir, dir, 'Project looked in the wrong place');
  const found = listProjects().find(p => p.root === path.resolve(root));
  assert.ok(found, 'listProjects did not see a project under the overridden dir');
  assert.equal(found.sessions, 1);
});

// Nothing is written to a transcript while a tool runs or the model thinks, so
// a busy session looks exactly like a finished one if all you have is the file's
// mtime. "Working" is read from whose turn it is: the assistant owes output —
// from a prompt or a tool result until it writes an end_turn — even when the
// file has gone perfectly quiet. Only an end_turn (or a turn abandoned so long
// it must be a crash) is idle.
test('working is read from whose turn it is, not from the file clock', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-busy-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-busyroot-'));
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  t.after(() => {
    if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = was;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  const dir = path.join(home, 'projects', slugOf(root));
  fs.mkdirSync(dir, { recursive: true });
  const call = (id, at) => JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(),
    message: { id: 'm' + id, model: 'opus', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 300' } }] } }) + '\n';
  const result = (id, at) => JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }) + '\n';
  const answer = (at) => JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(),
    message: { id: 'a' + at, model: 'opus', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'done' }] } }) + '\n';
  const prompt = (at) => JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(),
    message: { role: 'user', content: 'do the thing' } }) + '\n';

  const now = Date.now();
  const mins = (n) => now - n * 60e3;
  const write = (name, body, mtime) => {
    const fp = path.join(dir, name + '.jsonl');
    fs.writeFileSync(fp, body);
    fs.utimesSync(fp, new Date(mtime), new Date(mtime));   // pretend it went quiet
    return fp;
  };
  // a tool call still out — a long Bash, quiet 5min but the call has not returned
  write('open-call', call('t1', now - 90e3), mins(5));
  // a tool result came back, then quiet: the assistant is thinking about it (the
  // false-idle this whole change is about — a Sublimating turn with no writes)
  write('thinking', call('t2', mins(2)) + result('t2', mins(2)), mins(2));
  // a fresh prompt with no reply yet, quiet 2min: thinking before its first tool
  write('from-prompt', prompt(mins(2)), mins(2));
  // the assistant answered and stopped — genuinely finished, quiet 5min
  write('finished', call('t3', mins(5)) + result('t3', mins(5)) + answer(mins(5)), mins(5));
  // just wrote end_turn this instant: the file is fresh, but the turn is over —
  // mtime alone read this as busy for a further 45s
  write('just-done', call('t4', now - 3e3) + result('t4', now - 2e3) + answer(now - 1e3), now);
  // a turn left open far too long to be a think — a crash mid-turn
  write('abandoned', call('t5', mins(40)) + result('t5', mins(40)), mins(40));

  const by = new Map(new Project(root).list().sessions.map(s => [s.id, s]));
  assert.equal(by.get('open-call').active, true,
    'a tool call running for 90s read as idle — the file has not moved, but the work has not stopped');
  assert.equal(by.get('thinking').active, true,
    'a turn owing a reply after a tool result read as idle — that is exactly the Sublimating-but-idle bug');
  assert.equal(by.get('from-prompt').active, true,
    'a prompt with no reply yet read as idle while the assistant was thinking toward its first tool call');
  assert.equal(by.get('finished').active, false, 'a session that wrote end_turn should not read as working');
  assert.equal(by.get('just-done').active, false,
    'a turn that just ended still read as busy — the end_turn only just moved the file');
  assert.equal(by.get('abandoned').active, false,
    'a turn left open for 40min is a crash, not a think, and would claim to be working for ever');
});

// Claude Code records the folder it was started in, which is often a corner of
// the repository. That folder stays the session's identity; the repository is
// what a path is named against.
test('a session started below its repository still sees the whole of it', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-repo-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a],
    { stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  git('init', '-q');
  git('config', 'user.email', 'probe@example.com');
  git('config', 'user.name', 'probe');
  for (const d of ['bin', 'lib']) fs.mkdirSync(path.join(repo, d));
  fs.writeFileSync(path.join(repo, 'bin', 'cli.js'), '//\n');
  fs.writeFileSync(path.join(repo, 'lib', 'core.js'), '//\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '#\n');
  git('add', '-A');
  git('commit', '-qm', 'first');

  const started = path.join(repo, 'bin');
  const p = new Project(started);
  assert.equal(p.root, started, 'the recorded folder is still what identifies the session');
  assert.ok(p.dir.includes(slugOf(started)), 'transcripts are still found by the recorded folder');
  // Checked by what is at the path, not by how it is spelled: on Windows
  // os.tmpdir() hands back the 8.3 short name and git reports the long one, and
  // the two strings differ while naming the same folder.
  assert.notEqual(p.base, p.root, 'the extent moved up out of bin/');
  assert.ok(fs.existsSync(path.join(p.base, 'lib', 'core.js')), 'and it is the repository');

  return p.universe().then(u => {
    assert.equal(u.source, 'git');
    assert.deepEqual(u.files.slice().sort(), ['README.md', 'bin/cli.js', 'lib/core.js'],
      'named from the repository root, and the whole of it — not just bin/');
  });
});

// Claude Code fixes the transcript folder from the directory it started in and
// never moves it, so "go and work in the other worktree" leaves the record in one
// place and the work in another.
test('a session that went to work elsewhere is read against where it went', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-stray-'));
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  t.after(() => {
    if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = was;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const mkRepo = (name, files) => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-' + name + '-'));
    t.after(() => fs.rmSync(r, { recursive: true, force: true }));
    const git = (...a) => execFileSync('git', ['-C', r, ...a], { stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    git('init', '-q');
    git('config', 'user.email', 'p@e'); git('config', 'user.name', 'p');
    for (const f of files) {
      fs.mkdirSync(path.join(r, path.dirname(f)), { recursive: true });
      fs.writeFileSync(path.join(r, f), '//\n');
    }
    git('add', '-A'); git('commit', '-qm', 'i');
    return fs.realpathSync(r);
  };
  const started = mkRepo('here', ['a.js']);
  const went = mkRepo('there', ['src/one.js', 'src/two.js', 'lib/three.js']);

  const dir = path.join(home, 'projects', slugOf(started));
  fs.mkdirSync(dir, { recursive: true });
  const line = (fp) => JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z',
    message: { id: 'm' + fp, model: 'opus',
      content: [{ type: 'tool_use', id: 't' + fp, name: 'Read', input: { file_path: fp } }] } }) + '\n';
  // one touch at home, and the rest of the session spent in the other repository,
  // spread over its folders the way real work is
  fs.writeFileSync(path.join(dir, 'moved.jsonl'),
    line(path.join(started, 'a.js'))
    + ['src/one.js', 'src/two.js', 'lib/three.js'].map(f => line(path.join(went, f))).join(''));
  fs.writeFileSync(path.join(dir, 'stayed.jsonl'), line(path.join(started, 'a.js')));

  const p = new Project(started);
  // again by what is there rather than how it is spelled
  assert.ok(fs.existsSync(path.join(p.baseFor('moved'), 'src', 'one.js')),
    'followed the work into the other repository');
  assert.ok(!fs.existsSync(path.join(p.baseFor('stayed'), 'src', 'one.js')),
    'nothing to follow, so it stays');
  assert.ok(fs.existsSync(path.join(p.baseFor('stayed'), 'a.js')));

  return p.universe('moved').then(u => {
    assert.deepEqual(u.files.slice().sort(), ['lib/three.js', 'src/one.js', 'src/two.js'],
      'the file list is the repository the session actually worked in');
  });
});

// A long session opens with its own working papers — a plan, a memory note, a
// couple of scratch files — and only then gets to work. Judged on its opening
// alone, the biggest session measured on this machine put its real repository at
// 45% of 22 paths where the whole file put it at 71% of 504, lost the vote, and
// was read against a tree it had left: coverage 0 of 34, and the page reporting
// work "outside this project" for a project it never left.
test('a session is judged on what it did, not on how it opened', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ends-'));
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  t.after(() => {
    if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = was;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const mkRepo = (name, files) => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-' + name + '-'));
    t.after(() => fs.rmSync(r, { recursive: true, force: true }));
    const git = (...a) => execFileSync('git', ['-C', r, ...a], { stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    git('init', '-q');
    git('config', 'user.email', 'p@e'); git('config', 'user.name', 'p');
    for (const f of files) {
      fs.mkdirSync(path.join(r, path.dirname(f)), { recursive: true });
      fs.writeFileSync(path.join(r, f), '//\n');
    }
    git('add', '-A'); git('commit', '-qm', 'i');
    return fs.realpathSync(r);
  };
  const started = mkRepo('open-here', ['a.js']);
  const went = mkRepo('open-there', ['src/one.js', 'src/two.js', 'lib/three.js']);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-scratch-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  const read = (fp) => JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z',
    message: { id: 'm' + fp, model: 'opus',
      content: [{ type: 'tool_use', id: 't' + fp, name: 'Read', input: { file_path: fp } }] } }) + '\n';
  // a megabyte of talk between the two ends, so the middle is what gets skipped
  const filler = JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z',
    message: { id: 'pad', model: 'opus', content: [{ type: 'text', text: 'x'.repeat(4096) }] } }) + '\n';

  const dir = path.join(home, 'projects', slugOf(started));
  fs.mkdirSync(dir, { recursive: true });
  const head = read(path.join(started, 'a.js'))
    + read(path.join(home, 'plans', 'the-plan.md'))
    + read(path.join(scratch, 'notes.txt'))
    + read(path.join(scratch, 'out.json'));
  const tail = ['src/one.js', 'src/two.js', 'lib/three.js', 'src/one.js']
    .map(f => read(path.join(went, f))).join('');
  fs.writeFileSync(path.join(dir, 'late.jsonl'),
    head + filler.repeat(1400) + tail);          // ~5.7MB: both ends read, middle skipped

  const p = new Project(started);
  const base = p.baseFor('late');
  assert.ok(fs.existsSync(path.join(base, 'src', 'one.js')),
    'the work at the end counts, not just the papers at the start');
  // the transcript folder and a scratch directory are not candidates: one is the
  // session writing about itself, the other is no repository at all
  assert.ok(!base.startsWith(home) && !base.startsWith(scratch));
});

// Finding the repository by asking git meant asking it from inside the folder in
// question, and a folder deleted since — or belonging to a branch not checked
// out — cannot be stood in. git failed there, the path was left standing as its
// own root, and the work done in it dropped out of the vote. Measured across the
// 358 directories the transcripts on this machine name, 29 of them were in that
// state: the folder is gone, the repository it was part of is not.
test('work in a folder that has since gone still counts for its repository', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-gone-'));
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  t.after(() => {
    if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = was;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const mkRepo = (name, files) => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-' + name + '-'));
    t.after(() => fs.rmSync(r, { recursive: true, force: true }));
    const git = (...a) => execFileSync('git', ['-C', r, ...a], { stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    git('init', '-q');
    git('config', 'user.email', 'p@e'); git('config', 'user.name', 'p');
    for (const f of files) {
      fs.mkdirSync(path.join(r, path.dirname(f)), { recursive: true });
      fs.writeFileSync(path.join(r, f), '//\n');
    }
    git('add', '-A'); git('commit', '-qm', 'i');
    return fs.realpathSync(r);
  };
  const started = mkRepo('gone-here', ['a.js']);
  const went = mkRepo('gone-there', ['kept.js', 'old/one.js', 'old/two.js', 'old/three.js']);

  const read = (fp) => JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z',
    message: { id: 'm' + fp, model: 'opus',
      content: [{ type: 'tool_use', id: 't' + fp, name: 'Read', input: { file_path: fp } }] } }) + '\n';
  const dir = path.join(home, 'projects', slugOf(started));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'vanished.jsonl'),
    read(path.join(started, 'a.js'))
    + ['old/one.js', 'old/two.js', 'old/three.js'].map(f => read(path.join(went, f))).join(''));

  // the session finished, and then the folder it worked in was deleted
  fs.rmSync(path.join(went, 'old'), { recursive: true, force: true });

  const p = new Project(started);
  assert.equal(p.baseFor('vanished'), went,
    'the folder is gone, the repository it was part of is not');
});

// Claude Code is often run in a worktree, or in a container, and the folder it
// recorded itself against is not always still there afterwards. Widening a gone
// folder to the repository above it hands the session a file list it can never
// match — measured on this machine, 4 of 30 projects are deleted worktrees, and
// every one of them then reported the work as happening outside the project.
test('a folder that is gone is not widened to the repository above it', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-wt-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  git('init', '-q');
  git('config', 'user.email', 'p@e'); git('config', 'user.name', 'p');
  fs.writeFileSync(path.join(repo, 'kept.js'), '//\n');
  git('add', '-A'); git('commit', '-qm', 'i');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-wth-'));
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  t.after(() => {
    if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = was;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const live = path.join(fs.realpathSync(repo), 'wt', 'task_1');
  fs.mkdirSync(path.join(live, 'src'), { recursive: true });
  assert.equal(new Project(live).base, fs.realpathSync(repo),
    'a folder that is there is read against the repository holding it');

  // the session worked inside the worktree, and named it
  const dir = path.join(home, 'projects', slugOf(live));
  fs.mkdirSync(dir, { recursive: true });
  const read = (fp) => JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z',
    message: { id: 'm' + fp, model: 'opus',
      content: [{ type: 'tool_use', id: 't' + fp, name: 'Read', input: { file_path: fp } }] } }) + '\n';
  fs.writeFileSync(path.join(dir, 'inwt.jsonl'),
    ['src/a.js', 'src/b.js', 'src/c.js'].map(f => read(path.join(live, f))).join(''));

  fs.rmSync(path.join(repo, 'wt'), { recursive: true, force: true });
  const p = new Project(live);
  assert.equal(p.base, live, 'gone, so there is nothing to widen to');
  // and sorting its own paths must not climb out either: the worktree took its
  // .git file with it, so nothing stops the walk but the recorded folder itself
  assert.equal(p.baseFor('inwt'), live,
    'a path inside the recorded folder belongs to it, whatever is above');
  return p.universe('inwt').then(u => {
    assert.deepEqual(u.files, [],
      'and no file list — borrowing the parent repository\'s would be a denominator nothing can match');
  });
});

// Windows and macOS are case-insensitive, and a transcript may spell a path any
// way it likes — lib/parser.js has allowed for that since it started matching
// paths against the root. The comparisons in project.js decide whether a path is
// inside the folder the session was recorded against, and spelled differently
// they used to say no: the floor stopped applying and a deleted worktree climbed
// back out into its parent, which is the thing the floor exists to prevent.
//
// Only meaningful where the filesystem agrees. On Linux the two spellings really
// are two folders, so there is nothing to fold and nothing to check.
test('a path spelled in another case is still inside the recorded folder', (t) => {
  const CASE_BLIND = process.platform === 'win32' || process.platform === 'darwin';
  if (!CASE_BLIND) return t.skip('case-sensitive filesystem: the two spellings are two folders');

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-case-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  git('init', '-q');
  git('config', 'user.email', 'p@e'); git('config', 'user.name', 'p');
  fs.writeFileSync(path.join(repo, 'kept.js'), '//\n');
  git('add', '-A'); git('commit', '-qm', 'i');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-caseh-'));
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  t.after(() => {
    if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = was;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const wt = path.join(fs.realpathSync(repo), 'wt', 'task_1');
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true });

  // the transcript names the same folder in a different case, as a user-typed or
  // shell-completed path on these platforms routinely does
  const shouted = wt.toUpperCase();
  assert.notEqual(shouted, wt, 'the fixture has to differ in case for this to test anything');
  const dir = path.join(home, 'projects', slugOf(wt));
  fs.mkdirSync(dir, { recursive: true });
  const read = (fp) => JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z',
    message: { id: 'm' + fp, model: 'opus',
      content: [{ type: 'tool_use', id: 't' + fp, name: 'Read', input: { file_path: fp } }] } }) + '\n';
  fs.writeFileSync(path.join(dir, 'shout.jsonl'),
    ['src\\a.js', 'src\\b.js', 'src\\c.js'].map(f => read(path.join(shouted, f))).join(''));

  fs.rmSync(path.join(repo, 'wt'), { recursive: true, force: true });
  const p = new Project(wt);
  assert.equal(p.baseFor('shout'), wt,
    'the floor holds however the path is spelled');
});

test('without a repository the folder is the whole of it', (t) => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-plain-'));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  const p = new Project(plain);
  assert.equal(p.base, p.root, 'nothing to widen to, so nothing changes');
});

// A file Claude just wrote belongs to the project the moment it exists, not once
// someone runs git add. What keeps that from also meaning "and all of
// node_modules" is --exclude-standard, so that is the half worth a test.
test('the file universe counts untracked files but not ignored ones', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-univ-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-C', root, ...a],
    { stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });

  git('init', '-q');
  git('config', 'user.email', 'probe@example.com');
  git('config', 'user.name', 'probe');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(root, 'tracked.js'), '//\n');
  git('add', '.gitignore', 'tracked.js');
  git('commit', '-qm', 'first');

  fs.writeFileSync(path.join(root, 'just-written.js'), '//\n');       // untracked, not ignored
  fs.mkdirSync(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
  for (let i = 0; i < 50; i++)                                        // ignored, and plenty of it
    fs.writeFileSync(path.join(root, 'node_modules', 'left-pad', `f${i}.js`), '//\n');

  const u = await new Project(root).universe();
  assert.equal(u.source, 'git');
  assert.ok(u.files.includes('tracked.js'), 'lost a tracked file');
  assert.ok(u.files.includes('just-written.js'), 'a new file is invisible until git add');
  assert.equal(u.files.filter(f => f.includes('node_modules')).length, 0,
    'ignored files leaked into the project file list');
  assert.equal(u.truncated, undefined);
  assert.equal(u.total, u.files.length);
});

// Claude Code writes local slash-command records into a transcript on the user
// role — a caveat (isMeta), then <command-name>/<local-command-stdout> lines
// whose text is pure wrapper — and it does this to sessions that finished long
// ago, refreshing the mtime. They are neither turns nor prompts: taken as a
// turn, a dead session read as working; taken as a title, the real prompt was
// hidden and the panel fell back to the session id.
test('local-command records are neither a turn nor a title', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cmd-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cmdroot-'));
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  t.after(() => {
    if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = was;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dir = path.join(home, 'projects', slugOf(root));
  fs.mkdirSync(dir, { recursive: true });

  const now = Date.now();
  const iso = (at) => new Date(at).toISOString();
  const prompt = (at, text) => JSON.stringify({ type: 'user', timestamp: iso(at),
    message: { role: 'user', content: text } }) + '\n';
  const answer = (at) => JSON.stringify({ type: 'assistant', timestamp: iso(at),
    message: { id: 'a' + at, model: 'opus', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }) + '\n';
  const caveat = (at) => JSON.stringify({ type: 'user', isMeta: true, timestamp: iso(at),
    message: { role: 'user', content: '<local-command-caveat>Caveat: generated while running local commands. DO NOT respond.</local-command-caveat>' } }) + '\n';
  const cmd = (at) => JSON.stringify({ type: 'user', timestamp: iso(at),
    message: { role: 'user', content: '<command-name>/design-login</command-name>\n<command-args></command-args>' } }) + '\n';
  const cmdOut = (at) => JSON.stringify({ type: 'user', timestamp: iso(at),
    message: { role: 'user', content: '<local-command-stdout>Design-system access authorized.</local-command-stdout>' } }) + '\n';

  const write = (name, body, mtime) => {
    const fp = path.join(dir, name + '.jsonl');
    fs.writeFileSync(fp, body);
    fs.utimesSync(fp, new Date(mtime), new Date(mtime));
  };
  // finished 40min ago (prompt → end_turn), then command records land 1min ago —
  // fresh mtime, but the session is done and its title is the prompt.
  write('finished', prompt(now - 40 * 60e3, 'real question here') + answer(now - 40 * 60e3 + 1000)
    + caveat(now - 60e3) + cmd(now - 60e3) + cmdOut(now - 60e3), now - 60e3);
  // a session that only ever ran a command — no real turn at all
  write('cmdonly', caveat(now - 60e3) + cmd(now - 60e3) + cmdOut(now - 60e3), now - 60e3);

  const by = new Map(new Project(root).list().sessions.map(s => [s.id, s]));
  assert.equal(by.get('finished').active, false,
    'a finished session read as working because a fresh local-command record looked like a new turn');
  assert.equal(by.get('finished').title, 'real question here',
    'the command record hid the real prompt, so the panel fell back to the id');
  assert.equal(by.get('cmdonly').active, false,
    'a command-only session has no real turn and is not working');
});
