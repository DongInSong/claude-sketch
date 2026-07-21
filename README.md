# ✳ claude-sketch

**English** · [한국어](README.ko.md) · [日本語](README.ja.md) · [中文](README.zh.md)

> 🕵️ Claude just read `fusion.py` for the sixth time — and took a stroll through `vendor/`.
> You had no idea. Now you do.

A crayon sketch of what **Claude Code** is touching in your repo, live. 🖍️

```bash
npx claude-sketch
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshot-dark.png">
  <img src="docs/screenshot.png" alt="claude-sketch: footprints, attention share and file heat">
</picture>

## 👀 What you get

- 👣 **footprints** — every file in the repo; filled = stepped on, dashed = walked past, `⋯16⋯` = never went near. Coverage counted against `git ls-files`.
- 🎯 **attention share** — treemap where **area = tool calls**. One file eating a third of the frame *is* the warning.
- 🔥 **file heat** — 5m / 1h / whole session. Read-read-edit-run… or read-read-read-read. 😬
- 🧠 **agents** — `main ─task▶ subagents`, each with model, brief, status, duration. Click one to filter everything to it.
- 📝 **margin notes** — "read 6×, probably already in context", "poking `vendor/` 9×", "edit → run loop 👍".
- ✂️ **deletions & diffs** — `rm` inside a Bash call shows up struck through; edits carry `+12 −3`.

## 💸 The number nobody expects

```
fresh in 485 · cache 8.4M (100% reused) · out 10.6k · ≈$0.03 at API rates
```

Claude replays your whole context from cache every turn. "8.4M input tokens" 😱 is
meaningless — the number that costs you is **485**. Rates live in
`~/.claude-sketch.pricing.json`; on a subscription you're not billed per token at
all, so read it as *size of work*, not a bill. Failed calls get counted too — pure waste. ❌

## 🎛️ Options

| | |
|---|---|
| `-p, --project <dir>` | what to watch (default: cwd) |
| `--port <n>` | default 4517 — **hops to the next free port if busy** |
| `--strict-port` | fail instead of hopping |
| `--host <addr>` | default `127.0.0.1` (anything else warns loudly ⚠️) |
| `--open` / `--no-open` | browser or no browser |
| `-v, --version` · `-h, --help` | 🙂 |

## ⚙️ How it works

Claude Code already writes every event to `~/.claude/projects/<slug>/<session>.jsonl`
(subagents in `<session>/subagents/**`). claude-sketch tails those files, pulls out
`tool_use` + `message.model` + `message.usage`, and streams it to the browser over SSE.

**Measured, not guessed.** No DB, no build step, no framework, **zero dependencies**. 📦

## ⚡ Performance

| | |
|---|---|
| idle CPU | **0.08 %** of a core |
| memory | ~55 MB (worst seen: 105 MB) |
| 260 MB transcript, cold parse | **1.7 s** |
| full browser re-render | ~26 ms |

## 🔒 Privacy

Read-only by construction — no `writeFile`/`unlink`/`mkdir` anywhere in `lib/`. Binds
`127.0.0.1`. Clicking a file **asks first**. The only outbound request is the Korean
webfont; delete one `<link>` for full offline. 🏠

## 🎨 Details

- **Language**: 🇬🇧 🇰🇷 🇯🇵 🇨🇳 — one row in the header, one object in `I18N` to add more.
- **Font**: Excalifont (Excalidraw's hand) — **SIL Open Font License 1.1**, notice at
  [`public/fonts/LICENSE-Excalifont.txt`](public/fonts/LICENSE-Excalifont.txt).
  Swap it via the `--hand` CSS variable.
- **`n calls · 0 files`** is real, not a bug — shell commands don't point at files.
- Task duration = the longer of *spawn→result* and *the agent's own first→last call*
  (some transcripts write those 0.1 s apart 🙃).

## 📄 License

MIT. Not an official Anthropic product — just a tool for people who like knowing what
their agent is up to. ✳
