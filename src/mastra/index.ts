import { Mastra } from "@mastra/core/mastra";
import { brieferAgent } from "./agents/briefer.js";
import { overnightBriefWorkflow } from "./workflows/overnight-brief.js";

export const mastra = new Mastra({
  agents: { brieferAgent },
  workflows: { overnightBriefWorkflow },
});
