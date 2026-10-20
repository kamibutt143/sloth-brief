import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { mastra } from "./mastra/index.js";
import { MODEL, OLLAMA_BASE_URL } from "./config.js";

/**
 * Sloth Brief CLI.
 *
 * Usage:  npm run brief [-- --hours 24]
 *
 * Runs the overnight-brief workflow (fetch feeds → Gemma writes the brief)
 * and saves the result to briefs/brief-YYYY-MM-DD.md.
 */

async function checkOllama(): Promise<void> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/models`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    console.error(
      [
        "",
        "🦥 Sloth can't reach Ollama.",
        "",
        `Ollama endpoint: ${OLLAMA_BASE_URL}`,
        "Model:           " + MODEL,
        "",
        "Fix:",
        "  1. Start Ollama:        ollama serve",
        `  2. Pull the model:      ollama pull ${MODEL}`,
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const hoursFlag = process.argv.indexOf("--hours");
  const windowHours =
    hoursFlag >= 0 ? Number(process.argv[hoursFlag + 1]) : undefined;

  await checkOllama();

  console.log(
    `🦥 Sloth is reading the feeds so you don't have to… (model: ${MODEL})`,
  );

  const workflow = mastra.getWorkflow("overnightBriefWorkflow");
  const run = await workflow.createRun();
  const result = await run.start({
    inputData: windowHours ? { windowHours } : {},
  });

  if (result.status !== "success") {
    console.error("Workflow did not complete:", result.status);
    process.exit(1);
  }

  const { brief, itemCount } = result.result;
  const date = new Date().toISOString().slice(0, 10);
  const outDir = path.join(process.cwd(), "briefs");
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `brief-${date}.md`);
  await writeFile(outFile, brief + "\n", "utf8");

  console.log(
    `\n✅ Brief written from ${itemCount} overnight items → ${outFile}\n`,
  );
  console.log(brief);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
