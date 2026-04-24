import { describeTools } from "./lib/tools.mjs";

const apiUrl = (process.env.TERMINAL_WEBGPU_LLM_API_URL || "http://127.0.0.1:5179").replace(/\/$/, "");
const model =
  process.env.MODEL || "local-webllm-model-server::gemma-4-E2B-it-q4f16_1-MLC";

const AGENT_SYSTEM_PROMPT = `You simulate an agentic AI loop.

// You must respond with JSON only, no \`\`\`json, using exactly one of these shapes:

{"type":"tool","tool":"tool_name","input":{...},"reason":"short reason"}
{"type":"final","answer":"final answer to the user","reasoning":"short summary"}

Rules:
- This is a strict single-step protocol.
- Return exactly one JSON object per reply.
- Never return multiple JSON objects in one reply.
- Never wrap the JSON in markdown fences.
- Never add commentary before or after the JSON object.
- Execute only one step per reply.
- If you need a tool, return only a single {"type":"tool",...} object.
- After you receive a tool result, decide the next single step and return one JSON object.
- Only return {"type":"final",...} when you are completely done.
- Do not plan multiple future steps in one reply.
- Do not include a second tool call in the same reply.
- Do not include both a tool call and a final answer in the same reply.
- Your reply must begin with "{" and end with "}".
- Stop immediately after the closing "}" of the single JSON object.
- If you are unsure, return one tool object rather than multiple objects.
- Invalid example: {"type":"tool","tool":"list_models","input":{},"reason":"..."}{"type":"tool","tool":"current_time","input":{},"reason":"..."}
- Valid example: {"type":"tool","tool":"list_models","input":{},"reason":"need available models first"}
- Valid example: {"type":"final","answer":"model_count: 47\ntime_observed: Tue Apr 1 12:00:00 CEST 2026","reasoning":"used the required observed values"}
- Use tools only when they materially help.
- Never invent tool results.
- Keep reasoning concise.
- If the user asks for something you can answer directly, return type=final.
- Available tools are provided below.`;

const benchmarkUserPrompt =
  "Use tools to get the available models and the current local time. Then return a final answer with exactly these lines: model_count: <count> and time_observed: <exact time string>.";

const agentSystemWithTools = `${AGENT_SYSTEM_PROMPT}\n\nTools:\n${JSON.stringify(
  describeTools(),
  null,
  2
)}`;
const toolsOnlySystem = `Tools:\n${JSON.stringify(describeTools(), null, 2)}`;
const minifiedToolsSystem = `Tools:\n${JSON.stringify(describeTools())}`;
const plainToolNamesSystem = `Tools: ${describeTools().map((tool) => tool.name).join(", ")}`;
const repeatedSystem = (targetLength) =>
  "Return one short answer. ".repeat(Math.ceil(targetLength / 25)).slice(0, targetLength);
const padToAgentToolsLength = (prefix, suffix = "") => {
  const targetLength = agentSystemWithTools.length;
  const fillerLength = Math.max(0, targetLength - prefix.length - suffix.length);
  return `${prefix}${repeatedSystem(fillerLength)}${suffix}`;
};
const padToLength = (prefix, targetLength) => {
  const fillerLength = Math.max(0, targetLength - prefix.length);
  return `${prefix}${repeatedSystem(fillerLength)}`;
};

const probes = [
  {
    name: "one_user_exact_hello",
    max_tokens: 64,
    messages: [{ role: "user", content: "Reply with exactly: hello" }],
  },
  {
    name: "one_user_direct_hello",
    max_tokens: 128,
    messages: [{ role: "user", content: "Say hello in one short sentence." }],
  },
  {
    name: "short_system_direct_hello",
    max_tokens: 128,
    messages: [
      { role: "system", content: "Return a short friendly answer." },
      { role: "user", content: "Say hello in one short sentence." },
    ],
  },
  {
    name: "short_system_benchmark_user",
    max_tokens: 128,
    messages: [
      { role: "system", content: "Return a short answer." },
      { role: "user", content: benchmarkUserPrompt },
    ],
  },
  {
    name: "repeated_system_512_direct_hello",
    max_tokens: 128,
    messages: [
      { role: "system", content: repeatedSystem(512) },
      { role: "user", content: "Say hello in one short sentence." },
    ],
  },
  {
    name: "repeated_system_1024_direct_hello",
    max_tokens: 128,
    messages: [
      { role: "system", content: repeatedSystem(1024) },
      { role: "user", content: "Say hello in one short sentence." },
    ],
  },
  {
    name: "repeated_system_1536_direct_hello",
    max_tokens: 128,
    messages: [
      { role: "system", content: repeatedSystem(1536) },
      { role: "user", content: "Say hello in one short sentence." },
    ],
  },
  {
    name: "repeated_system_2048_direct_hello",
    max_tokens: 128,
    messages: [
      { role: "system", content: repeatedSystem(2048) },
      { role: "user", content: "Say hello in one short sentence." },
    ],
  },
  {
    name: "repeated_system_2511_direct_hello",
    max_tokens: 128,
    messages: [
      { role: "system", content: repeatedSystem(2511) },
      { role: "user", content: "Say hello in one short sentence." },
    ],
  },
  {
    name: "tools_only_system_direct_hello",
    max_tokens: 128,
    messages: [
      { role: "system", content: toolsOnlySystem },
      { role: "user", content: "Say hello in one short sentence." },
    ],
  },
  {
    name: "agent_system_without_tools_direct_hello",
    max_tokens: 128,
    messages: [
      { role: "system", content: AGENT_SYSTEM_PROMPT },
      { role: "user", content: "Say hello in one short sentence." },
    ],
  },
  {
    name: "agent_system_padded_1900_direct_hello",
    max_tokens: 128,
    messages: [
      { role: "system", content: padToLength(AGENT_SYSTEM_PROMPT, 1900) },
      { role: "user", content: "Say hello in one short sentence." },
    ],
  },
  {
    name: "agent_system_padded_1984_direct_hello",
    max_tokens: 128,
    messages: [
      { role: "system", content: padToLength(AGENT_SYSTEM_PROMPT, 1984) },
      { role: "user", content: "Say hello in one short sentence." },
    ],
  },
  {
    name: "agent_system_padded_2016_direct_hello",
    max_tokens: 128,
    messages: [
      { role: "system", content: padToLength(AGENT_SYSTEM_PROMPT, 2016) },
      { role: "user", content: "Say hello in one short sentence." },
    ],
  },
  {
    name: "agent_system_padded_2032_direct_hello",
    max_tokens: 128,
    messages: [
      { role: "system", content: padToLength(AGENT_SYSTEM_PROMPT, 2032) },
      { role: "user", content: "Say hello in one short sentence." },
    ],
  },
  {
    name: "agent_system_padded_2048_direct_hello",
    max_tokens: 128,
    messages: [
      { role: "system", content: padToLength(AGENT_SYSTEM_PROMPT, 2048) },
      { role: "user", content: "Say hello in one short sentence." },
    ],
  },
  {
    name: "agent_system_padded_2300_direct_hello",
    max_tokens: 128,
    messages: [
      { role: "system", content: padToLength(AGENT_SYSTEM_PROMPT, 2300) },
      { role: "user", content: "Say hello in one short sentence." },
    ],
  },
  {
    name: "agent_system_padded_to_full_length_direct_hello",
    max_tokens: 128,
    messages: [
      { role: "system", content: padToAgentToolsLength(AGENT_SYSTEM_PROMPT) },
      { role: "user", content: "Say hello in one short sentence." },
    ],
  },
  {
    name: "repeated_prefix_plus_tools_to_full_length_direct_hello",
    max_tokens: 128,
    messages: [
      { role: "system", content: padToAgentToolsLength("", toolsOnlySystem) },
      { role: "user", content: "Say hello in one short sentence." },
    ],
  },
  {
    name: "agent_plus_plain_tool_names_direct_hello",
    max_tokens: 128,
    messages: [
      { role: "system", content: `${AGENT_SYSTEM_PROMPT}\n\n${plainToolNamesSystem}` },
      { role: "user", content: "Say hello in one short sentence." },
    ],
  },
  {
    name: "agent_plus_minified_tools_direct_hello",
    max_tokens: 128,
    messages: [
      { role: "system", content: `${AGENT_SYSTEM_PROMPT}\n\n${minifiedToolsSystem}` },
      { role: "user", content: "Say hello in one short sentence." },
    ],
  },
  {
    name: "agent_system_direct_hello",
    max_tokens: 128,
    messages: [
      { role: "system", content: agentSystemWithTools },
      { role: "user", content: "Say hello in one short sentence." },
    ],
  },
  {
    name: "agent_system_benchmark_user",
    max_tokens: 128,
    messages: [
      { role: "system", content: agentSystemWithTools },
      { role: "user", content: benchmarkUserPrompt },
    ],
  },
];

async function request(path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, options);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload?.error?.message || payload?.error || `HTTP ${response.status}`);
  }
  return payload;
}

function contentFrom(completion) {
  return completion?.choices?.[0]?.message?.content || completion?.choices?.[0]?.text || "";
}

console.log(`api: ${apiUrl}`);
console.log(`model: ${model}`);
const probeFilter = process.env.PROBE_FILTER || "";
if (probeFilter) {
  console.log(`probe filter: ${probeFilter}`);
}

const health = await request("/health");
console.log(`health: ok | loaded: ${health.loaded ? "yes" : "no"}`);

await request("/v1/load", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model }),
});
console.log("load: ok");

const selectedProbes = probeFilter
  ? probes.filter((probe) => probe.name.includes(probeFilter))
  : probes;

if (selectedProbes.length === 0) {
  throw new Error(`No probes matched PROBE_FILTER=${probeFilter}`);
}

for (const probe of selectedProbes) {
  console.log(`\n=== ${probe.name} ===`);
  console.log(
    `messages: ${probe.messages.map((message) => `${message.role}[${message.content.length}]`).join(", ")}`
  );

  const startedAt = Date.now();
  try {
    const completion = await request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: probe.messages,
        temperature: 0,
        max_tokens: probe.max_tokens,
      }),
    });
    const content = contentFrom(completion);
    const finishReason = completion?.choices?.[0]?.finish_reason || "";
    console.log(`ok: ${Date.now() - startedAt}ms | finish_reason=${finishReason}`);
    console.log(`content: ${JSON.stringify(content)}`);
  } catch (error) {
    console.log(`error: ${Date.now() - startedAt}ms`);
    console.log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    break;
  }
}
