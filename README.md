# 🦥 Sloth Brief

**A local-first AI news research agent that reads the feeds overnight, so you don't have to.**

Sloth Brief is a [Mastra](https://mastra.ai) agent powered by an open-weight
model (**Gemma**, served locally by [Ollama](https://ollama.com)). Point it at
your RSS feeds before bed; in the morning you get one tight Markdown briefing:
the top 3 stories with your coffee, everything else grouped by theme, and a
one-line radar for the rest. Three minutes, and you're caught up.

Built for the DEV Hacktoberfest 2026 Week 3 challenge — **"Slow and Steady"**:
software that rewards laziness, built on open-source AI.

## Why open matters

- **Zero API cost.** The whole pipeline runs on your machine. No keys, no
  per-token bills, no rate limits — the marginal cost of a brief is the
  electricity to run a 4B model for a minute.
- **Private by default.** Your reading list never leaves your laptop. No
  analytics company learns that you mainline AI news at 7am.
- **Swappable models.** Gemma today, whatever ships next month tomorrow.
  The model is a config value (`SLOTH_MODEL`), not a vendor relationship.
- **Forkable forever.** Mastra, Ollama, Gemma's weights, rss-parser — every
  layer is open. If any maintainer vanished tomorrow, this project would
  still run.

## How it works

```
RSS feeds ──▶ fetch-overnight step ──▶ Sloth Briefer agent ──▶ brief-YYYY-MM-DD.md
 (9 sources)   dedupe, window, cap        (Gemma via Ollama)     Top 3 / By theme / Radar
```

1. **Fetch** — `fetchOvernightItems()` pulls every feed in `src/config.ts`,
   keeps only items from the last 12 hours, dedupes by link, newest first.
   A dead feed is logged and skipped, never fatal.
2. **Brief** — the Mastra workflow `overnight-brief` hands the items to the
   **Sloth Briefer** agent, which clusters them by theme, merges duplicate
   coverage of the same story, and writes the brief. The agent also has the
   feed tool registered, so in Mastra Studio it can fetch on demand.
3. **Read** — the brief lands in `briefs/brief-YYYY-MM-DD.md`. That's it.
   No app, no dashboard, no notifications. It's a file. Read it with coffee.

A real, unedited output: [sample-brief.md](sample-brief.md).

## Quick start

Prerequisites: Node.js 20+, [Ollama](https://ollama.com/download).

```bash
# 1. Get an open-weight model running locally
ollama pull gemma3:4b
ollama serve            # if the Ollama app/service isn't already running

# 2. Clone and install
git clone https://github.com/kamibutt143/sloth-brief.git
cd sloth-brief
npm install

# 3. Make the brief
npm run brief
```

Your brief is in `briefs/`. Schedule it with cron if you want it truly
hands-off:

```cron
0 7 * * *  cd ~/sloth-brief && npm run brief   # fresh brief every morning at 7
```

## Configuration

All optional, via environment variables (`.env` supported):

| Variable | Default | What it does |
| --- | --- | --- |
| `SLOTH_MODEL` | `gemma3:4b` | Any model Ollama can pull (`gemma3:1b`, `llama3.2`, …) |
| `OLLAMA_BASE_URL` | `http://localhost:11434/v1` | Ollama's OpenAI-compatible endpoint |
| `SLOTH_WINDOW_HOURS` | `12` | How far back the overnight window reaches |
| `SLOTH_MAX_ITEMS` | `40` | Cap on items handed to the model |

Feeds live in `src/config.ts` — edit the `FEEDS` list to follow your own
sources. Defaults: Hacker News, TechCrunch, The Verge, Ars Technica,
Hugging Face, OpenAI, Simon Willison, Import AI, Lobsters.

## Project layout

```
src/
  config.ts                       feeds + model settings
  run.ts                          CLI entry (npm run brief)
  mastra/
    index.ts                      Mastra instance
    agents/briefer.ts             the Sloth Briefer agent (Gemma via Ollama)
    tools/fetch-feeds.ts          RSS fetch tool (also used step-wise)
    workflows/overnight-brief.ts  fetch → brief workflow
briefs/                           generated briefings land here
```

## Troubleshooting

- **Brief cuts off mid-way?** Ollama's default context window (4096 tokens)
  fills up with the feed items and leaves no room for the brief itself.
  Start the server with a larger context: `OLLAMA_CONTEXT_LENGTH=8192 ollama serve`.
- **Very slow generation?** That's CPU inference being CPU inference. The
  brief is generated overnight precisely so nobody has to watch it happen.
  Slower machine, smaller model: `SLOTH_MODEL=gemma3:1b npm run brief`.

## Notes on model choice

`gemma3:4b` is the sweet spot for a laptop: small enough to run anywhere,
strong enough to cluster and summarize 40 headlines faithfully. On a very
modest machine, `gemma3:1b` works too — the brief gets terser, the sloth
gets lazier. That is a feature.

## License

MIT — see [LICENSE](LICENSE).
