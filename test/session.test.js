// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../lib/session.js';

const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cs-session-'));

// one assistant record: a tool call and the tokens it cost, the way a transcript
// carries them together
const line = (id, file, tok) => JSON.stringify({
  type: 'assistant', timestamp: '2026-01-01T00:00:00Z',
  message: { id: 'm-' + id, model: 'opus',
    usage: { input_tokens: tok, output_tokens: tok },
    content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/r/' + file } }] },
}) + '\n';

const opened = (dir) => {
  const s = new Session({ id: 'sess', dir, root: '/r' });
  return { s, fp: path.join(dir, 'sess.jsonl'),
    files: () => s.events.filter(e => e.t === 'op').map(e => e.file) };
};

test('a transcript that got shorter is read again, not abandoned', (t) => {
  const dir = mkdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { s, fp, files } = opened(dir);

  fs.writeFileSync(fp, line('t1', 'a.js', 10) + line('t2', 'b.js', 10));
  s.scan();
  assert.deepEqual(files(), ['a.js', 'b.js']);

  // replaced by something shorter: the offset now sits past the end of the file,
  // and reading on from there means never reading this session again
  fs.writeFileSync(fp, line('t3', 'c.js', 10));
  s.scan();
  assert.ok(files().includes('c.js'), 'nothing written after the truncation was read');
});

test('lines that come round a second time are not counted a second time', (t) => {
  const dir = mkdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { s, fp, files } = opened(dir);

  fs.writeFileSync(fp, line('t1', 'a.js', 10) + line('t2', 'b.js', 10));
  s.scan();
  assert.deepEqual(files(), ['a.js', 'b.js']);
  assert.deepEqual(s.parser.totals.get('main'), { tin: 20, tout: 20 });

  // shorter, and its one line is one we have already read — which is what makes
  // restarting the file safe: tool calls are keyed by id and usage by message id
  fs.writeFileSync(fp, line('t1', 'a.js', 10));
  s.scan();
  assert.deepEqual(files(), ['a.js', 'b.js'], 'a.js was emitted twice');
  assert.deepEqual(s.parser.totals.get('main'), { tin: 20, tout: 20 }, 'tokens were double-counted');
});

test('a watch that cannot be set up leaves the poll running', (t) => {
  const dir = mkdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { s, fp } = opened(dir);
  fs.writeFileSync(fp, line('t1', 'a.js', 10));

  // no subagents directory here, and on some platforms no recursive watch either
  assert.doesNotThrow(() => s.start());
  t.after(() => s.stop());
  assert.equal(s.started, true);
  assert.ok(s.events.some(e => e.t === 'op'), 'start() did not read the backlog');

  s.stop();
  assert.equal(s.watchers.length, 0, 'stop() left a watcher behind');
  assert.equal(s.timer, null);
});
