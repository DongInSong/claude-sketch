// Local-only HTTP server: static front-end + tiny JSON API + SSE event stream.

import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadPricing } from './pricing.js';
import { Project, listProjects } from './project.js';
import { spawn, execFileSync } from 'node:child_process';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Two guards, because a server on localhost is reachable from any page the
// browser happens to be on:
//   · host check — a DNS-rebinding attack has to arrive under its own domain
//     name, so only literal addresses (and "localhost") are served at all.
//   · token     — handed to the page itself, unreadable across origins, so a
//     drive-by form POST can't reach /api/open even on the right port.
const TOKEN = crypto.randomBytes(16).toString('hex');
const TOKEN_BUF = Buffer.from(TOKEN, 'utf8');

// timingSafeEqual throws when the two buffers differ in length, and a string's
// length is its character count while a buffer's is its byte count — "한" is one
// of the first and three of the second. Comparing the strings let a 32-character
// multibyte token past the guard and into a throw that no handler catches, which
// took the whole server down. Measure the bytes that actually get compared.
function tokenOk(given) {
  const buf = Buffer.from(String(given || ''), 'utf8');
  return buf.length === TOKEN_BUF.length && crypto.timingSafeEqual(buf, TOKEN_BUF);
}

function hostOk(hostHeader) {
  const name = String(hostHeader || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (!name) return false;
  return name === 'localhost' || name.includes(':')          // ::1 and friends
    || /^\d{1,3}(\.\d{1,3}){3}$/.test(name);
}

function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                                   // same-origin GET, curl, EventSource
  return origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
}

// Detached launch that can never take the server with it: on Windows the editor
// is a .cmd shim, which CreateProcess refuses to run, and that arrives as an
// async 'error' event — a try/catch around spawn() would not see it.
function launch(cmd, args) {
  const win = process.platform === 'win32';
  const child = win
    ? spawn(cmd, args.map(a => `"${String(a).replace(/"/g, '')}"`),
        { stdio: 'ignore', detached: true, shell: true, windowsHide: true })
    : spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => { /* no editor, no file manager — the UI says so */ });
  child.unref();
  return child;
}

const IS_WSL = (() => {
  try { return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch { return false; }
})();
const HAS_CODE = (() => {
  try { execFileSync(process.platform === 'win32' ? 'where' : 'which', ['code'], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();

// Open a file or folder in the user's editor / file manager. Local paths only:
// the target must exist and sit under the project, the home dir, or a temp dir.
function openPath(root, raw) {
  const target = path.resolve(root, raw);
  const allowed = [root, os.homedir(), os.tmpdir(), '/tmp']
    .map(d => path.resolve(d))
    .some(d => target === d || target.startsWith(d + path.sep));
  if (!allowed) return { ok: false, error: 'outside allowed roots' };
  if (!fs.existsSync(target)) return { ok: false, error: 'not found' };

  const isDir = fs.statSync(target).isDirectory();
  let cmd, args;
  if (HAS_CODE) { cmd = 'code'; args = [isDir ? '--new-window' : '--goto', target]; }
  else if (process.platform === 'darwin') { cmd = 'open'; args = [target]; }
  else if (process.platform === 'win32') { cmd = 'explorer.exe'; args = [target]; }
  else if (IS_WSL) {
    try { cmd = 'explorer.exe'; args = [execFileSync('wslpath', ['-w', target], { encoding: 'utf8' }).trim()]; }
    catch { cmd = 'xdg-open'; args = [target]; }
  } else { cmd = 'xdg-open'; args = [target]; }

  try {
    launch(cmd, args);
    return { ok: true, opened: target, with: cmd };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// Read once and keep it, but notice when the file changes underneath — a stat
// per page load is nothing, and editing the UI shouldn't need a restart.
let pageCache = null;
function PAGE() {
  const fp = path.join(PUB, 'index.html');
  const mtime = fs.statSync(fp).mtimeMs;
  if (!pageCache || pageCache.mtime !== mtime) {
    pageCache = { mtime, html: fs.readFileSync(fp, 'utf8')
      .replace('</head>', `<script>window.__CS_TOKEN__=${JSON.stringify(TOKEN)}</script>\n</head>`) };
  }
  return pageCache.html;
}

const ROOTS_TTL = 10000;   // a new folder only appears when Claude Code starts one
const KEEP_PROJECTS = 8;

export function createServer(project) {
  // One Project per watched root. Switching folders in the UI adds to this map
  // rather than restarting the server.
  const projects = new Map([[project.root, project]]);
  const used = new Map([[project.root, 0]]);

  // Validating "is this a real project root?" means scanning every transcript
  // folder — far too much work to redo on every poll, and the answer barely moves.
  let roots = null, rootsAt = 0;
  const knownRoot = (want) => {
    if (!roots || Date.now() - rootsAt > ROOTS_TTL) {
      roots = new Set(listProjects(999).map(p => p.root));
      rootsAt = Date.now();
    }
    return roots.has(want);
  };

  // Folders the UI has visited stay warm, but not forever: drop the least
  // recently used one once there are enough, as long as nobody is watching it.
  const evict = () => {
    if (projects.size <= KEEP_PROJECTS) return;
    const idle = [...projects.entries()]
      .filter(([root, p]) => root !== project.root && !p.busy())
      .sort((a, b) => (used.get(a[0]) || 0) - (used.get(b[0]) || 0));
    while (projects.size > KEEP_PROJECTS && idle.length) {
      const [root, p] = idle.shift();
      p.close();
      projects.delete(root);
      used.delete(root);
    }
  };

  const pick = (url) => {
    const want = url.searchParams.get('project');
    if (!want) return project;
    const hit = projects.get(want);
    if (hit) { used.set(want, Date.now()); return hit; }
    // only roots Claude Code actually has transcripts for — not arbitrary paths
    if (!knownRoot(want)) return null;
    const p = new Project(want);
    projects.set(want, p);
    used.set(want, Date.now());
    evict();
    return p;
  };

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (!hostOk(req.headers.host) || !originOk(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('claude-sketch only answers to this machine');
      return;
    }
    // The page is the one thing served without a token — it is what hands the
    // token out, and same-origin policy keeps that out of a hostile page's reach.
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE());
      return;
    }

    if (url.pathname.startsWith('/fonts/')) {
      const name = path.basename(url.pathname);
      const fp = path.join(PUB, 'fonts', name);
      if (/^[\w.-]+\.woff2$/.test(name) && fs.existsSync(fp)) {
        res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=31536000' });
        res.end(fs.readFileSync(fp));
      } else { res.writeHead(404); res.end(); }
      return;
    }

    // the page's own modules; basename only, so the path can't walk anywhere
    if (url.pathname.startsWith('/lib/')) {
      const name = path.basename(url.pathname);
      const fp = path.join(PUB, 'lib', name);
      if (/^[\w-]+\.js$/.test(name) && fs.existsSync(fp)) {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        res.end(fs.readFileSync(fp));
      } else { res.writeHead(404); res.end(); }
      return;
    }

    if (url.pathname.startsWith('/api/') || url.pathname === '/events') {
      if (!tokenOk(url.searchParams.get('k'))) { res.writeHead(403); res.end('bad token'); return; }
    }

    if (url.pathname === '/api/meta') {
      const p = pick(url) || project;        // ?project= wins, so a reload reports the folder it is on
      return json(res, { project: p.root, dir: p.dir, canOpen: true,
        editor: HAS_CODE ? 'code' : (process.platform === 'darwin' ? 'Finder'
          : (process.platform === 'win32' || IS_WSL) ? 'Explorer' : 'system'),
        pricing: loadPricing() });
    }
    if (url.pathname === '/api/open' && req.method === 'POST') {
      const from = pick(url) || project;
      let body = '';
      req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        let target = '';
        try { target = JSON.parse(body).path || ''; } catch { /* ignore */ }
        // base, not root: the paths on the page are named from the project's
        // extent, so that is what they have to be resolved against. Resolving a
        // repository path against the recorded subdirectory finds nothing and
        // fails as "not found", which looks like the file is missing.
        const base = from.baseFor ? from.baseFor(url.searchParams.get('session') || '')
                                  : from.root;
        json(res, target ? openPath(base, target) : { ok: false, error: 'no path' });
      });
      return;
    }
    if (url.pathname === '/api/projects') {
      return json(res, { current: project.root, projects: listProjects() });
    }
    if (url.pathname === '/api/sessions') {
      const p = pick(url);
      return p ? json(res, { ...p.list(), root: p.root }) : notFound(res, 'unknown project');
    }
    if (url.pathname === '/api/universe') {
      const p = pick(url);
      if (!p) return notFound(res, 'unknown project');
      // ?session=, because a session can have worked somewhere other than the
      // folder it was recorded against, and the file list has to be the one its
      // paths are named from
      p.universe(url.searchParams.get('session') || '')
        .then(u => json(res, u), () => json(res, { source: 'none', files: [] }));
      return;
    }

    if (url.pathname === '/events') {
      const id = url.searchParams.get('session') || '';
      const p = pick(url);
      const sess = p && p.session(id);
      if (!sess) { res.writeHead(404); res.end('unknown session'); return; }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      sess.start();
      sess.scan();                             // ensure backlog is fully parsed
      for (let i = 0; i < sess.events.length; i += 800)
        send({ t: 'backlog', events: sess.events.slice(i, i + 800) });
      send({ t: 'ready', title: sess.parser.title });

      const unsub = sess.subscribe(evs => send({ t: 'backlog', events: evs }));
      const beat = setInterval(() => res.write(': hb\n\n'), 25000);
      req.on('close', () => { clearInterval(beat); unsub(); });
      return;
    }

    res.writeHead(404); res.end('not found');
  });
}

function notFound(res, msg) { res.writeHead(404); res.end(msg); }

function json(res, obj) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
