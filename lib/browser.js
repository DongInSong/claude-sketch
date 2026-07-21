// Opening the page, and knowing when not to.
//
// Restarting the server used to pile up browser tabs: a new one every time,
// while the tab you already had sat there. The page recovers on its own now, so
// the second window is not just noise, it is the wrong one — the old tab is the
// one with your scroll position. If we opened a tab for this port recently,
// assume it is still there and leave it to reload itself.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const RECENT_MS = 10 * 60 * 1000;

const markFile = (port) => path.join(os.tmpdir(), `claude-sketch-${port}.opened`);

export function openedRecently(port, now = Date.now()) {
  try {
    return now - fs.statSync(markFile(port)).mtimeMs < RECENT_MS;
  } catch {
    return false;                      // never opened, or the temp file is gone
  }
}

export function markOpened(port) {
  try { fs.writeFileSync(markFile(port), new Date().toISOString()); } catch { /* not worth failing over */ }
}

export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  try {
    // a missing xdg-open arrives as an async 'error' event, which would
    // otherwise be an unhandled throw — the URL is printed either way
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
