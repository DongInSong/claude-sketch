// Best-effort list prices in USD per million tokens. Rates change and vary by
// plan, so treat every number here as an estimate and correct it yourself:
// drop a JSON file at ~/.claude-sketch.pricing.json with the same shape and
// it wins. Models with a null entry are reported as "rate unknown" rather than
// guessed at.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PRICING = {
  cacheReadFactor: 0.1,     // cached input is an order of magnitude cheaper
  cacheWriteFactor: 1.25,   // writing the cache costs a little more than fresh input
  models: {
    opus:   { in: 15,  out: 75 },
    sonnet: { in: 3,   out: 15 },
    haiku:  { in: 0.8, out: 4 },
    fable:  null,           // not published here — set your own rate
    mythos: null,
  },
};

export function loadPricing() {
  const fp = path.join(os.homedir(), '.claude-sketch.pricing.json');
  try {
    const user = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return {
      ...DEFAULT_PRICING, ...user,
      models: { ...DEFAULT_PRICING.models, ...(user.models || {}) },
      source: fp,
    };
  } catch {
    return { ...DEFAULT_PRICING, source: null };
  }
}
