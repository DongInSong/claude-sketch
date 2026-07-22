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

// scan() walks subagents/** because workflow agents nest their transcripts in
// subagents/workflows/wf_x/. Naming them looked in subagents/ and nowhere else,
// so their meta was never found and each fell back to a hash — measured on a
// session running 32 subagents, 31 of the 32 metas were nested and not one was
// read. The meta sits beside the transcript, wherever that turns out to be.
test('a nested subagent is named from the meta beside it, not from a hash', (t) => {
  const dir = mkdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const id = 'sess1';
  fs.writeFileSync(path.join(dir, id + '.jsonl'), '');

  const deep = path.join(dir, id, 'subagents', 'workflows', 'wf_abc');
  const flat = path.join(dir, id, 'subagents');
  fs.mkdirSync(deep, { recursive: true });
  const call = (n, file) => JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z',
    message: { id: 'm' + n, model: 'opus',
      content: [{ type: 'tool_use', id: 't' + n, name: 'Read', input: { file_path: '/p/' + file } }] } }) + '\n';

  // one nested under a workflow, one sitting directly in subagents/
  fs.writeFileSync(path.join(deep, 'agent-aaaaaa1111.meta.json'),
    JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }));
  fs.writeFileSync(path.join(deep, 'agent-aaaaaa1111.jsonl'), call(1, 'a.js'));
  fs.writeFileSync(path.join(flat, 'agent-bbbbbb2222.meta.json'),
    JSON.stringify({ agentType: 'Explore', spawnDepth: 1 }));
  fs.writeFileSync(path.join(flat, 'agent-bbbbbb2222.jsonl'), call(2, 'b.js'));

  const s = new Session({ id, dir, root: '/p' });
  s.budget = Infinity;
  s.scan();

  const named = [...s.agentLabels.values()];
  assert.ok(named.includes('workflow-subagent'),
    'the nested one kept its hash: ' + named.join(', '));
  assert.ok(named.includes('Explore'), 'the flat one still has to work');
  assert.equal(named.filter(l => /^agent-[0-9a-f]{6}$/.test(l)).length, 0,
    'nothing should fall back to a hash when a meta is there');
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
