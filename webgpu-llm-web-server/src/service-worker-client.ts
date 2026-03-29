import { MODELS_API_PATH } from "./index";

export function postToServiceWorker(message: Record<string, unknown>) {
  navigator.serviceWorker.controller?.postMessage(message);
}

async function waitForController() {
  if (navigator.serviceWorker.controller) {
    return;
  }

  await new Promise<void>((resolve) => {
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => resolve(),
      { once: true },
    );
  });
}

export async function registerServiceWorker(
  serviceWorkerUrl: string,
  setAppState: (state: string) => void,
) {
  if (!("serviceWorker" in navigator)) {
    throw new Error("This browser does not support service workers.");
  }

  setAppState("registering");
  await navigator.serviceWorker.register(serviceWorkerUrl, {
    type: "module",
    scope: "/",
  });

  await navigator.serviceWorker.ready;
  await waitForController();
  setAppState("idle");
}

export function startKeepAlive(postMessage: (message: Record<string, unknown>) => void) {
  return window.setInterval(() => {
    postMessage({
      type: "webllm-keepalive",
    });
  }, 10_000);
}

export async function getModels() {
  const response = await fetch(MODELS_API_PATH);
  if (!response.ok) {
    throw new Error(`Model probe failed with ${response.status}`);
  }
  return response.json();
}
