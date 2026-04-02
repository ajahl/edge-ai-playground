import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectDir = path.resolve(__dirname, "..");

export const distDir = path.join(projectDir, "dist");
export const host = process.env.HOST || "127.0.0.1";
export const browserHost = process.env.BROWSER_HOST || (host === "0.0.0.0" ? "127.0.0.1" : host);

export const cliArgs = process.argv.slice(2);
export const exposeRenderer = cliArgs.includes("--expose-renderer");
export const startupModelArg = cliArgs.find((arg) => arg && !arg.startsWith("--")) || null;

export const rendererListenPort = exposeRenderer ? Number(process.env.PORT || 5178) : 0;
export const apiPort = Number(process.env.API_PORT || 5179);

export const builtInModels = [
  "Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC",
  "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC",
  "Llama-3.2-1B-Instruct-q4f16_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
  "Qwen3-8B-q4f16_1-MLC",
  "Ministral-3-3B-Reasoning-2512-q4f16_1-MLC",
  "Llama-3.2-3B-Instruct-q4f16_1-MLC",
  "Llama-3.1-8B-Instruct-q4f16_1-MLC",
];

export const defaultModel = builtInModels[0];
export const startupModel = startupModelArg?.trim() || process.env.MODEL?.trim() || null;

export const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

export const executableNames = [
  "Chromium",
  "chrome",
  "headless_shell",
  "chrome.exe",
  "Google Chrome for Testing",
];
