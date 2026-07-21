// Boots the real server on an ephemeral port and checks the guards from outside.
// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Project } from '../lib/project.js';
import { createServer } from '../lib/server.js';

const boot = async () => {
  const server = createServer(new Project(process.cwd()));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await (await fetch(base)).text();
  const token = (page.match(/__CS_TOKEN__="([a-f0-9]+)"/) || [])[1];
  return { server, base, token, page };
};

test('the page hands out a token, and the API refuses to work without it', async (t) => {
  const { server, base, token, page } = await boot();
  t.after(() => server.close());

  assert.match(token || '', /^[a-f0-9]{32}$/);
  assert.ok(page.includes('claude-sketch'));

  assert.equal((await fetch(`${base}/api/sessions`)).status, 403);
  assert.equal((await fetch(`${base}/api/sessions?k=nope`)).status, 403);
  assert.equal((await fetch(`${base}/events?session=whatever`)).status, 403);
  assert.equal((await fetch(`${base}/api/sessions?k=${token}`)).status, 200);
});

// fetch() silently drops a caller-set Host header, so this one goes out raw.
const getAs = (port, host, p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host } },
    res => { res.resume(); resolve(res.statusCode); });
  req.on('error', reject);
  req.end();
});

test('a request arriving under someone else\'s domain name is refused (DNS rebinding)', async (t) => {
  const { server, token } = await boot();
  t.after(() => server.close());
  const port = server.address().port;

  assert.equal(await getAs(port, 'evil.example.com', `/api/sessions?k=${token}`), 403);
  assert.equal(await getAs(port, 'evil.example.com', '/'), 403);
  assert.equal(await getAs(port, `127.0.0.1:${port}`, `/api/sessions?k=${token}`), 200);
  assert.equal(await getAs(port, `localhost:${port}`, '/'), 200);
});

test('a cross-origin POST cannot reach /api/open', async (t) => {
  const { server, base, token } = await boot();
  t.after(() => server.close());

  const res = await fetch(`${base}/api/open?k=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: 'https://evil.example.com' },
    body: JSON.stringify({ path: 'README.md' }),
  });
  assert.equal(res.status, 403);
});

test('an unknown project root is refused rather than opened', async (t) => {
  const { server, base, token } = await boot();
  t.after(() => server.close());

  const res = await fetch(`${base}/api/sessions?project=${encodeURIComponent('/definitely/not/a/project')}&k=${token}`);
  assert.equal(res.status, 404);
});

test('the file universe comes back as slash-separated relative paths', async (t) => {
  const { server, base, token } = await boot();
  t.after(() => server.close());

  const u = await (await fetch(`${base}/api/universe?k=${token}`)).json();
  assert.ok(u.files.includes('lib/server.js'), 'expected lib/server.js in ' + u.source);
  assert.ok(!u.files.some(f => f.includes('\\')), 'no backslashes should survive');
});
