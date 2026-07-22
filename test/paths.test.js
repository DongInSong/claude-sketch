// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirOf, isWastePath, shortDir, computeRoot, stripRoot, dirLabel, shortModel }
  from '../public/lib/paths.js';

test('dirOf(): buckets a path by its directory, web calls by themselves', () => {
  assert.equal(dirOf('lib/server.js'), 'lib');
  assert.equal(dirOf('a/b/c/d.js'), 'a/b/c');
  assert.equal(dirOf('README.md'), '(root)');
  assert.equal(dirOf('web: how to squarify'), '(web)');
  assert.equal(dirOf('https://example.com/x'), '(web)');
});

test('isWastePath(): flags vendored and generated trees, not lookalikes', () => {
  for (const p of ['node_modules/x/y.js', 'a/node_modules/b.js', 'dist/main.js',
                   '.venv/lib/x.py', 'src/__pycache__/m.pyc', 'data/cache/blob'])
    assert.equal(isWastePath(p), true, p);
  for (const p of ['src/distance.js', 'app/building.ts', 'lib/venvy.js', 'my-dist/x'])
    assert.equal(isWastePath(p), false, p);
});

test('shortDir(): keeps the tail, leaves bucket names alone', () => {
  assert.equal(shortDir('a/b/c/d', 2), '…/c/d');
  assert.equal(shortDir('a/b', 2), 'a/b');
  assert.equal(shortDir('(root)', 2), '(root)');
  assert.equal(shortDir('a/b/c/d/e', 3), '…/c/d/e');
});

test('computeRoot(): the prefix every directory shares, or nothing', () => {
  assert.equal(computeRoot(['src/a', 'src/b/c', 'src/d']), 'src');
  assert.equal(computeRoot(['src/a', 'test/b']), '');
  assert.equal(computeRoot(['only/one']), '', 'a single directory has no common prefix worth hiding');
  assert.equal(computeRoot(['src/a', '(web)', '(root)']), '', 'buckets are not directories');
  assert.equal(computeRoot(['a/b/c', 'a/b/d']), 'a/b');
});

test('computeRoot(): one stray folder does not cost everyone else their prefix', () => {
  // the shape that made it come back empty on every real session measured: nine
  // directories deep under one tree, and a single file written somewhere else
  const dirs = [
    'docs/product-intro/20260622/captures',
    'docs/product-intro/20260622/captures/02-observability/01-overview',
    'docs/product-intro/20260622/captures/02-observability/02-trace',
    'docs/product-intro/20260622/captures/02-observability/03-network',
    'docs/product-intro/20260622/captures/05-flow/fixedlen',
    'docs/product-intro/20260622/captures/light-theme',
    'docs/product-intro/20260622/captures/slide-thumbnails',
    '.playwright-mcp',
  ];
  assert.equal(computeRoot(dirs), 'docs/product-intro/20260622/captures');
  // and the stray one keeps its whole name, because it is not under that prefix
  assert.equal(stripRoot('.playwright-mcp', computeRoot(dirs)), '.playwright-mcp');
});

test('computeRoot(): a genuine even split still hides nothing', () => {
  assert.equal(computeRoot(['src/a', 'src/b', 'test/c', 'test/d']), '',
    'neither half is most of it, so there is no honest prefix to pull out');
});

test('stripRoot(): drops the shared prefix without eating a sibling', () => {
  assert.equal(stripRoot('src/lib', 'src'), 'lib');
  assert.equal(stripRoot('src', 'src'), './');
  assert.equal(stripRoot('srcextra/lib', 'src'), 'srcextra/lib', 'prefix must end at a separator');
  assert.equal(stripRoot('(root)', 'src'), '(root)');
  assert.equal(stripRoot('src/lib', ''), 'src/lib');
});

test('dirLabel(): strip the root, then shorten what is left', () => {
  assert.equal(dirLabel('proj/a/b/c/d', 2, 'proj'), '…/c/d');
  assert.equal(dirLabel('proj/lib', 2, 'proj'), 'lib');
});

test('shortModel(): strips the vendor prefix and the date suffix', () => {
  assert.equal(shortModel('claude-opus-4-8'), 'opus-4-8');
  assert.equal(shortModel('claude-haiku-4-5-20251001'), 'haiku-4-5');
  assert.equal(shortModel(''), '');
  assert.equal(shortModel(null), '');
});
