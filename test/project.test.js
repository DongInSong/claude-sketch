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
