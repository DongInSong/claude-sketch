// Tails a live session with claude-sketch's own Session class and writes one
// JSON line per event: the transcript's own timestamp, when the tailer actually
// saw it, and which agent it belonged to. Every scan() is timed too, because
// what that costs is the load the tool puts on the machine Claude Code is
// working on.
//
//   node tools/fanout/record.mjs <sessionId> [seconds] [outFile]
//
// Start it BEFORE the fan-out. It primes itself to the current end of every
// transcript it can already see, so nothing that happened earlier is recorded —
// a recorder started late reports its own cold start as ten seconds of event
// lag, which is not a thing that happens to a page that was already open.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''));
const { Session } = await import(pathToFileURL(path.join(HERE, '..', '..', 'lib', 'session.js')).href);

const [, , ID, SECS = '300', OUT = 'fanout-trace.jsonl'] = process.argv;
if (!ID) {
  console.error('usage: node tools/fanout/record.mjs <sessionId> [seconds] [outFile]');
  process.exit(1);
}

const BASE = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects')
  : path.join(os.homedir(), '.claude', 'projects');

const dir = fs.readdirSync(BASE)
  .map(p => path.join(BASE, p))
  .find(p => fs.existsSync(path.join(p, ID + '.jsonl')));
if (!dir) { console.error(`no transcript for ${ID} under ${BASE}`); process.exit(1); }

const sess = new Session({ id: ID, dir, root: process.cwd() });

// Prime past the backlog: start every transcript that already exists at its
// current end, so only what happens from now on is recorded.
//
// Every transcript, not just the main one. Priming main alone left the subagent
// files at offset 0, so the first scan replayed every wave that had ever run in
// this session — 245 reads of a fixture that had been rebuilt twice, all of them
// reported as arriving in one flush, seconds stale. Exactly the artifact this is
// supposed to avoid, one directory over.
const prime = (fp, agent) => {
  try { sess.tails.set(fp, { offset: fs.statSync(fp).size, rest: '', agent }); } catch { /* not there */ }
};
prime(path.join(dir, ID + '.jsonl'), 'main');
const subRoot = path.join(dir, ID, 'subagents');
try {
  for (const e of fs.readdirSync(subRoot, { recursive: true })) {
    const name = String(e);
    if (!name.endsWith('.jsonl') || !path.basename(name).startsWith('agent-')) continue;
    const fp = path.join(subRoot, name);
    prime(fp, sess.label(path.basename(name).slice(6, -6), path.dirname(fp)));
  }
} catch { /* no subagents yet, which is the clean case */ }

const out = fs.createWriteStream(path.resolve(OUT), { flags: 'w' });
const t0 = Date.now();
let scans = 0, scanMs = 0, scanMax = 0, evs = 0;

const realScan = sess.scan.bind(sess);
sess.scan = function () {
  const a = process.hrtime.bigint();
  realScan();
  const ms = Number(process.hrtime.bigint() - a) / 1e6;
  scans++; scanMs += ms; if (ms > scanMax) scanMax = ms;
  out.write(JSON.stringify({ k: 'scan', at: Date.now() - t0, ms: +ms.toFixed(3) }) + '\n');
};

sess.subscribe(list => {
  const seen = Date.now();
  for (const ev of list) {
    if (ev.t === 'agent') {
      out.write(JSON.stringify({ k: 'agent', at: seen - t0, name: ev.name, type: ev.agentType }) + '\n');
      continue;
    }
    if (ev.t !== 'op' && ev.t !== 'res') continue;
    evs++;
    out.write(JSON.stringify({
      k: ev.t, at: seen - t0,                    // when the tailer saw it
      ts: ev.ts,                                 // what the transcript says
      lag: ev.ts ? seen - ev.ts : null,
      agent: ev.agent, op: ev.op, file: ev.file, id: ev.id, rows: ev.rows,
    }) + '\n');
  }
});

console.log(`recording ${SECS}s of ${ID} -> ${path.resolve(OUT)}`);
const iv = setInterval(() => {
  process.stdout.write(`\r${((Date.now() - t0) / 1000) | 0}s  events ${evs}  scans ${scans}  `
    + `avg ${(scanMs / Math.max(1, scans)).toFixed(2)}ms  max ${scanMax.toFixed(1)}ms   `);
}, 2000);

setTimeout(() => {
  clearInterval(iv);
  sess.stop();
  out.end();
  console.log(`\ndone: ${evs} events, ${scans} scans, `
    + `avg ${(scanMs / Math.max(1, scans)).toFixed(2)}ms, max ${scanMax.toFixed(1)}ms`);
  process.exit(0);
}, Number(SECS) * 1000);
