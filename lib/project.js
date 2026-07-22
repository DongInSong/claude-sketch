// Project-level discovery: which sessions exist for a working directory,
// and the file universe (for coverage / fog map).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
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
// A repository is the directory with a .git in it — which is already how isRepo()
// below decides whether one is a repository at all, so finding the root the same
// way makes the two answers agree. This used to ask git, one `rev-parse
// --show-toplevel` process per directory. Measured across the 358 directories
// the transcripts on this machine name: 622ms of spawning against 11ms of
// walking, and the walk was the better answer 29 times.
//
// Those 29 are directories that have since been deleted, or that belong to a
// branch not checked out. git cannot chdir into one to answer, so it failed and
// the path was left standing as its own root — a root with no .git, which the
// vote then threw out. Work done in a folder that has since gone is still work
// done in that repository, and walking up finds it.
//
// .git is a directory in an ordinary clone and a file in a worktree or a
// submodule. Both are a toplevel, and existsSync says yes to both.
//
// memo is optional and maps every directory on the way up to the answer, so a
// second path in the same tree stops at the first level it recognises.
//
// stopAt is a floor, and only applies to paths already inside it: a path in the
// folder this session was recorded against belongs to that folder, whatever sits
// above it. Claude Code is often run in a worktree, and a worktree that has since
// been deleted takes its .git file with it — so without a floor the walk climbs
// out into the repository that contained it and votes for that instead. Measured
// on this machine, that relocated 7 of the 12 sessions recorded in deleted
// worktrees into a tree whose file list matches nothing they touched.
// Windows, and macOS on a default APFS volume, are case-insensitive: C:\Repo and
// C:\repo are the same folder and a transcript may spell it either way — which is
// why the parser matches paths against the root case-blind too. It matters here
// because these comparisons decide whether a path is inside the folder the
// session was recorded against: spelled differently, the floor below stops
// applying and a deleted worktree climbs back out into its parent.
const CASE_BLIND = process.platform === 'win32' || process.platform === 'darwin';
const fold = (p) => CASE_BLIND ? p.toLowerCase() : p;
const samePath = (a, b) => fold(a) === fold(b);
const under = (p, d) => {
  const pk = fold(p), dk = fold(d);
  return pk === dk || pk.startsWith(dk.endsWith(path.sep) ? dk : dk + path.sep);
};
function repoRoot(dir, memo, stopAt) {
  const start = path.resolve(dir);
  const floor = stopAt && under(start, path.resolve(stopAt)) ? path.resolve(stopAt) : null;
  const seen = [];
  let d = start;
  const settle = (r) => {
    if (memo) { for (const s of seen) memo.set(s, r); memo.set(d, r); }
    return r;
  };
  for (;;) {
    if (memo && memo.has(d)) {
      const hit = memo.get(d);
      for (const s of seen) memo.set(s, hit);
      return hit;
    }
    if (fs.existsSync(path.join(d, '.git'))) return settle(d);
    if (floor && samePath(d, floor)) return settle(d);   // no higher, whatever is up there
    seen.push(d);
    const up = path.dirname(d);
    if (up === d) break;              // reached the top without finding one
    d = up;
  }
  // no repository above any of them, so each is the whole of itself
  if (memo) for (const s of seen) memo.set(s, s);
  return start;
}

// Where a session actually worked. Claude Code fixes the transcript folder from
// the directory it started in and never moves it, so "go and work in the other
// worktree" leaves the record here and the work over there — measured on this
// machine, 5 of one folder's 96 sessions did all their file work in a different
// repository. The paths themselves are the only honest answer, so read the ones
// this session used and take the repository most of them are in.
//
// Both ends are read, not just the head. The head alone is what a session starts
// with, and a session starts by reading a plan, a memory file and a couple of
// scratch files in /tmp — measured on a 30MB transcript, the first 2MB held 22
// paths against the whole file's 504, and the true repository came to 45% of
// them where the whole file put it at 71%. Under the majority it needs, so that
// session was read against the wrong tree: coverage 0 of 34, and the page saying
// the work happened outside a project it never left. The tail is where a long
// session does its actual work, and it costs the same one read.
const WORK_SCAN = 2 * 1024 * 1024;
function readEnds(fp) {
  const fd = fs.openSync(fp, 'r');
  try {
    const size = fs.statSync(fp).size;
    const grab = (from, want) => {
      const buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, from);
      return buf.toString('utf8');
    };
    if (size <= WORK_SCAN * 2) return grab(0, size);
    return grab(0, WORK_SCAN) + '\n' + grab(size - WORK_SCAN, WORK_SCAN);
  } finally { fs.closeSync(fd); }
}

// Transcripts live here, so a path under this one is the session writing about
// itself — a plan, a memory note, another session's log. Never project work,
// even when the home directory it sits in happens to be a repository.
const inConfigDir = (p) => under(p, configDir());
const isRepo = (r) => fs.existsSync(path.join(r, '.git'));

function workedIn(fp, fallback) {
  let text = '';
  try { text = readEnds(fp); } catch { return fallback; }

  const perDir = new Map();
  for (const m of text.matchAll(/"(?:file_path|notebook_path)":"((?:[^"\\]|\\.)*)"/g)) {
    let p; try { p = JSON.parse('"' + m[1] + '"'); } catch { continue; }
    if (!path.isAbsolute(p) || inConfigDir(p)) continue;
    const d = path.dirname(p);
    perDir.set(d, (perDir.get(d) || 0) + 1);
  }
  if (!perDir.size) return fallback;

  // Counted per repository, not per directory. Work spreads itself across a
  // repository's folders, so no single folder is ever a majority — on the session
  // this was measured against the busiest one held 24% of the paths, and a
  // directory-based vote could never have fired. The memo is shared across the
  // walk rather than keyed on the directories asked about: a session names a few
  // dozen folders and they are mostly the same tree, so after the first one the
  // rest stop at a level already answered for.
  const memo = new Map();
  const repos = new Map();
  const perRepo = new Map();
  let total = 0;
  for (const [d, n] of perDir) {
    const r = repoRoot(d, memo, fallback);
    // Only work inside a repository is a vote for one. Scratch files carry no
    // opinion about which tree the session belongs to, and counting them in the
    // denominator is what sank a real 71% majority to 45% — under the threshold,
    // so the session was read against a tree it had left.
    // Tallied under one spelling. Two paths in the same tree can reach it as
    // C:\Repo and c:\repo, and counted apart they split the vote between two
    // entries that are the same folder — enough to put a clear majority under
    // the threshold. The first spelling seen stands for all of them.
    const key = fold(r);
    if (!repos.has(key)) repos.set(key, isRepo(r) ? r : null);
    const canon = repos.get(key);
    if (!canon) continue;
    perRepo.set(canon, (perRepo.get(canon) || 0) + n);
    total += n;
  }
  if (!total) return fallback;
  let best = null, bestN = 0;
  for (const [r, n] of perRepo) if (n > bestN) { bestN = n; best = r; }

  // it has to be most of the work, and somewhere else — that it is a repository
  // at all is already settled, since nothing else was allowed to vote
  if (!best || samePath(best, fallback) || bestN / total < 0.5) return fallback;
  return best;
}

export class Project {
  constructor(root) {
    this.root = path.resolve(root);              // identity: slug, session list, ?project=
    this.dir = path.join(projectsDir(), slugOf(this.root));
    // extent: paths, the file list, opening. A folder that is not on disk is not
    // a corner of some repository we can widen to — there is nothing to widen,
    // and the page already has a way to say the folder is gone. Asking git got
    // this right by failing from a directory it could not stand in; walking up
    // gets it wrong by succeeding, and hands a deleted worktree its parent
    // repository's file list, against which nothing it touched is ever found.
    // Sorting a *path* into a repository still walks up — that is where the walk
    // earns its keep, and it is untouched by this.
    this.base = fs.existsSync(this.root) ? repoRoot(this.root) : this.root;
    this.sessions = new Map(); // id -> Session
    this.bases = new Map();    // id -> where that session actually worked
  }

  // The extent a given session should be read against. Per session, because one
  // recorded folder can hold a hundred of them and a handful can have wandered.
  baseFor(id) {
    if (!/^[A-Za-z0-9-]+$/.test(id)) return this.base;
    if (!this.bases.has(id))
      this.bases.set(id, workedIn(path.join(this.dir, id + '.jsonl'), this.base));
    return this.bases.get(id);
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
      this.sessions.set(id, new Session({ id, dir: this.dir, root: this.baseFor(id) }));
    }
    return this.sessions.get(id);
  }

  // The file list barely moves and walking a big tree isn't free, so hold it for
  // a while instead of rebuilding it on every page load. Async because the page
  // now asks again every minute, and shelling out to git synchronously would
  // stop the event loop — and with it every session's event stream — for as long
  // as `git ls-files` takes on a big repo.
  universe(id) {
    // keyed by extent, not by session: a hundred sessions in one folder almost
    // always share it, and the ones that wandered get their own entry.
    // baseFor is synchronous, which is the one thing in here that is — it reads
    // two megabytes and walks some directories, no process behind it, measured
    // at 5ms and once per session. It is not what the paragraph above is about.
    const base = id ? this.baseFor(id) : this.base;
    if (!this._universes) this._universes = new Map();
    const hit = this._universes.get(base);
    if (hit && Date.now() - hit.at < 30000) return Promise.resolve(hit.u);
    if (hit && hit.building) return hit.building;
    const building = this.buildUniverse(base).then((u) => {
      this._universes.set(base, { u, at: Date.now() });
      return u;
    }, (e) => { this._universes.delete(base); throw e; });
    this._universes.set(base, { building, at: 0 });
    return building;
  }

  async buildUniverse(base = this.base) {
    // git ls-files respects .gitignore — the honest coverage denominator. Asking
    // for untracked files too, because a file Claude just wrote is part of the
    // project the moment it exists, not once someone runs git add. --exclude-standard
    // is what keeps that from meaning "and all of node_modules": measured on a repo
    // with 95,203 files under an ignored node_modules, none of them come back, and
    // the walk costs ~30ms more than reading the index alone.
    // stderr is swallowed: outside a repo git complains, and that complaint is
    // not the user's problem.
    const git = (args) => new Promise((resolve) => {
      execFile('git', ['-C', base, ...args],
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
    walk(base, '', 0);
    return capped('walk', files, WALK_CAP);
  }
}
