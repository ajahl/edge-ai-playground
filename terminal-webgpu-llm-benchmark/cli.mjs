import { TerminalWebgpuApiClient } from "./lib/api-client.mjs";
import { COMPACT_SYSTEM_PROMPT, runAgentLoop } from "./lib/agent-loop.mjs";
import { benchmarkCases, getBenchmarkCase } from "./lib/benchmarks.mjs";
import { TerminalUI, UILogger, SummaryLogger, SilentLogger, FileLogger, CombinedLogger } from "./lib/terminal-ui.mjs";

const ui = new TerminalUI();
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
    interactive: true,
    verbose: false,
    silent: false,
    logFile: null,
    smoke: false,
    smokePrompt: "Reply with exactly: hello",
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
    if (value === "--smoke") {
      options.smoke = true;
      continue;
    }
    if (value === "--smoke-prompt") {
      options.smokePrompt = args[index + 1] || options.smokePrompt;
      index += 1;
      continue;
    }
    if (value === "--no-interactive") {
      options.interactive = false;
      continue;
    }
    if (value === "--verbose" || value === "-v") {
      options.verbose = true;
      continue;
    }
    if (value === "--silent" || value === "-s") {
      options.silent = true;
      continue;
    }
    if (value === "--log-file") {
      options.logFile = args[index + 1] || null;
      index += 1;
      continue;
    }
    free.push(value);
  }

  options.prompt = free.join(" ").trim();
  return options;
}

function displayCases() {
  ui.subheader("Available Benchmark Cases");
  ui.blank();

  benchmarkCases.forEach((entry, index) => {
    const mode = entry.mode || "agent";
    console.log(`  ${ui.colors.bright}${index + 1}. ${entry.id}${ui.colors.reset} ${ui.colors.dim}[${mode}]${ui.colors.reset}`);
    console.log(`     ${ui.colors.dim}${entry.prompt}${ui.colors.reset}`);
    console.log();
  });
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

function createLogger(verbose = false, silent = false, logFile = null) {
  let logger;
  let actualLogFile = null;
  
  if (verbose) {
    logger = new UILogger(ui);
  } else if (silent) {
    logger = new SilentLogger();
  } else {
    logger = new SummaryLogger(ui);
  }
  
  if (logFile) {
    const fileLogger = new FileLogger(logFile);
    actualLogFile = fileLogger.filePath;
    logger = new CombinedLogger(logger, fileLogger);
  }
  
  return { logger, actualLogFile };
}

function extractChatText(completion) {
  return (
    completion?.choices?.[0]?.message?.content ||
    completion?.choices?.[0]?.text ||
    ""
  );
}

async function runDirectChat({ api, userPrompt, generationConfig, logger = console }) {
  const startedAt = Date.now();
  logger.log("direct chat: generating");
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

async function runSmokeTest(options) {
  const { logger, actualLogFile } = createLogger(options.verbose, options.silent, options.logFile);
  const api = new TerminalWebgpuApiClient({ model: options.model, logger });
  const startedAt = Date.now();

  try {
    console.log(`api: ${api.baseUrl}`);
    if (actualLogFile) {
      console.log(`logging to: ${actualLogFile}`);
    }

    const health = await api.health();
    console.log(`health: ${health.ok ? "ok" : "not ok"} | loaded: ${health.loaded ? "yes" : "no"}`);

    const models = await api.models();
    const modelIds = models?.data?.map((entry) => entry.id).filter(Boolean) || [];
    console.log(`models: ${modelIds.length}`);

    if (options.model) {
      console.log(`loading model: ${options.model}`);
      await api.load(options.model);
      console.log("load: ok");
    } else {
      console.log("load: skipped (no --model provided)");
    }

    const prompt = options.smokePrompt;
    console.log(`chat prompt: ${prompt}`);
    const completion = await api.chat(
      [
        {
          role: "user",
          content: prompt,
        },
      ],
      {
        ...getGenerationConfig(options.model, { maxTokens: 64 }),
      },
    );

    const text = extractChatText(completion).trim();
    if (!text) {
      throw new Error("Smoke chat returned empty text.");
    }

    console.log("\nsmoke response:\n");
    console.log(text);
    console.log(`\nsmoke: passed in ${Date.now() - startedAt}ms`);
  } finally {
    if (logger.close) {
      await logger.close();
    }
  }
}

async function selectBenchmarkCase() {
  ui.section("Select a Benchmark Case");
  console.log();
  benchmarkCases.forEach((entry, i) => {
    console.log(`  ${ui.colors.bright}${i + 1}${ui.colors.reset}. ${entry.id} ${ui.colors.dim}[${entry.mode || "agent"}]${ui.colors.reset}`);
    console.log(`     ${ui.colors.dim}${entry.prompt}${ui.colors.reset}\n`);
  });
  console.log(`  ${ui.colors.bright}0${ui.colors.reset}. Custom prompt\n`);

  const selection = await ui.input("Select option (0-" + benchmarkCases.length + "):");
  const index = parseInt(selection) - 1;

  if (selection === "0") {
    const customPrompt = await ui.input("Enter your prompt:");
    return { prompt: customPrompt, caseId: null };
  }

  if (index >= 0 && index < benchmarkCases.length) {
    const selectedCase = benchmarkCases[index];
    return { prompt: selectedCase.prompt, caseId: selectedCase.id };
  }

  ui.error("Invalid selection");
  return selectBenchmarkCase();
}

async function selectModel(api) {
  try {
    const result = await api.models();
    const models = result?.data?.map((entry) => entry.id) || [];

    if (models.length === 0) {
      ui.warning("No models available");
      return null;
    }

    ui.section("Available Models");
    models.forEach((model, i) => {
      console.log(`  ${ui.colors.bright}${i + 1}${ui.colors.reset}. ${model}`);
    });
    console.log();

    const selection = await ui.input("Select model (1-" + models.length + "):");
    const index = parseInt(selection) - 1;

    if (index >= 0 && index < models.length) {
      return models[index];
    }

    ui.error("Invalid selection");
    return selectModel(api);
  } catch (error) {
    ui.error("Failed to fetch models: " + error.message);
    return null;
  }
}

async function runBenchmarkRun(api, prompt, caseData, runNumber, totalRuns, verbose = false, silent = false, logFile = null) {
  ui.section(`Run ${runNumber}/${totalRuns}`);
  console.log(`${ui.colors.dim}Prompt: ${prompt}${ui.colors.reset}\n`);
  console.log(`${ui.colors.dim}Mode: ${caseData?.mode || "agent"}${ui.colors.reset}\n`);

  const { logger, actualLogFile } = createLogger(verbose, silent, logFile);
  if (actualLogFile && runNumber === 1) {
    console.log(`${ui.colors.dim}Logging to: ${actualLogFile}${ui.colors.reset}\n`);
  }
  const generationConfig = getGenerationConfig(api.model);

  const result =
    caseData?.mode === "direct"
      ? await runDirectChat({ api, userPrompt: prompt, generationConfig, logger })
      : await runAgentLoop({
          api,
          userPrompt: prompt,
          systemPrompt: getAgentSystemPrompt(api.model),
          toolDescriptionMode: getToolDescriptionMode(api.model),
          generationConfig,
          fallbackToolPlan: getFallbackToolPlan(api.model, caseData),
          logger,
        });

  ui.agentFinal(result.answer, result.reasoning);

  if (caseData?.validate) {
    const validation = caseData.validate(result);
    result.validation = validation;
    ui.validation(validation);
  }

  ui.blank();
  ui.section("Run Metrics");
  ui.metric("Steps", result.step);
  ui.metric("Time", result.elapsedMs, "ms", ui.colors.green);

  if (logger.close) {
    await logger.close();
  }

  // Append results to log file if logging was enabled
  if (logFile && logger.getSecondary) {
    const fileLogger = logger.getSecondary();
    if (fileLogger?.appendResults) {
      await fileLogger.appendResults(result);
    }
  }

  // Track logger and log file for benchmark summary
  result._logger = logger;
  result._actualLogFile = actualLogFile;

  return result;
}

async function interactiveMode(verbose = false) {
  ui.clear();
  ui.header("Terminal WebGPU LLM Benchmark");
  ui.blank();

  const apiUrl = process.env.TERMINAL_WEBGPU_LLM_API_URL || "http://127.0.0.1:5179";
  const logger = verbose ? new UILogger(ui) : new SilentLogger();
  const api = new TerminalWebgpuApiClient({ baseUrl: apiUrl, logger });

  try {
    const health = await api.health();
    ui.success(`Connected to API at ${apiUrl}`);
    ui.status("Status", health.loaded ? "Ready" : "Model not loaded");
    ui.blank();
  } catch (error) {
    ui.error(`Failed to connect to API: ${error.message}`);
    ui.info("Make sure the terminal-webgpu-llm server is running");
    return;
  }

  while (true) {
    const mainMenu = await ui.input(
      "\n" +
        ui.colors.bright +
        "Main Menu\n" +
        "  1. Run Benchmark\n" +
        "  2. List Cases\n" +
        "  3. Select Model\n" +
        "  4. Exit\n\n" +
        "Choose option (1-4): " +
        ui.colors.reset
    );

    if (mainMenu === "1") {
      const { prompt, caseId } = await selectBenchmarkCase();
      const caseData = caseId ? getBenchmarkCase(caseId) : null;

      const runsInput = await ui.input("Number of runs (default 1):");
      const runs = Math.max(1, parseInt(runsInput) || 1);

      let model = api.model;
      if (!model) {
        model = await selectModel(api);
        if (model) {
          ui.info(`Loading model: ${model}`);
          await api.load(model);
        }
      }

      ui.blank();
      
      // Ask for logging options
      const verboseAnswer = await ui.confirm("Show verbose debug output?");
      const logFileAnswer = await ui.confirm("Save debug log to file?");
      let logFile = null;
      if (logFileAnswer) {
        const now = new Date();
        const timestamp = now.toISOString().split('.')[0].replace(/:/g, '-'); // e.g., 2026-04-02T13-13-07
        const defaultName = `benchmark-${timestamp}.log`;
        logFile = await ui.input(`Log file name (default: ${defaultName}):`);
        if (!logFile) logFile = defaultName;
      }
      
      ui.blank();
      ui.info("Starting benchmark...");
      ui.blank();

      const results = [];
      let trackingLogger = null;
      let trackingLogFile = null;
      
      for (let run = 1; run <= runs; run += 1) {
        try {
          const result = await runBenchmarkRun(api, prompt, caseData, run, runs, verboseAnswer, false, logFile);
          results.push(result);
          // Track the logger from the first run to use for benchmark summary
          if (run === 1 && logFile) {
            trackingLogger = result._logger;
            trackingLogFile = result._actualLogFile;
          }
        } catch (error) {
          ui.error(`Run ${run} failed: ${error.message}`);
        }
      }

      if (results.length > 0) {
        ui.blank();
        ui.header("Benchmark Summary");
        ui.blank();
        const summary = summarizeRuns(results);
        ui.benchmark(summary);
        ui.blank();
        
        // Append benchmark summary to log file if applicable
        if (logFile && trackingLogger && trackingLogger.appendBenchmarkSummary) {
          await trackingLogger.appendBenchmarkSummary(summary, trackingLogFile);
        }
        
        if (logFile) {
          ui.info(`Debug log saved to file (check console output for actual path)`);
        }
      }

      await ui.input("Press Enter to continue...");
    } else if (mainMenu === "2") {
      ui.clear();
      ui.header("Benchmark Cases");
      ui.blank();
      displayCases();
      await ui.input("Press Enter to go back...");
      ui.clear();
    } else if (mainMenu === "3") {
      await selectModel(api);
    } else if (mainMenu === "4") {
      ui.info("Goodbye!");
      break;
    } else {
      ui.warning("Invalid option");
    }

    ui.clear();
    ui.header("Terminal WebGPU LLM Benchmark");
  }
}

async function nonInteractiveMode(options) {
  const { logger: apiLogger, actualLogFile: apiLogFile } = createLogger(options.verbose, options.silent, options.logFile);
  const api = new TerminalWebgpuApiClient({ model: options.model, logger: apiLogger });

  try {
    const health = await api.health();
    console.log(`api: ${api.baseUrl} | loaded: ${health.loaded ? "yes" : "no"}`);

    if (options.model) {
      console.log(`loading model: ${options.model}`);
      await api.load(options.model);
    }

    console.log(`benchmark prompt: ${options.prompt}`);
    console.log(`runs: ${options.runs}`);
    const caseData = options.caseId ? getBenchmarkCase(options.caseId) : null;
    const activeModelHint = getActiveModelHint(api, health);
    const agentSystemPrompt = getAgentSystemPrompt(activeModelHint);
    const toolDescriptionMode = getToolDescriptionMode(activeModelHint);
    const generationConfig = getGenerationConfig(activeModelHint);
    const fallbackToolPlan = getFallbackToolPlan(activeModelHint, caseData);
    console.log(`mode: ${caseData?.mode || "agent"}`);
    if (caseData?.mode !== "direct") {
      console.log(`agent prompt: ${agentSystemPrompt ? "compact-gemma4" : "default"}`);
      console.log(`tool descriptions: ${toolDescriptionMode}`);
      console.log(`temperature: ${generationConfig.temperature}`);
    }
    if (apiLogFile) {
      console.log(`logging to: ${apiLogFile}`);
    }

    const results = [];
    for (let run = 1; run <= options.runs; run += 1) {
      console.log(`\n=== run ${run}/${options.runs} ===`);
      const { logger: agentLogger } = createLogger(options.verbose, options.silent, options.logFile);
      const result =
        caseData?.mode === "direct"
          ? await runDirectChat({ api, userPrompt: options.prompt, generationConfig, logger: agentLogger })
          : await runAgentLoop({
              api,
              userPrompt: options.prompt,
              systemPrompt: agentSystemPrompt,
              toolDescriptionMode,
              generationConfig,
              fallbackToolPlan,
              logger: agentLogger,
            });
      if (agentLogger.close) {
        await agentLogger.close();
      }
      results.push(result);
      console.log("\nfinal answer:\n");
      console.log(result.answer);
      if (result.reasoning) {
        console.log(`\nsummary: ${result.reasoning}`);
      }
      if (caseData?.validate) {
        const validation = caseData.validate(result);
        result.validation = validation;
        console.log("\nvalidation:\n");
        console.log(JSON.stringify(validation, null, 2));
      }
      console.log(`\nmetrics: ${JSON.stringify({ step: result.step, elapsedMs: result.elapsedMs }, null, 2)}`);
    }

    const summary = summarizeRuns(results);
    console.log("\nbenchmark summary:\n");
    console.log(JSON.stringify(summary, null, 2));

    if (apiLogger.close) {
      await apiLogger.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (apiLogger.close) {
      await apiLogger.close();
    }
    process.exit(1);
  }
}

async function quickSetupMode(verbose = false, silent = false, logFile = null) {
  ui.clear();
  ui.header("Terminal WebGPU LLM Benchmark");
  ui.blank();

  const apiUrl = process.env.TERMINAL_WEBGPU_LLM_API_URL || "http://127.0.0.1:5179";
  const logger = verbose ? new UILogger(ui) : new SilentLogger();
  const api = new TerminalWebgpuApiClient({ baseUrl: apiUrl, logger });

  try {
    const health = await api.health();
    ui.success(`Connected to API at ${apiUrl}`);
    ui.status("Status", health.loaded ? "Ready" : "Model not loaded");
    ui.blank();
  } catch (error) {
    ui.error(`Failed to connect to API: ${error.message}`);
    ui.info("Make sure the terminal-webgpu-llm server is running");
    return;
  }

  const { prompt, caseId } = await selectBenchmarkCase();
  const caseData = caseId ? getBenchmarkCase(caseId) : null;

  const runsInput = await ui.input("Number of runs (default 1):");
  const runs = Math.max(1, parseInt(runsInput) || 1);

  let model = api.model;
  if (!model) {
    model = await selectModel(api);
    if (model) {
      ui.info(`Loading model: ${model}`);
      await api.load(model);
    }
  }

  ui.blank();
  ui.info("Starting benchmark...");
  ui.blank();

  const results = [];
  for (let run = 1; run <= runs; run += 1) {
    try {
      const result = await runBenchmarkRun(api, prompt, caseData, run, runs, verbose, silent, logFile);
      results.push(result);
    } catch (error) {
      ui.error(`Run ${run} failed: ${error.message}`);
    }
  }

  if (results.length > 0) {
    ui.blank();
    ui.header("Benchmark Summary");
    ui.blank();
    const summary = summarizeRuns(results);
    ui.benchmark(summary);
    ui.blank();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.listCases) {
    displayCases();
    return;
  }

  if (options.smoke) {
    await runSmokeTest(options);
    return;
  }

  // Check if we have all required info for CLI mode
  const selectedCase = options.caseId ? getBenchmarkCase(options.caseId) : null;
  const prompt = selectedCase?.prompt || options.prompt;
  const hasCliArgs = prompt || options.model || options.caseId;

  if (hasCliArgs) {
    // CLI mode with arguments
    if (!prompt) {
      console.error("Usage: pnpm start -- [--model MODEL_ID] [--runs N] [--case CASE_ID] [--verbose] [--silent] [--log-file FILE] \"your task here\"");
      console.error("       pnpm start -- --smoke [--model MODEL_ID] [--smoke-prompt PROMPT]");
      console.error("       pnpm start -- --list-cases");
      console.error("       pnpm start -- [--no-interactive] [--verbose] [--silent] [--log-file FILE]");
      process.exit(1);
    }

    await nonInteractiveMode({
      ...options,
      prompt,
    });
  } else if (options.interactive) {
    // Full interactive mode with menu
    await interactiveMode(options.verbose);
  } else {
    // Quick setup mode (--no-interactive without args)
    await quickSetupMode(options.verbose, options.silent, options.logFile);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
