import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectDir = path.resolve(__dirname, "..");

export const cliArgs = process.argv.slice(2);
export const startupModelArg = cliArgs.find((arg) => arg && !arg.startsWith("--")) || null;

export const host = process.env.HOST || "127.0.0.1";
export const apiPort = Number(process.env.API_PORT || 8012);
export const llamaPort = Number(process.env.LLAMA_PORT || 8013);
export const llamaServerBin = process.env.LLAMA_SERVER_BIN || "llama-server";
export const hfToken = process.env.HF_TOKEN || "";
export const modelsDir = path.resolve(process.env.MODELS_DIR || path.join(projectDir, ".models"));
export const nGpuLayers = process.env.N_GPU_LAYERS || "99";
export const ctxSize = process.env.CTX_SIZE || "4096";

export const startupModel = startupModelArg?.trim() || process.env.MODEL?.trim() || null;

export const builtInRepos = [
  "bartowski/Llama-3.2-3B-Instruct-GGUF",
  "bartowski/Qwen2.5-Coder-3B-Instruct-GGUF",
  "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF",
  "bartowski/Mistral-7B-Instruct-v0.3-GGUF",
  "bartowski/gemma-2-2b-it-GGUF",
  "unsloth/gemma-4-E2B-it-GGUF",
  "unsloth/gemma-4-E4B-it-GGUF",
  "unsloth/gemma-4-26B-A4B-it-GGUF",
  "YTan2000/Qwen3.5-27B-TQ3_4S",
];

export const defaultModel = startupModel || builtInRepos[0];
