import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@mlc-ai/web-runtime": resolve(
        __dirname,
        "../web-llm/node_modules/@mlc-ai/web-runtime/lib/index.js",
      ),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5177,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
      },
    },
  },
});
