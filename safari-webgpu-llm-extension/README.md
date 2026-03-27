# Safari WebGPU LLM Extension

This subproject is a Safari-targeted extension based on the current browser-extension code in this workspace.

It exists so the repo has a dedicated Safari starting point, but it is not yet a fully packaged Safari app extension. Apple’s current Safari Web Extension flow requires Safari/Xcode tooling to convert or package the extension for Safari, and that tooling is not installed in this environment.

## Current State

- uses a Safari-friendly popup plus persistent background-page runtime shape
- keeps the same WebLLM chat UI, current-page attach flow, storage reporting, and storage cleanup behavior
- is intended to become a Safari Web Extension package after Apple-specific conversion and testing

## What Still Needs Apple Tooling

- convert or package the extension with Safari/Xcode tooling
- verify which Safari extension APIs work for this project shape on the target Safari version
- run the extension inside Safari and validate WebGPU and model-loading behavior there

## Run The Source Build

```bash
cd safari-webgpu-llm-extension
pnpm install
pnpm build
```

Parcel writes a browser-extension bundle to `dist/`, which is useful as source output, but Safari packaging still needs Apple tooling afterwards.

## Notes

- Apple’s Safari Web Extension docs: https://developer.apple.com/documentation/safariservices/safari_web_extensions/developing_a_safari_web_extension
- On this machine, `xcodebuild` and `safari-web-extension-converter` are currently unavailable, so the Safari-specific packaging step could not be completed here.
