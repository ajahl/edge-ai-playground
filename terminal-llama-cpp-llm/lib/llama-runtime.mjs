import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { ctxSize, host, llamaPort, llamaServerBin, nGpuLayers } from "./config.mjs";

let currentServer = null;
let currentModelPath = null;
let currentModelLabel = null;

async function assertExecutable(bin) {
  if (bin.includes("/") || bin.startsWith(".")) {
    await access(bin, constants.X_OK);
  }
}

export function getRuntimeSnapshot() {
  return {
    pid: currentServer?.pid || null,
    modelPath: currentModelPath,
    modelLabel: currentModelLabel,
    url: `http://${host}:${llamaPort}`,
  };
}

export async function stopServer() {
  if (!currentServer) {
    return;
  }

  const server = currentServer;
  currentServer = null;
  currentModelPath = null;
  currentModelLabel = null;

  await new Promise((resolve) => {
    server.once("exit", () => resolve());
    server.kill("SIGTERM");
    setTimeout(() => {
      try {
        server.kill("SIGKILL");
      } catch {
        resolve();
      }
    }, 2500).unref();
  });
}

export async function startServer(modelPath, onLog, modelLabel = null) {
  await assertExecutable(llamaServerBin);
  await stopServer();

  const args = [
    "--host",
    host,
    "--port",
    String(llamaPort),
    "--model",
    modelPath,
    "--alias",
    modelLabel || modelPath,
    "--jinja",
    "--ctx-size",
    String(ctxSize),
    "--n-gpu-layers",
    String(nGpuLayers),
  ];

  const child = spawn(llamaServerBin, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  currentServer = child;
  currentModelPath = modelPath;
  currentModelLabel = modelLabel || modelPath;

  child.stdout.on("data", (chunk) => onLog?.(`stdout ${String(chunk).trim()}`));
  child.stderr.on("data", (chunk) => onLog?.(`stderr ${String(chunk).trim()}`));
  child.on("exit", (code, signal) => {
    onLog?.(`llama-server exited code=${code} signal=${signal}`);
    if (currentServer === child) {
      currentServer = null;
      currentModelPath = null;
      currentModelLabel = null;
    }
  });

  await waitForServerReady();
  return getRuntimeSnapshot();
}

export async function waitForServerReady(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "server not started";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${host}:${llamaPort}/health`);
      if (response.ok) {
        return true;
      }
      lastError = `health HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`llama-server did not become ready: ${lastError}`);
}

export async function createChatCompletion(payload) {
  const requestPayload = { ...payload };
  if (!requestPayload.model) {
    delete requestPayload.model;
  }

  const response = await fetch(`http://${host}:${llamaPort}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(requestPayload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`chat completion failed: HTTP ${response.status} ${text}`.trim());
  }

  return response.json();
}
