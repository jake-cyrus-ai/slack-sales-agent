FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY src ./src
COPY server ./server

RUN pnpm run build && pnpm run build:server
RUN pnpm prune --prod

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=3001
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/start.mjs ./server/start.mjs

USER node
EXPOSE 3001
CMD ["node", "server/start.mjs"]
