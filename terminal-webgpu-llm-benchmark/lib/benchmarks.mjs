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
];

export function getBenchmarkCase(id) {
  return benchmarkCases.find((entry) => entry.id === id) || null;
}
