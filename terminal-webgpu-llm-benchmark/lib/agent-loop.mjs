import { describeTools, runToolCall } from "./tools.mjs";

const SYSTEM_PROMPT = `You simulate an agentic AI loop.

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

export const COMPACT_SYSTEM_PROMPT = `Return JSON only. Use one object:
{"type":"tool","tool":"name","input":{},"reason":"why"}
{"type":"final","answer":"answer","reasoning":"why"}
Rules: one object only; no markdown; use listed tools only; after tool results, continue or final.
Tools are below.`;

function formatToolDescriptions(toolDescriptions, mode) {
  if (mode === "names") {
    return `Tool names: ${toolDescriptions.map((tool) => tool.name).join(", ")}`;
  }
  return `Tools:\n${JSON.stringify(toolDescriptions, null, 2)}`;
}

function extractText(completion) {
  return (
    completion?.choices?.[0]?.message?.content ||
    completion?.choices?.[0]?.text ||
    ""
  );
}

function stripMarkdownJsonFence(text) {
  return String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseDecision(text) {
  return normalizeDecision(JSON.parse(stripMarkdownJsonFence(text)));
}

function buildJsonRepairPrompt(raw, toolNames) {
  return `Your previous reply was not valid for the required agent protocol.

Convert the previous reply into exactly one JSON object using one of these shapes:
{"type":"final","answer":"final answer to the user","reasoning":"short summary"}
{"type":"tool","tool":"tool_name","input":{},"reason":"short reason"}

Rules:
- Return JSON only.
- The JSON object must include a "type" field.
- Do not wrap it in markdown fences.
- Preserve the useful answer from the previous reply in the "answer" field.
- If the previous reply attempted to call a tool, return the correct single "tool" object.
- If the previous reply gave a final answer, return a "final" object.
- Allowed tool names are: ${toolNames.join(", ")}.

Previous reply:
${raw}`;
}

function isProtocolDecision(decision, toolNames) {
  if (decision?.type === "final") {
    return true;
  }
  if (decision?.type === "tool" && typeof decision.tool === "string" && toolNames.includes(decision.tool)) {
    return true;
  }
  return false;
}

function normalizeDecision(decision) {
  if (!decision || typeof decision !== "object") {
    return decision;
  }

  if (!decision.type && Array.isArray(decision.tool) && decision.tool[0]?.name) {
    return {
      type: "tool",
      tool: decision.tool[0].name,
      input: {},
      reason: decision.reasoning || decision.reason || "model selected a tool",
    };
  }

  if (decision.type === "tool" && !decision.tool && typeof decision.tool_name === "string") {
    return {
      ...decision,
      tool: decision.tool_name,
      input:
        decision.input && typeof decision.input === "object"
          ? decision.input
          : {},
    };
  }

  return decision;
}

async function requestDecision({ api, messages, step, logger, trace, maxJsonRetries, toolNames, generationConfig }) {
  let retries = 0;
  let lastRaw = "";
  let activeMessages = messages;

  while (retries <= maxJsonRetries) {
    logger.log(`messages sent at step ${step}${retries > 0 ? ` retry ${retries}` : ""}:`);
    logger.log(JSON.stringify(activeMessages, null, 2));
    const completion = await api.chat(activeMessages, generationConfig);
    const raw = extractText(completion);
    lastRaw = raw;
    trace.rawReplies.push({ step, retry: retries, raw });
    logger.log(`raw model reply at step ${step}${retries > 0 ? ` retry ${retries}` : ""}:`);
    logger.log(raw);

    try {
      const decision = parseDecision(raw);
      if (isProtocolDecision(decision, toolNames)) {
        return {
          decision,
          raw,
        };
      }

      throw new Error(`Parsed JSON did not match protocol: ${JSON.stringify(decision)}`);
    } catch (error) {
      if (retries >= maxJsonRetries) {
        throw new Error(`Model returned invalid agent protocol after ${retries + 1} attempt(s): ${lastRaw}`);
      }

      logger.log(`invalid agent protocol at step ${step}; requesting isolated protocol repair`);
      activeMessages = [
        {
          role: "system",
          content: "You repair malformed agent-loop replies. Return exactly one JSON object and no other text.",
        },
        {
          role: "user",
          content: buildJsonRepairPrompt(raw, toolNames),
        },
      ];
      retries += 1;
    }
  }

  throw new Error(`Model returned invalid JSON: ${lastRaw}`);
}

async function runFallbackToolPlan({ api, trace, logger, fallbackToolPlan, startedAt }) {
  const toolResults = {};

  for (let index = 0; index < fallbackToolPlan.tools.length; index += 1) {
    const tool = fallbackToolPlan.tools[index];
    const step = index + 1;
    logger.log(`fallback tool ${step}: ${tool}`);
    const result = await runToolCall({ type: "tool", tool, input: {} }, { api });
    toolResults[tool] = result;
    trace.toolCalls.push({
      step,
      tool,
      input: {},
      result,
      fallback: true,
    });
  }

  const answer = fallbackToolPlan.buildAnswer(toolResults);
  return {
    type: "final",
    step: fallbackToolPlan.tools.length,
    answer,
    reasoning: fallbackToolPlan.reasoning || "used deterministic fallback after invalid model protocol",
    elapsedMs: Date.now() - startedAt,
    trace,
  };
}

export async function runAgentLoop({
  api,
  userPrompt,
  maxSteps = 5,
  maxJsonRetries = 1,
  systemPrompt = SYSTEM_PROMPT,
  toolDescriptionMode = "json",
  generationConfig = {},
  fallbackToolPlan = null,
  logger = console,
}) {
  const startedAt = Date.now();
  const toolDescriptions = describeTools();
  const toolNames = toolDescriptions.map((tool) => tool.name);
  const trace = {
    rawReplies: [],
    toolCalls: [],
  };
  const messages = [
    {
      role: "system",
      content: `${systemPrompt}\n\n${formatToolDescriptions(toolDescriptions, toolDescriptionMode)}`,
    },
    {
      role: "user",
      content: userPrompt,
    },
  ];

  for (let step = 1; step <= maxSteps; step += 1) {
    logger.log(`step ${step}: thinking`);
    let decision;
    let raw;
    try {
      const result = await requestDecision({
        api,
        messages,
        step,
        logger,
        trace,
        maxJsonRetries,
        toolNames,
        generationConfig,
      });
      decision = result.decision;
      raw = result.raw;
    } catch (error) {
      if (fallbackToolPlan && step === 1) {
        logger.log(`falling back after invalid model protocol: ${error.message}`);
        return runFallbackToolPlan({ api, trace, logger, fallbackToolPlan, startedAt });
      }
      throw error;
    }

    if (decision?.type === "final") {
      return {
        type: "final",
        step,
        answer: decision.answer || "",
        reasoning: decision.reasoning || "",
        elapsedMs: Date.now() - startedAt,
        trace,
      };
    }

    if (decision?.type !== "tool") {
      throw new Error(`Unexpected decision type: ${decision?.type || "missing"}`);
    }

    logger.log(`step ${step}: tool ${decision.tool}`);
    const toolResult = await runToolCall(decision, { api });
    trace.toolCalls.push({
      step,
      tool: decision.tool,
      input: decision.input || {},
      result: toolResult,
    });
    logger.log(`tool result at step ${step}:`);
    logger.log(JSON.stringify(toolResult, null, 2));
    messages.push({
      role: "assistant",
      content: raw,
    });
    messages.push({
      role: "user",
      content: `Tool result for ${decision.tool}:\n${JSON.stringify(toolResult, null, 2)}`,
    });
  }

  throw new Error(`Agent loop exceeded max steps (${maxSteps}).`);
}
