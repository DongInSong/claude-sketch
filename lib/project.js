// Project-level discovery: which sessions exist for a working directory,
// and the file universe (for coverage / fog map).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Session } from './session.js';
import { cleanPrompt } from './parser.js';

export function slugOf(projectRoot) {
  return path.resolve(projectRoot).replace(/[^A-Za-z0-9]/g, '-');
}

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');

// The slug can't be reversed into a path (every separator becomes a dash), but
// the transcripts record the cwd they ran in, so read it back out of them.
export function listProjects(limit = 40) {
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
          const st = fs.statSync(fp); return { fp, mtimeMs: st.mtimeMs }; })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch { continue; }
    if (!files.length) continue;

    const root = readCwd(files[0].fp, slug);
    if (!root) continue;
    out.push({ root, slug, sessions: files.length, mtimeMs: files[0].mtimeMs,
      exists: fs.existsSync(root) });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
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

export class Project {
  constructor(root) {
    this.root = path.resolve(root);
    this.dir = path.join(os.homedir(), '.claude', 'projects', slugOf(this.root));
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
      sessions: files.map(f => ({
        id: f.id,
        title: this.peekTitle(f.fp) || f.id.slice(0, 8),
        mtimeMs: f.mtimeMs,
        size: f.size,
        active: now - f.mtimeMs < 5 * 60 * 1000,
      })),
    };
  }

  // label = the newest user prompt (what the session is actually about),
  // falling back to the model-written title. Tail scan only — no full parse.
  peekTitle(fp) {
    try {
      const st = fs.statSync(fp);
      const fd = fs.openSync(fp, 'r');
      try {
        for (const [from, size] of [[Math.max(0, st.size - 262144), 262144], [0, 32768]]) {
          const buf = Buffer.alloc(Math.min(size, st.size));
          fs.readSync(fd, buf, 0, buf.length, from);
          const text = buf.toString('utf8');
          const grab = re => { const m = [...text.matchAll(re)].pop();
            try { return m ? JSON.parse('"' + m[1] + '"') : null; } catch { return null; } };
          const prompt = cleanPrompt(grab(/"lastPrompt":"((?:[^"\\]|\\.)*)"/g));
          if (prompt) return prompt;
          const title = grab(/"aiTitle":"((?:[^"\\]|\\.)*)"/g)
                     || grab(/"type":"summary","summary":"((?:[^"\\]|\\.)*)"/g);
          if (title) return cleanPrompt(title, 64);
        }
      } finally { fs.closeSync(fd); }
    } catch { /* ignore */ }
    return null;
  }

  session(id) {
    if (!/^[A-Za-z0-9-]+$/.test(id)) return null;
    if (!this.sessions.has(id)) {
      if (!fs.existsSync(path.join(this.dir, id + '.jsonl'))) return null;
      this.sessions.set(id, new Session({ id, dir: this.dir, root: this.root }));
    }
    return this.sessions.get(id);
  }

  universe() {
    // The file list barely moves and walking a big tree isn't free, so hold it
    // for a while instead of rebuilding it on every page load.
    if (this._universe && Date.now() - this._universeAt < 30000) return this._universe;
    const built = this.buildUniverse();
    this._universe = built;
    this._universeAt = Date.now();
    return built;
  }

  buildUniverse() {
    // git ls-files respects .gitignore — the honest coverage denominator.
    // stderr is swallowed: outside a repo git complains, and that complaint is
    // not the user's problem.
    try {
      const out = execFileSync('git', ['-C', this.root, 'ls-files'],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      const files = out.split('\n').filter(Boolean);
      if (files.length) return { source: 'git', files: files.slice(0, 30000) };
    } catch { /* not a git repo */ }
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
    walk(this.root, '', 0);
    return { source: 'walk', files };
  }
}
