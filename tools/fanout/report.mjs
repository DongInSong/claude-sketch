// Turns a recorded trace into the numbers the caps depend on.
//
//   node tools/fanout/report.mjs [trace.jsonl] [skipMsFromStart]
//
// The second argument exists because a recorder started after the fan-out picks
// its whole backlog up in one flush, and that flush reports as enormous event
// lag. Drop the first couple of seconds and the artifact goes with it — or start
// the recorder first and pass nothing.

import fs from 'node:fs';

const NOW_MS = 20000;      // how long a mark lives, from the page
const LIVE_MAX = 8;        // the cap being argued about
const STEP = 250;          // how often the state is sampled

const [, , FILE = 'fanout-trace.jsonl', SKIP = '0'] = process.argv;
const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean)
  .map(l => JSON.parse(l)).filter(l => l.at >= Number(SKIP));

const scans = lines.filter(l => l.k === 'scan');
const ops = lines.filter(l => l.k === 'op' && l.file).sort((a, b) => a.ts - b.ts);
if (!ops.length) { console.log('nothing recorded'); process.exit(0); }

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const f1 = (n) => n.toFixed(1);
const sum = (a) => a.reduce((x, y) => x + y, 0);

const T0 = ops[0].ts, T1 = ops[ops.length - 1].ts, span = (T1 - T0) / 1000;
const agents = new Set(ops.map(o => o.agent));
console.log(`${ops.length} file-touching calls · ${agents.size} agents · ${f1(span)}s\n`);

// ── what the tailer costs, and how far behind it runs ──────────────────────
const sms = scans.map(s => s.ms);
console.log('tailer');
console.log(`  scan()  n=${scans.length}  avg ${f1(sum(sms) / sms.length)}ms  p90 ${f1(pct(sms, 0.9))}ms  max ${f1(Math.max(...sms))}ms`);
console.log(`          ~${f1(scans.length / span)} scans/s -> ${f1(sum(sms) / span / 10)}% of one core`);
const lags = ops.map(o => o.lag).filter(x => x != null && x >= 0);
console.log(`  lag     p50 ${pct(lags, 0.5)}ms  p90 ${pct(lags, 0.9)}ms  max ${Math.max(...lags)}ms`);
const byAgent = new Map();
for (const o of ops) { if (!byAgent.has(o.agent)) byAgent.set(o.agent, []); byAgent.get(o.agent).push(o); }
const gaps = [];
for (const [, l] of byAgent) for (let i = 1; i < l.length; i++) gaps.push(l[i].ts - l[i - 1].ts);
console.log(`  per-agent gap  p50 ${pct(gaps, 0.5)}ms  p90 ${pct(gaps, 0.9)}ms\n`);

// ── how crowded the live set gets ──────────────────────────────────────────
const samples = [];
for (let t = T0; t <= T1; t += STEP) {
  const win = ops.filter(o => o.ts <= t && t - o.ts < NOW_MS);
  const per = new Map();
  for (const o of win) { if (!per.has(o.file)) per.set(o.file, new Set()); per.get(o.file).add(o.agent); }
  samples.push({
    t, files: per.size,
    agents: new Set(win.map(o => o.agent)).size,
    shared: [...per.values()].filter(s => s.size > 1).length,
  });
}
// Only while something is live. A trace that kept recording after the fan-out
// finished would otherwise divide every percentage by its own idle tail, and
// "hiding files 66% of the time" would quietly become 32% by running longer.
const busy = samples.filter(s => s.agents > 0);
const share = (f) => f1(busy.filter(f).length / busy.length * 100) + '%';
const files = busy.map(s => s.files), live = busy.map(s => s.agents);
console.log(`crowding (uncapped, ${NOW_MS / 1000}s mark lifetime, `
  + `over the ${f1(busy.length * STEP / 1000)}s something was live)`);
console.log(`  live files   p50 ${pct(files, 0.5)} · p90 ${pct(files, 0.9)} · max ${Math.max(...files)}`);
console.log(`  live agents  p50 ${pct(live, 0.5)} · p90 ${pct(live, 0.9)} · max ${Math.max(...live)}`);
console.log(`  more than one agent live: ${share(s => s.agents > 1)}`);
// The cap only has anything to answer for while a fan-out is on. Measured
// against a trace that also contains one agent working alone, the same page
// looks half as broken as it is — so say which stretch is being counted.
const fan = busy.filter(s => s.agents > 1);
if (fan.length) {
  const fshare = (f) => f1(fan.filter(f).length / fan.length * 100) + '%';
  console.log(`\n  while 2+ agents are live (${f1(fan.length * STEP / 1000)}s of it)`);
  console.log(`    live files   p50 ${pct(fan.map(s => s.files), 0.5)} · p90 ${pct(fan.map(s => s.files), 0.9)} · max ${Math.max(...fan.map(s => s.files))}`);
  console.log(`    above LIVE_MAX=${LIVE_MAX}: ${fshare(s => s.files > LIVE_MAX)} — files being worked on, not drawn`);
  console.log(`    files with 2+ agents on them: max ${Math.max(...fan.map(s => s.shared))} at once, present ${fshare(s => s.shared > 0)}`);
}
console.log();

// ── the arrow ──────────────────────────────────────────────────────────────
let best = { n: 0, t: T0 };
for (let t = T0; t <= T1; t += 500) {
  const n = ops.filter(o => o.ts >= t && o.ts < t + 10000).length;
  if (n > best.n) best = { n, t };
}
const win = ops.filter(o => o.ts >= best.t && o.ts < best.t + 10000);
let one = 0;
for (let i = 1; i < win.length; i++) if (win[i].file !== win[i - 1].file) one++;
const each = [...new Set(win.map(o => o.agent))].map(a => {
  const l = win.filter(o => o.agent === a);
  let j = 0; for (let i = 1; i < l.length; i++) if (l[i].file !== l[i - 1].file) j++;
  return j;
});
console.log('the arrow');
console.log(`  busiest 10s: ${win.length} calls · ${new Set(win.map(o => o.agent)).size} agents`);
console.log(`    one shared arrow : ${one} jumps in 10s`);
console.log(`    per-agent arrows : median ${pct(each, 0.5)} jumps in 10s, worst ${Math.max(...each)}`);

// what each key would be pointing at: how old is the thing under the arrow
const ageFile = [], ageAgent = [];
for (const s of samples) {
  const last = new Map();
  for (const o of ops) if (o.ts <= s.t && s.t - o.ts < NOW_MS) last.set(o.file, Math.max(last.get(o.file) || 0, o.ts));
  for (const [, ts] of last) ageFile.push(s.t - ts);
  for (const [, l] of byAgent) {
    const e = l.filter(o => o.ts <= s.t).pop();
    if (e && s.t - e.ts < NOW_MS) ageAgent.push(s.t - e.ts);
  }
}
const stale = (a) => `p50 ${(pct(a, 0.5) / 1000).toFixed(1)}s · p90 ${(pct(a, 0.9) / 1000).toFixed(1)}s · over 5s: ${f1(a.filter(x => x > 5000).length / a.length * 100)}%`;
console.log(`  keyed by file : ${stale(ageFile)}`);
console.log(`  keyed by agent: ${stale(ageAgent)}\n`);

// ── the clock ──────────────────────────────────────────────────────────────
let tsTies = 0;
for (let i = 1; i < ops.length; i++) if (ops[i].ts === ops[i - 1].ts) tsTies++;
const arr = [...ops].sort((a, b) => a.at - b.at);
let atTies = 0;
for (let i = 1; i < arr.length; i++) if (arr[i].at === arr[i - 1].at) atTies++;
const flush = new Map();
for (const o of ops) { if (!flush.has(o.at)) flush.set(o.at, []); flush.get(o.at).push(o.ts); }
const many = [...flush.values()].filter(v => v.length > 1);
const spread = many.map(v => Math.max(...v) - Math.min(...v));
console.log('the clock — what Date.now() stamping would collapse');
console.log(`  consecutive events sharing a transcript ts : ${tsTies} / ${ops.length - 1}`);
console.log(`  consecutive events sharing an arrival ms   : ${atTies} / ${ops.length - 1}`);
if (spread.length)
  console.log(`  real time spanned inside one flush        : p50 ${pct(spread, 0.5)}ms · max ${Math.max(...spread)}ms`);
