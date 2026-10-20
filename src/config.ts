/**
 * Sloth Brief configuration.
 *
 * Everything runs locally: feeds are fetched directly, and the model is a
 * local open-weight model served by Ollama. No API keys, no cloud calls.
 *
 * Numeric settings are validated at startup: a typo in an env var fails
 * fast with a clear message instead of silently producing an empty brief.
 */

export interface FeedSource {
  name: string;
  url: string;
}

/** Default AI / tech news feeds. Add your own — broken feeds are skipped. */
export const FEEDS: FeedSource[] = [
  { name: "Hacker News", url: "https://hnrss.org/frontpage" },
  { name: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { name: "The Verge", url: "https://www.theverge.com/rss/index.xml" },
  { name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index" },
  { name: "Hugging Face Blog", url: "https://huggingface.co/blog/feed.xml" },
  { name: "OpenAI Blog", url: "https://openai.com/blog/rss.xml" },
  { name: "Simon Willison", url: "https://simonwillison.net/atom/everything/" },
  { name: "Import AI", url: "https://jack-clark.net/feed/" },
  { name: "Lobsters", url: "https://lobste.rs/rss" },
];

/**
 * Parse an integer setting, requiring a finite value inside [min, max].
 * Throws a descriptive error — configuration mistakes should be loud.
 */
export function parseBoundedInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(
      `Invalid ${name}: "${raw}" is not a whole number. Expected an integer between ${min} and ${max}.`,
    );
  }
  if (value < min || value > max) {
    throw new Error(
      `Invalid ${name}: ${value} is out of range. Expected an integer between ${min} and ${max}.`,
    );
  }
  return value;
}

/** Ollama's OpenAI-compatible endpoint. */
export const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";

/**
 * Open-weight model served by Ollama.
 * The workflow runs tool-less, so any Ollama chat model works there.
 * Interactive use in Mastra Studio (the feed-fetch tool) additionally
 * requires a model that supports tool calling.
 */
export const MODEL = process.env.SLOTH_MODEL ?? "gemma3:4b";

/** How far back the overnight window reaches, in hours (1–168). */
export const WINDOW_HOURS = parseBoundedInt(
  "SLOTH_WINDOW_HOURS",
  process.env.SLOTH_WINDOW_HOURS,
  12,
  1,
  168,
);

/** Cap on items handed to the model, newest first (1–100). Keeps small models happy. */
export const MAX_ITEMS = parseBoundedInt(
  "SLOTH_MAX_ITEMS",
  process.env.SLOTH_MAX_ITEMS,
  40,
  1,
  100,
);

/**
 * Total context window (tokens) to budget against. The workflow trims the
 * item list so prompt + brief fit inside it. Match this to your Ollama
 * server (start it with OLLAMA_CONTEXT_LENGTH=<this>); Ollama's own
 * default is only 4096, which truncates briefs.
 */
export const CONTEXT_LENGTH = parseBoundedInt(
  "SLOTH_CONTEXT_LENGTH",
  process.env.SLOTH_CONTEXT_LENGTH,
  8192,
  2048,
  65536,
);

/** Tokens reserved for the generated brief itself. */
export const OUTPUT_TOKENS = 3000;
