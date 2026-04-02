import { TerminalWebgpuApiClient } from "./lib/api-client.mjs";
import { runAgentLoop } from "./lib/agent-loop.mjs";
import { benchmarkCases, getBenchmarkCase } from "./lib/benchmarks.mjs";
import { TerminalUI, UILogger, SummaryLogger, SilentLogger } from "./lib/terminal-ui.mjs";

const ui = new TerminalUI();

function parseArgs(args) {
  const options = {
    model: process.env.MODEL || "",
    runs: 1,
    caseId: "",
    interactive: true,
    verbose: false,
    silent: false,
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
    free.push(value);
  }

  options.prompt = free.join(" ").trim();
  return options;
}

function displayCases() {
  ui.subheader("Available Benchmark Cases");
  ui.blank();

  benchmarkCases.forEach((entry, index) => {
    console.log(`  ${ui.colors.bright}${index + 1}. ${entry.id}${ui.colors.reset}`);
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

async function selectBenchmarkCase() {
  ui.section("Select a Benchmark Case");
  console.log();
  benchmarkCases.forEach((entry, i) => {
    console.log(`  ${ui.colors.bright}${i + 1}${ui.colors.reset}. ${entry.id}`);
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

async function runBenchmarkRun(api, prompt, caseData, runNumber, totalRuns, verbose = false, silent = false) {
  ui.section(`Run ${runNumber}/${totalRuns}`);
  console.log(`${ui.colors.dim}Prompt: ${prompt}${ui.colors.reset}\n`);

  let logger;
  if (verbose) {
    logger = new UILogger(ui);
  } else if (silent) {
    logger = new SilentLogger();
  } else {
    logger = new SummaryLogger(ui);
  }

  const result = await runAgentLoop({
    api,
    userPrompt: prompt,
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
      ui.info("Starting benchmark...");
      ui.blank();

      const results = [];
      for (let run = 1; run <= runs; run += 1) {
        try {
          const result = await runBenchmarkRun(api, prompt, caseData, run, runs, verbose);
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
  const logger = options.verbose ? console : new SilentLogger();
  const api = new TerminalWebgpuApiClient({ model: options.model, logger });

  try {
    const health = await api.health();
    console.log(`api: ${api.baseUrl} | loaded: ${health.loaded ? "yes" : "no"}`);

    if (options.model) {
      console.log(`loading model: ${options.model}`);
      await api.load(options.model);
    }

    console.log(`benchmark prompt: ${options.prompt}`);
    console.log(`runs: ${options.runs}`);

    const results = [];
    for (let run = 1; run <= options.runs; run += 1) {
      console.log(`\n=== run ${run}/${options.runs} ===`);
      let debugLogger;
      if (options.verbose) {
        debugLogger = console;
      } else if (options.silent) {
        debugLogger = new SilentLogger();
      } else {
        debugLogger = new SummaryLogger(ui);
      }
      const result = await runAgentLoop({
        api,
        userPrompt: options.prompt,
        logger: debugLogger,
      });
      results.push(result);
      console.log("\nfinal answer:\n");
      console.log(result.answer);
      if (result.reasoning) {
        console.log(`\nsummary: ${result.reasoning}`);
      }
      console.log(`\nmetrics: ${JSON.stringify({ step: result.step, elapsedMs: result.elapsedMs }, null, 2)}`);
    }

    const summary = summarizeRuns(results);
    console.log("\nbenchmark summary:\n");
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function quickSetupMode(verbose = false, silent = false) {
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
      const result = await runBenchmarkRun(api, prompt, caseData, run, runs, verbose, silent);
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

  // Check if we have all required info for CLI mode
  const selectedCase = options.caseId ? getBenchmarkCase(options.caseId) : null;
  const prompt = selectedCase?.prompt || options.prompt;
  const hasCliArgs = prompt || options.model || options.caseId;

  if (hasCliArgs) {
    // CLI mode with arguments
    if (!prompt) {
      console.error("Usage: pnpm start -- [--model MODEL_ID] [--runs N] [--case CASE_ID] [--verbose] [--silent] \"your task here\"");
      console.error("       pnpm start -- --list-cases");
      console.error("       pnpm start -- [--no-interactive] [--verbose] [--silent]");
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
    await quickSetupMode(options.verbose, options.silent);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
