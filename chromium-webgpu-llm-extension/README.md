# Chromium WebGPU LLM Extension

This subproject packages a Chromium-family extension that runs WebLLM in a browser side panel.

It mirrors the user-facing behavior of `../firefox-webgpu-llm-extension`, but adapts the extension runtime to Chromium-family browsers such as Chrome and Chromium:

- the UI lives in a `side_panel`
- a MV3 service worker manages side panel behavior and active-tab page reads
- an offscreen document hosts the WebLLM engine so the model can stay loaded even when the side panel is closed

## What It Does

- opens from the browser toolbar into the side panel
- loads a WebLLM model directly in the extension
- keeps the model warm in an offscreen document while the side panel is closed
- streams chat responses into the side panel conversation view
- shows a progress bar while the model loads
- shows current WebLLM storage usage for this extension context
- supports `Use Current Page` to attach active-tab text to the next prompt
- supports `Clear Model Storage` for the extension's WebLLM cache and databases

## Run

```bash
cd chromium-webgpu-llm-extension
pnpm install
pnpm build
```

Parcel writes the unpacked extension to `dist/`.

In Chrome:

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Choose `Load unpacked`.
4. Select the generated `dist/` directory.
5. Click the extension action to open the side panel.

In Chromium:

1. Open `chrome://extensions`.
2. Enable developer mode if it is not already enabled.
3. Choose `Load unpacked`.
4. Select the generated `dist/` directory.
5. Click the extension action to open the side panel.

## Notes

- The heavy WebLLM runtime is hosted in the offscreen document bundle, not the side panel itself.
- The first model load can take a while because model weights are fetched and initialized.
- Chromium-family browser builds need WebGPU enabled and available on the machine.
