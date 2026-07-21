// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openedRecently, markOpened, RECENT_MS } from '../lib/browser.js';

const PORT = 65432;                                  // nothing is listening here
const marker = path.join(os.tmpdir(), `claude-sketch-${PORT}.opened`);
const clean = () => { try { fs.unlinkSync(marker); } catch { /* fine */ } };

test('a port we have never opened is not "recently opened"', () => {
  clean();
  assert.equal(openedRecently(PORT), false);
});

test('marking a port makes it recent, and it stops being recent later', (t) => {
  t.after(clean);
  clean();
  markOpened(PORT);
  assert.equal(openedRecently(PORT), true);

  // the tab is long gone by then, so a restart should open a fresh one
  const later = Date.now() + RECENT_MS + 1000;
  assert.equal(openedRecently(PORT, later), false);
});

test('an unreadable marker is treated as never opened, not as an error', (t) => {
  t.after(clean);
  clean();
  assert.doesNotThrow(() => openedRecently(PORT));
  assert.equal(openedRecently(PORT), false);
});
