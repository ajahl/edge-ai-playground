# Firefox WebGPU LLM Extension

This subproject packages a Firefox sidebar extension that runs WebLLM locally inside the extension UI.

## What It Does

- opens as a docked Firefox sidebar from the toolbar button
- loads a WebLLM model directly in the sidebar
- streams chat responses into the sidebar conversation view
- shows a progress bar while the model loads
- shows current WebLLM storage usage for this extension context
- clears cached WebLLM storage with `Clear Model Storage`
- uses Firefox/system colors so the UI follows the active browser theme more closely

## Sidebar And Theme Notes

- The extension uses Firefox's sidebar UI, not a popup.
- Firefox controls whether the sidebar appears on the left or right.
- The extension can open the sidebar, but it cannot force Firefox to dock it on the right side programmatically.
- Styling uses Firefox/system colors, so it tracks the current browser theme more naturally than a custom fixed palette.

## What `Clear Model Storage` Removes

The clean button is intentionally broad for this extension context. It:

- unloads the currently loaded model if needed
- removes selected-model cache metadata through WebLLM
- deletes WebLLM Cache Storage entries used by the extension
- deletes WebLLM IndexedDB databases used by the extension
- deletes `localStorage` keys containing `webllm` in the extension origin

This clears WebLLM data used by this Firefox extension itself. It does not clear data from other websites, other extensions, or other Firefox profiles.

## Run

```bash
cd firefox-webgpu-llm-extension
pnpm install
pnpm build
```

Parcel writes the unpacked extension to `dist/`.

In Firefox:

1. Open `about:debugging`.
2. Choose `This Firefox`.
3. Select `Load Temporary Add-on`.
4. Pick `dist/manifest.json`.
5. Click the extension toolbar button to open the sidebar.

## Notes

- The model is unloaded when the sidebar closes.
- The first load can take a while because model weights are fetched and initialized.
- Firefox needs WebGPU enabled for the selected runtime.
- The built sidebar bundle is still large because WebLLM ships substantial browser-side runtime code.
