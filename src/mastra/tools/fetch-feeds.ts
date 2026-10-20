import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import Parser from "rss-parser";
import { FEEDS, WINDOW_HOURS, MAX_ITEMS } from "../../config.js";

export interface NewsItem {
  title: string;
  link: string;
  source: string;
  published: string;
  summary: string;
}

const parser = new Parser({ timeout: 15000 });

/** How many feeds to fetch at once — polite to publishers, fast enough. */
const FEED_CONCURRENCY = 4;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode HTML entities (&amp; → &) instead of blanking them out. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Strip tags, decode entities, collapse whitespace. */
export function stripHtml(text: string): string {
  return decodeHtmlEntities(text.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Canonical form of a URL for deduplication: lowercase host, no fragment,
 * no tracking parameters, no trailing slash. The item keeps its original
 * link for display; only the dedupe key is normalized.
 */
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_|ref$|source$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return raw.trim();
  }
}

interface RawEntry {
  isoDate?: string;
  pubDate?: string;
  date?: string;
}

/**
 * Publication time of a feed entry, or null when it cannot be established.
 * An undated or badly-dated item must NOT be treated as fresh — guessing
 * "now" would surface months-old posts as overnight news.
 */
export function parseEntryDate(entry: RawEntry): number | null {
  for (const raw of [entry.isoDate, entry.pubDate, entry.date]) {
    if (!raw) continue;
    const ts = new Date(raw).getTime();
    if (Number.isFinite(ts)) return ts;
  }
  return null;
}

/**
 * Clean a feed summary for the prompt. Bare URLs are removed on purpose:
 * some feeds (e.g. hnrss) embed extra URLs in the body — comment-page
 * links, references — and a small model will happily cite those instead
 * of the item's own link. The one true link travels in its own field.
 */
export function cleanSummary(raw: string): string {
  return stripHtml(raw)
    .replace(/(Article|Comments) URL:\s*/gi, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\bPoints:\s*\d+\s*#?\s*Comments:\s*\d+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

async function fetchFeed(feed: (typeof FEEDS)[number], cutoff: number) {
  const parsed = await parser.parseURL(feed.url);
  const items: NewsItem[] = [];
  let undated = 0;
  for (const entry of parsed.items ?? []) {
    const link = entry.link ?? "";
    if (!link) continue;
    const published = parseEntryDate(entry);
    if (published === null) {
      undated++;
      continue;
    }
    if (published < cutoff) continue;
    items.push({
      title: stripHtml(entry.title ?? "(untitled)"),
      link,
      source: feed.name,
      published: new Date(published).toISOString(),
      summary: cleanSummary(
        entry.contentSnippet ?? entry.content ?? entry.summary ?? "",
      ),
    });
  }
  if (undated > 0) {
    console.error(
      `[sloth] ${feed.name}: skipped ${undated} item(s) with no usable date`,
    );
  }
  return items;
}

/**
 * Fetch every configured feed concurrently, keep only items published
 * inside the overnight window, dedupe by normalized link (the copy with
 * the richer summary wins), newest first, capped at MAX_ITEMS.
 * A feed that fails is logged and skipped — one dead feed never sinks the brief.
 */
export async function fetchOvernightItems(
  windowHours: number = WINDOW_HOURS,
): Promise<NewsItem[]> {
  const cutoff = Date.now() - windowHours * 60 * 60 * 1000;

  const perFeed: NewsItem[][] = [];
  for (let i = 0; i < FEEDS.length; i += FEED_CONCURRENCY) {
    const batch = FEEDS.slice(i, i + FEED_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((feed) => fetchFeed(feed, cutoff)),
    );
    for (const [j, result] of results.entries()) {
      if (result.status === "fulfilled") {
        perFeed.push(result.value);
      } else {
        const feed = batch[j];
        console.error(
          `[sloth] feed failed, skipping: ${feed.name} (${feed.url}) — ${
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
          }`,
        );
      }
    }
  }

  const byLink = new Map<string, NewsItem>();
  for (const item of perFeed.flat()) {
    const key = normalizeUrl(item.link);
    const existing = byLink.get(key);
    if (!existing || item.summary.length > existing.summary.length) {
      byLink.set(key, item);
    }
  }

  const items = [...byLink.values()];
  items.sort((a, b) => b.published.localeCompare(a.published));
  return items.slice(0, MAX_ITEMS);
}

export const fetchFeedsTool = createTool({
  id: "fetch-overnight-feeds",
  description:
    "Fetch the configured AI/tech RSS feeds and return the items published in the last N hours (the overnight window), deduped and newest-first.",
  inputSchema: z.object({
    windowHours: z
      .number()
      .optional()
      .describe("How many hours back to look. Defaults to the configured window."),
  }),
  outputSchema: z.object({
    items: z.array(
      z.object({
        title: z.string(),
        link: z.string(),
        source: z.string(),
        published: z.string(),
        summary: z.string(),
      }),
    ),
  }),
  execute: async ({ windowHours }) => {
    const items = await fetchOvernightItems(windowHours);
    return { items };
  },
});
