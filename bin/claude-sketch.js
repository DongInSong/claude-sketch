#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Project } from '../lib/project.js';
import { createServer } from '../lib/server.js';
import { openBrowser, openedRecently, markOpened } from '../lib/browser.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));

const DEFAULT_PORT = 4517;
const PORT_TRIES = 12;

const opt = {
  project: process.cwd(),
  port: DEFAULT_PORT,
  host: '127.0.0.1',
  open: true,
  openExplicit: false,
  strictPort: false,
  detach: false,
};

const args = process.argv.slice(2);
const need = (i, flag) => {
  if (i >= args.length) die(`${flag} needs a value`);
  return args[i];
};
function die(msg) {
  console.error(`claude-sketch: ${msg}\nrun "claude-sketch --help" for the options`);
  process.exit(1);
}

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--project' || a === '-p') opt.project = need(++i, a);
  else if (a === '--port') {
    const n = parseInt(need(++i, a), 10);
    if (!Number.isInteger(n) || n < 1 || n > 65535) die(`--port takes a number between 1 and 65535`);
    opt.port = n;
  }
  else if (a === '--host') opt.host = need(++i, a);
  else if (a === '--strict-port') opt.strictPort = true;
  else if (a === '--detach' || a === '-d') opt.detach = true;
  else if (a === '--open') { opt.open = true; opt.openExplicit = true; }   // asked for it: always open
  else if (a === '--no-open') opt.open = false;
  else if (a === '--version' || a === '-v') { console.log(PKG.version); process.exit(0); }
  else if (a === '--help' || a === '-h') { help(); process.exit(0); }
  else die(`unknown option "${a}"`);
}

function help() {
  console.log(`✳ claude-sketch v${PKG.version} — a live sketch of what Claude Code is touching

usage
  claude-sketch [options]

options
  -p, --project <dir>   project to watch                (default: current directory)
      --port <n>        port to serve on                (default: ${DEFAULT_PORT}, next free one if taken)
      --strict-port     fail instead of trying the next port
  -d, --detach          run in the background and hand the terminal back
      --host <addr>     address to bind                 (default: 127.0.0.1)
      --open            open a tab without checking for one first
      --no-open         don't open the browser
                        (by default: if a tab is already open on this port it is
                         left alone — it notices the restart and reloads itself)
  -v, --version         print the version
  -h, --help            print this

Reads ~/.claude/projects/<dir-slug>/*.jsonl locally. Nothing leaves your machine.`);
}

if (!fs.existsSync(opt.project)) die(`no such directory: ${opt.project}`);

const freePort = (from) => new Promise((resolve) => {
  const probe = (p, left) => {
    if (!left) return resolve(null);
    const s = net.createServer();
    s.once('error', () => probe(p + 1, left - 1));
    s.once('listening', () => s.close(() => resolve(p)));
    s.listen(p, opt.host);
  };
  probe(from, PORT_TRIES);
});

// Knock on a port until something answers. `dead` lets a child that exited cut
// the wait short instead of sitting out the whole deadline.
const listening = (port, host, ms, dead) => new Promise((resolve) => {
  const until = Date.now() + ms;
  const knock = () => {
    if (dead()) return resolve(false);
    const s = net.connect({ port, host: host === '0.0.0.0' ? '127.0.0.1' : host });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => {
      s.destroy();
      if (dead() || Date.now() > until) return resolve(false);
      setTimeout(knock, 60);
    });
  };
  knock();
});

// Background mode: pick the port here so the parent can print a URL that is
// actually true, then hand the terminal back.
if (opt.detach && !process.env.CLAUDE_SKETCH_CHILD) {
  const port = opt.strictPort ? opt.port : await freePort(opt.port);
  if (port === null) die(`no free port near ${opt.port}`);
  const logPath = path.join(os.tmpdir(), `claude-sketch-${port}.log`);
  const log = fs.openSync(logPath, 'a');
  const passthrough = process.argv.slice(2)
    .filter((a, i, all) => a !== '-d' && a !== '--detach'
      && a !== '--port' && all[i - 1] !== '--port');
  const child = spawn(process.execPath,
    [fileURLToPath(import.meta.url), ...passthrough, '--port', String(port), '--strict-port'],
    // windowsHide: a detached console app would otherwise open a console window
    // of its own and leave it sitting there
    { detached: true, windowsHide: true, stdio: ['ignore', log, log],
      env: { ...process.env, CLAUDE_SKETCH_CHILD: '1' } });
  child.unref();

  // The port was free a moment ago, not necessarily now — and the child binds it
  // with --strict-port, so losing that race ends it inside a log file nobody is
  // watching, after this process has already printed a URL that never worked.
  // Say nothing until it answers.
  let died = false;
  child.on('exit', () => { died = true; });
  const up = await listening(port, opt.host, 5000, () => died);
  // Something answering there is not proof it is ours: a server already on that
  // port answers the first knock while our child is still failing to bind. Let
  // the child fall over first — EADDRINUSE arrives long before this is up.
  await new Promise(r => setTimeout(r, 300));
  if (died) {
    console.error(`claude-sketch: the background server stopped as soon as it started`);
    console.error(`  port ${port} is most likely taken already — its output is in ${logPath}`);
    process.exit(1);
  }
  if (!up) {
    console.error(`claude-sketch: nothing came up on port ${port} (pid ${child.pid} is still running)`);
    console.error(`  its output is in ${logPath}`);
    process.exit(1);
  }
  console.log(`✳ claude-sketch v${PKG.version} — running in the background`);
  console.log(`  open  http://localhost:${port}`);
  console.log(`  pid   ${child.pid}`);
  console.log(`  log   ${logPath}`);
  console.log(`  stop  kill ${child.pid}`);
  process.exit(0);
}

const project = new Project(opt.project);
const server = createServer(project);

// long enough for an open tab's event stream to retry (browsers wait ~3s),
// short enough not to sit there when there is no tab
const TAB_WAIT_MS = 5000;
let knocked = false;
server.on('request', () => { knocked = true; });

// A busy port is the most common first-run stumble, so walk to the next free one
// unless the caller pinned it with --strict-port.
let attempt = 0;
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') die(err.message);
  if (opt.strictPort) die(`port ${opt.port} is already in use (--strict-port)`);
  if (++attempt >= PORT_TRIES) die(`ports ${opt.port - attempt + 1}–${opt.port} are all in use`);
  console.log(`  port ${opt.port} is busy — another claude-sketch may be on it; trying ${opt.port + 1}…`);
  server.listen(++opt.port, opt.host);
});

server.listen(opt.port, opt.host, () => {
  const shown = (opt.host === '0.0.0.0' || opt.host === '127.0.0.1') ? 'localhost' : opt.host;
  const url = `http://${shown}:${opt.port}`;
  const list = project.list();
  console.log(`✳ claude-sketch v${PKG.version}`);
  console.log(`  project     ${project.root}`);
  console.log(`  transcripts ${project.dir}`);
  console.log(`  sessions    ${list.sessions ? list.sessions.length : 0} found${list.error ? ' (' + list.error + ')' : ''}`);
  console.log(`  serving     ${url}`);
  if (opt.host !== '127.0.0.1' && opt.host !== 'localhost')
    console.log(`  ⚠ bound to ${opt.host} — anyone on this network can read these transcripts`);

  const ready = () => console.log(`\n  watching · ctrl-c to stop`);
  const show = () => { openBrowser(url); markOpened(opt.port); };

  if (!opt.open) return ready();
  if (opt.openExplicit || !openedRecently(opt.port)) {
    show();
    console.log(`\n  ✓ opened a tab`);
    return ready();
  }

  // We opened a tab for this port not long ago. It may still be there, holding
  // your scroll position and waiting to reconnect — or you may have closed it.
  // Listen instead of assuming: an open tab knocks within a few seconds.
  console.log(`\n  checking browser…`);
  setTimeout(() => {
    if (knocked) {
      markOpened(opt.port);
      console.log(`  ✓ tab already open — it reloads itself`);
    } else {
      show();
      console.log(`  ✓ no tab there — opened one`);
    }
    ready();
  }, TAB_WAIT_MS);
});

process.on('SIGINT', () => { console.log('\n✳ bye'); process.exit(0); });
