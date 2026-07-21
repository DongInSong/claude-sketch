// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionParser, cleanPrompt, deletedPaths } from '../lib/parser.js';

const opsOf = (evs, t = 'op') => evs.filter(e => e.t === t);

test('rel(): native separators land on the same shape git reports', () => {
  const win = new SessionParser('C:\\repo\\claude-sketch');
  const [ev] = opsOf(win.parseLine({
    type: 'assistant', timestamp: '2026-01-01T00:00:00Z',
    message: { content: [{ type: 'tool_use', id: 'a1', name: 'Read',
      input: { file_path: 'C:\\repo\\claude-sketch\\lib\\server.js' } }] },
  }, 'main'));
  assert.equal(ev.file, 'lib/server.js');   // matches `git ls-files`, so coverage counts it

  const posix = new SessionParser('/home/me/repo');
  const [ev2] = opsOf(posix.parseLine({
    type: 'assistant', timestamp: '2026-01-01T00:00:00Z',
    message: { content: [{ type: 'tool_use', id: 'b1', name: 'Read',
      input: { file_path: '/home/me/repo/lib/server.js' } }] },
  }, 'main'));
  assert.equal(ev2.file, 'lib/server.js');
});

test('rel(): a trailing separator on the root does not eat the first character', () => {
  const p = new SessionParser('/home/me/repo/');
  assert.equal(p.rel('/home/me/repo/a.js'), 'a.js');
});

test('rel(): paths outside the project stay absolute and slash-normalised', () => {
  const p = new SessionParser('C:\\repo\\a');
  assert.equal(p.rel('C:\\other\\b.js'), 'C:/other/b.js');
});

test('edits carry the line delta, writes count as pure additions', () => {
  const p = new SessionParser('/r');
  const line = (id, name, input) => opsOf(p.parseLine({
    type: 'assistant', timestamp: '2026-01-01T00:00:00Z',
    message: { content: [{ type: 'tool_use', id, name, input }] },
  }, 'main'))[0];

  const e = line('e1', 'Edit', { file_path: '/r/a.js', old_string: 'x', new_string: 'x\ny\nz' });
  assert.equal(e.plus, 2);
  assert.equal(e.minus, undefined);

  const w = line('w1', 'Write', { file_path: '/r/b.js', content: 'a\nb\nc' });
  assert.equal(w.plus, 3);
});

test('usage is summed per agent, and a restated message id does not double-count', () => {
  const p = new SessionParser('/r');
  const usage = { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7 };
  const emit = () => p.parseLine({ type: 'assistant', message: { id: 'm1', model: 'opus', usage } }, 'main');
  const first = emit().find(e => e.t === 'usage');
  assert.deepEqual([first.tin, first.tout, first.fresh, first.cw, first.cr], [115, 7, 10, 5, 100]);
  assert.equal(emit().find(e => e.t === 'usage'), undefined);   // unchanged: nothing to say
});

test('deletedPaths(): reads rm out of a Bash command, skips flags and globs', () => {
  assert.deepEqual(deletedPaths('rm -rf build/old.js'), ['build/old.js']);
  assert.deepEqual(deletedPaths('echo hi && rm a.txt b.txt'), ['a.txt', 'b.txt']);
  assert.deepEqual(deletedPaths('rm *.log'), []);
  assert.deepEqual(deletedPaths('rm -rf $TMP'), []);
  assert.deepEqual(deletedPaths('grep rm file'), []);
});

test('cleanPrompt(): strips command wrappers and image markers, then truncates', () => {
  assert.equal(cleanPrompt('<command-name>/model</command-name>hello'), 'hello');
  assert.equal(cleanPrompt('[Image #1] fix it'), 'fix it');
  assert.equal(cleanPrompt(''), null);
  assert.equal(cleanPrompt('x'.repeat(100)).length, 64);
});

test('the newest typed prompt wins the title, ai-title is only a fallback', () => {
  const p = new SessionParser('/r');
  p.parseLine({ type: 'ai-title', aiTitle: 'Refactoring the parser' }, 'main');
  assert.equal(p.title, 'Refactoring the parser');
  p.parseLine({ type: 'queue-operation', content: 'now do the tests', timestamp: '2026-01-01T00:00:10Z' }, 'main');
  assert.equal(p.title, 'now do the tests');
  p.parseLine({ type: 'queue-operation', content: 'older', timestamp: '2026-01-01T00:00:05Z' }, 'main');
  assert.equal(p.title, 'now do the tests');
});
