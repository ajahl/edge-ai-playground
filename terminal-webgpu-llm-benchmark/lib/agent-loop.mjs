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

function extractText(completion) {
  return (
    completion?.choices?.[0]?.message?.content ||
    completion?.choices?.[0]?.text ||
    ""
  );
}

function parseDecision(text) {
  return JSON.parse(String(text || "").trim());
}

export async function runAgentLoop({
  api,
  userPrompt,
  maxSteps = 5,
  logger = console,
}) {
  const startedAt = Date.now();
  const toolDescriptions = describeTools();
  const trace = {
    rawReplies: [],
    toolCalls: [],
  };
  const messages = [
    {
      role: "system",
      content: `${SYSTEM_PROMPT}\n\nTools:\n${JSON.stringify(toolDescriptions, null, 2)}`,
    },
    {
      role: "user",
      content: userPrompt,
    },
  ];

  for (let step = 1; step <= maxSteps; step += 1) {
    logger.log(`step ${step}: thinking`);
    logger.log(`messages sent at step ${step}:`);
    logger.log(JSON.stringify(messages, null, 2));
    const completion = await api.chat(messages);
    const raw = extractText(completion);
    trace.rawReplies.push({ step, raw });
    logger.log(`raw model reply at step ${step}:`);
    logger.log(raw);

    let decision;
    try {
      decision = parseDecision(raw);
    } catch {
        const cleaned = raw.replace(/```json\n?|\n?```/g, '');
        try { 
          decision = parseDecision(cleaned);
        } catch {
          throw new Error(`Model returned invalid JSON: ${raw}`);
        }
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
