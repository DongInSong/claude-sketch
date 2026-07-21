# ✳ claude-sketch

**English** · [한국어](README.ko.md) · [日本語](README.ja.md) · [中文](README.zh.md)

> Claude Code just read `fusion.py` for the sixth time.
> It also went for a stroll through `vendor/urllib3/`.
> You had no idea. Now you do.

**claude-sketch** draws — in crayon — what Claude Code is touching in your repo,
live. Which files it stepped on, which ones it never opened, where the attention
actually went, what it deleted, what it broke, and how many tokens the whole
adventure took.

No account. No cloud. No config. It reads the session transcripts Claude Code
already writes to your disk, and nothing ever leaves your machine.

```bash
npx claude-sketch
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshot-dark.png">
  <img src="docs/screenshot.png" alt="claude-sketch showing footprints, attention share and file heat for a live session">
</picture>

---

## What you're looking at

**✳ footprints** — every file in the repo, one folder per line. Crayon fill = Claude
stepped on it. Dashed outline = a neighbour, revealed so you can see *what it walked
past*. `⋯ 16 ⋯` = a stretch it never went near, folded up so a monorepo doesn't turn
into wallpaper. The counter says `16 / 58 (28%)` — that's coverage, honestly counted
against `git ls-files`.

**◆ attention share** — a treemap where **area = tool calls**, so the picture *is* the
verdict. When one file swallows a third of the frame and it's a config you asked
nobody to touch, you don't need a metric to tell you something went sideways.
Bright = recent, big = cumulative, `+3 −1` = lines that moved.

**▨ file heat** — the last 5 minutes, an hour, or the whole session, 30 columns wide.
Darker crayon = busier slice. This is where a rhythm shows up: read, read, edit,
run, read, read… or the sadder one: read, read, read, read, read.

**Margin notes** — the sheet writes on itself. *"fusion.py read 6× — probably already
in context."* *"poking dependency/cache paths 9×."* *"edit → run loop detected —
healthy rhythm."* Praise included; it's not only here to nag.

**Agents** — `main ─task▶ subagents`, each with its model, its brief in its own words,
whether it's still running, and how long it took. Model names are ranked by family:
**✦ Fable** shimmers in gold, **◆ Opus** in bold accent, **◇ Sonnet** in ink, *Haiku*
light and quick. You can tell at a glance which tier is burning.
Click one and every view narrows to that agent alone.

---

## The number that surprises everyone

```
fresh in 485 · cache 8.4M (100% reused) · out 10.6k · ≈$0.03 at API rates
```

Claude Code replays almost your entire context from cache on every turn. A raw
"8.4M input tokens" reads like a disaster and means nothing; the number that costs
you is **485**. claude-sketch splits fresh input from cache traffic, shows the reuse
rate, and converts the lot into an API-price equivalent using a rate table you can
edit (`~/.claude-sketch.pricing.json`). On a subscription you aren't billed per
token at all — read the figure as *the size of the work*, not a bill.

And the other honest number: **failed calls**. A tool call that comes back an error
spent tokens and bought nothing. They're counted per file and per agent, so the
file that keeps erroring out is impossible to miss.

---

## Install

```bash
npx claude-sketch                       # watch the current directory
npx claude-sketch --project ~/dev/app   # watch another project
npx claude-sketch --port 5000 --no-open
```

Or keep it around:

```bash
npm i -g claude-sketch
cd ~/dev/app && claude-sketch
```

| option | |
|---|---|
| `-p, --project <dir>` | project to watch (default: current directory) |
| `--port <n>` | port to serve on (default: 4517 — **walks to the next free one if it's taken**) |
| `--strict-port` | fail instead of walking to the next port |
| `--host <addr>` | address to bind (default: `127.0.0.1`; anything else prints a warning, because it hands your transcripts to the network) |
| `--open` / `--no-open` | open the browser, or don't (default: open) |
| `-v, --version` · `-h, --help` | the usual |

Node 18+. **Zero runtime dependencies** — the whole thing is five small modules and
one HTML file.

---

## How it works

Claude Code appends every event of a session to
`~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`, and every subagent to
`<sessionId>/subagents/**/agent-<id>.jsonl`. claude-sketch:

1. **tails those files** — no watcher libraries, no native modules;
2. **parses `tool_use` entries** (Read / Grep / Glob / Edit / Write / Bash / Task…),
   de-duplicating the streamed rewrites by `tool_use.id`;
3. **reads `message.model` and `message.usage`**, so models and tokens are
   *measured, not estimated*;
4. **reads the commands too** — `rm` inside a Bash call is how files actually get
   deleted, so deletions show up struck through with a ✕;
5. **streams it to the browser over SSE**, where a few hundred lines of vanilla JS
   draw the crayon.

No database. No build step. No framework. `git ls-files` supplies the file universe
so coverage has an honest denominator.

---

## It stays out of the way

Measured here against real transcripts — the largest was a **260 MB** session file:

| | |
|---|---|
| Idle CPU, browser attached | **0.08 %** of one core |
| Memory, typical session | ~55 MB |
| Memory, worst case (351 subagents, 10k events) | ~105 MB |
| Cold parse of that 260 MB transcript | **1.7 s** |
| Steady-state poll | 0.02 ms per tick |
| Browser: full re-render | ~26 ms, 3 MB heap |

Lines that can't contain a tool call, a usage block or a prompt are never
`JSON.parse`d. Files drain in 32 MB budgets with an immediate follow-up while
they're behind. Polling backs off from 600 ms to 2.5 s after a spell of quiet and
snaps back on the first byte.

**Effect on Claude Code: none, by construction.** The tool only ever reads — there
is no `writeFile`, `unlink` or `mkdir` anywhere in `lib/`. Transcripts are opened
`'r'` and read by offset, which doesn't block Claude Code's appends. The server
binds `127.0.0.1` unless you ask otherwise. Clicking a file asks before it opens anything, and
`POST /api/open` refuses paths outside your project, home or temp directories.

---

## Details worth knowing

- **`n tool calls · 0 files` is a real state, not a bug.** Shell commands and task
  spawns don't name a file, so a session that only ran commands maps nothing. The
  page says so instead of leaving you staring at a blank grid.
- **Task duration** is the longer of two partial clocks: spawn→result from the parent
  transcript, and the subagent's own first→last call. Some transcripts record those
  two moments 0.1 s apart, which would otherwise report eight minutes of work as "1s".
- **Per-file token numbers are estimates** from tool-result size; per-agent
  input/output totals are exact API usage.
- **Folder labels drop the prefix every path shares**, shown once above the map, so a
  monorepo doesn't repeat `packages/app/...` on every row.
- Grep/Glob are attributed to their `path` argument; WebFetch/WebSearch land
  under `(web)`.

---

## Configuration

**Prices.** Drop a file at `~/.claude-sketch.pricing.json`:

```json
{
  "cacheReadFactor": 0.1,
  "cacheWriteFactor": 1.25,
  "models": {
    "opus":   { "in": 15,  "out": 75 },
    "sonnet": { "in": 3,   "out": 15 },
    "haiku":  { "in": 0.8, "out": 4 },
    "fable":  null
  }
}
```

Rates are per million tokens. Families set to `null` are reported as *rate unset*
rather than guessed at — including Fable, whose list price isn't published here.

**Language.** English / 한국어 / 日本語 / 中文, picked from the row in the header.
Adding one is adding one object to `I18N` in `public/index.html`.

**Typeface.** The handwriting is **Excalifont** — the face Excalidraw draws with —
bundled locally so Latin text needs no network. It ships inside the MIT-licensed
`@excalidraw/excalidraw` package; the font's own licence file isn't published there,
so verify it before redistributing. Korean glyphs come from Google Fonts' *Gaegu*,
the only outbound request the page makes; delete the `<link>` to go fully offline.
Want a different hand? Change the `--hand` custom property. One line.

---

## Why it looks like this

Because a dashboard would have made it look like a status report, and this isn't one.
It's a page of scratch paper you keep open next to your editor while something else
does the typing — the kind of thing you glance at, not study. Crayon smudges,
wobbly boxes, handwriting that doesn't line up perfectly. If a treemap cell has room
for the numbers it prints them; if it doesn't, it stays quiet.

Also: watching a coding agent work is genuinely fun, and nothing about that fact
required a bar chart.

---

## License

MIT. Not an official Anthropic product — just a tool for people who like knowing
what their agent is up to.
