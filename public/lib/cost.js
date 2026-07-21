// What the work would have cost at API rates. Wrong numbers here are invisible
// — nothing crashes, the figure is just quietly false — so it lives on its own
// with tests around it.
//
// Rates come from the server (~/.claude-sketch.pricing.json overrides them), and
// a model with no rate reports known:false rather than a guess.

const M = 1e6;

export function rateFor(model, pricing) {
  if (!pricing || !model) return null;
  const key = Object.keys(pricing.models).find(k => model.toLowerCase().includes(k));
  return key ? pricing.models[key] : null;
}

// The three kinds of input cost very different amounts, which is the whole point
// of showing them apart: replaying a cached context is an order of magnitude
// cheaper than sending it fresh, and writing that cache costs a little more.
export function costOf(agent, pricing) {
  const r = rateFor(agent.model, pricing);
  if (!r) return { usd: 0, known: false };
  const usd = (agent.fresh / M) * r.in
            + (agent.cw / M) * r.in * (pricing.cacheWriteFactor ?? 1.25)
            + (agent.cr / M) * r.in * (pricing.cacheReadFactor ?? 0.1)
            + (agent.tout / M) * r.out;
  return { usd, known: true };
}

export function fmtUsd(v) {
  return v >= 10 ? '$' + v.toFixed(0) : v >= 0.01 ? '$' + v.toFixed(2) : '<$0.01';
}

export function fmtTok(n) {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
       : n >= 1000 ? (n / 1000).toFixed(1) + 'k'
       : String(n);
}
