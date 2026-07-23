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

test('usage: a restated message replaces its own tokens, and agents keep separate books', () => {
  const p = new SessionParser('/r');
  const say = (id, agent, n) => p.parseLine({ type: 'assistant',
    message: { id, model: 'opus', usage: { input_tokens: n, output_tokens: n } } },
    agent).find(e => e.t === 'usage');

  say('m1', 'main', 10);
  const grown = say('m1', 'main', 30);          // streamed again, larger
  assert.deepEqual([grown.tin, grown.tout], [30, 30], 'a rewrite replaces, it does not add');

  const both = say('m2', 'main', 5);            // a new message does add
  assert.deepEqual([both.tin, both.tout], [35, 35]);

  const sub = say('m3', 'Explore', 7);
  assert.deepEqual([sub.agent, sub.tin, sub.tout], ['Explore', 7, 7]);
  assert.deepEqual(p.totals.get('main'), { tin: 35, tout: 35 }, 'the subagent did not touch main');
});

// The agent's total used to be re-summed from every message seen so far, which
// is quadratic in the length of a session — and it is paid on the /events
// connect that replays the backlog. Measured here: 20k messages cost 460ms that
// way and 18ms this way; 100k is 66ms linear and would be somewhere near 11s
// quadratic. The bound sits between the two with room for a slow CI runner.
test('usage: the running total does not re-read the whole session per message', () => {
  const p = new SessionParser('/r');
  const t0 = Date.now();
  for (let i = 0; i < 100000; i++)
    p.parseLine({ type: 'assistant', message: { id: 'm' + i, model: 'opus',
      usage: { input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3 } } }, 'main');
  const ms = Date.now() - t0;
  assert.deepEqual(p.totals.get('main'), { tin: 300000, tout: 300000 });
  assert.ok(ms < 3000, `100k messages took ${ms}ms — per-message cost is growing with the session`);
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

test('a result reports how many lines came back, whatever shape it arrives in', () => {
  const p = new SessionParser('/r');
  const res = (content) => p.parseLine({ type: 'user', timestamp: '2026-01-01T00:00:00Z',
    message: { content: [{ type: 'tool_result', tool_use_id: 'r' + Math.random(), content }] } },
    'main').find(e => e.t === 'res');

  assert.equal(res('one\ntwo\nthree').rows, 3, 'a plain string result');
  assert.equal(res('one\ntwo\nthree\n').rows, 3,
    'a file ending in a newline has no line after it — 145 lines were reported as 146');
  assert.equal(res([{ type: 'text', text: 'a\nb' }, { type: 'text', text: 'c\nd\ne' }]).rows, 5,
    'a result that arrives as blocks');
  assert.equal(res('').rows, 0);
  assert.equal(res(undefined).rows, 0, 'a result with no content at all');
});

// The turn signal drives the live "working" badge. A prompt (typed or queued)
// opens the turn — the assistant owes a reply and is working before it has made
// a single tool call — and an end_turn closes it. Anything else leaves it open.
test('a prompt opens the turn and end_turn closes it', () => {
  const p = new SessionParser('/r');
  const turns = (line) => p.parseLine(line, 'main').filter(e => e.t === 'open' || e.t === 'end');

  const typed = turns({ type: 'user', timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'user', content: 'do the thing' } });
  assert.deepEqual(typed, [{ t: 'open', agent: 'main', ts: Date.parse('2026-01-01T00:00:00Z') }],
    'a typed prompt owes a reply — the turn is open before any tool call');

  const queued = turns({ type: 'queue-operation', content: 'and this too', timestamp: '2026-01-01T00:00:05Z' });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].t, 'open', 'a queued prompt opens the turn too');

  // a tool_use assistant message is mid-turn: still open, no signal needed here
  const toolCall = turns({ type: 'assistant', timestamp: '2026-01-01T00:00:06Z',
    message: { id: 'm1', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'a1', name: 'Read', input: { file_path: '/r/a.js' } }] } });
  assert.deepEqual(toolCall, [], 'a tool call does not emit end — the turn is still the assistant’s');

  const done = turns({ type: 'assistant', timestamp: '2026-01-01T00:00:07Z',
    message: { id: 'm2', stop_reason: 'end_turn', content: [{ type: 'text', text: 'all done' }] } });
  assert.deepEqual(done, [{ t: 'end', agent: 'main', ts: Date.parse('2026-01-01T00:00:07Z') }],
    'end_turn hands the turn back to the user');
});

// Slash-command records ride in on the user role — a caveat (isMeta), then
// <command-name>/<local-command-stdout> lines that clean to nothing. None of
// them is a prompt the assistant answers, so none opens a turn.
test('local-command records do not open a turn', () => {
  const p = new SessionParser('/r');
  const turns = (line) => p.parseLine(line, 'main').filter(e => e.t === 'open' || e.t === 'end');

  assert.equal(turns({ type: 'user', timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'user', content: 'do the thing' } }).length, 1, 'a real prompt opens the turn');
  assert.deepEqual(turns({ type: 'user', isMeta: true, timestamp: '2026-01-01T00:00:01Z',
    message: { role: 'user', content: '<local-command-caveat>Caveat: …</local-command-caveat>' } }), [],
    'the caveat (isMeta) opens nothing');
  assert.deepEqual(turns({ type: 'user', timestamp: '2026-01-01T00:00:02Z',
    message: { role: 'user', content: '<command-name>/design-login</command-name>' } }), [],
    'the command record opens nothing');
  assert.deepEqual(turns({ type: 'user', timestamp: '2026-01-01T00:00:03Z',
    message: { role: 'user', content: '<local-command-stdout>ok</local-command-stdout>' } }), [],
    'the command stdout opens nothing');
});

// System records ride in on the user/queue channel — a background-task
// notification, a slash-command echo, a teammate hand-off. cleanPrompt used to
// strip only their tags, leaving the ids and paths inside a <task-notification>
// as a title like "b5alp9nx0 toolu_01… /tmp/…". Take the whole block instead.
test('cleanPrompt drops system records, keeps what a person typed', () => {
  const notif = '<task-notification>\n<task-id>bs35z6i31</task-id>\n'
    + '<tool-use-id>toolu_01NXe1va3SoK2QMWqaZvEYu7</tool-use-id>\n'
    + '<output-file>/tmp/claude/tasks/bs35z6i31.output</output-file>\n<status>completed</status>\n</task-notification>';
  assert.equal(cleanPrompt(notif), null, 'a task-notification is not a prompt');
  assert.equal(cleanPrompt('<command-name>/design-login</command-name>'), null, 'a slash-command echo is not a prompt');
  assert.equal(cleanPrompt('<system-reminder>be nice</system-reminder>'), null, 'a reminder is not a prompt');
  // a teammate hand-off keeps its instruction, loses the wrapper
  assert.equal(cleanPrompt('<teammate-message teammate_id="team-lead-frontend-review">scope=frontend, verify the build</teammate-message>'),
    'scope=frontend, verify the build');
  assert.equal(cleanPrompt('배포 스크립트 좀 고쳐줘'), '배포 스크립트 좀 고쳐줘', 'a real prompt is untouched');
});

// Bash was one undifferentiated "run"; the command says which kind of work it is.
test('Bash calls are classified by what the command does', () => {
  const p = new SessionParser('/r');
  const act = (command) => opsOf(p.parseLine({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z',
    message: { content: [{ type: 'tool_use', id: 'b' + Math.random(), name: 'Bash', input: { command } }] } },
    'main'))[0];
  assert.equal(act('git commit -m "x"').act, 'git');
  assert.equal(act('gh pr create').act, 'git');
  assert.equal(act('npm test').act, 'test');
  assert.equal(act('pytest -q tests/').act, 'test');
  assert.equal(act('node --test').act, 'test');
  assert.equal(act('go test ./...').act, 'test');
  assert.equal(act('npm run build').act, 'build');
  assert.equal(act('make -j4').act, 'build');
  assert.equal(act('tsc -p .').act, 'build');
  assert.equal(act('npm install').act, 'install');
  assert.equal(act('pip install requests').act, 'install');
  assert.equal(act('ls -la && cat foo.txt').act, 'run');
  const e = act('git status');
  assert.equal(e.op, 'bash', 'the coarse op stays bash, so the file panels are unchanged');
});

// MCP tools used to be dropped entirely — a browser session, a DB query, a
// service call all invisible. Now they are activities with a readable detail.
test('MCP tools become visible activities with a readable detail', () => {
  const p = new SessionParser('/r');
  const op = (name, input) => opsOf(p.parseLine({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z',
    message: { content: [{ type: 'tool_use', id: 'm' + Math.random(), name, input }] } }, 'main'))[0];

  const nav = op('mcp__plugin_playwright_playwright__browser_navigate', { url: 'http://localhost:3000/app' });
  assert.equal(nav.op, 'browse'); assert.equal(nav.file, 'http://localhost:3000/app');
  const click = op('mcp__plugin_playwright_playwright__browser_click', { ref: 'x' });
  assert.equal(click.op, 'browse'); assert.equal(click.file, 'click', 'no url → the browser action');
  const q = op('mcp__pms-postgres-prod__query', { sql: 'select *\n  from users' });
  assert.equal(q.op, 'data'); assert.equal(q.file, 'select * from users');
  const other = op('mcp__some_server__do_thing', {});
  assert.equal(other.op, 'mcp'); assert.equal(other.file, 'some-server · do_thing');
});

test('web search and fetch are web activity, not grep', () => {
  const p = new SessionParser('/r');
  const op = (name, input) => opsOf(p.parseLine({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z',
    message: { content: [{ type: 'tool_use', id: 'w' + Math.random(), name, input }] } }, 'main'))[0];
  const s = op('WebSearch', { query: 'vite pwa config' });
  assert.equal(s.op, 'web'); assert.equal(s.act, 'web'); assert.equal(s.file, 'web: vite pwa config');
  const f = op('WebFetch', { url: 'https://example.com/docs' });
  assert.equal(f.op, 'web'); assert.equal(f.file, 'https://example.com/docs');
});
