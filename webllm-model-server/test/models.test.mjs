import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const repoDir = path.resolve(import.meta.dirname, "..");
let child;
let baseUrl;

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForServer(url) {
  const deadline = Date.now() + 5000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw lastError || new Error("server did not become ready");
}

before(async () => {
  const modelsRoot = mkdtempSync(path.join(tmpdir(), "webllm-models-"));
  const modelId = "fixture-qwen-q4f16_1-MLC";
  const packageDir = path.join(modelsRoot, modelId, "package");
  mkdirSync(path.join(packageDir, "libs"), { recursive: true });

  writeFileSync(
    path.join(modelsRoot, "index.json"),
    JSON.stringify(
      {
        models: [
          {
            id: modelId,
            rootDir: modelId,
            packageDir: "package",
            config: "package/mlc-chat-config.json",
            libs: [`package/libs/${modelId}-webgpu.wasm`],
            model_type: "qwen2",
            buffer_size_required_bytes: 1234,
            runtime_supported: true,
            runtime_support_notes: null,
          },
          {
            id: "fixture-gemma-q4f16_1-MLC",
            rootDir: "fixture-gemma-q4f16_1-MLC",
            packageDir: "package",
            config: "package/mlc-chat-config.json",
            libs: [],
            model_type: "gemma4",
            runtime_supported: false,
            runtime_support_notes: "unsupported fixture",
          },
        ],
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(packageDir, "mlc-chat-config.json"), JSON.stringify({ model_id: modelId }));
  writeFileSync(path.join(packageDir, "libs", `${modelId}-webgpu.wasm`), "");

  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: repoDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      MODELS_ROOT: modelsRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await waitForServer(baseUrl);
});

after(() => {
  child?.kill();
});

test("GET /health does not include the model list", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, "mlc-models");
  assert.equal("models" in body, false);
});

test("GET /models exposes runtime support metadata", async () => {
  const response = await fetch(`${baseUrl}/models`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.models.length, 2);

  const qwen = body.models.find((model) => model.id === "fixture-qwen-q4f16_1-MLC");
  assert.equal(qwen.model_type, "qwen2");
  assert.equal(qwen.buffer_size_required_bytes, 1234);
  assert.equal(qwen.runtime_supported, true);
  assert.equal(qwen.runtime_support_notes, null);
  assert.match(qwen.config, /^\/models\/fixture-qwen-q4f16_1-MLC\/mlc-chat-config\.json\?v=\d+$/);
  assert.match(qwen.libs[0].url, /^\/models\/fixture-qwen-q4f16_1-MLC\/libs\/fixture-qwen-q4f16_1-MLC-webgpu\.wasm\?v=\d+$/);

  const gemma = body.models.find((model) => model.id === "fixture-gemma-q4f16_1-MLC");
  assert.equal(gemma.model_type, "gemma4");
  assert.equal(gemma.runtime_supported, false);
  assert.equal(gemma.runtime_support_notes, "unsupported fixture");
});
