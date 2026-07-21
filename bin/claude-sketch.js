#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { Project } from '../lib/project.js';
import { createServer } from '../lib/server.js';

const args = process.argv.slice(2);
const opt = { project: process.cwd(), port: 4517, open: true };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--project' || a === '-p') opt.project = args[++i];
  else if (a === '--port') opt.port = parseInt(args[++i], 10) || 4517;
  else if (a === '--no-open') opt.open = false;
  else if (a === '--help' || a === '-h') {
    console.log(`claude-sketch — live sketch for Claude Code sessions

usage: npx claude-sketch [--project <dir>] [--port <n>] [--no-open]

Reads ~/.claude/projects/<dir-slug>/*.jsonl locally. Nothing leaves your machine.`);
    process.exit(0);
  }
}

const project = new Project(opt.project);
const server = createServer(project);

server.listen(opt.port, '127.0.0.1', () => {
  const url = `http://localhost:${opt.port}`;
  const list = project.list();
  console.log(`✳ claude-sketch`);
  console.log(`  project   ${project.root}`);
  console.log(`  transcripts ${project.dir}`);
  console.log(`  sessions  ${list.sessions ? list.sessions.length : 0} found${list.error ? ' (' + list.error + ')' : ''}`);
  console.log(`  open      ${url}`);
  if (opt.open) {
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    try { spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref(); } catch { /* just print */ }
  }
});
