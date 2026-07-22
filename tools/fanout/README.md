# Generating a fan-out to measure

The caps in the live layer — how many files may wear a mark, how many arrows may
be on screen — are only defensible if the numbers behind them can be produced
again. The session the first round was measured against is gone, and its numbers
could not be checked. This is so the next round can be.

It makes a real fan-out: nine subagents doing real reads and edits on a tree of
thirty tiny modules, recorded through the tool's own tailer.

## Run it

```bash
node tools/fanout/fixture.mjs ./fanout-fixture       # 30 small files to work on
node tools/fanout/record.mjs <sessionId> 300 &       # start this FIRST
# …then run a fan-out over ./fanout-fixture — see workflow.md
node tools/fanout/report.mjs fanout-trace.jsonl
```

`<sessionId>` is the Claude Code session doing the work: the transcript name
under `~/.claude/projects/<slug>/`, or `$CLAUDE_CONFIG_DIR/projects/<slug>/`.

Start the recorder **before** the fan-out. It primes past whatever is already on
disk, so a late start reports its own backlog as ten seconds of event lag — an
artifact that threw away the first wave of the last round.

Re-run `fixture.mjs` between waves. The workers edit `VERSION`, and an edit whose
string no longer matches never happens, which quietly changes the traffic mix.

## What it reports

```
tailer      scan() cost, event lag, per-agent call cadence
crowding    live files and live agents over time, uncapped;
            how much of the run sits above LIVE_MAX;
            how often two agents are on the same file
the arrow   jumps in the busiest ten seconds, one shared arrow vs one per agent;
            how out of date each keying would leave the thing being pointed at
the clock   how many events a Date.now() stamp would make simultaneous
```

## Keeping it cheap

The workers are the expensive part, so: small files, a fixed script of about
fifteen tool calls each, and a model to match. The last full run was 9 agents,
135 tool calls and ~230k tokens per wave, on Haiku at low effort — a couple of
minutes and pocket change.

Haiku moves faster than the models a real fan-out usually runs, so the gaps
between one agent's calls come out tighter than life. That makes it a stress
case, which is the right direction for sizing a cap. The fixture's thirty files
also put a ceiling on the live-file count — read that number as a floor.

See [workflow.md](workflow.md) for the fan-out script itself, and
[`../../docs/parallel-agents.md`](../../docs/parallel-agents.md) for what the
numbers were used to decide.
