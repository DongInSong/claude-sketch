// node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
