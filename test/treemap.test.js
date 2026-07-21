// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { squarify, heatScore } from '../public/lib/treemap.js';

const area = (r) => r.w * r.h;
const overlap = (a, b) =>
  a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 &&
  a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;

test('squarify(): area is proportional to weight — that is the whole claim', () => {
  const items = [{ wt: 4 }, { wt: 3 }, { wt: 2 }, { wt: 1 }];
  squarify(items, 0, 0, 100, 100);
  const total = items.reduce((s, i) => s + i.wt, 0);
  for (const it of items)
    assert.ok(Math.abs(area(it.rect) - (it.wt / total) * 10000) < 1,
      `weight ${it.wt} got area ${area(it.rect)}`);
});

test('squarify(): tiles stay inside the box and never overlap', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ wt: 12 - i }));
  squarify(items, 10, 20, 300, 180);
  for (const it of items) {
    const r = it.rect;
    assert.ok(r.x >= 9.99 && r.y >= 19.99 && r.x + r.w <= 310.01 && r.y + r.h <= 200.01,
      `escaped the box: ${JSON.stringify(r)}`);
  }
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      assert.ok(!overlap(items[i].rect, items[j].rect), `tiles ${i} and ${j} overlap`);
});

test('squarify(): keeps tiles roughly square rather than slivered', () => {
  const items = Array.from({ length: 9 }, () => ({ wt: 1 }));
  squarify(items, 0, 0, 300, 300);
  for (const it of items) {
    const ratio = Math.max(it.rect.w / it.rect.h, it.rect.h / it.rect.w);
    assert.ok(ratio < 2, `aspect ratio ${ratio.toFixed(2)} is a sliver`);
  }
});

test('squarify(): degenerate inputs do not throw', () => {
  assert.doesNotThrow(() => squarify([], 0, 0, 100, 100));
  assert.doesNotThrow(() => squarify([{ wt: 1 }], 0, 0, 0, 0));
});

test('heatScore(): recent activity outweighs the same activity earlier', () => {
  const COLS = 30;
  const now = { hb: { 100: 1 }, total: 1 };
  const old = { hb: { 90: 1 }, total: 1 };
  assert.ok(heatScore(now, 100, COLS) > heatScore(old, 100, COLS));
});

test('heatScore(): a long-worked file never reads as stone cold', () => {
  const COLS = 30;
  const busyLongAgo = { hb: {}, total: 50 };
  const untouched = { hb: {}, total: 0 };
  assert.equal(heatScore(untouched, 100, COLS), 0);
  assert.ok(heatScore(busyLongAgo, 100, COLS) > 0);
});

test('heatScore(): only counts back as far as the strip shows', () => {
  const COLS = 30;
  const outside = { hb: { 60: 100 }, total: 0 };     // 40 buckets ago, off the strip
  assert.equal(heatScore(outside, 100, COLS), 0);
});
