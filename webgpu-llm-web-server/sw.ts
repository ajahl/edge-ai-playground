import {
  AVAILABLE_MODELS,
  DEFAULT_MODEL,
  LOAD_API_PATH,
  MODELS_API_PATH,
  OPENAI_API_PATH,
} from "./src/index";

const pendingRequests = new Map();
let loadedModel = DEFAULT_MODEL;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  };
}

function nextRequestId() {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function getRendererClient() {
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });

  const visibleClient = clients.find((client) => client.visibilityState === "visible");
  return visibleClient || clients[0] || null;
}

function isChatCompletionRequest(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const request = value as Record<string, unknown>;
  return Array.isArray(request.messages);
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") {
    return;
  }

  if (data.type === "webllm-keepalive") {
    event.source?.postMessage({
      type: "webllm-keepalive-ack",
      model: loadedModel,
    });
    return;
  }

  if (data.type === "webllm-progress" || data.type === "webllm-model") {
    if (typeof data.model === "string") {
      loadedModel = data.model;
    }
    return;
  }

  const entry = pendingRequests.get(data.id);
  if (!entry) {
    return;
  }

  if (data.type === "webllm-response") {
    pendingRequests.delete(data.id);
    entry.resolve(data.payload);
    return;
  }

  if (data.type === "webllm-error") {
    pendingRequests.delete(data.id);
    entry.reject(new Error(data.error || "Unknown error"));
    return;
  }

  if (data.type === "webllm-stream-chunk") {
    entry.pushChunk(data.chunk);
    return;
  }

  if (data.type === "webllm-stream-done") {
    pendingRequests.delete(data.id);
    entry.finish();
    return;
  }

  if (data.type === "webllm-stream-error") {
    pendingRequests.delete(data.id);
    entry.fail(data.error || "Unknown error");
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (event.request.method === "GET" && url.pathname === MODELS_API_PATH) {
    event.respondWith(
      json({
        object: "list",
        data: AVAILABLE_MODELS.map((modelId) => ({
          id: modelId,
          object: "model",
          owned_by: "webllm",
        })),
      }),
    );
    return;
  }

  if (event.request.method === "POST" && url.pathname === LOAD_API_PATH) {
    event.respondWith(handleLoadRequest(event.request));
    return;
  }

  if (event.request.method === "POST" && url.pathname === OPENAI_API_PATH) {
    event.respondWith(handleChatCompletion(event.request));
  }
});

async function handleLoadRequest(request: Request) {
  try {
    const payload = await request.json().catch(() => ({}));
    const client = await getRendererClient();
    if (!client) {
      return json(
        {
          error: {
            message: "Open the example page first so it can host the WebLLM engine.",
            type: "server_error",
          },
        },
        503,
      );
    }

    const id = nextRequestId();
    const responsePayload = await new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      client.postMessage({
        type: "webllm-request",
        id,
        kind: "load",
        payload,
      });
    });

    return json(responsePayload);
  } catch (error) {
    return json(
      {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "server_error",
        },
      },
      500,
    );
  }
}

async function handleChatCompletion(request: Request) {
  try {
    const payload = await request.json();
    if (!isChatCompletionRequest(payload)) {
      return json(
        {
          error: {
            message: "Request body must include a messages array.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    const client = await getRendererClient();
    if (!client) {
      return json(
        {
          error: {
            message: "Open the example page first so it can host the WebLLM engine.",
            type: "server_error",
          },
        },
        503,
      );
    }

    if (payload.stream === true) {
      return handleStreamingChatCompletion(client, payload);
    }

    const id = nextRequestId();
    const responsePayload = await new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      client.postMessage({
        type: "webllm-request",
        id,
        kind: "chat",
        payload,
      });
    });

    return json(responsePayload);
  } catch (error) {
    return json(
      {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "server_error",
        },
      },
      500,
    );
  }
}

function handleStreamingChatCompletion(client: Client, payload: unknown) {
  const encoder = new TextEncoder();
  const id = nextRequestId();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      pendingRequests.set(id, {
        pushChunk(chunk: unknown) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        },
        finish() {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
        fail(message: string) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: { message, type: "server_error" } })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      client.postMessage({
        type: "webllm-request",
        id,
        kind: "chat",
        payload,
      });
    },
    cancel() {
      pendingRequests.delete(id);
    },
  });

  return new Response(stream, {
    headers: sseHeaders(),
  });
}
