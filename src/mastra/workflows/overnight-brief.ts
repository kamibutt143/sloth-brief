import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { fetchOvernightItems, type NewsItem } from "../tools/fetch-feeds.js";
import { workflowBrieferAgent } from "../agents/briefer.js";
import { validateBrief, repairBrief, assertBriefValid } from "./validate-brief.js";
import { parseBriefPlan, renderBrief, sanitizePlan } from "./brief-plan.js";
import { WINDOW_HOURS, CONTEXT_LENGTH, OUTPUT_TOKENS } from "../../config.js";

const itemSchema = z.object({
  title: z.string(),
  link: z.string(),
  source: z.string(),
  published: z.string(),
  summary: z.string(),
});

/** Step 1: gather the overnight items (plain code — fast and deterministic). */
const fetchStep = createStep({
  id: "fetch-overnight",
  inputSchema: z.object({
    windowHours: z.number().optional(),
    dateLabel: z.string().optional(),
  }),
  outputSchema: z.object({
    items: z.array(itemSchema),
    fetchedAt: z.string(),
    dateLabel: z.string().optional(),
  }),
  execute: async ({ inputData }) => {
    const items = await fetchOvernightItems(
      inputData.windowHours ?? WINDOW_HOURS,
    );
    return {
      items,
      fetchedAt: new Date().toISOString(),
      dateLabel: inputData.dateLabel,
    };
  },
});

/** Rough token estimate (chars / 4) — good enough for budget guardrails. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatListing(items: NewsItem[]): string {
  // No links in the prompt on purpose: the model plans in item IDs and
  // the renderer attaches the real links. A URL the model never sees is
  // a URL it cannot mutate, miscopy, or invent.
  return items
    .map(
      (item, i) =>
        `${i + 1}. [${item.source}] ${item.title}\n   ${item.summary.slice(0, 280)}`,
    )
    .join("\n\n");
}

/**
 * Fit the item list inside the model's total context window: the prompt,
 * the agent instructions (~600 tokens) and the brief itself must all fit.
 * Items that don't fit are dropped (newest items are already first-class:
 * the fetch step sorts newest-first, and the tail is the least essential).
 */
function budgetItems(items: NewsItem[]): NewsItem[] {
  const budget = CONTEXT_LENGTH - OUTPUT_TOKENS - 700;
  const kept: NewsItem[] = [];
  for (const item of items) {
    const candidate = [...kept, item];
    if (estimateTokens(formatListing(candidate)) > budget) break;
    kept.push(item);
  }
  if (kept.length < items.length) {
    console.error(
      `[sloth] context budget (${CONTEXT_LENGTH} tokens): using ${kept.length} of ${items.length} items`,
    );
  }
  return kept;
}

/** Step 2: the Sloth agent clusters and summarizes the items into the brief. */
const briefStep = createStep({
  id: "write-brief",
  inputSchema: z.object({
    items: z.array(itemSchema),
    fetchedAt: z.string(),
    dateLabel: z.string().optional(),
  }),
  outputSchema: z.object({ brief: z.string(), itemCount: z.number() }),
  execute: async ({ inputData }) => {
    const agent = workflowBrieferAgent;

    // One authoritative run date for the whole brief (from the fetch
    // timestamp unless the CLI supplied a label) — heading and filename
    // can no longer disagree around midnight.
    const dateLabel =
      inputData.dateLabel ??
      new Date(inputData.fetchedAt).toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      });

    if (inputData.items.length === 0) {
      return {
        brief:
          `# Sloth Brief — ${dateLabel}\n\n` +
          "Nothing new in the feeds overnight. Even the sloth approves — go back to bed.",
        itemCount: 0,
      };
    }

    const items = budgetItems(inputData.items);
    const listing = formatListing(items);
    const prompt =
      `Today is ${dateLabel}. Here are the ${items.length} items from the overnight feeds:\n\n` +
      listing +
      `\n\nReturn the JSON plan now, following your instructions exactly. Output ONLY the JSON object.`;

    // Stream the generation: a small local model can take many minutes,
    // and a buffered request dies on HTTP header timeouts long before
    // the first token comes back. Streaming keeps the connection alive.
    const generate = async (extra: string): Promise<string> => {
      const result = await agent.stream(prompt + extra, {
        // Output allowance only — the input side is budgeted in budgetItems.
        // Low temperature: this is faithful editing, not brainstorming.
        modelSettings: { maxOutputTokens: OUTPUT_TOKENS, temperature: 0.3 },
      });
      let text = "";
      for await (const chunk of result.textStream) text += chunk;
      return text;
    };

    // The model returns a plan; the renderer builds the brief. Two kinds
    // of problems are tracked separately:
    // - validation: structural checks on the rendered brief (sections,
    //   links, repeats). FAIL CLOSED: a brief that fails these is never
    //   returned — the step throws and no file is written.
    // - quality problems: sanitizePlan demotions (mismatched headlines,
    //   unsupported claims), already neutralized by demoting the entry
    //   to the radar with its true title. Worth one retry so the story
    //   gets a proper featured slot, but never a reason to ship a lie.
    const attempt = async (extra: string) => {
      const raw = await generate(extra);
      const plan = parseBriefPlan(raw);
      if (!plan) return null;
      const { plan: cleanPlan, problems } = sanitizePlan(plan, items);
      const brief = repairBrief(renderBrief(cleanPlan, items, dateLabel), items);
      return { brief, validation: validateBrief(brief, items), qualityProblems: problems };
    };
    const score = (r: NonNullable<Awaited<ReturnType<typeof attempt>>>) =>
      (r.validation.ok ? 0 : 100) +
      r.validation.problems.length +
      r.qualityProblems.length;

    let result = await attempt("");
    if (!result || !result.validation.ok || result.qualityProblems.length > 0) {
      const reason = !result
        ? "the model did not return a valid JSON plan"
        : [...result.validation.problems, ...result.qualityProblems].join("; ");
      console.error(`[sloth] first attempt unusable (${reason}), retrying once`);
      const retry = await attempt(
        `\n\nIMPORTANT: a previous attempt failed because ${reason}. Return a corrected JSON plan.`,
      );
      if (retry && (!result || score(retry) <= score(result))) {
        result = retry;
      }
    }

    if (!result) {
      throw new Error(
        "The model did not return a valid JSON plan after two attempts. No brief was written.",
      );
    }
    // FAIL CLOSED: an invalid brief throws here and is never saved.
    assertBriefValid(result.brief, items);
    if (result.qualityProblems.length > 0) {
      console.error(
        `[sloth] note: ${result.qualityProblems.length} entr${result.qualityProblems.length === 1 ? "y" : "ies"} demoted to the radar: ${result.qualityProblems.join("; ")}`,
      );
    }

    return { brief: result.brief, itemCount: items.length };
  },
});

export const overnightBriefWorkflow = createWorkflow({
  id: "overnight-brief",
  inputSchema: z.object({
    windowHours: z.number().optional(),
    dateLabel: z.string().optional(),
  }),
  outputSchema: z.object({ brief: z.string(), itemCount: z.number() }),
})
  .then(fetchStep)
  .then(briefStep)
  .commit();
