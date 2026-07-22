#!/usr/bin/env node
// A load generator and a stopwatch for the live path.
//
// Writes a synthetic session — several agents working on different files at the
// same time — into a transcript, then either leaves it there for the real page
// to watch, or connects as its own client and reports what got through and how
// late it was.
//
//   node tools/probe.js --check                 measure; nothing touches ~/.claude
//   node tools/probe.js --agents 5 --rate 20    heavier concurrent load
//   node tools/probe.js --real                  write into the real ~/.claude and
//                                               point claude-sketch at the printed folder
//
// Not part of the package (see "files" in package.json) — it is a bench, not a
// feature.

import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';

const opt = { agents: 3, rate: 12, seconds: 10, check: false, verify: false, real: false, quiet: false };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i], num = () => Number(args[++i]);
  if (a === '--agents') opt.agents = num();
  else if (a === '--rate') opt.rate = num();
  else if (a === '--seconds') opt.seconds = num();
  else if (a === '--check') opt.check = true;
  else if (a === '--verify') { opt.verify = true; opt.check = true; opt.agents = 1; }
  else if (a === '--real') opt.real = true;
  else if (a === '--quiet') opt.quiet = true;
  else if (a === '--help' || a === '-h') { help(); process.exit(0); }
  else { console.error(`probe: unknown option "${a}"`); process.exit(1); }
}
function help() {
  console.log(`probe — synthetic concurrent session, and a stopwatch on the live path

  --agents <n>    agents working at once, main included   (default 3)
  --rate <n>      tool calls per second, across all of them (default 12)
  --seconds <n>   how long to keep it up                  (default 10)
  --check         run a server and a client, and report timings
  --verify        one agent, known input, and assert the stream matches it
                  exactly — counts, op types, edit line deltas, order, tokens
  --real          write into the real ~/.claude instead of a sandbox
  --quiet         only print the summary`);
}

/* ── where the transcript goes ───────────────────────────────────────────── */
const SANDBOX = path.join(os.tmpdir(), 'claude-sketch-probe');
const HOME = opt.real ? os.homedir() : path.join(SANDBOX, 'home');
if (!opt.real) { process.env.HOME = HOME; process.env.USERPROFILE = HOME; }

const ROOT = opt.real ? process.cwd() : path.join(SANDBOX, 'proj');
const slug = path.resolve(ROOT).replace(/[^A-Za-z0-9]/g, '-');
const DIR = path.join(HOME, '.claude', 'projects', slug);
const SID = 'probe0000-0000-4000-8000-' + String(Date.now()).slice(-12);
const MAIN = path.join(DIR, SID + '.jsonl');
const SUBS = path.join(DIR, SID, 'subagents');

fs.mkdirSync(SUBS, { recursive: true });
if (!opt.real) fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true });

/* ── the agents, each on its own patch of the tree ───────────────────────── */
const AGENTS = Array.from({ length: Math.max(1, opt.agents) }, (_, i) => {
  const id = i === 0 ? null : 'agent' + String(i).padStart(4, '0');
  const dir = i === 0 ? 'lib' : `pkg${i}`;
  if (id) fs.writeFileSync(path.join(SUBS, `agent-${id}.meta.json`),
    JSON.stringify({ agentType: ['Explore', 'Plan', 'general-purpose'][i % 3],
      description: `working through ${dir}/`, spawnDepth: 1 }));
  return { id, dir, file: id ? path.join(SUBS, `agent-${id}.jsonl`) : MAIN,
    label: id ? `agent-${id}` : 'main' };
});

fs.writeFileSync(MAIN, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(),
  message: { content: 'probe: several agents at once' } }) + '\n');

const OPS = ['read', 'read', 'edit', 'grep'];
const TOOL = { read: 'Read', edit: 'Edit', grep: 'Grep' };
let seq = 0;
const sent = new Map();          // tool_use id -> {at, file, agent}

function emit(agent) {
  const n = ++seq;
  const op = OPS[n % OPS.length];
  const rel = `${agent.dir}/f${n % 7}.js`;
  const id = `t${n}`;
  const input = op === 'grep' ? { path: `${ROOT}/${agent.dir}` }
    : op === 'edit' ? { file_path: `${ROOT}/${rel}`, old_string: 'a', new_string: 'a\nb' }
    : { file_path: `${ROOT}/${rel}` };
  const line = JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(),
    message: { id: `m${n}`, model: 'claude-opus-4-8',
      usage: { input_tokens: 5, cache_read_input_tokens: 900, output_tokens: 40 },
      content: [{ type: 'tool_use', id, name: TOOL[op], input }] } }) + '\n';
  sent.set(id, { at: Date.now(), file: op === 'grep' ? agent.dir : rel, agent: agent.label,
    seq: n, op, plus: op === 'edit' ? 1 : undefined });
  fs.appendFileSync(agent.file, line);
  return id;
}

// What the transcript said, so the stream can be held against it. One writer, so
// there is exactly one right answer — subagents come after this is solid.
const TOK = { fresh: 5, cr: 900, tout: 40 };
function verify(got, lastUsage) {
  const bad = [];
  const say = (ok, msg) => { if (!ok) bad.push(msg); };

  say(got.length === sent.size, `delivered ${got.length} of ${sent.size} tool calls`);
  const byId = new Map(got.map(g => [g.id, g]));
  say(byId.size === got.length, `${got.length - byId.size} events arrived more than once`);

  for (const [id, want] of sent) {
    const g = byId.get(id);
    if (!g) { say(false, `${id} (${want.op} ${want.file}) never arrived`); continue; }
    say(g.op === want.op, `${id}: op ${g.op}, expected ${want.op}`);
    say(g.file === want.file, `${id}: file ${g.file}, expected ${want.file}`);
    say(g.plus === want.plus, `${id}: plus ${g.plus}, expected ${want.plus}`);
  }
  const order = got.map(g => sent.get(g.id).seq);
  say(order.every((v, i) => i === 0 || v > order[i - 1]), 'events arrived out of order');

  const n = sent.size;
  if (lastUsage) {
    say(lastUsage.tin === (TOK.fresh + TOK.cr) * n,
      `tin ${lastUsage.tin}, expected ${(TOK.fresh + TOK.cr) * n}`);
    say(lastUsage.tout === TOK.tout * n, `tout ${lastUsage.tout}, expected ${TOK.tout * n}`);
    say(lastUsage.cr === TOK.cr * n, `cache read ${lastUsage.cr}, expected ${TOK.cr * n}`);
  } else say(false, 'no usage event arrived at all');

  console.log(`\nground truth — ${n} tool calls from one agent`);
  if (!bad.length) {
    console.log('  ✓ every call delivered exactly once, in order');
    console.log('  ✓ op type, file path and edit line delta match on all of them');
    console.log(`  ✓ tokens add up: ${lastUsage.tin} in (${lastUsage.cr} of it cached), ${lastUsage.tout} out`);
    return true;
  }
  for (const b of bad.slice(0, 12)) console.log('  ✗ ' + b);
  if (bad.length > 12) console.log(`  … and ${bad.length - 12} more`);
  return false;
}

/* ── run the load ────────────────────────────────────────────────────────── */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function load() {
  const gap = 1000 / Math.max(1, opt.rate);
  const until = Date.now() + opt.seconds * 1000;
  let i = 0;
  while (Date.now() < until) {
    // round-robin, so several agents are mid-work at any moment
    emit(AGENTS[i++ % AGENTS.length]);
    await sleep(gap);
  }
}

/* ── what the numbers mean ───────────────────────────────────────────────── */
const pct = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1,
  Math.floor(a.length * p / 100))] : 0;

// The page keeps one "live" slot: the newest event wins it, whatever else is
// going on. So a mark lasts until the next event lands on a different file —
// which under concurrent agents can be no time at all.
function dwell(events) {
  const out = [];
  for (let i = 0; i < events.length; i++) {
    let j = i + 1;
    while (j < events.length && events[j].file === events[i].file) j++;
    out.push((j < events.length ? events[j].at : events[i].at + 20000) - events[i].at);
  }
  return out;
}

// how many distinct files were being worked on inside each one-second window
function fronts(events) {
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const s = new Set();
    for (let j = i; j < events.length && events[j].at - events[i].at < 1000; j++) s.add(events[j].file);
    out.push(s.size);
  }
  return out;
}

async function check() {
  const { Project } = await import('../lib/project.js');
  const { createServer } = await import('../lib/server.js');
  const server = createServer(new Project(ROOT));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const token = (await (await fetch(`http://127.0.0.1:${port}/`)).text())
    .match(/__CS_TOKEN__="([a-f0-9]+)"/)[1];

  const got = [];                       // {id, at, file, agent, lag, op, plus}
  const seenIds = new Set();
  let lastUsage = null;
  await new Promise((ready) => {
    http.get(`http://127.0.0.1:${port}/events?session=${SID}&k=${token}`, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const ln of lines) {
          if (!ln.startsWith('data: ')) continue;
          let d; try { d = JSON.parse(ln.slice(6)); } catch { continue; }
          if (d.t === 'ready') ready();
          if (d.t !== 'backlog') continue;
          const now = Date.now();
          for (const ev of d.events) {
            if (ev.t === 'usage' && ev.agent === 'main') lastUsage = ev;
            if (ev.t !== 'op' || !sent.has(ev.id)) continue;
            if (seenIds.has(ev.id)) { got.push({ ...sent.get(ev.id), id: ev.id, dup: true }); continue; }
            seenIds.add(ev.id);
            const s = sent.get(ev.id);
            got.push({ ...s, id: ev.id, op: ev.op, file: ev.file, plus: ev.plus,
              lag: now - s.at, at: s.at });
          }
        }
      });
    }).end();
  });

  await load();
  await sleep(1200);                    // let the tail drain

  if (opt.verify) {
    const ok = verify(got, lastUsage);
    server.closeAllConnections(); server.close();
    if (!ok) process.exitCode = 1;
    return;
  }

  const lags = got.map(g => g.lag);
  const d = dwell(got.slice().sort((a, b) => a.at - b.at));
  const f = fronts(got.slice().sort((a, b) => a.at - b.at));
  const flash = d.filter(x => x < 200).length;

  console.log(`\nagents ${AGENTS.length} · ${opt.rate}/s · ${opt.seconds}s`);
  console.log(`delivered        ${got.length}/${sent.size}` +
    (got.length === sent.size ? '' : `  ← ${sent.size - got.length} MISSING`));
  console.log(`lag  p50 ${pct(lags, 50)}ms · p90 ${pct(lags, 90)}ms · max ${Math.max(...lags, 0)}ms`);
  console.log(`files being worked on at once   avg ${(f.reduce((a, b) => a + b, 0) / (f.length || 1)).toFixed(1)} · max ${Math.max(...f, 0)}`);
  console.log(`live mark holds                 p50 ${pct(d, 50)}ms · p90 ${pct(d, 90)}ms`);
  console.log(`marks gone in under 200ms       ${flash}/${d.length}` +
    ` (${Math.round(flash / (d.length || 1) * 100)}% — the page shows one file at a time)`);

  server.closeAllConnections();
  server.close();
}

if (opt.check) {
  await check();
  if (!opt.real) fs.rmSync(SANDBOX, { recursive: true, force: true });
} else {
  console.log(`transcript  ${MAIN}`);
  console.log(`project     ${ROOT}`);
  console.log(opt.real
    ? `\nrun:  claude-sketch --project ${ROOT}\n`
    : `\nrun:  HOME=${HOME} npx claude-sketch --project ${ROOT}\n`);
  await load();
  console.log(`wrote ${seq} tool calls across ${AGENTS.length} agents`);
}
// exitCode, not exit(0) — --verify sets it on failure and a hard exit would
// swallow that, which makes the whole thing a rubber stamp in a script
process.exit(process.exitCode || 0);
