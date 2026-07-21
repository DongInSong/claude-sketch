// Local-only HTTP server: static front-end + tiny JSON API + SSE event stream.

import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPricing } from './pricing.js';
import { Project, listProjects } from './project.js';
import { spawn, execFileSync } from 'node:child_process';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

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
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
    return { ok: true, opened: target, with: cmd };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

export function createServer(project) {
  // One Project per watched root. Switching folders in the UI adds to this map
  // rather than restarting the server.
  const projects = new Map([[project.root, project]]);
  const pick = (url) => {
    const want = url.searchParams.get('project');
    if (!want) return project;
    if (projects.has(want)) return projects.get(want);
    // only roots Claude Code actually has transcripts for — not arbitrary paths
    if (!listProjects(999).some(p => p.root === want)) return null;
    const p = new Project(want);
    projects.set(want, p);
    return p;
  };

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(PUB, 'index.html')));
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

    if (url.pathname === '/api/meta') {
      return json(res, { project: project.root, dir: project.dir, canOpen: true,
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
        json(res, target ? openPath(from.root, target) : { ok: false, error: 'no path' });
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
      return p ? json(res, p.universe()) : notFound(res, 'unknown project');
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
