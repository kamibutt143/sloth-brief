import { normalizeUrl, type NewsItem } from "../tools/fetch-feeds.js";

export interface BriefValidation {
  ok: boolean;
  problems: string[];
}

const REQUIRED_HEADINGS = [
  "# Sloth Brief",
  "## Top 3",
  "## By theme",
  "## One-line radar",
];

/** URLs as they appear in Markdown links or bare in the text. */
function extractUrls(text: string): string[] {
  const urls: string[] = [];
  const pattern = /\((https?:\/\/[^)\s]+)\)|\bhttps?:\/\/[^\s)\]]+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    urls.push(match[1] ?? match[0]);
  }
  return urls;
}

/** Markdown links as [label](url) pairs. */
function extractLinks(text: string): { label: string; url: string }[] {
  const links: { label: string; url: string }[] = [];
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    links.push({ label: match[1], url: match[2] });
  }
  return links;
}

/** The text of one "## " section, from its heading to the next heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const rest = text.slice(start + heading.length);
  const next = rest.indexOf("\n## ");
  return next < 0 ? rest : rest.slice(0, next);
}

/** Remove stray angle brackets a model copies from placeholders: "<Name>" → "Name". */
function cleanLabel(label: string): string {
  return label.trim().replace(/^</, "").replace(/>$/, "").trim();
}

/** Classic Levenshtein edit distance (URLs are short; this stays cheap). */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = cur;
    }
  }
  return row[b.length];
}

/**
 * Find the item link a mutated URL most likely belongs to: same origin
 * and ≥80% edit similarity. Small models drop or "fix" a path segment in
 * long URLs (one real slug contained a typo the model helpfully removed,
 * breaking the link). A near-exact match on the same host is unambiguous;
 * anything weaker is left for the validator to reject.
 */
export function closestItemLink(url: string, items: NewsItem[]): string | null {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  const target = normalizeUrl(url);
  let best: string | null = null;
  let bestScore = 0;
  for (const item of items) {
    const candidate = normalizeUrl(item.link);
    try {
      if (new URL(candidate).origin !== origin) continue;
    } catch {
      continue;
    }
    const score =
      1 - editDistance(candidate, target) / Math.max(candidate.length, target.length);
    if (score > bestScore) {
      bestScore = score;
      best = item.link;
    }
  }
  return bestScore >= 0.8 ? best : null;
}

/**
 * Fail-closed gate: throw unless the brief passes every structural
 * check. The workflow calls this before returning, so an invalid brief
 * can never be saved — the run fails loudly instead.
 */
export function assertBriefValid(text: string, items: NewsItem[]): void {
  const validation = validateBrief(text, items);
  if (!validation.ok) {
    throw new Error(
      `Brief failed validation and was not saved: ${validation.problems.join("; ")}`,
    );
  }
}

/**
 * Deterministic repairs for the most common small-model slips:
 * repeating a story in a second section, naming the wrong source next
 * to a link, wrapping labels/links in stray angle brackets, and
 * forgetting the bold headline. All mechanical — the first occurrence
 * of a link wins, a source-name label that doesn't own its link is
 * rewritten to the true owner, and formatting is normalized. Meaning
 * is never touched.
 */
export function repairBrief(text: string, items: NewsItem[]): string {
  const ownerByUrl = new Map<string, string>();
  const sourceNames = new Set<string>();
  for (const item of items) {
    ownerByUrl.set(item.link, item.source);
    ownerByUrl.set(normalizeUrl(item.link), item.source);
    sourceNames.add(item.source.toLowerCase());
  }

  // Normalize link syntax first: [<Label>](<url>) and [<Label](url)
  // both become [Label](url).
  const normalized = text
    .replace(/\[<([^\]>]+)>\]\(<(https?:\/\/[^)\s]+)>\)/g, "[$1]($2)")
    .replace(/\[<([^\]]+)\]\(/g, "[$1](")
    .replace(/\]\(\s*<(https?:\/\/[^)\s>]+)>\s*\)/g, "]($1)");

  const seenLinks = new Set<string>();
  const out: string[] = [];
  let currentSection = "";
  for (const line of normalized.split("\n")) {
    if (line.startsWith("## ")) currentSection = line;
    const inAttributed =
      currentSection.startsWith("## Top 3") ||
      currentSection.startsWith("## By theme");

    const lineLinks = extractLinks(line);
    let drop = false;
    let fixed = line;
    for (const { label, url } of lineLinks) {
      // A URL the model mutated (dropped/altered a path segment) is
      // snapped back to the real item link when the match is near-exact.
      let effectiveUrl = url;
      if (!ownerByUrl.has(url) && !ownerByUrl.has(normalizeUrl(url))) {
        const snapped = closestItemLink(url, items);
        if (snapped) {
          fixed = fixed.replace(`(${url})`, `(${snapped})`);
          effectiveUrl = snapped;
        }
      }
      const key = normalizeUrl(effectiveUrl);
      if (seenLinks.has(key)) drop = true;
      seenLinks.add(key);
      const owner = ownerByUrl.get(effectiveUrl) ?? ownerByUrl.get(key);
      if (
        owner &&
        sourceNames.has(cleanLabel(label).toLowerCase()) &&
        cleanLabel(label).toLowerCase() !== owner.toLowerCase()
      ) {
        fixed = fixed.replace(
          `[${label}](${effectiveUrl})`,
          `[${owner}](${effectiveUrl})`,
        );
      }
    }
    if (drop) continue;

    // Bold the headline of Top 3 / By theme bullets when the model
    // forgot: "- Headline — summary" → "- **Headline** — summary".
    if (
      inAttributed &&
      fixed.trimStart().startsWith("- ") &&
      !fixed.includes("**") &&
      fixed.includes(" — ")
    ) {
      fixed = fixed.replace(/^(\s*- )(.+?)( — )/, "$1**$2**$3");
    }
    out.push(fixed);
  }
  return out.join("\n");
}

/**
 * Deterministic checks on the generated brief before it is trusted.
 * A small local model can omit a section, repeat a story across sections,
 * or invent a link — all cheap to catch here, embarrassing to ship.
 * Every URL in the brief must come from the supplied items; that check
 * doubles as the last line of defense against prompt injection via feeds.
 */
export function validateBrief(text: string, items: NewsItem[]): BriefValidation {
  const problems: string[] = [];

  if (!text || text.trim().length < 100) {
    problems.push("brief is empty or suspiciously short");
    return { ok: false, problems };
  }

  for (const heading of REQUIRED_HEADINGS) {
    if (!text.includes(heading)) {
      problems.push(`missing required section heading "${heading}"`);
    }
  }

  const allowed = new Set<string>();
  for (const item of items) {
    allowed.add(item.link);
    allowed.add(normalizeUrl(item.link));
  }

  const urls = extractUrls(text);
  const seenOnce = new Set<string>();
  for (const url of urls) {
    if (!allowed.has(url) && !allowed.has(normalizeUrl(url))) {
      problems.push(`link not present in the source items: ${url}`);
    }
    const key = normalizeUrl(url);
    if (seenOnce.has(key)) {
      problems.push(`link used more than once (item repeated across sections?): ${url}`);
    }
    seenOnce.add(key);
  }

  const topSection = section(text, "## Top 3");
  const topLines = topSection
    .split("\n")
    .filter((line) => line.trimStart().startsWith("- "));
  if (topLines.length === 0) {
    problems.push("Top 3 section contains no items");
  } else if (topLines.length > 3) {
    problems.push(`Top 3 section contains ${topLines.length} items (max 3)`);
  }
  for (const line of topLines) {
    if (!line.includes("**")) {
      problems.push(`Top 3 item is missing its bold headline: ${line.trim().slice(0, 60)}`);
    }
  }

  // Attribution consistency: in Top 3 and By theme, links are labelled
  // with the source name — [TechCrunch](url). A small model sometimes
  // pairs one story's text with another story's link; when the label is a
  // source name that doesn't own the link, the pairing is wrong.
  const ownerByUrl = new Map<string, string>();
  for (const item of items) {
    ownerByUrl.set(item.link, item.source);
    ownerByUrl.set(normalizeUrl(item.link), item.source);
  }
  const attributed = section(text, "## Top 3") + section(text, "## By theme");
  for (const { label, url } of extractLinks(attributed)) {
    const owner = ownerByUrl.get(url) ?? ownerByUrl.get(normalizeUrl(url));
    if (owner && cleanLabel(label).toLowerCase() !== owner.toLowerCase()) {
      problems.push(
        `source label "${label}" does not match the item that owns the link (expected "${owner}"): ${url}`,
      );
    }
  }

  // Theme headings must be single themes, not the example list copied whole.
  for (const line of text.split("\n")) {
    if (line.startsWith("### ") && line.includes(" / ")) {
      problems.push(`theme heading merges several themes into one: ${line.trim()}`);
    }
  }

  return { ok: problems.length === 0, problems };
}
