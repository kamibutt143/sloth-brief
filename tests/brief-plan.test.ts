import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBriefPlan,
  renderBrief,
  sanitizePlan,
  type BriefPlan,
} from "../src/mastra/workflows/brief-plan.js";
import { validateBrief } from "../src/mastra/workflows/validate-brief.js";
import type { NewsItem } from "../src/mastra/tools/fetch-feeds.js";

const items: NewsItem[] = [
  { title: "Alpha story", link: "https://a.example/alpha", source: "FeedA", published: "2026-10-20T05:00:00.000Z", summary: "Alpha." },
  { title: "Beta story", link: "https://b.example/beta", source: "FeedB", published: "2026-10-20T04:00:00.000Z", summary: "Beta." },
  { title: "Gamma story", link: "https://c.example/gamma", source: "FeedC", published: "2026-10-20T03:00:00.000Z", summary: "Gamma." },
];

test("parseBriefPlan: plain, fenced, and garbage output", () => {
  const plan = { top: [{ id: 1, headline: "H", summary: "S" }], themes: [], radar: [2] };
  assert.deepEqual(parseBriefPlan(JSON.stringify(plan)), plan);
  assert.deepEqual(parseBriefPlan("```json\n" + JSON.stringify(plan) + "\n```"), plan);
  assert.equal(parseBriefPlan("no json here"), null);
  assert.equal(
    parseBriefPlan(JSON.stringify({ top: [1, 2, 3, 4].map((id) => ({ id, headline: "H", summary: "S" })), themes: [], radar: [] })),
    null,
    "top with 4 entries violates the schema",
  );
});

test("renderBrief: real links, partition enforced, leftovers swept to radar", () => {
  const plan: BriefPlan = {
    top: [{ id: 1, headline: "Alpha!", summary: "Alpha happened." }],
    themes: [
      { name: "Agents & Tooling", items: [{ id: 2, headline: "Beta!", summary: "Beta." }] },
    ],
    radar: [1], // duplicate of a top item on purpose — must be consumed once
    // item 3 is never mentioned — must be swept into the radar
  };
  const brief = renderBrief(plan, items, "Tuesday 20 October 2026");
  assert.ok(brief.includes("[FeedA](https://a.example/alpha)"));
  assert.ok(brief.includes("[FeedB](https://b.example/beta)"));
  assert.ok(brief.includes("[Gamma story](https://c.example/gamma)"));
  assert.equal(brief.match(/a\.example\/alpha/g)?.length, 1, "alpha link appears exactly once");
  assert.equal(validateBrief(brief, items).ok, true);
});

test("sanitizePlan demotes a headline paired with the wrong item", () => {
  const longItems: NewsItem[] = [
    { title: "Alpha outage takes down banking apps", link: "https://a.example/alpha", source: "FeedA", published: "2026-10-20T05:00:00.000Z", summary: "Alpha." },
    { title: "Beta browser launches with privacy focus", link: "https://b.example/beta", source: "FeedB", published: "2026-10-20T04:00:00.000Z", summary: "Beta." },
    { title: "Gamma rockets expand into European markets", link: "https://c.example/gamma", source: "FeedC", published: "2026-10-20T03:00:00.000Z", summary: "Gamma." },
  ];
  const plan: BriefPlan = {
    top: [
      { id: 1, headline: "Alpha outage takes down banking apps", summary: "Alpha." },
      // Headline is about the Beta browser, but the ID points at Gamma.
      { id: 3, headline: "Beta browser launches with privacy focus", summary: "Beta." },
    ],
    themes: [],
    radar: [],
  };
  const { plan: clean, problems } = sanitizePlan(plan, longItems);
  assert.equal(problems.length, 1);
  assert.equal(clean.top.length, 1);
  assert.ok(clean.radar.includes(3), "mismatched item demoted to radar");
  const brief = renderBrief(clean, longItems, "Tuesday 20 October 2026");
  assert.ok(brief.includes("[Gamma rockets expand into European markets](https://c.example/gamma)"));
  // The mismatched headline must not appear in the featured sections
  // (item 2's real title legitimately shows up in the radar sweep).
  assert.equal(brief.split("## One-line radar")[0].includes("Beta browser"), false);
});

test("sanitizePlan demotes an unsupported novelty claim (archival item)", () => {
  const archival: NewsItem[] = [
    { title: "The Annotated VT100 Firmware (2022)", link: "https://v.example/vt100", source: "FeedA", published: "2026-10-20T05:00:00.000Z", summary: "A walkthrough of the annotated firmware ROM dumps." },
    { title: "Beta browser launches with privacy focus", link: "https://b.example/beta", source: "FeedB", published: "2026-10-20T04:00:00.000Z", summary: "The browser launches today with a new privacy dashboard." },
  ];
  const plan: BriefPlan = {
    top: [
      // The VT100 failure mode: archival content framed as a fresh release.
      { id: 1, headline: "The Annotated VT100 Firmware (2022)", summary: "A firmware update for VT100 terminals was released." },
      // A release claim the item itself supports — must be kept.
      { id: 2, headline: "Beta browser launches with privacy focus", summary: "The browser was launched today with a new privacy dashboard." },
    ],
    themes: [],
    radar: [],
  };
  const { plan: clean, problems } = sanitizePlan(plan, archival);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes("item 1"));
  assert.equal(clean.top.length, 1);
  assert.equal(clean.top[0].id, 2);
  assert.ok(clean.radar.includes(1), "archival item demoted to radar with its true title");
});

test("renderBrief: model text cannot smuggle links", () => {
  const plan: BriefPlan = {
    top: [{ id: 1, headline: "See https://evil.example/x now", summary: "Visit [this](https://evil.example/y)!" }],
    themes: [],
    radar: [],
  };
  const brief = renderBrief(plan, items, "Tuesday 20 October 2026");
  assert.equal(brief.includes("evil.example"), false);
});
