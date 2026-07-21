// One observed session: the main JSONL plus any subagent files under
// <sessionId>/subagents/**. Zero-dependency tailing via a polling loop —
// robust across platforms and network mounts, cheap at this file count.

import fs from 'node:fs';
import path from 'node:path';
import { SessionParser } from './parser.js';

const POLL_MS = 600;          // while anything is moving
const IDLE_MS = 2500;         // after a spell of silence
const IDLE_AFTER = 8;         // quiet scans before backing off
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
  }

  // First sighting of a subagent file: name it from its meta and announce the
  // Task call that spawned it, so the UI can pair agent ↔ brief ↔ timing.
  label(agentId) {
    if (this.agentLabels.has(agentId)) return this.agentLabels.get(agentId);
    let label = 'agent-' + agentId.slice(0, 6), meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(
        path.join(this.subDir, 'subagents', `agent-${agentId}.meta.json`), 'utf8'));
      label = meta.agentType || label;
      if ([...this.agentLabels.values()].includes(label)) label += ' #' + (this.agentLabels.size + 1);
    } catch { /* workflow agents ship no meta */ }
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
    try { entries = fs.readdirSync(subRoot, { recursive: true }); } catch { return; }
    for (const e of entries) {
      const name = String(e);
      if (!name.endsWith('.jsonl') || !path.basename(name).startsWith('agent-')) continue;
      const agentId = path.basename(name).slice(6, -6);
      this.tailFile(path.join(subRoot, name), this.label(agentId));
    }
  }

  // Catching up on a backlog reschedules immediately; a quiet session backs off.
  tick() {
    this.quiet++;
    this.scan();
    if (!this.started) return;
    const wait = this.behind ? 0 : (this.quiet >= IDLE_AFTER ? IDLE_MS : POLL_MS);
    this.timer = setTimeout(() => this.tick(), wait);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.tick();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
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
