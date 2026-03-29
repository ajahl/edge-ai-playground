# WebGPU LLM Service

This example provides a minimal browser-hosted WebGPU LLM service:

- a small local server serves the page
- the page runs WebLLM in your browser with WebGPU
- a service worker exposes same-origin OpenAI-style routes
- browser code can call `/v1/chat/completions` directly

## What It Provides

The page and API live on the same origin, for example `http://127.0.0.1:4173`, with:

- `GET /health`
- `GET /v1/models`
- `POST /v1/load`
- `POST /v1/chat/completions`
- `POST /v1/url-context`

`POST /v1/chat/completions` supports:

- non-streaming JSON responses
- streaming SSE responses when `stream: true`

`POST /v1/url-context` lets the local Node server fetch a public web page, extract readable text, and return it so the UI can attach that page as context for the next prompt.

## Requirements

- Node.js and `pnpm`
- a browser with WebGPU support
- service worker support

## Architecture

This project remains browser-hosted even when you run it in Docker:

- the container only serves the built web app
- the browser page still runs WebLLM, WASM, and WebGPU
- the service worker still exposes same-origin `/v1/...` routes
- the API only works while a real browser page is open on that origin

## Run In Dev

```bash
cd webgpu-llm-web-server
pnpm install
pnpm dev
```

Then open `http://127.0.0.1:4173` in your browser.

## Run As A Tiny Server

```bash
pnpm build
pnpm start
```

This serves the built page on `http://127.0.0.1:4173`.

## Run In Docker

Build the browser-hosted container:

```bash
docker build -t webgpu-llm-web-server .
```

Run it with the same port exposed:

```bash
docker run --rm -p 4173:4173 webgpu-llm-web-server
```

Then open `http://127.0.0.1:4173` in a WebGPU-capable browser.

This Docker mode is side-by-side with the existing local Node flow, not a new backend architecture. The container serves the app, but the model still runs in the browser that opens the page.

## Calling It From Outside

You can expose the page URL from Docker and access it remotely through your normal host or reverse proxy setup, but the WebLLM API is still browser-scoped:

- remote users can open the page and use the same-origin `/v1/...` routes from that browser session
- external tools such as `curl` do not get a standalone model server from this setup
- if you need a true externally callable API, use the Chromium or Electron bridge variant instead

## Example Browser Request

```js
const response = await fetch("/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC",
    messages: [
      { role: "user", content: "Write a short haiku about local AI." }
    ]
  }),
});

const data = await response.json();
console.log(data);
```

Warm a model first if you want:

```js
await fetch("/v1/load", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC",
  }),
});
```

Attach a public URL as prompt context through the local server:

```js
const response = await fetch("/v1/url-context", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    url: "https://example.com/article",
  }),
});

const data = await response.json();
console.log(data.title, data.url, data.content);
```

## Project Structure

- `server.mjs`: tiny static server for the built page
- `index.html`: minimal UI for status and test requests
- `src/main.ts`: hosts the WebLLM engine in the page and handles requests
- `sw.ts`: implements the same-origin REST endpoints and forwards requests to the page
- `src/index.ts`: shared constants such as route paths and available models

## URL Context Notes

- URL attachment uses the local Node server, not direct browser fetches.
- This avoids most browser-side CORS issues for public pages.
- The fetched page is reduced to plain readable text before being attached.
- The attached page is sent into the next chat request as a `system` context message.
- This route is available when you run the built app with `pnpm start` or in Docker.

## Notes

- The model lives in the browser, not in Node.
- The model stays loaded while the page stays open.
- This is intended for browser callers on the same origin.
- Docker here changes deployment, not the inference runtime.
- If you need a machine-wide localhost API for `curl`, use the Electron or Chrome bridge examples instead.
