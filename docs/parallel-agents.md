# The live layer under many agents

Notes on an unfinished change. Nothing here is decided; the numbers are, so start
with those.

## The symptom

Run something that spawns a lot of subagents — an ultracode workflow, a wide
fan-out — and the arrow on the live layer stops reading as a pointer. It jumps
between files several times a second. The marks underneath are fine; it is the
one arrow that thrashes.

## What was measured

Against a live session in `MesimConsole-observability/docker/observability`
(`4952f5bc`, 457 file calls over 12 minutes, 24 distinct agents), and across the
84 sessions on this machine that ran two or more subagents.

**The busiest ten seconds of that live session**

```
39 tool calls · 9 agents
one shared arrow  : 39 jumps in 10s
per-agent arrows  : median 5 jumps in 10s, worst 6
per-agent gap     : 1.5 – 2.8s between calls
```

**How crowded the live set gets**

```
live agents      peak 7 · avg 4.9
more than one agent live      99% of the time
```

Across all 84 sessions, peak simultaneous agents came to p50 3 · p90 7 · max 9,
and arrow jumps in the busiest ten seconds to p50 10 · p90 27 · max 73.

**What LIVE_MAX is cutting off.** The cap is 8 files. Uncapped, replaying the
same 20s mark lifetime:

```
peak live files   p50 16 · p90 49 · max 96
time spent above the cap of 8    19% – 74%
```

One session holds 96 files inside one mark lifetime and spends 74% of itself
above the cap. `LIVE_MAX = 8` was justified by measuring how many files were
touched inside any one *second*; a mark lives for twenty. The comment measures
the wrong window, and the value is far too low for a fan-out.

## Why it happens

39 jumps in ten seconds is not something any agent does. It is nine serial
streams superimposed on one pointer. Each agent moves every 1.5–2.8s, which is
comfortably readable — the thrash is an artifact of representing N concurrent
actors with a single marker, not a property of the work.

That reframes the fix: the arrow does not need slowing down, it needs splitting
up.

## Ruled out

**A dwell time on the single arrow.** Hold the arrow on a file for ~800ms before
it may move. Rejected: it buys legibility by dropping information — roughly 12
of 39 events would ever be pointed at, and the one shown is already over by the
time it is read. Real-time accuracy is the point of the panel, so this trades
away the thing being paid for. (This was the first proposal here and it was
wrong; the objection that killed it was the right one.)

**Per-agent colour or texture.** Colour is already committed to the kind of work
— read, search, edit — and the footprints legend now draws the map's own cells
to promise exactly that. Spending the same axis on identity breaks a promise the
page makes on screen.

**Agent labels on the marks themselves.** A footprints cell is 22px wide and
agent labels run to 12 characters. Seven of them do not fit, and the label would
dwarf the thing it labels.

## Where it stands

An arrow per live file, carrying the agent, in a lighter form than the single
arrow wears today. Measured widths in the page's own font, against the 836px
footprints panel:

```
"reading!  838 lines"   153px   5 fit     ← today's full form
"#36 read 838"          119px   7 fit
"#36 838"                86px   9 fit
"#36"                    56px  14 fit
```

`read` is the cheapest to drop: the highlighter colour already says it. Line
counts and edit deltas stay — they are the payload, and hover is not enough when
the point is watching it happen.

Two caps rather than one, because a mark and an arrow cost different amounts:

```
marks    ~24    a 22px cell; cheap, does not collide
arrows    ~8    86px plus vertical space; collides
```

Neither number is settled. p50 uncapped is 16 files, so 24 covers most moments
whole; 8 arrows is what the panel measurably holds. The 96-file extreme is cut
whatever the cap — that should be said out loud rather than silently, the way
coverage says `only the first 20000 of 20026`.

The shake stays for now. Seven shaking labels may be too much, but that is not
answerable on paper — build it, put it in front of a real fan-out, look.

When only one agent is live the full form stays: `#36` means nothing when there
is only `main`.

## Still to work out

Lifecycle, contention and timing, none of it examined yet:

- **`liveCol()` and `liveWord()` read `S.now`,** a single global, while the arrow
  is drawn for whichever mark is `newest`. There is already a guard for the case
  where those two disagree — two events in the same millisecond put a blue
  "reading!" on a green edit. With an arrow per file each one needs its own
  colour and word, so these stop being globals.
- **Two caps mean two sets to keep consistent.** Eviction is LRU on `S.live`; a
  file that keeps its mark but loses its arrow, and gets it back, must not
  re-animate as though it were new.
- **`rows` arrives after the fact.** A read's line count is filled in when the
  `res` event comes back, onto the mark if it is still live. Different caps
  change who is still there to receive it.
- **Agent names arrive asynchronously.** `label()` emits on first sighting and
  `nameAgents()` renumbers on render, so an arrow can be drawn before its agent
  has its final number.
- **Ties in `liveNow()`.** Sorting by timestamp already had a same-millisecond
  bug. With N arrows the tie-break decides layout, and arrows swapping places
  between frames would be worse than the thrash this is meant to fix.
- **Nothing places arrows.** Two can land on top of each other. Any placement
  pass is stateful across frames or it jitters.

## One bug this turned up

`Session.label()` looked for an agent's meta at `subagents/agent-<id>.meta.json`
while `scan()` walks `subagents/**`, where workflow agents actually live —
`subagents/workflows/wf_x/`. On the session above, 31 of 31 metas were nested and
none were read, so every agent fell back to a hash and the agents list, the
tooltips and the filter all said `agent-a1d1de`. The meta sits beside the
transcript; it is now read from there. All 37 agents in that session come back
named.
