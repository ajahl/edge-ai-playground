FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY index.html server.mjs sw.ts vite.config.ts ./
COPY src ./src

RUN pnpm build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV HOST=0.0.0.0
ENV PORT=4173

COPY --from=build /app/package.json ./
COPY --from=build /app/server.mjs ./
COPY --from=build /app/dist ./dist

EXPOSE 4173

CMD ["node", "server.mjs"]
