/**
 * Sloth Brief configuration.
 *
 * Everything runs locally: feeds are fetched directly, and the model is a
 * local open-weight model served by Ollama. No API keys, no cloud calls.
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

/** Ollama's OpenAI-compatible endpoint. */
export const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";

/** Open-weight model served by Ollama. Any model you can `ollama pull` works. */
export const MODEL = process.env.SLOTH_MODEL ?? "gemma3:4b";

/** How far back the overnight window reaches, in hours. */
export const WINDOW_HOURS = Number(process.env.SLOTH_WINDOW_HOURS ?? 12);

/** Cap on items handed to the model, newest first. Keeps small models happy. */
export const MAX_ITEMS = Number(process.env.SLOTH_MAX_ITEMS ?? 40);
