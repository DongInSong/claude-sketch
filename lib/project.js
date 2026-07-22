// Project-level discovery: which sessions exist for a working directory,
// and the file universe (for coverage / fog map).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { Session } from './session.js';
import { cleanPrompt } from './parser.js';

export function slugOf(projectRoot) {
  return path.resolve(projectRoot).replace(/[^A-Za-z0-9]/g, '-');
}

// Where Claude Code keeps its transcripts. ~/.claude unless CLAUDE_CONFIG_DIR
// says otherwise — and it is the same binary behind the CLI, the desktop app and
// the IDE extensions, so all of them honour it. Read at call time rather than at
// import, so a process that sets it late still lands in the right place.
export const configDir = () =>
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const projectsDir = () => path.join(configDir(), 'projects');

// The slug can't be reversed into a path (every separator becomes a dash), but
// the transcripts record the cwd they ran in, so read it back out of them.
export function listProjects(limit = 40) {
  const CLAUDE_DIR = projectsDir();
  let slugs = [];
  try { slugs = fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name); } catch { return []; }

  const out = [];
  for (const slug of slugs) {
    const dir = path.join(CLAUDE_DIR, slug);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
        .map(f => { const fp = path.join(dir, f);
          const st = fs.statSync(fp); return { fp, st, mtimeMs: st.mtimeMs }; })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch { continue; }
    if (!files.length) continue;

    const root = readCwdCached(files[0].fp, slug, files[0].st);
    if (!root) continue;
    out.push({ root, slug, sessions: files.length, mtimeMs: files[0].mtimeMs,
      exists: fs.existsSync(root) });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

// Recovering a root means reading the head of a transcript and regexing it —
// per folder, on every listing. The answer is a property of that file, so it is
// only ever computed once per (file, size, mtime).
const cwdCache = new Map();
function readCwdCached(fp, slug, st) {
  const key = fp + '\0' + st.mtimeMs + '\0' + st.size;
  if (cwdCache.has(key)) return cwdCache.get(key);
  const root = readCwd(fp, slug);
  if (cwdCache.size > 500) cwdCache.delete(cwdCache.keys().next().value);
  cwdCache.set(key, root);
  return root;
}

function readCwd(fp, slug) {
  try {
    const fd = fs.openSync(fp, 'r');
    try {
      const buf = Buffer.alloc(Math.min(fs.statSync(fp).size, 262144));
      fs.readSync(fd, buf, 0, buf.length, 0);
      const seen = [...buf.toString('utf8').matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)]
        .map(m => { try { return JSON.parse('"' + m[1] + '"'); } catch { return null; } })
        .filter(Boolean);
      // the session's own root is the cwd whose slug matches this folder
      return seen.find(c => slugOf(c) === slug) || null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

// A project bigger than this stops being drawable long before it stops being
// countable, so the list is cut. Say so rather than cutting quietly: coverage
// divides by this number, and a silently truncated denominator turns the
// percentage into a confident lie.
const GIT_CAP = 30000;
const WALK_CAP = 20000;
function capped(source, files, cap) {
  const total = files.length;
  return total > cap
    ? { source, files: files.slice(0, cap), total, truncated: true }
    : { source, files, total };
}

// Nothing is written to a transcript while a tool runs: the call goes in when it
// starts and the result when it comes back. So a long Bash or a running subagent
// looks exactly like a finished session from the outside — measured on a real
// session, 95 seconds of a 100-second call with the file untouched, and 8.1% of
// one session's wall clock spent looking idle while it was working.
//
// A call that started and has not come back is the missing signal. It sits at the
// end of the file for the same reason it is invisible: nothing follows it.
function openCallSince(lines) {
  const started = new Map(), done = new Set();
  for (const ln of lines) {
    if (ln.length < 24) continue;
    if (!ln.includes('"tool_use"') && !ln.includes('"tool_result"')) continue;
    let o;
    try { o = JSON.parse(ln); } catch { continue; }
    const content = o.message && o.message.content;
    if (!Array.isArray(content)) continue;
    const ts = Date.parse(o.timestamp || '') || 0;
    for (const c of content) {
      if (c.type === 'tool_use' && c.id) started.set(c.id, ts);
      else if (c.type === 'tool_result' && c.tool_use_id) done.add(c.tool_use_id);
    }
  }
  let newest = 0;
  for (const [id, ts] of started) if (!done.has(id) && ts > newest) newest = ts;
  return newest;
}

const ACTIVE_MS = 45 * 1000;          // the file itself moved this recently
// A session killed mid-call leaves its tool call outstanding for ever, so the
// signal needs an end. Longer than any real tool run measured here (the worst
// was 427s), short enough that yesterday's crash is not still "working".
const OPEN_CALL_MS = 30 * 60 * 1000;
function working(now, mtimeMs, openSince) {
  if (now - mtimeMs < ACTIVE_MS) return true;
  return !!openSince && now - openSince < OPEN_CALL_MS;
}

// Claude Code records the directory it was started in. That directory is the
// session's identity — the transcripts live under a slug made from it — but it
// is often a corner of the repository rather than the whole of it. Measured on
// this machine: of 15 git projects, 5 were started below their repository root,
// and 4 of those 5 did essentially all their work outside that corner, which is
// why coverage read 0%. So the recorded directory stays the identity and the
// repository is the extent: one value, used by everything that has to agree on
// what a path means.
function repoRoot(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out ? path.resolve(out) : dir;
  } catch {
    return dir;                       // no repository here, so the folder is all there is
  }
}

export class Project {
  constructor(root) {
    this.root = path.resolve(root);              // identity: slug, session list, ?project=
    this.dir = path.join(projectsDir(), slugOf(this.root));
    this.base = repoRoot(this.root);             // extent: paths, the file list, opening
    this.sessions = new Map(); // id -> Session
  }

  // cheap listing: stat + tail-scan for a title, no full parse
  list() {
    let files = [];
    try {
      files = fs.readdirSync(this.dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const fp = path.join(this.dir, f);
          const st = fs.statSync(fp);
          return { id: f.slice(0, -6), fp, mtimeMs: st.mtimeMs, size: st.size };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, 20);
    } catch {
      return { error: 'no-project-dir', dir: this.dir, sessions: [] };
    }
    const now = Date.now();
    return {
      dir: this.dir,
      sessions: files.map(f => {
        const p = this.peek(f);
        return {
          id: f.id,
          title: p.title || f.id.slice(0, 8),
          mtimeMs: f.mtimeMs,
          size: f.size,
          active: working(now, f.mtimeMs, p.openSince),
        };
      }),
    };
  }

  // Titles only move when the file does, and this list is polled — so key the
  // work on (size, mtime) instead of re-reading every ten seconds. The tail read
  // answers both questions, so the outstanding-call check rides along for free —
  // and it is cached just as safely, because a call can only start or finish by
  // the file changing.
  peek(f) {
    if (!this._peeks) this._peeks = new Map();
    const hit = this._peeks.get(f.fp);
    if (hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs) return hit;
    const got = this.peekTail(f.fp);
    const rec = { size: f.size, mtimeMs: f.mtimeMs, ...got };
    this._peeks.set(f.fp, rec);
    if (this._peeks.size > 200) this._peeks.delete(this._peeks.keys().next().value);
    return rec;
  }

  // label = the newest thing the user typed. Parses only the tail: prompts are
  // timestamped, while last-prompt records are rewritten every turn and can't be
  // ordered by position. The same bytes also say whether a tool call is still out.
  peekTail(fp) {
    let openSince = 0;
    try {
      const st = fs.statSync(fp);
      const fd = fs.openSync(fp, 'r');
      try {
        for (const size of [262144, 4 * 1024 * 1024]) {
          const from = Math.max(0, st.size - size);
          const buf = Buffer.alloc(Math.min(size, st.size));
          fs.readSync(fd, buf, 0, buf.length, from);
          const lines = buf.toString('utf8').split('\n');
          if (from > 0) lines.shift();                 // the first one is cut in half

          // An outstanding call sits at the very end of the file — nothing is
          // written while a tool runs — so the first window always holds it.
          if (size === 262144) openSince = openCallSince(lines);

          let best = null, aiTitle = null, fallback = null;
          for (const ln of lines) {
            if (ln.length < 24) continue;
            if (!ln.includes('"content":"') && !ln.includes('"lastPrompt"')
                && !ln.includes('"aiTitle"')) continue;
            let o;
            try { o = JSON.parse(ln); } catch { continue; }
            const ts = Date.parse(o.timestamp || '') || 0;
            let text = null;
            if (o.type === 'queue-operation' && typeof o.content === 'string') text = o.content;
            else if (o.type === 'user' && o.message && typeof o.message.content === 'string')
              text = o.message.content;
            else if (o.type === 'ai-title' && o.aiTitle) aiTitle = o.aiTitle;
            else if (o.type === 'last-prompt' && o.lastPrompt) fallback = o.lastPrompt;
            if (text && ts && (!best || ts >= best.ts)) best = { ts, text };
          }
          const title = cleanPrompt(best ? best.text : (fallback || aiTitle));
          if (title) return { title, openSince };
          if (from === 0) break;          // already saw the whole file
        }
      } finally { fs.closeSync(fd); }
    } catch { /* ignore */ }
    return { title: null, openSince };
  }

  // is anyone actually watching this folder right now?
  busy() {
    for (const s of this.sessions.values()) if (s.listeners.size) return true;
    return false;
  }

  close() {
    for (const s of this.sessions.values()) s.stop();
    this.sessions.clear();
  }

  session(id) {
    if (!/^[A-Za-z0-9-]+$/.test(id)) return null;
    if (!this.sessions.has(id)) {
      if (!fs.existsSync(path.join(this.dir, id + '.jsonl'))) return null;
      this.sessions.set(id, new Session({ id, dir: this.dir, root: this.base }));
    }
    return this.sessions.get(id);
  }

  // The file list barely moves and walking a big tree isn't free, so hold it for
  // a while instead of rebuilding it on every page load. Async because the page
  // now asks again every minute, and shelling out to git synchronously would
  // stop the event loop — and with it every session's event stream — for as long
  // as `git ls-files` takes on a big repo.
  universe() {
    if (this._universe && Date.now() - this._universeAt < 30000)
      return Promise.resolve(this._universe);
    if (this._building) return this._building;          // one build at a time
    this._building = this.buildUniverse().then((u) => {
      this._universe = u;
      this._universeAt = Date.now();
      this._building = null;
      return u;
    }, (e) => { this._building = null; throw e; });
    return this._building;
  }

  async buildUniverse() {
    // git ls-files respects .gitignore — the honest coverage denominator. Asking
    // for untracked files too, because a file Claude just wrote is part of the
    // project the moment it exists, not once someone runs git add. --exclude-standard
    // is what keeps that from meaning "and all of node_modules": measured on a repo
    // with 95,203 files under an ignored node_modules, none of them come back, and
    // the walk costs ~30ms more than reading the index alone.
    // stderr is swallowed: outside a repo git complains, and that complaint is
    // not the user's problem.
    const git = (args) => new Promise((resolve) => {
      execFile('git', ['-C', this.base, ...args],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
        (err, stdout) => resolve(err ? null : stdout));
    });
    // --full-name ':/' rather than plain ls-files: run from a subdirectory the
    // plain form lists only that subdirectory, and names what it finds relative
    // to it. Both halves have to be the repository's.
    const [tracked, untracked] = await Promise.all([
      git(['ls-files', '--full-name', ':/']),
      git(['ls-files', '--others', '--exclude-standard', '--full-name', ':/']),
    ]);
    if (tracked !== null || untracked !== null) {
      const all = [...new Set((tracked || '').split('\n').concat((untracked || '').split('\n'))
        .filter(Boolean))];
      if (all.length) return capped('git', all, GIT_CAP);
    }
    const files = [];
    const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv',
      'dist', 'build', '.next', '.cache', 'target']);
    const walk = (dir, rel, depth) => {
      if (depth > 8 || files.length >= 20000) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') && e.name !== '.claude') continue;
        if (e.isDirectory()) {
          if (!SKIP.has(e.name)) walk(path.join(dir, e.name), rel ? rel + '/' + e.name : e.name, depth + 1);
        } else if (e.isFile()) {
          files.push(rel ? rel + '/' + e.name : e.name);
        }
      }
    };
    walk(this.base, '', 0);
    return capped('walk', files, WALK_CAP);
  }
}
