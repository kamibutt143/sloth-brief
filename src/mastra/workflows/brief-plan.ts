import { z } from "zod";
import type { NewsItem } from "../tools/fetch-feeds.js";

/**
 * The model never writes the brief directly. It returns a structured
 * PLAN — which item IDs go where, with a headline and summary for the
 * featured ones — and TypeScript renders the Markdown. A 4B model is a
 * decent editor and a terrible typesetter: it mutates long URLs, drops
 * bold markers, and repeats stories across sections. By construction,
 * none of that can happen here — links, labels and layout come from the
 * item data, and each ID can be consumed exactly once.
 */
export const briefPlanSchema = z.object({
  top: z
    .array(
      z.object({
        id: z.number(),
        headline: z.string(),
        summary: z.string(),
      }),
    )
    .max(3),
  themes: z.array(
    z.object({
      name: z.string(),
      items: z.array(
        z.object({
          id: z.number(),
          headline: z.string(),
          summary: z.string(),
        }),
      ),
    }),
  ),
  radar: z.array(z.number()),
});

export type BriefPlan = z.infer<typeof briefPlanSchema>;

/** Extract and validate a plan from raw model output (tolerant of fences/preamble). */
export function parseBriefPlan(raw: string): BriefPlan | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = briefPlanSchema.safeParse(JSON.parse(raw.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function contentWords(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 4),
  );
}

// Novelty/release claims a summary might make ("newly released", "was
// launched", "a new version") — believable only when the source item
// itself signals novelty. The classic failure: an archival item (a 2022
// firmware annotation) summarized as if it were today's product launch.
const CLAIM_PATTERNS = [
  /\bnewly\s+(released|launched|announced|published|unveiled|introduced)\b/,
  /\bjust\s+(released|launched|announced|published|dropped|unveiled)\b/,
  /\bbrand[- ]new\b/,
  /\bnew\s+(release|version|update|firmware)\b/,
  /\b(is|was|has been|have been)\s+(released|launched|announced|unveiled|published)\b/,
];
const SUPPORT_MARKERS = [
  "new", "launch", "releas", "announc", "unveil", "introduc",
  "debut", "latest", "roll", "ship", "first",
];

/**
 * Plan sanitation, two lightweight checks — deliberately simple enough
 * for the pipeline around a 4B model:
 *
 * 1. Coherence: a plan headline should be a paraphrase of its item's
 *    title — they share content words. Zero overlap almost always means
 *    the model paired one story's headline with another story's ID.
 * 2. Supported claims: a summary that claims novelty or a release is
 *    only kept when the item's own title/summary signals the same — and
 *    never when the title carries an earlier year (archival content).
 *
 * Failing entries are demoted to the radar, where the item's real title
 * is used — truthful by construction — and reported as problems so the
 * workflow can retry once for a properly featured version.
 */
export function sanitizePlan(
  plan: BriefPlan,
  items: NewsItem[],
): { plan: BriefPlan; problems: string[] } {
  const problems: string[] = [];
  const demoted: number[] = [];

  const coherent = (id: number, headline: string): boolean => {
    const item = items[id - 1];
    if (!item) return false;
    const titleWords = contentWords(item.title);
    if (titleWords.size < 3) return true; // too little signal to judge
    const headlineWords = contentWords(headline);
    for (const w of headlineWords) if (titleWords.has(w)) return true;
    return false;
  };

  const claimSupported = (entry: { headline: string; summary: string }, item: NewsItem): boolean => {
    const text = `${entry.headline} ${entry.summary}`.toLowerCase();
    if (!CLAIM_PATTERNS.some((p) => p.test(text))) return true; // no claim made
    const titleYears = [...item.title.matchAll(/\b(?:19|20)\d{2}\b/g)].map((m) =>
      Number(m[0]),
    );
    if (titleYears.length > 0 && Math.max(...titleYears) < new Date().getFullYear()) {
      return false; // archival item — a release claim is never supported
    }
    const itemText = `${item.title} ${item.summary}`.toLowerCase();
    return SUPPORT_MARKERS.some((marker) => itemText.includes(marker));
  };

  const check = <
    T extends { id: number; headline: string; summary: string },
  >(entries: T[]): T[] =>
    entries.filter((entry) => {
      const item = items[entry.id - 1];
      if (!item || !coherent(entry.id, entry.headline)) {
        problems.push(
          `headline for item ${entry.id} ("${entry.headline}") does not match that item's title ("${item?.title}")`,
        );
        demoted.push(entry.id);
        return false;
      }
      if (!claimSupported(entry, item)) {
        problems.push(
          `summary for item ${entry.id} ("${entry.summary}") claims a release/novelty its source item ("${item.title}") does not support`,
        );
        demoted.push(entry.id);
        return false;
      }
      return true;
    });

  return {
    plan: {
      top: check(plan.top),
      themes: plan.themes.map((theme) => ({ ...theme, items: check(theme.items) })),
      radar: [...plan.radar, ...demoted],
    },
    problems,
  };
}

/** Model-written text must not smuggle in its own links or markup. */
function cleanText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Render the plan to the brief's Markdown format. IDs are 1-based
 * indexes into `items`. Each item is used at most once (first claim
 * wins: top, then themes, then radar), and any item the plan forgot
 * entirely is swept into the radar — a briefing must not silently
 * lose stories.
 */
export function renderBrief(
  plan: BriefPlan,
  items: NewsItem[],
  dateLabel: string,
): string {
  const byId = new Map(items.map((item, i) => [i + 1, item]));
  const used = new Set<number>();
  const claim = (id: number): NewsItem | null => {
    const item = byId.get(id);
    if (!item || used.has(id)) return null;
    used.add(id);
    return item;
  };

  const lines: string[] = [`# Sloth Brief — ${dateLabel}`, ""];

  lines.push("## Top 3 — read these with your coffee");
  for (const entry of plan.top.slice(0, 3)) {
    const item = claim(entry.id);
    if (!item) continue;
    lines.push(
      `- **${cleanText(entry.headline)}** — ${cleanText(entry.summary)} [${item.source}](${item.link})`,
    );
  }
  lines.push("");

  lines.push("## By theme");
  for (const theme of plan.themes) {
    const themeLines: string[] = [];
    for (const entry of theme.items) {
      const item = claim(entry.id);
      if (!item) continue;
      themeLines.push(
        `- **${cleanText(entry.headline)}** — ${cleanText(entry.summary)} [${item.source}](${item.link})`,
      );
    }
    if (themeLines.length > 0) {
      lines.push(`### ${cleanText(theme.name)}`, ...themeLines);
    }
  }
  lines.push("");

  lines.push("## One-line radar");
  const radarIds = [...plan.radar];
  for (let id = 1; id <= items.length; id++) {
    if (!used.has(id) && !radarIds.includes(id)) radarIds.push(id);
  }
  for (const id of radarIds) {
    const item = claim(id);
    if (!item) continue;
    lines.push(`- [${item.title}](${item.link})`);
  }

  return lines.join("\n");
}
