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

// Nothing is written to a transcript while a tool runs, so a long call looks
// exactly like a finished session if all you have is the file's mtime.
test('a tool call still out means working, however long the file has sat still', (t) => {
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
    message: { id: 'm' + id, model: 'opus',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 300' } }] } }) + '\n';
  const result = (id, at) => JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }) + '\n';

  // three sessions, none of them written to for five minutes
  const long = Date.now() - 5 * 60e3;
  const write = (name, body, mtime) => {
    const fp = path.join(dir, name + '.jsonl');
    fs.writeFileSync(fp, body);
    fs.utimesSync(fp, new Date(mtime), new Date(mtime));   // pretend it went quiet
    return fp;
  };
  write('aaa', call('t1', Date.now() - 90e3), long);                    // call still out, started 90s ago
  write('bbb', call('t2', long) + result('t2', long), long);            // call came back, then silence
  write('ccc', call('t3', Date.now() - 40 * 60e3), Date.now() - 40 * 60e3);  // killed mid-call, 40min ago

  const by = new Map(new Project(root).list().sessions.map(s => [s.id, s]));
  assert.equal(by.get('aaa').active, true,
    'a tool call running for 90s read as idle — the file has not moved, but the work has not stopped');
  assert.equal(by.get('bbb').active, false, 'a finished session should not read as working');
  assert.equal(by.get('ccc').active, false,
    'a session killed mid-call would claim to be working for ever');
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
  assert.equal(p.base, fs.realpathSync(repo), 'the repository is the extent');
  assert.ok(p.dir.includes(slugOf(started)), 'transcripts are still found by the recorded folder');

  return p.universe().then(u => {
    assert.equal(u.source, 'git');
    assert.deepEqual(u.files.slice().sort(), ['README.md', 'bin/cli.js', 'lib/core.js'],
      'named from the repository root, and the whole of it — not just bin/');
  });
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
