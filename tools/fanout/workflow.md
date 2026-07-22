# The fan-out itself

Nine workers, run in parallel, each following a fixed script of about fifteen
tool calls. Two things in it are deliberate:

- **overlapping reads.** Three files everybody reads, plus each worker's
  neighbours. Two agents on one file is the case the live layer handles worst,
  so it has to be in the fixture rather than left to chance.
- **exclusive edits.** Each worker owns three files nobody else edits. Edits that
  collide fail on a string mismatch, and a failed edit is traffic that never
  reaches the page — which would quietly bias the very numbers being measured.

Save as a Claude Code workflow script and run it while `record.mjs` is going.
`SB` must point at the fixture tree.

```js
export const meta = {
  name: 'fanout-fixture',
  description: 'Nine workers doing small reads and edits on a fixture tree',
  phases: [{ title: 'Fanout', detail: 'nine workers, overlapping reads, exclusive edits' }],
}

const SB = '<absolute path to ./fanout-fixture>'
const DIRS = ['core', 'util', 'net']
const f = (i) => `${SB}/${DIRS[i % 3]}/mod${String(i).padStart(2, '0')}.js`
const HOT = [f(0), f(1), f(2)]        // the file the treemap should shout about

const SCHEMA = {
  type: 'object',
  properties: { calls: { type: 'integer' }, edited: { type: 'integer' } },
  required: ['calls', 'edited'],
  additionalProperties: false,
}

const work = []
for (let i = 0; i < 9; i++) work.push({
  i,
  mine: [f(i), f(i + 9), f(i + 18)],                        // nobody else edits these
  shared: [f((i + 1) % 30), f((i + 2) % 30), f((i + 15) % 30)],
})

phase('Fanout')

const results = await parallel(work.map(w => () => agent(
`You are a fixture worker in a measurement run. Do not explain anything, do not
summarise, do not plan. Just make the tool calls below in order, one at a time.

Work ONLY on these exact paths. Do not touch anything else.

1.  Read ${HOT[0]}
2.  Read ${w.shared[0]}
3.  Read ${w.mine[0]}
4.  Edit ${w.mine[0]} — change the line "export const VERSION = 1;" to "export const VERSION = ${2 + w.i};"
5.  Read ${HOT[1]}
6.  Grep for "VERSION" in ${SB} (output_mode "count")
7.  Read ${w.mine[1]}
8.  Edit ${w.mine[1]} — change "export const VERSION = 1;" to "export const VERSION = ${2 + w.i};"
9.  Read ${w.shared[1]}
10. Read ${HOT[2]}
11. Read ${w.mine[2]}
12. Edit ${w.mine[2]} — change "export const VERSION = 1;" to "export const VERSION = ${2 + w.i};"
13. Read ${w.shared[2]}
14. Read ${HOT[0]} again
15. Grep for "apply" in ${SB} (output_mode "files_with_matches")

If an Edit fails because the string does not match, skip it and move to the next
step — do not retry, do not investigate.

Then return only the counts.`,
  { label: `worker ${w.i + 1}`, phase: 'Fanout', schema: SCHEMA, model: 'haiku', effort: 'low' }
)))

const ok = results.filter(Boolean)
log(`${ok.length}/9 workers finished`)
return {
  workers: ok.length,
  calls: ok.reduce((a, r) => a + (r.calls || 0), 0),
  edits: ok.reduce((a, r) => a + (r.edited || 0), 0),
}
```

Fifteen steps and no room to improvise is the point: the workers are a traffic
generator, not a task. Left to their own judgement they explore, and the cadence
stops being reproducible between waves.
