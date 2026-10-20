import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBoundedInt } from "../src/config.js";
import {
  normalizeUrl,
  stripHtml,
  parseEntryDate,
  cleanSummary,
} from "../src/mastra/tools/fetch-feeds.js";
import {
  validateBrief,
  repairBrief,
  assertBriefValid,
} from "../src/mastra/workflows/validate-brief.js";
import type { NewsItem } from "../src/mastra/tools/fetch-feeds.js";

// ---------- config parsing ----------

test("parseBoundedInt: fallback, valid values, and loud failures", () => {
  assert.equal(parseBoundedInt("X", undefined, 12, 1, 168), 12);
  assert.equal(parseBoundedInt("X", "", 12, 1, 168), 12);
  assert.equal(parseBoundedInt("X", "24", 12, 1, 168), 24);
  assert.throws(() => parseBoundedInt("X", "abc", 12, 1, 168), /not a whole number/);
  assert.throws(() => parseBoundedInt("X", "1.5", 12, 1, 168), /not a whole number/);
  assert.throws(() => parseBoundedInt("X", "0", 12, 1, 168), /out of range/);
  assert.throws(() => parseBoundedInt("X", "999", 12, 1, 168), /out of range/);
});

// ---------- URL normalization ----------

test("normalizeUrl strips tracking, fragments, trailing slash", () => {
  assert.equal(
    normalizeUrl("https://EXAMPLE.com/story/?utm_source=rss&id=7#top"),
    "https://example.com/story?id=7",
  );
  assert.equal(
    normalizeUrl("https://example.com/story"),
    normalizeUrl("https://example.com/story/"),
  );
  assert.equal(normalizeUrl("not a url"), "not a url");
});

// ---------- HTML cleanup ----------

test("stripHtml removes tags and decodes entities", () => {
  assert.equal(stripHtml("<p>AT&amp;T <b>news</b></p>"), "AT&T news");
  assert.equal(stripHtml("Tom &#8217;s &quot;take&quot;"), "Tom ’s \"take\"");
});

test("cleanSummary strips bare URLs so only the item link can be cited", () => {
  const raw =
    "Big news today. Article URL: https://example.com/a Comments URL: https://news.ycombinator.com/item?id=123 Points: 42";
  const cleaned = cleanSummary(raw);
  assert.equal(cleaned.includes("http"), false);
  assert.ok(cleaned.startsWith("Big news today."));
});

// ---------- feed dates ----------

test("parseEntryDate: valid, fallback, and unusable dates", () => {
  const ts = parseEntryDate({ isoDate: "2026-10-20T05:00:00.000Z" });
  assert.equal(ts, Date.parse("2026-10-20T05:00:00.000Z"));
  // Invalid isoDate falls through to a valid pubDate.
  assert.equal(
    parseEntryDate({ isoDate: "not-a-date", pubDate: "Tue, 20 Oct 2026 05:00:00 GMT" }),
    Date.parse("2026-10-20T05:00:00.000Z"),
  );
  // Nothing usable -> null (item gets skipped, never treated as fresh).
  assert.equal(parseEntryDate({ isoDate: "garbage" }), null);
  assert.equal(parseEntryDate({}), null);
});

// ---------- brief validation ----------

const items: NewsItem[] = [
  {
    title: "Alpha",
    link: "https://a.example/alpha",
    source: "FeedA",
    published: "2026-10-20T05:00:00.000Z",
    summary: "Alpha summary.",
  },
  {
    title: "Beta",
    link: "https://b.example/beta",
    source: "FeedB",
    published: "2026-10-20T04:00:00.000Z",
    summary: "Beta summary.",
  },
];

const goodBrief = `# Sloth Brief — Tuesday 20 October 2026

## Top 3 — read these with your coffee
- **Alpha** — Alpha happened and it matters for several reasons. [FeedA](https://a.example/alpha)

## By theme
### Agents & Tooling
- **Beta** — Beta is a tooling story. [FeedB](https://b.example/beta)

## One-line radar
- Nothing else tonight.
`;

test("validateBrief accepts a well-formed brief", () => {
  const result = validateBrief(goodBrief, items);
  assert.equal(result.ok, true, result.problems.join("; "));
});

test("validateBrief rejects invented links", () => {
  const bad = goodBrief.replace("https://b.example/beta", "https://evil.example/x");
  const result = validateBrief(bad, items);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /not present in the source items/);
});

test("validateBrief rejects a story repeated across sections", () => {
  const bad = goodBrief.replace(
    "- Nothing else tonight.",
    "- [Alpha](https://a.example/alpha)",
  );
  const result = validateBrief(bad, items);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /more than once/);
});

test("validateBrief rejects a source label that doesn't own the link", () => {
  // Story text from Alpha paired with Beta's link and Alpha's name:
  // the classic small-model mix-up.
  const bad = goodBrief.replace("[FeedB](https://b.example/beta)", "[FeedA](https://b.example/beta)");
  const result = validateBrief(bad, items);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /does not match/);
});

test("repairBrief drops repeated stories and fixes wrong source labels", () => {
  const duplicated = goodBrief.replace(
    "- Nothing else tonight.",
    "- **Alpha again** — repeated. [FeedA](https://a.example/alpha)",
  );
  const repaired = repairBrief(duplicated, items);
  assert.equal(repaired.includes("Alpha again"), false);
  assert.equal(validateBrief(repaired, items).ok, true);

  const mislabeled = goodBrief.replace(
    "[FeedB](https://b.example/beta)",
    "[FeedA](https://b.example/beta)",
  );
  const fixed = repairBrief(mislabeled, items);
  assert.ok(fixed.includes("[FeedB](https://b.example/beta)"));
});

test("repairBrief normalizes angle-bracket links and bolds bare headlines", () => {
  const sloppy = goodBrief
    .replace("[FeedA](https://a.example/alpha)", "[<FeedA>](<https://a.example/alpha>)")
    .replace("- **Alpha** —", "- Alpha —");
  const fixed = repairBrief(sloppy, items);
  assert.ok(fixed.includes("[FeedA](https://a.example/alpha)"));
  assert.ok(fixed.includes("- **Alpha** —"));
  assert.equal(validateBrief(fixed, items).ok, true);
});

test("repairBrief snaps a mutated URL back to the real item link", () => {
  const realLink =
    "https://news.example/google-cloud-outage-takes-down-hsbc-revolut-bank-of-scotland-llyods-equifax-more/";
  const typoItems: NewsItem[] = [
    {
      title: "Outage",
      link: realLink,
      source: "FeedA",
      published: "2026-10-20T05:00:00.000Z",
      summary: "An outage.",
    },
    ...items.slice(1),
  ];
  const brief = `# Sloth Brief — Tuesday 20 October 2026

## Top 3 — read these with your coffee
- **Outage** — Banks were hit by an outage and it matters. [FeedA](https://news.example/google-cloud-outage-takes-down-hsbc-revolut-bank-of-scotland-equifax-more/)

## By theme
### Agents & Tooling
- **Beta** — Beta is a tooling story. [FeedB](https://b.example/beta)

## One-line radar
- Nothing else tonight.
`;
  const fixed = repairBrief(brief, typoItems);
  assert.ok(fixed.includes(realLink));
  assert.equal(validateBrief(fixed, typoItems).ok, true);

  // A genuinely different story on the same host must NOT be snapped.
  const alien = brief.replace(
    "google-cloud-outage-takes-down-hsbc-revolut-bank-of-scotland-equifax-more",
    "totally-different-story-about-cooking-recipes-and-gardening",
  );
  const unfixed = repairBrief(alien, typoItems);
  assert.equal(validateBrief(unfixed, typoItems).ok, false);
});

test("assertBriefValid fails closed on an invalid brief", () => {
  assert.equal(validateBrief(goodBrief, items).ok, true);
  assert.doesNotThrow(() => assertBriefValid(goodBrief, items));
  const bad = goodBrief.replace("https://a.example/alpha", "https://evil.example/fake");
  assert.throws(() => assertBriefValid(bad, items), /not saved/);
});

test("validateBrief rejects missing sections and an over-full Top 3", () => {
  const noRadar = goodBrief.replace("## One-line radar", "## Leftovers");
  assert.equal(validateBrief(noRadar, items).ok, false);

  const fourTop = goodBrief.replace(
    "- **Alpha**",
    "- **One** — x. [FeedA](https://a.example/alpha)\n- **Two** — x. [FeedA](https://a.example/alpha)\n- **Three** — x. [FeedA](https://a.example/alpha)\n- **Alpha**",
  );
  const result = validateBrief(fourTop, items);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /Top 3 section contains 4 items/);
});
