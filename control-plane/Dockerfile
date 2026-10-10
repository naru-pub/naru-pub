# Two images from one build, chosen with --target:
#
#   web   the Next.js server, from `output: "standalone"`: only the files the
#         server traces, with no Chromium, pnpm, devDependencies or build cache.
#         The blue/green slots run this.
#   jobs  the CLIs under src/cli, compiled by scripts/build-cli.mjs and run
#         with plain node: cron (which starts Playwright for screenshots),
#         worker and migrations. It has Chromium and the production
#         dependencies, and neither the Next build nor tsx.

FROM node:24-slim AS deps

WORKDIR /app

RUN npm install --global pnpm@11.5.2

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm install --frozen-lockfile

FROM deps AS cli-builder

COPY tsconfig.json ./
COPY scripts/build-cli.mjs scripts/
COPY src/ src/

RUN pnpm run build:cli

# Only the dependencies the compiled CLIs import, which the build lists in
# dist/package.json; the web app's (Next, React, Monaco and the rest) stay
# out. The lockfile is the full one, so every version it has for these is kept
# as locked, and --frozen-lockfile, which would refuse the shorter manifest, is
# off.
FROM node:24-slim AS prod-deps

WORKDIR /app

RUN npm install --global pnpm@11.5.2

COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=cli-builder /app/dist/package.json ./

RUN pnpm install --prod --no-frozen-lockfile

FROM deps AS builder

# NEXT_PUBLIC_* are compiled into the client bundle.
ARG NEXT_PUBLIC_DOMAIN=naru.pub
ENV NEXT_PUBLIC_DOMAIN=$NEXT_PUBLIC_DOMAIN

COPY components.json \
     kysely.config.ts \
     next.config.mjs \
     postcss.config.mjs \
     sentry.edge.config.ts \
     sentry.server.config.ts \
     tailwind.config.ts \
     tsconfig.json \
     ./

COPY public/ public/

# The SDK source and the check, run first by the build, that public/sdk/ is
# what it emits. The served files are the committed ones, never rebuilt here.
COPY sdk/ sdk/
COPY scripts/build-sdk.mjs scripts/

COPY src/ src/

RUN pnpm run build

FROM node:24-slim AS jobs

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Chromium and what it needs, for src/cli/update-screenshots.tsx.
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG NEXT_PUBLIC_DOMAIN=naru.pub
ENV NEXT_PUBLIC_DOMAIN=$NEXT_PUBLIC_DOMAIN
# Stack traces point into src/ through the maps built beside each CLI. Set
# here, not as a flag, so the jobs cron starts inherit it.
ENV NODE_OPTIONS=--enable-source-maps

COPY --from=prod-deps /app/node_modules node_modules/
COPY --from=prod-deps /app/package.json ./
COPY --from=cli-builder /app/dist dist/

# docker-compose.yml gives each service its own command.
CMD ["node", "dist/cli/worker.mjs"]

FROM node:24-slim AS web

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
# server.js listens on $HOSTNAME, which Docker sets to the container ID: that
# would bind only the container's own address and fail the healthcheck, which
# asks 127.0.0.1.
ENV HOSTNAME=0.0.0.0

# The standalone server does not serve these from the build; they go next to it.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static .next/static/
COPY --from=builder --chown=node:node /app/public public/

# Next writes its image optimization cache under .next/cache.
USER node

EXPOSE 3000

CMD ["node", "server.js"]
