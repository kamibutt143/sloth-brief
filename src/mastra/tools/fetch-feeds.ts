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

function stripHtml(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetch every configured feed, keep only items published inside the
 * overnight window, dedupe by link, newest first, capped at MAX_ITEMS.
 * A feed that fails is logged and skipped — one dead feed never sinks the brief.
 */
export async function fetchOvernightItems(
  windowHours: number = WINDOW_HOURS,
): Promise<NewsItem[]> {
  const cutoff = Date.now() - windowHours * 60 * 60 * 1000;
  const seen = new Set<string>();
  const items: NewsItem[] = [];

  for (const feed of FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);
      for (const entry of parsed.items ?? []) {
        const link = entry.link ?? "";
        if (!link || seen.has(link)) continue;
        const published = entry.isoDate
          ? new Date(entry.isoDate).getTime()
          : Date.now();
        if (published < cutoff) continue;
        seen.add(link);
        items.push({
          title: stripHtml(entry.title ?? "(untitled)"),
          link,
          source: feed.name,
          published: new Date(published).toISOString(),
          summary: stripHtml(
            entry.contentSnippet ?? entry.content ?? entry.summary ?? "",
          ).slice(0, 400),
        });
      }
    } catch (err) {
      console.error(
        `[sloth] feed failed, skipping: ${feed.name} (${feed.url}) — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

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
