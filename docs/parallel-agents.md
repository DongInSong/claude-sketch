# The live layer under many agents

What the panel does when several agents are working at once, why, and what the
numbers behind it were. All of it is measured against a fan-out generated on
purpose, and the harness that generates it is in
[`tools/fanout/`](../tools/fanout) — so none of this has to be taken on trust,
and the next person to argue about a cap can run it again.

Built, not proposed: an arrow per live agent, a mark cap of 32 that says what it
is hiding, transcript timestamps instead of arrival ones, and a tailer that
reads the file a watch named rather than every file the session ever spawned.
What is still open is at the bottom.

## The symptom

Run something that spawns a lot of subagents — an ultracode workflow, a wide
fan-out — and the arrow on the live layer stops reading as a pointer. It jumps
between files several times a second. The marks underneath are fine; it is the
one arrow that thrashes.

## What was measured

Nine workers on a fixture tree of thirty small modules: overlapping reads, a hot
file everybody touches, one exclusive edit each. Tailed with the tool's own
`Session` class, so what is timed is the real pipeline and not a model of it.
Two waves; the first was thrown away because the recorder started late and its
cold start showed up as ten-second event lag. What follows is the clean one.

```
143 file-touching calls · 10 agents

busiest ten seconds        40 calls · 9 agents
  one shared arrow         38 jumps in 10s
  per-agent arrows         median 3 jumps in 10s, worst 3
per-agent gap              p50 2.35s · p90 3.37s

while two or more agents are live — 66s of it
  live files (uncapped)    p50 14 · p90 25 · max 27
  time above LIVE_MAX = 8  74.6%
```

Conditioned on a fan-out actually being on, because that is the only stretch the
cap has anything to answer for. Counted against the whole recording — which
contains one agent working alone either side of the wave — the same page looks
half as broken as it is, and a longer recording would make it look better still.
`report.mjs` prints the span it counted for exactly that reason.

The earlier round of measurements — taken against a session that no longer
exists on this machine — said 39 jumps across 9 agents, gaps of 1.5–2.8s, and
19–74% of the time above the cap. All three come back. The live-file peak does
not: thirty fixture files is a ceiling, and the 96-file extreme the old notes
describe is out of reach of a sandbox this size. Treat p90 26 as a floor.

**Two agents on one file is the normal case, not the edge case.**

```
files with 2+ agents on them   max 13 at once · present 92.8% of the fan-out
```

`LIVE_MAX = 8` cannot draw that. The cap was justified by counting how many
files were touched inside any one *second*; a mark lives for twenty. The comment
measures the wrong window, and for three quarters of a fan-out the page is
hiding files that are being worked on right now.

## Why it happens

39 jumps in ten seconds is not something any agent does. It is nine serial
streams superimposed on one pointer. Each agent moves every ~2.3s, which is
comfortably readable — the thrash is an artifact of representing N concurrent
actors with a single marker, not a property of the work.

That reframes the fix: the arrow does not need slowing down, it needs splitting
up. The question is what to split it *by*.

## Ruled out

**A dwell time on the single arrow.** Hold the arrow on a file for ~800ms before
it may move. Rejected: it buys legibility by dropping information — roughly 12
of 39 events would ever be pointed at, and the one shown is already over by the
time it is read. Real-time accuracy is the point of the panel, so this trades
away the thing being paid for. (This was the first proposal here and it was
wrong; the objection that killed it was the right one.)

**One arrow per live file.** This was the second proposal here, and it fails the
same objection the first one did. An arrow keyed by file outlives the work: the
mark stays up for twenty seconds, so the arrow goes on pointing long after that
file's last event.

```
age of whatever the arrow is pointing at
  keyed by file    p50 6.9s · p90 17.2s · over 5s: 58.9%
  keyed by agent   p50 2.2s · p90 15.0s · over 5s: 35.0%
```

Well over half of what a per-file arrow points at is more than five seconds
stale, against a third when keyed by agent — and an agent's arrow is always its
own *current*
target rather than a place one of them happened to be. Keying by file also
scales with the wrong number — live files have no ceiling, live agents peak at
ten — so the cap bites constantly and LRU decides what is hidden.

**Per-agent colour or texture.** Colour is already committed to the kind of work
— read, search, edit — and the footprints legend now draws the map's own cells
to promise exactly that. Spending the same axis on identity breaks a promise the
page makes on screen.

**The agent's name on the arrow.** Measured in the page's own font against the
836px footprints panel, with the arrow shaft included:

```
"reading!  838 lines"        170px    4 fit    ← today's full form
"#36 838"                     98px    8 fit    ← what the old notes proposed
"workflow-subagent 3  838"   240px    3 fit    ← what a workflow fan-out is called
"general-purpose 2  838"     222px    3 fit
"Explore 3  838"             140px    5 fit
"ws3  838"                    78px   10 fit
```

`#36` is not a name this codebase produces. `label()` appends that suffix only
when two agents share a type, and `nameAgents()` throws it away on purpose —
the number counts transcripts, not agents. What actually reaches the screen is
the role, and the roles are long: the nine workers in the run above were all
`workflow-subagent`, numbered 1 to 9. The old notes' "9 fit" is 3 in the case
that matters most.

## What it does now

An arrow per live agent, carrying a short code and the payload. The code is the
role's initials and the index `nameAgents()` already assigns — `ws3`, `gp2`,
`E1` — and the same code goes in the agents panel beside the full name, so the
key to the map is drawn with the map's own pieces. `read` is dropped from the
label: the highlighter colour already says it. Line counts and edit deltas stay
— they are the payload, and hover is not enough when the point is watching it
happen.

Several agents on one file share an arrow and read `ws3 gp2` rather than
stacking identical arrows on the same 22px cell. That case is 92.8% of a
fan-out, so it is the normal one; drawing it six times is noise, not
information. Past three names it says `+n`.

Each arrow carries its own colour and its own word. Those used to come off
`S.now`, a single global — which cannot be right once six arrows are pointing at
six different kinds of work at once.

Two caps rather than one, because a mark and an arrow cost different amounts:

```
marks    32    a 22px cell; cheap, does not collide
arrows    6    ~90px plus vertical space; collides
```

Drawing was never what justified the old cap. Measured in a browser with the
real primitives, one frame across all three panels:

```
 8 marks / 1 arrow     52µs     1.0% of a core at 20fps
24 marks / 5 arrows   174µs     3.5%
49 marks / 8 arrows   322µs     6.5%
96 marks / 8 arrows   536µs    10.7%
```

The expensive thing sat beside the drawing, not in it. `drawLive()` read
`offsetLeft`/`offsetTop` off every live fog cell every frame; on a 5000-file
repo, once a DOM write has invalidated layout, that is 1.4ms a frame — three
times the cost of drawing ninety-six marks, twenty times a second, to learn
where boxes are that had not moved. The rects are cached now, rebuilt when a
render replaces them or a panel's width stops matching. That is what pays for
the bigger cap.

What the cap cuts is said out loud — `+7 more being touched`, under the map —
rather than dropped, the way coverage says `only the first 20000 of 20026`.
Marks past the cap are still tracked, which is the only way to know how many
there are to admit to.

The shake stays for now. Six shaking labels may be too much, but that is not
answerable on paper — it is built, so put it in front of a real fan-out and look.

When only one agent is live the full form stays: `ws1` means nothing when there
is only `main`.

## What the run turned up in the pipeline

**Marks were stamped with the wrong clock.** `applyEvent` set a mark's `ts` from
`Date.now()` — when the browser saw it — while the transcript's own timestamp was
right there on the event.

```
consecutive events sharing a transcript ts    0 / 136
consecutive events sharing an arrival ms     24 / 136
real time spanned inside one flush            p50 60ms · max 114ms
```

Nothing is genuinely simultaneous; the arrival clock invented it for 18% of
consecutive events, and same-millisecond ties had already put a blue "reading!"
on a green edit once. `ts` and the ordering come from `ev.ts` now, clamped so a
timestamp in the future cannot outlive its twenty seconds, and moving forward
only so a flush that delivers an older event after a newer one cannot walk a
mark's clock backwards. `born` — the stroke's own clock, which decides how far
the highlighter has been drawn on — stays on `Date.now()`, because that one
really is about the browser.

**Late line counts were dropped.** A read's `rows` arrives with the result and
was folded onto the live mark only if that mark was still a read. When a second
agent edited the same file first, the count went on the floor — and two agents
on one file is 92.8% of a fan-out. Whether the result was a read is remembered
from the call that made it, on `S.opFiles`, rather than guessed from whatever
the mark says by the time it lands.

**`scan()` cost what the whole session had spawned, not what was live.** Every
wake walked the subagent tree and stat'd every transcript in it, finished ones
included.

```
 9 subagents   avg 1.44ms per scan
18 subagents   avg 1.80ms · max 23.0ms
extrapolated to 325, at the ~8 scans/s a fan-out drives: 19.7% of a core
```

It scaled with the wrong number, and it is synchronous, so it landed on the same
event loop the SSE writes go out on — against the directory Claude Code is
writing to, on the machine it is working on. `fs.watch` already says which file
changed and the callback threw both arguments away. It keeps a dirty set now:

```
full scan(), 22 transcripts   1.607ms
scanDirty(), one named file   0.020ms      82x
```

The full walk still runs on the poll, so a watch that silently delivers nothing
— which is how they behave on some network mounts and container filesystems —
costs nothing, and anything the dirty path cannot place, such as the new nested
directory a workflow agent first appears as, sends it straight back to the walk.
Discovery had to stay as quick as it was: all nine workers were picked up within
166ms of their first call, and trading that for a cheaper scan would be paying
in the only currency this panel has.

**What is not wrong.** The tailer keeps up: a subagent's event reaches it in
p50 151ms, p90 166ms, and every one of the nine workers was picked up within
166ms of its first call. Only `main` runs late — up to ~10s, because its
transcript is flushed on the turn, not on the call. The 600ms poll floor was
never reached; the watches do their job.

## Still to work out

- **Placement.** Two arrows on files that sit near each other can still overlap.
  Agents on the *same* file share one arrow, so the exact-overlap case is gone,
  but nothing spaces out neighbours. Keyed by agent the set is stable between
  frames, so a slot can be held and only given up after a delay — that is the
  shape of the fix, and it is not written.
- **Eviction across two caps.** A file that keeps its mark, loses its arrow and
  gets it back must not re-animate as though it were new. `born` survives, so
  the highlighter does not re-strike; the arrow appearing again is untested.
- **Whether six is right.** The cap is not measured, only afforded. Put it in
  front of a wide fan-out and count how many labels can actually be read.
- **The boil that isn't.** The comment on the live marks promises lines that
  crawl, redrawn on a fresh seed ten times a second. The seed is per mark and
  `prog` saturates at 340ms, so after that every frame is pixel-identical: the
  cost of an animation with none of the effect. Either vary the seed or cache
  the static marks and composite only what moves — but decide, rather than
  leaving the comment describing something that does not happen.

## One bug this turned up

`Session.label()` looked for an agent's meta at `subagents/agent-<id>.meta.json`
while `scan()` walks `subagents/**`, where workflow agents actually live —
`subagents/workflows/wf_x/`. On the session above, 31 of 31 metas were nested and
none were read, so every agent fell back to a hash and the agents list, the
tooltips and the filter all said `agent-a1d1de`. The meta sits beside the
transcript; it is now read from there. All 37 agents in that session come back
named.
