// Thirty tiny modules for a fan-out to read and edit.
//
// Small on purpose: what is being measured is the shape of the tool traffic —
// how many agents are live at once, how often the arrow would move, how many
// files wear a mark — and none of that depends on the files being big. It does
// depend on them being cheap, because every read costs the workers tokens.
//
//   node tools/fanout/fixture.mjs [dir] [count]     (default: ./fanout-fixture, 30)
//
// The count is a ceiling on how many files can be live at once, so it decides
// whether a run can reach the mark cap at all. Thirty is enough to watch the
// arrow; to see the cap bite, and to see what it says when it does, it has to be
// comfortably more than LIVE_MAX.

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'fanout-fixture');
const N = Number(process.argv[3] || 30);
const DIRS = ['core', 'util', 'net'];

fs.rmSync(root, { recursive: true, force: true });
for (const d of DIRS) fs.mkdirSync(path.join(root, d), { recursive: true });

for (let i = 0; i < N; i++) {
  const d = DIRS[i % DIRS.length];
  const name = `mod${String(i).padStart(2, '0')}.js`;
  fs.writeFileSync(path.join(root, d, name), [
    `// ${d}/${name} — generated fixture`,
    `export const NAME = '${d}.${name.slice(0, -3)}';`,
    `export const VERSION = 1;`,
    ``,
    `export function apply(x) {`,
    `  return x * ${i + 2};`,
    `}`,
    ``,
    `export function label() {`,
    `  return NAME + '@' + VERSION;`,
    `}`,
    ``,
  ].join('\n'));
}

console.log(`fixture ready: ${root} — ${DIRS.length} dirs, ${N} files`);
console.log('re-run this between waves: the workers edit VERSION, and an edit');
console.log('that no longer matches is an edit that never reaches the page.');
