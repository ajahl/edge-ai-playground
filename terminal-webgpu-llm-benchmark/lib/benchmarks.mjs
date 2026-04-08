function findToolCall(result, toolName) {
  return result?.trace?.toolCalls?.find((entry) => entry.tool === toolName) || null;
}

function validateHello(result) {
  const passed = typeof result.answer === "string" && result.answer.trim().length > 0;
  return {
    passed,
    checks: [
      {
        name: "non_empty_answer",
        passed,
        details: passed ? `answer="${result.answer}"` : "final answer was empty",
      },
    ],
  };
}

function validateModelsAndTime(result) {
  const modelCall = findToolCall(result, "list_models");
  const timeCall = findToolCall(result, "current_time");
  const modelList = Array.isArray(modelCall?.result) ? modelCall.result : [];
  const timeValue = typeof timeCall?.result === "string" ? timeCall.result : "";
  const answer = String(result?.answer || "");

  const checks = [
    {
      name: "used_list_models",
      passed: Boolean(modelCall),
      details: modelCall ? `tool used at step ${modelCall.step}` : "list_models was not used",
    },
    {
      name: "used_current_time",
      passed: Boolean(timeCall),
      details: timeCall ? `tool used at step ${timeCall.step}` : "current_time was not used",
    },
    {
      name: "reported_model_count",
      passed: modelList.length > 0 && answer.includes(String(modelList.length)),
      details:
        modelList.length > 0
          ? `expected count ${modelList.length}`
          : "no model list result available",
    },
    {
      name: "reported_time_value",
      passed: Boolean(timeValue) && answer.includes(timeValue),
      details: timeValue || "no current_time result available",
    },
  ];

  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
}

function validateMiniCodingAgentPattern(result) {
  const cwdCall = findToolCall(result, "workspace_cwd");
  const filesCall = findToolCall(result, "workspace_files");
  const cwdValue = typeof cwdCall?.result === "string" ? cwdCall.result : "";
  const filesValue = Array.isArray(filesCall?.result) ? filesCall.result : [];
  const answer = String(result?.answer || "");

  const cwdLine = cwdValue ? `cwd: ${cwdValue}` : "";
  const entriesLine = `entries: ${filesValue.length}`;
  const summaryLine = "pattern: observed workspace before final answer";

  const checks = [
    {
      name: "used_workspace_cwd",
      passed: Boolean(cwdCall),
      details: cwdCall ? `tool used at step ${cwdCall.step}` : "workspace_cwd was not used",
    },
    {
      name: "used_workspace_files",
      passed: Boolean(filesCall),
      details: filesCall ? `tool used at step ${filesCall.step}` : "workspace_files was not used",
    },
    {
      name: "reported_exact_cwd",
      passed: Boolean(cwdLine) && answer.includes(cwdLine),
      details: cwdLine || "no cwd result available",
    },
    {
      name: "reported_entry_count",
      passed: answer.includes(entriesLine),
      details: entriesLine,
    },
    {
      name: "reported_pattern_summary",
      passed: answer.includes(summaryLine),
      details: summaryLine,
    },
  ];

  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
}

function validateLocalAgentLoopInspection(result) {
  const modelCall = findToolCall(result, "list_models");
  const cwdCall = findToolCall(result, "workspace_cwd");
  const filesCall = findToolCall(result, "workspace_files");
  const modelList = Array.isArray(modelCall?.result) ? modelCall.result : [];
  const cwdValue = typeof cwdCall?.result === "string" ? cwdCall.result : "";
  const filesValue = Array.isArray(filesCall?.result) ? filesCall.result : [];
  const answer = String(result?.answer || "");

  const checks = [
    {
      name: "used_list_models",
      passed: Boolean(modelCall),
      details: modelCall ? `tool used at step ${modelCall.step}` : "list_models was not used",
    },
    {
      name: "used_workspace_cwd",
      passed: Boolean(cwdCall),
      details: cwdCall ? `tool used at step ${cwdCall.step}` : "workspace_cwd was not used",
    },
    {
      name: "used_workspace_files",
      passed: Boolean(filesCall),
      details: filesCall ? `tool used at step ${filesCall.step}` : "workspace_files was not used",
    },
    {
      name: "reported_model_count",
      passed: answer.includes(`model_count: ${modelList.length}`),
      details: `model_count: ${modelList.length}`,
    },
    {
      name: "reported_exact_cwd",
      passed: Boolean(cwdValue) && answer.includes(`cwd: ${cwdValue}`),
      details: cwdValue || "no cwd result available",
    },
    {
      name: "reported_entry_count",
      passed: answer.includes(`entries: ${filesValue.length}`),
      details: `entries: ${filesValue.length}`,
    },
    {
      name: "reported_loop_summary",
      passed: answer.includes("loop: local minimal agent loop completed"),
      details: "loop: local minimal agent loop completed",
    },
  ];

  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
}

export const benchmarkCases = [
  {
    id: "direct_hello",
    prompt: "Say hello in one short sentence.",
    description: "Direct answer without tool use.",
    validate: validateHello,
  },
  {
    id: "models_and_time_validated",
    prompt:
      "Use tools to get the available models and the current local time. Then return a final answer with exactly these lines: model_count: <count> and time_observed: <exact time string>.",
    description: "Validated multi-step workflow using list_models and current_time.",
    validate: validateModelsAndTime,
  },
  {
    id: "mini_coding_agent_pattern",
    prompt:
      "Follow a mini coding agent style loop. First observe the workspace with tools instead of guessing. Use the workspace_cwd and workspace_files tools, then return a final answer with exactly these three lines: cwd: <exact cwd string>, entries: <number of items returned by workspace_files>, and pattern: observed workspace before final answer.",
    description: "Validated repo-observation workflow inspired by rasbt/mini-coding-agent.",
    validate: validateMiniCodingAgentPattern,
  },
  {
    id: "local_agent_loop_inspection",
    prompt:
      "Use the local minimal agent loop carefully. Gather facts with tools before answering. Use list_models, workspace_cwd, and workspace_files, then return a final answer with exactly these four lines: model_count: <number of models>, cwd: <exact cwd string>, entries: <number of items returned by workspace_files>, and loop: local minimal agent loop completed.",
    description: "Validated multi-tool benchmark that explicitly exercises the local minimal agent loop.",
    validate: validateLocalAgentLoopInspection,
  },
];

export function getBenchmarkCase(id) {
  return benchmarkCases.find((entry) => entry.id === id) || null;
}
