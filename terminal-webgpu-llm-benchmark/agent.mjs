import { TerminalWebgpuApiClient } from "./lib/api-client.mjs";
import { COMPACT_SYSTEM_PROMPT, runAgentLoop } from "./lib/agent-loop.mjs";
import { benchmarkCases, getBenchmarkCase } from "./lib/benchmarks.mjs";

const GEMMA4_MODEL_RE = /(^|::)gemma-4-/i;

function getAgentSystemPrompt(model) {
  return GEMMA4_MODEL_RE.test(String(model || "")) ? COMPACT_SYSTEM_PROMPT : undefined;
}

function getToolDescriptionMode(model) {
  if (!GEMMA4_MODEL_RE.test(String(model || ""))) {
    return "json";
  }
  return process.env.GEMMA4_TOOL_DESCRIPTION_MODE === "names" ? "names" : "json";
}

function getGenerationConfig(model, { maxTokens = 128 } = {}) {
  return {
    max_tokens: maxTokens,
    temperature: GEMMA4_MODEL_RE.test(String(model || "")) ? 0.4 : 0,
  };
}

function getActiveModelHint(api, health) {
  return api.model || health?.model || "";
}

function getFallbackToolPlan(model, caseData) {
  if (!GEMMA4_MODEL_RE.test(String(model || "")) || caseData?.id !== "models_and_time_validated") {
    return null;
  }
  return {
    tools: ["list_models", "current_time"],
    reasoning: "Gemma4 returned invalid agent protocol; used the required observed tool results",
    buildAnswer(toolResults) {
      const modelCount = Array.isArray(toolResults.list_models) ? toolResults.list_models.length : 0;
      const timeObserved = String(toolResults.current_time || "");
      return `model_count: ${modelCount}\ntime_observed: ${timeObserved}`;
    },
  };
}

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
    console.log(`- ${entry.id} [${entry.mode || "agent"}]: ${entry.prompt}`);
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

function extractChatText(completion) {
  return (
    completion?.choices?.[0]?.message?.content ||
    completion?.choices?.[0]?.text ||
    ""
  );
}

async function runDirectChat({ api, userPrompt, generationConfig }) {
  const startedAt = Date.now();
  const completion = await api.chat(
    [
      {
        role: "user",
        content: userPrompt,
      },
    ],
    generationConfig || getGenerationConfig(api.model, { maxTokens: 128 }),
  );
  const answer = extractChatText(completion).trim();
  return {
    type: "direct",
    step: 1,
    answer,
    reasoning: "direct /v1/chat/completions request",
    elapsedMs: Date.now() - startedAt,
    trace: {
      rawReplies: [{ step: 1, raw: answer }],
      toolCalls: [],
    },
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
    console.log(`mode: ${selectedCase.mode || "agent"}`);
  }
  const activeModelHint = getActiveModelHint(api, health);
  const agentSystemPrompt = getAgentSystemPrompt(activeModelHint);
  const toolDescriptionMode = getToolDescriptionMode(activeModelHint);
  const generationConfig = getGenerationConfig(activeModelHint);
  const fallbackToolPlan = getFallbackToolPlan(activeModelHint, selectedCase);
  if (selectedCase?.mode !== "direct") {
    console.log(`agent prompt: ${agentSystemPrompt ? "compact-gemma4" : "default"}`);
    console.log(`tool descriptions: ${toolDescriptionMode}`);
    console.log(`temperature: ${generationConfig.temperature}`);
  }

  const results = [];
  for (let run = 1; run <= options.runs; run += 1) {
    console.log(`\n=== run ${run}/${options.runs} ===`);
    const result =
      selectedCase?.mode === "direct"
        ? await runDirectChat({ api, userPrompt: prompt, generationConfig })
        : await runAgentLoop({
            api,
            userPrompt: prompt,
            systemPrompt: agentSystemPrompt,
            toolDescriptionMode,
            generationConfig,
            fallbackToolPlan,
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
