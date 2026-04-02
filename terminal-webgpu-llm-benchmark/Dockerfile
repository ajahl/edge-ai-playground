FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN corepack enable && pnpm install

COPY . .

ENV NODE_ENV=production
ENV TERMINAL_WEBGPU_LLM_API_URL=http://terminal-webgpu-llm:5179

CMD ["node", "cli.mjs"]
