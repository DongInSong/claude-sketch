// Incremental parser for Claude Code session JSONL lines.
// Emits compact events the front-end consumes:
//   {t:'op',    ts, agent, op, act, file, id}   one tool call
//                (op is the coarse kind the file panels colour by — read/grep/edit/
//                 del for work on a file; or a non-file activity: bash/task/web/
//                 browse/data/mcp/flow. act is the finer verb for the label: a Bash
//                 is git/test/build/install/run, a Grep is search, a Task delegate.)
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
//   {t:'open',  agent, ts}   the assistant's turn opened — a prompt landed and a
//                            reply is owed; it is working even before its first tool call
//   {t:'end',   agent, ts}   the assistant ended its turn (stop_reason end_turn) —
//                            the ball is back with the user

const OP_MAP = {
  Read: 'read',
  Grep: 'grep', Glob: 'grep',
  WebSearch: 'web', WebFetch: 'web',        // not a file — its own activity, not a grep
  Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Bash: 'bash',
  Task: 'task', Agent: 'task',
  Workflow: 'flow',
};

// The finer verb, where it differs from the coarse op. Read/Edit are named by
// themselves and Bash by its command, so they are not listed; anything missing
// falls back to its op.
const ACT = {
  Grep: 'search', Glob: 'search',
  WebSearch: 'web', WebFetch: 'web',
  Task: 'delegate', Agent: 'delegate',
  Workflow: 'orchestrate',
};

// A Bash command's flavour, read off the command itself — git work, a test run, a
// build, an install, or plain shell. The doodle wants the gist, not a parse, so
// this is first words and markers, not a grammar.
function bashKind(cmd) {
  const s = String(cmd || '').toLowerCase();
  if (/(^|[\s;&|(])(git|gh)\s/.test(s)) return 'git';
  if (/(^|[\s;&|(])(pytest|jest|vitest|mocha|rspec|phpunit|ava)\b/.test(s)
      || /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/.test(s)
      || /\b(go|cargo|mvn|gradle|dotnet)\s+test\b/.test(s)
      || /\bnode\s+--test\b/.test(s)) return 'test';
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b/.test(s)
      || /(^|[\s;&|(])(make|cmake|tsc|webpack|rollup|esbuild)\b/.test(s)
      || /\bvite\s+build\b/.test(s) || /\bdocker\s+build\b/.test(s)
      || /\b(go|cargo|mvn|gradle)\s+(build|package)\b/.test(s)) return 'build';
  if (/\b(npm|pnpm|yarn|bun)\s+(install|add|ci)\b/.test(s)
      || /\b(pip|pip3)\s+install\b/.test(s)
      || /\b(poetry|bundle|gem|go)\s+(add|install|get)\b/.test(s)
      || /\b(apt|apt-get|brew|dnf|yum|apk)\s+(install|add)\b/.test(s)) return 'install';
  return 'run';
}

// MCP tools were dropped for having no file to sit on — but a browser session, a
// database query, a service call are exactly the work that went invisible. The
// name is mcp__<server>__<tool>; the category is read off it.
function mcpKind(name) {
  if (/(^|_)browser_|playwright|puppeteer/i.test(name)) return 'browse';
  if (/postgres|mysql|sqlite|mssql|mongo|redis|(^|_)sql(_|$)|(^|_)query|database|supabase|prisma/i.test(name))
    return 'data';
  return 'mcp';
}

// The list label is the user's own words: the newest prompt, cleaned of
// pasted-image markers and the machinery that rides in on the same channel.
export function cleanPrompt(txt, max = 64) {
  let s = String(txt || '')
    // System records arrive on the user/queue channel too — a background-task
    // notification, a slash-command echo, a reminder. Take each block whole, tag
    // and machine payload both: stripping only the tags left the ids and path
    // inside a <task-notification> as a title reading "b5alp9nx0 toolu_01… /tmp".
    .replace(/<(task-notification|system-reminder|local-command-[a-z-]+|command-[a-z-]+)\b[^>]*>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<\/?teammate-message[^>]*>/g, ' ')   // a hand-off: drop the wrapper, keep the instruction
    .replace(/<[^>]{1,40}>/g, ' ')
    .replace(/\[Image[^\]]*\]/g, ' ')
    .replace(/\[Request interrupted[^\]]*\]/gi, ' ')   // an ESC, not a question the user typed
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Text that ends in a newline has no line after it. Files almost always do, and
// counting the empty tail reported a 145-line file as 146 — and every Write as
// one line longer than it was.
const lines = (s) => {
  const t = s == null ? '' : String(s);
  if (!t) return 0;
  return t.split('\n').length - (t.endsWith('\n') ? 1 : 0);
};

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
      case 'Workflow': return input.name ? String(input.name).slice(0, 60) : 'workflow';
      default: return null;
    }
  }

  // What a tool call is: its coarse op, its finer verb (act), and the label to
  // show. null for the tools that leave only tokens behind — Skill, TodoWrite,
  // the Task* bookkeeping, SendMessage.
  classify(name, input) {
    const op = OP_MAP[name];
    if (op) {
      const file = this.fileFor(name, input);
      if (!file) return null;
      const act = name === 'Bash' ? bashKind(input && input.command) : (ACT[name] || op);
      return { op, act, file };
    }
    if (name.startsWith('mcp__')) return this.mcpOp(name, input);
    return null;
  }

  // mcp__<server>__<tool> → an activity op and a readable detail: the page for a
  // browser call, the query for a database one, the server·tool for the rest.
  mcpOp(name, input) {
    const op = mcpKind(name);
    const rest = name.slice(5);
    const cut = rest.lastIndexOf('__');
    const server = cut > 0 ? rest.slice(0, cut) : rest;
    const tool = cut > 0 ? rest.slice(cut + 2) : rest;
    let file;
    if (op === 'browse')
      file = input && (input.url || input.href)
        ? String(input.url || input.href).slice(0, 80) : tool.replace(/^browser_/, '');
    else if (op === 'data')
      file = input && (input.sql || input.query)
        ? String(input.sql || input.query).replace(/\s+/g, ' ').trim().slice(0, 80) : tool;
    else
      file = server.replace(/^plugin_/, '').replace(/_/g, '-') + ' · ' + tool;
    return { op, act: op, file: file || tool };
  }

  // line: parsed JSON object; agent: label this file belongs to ('main' or subagent label)
  parseLine(line, agent) {
    const out = [];
    if (!line || typeof line !== 'object') return out;

    // The session's title is the user's own question — so only the main thread
    // names it. A subagent's transcript opens with the brief the main gave it
    // ("scope=frontend. …"), a real user-role message; read as a prompt it became
    // the session title, which is main's instruction to a worker, not the user's.
    //
    // A prompt typed while Claude is still working is queued first and only
    // becomes a last-prompt record a turn later — read both so the label keeps up.
    if (line.type === 'queue-operation' && typeof line.content === 'string') {
      const qts = Date.parse(line.timestamp || '') || 0;
      if (agent === 'main') this.setPrompt(line.content, qts, out);
      if (cleanPrompt(line.content)) out.push({ t: 'open', agent, ts: qts || Date.now() });   // a real queued prompt owes a reply
      return out;
    }
    if (line.type === 'last-prompt' && line.lastPrompt) {
      if (agent === 'main') this.setPrompt(line.lastPrompt, 0, out);
      return out;
    }
    if (line.type === 'ai-title' && line.aiTitle) {
      if (agent === 'main') { this.aiTitle = line.aiTitle; this.retitle(out); }
      return out;
    }
    if (line.type === 'summary' && line.summary) {
      if (agent === 'main') {
        if (!this.aiTitle) this.aiTitle = line.summary;
        this.retitle(out);
      }
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
        const cls = this.classify(c.name, c.input);
        if (!cls) continue;                     // Skill/TodoWrite/Task*/SendMessage: usage-only
        const { op, act, file } = cls;
        const ev = { t: 'op', ts, agent, op, act, file, id: c.id };
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
            out.push({ t: 'op', ts, agent, op: 'del', act: 'del', file: this.rel(g), id: c.id + '#d' + i }));
        }
      }
      // end_turn hands control back to the user; anything else (tool_use, or a
      // partial still streaming) leaves the turn open. Streamed rewrites restate
      // the same stop_reason, so this is idempotent for the front-end.
      if (msg.stop_reason === 'end_turn') out.push({ t: 'end', agent, ts });
      return out;
    }

    if (line.type === 'user' && typeof msg.content === 'string') {
      if (line.isMeta) return out;          // a local-command caveat: not a turn, not a title
      if (agent === 'main') this.setPrompt(msg.content, ts, out);
      // A slash-command record (<command-name>…, <local-command-stdout>…) cleans
      // to nothing — it is not a prompt the assistant answers, so no turn opens.
      if (cleanPrompt(msg.content)) out.push({ t: 'open', agent, ts });
      return out;
    }
    if (line.type === 'user' && Array.isArray(msg.content)) {
      // A prompt with an image attached arrives as text blocks plus an image
      // block, not a tool_result — the string branch above never sees it, so a
      // question with a screenshot went unread and the title stalled on the last
      // text-only one. Read its text; the tool_result loop below skips it. But
      // the same shape carries machinery too — a skill's injected instructions
      // (isMeta), an ESC's "[Request interrupted by user]" — so the string
      // branch's guards apply here as well: skip isMeta, and let cleanPrompt drop
      // the rest. peekTail reads only string content, so without matching guards
      // the parser took titles it never did, and the name changed on click.
      if (!line.isMeta && !msg.content.some(c => c && c.type === 'tool_result')) {
        const text = msg.content
          .filter(c => c && c.type === 'text' && typeof c.text === 'string')
          .map(c => c.text).join(' ').trim();
        if (text) {
          if (agent === 'main') this.setPrompt(text, ts, out);
          if (cleanPrompt(text)) out.push({ t: 'open', agent, ts });
        }
      }
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
