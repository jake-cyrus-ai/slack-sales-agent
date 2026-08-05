# Rogue-GPT backend (Node + Express + Inngest). Staging runs in us-east-1.
# Frontend is served from S3/CloudFront; this image is backend only.
FROM node:22-alpine

# Enable pnpm via corepack. Pinned: `latest` jumped to pnpm 11, which makes
# ERR_PNPM_IGNORED_BUILDS fatal under --frozen-lockfile and breaks the build.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Install dependencies (use frozen lockfile for reproducible builds)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source and build the server bundle
COPY server ./server
COPY tsconfig.json tsconfig.app.json tsconfig.node.json ./
RUN pnpm run build:server

# start.mjs is already in server/ from COPY server above

# App Runner expects PORT from env; server defaults to 3001
ENV PORT=3001
EXPOSE 3001

# Load secret if ROGUE_GPT_SECRET_NAME is set (e.g. in App Runner), then start server
CMD ["node", "server/start.mjs"]
