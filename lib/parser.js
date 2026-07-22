// Incremental parser for Claude Code session JSONL lines.
// Emits compact events the front-end consumes:
//   {t:'op',    ts, agent, op, file, id}        one tool call
//                (edits carry plus/minus: how the file's line count moved;
//                 'rm' inside a Bash command is emitted as its own del op)
//                (op:'task' also carries desc + sub — the spawned agent's brief)
//   {t:'res',   id, len, ts, err}                tool result: size, when, and whether it failed
//                (a task's result timestamp is that subagent's finish time)
//   {t:'model', agent, model}
//   {t:'usage', agent, tin, tout, fresh, cw, cr}  cumulative measured tokens
//                (fresh = new input, cw = cache written, cr = cache read —
//                 they cost very different amounts, so they stay separate)
//   {t:'title', title}

const OP_MAP = {
  Read: 'read',
  Grep: 'grep', Glob: 'grep', WebSearch: 'grep', WebFetch: 'grep',
  Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Bash: 'bash',
  Task: 'task', Agent: 'task',
};

// The list label is the user's own words: the newest prompt, cleaned of
// pasted-image markers and slash-command wrappers.
export function cleanPrompt(txt, max = 64) {
  let s = String(txt || '')
    .replace(/<(local-)?command-[a-z-]+>[\s\S]*?<\/(local-)?command-[a-z-]+>/g, ' ')
    .replace(/<[^>]{1,40}>/g, ' ')
    .replace(/\[Image[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

const lines = s => (s ? String(s).split('\n').length : 0);

// How many lines came back. A Read's result is the file, so this is how much of
// it was actually pulled in — the number worth putting next to the mark. Content
// arrives as a string or as a list of blocks depending on the tool.
function resultRows(content) {
  if (typeof content === 'string') return lines(content);
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) if (b && typeof b.text === 'string') n += lines(b.text);
  return n;
}

// A Bash command is the only way files get deleted, so read the command itself.
const DEL_RE = /(?:^|[;&|]\s*)(?:sudo\s+)?(?:rm|unlink|trash)\s+((?:-{1,2}[\w-]+\s+)*)([^;&|<>]+)/g;
export function deletedPaths(cmd) {
  const out = [];
  for (const m of String(cmd).matchAll(DEL_RE)) {
    for (const raw of m[2].split(/\s+/)) {
      const p = raw.replace(/^['"]|['"]$/g, '').trim();
      // skip flags, shell vars, globs, redirect artefacts ("2" from `2>/dev/null`)
      if (!p || p.startsWith('-') || p.includes('$') || p === '/') continue;
      if (/[*?{}]/.test(p) || /^\d+$/.test(p) || p.startsWith('>')) continue;   // globs & brace lists
      out.push(p);
      if (out.length >= 5) return out;
    }
  }
  return out;
}

// Tool calls report native paths (C:\repo\lib\a.js on Windows) while the file
// universe comes from git, which always speaks forward slashes. Everything the
// front-end matches on — coverage, the fog map, directory grouping — compares
// these two, so both sides are normalised to one shape here.
const slash = p => String(p).replace(/\\/g, '/');
// Windows, and macOS on a default APFS volume, are case-insensitive: /Users/me/Repo
// and /Users/me/repo are the same folder, and the transcript may spell it either way.
const CASE_BLIND = process.platform === 'win32' || process.platform === 'darwin';

export class SessionParser {
  constructor(root) {
    this.root = slash(root).replace(/\/+$/, '') + '/';
    this.rootKey = CASE_BLIND ? this.root.toLowerCase() : this.root;
    this.seenTools = new Set();      // tool_use ids (streaming rewrites lines)
    this.seenResults = new Set();
    this.usageByMsg = new Map();     // message.id -> {agent, fresh, cw, cr, tout}
    this.sums = new Map();           // agent -> running total of the above
    this.totals = new Map();         // agent -> {tin, tout} last announced
    this.models = new Map();         // agent -> model
    this.title = null;
    this.aiTitle = null;
    this.prompt = null;
    this.promptTs = 0;    // last-prompt records get rewritten, so trust timestamps
  }

  // Keeps the newest thing the user actually typed. Queued messages carry a
  // timestamp; last-prompt records don't and are re-emitted every turn, so they
  // only fill in when nothing better has been seen.
  setPrompt(text, ts, out) {
    const c = cleanPrompt(text);
    if (!c) return;
    if (ts ? ts < this.promptTs : this.promptTs) return;
    this.prompt = c;
    if (ts) this.promptTs = ts;
    this.retitle(out);
  }

  // newest prompt wins; the model-written title is the fallback
  retitle(out) {
    const next = this.prompt || this.aiTitle;
    if (next && next !== this.title) {
      this.title = next;
      out.push({ t: 'title', title: next });
    }
  }

  // One message's worth on or off an agent's running total. The ledger it is
  // derived from is never pruned: drop an entry and the next rewrite of that
  // message has nothing to cancel out, so its tokens get counted twice.
  addUsage(agent, u, sign) {
    const s = this.sums.get(agent) || { fresh: 0, cw: 0, cr: 0, tout: 0 };
    s.fresh += sign * u.fresh;
    s.cw += sign * u.cw;
    s.cr += sign * u.cr;
    s.tout += sign * u.tout;
    this.sums.set(agent, s);
  }

  // Only speak up when the total actually moved — a streamed rewrite that
  // restates the same numbers has nothing to say.
  emitUsage(agent, out) {
    const s = this.sums.get(agent);
    if (!s) return;
    const tin = s.fresh + s.cw + s.cr;
    const prev = this.totals.get(agent);
    if (prev && prev.tin === tin && prev.tout === s.tout) return;
    this.totals.set(agent, { tin, tout: s.tout });
    out.push({ t: 'usage', agent, tin, tout: s.tout, fresh: s.fresh, cw: s.cw, cr: s.cr });
  }

  rel(p) {
    if (typeof p !== 'string' || !p) return null;
    const s = slash(p);
    // slash() is length-preserving, so the prefix length carries over to `s`
    const key = CASE_BLIND ? s.toLowerCase() : s;
    return key.startsWith(this.rootKey) ? s.slice(this.root.length) : s;
  }

  fileFor(name, input) {
    if (!input) return null;
    switch (name) {
      case 'Read': return this.rel(input.file_path);
      case 'Edit': case 'Write': case 'MultiEdit': return this.rel(input.file_path);
      case 'NotebookEdit': return this.rel(input.notebook_path);
      case 'Grep': case 'Glob': return this.rel(input.path) || '(project)';
      case 'WebSearch': return input.query ? 'web: ' + String(input.query).slice(0, 60) : null;
      case 'WebFetch': return input.url ? String(input.url).slice(0, 80) : null;
      case 'Bash': return input.command ? String(input.command).slice(0, 120) : null;
      case 'Task': case 'Agent': return input.description ? String(input.description).slice(0, 80) : 'subagent';
      default: return null;
    }
  }

  // line: parsed JSON object; agent: label this file belongs to ('main' or subagent label)
  parseLine(line, agent) {
    const out = [];
    if (!line || typeof line !== 'object') return out;

    // A prompt typed while Claude is still working is queued first and only
    // becomes a last-prompt record a turn later — read both so the label keeps up.
    if (line.type === 'queue-operation' && typeof line.content === 'string') {
      this.setPrompt(line.content, Date.parse(line.timestamp || '') || 0, out);
      return out;
    }
    if (line.type === 'last-prompt' && line.lastPrompt) {
      this.setPrompt(line.lastPrompt, 0, out);
      return out;
    }
    if (line.type === 'ai-title' && line.aiTitle) {
      this.aiTitle = line.aiTitle;
      this.retitle(out);
      return out;
    }
    if (line.type === 'summary' && line.summary) {
      if (!this.aiTitle) this.aiTitle = line.summary;
      this.retitle(out);
      return out;
    }

    const msg = line.message;
    if (!msg) return out;
    const ts = Date.parse(line.timestamp || '') || Date.now();

    if (line.type === 'assistant') {
      if (msg.model && this.models.get(agent) !== msg.model) {
        this.models.set(agent, msg.model);
        out.push({ t: 'model', agent, model: msg.model });
      }
      // measured tokens: usage repeats across streamed rewrites of the same
      // message id, so each id holds one value and a rewrite replaces it. The
      // agent's total moves by the difference — re-summing the whole ledger per
      // message was quadratic over a session, and by twenty thousand messages
      // that was 460ms of blocked event loop on every /events connect.
      if (msg.usage && msg.id) {
        const next = { agent,
          fresh: msg.usage.input_tokens || 0,
          cw: msg.usage.cache_creation_input_tokens || 0,
          cr: msg.usage.cache_read_input_tokens || 0,
          tout: msg.usage.output_tokens || 0 };
        const prev = this.usageByMsg.get(msg.id);
        this.usageByMsg.set(msg.id, next);
        if (prev) this.addUsage(prev.agent, prev, -1);
        this.addUsage(agent, next, 1);
        // a message that changed hands would leave its old agent overstated
        if (prev && prev.agent !== agent) this.emitUsage(prev.agent, out);
        this.emitUsage(agent, out);
      }
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const c of content) {
        if (c.type !== 'tool_use' || !c.id || this.seenTools.has(c.id)) continue;
        this.seenTools.add(c.id);
        // ids only repeat across a message's streamed rewrites, so old ones can go
        if (this.seenTools.size > 20000) this.seenTools = new Set([...this.seenTools].slice(-5000));
        const op = OP_MAP[c.name];
        if (!op) continue;                      // Skill/TodoWrite/mcp etc: usage-only
        const file = this.fileFor(c.name, c.input);
        if (!file) continue;
        const ev = { t: 'op', ts, agent, op, file, id: c.id };
        if (op === 'task' && c.input) {
          ev.desc = c.input.description ? String(c.input.description).slice(0, 120) : null;
          ev.sub = c.input.subagent_type || null;
        }
        // how many lines the edit added or removed (net, per direction)
        if (op === 'edit' && c.input) {
          let plus = 0, minus = 0;
          const step = (oldS, newS) => {
            const d = lines(newS) - lines(oldS);
            if (d > 0) plus += d; else minus += -d;
          };
          if (c.name === 'Write') plus += lines(c.input.content);
          else if (c.name === 'MultiEdit' && Array.isArray(c.input.edits))
            for (const e of c.input.edits) step(e.old_string, e.new_string);
          else step(c.input.old_string, c.input.new_string);
          if (plus) ev.plus = plus;
          if (minus) ev.minus = minus;
        }
        out.push(ev);
        if (c.name === 'Bash' && c.input && c.input.command) {
          const gone = deletedPaths(c.input.command);
          gone.forEach((g, i) =>
            out.push({ t: 'op', ts, agent, op: 'del', file: this.rel(g), id: c.id + '#d' + i }));
        }
      }
      return out;
    }

    if (line.type === 'user' && typeof msg.content === 'string') {
      this.setPrompt(msg.content, ts, out);
      return out;
    }
    if (line.type === 'user' && Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c.type !== 'tool_result' || !c.tool_use_id) continue;
        if (this.seenResults.has(c.tool_use_id)) continue;
        this.seenResults.add(c.tool_use_id);
        if (this.seenResults.size > 20000) this.seenResults = new Set([...this.seenResults].slice(-5000));
        let len = 0;
        try { len = JSON.stringify(c.content ?? '').length; } catch { len = 0; }
        const ev = { t: 'res', id: c.tool_use_id, len, ts, rows: resultRows(c.content) };
        if (c.is_error === true) ev.err = true;      // a failed call is pure waste
        out.push(ev);
      }
    }
    return out;
  }
}
