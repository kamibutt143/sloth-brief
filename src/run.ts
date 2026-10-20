import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { mastra } from "./mastra/index.js";
import { MODEL, OLLAMA_BASE_URL, parseBoundedInt } from "./config.js";

/**
 * Sloth Brief CLI.
 *
 * Usage:  npm run brief [-- --hours 24]
 *
 * Runs the overnight-brief workflow (fetch feeds → Gemma writes the brief)
 * and saves the result to briefs/brief-YYYY-MM-DD.md.
 */

function printOllamaHelp(problem: string): void {
  console.error(
    [
      "",
      `🦥 ${problem}`,
      "",
      `Ollama endpoint: ${OLLAMA_BASE_URL}`,
      "Model:           " + MODEL,
      "",
      "Fix:",
      "  1. Start Ollama:        ollama serve   (use OLLAMA_CONTEXT_LENGTH=8192 for full briefs)",
      `  2. Pull the model:      ollama pull ${MODEL}`,
      "",
    ].join("\n"),
  );
}

/**
 * Preflight: Ollama must be reachable AND the configured model must
 * actually be installed — a reachable server with a missing model
 * otherwise fails later, deep inside generation, with a worse error.
 */
async function checkOllama(): Promise<void> {
  let modelIds: string[];
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/models`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { id?: string }[] };
    modelIds = (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
  } catch {
    printOllamaHelp("Sloth can't reach Ollama.");
    process.exit(1);
  }

  const modelPresent = modelIds.some(
    (id) => id === MODEL || (!MODEL.includes(":") && id.startsWith(`${MODEL}:`)),
  );
  if (!modelPresent) {
    printOllamaHelp(
      `Ollama is running, but the model "${MODEL}" is not installed.`,
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  let windowHours: number | undefined;
  const hoursFlag = process.argv.indexOf("--hours");
  if (hoursFlag >= 0) {
    const raw = process.argv[hoursFlag + 1];
    if (raw === undefined) {
      console.error("Missing value for --hours. Usage: npm run brief -- --hours 24");
      process.exit(1);
    }
    try {
      windowHours = parseBoundedInt("--hours", raw, 12, 1, 168);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  await checkOllama();

  console.log(
    `🦥 Sloth is reading the feeds so you don't have to… (model: ${MODEL})`,
  );

  // A single run date, in local time, drives both the brief's heading and
  // its filename — they can no longer disagree around midnight.
  const now = new Date();
  const dateLabel = now.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const fileDate = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");

  const workflow = mastra.getWorkflow("overnightBriefWorkflow");
  const run = await workflow.createRun();
  const result = await run.start({
    inputData: { windowHours, dateLabel },
  });

  if (result.status !== "success") {
    const detail =
      result.status === "failed"
        ? (result.error?.message ?? "unknown error")
        : result.status;
    console.error(`Workflow did not complete (${result.status}): ${detail}`);
    process.exit(1);
  }

  const { brief, itemCount } = result.result;
  const outDir = path.join(process.cwd(), "briefs");
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `brief-${fileDate}.md`);
  await writeFile(outFile, brief + "\n", "utf8");

  console.log(
    `\n✅ Brief written from ${itemCount} overnight items → ${outFile}\n`,
  );
  console.log(brief);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
