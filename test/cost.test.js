// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { rateFor, costOf, fmtUsd, fmtTok } from '../public/lib/cost.js';
import { DEFAULT_PRICING } from '../lib/pricing.js';

const P = DEFAULT_PRICING;                     // the shape the server actually sends
const M = 1e6;
const agent = (o) => ({ model: 'claude-opus-4-8', fresh: 0, cw: 0, cr: 0, tout: 0, ...o });

test('rateFor(): matches on the family inside the model id', () => {
  assert.deepEqual(rateFor('claude-opus-4-8', P), { in: 15, out: 75 });
  assert.deepEqual(rateFor('claude-sonnet-5', P), { in: 3, out: 15 });
  assert.equal(rateFor('claude-fable-5', P), null, 'a null entry is "unknown", not free');
  assert.equal(rateFor('something-else', P), null);
  assert.equal(rateFor('claude-opus-4-8', null), null);
});

test('costOf(): each kind of input is priced differently', () => {
  assert.equal(costOf(agent({ fresh: M }), P).usd, 15);
  assert.equal(costOf(agent({ cw: M }), P).usd, 15 * 1.25, 'writing the cache costs a little more');
  assert.equal(costOf(agent({ cr: M }), P).usd, 15 * 0.1, 'replaying it is an order of magnitude less');
  assert.equal(costOf(agent({ tout: M }), P).usd, 75);
});

test('costOf(): the headline case — a huge cached context is not a huge bill', () => {
  // 8.4M input tokens, all of it replayed from cache, against 485 fresh
  const { usd, known } = costOf(agent({ fresh: 485, cr: 8.4 * M, tout: 10600 }), P);
  assert.equal(known, true);
  assert.ok(usd > 12 && usd < 14, `expected ~$12.60, got ${usd}`);
  const naive = ((485 + 8.4 * M) / M) * 15 + (10600 / M) * 75;
  assert.ok(naive > usd * 9, 'billing cache reads at full rate would overstate it ~10x');
});

test('costOf(): an unpublished rate reports unknown rather than guessing', () => {
  const r = costOf(agent({ model: 'claude-fable-5', fresh: M }), P);
  assert.deepEqual(r, { usd: 0, known: false });
});

test('costOf(): a user pricing file can override the factors', () => {
  const mine = { ...P, cacheReadFactor: 0.5, models: { ...P.models, opus: { in: 10, out: 50 } } };
  assert.equal(costOf(agent({ cr: M }), mine).usd, 10 * 0.5);
});

test('fmtUsd(): loud about dollars, quiet about cents', () => {
  assert.equal(fmtUsd(0.004), '<$0.01');
  assert.equal(fmtUsd(0.03), '$0.03');
  assert.equal(fmtUsd(9.99), '$9.99');
  assert.equal(fmtUsd(151.4), '$151');
});

test('fmtTok(): thousands and millions', () => {
  assert.equal(fmtTok(485), '485');
  assert.equal(fmtTok(10600), '10.6k');
  assert.equal(fmtTok(8.4e6), '8.4M');
});
