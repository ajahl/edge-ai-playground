import { execFile } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";

const execFileAsync = promisify(execFile);

async function runCommand(command, args = []) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    maxBuffer: 1024 * 1024,
  });
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

export const tools = {
  list_models: {
    description: "List the models currently available from the terminal-webgpu-llm API.",
    inputSchema: {},
    async run(_input, context) {
      const result = await context.api.models();
      return result?.data?.map((entry) => entry.id) || [];
    },
  },
  current_time: {
    description: "Return the current local time on this machine.",
    inputSchema: {},
    async run() {
      const { stdout } = await runCommand("date");
      return stdout;
    },
  },
  echo: {
    description: "Echo back text exactly. Useful for verifying arguments in the loop.",
    inputSchema: {
      text: "string",
    },
    async run(input) {
      return String(input?.text || "");
    },
  },
  workspace_cwd: {
    description: "Return the current working directory for this benchmark process.",
    inputSchema: {},
    async run() {
      return process.cwd();
    },
  },
  workspace_files: {
    description: "List files and directories in the current working directory.",
    inputSchema: {},
    async run() {
      const { stdout } = await runCommand("ls", ["-1"]);
      return stdout ? stdout.split("\n").filter(Boolean) : [];
    },
  },
};

export function describeTools() {
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export async function runToolCall(call, context) {
  const tool = tools[call?.tool];
  if (!tool) {
    throw new Error(`Unknown tool: ${call?.tool || "missing"}`);
  }
  return tool.run(call.input || {}, context);
}
