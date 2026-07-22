// One observed session: the main JSONL plus any subagent files under
// <sessionId>/subagents/**. Zero-dependency tailing via a polling loop —
// robust across platforms and network mounts, cheap at this file count.

import fs from 'node:fs';
import path from 'node:path';
import { SessionParser } from './parser.js';

const POLL_MS = 600;          // while anything is moving
const IDLE_MS = 2500;         // after a spell of silence
const IDLE_AFTER = 8;         // quiet scans before backing off
const WAKE_MS = 40;           // coalesce a burst of filesystem events into one scan
const WAKE_GAP = 120;         // ...and never scan more often than this on their account
const CHUNK = 8 * 1024 * 1024;
const BUDGET = 32 * 1024 * 1024;   // bytes per tick: keeps the event loop breathing
// Lines that can't hold anything we extract are never JSON.parsed. Transcripts
// run to hundreds of MB, mostly attachment and text payloads.
const INTERESTING = /"tool_use"|"tool_result"|"usage"|"lastPrompt"|"aiTitle"|"summary"/;

export class Session {
  constructor({ id, dir, root }) {
    this.id = id;
    this.dir = dir;                       // project slug dir
    this.mainPath = path.join(dir, id + '.jsonl');
    this.subDir = path.join(dir, id);     // contains subagents/
    this.parser = new SessionParser(root);
    this.tails = new Map();               // filePath -> {offset, rest, agent}
    this.agentLabels = new Map();         // agentId -> label
    this.events = [];
    this.listeners = new Set();
    this.timer = null;
    this.started = false;
    this.quiet = 0;            // consecutive scans that found nothing
    this.budget = 0;           // bytes left to read this tick
    this.behind = false;       // more data waiting than the budget allowed
    this.watchers = [];        // filesystem watches, when the platform has them
    this.wakeT = null;
    this.subWatched = false;
    this.lastScan = 0;
  }

  // The poll interval is a floor on how late an event can be: up to 600ms while
  // a session is busy, and up to 2500ms for the first tool call after a pause —
  // which is precisely the one being waited for. The filesystem can say "this
  // grew" as it happens, so listen where that works and leave the poll as what
  // it should have been all along, a safety net: watches are unreliable on
  // network mounts, silently deliver nothing on some container filesystems, and
  // cannot be set up for a directory that does not exist yet. Nothing here can
  // make an event arrive later than the poll would have brought it.
  watch() {
    const wake = () => {
      if (this.wakeT || !this.started) return;
      const since = Date.now() - this.lastScan;
      this.wakeT = setTimeout(() => {
        this.wakeT = null;
        if (!this.started) return;
        this.quiet = 0;                 // something moved: come off the idle interval
        this.tick();
      }, Math.max(WAKE_MS, WAKE_GAP - since));
    };
    this.wake = wake;
    this.addWatch(this.dir);            // the main transcript
    this.watchSubs(path.join(this.subDir, 'subagents'));
  }

  addWatch(dir, opts) {
    try {
      const w = fs.watch(dir, opts || {}, this.wake);
      w.on('error', () => { /* the poll still covers this file */ });
      this.watchers.push(w);
      return true;
    } catch {
      return false;   // no such directory, no inotify slots, no recursive support here
    }
  }

  // Subagent transcripts nest (subagents/workflows/wf_x/agent-*.jsonl), so this
  // one wants recursion — which Linux only grew in Node 20. It also tends not to
  // exist when the session starts, so scan() offers it again once it appears.
  watchSubs(subRoot) {
    if (this.subWatched || !this.started) return;
    if (this.addWatch(subRoot, { recursive: true }) || this.addWatch(subRoot))
      this.subWatched = true;
  }

  // First sighting of a subagent file: name it from its meta and announce the
  // Task call that spawned it, so the UI can pair agent ↔ brief ↔ timing.
  //
  // `dir` is the folder the transcript was found in, because that is where its
  // meta sits. This used to look in subagents/ and nowhere else, while scan()
  // walks the tree beneath it — so a workflow agent, whose files live in
  // subagents/workflows/wf_x/, never had its meta read. The catch swallowed it
  // and every one of them fell back to a hash: measured on a session running
  // 32 subagents, 31 of the 32 metas were nested and none were found, so the
  // agents list, the tooltips and the filter all read agent-a1d1de rather than
  // what the agent was. They do ship a meta; we were looking one level up.
  label(agentId, dir) {
    if (this.agentLabels.has(agentId)) return this.agentLabels.get(agentId);
    let label = 'agent-' + agentId.slice(0, 6), meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(
        path.join(dir || path.join(this.subDir, 'subagents'), `agent-${agentId}.meta.json`), 'utf8'));
      label = meta.agentType || label;
      if ([...this.agentLabels.values()].includes(label)) label += ' #' + (this.agentLabels.size + 1);
    } catch { /* no meta beside it: the hash is all there is */ }
    this.agentLabels.set(agentId, label);
    this.emit([{ t: 'agent', name: label, agentId,
      agentType: meta && meta.agentType || null,
      description: meta && meta.description || null,
      toolUseId: meta && meta.toolUseId || null,
      depth: meta && meta.spawnDepth || 1 }]);
    return label;
  }

  emit(evs) {
    if (!evs.length) return;
    this.events.push(...evs);
    if (this.events.length > 20000) this.events.splice(0, this.events.length - 20000);
    for (const fn of this.listeners) fn(evs);
  }

  // Drains a file up to this tick's byte budget; anything left over is picked up
  // on the immediate follow-up scan rather than one chunk per poll interval.
  tailFile(fp, agent) {
    let st;
    try { st = fs.statSync(fp); } catch { return; }
    let tail = this.tails.get(fp);
    if (!tail) { tail = { offset: 0, rest: '', agent }; this.tails.set(fp, tail); }
    // A file that got shorter was truncated or replaced under us, and reading on
    // from the old offset would mean never reading it again — silently, for as
    // long as the page stayed open. Start it over: the parser keys tool calls and
    // usage by id, so a second pass over the same lines lands on the same totals.
    if (st.size < tail.offset) { tail.offset = 0; tail.rest = ''; }
    if (st.size <= tail.offset || this.budget <= 0) {
      if (st.size > tail.offset) this.behind = true;
      return;
    }

    const fd = fs.openSync(fp, 'r');
    try {
      while (tail.offset < st.size && this.budget > 0) {
        const want = Math.min(st.size - tail.offset, CHUNK, this.budget);
        const buf = Buffer.alloc(want);
        const read = fs.readSync(fd, buf, 0, want, tail.offset);
        if (read <= 0) break;
        tail.offset += read;
        this.budget -= read;
        this.quiet = 0;
        const chunk = tail.rest + buf.toString('utf8', 0, read);
        const lines = chunk.split('\n');
        tail.rest = lines.pop() ?? '';
        const evs = [];
        for (const ln of lines) {
          if (ln.length < 24 || !INTERESTING.test(ln)) continue;
          let obj;
          try { obj = JSON.parse(ln); } catch { continue; }
          evs.push(...this.parser.parseLine(obj, tail.agent));
        }
        this.emit(evs);
      }
      if (tail.offset < st.size) this.behind = true;
    } finally {
      fs.closeSync(fd);
    }
  }

  scan() {
    this.budget = BUDGET;
    this.behind = false;
    this.tailFile(this.mainPath, 'main');
    // subagent transcripts appear under <sessionId>/subagents/ (possibly nested,
    // e.g. subagents/workflows/wf_x/agent-*.jsonl)
    const subRoot = path.join(this.subDir, 'subagents');
    let entries = [];
    try { entries = fs.readdirSync(subRoot, { recursive: true }); }
    catch { this.lastScan = Date.now(); return; }
    this.watchSubs(subRoot);            // it is there now; it may not have been at start()
    for (const e of entries) {
      const name = String(e);
      if (!name.endsWith('.jsonl') || !path.basename(name).startsWith('agent-')) continue;
      const fp = path.join(subRoot, name);
      const agentId = path.basename(name).slice(6, -6);
      this.tailFile(fp, this.label(agentId, path.dirname(fp)));
    }
    this.lastScan = Date.now();
  }

  // Catching up on a backlog reschedules immediately; a quiet session backs off.
  // Clears the pending timer first, so a watch that wakes this out of turn moves
  // the existing loop along rather than starting a second one.
  tick() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.quiet++;
    this.scan();
    if (!this.started) return;
    const wait = this.behind ? 0 : (this.quiet >= IDLE_AFTER ? IDLE_MS : POLL_MS);
    this.timer = setTimeout(() => this.tick(), wait);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.watch();
    this.tick();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.wakeT) clearTimeout(this.wakeT);
    this.wakeT = null;
    for (const w of this.watchers) { try { w.close(); } catch { /* already gone */ } }
    this.watchers = [];
    this.subWatched = false;
    this.started = false;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    this.start();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) this.stop();
    };
  }
}
