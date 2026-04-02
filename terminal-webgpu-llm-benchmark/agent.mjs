import { TerminalWebgpuApiClient } from "./lib/api-client.mjs";
import { runAgentLoop } from "./lib/agent-loop.mjs";
import { benchmarkCases, getBenchmarkCase } from "./lib/benchmarks.mjs";

function parseArgs(args) {
  const options = {
    model: process.env.MODEL || "",
    runs: 1,
    caseId: "",
  };

  const free = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--model") {
      options.model = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (value === "--runs") {
      options.runs = Math.max(1, Number(args[index + 1] || "1"));
      index += 1;
      continue;
    }
    if (value === "--case") {
      options.caseId = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (value === "--list-cases") {
      options.listCases = true;
      continue;
    }
    free.push(value);
  }

  options.prompt = free.join(" ").trim();
  return options;
}

function printCases() {
  console.log("available benchmark cases:\n");
  for (const entry of benchmarkCases) {
    console.log(`- ${entry.id}: ${entry.prompt}`);
  }
}

function summarizeRuns(results) {
  const totalMs = results.reduce((sum, entry) => sum + entry.elapsedMs, 0);
  const totalSteps = results.reduce((sum, entry) => sum + entry.step, 0);
  return {
    runs: results.length,
    avgMs: Math.round(totalMs / results.length),
    avgSteps: Number((totalSteps / results.length).toFixed(2)),
    minMs: Math.min(...results.map((entry) => entry.elapsedMs)),
    maxMs: Math.max(...results.map((entry) => entry.elapsedMs)),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.listCases) {
    printCases();
    return;
  }

  const selectedCase = options.caseId ? getBenchmarkCase(options.caseId) : null;
  const prompt = selectedCase?.prompt || options.prompt;

  if (!prompt) {
    console.error("Usage: pnpm start -- [--model MODEL_ID] [--runs N] [--case CASE_ID] \"your task here\"");
    console.error("       pnpm start -- --list-cases");
    process.exit(1);
  }

  const api = new TerminalWebgpuApiClient({ model: options.model, logger: console });
  const health = await api.health();
  console.log(`api: ${api.baseUrl} | loaded: ${health.loaded ? "yes" : "no"}`);

  if (options.model) {
    console.log(`loading model: ${options.model}`);
    await api.load(options.model);
  }

  console.log(`benchmark prompt: ${prompt}`);
  console.log(`runs: ${options.runs}`);
  if (selectedCase) {
    console.log(`case: ${selectedCase.id}`);
  }

  const results = [];
  for (let run = 1; run <= options.runs; run += 1) {
    console.log(`\n=== run ${run}/${options.runs} ===`);
    const result = await runAgentLoop({
      api,
      userPrompt: prompt,
      logger: console,
    });
    results.push(result);
    console.log("\nfinal answer:\n");
    console.log(result.answer);
    if (result.reasoning) {
      console.log(`\nsummary: ${result.reasoning}`);
    }
    if (selectedCase?.validate) {
      const validation = selectedCase.validate(result);
      result.validation = validation;
      console.log("\nvalidation:\n");
      console.log(JSON.stringify(validation, null, 2));
    }
    console.log(`\nmetrics: ${JSON.stringify({ step: result.step, elapsedMs: result.elapsedMs }, null, 2)}`);
  }

  const summary = summarizeRuns(results);
  console.log("\nbenchmark summary:\n");
  console.log(JSON.stringify(summary, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
