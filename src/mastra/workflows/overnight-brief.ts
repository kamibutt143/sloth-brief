import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { fetchOvernightItems } from "../tools/fetch-feeds.js";
import { workflowBrieferAgent } from "../agents/briefer.js";
import { WINDOW_HOURS } from "../../config.js";

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
  inputSchema: z.object({ windowHours: z.number().optional() }),
  outputSchema: z.object({
    items: z.array(itemSchema),
    fetchedAt: z.string(),
  }),
  execute: async ({ inputData }) => {
    const items = await fetchOvernightItems(
      inputData.windowHours ?? WINDOW_HOURS,
    );
    return { items, fetchedAt: new Date().toISOString() };
  },
});

/** Step 2: the Sloth agent clusters and summarizes the items into the brief. */
const briefStep = createStep({
  id: "write-brief",
  inputSchema: z.object({
    items: z.array(itemSchema),
    fetchedAt: z.string(),
  }),
  outputSchema: z.object({ brief: z.string(), itemCount: z.number() }),
  execute: async ({ inputData }) => {
    const agent = workflowBrieferAgent;

    if (inputData.items.length === 0) {
      return {
        brief:
          "# Sloth Brief\n\nNothing new in the feeds overnight. Even the sloth approves — go back to bed.",
        itemCount: 0,
      };
    }

    const today = new Date().toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    const listing = inputData.items
      .map(
        (item, i) =>
          // Trim summaries: small local models run in a small context
          // window, and the prompt must leave room for the brief itself.
          `${i + 1}. [${item.source}] ${item.title}\n   ${item.link}\n   ${item.summary.slice(0, 280)}`,
      )
      .join("\n\n");

    const { text } = await agent.generate(
      `Today is ${today}. Here are the ${inputData.items.length} items from the overnight feeds:\n\n` +
        listing +
        `\n\nWrite the morning brief now, following your instructions exactly.`,
      // Small local models otherwise stop early — give the brief room to finish.
      { modelSettings: { maxOutputTokens: 4096 } },
    );

    return { brief: text, itemCount: inputData.items.length };
  },
});

export const overnightBriefWorkflow = createWorkflow({
  id: "overnight-brief",
  inputSchema: z.object({ windowHours: z.number().optional() }),
  outputSchema: z.object({ brief: z.string(), itemCount: z.number() }),
})
  .then(fetchStep)
  .then(briefStep)
  .commit();
