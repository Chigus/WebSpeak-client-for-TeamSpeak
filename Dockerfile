FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json ./web/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY scripts/prepare-sdk.mjs ./scripts/prepare-sdk.mjs
RUN npm run prepare:sdk
RUN npm rebuild @discordjs/opus --foreground-scripts --no-audit --no-fund
RUN npm --prefix web ci

COPY . .
# Preserve the exact build context before compilation/pruning. CI supplies a
# Git archive instead; local builds still offer their corresponding source.
RUN mkdir -p /tmp/webspeak-source \
  && tar --exclude='./node_modules' --exclude='./web/node_modules' \
    --exclude='./web/public/source' -czf /tmp/webspeak-source/webspeak-stereo-source.tar.gz .
RUN npm run verify \
  && mkdir -p web/dist/source \
  && if [ ! -f web/dist/source/webspeak-stereo-source.tar.gz ]; then \
    cp /tmp/webspeak-source/webspeak-stereo-source.tar.gz web/dist/source/; fi \
  && npm prune --omit=dev \
  && rm -rf web/node_modules

FROM node:22-bookworm-slim AS runtime

ARG WEBSPEAK_REVISION=unknown
LABEL org.opencontainers.image.revision=$WEBSPEAK_REVISION \
      org.opencontainers.image.source="https://github.com/Chigus/WebSpeak-client-for-TeamSpeak" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libstdc++6 iputils-ping \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data \
  && chown node:node /data

ENV NODE_ENV=production
ENV WEBSPEAK_DATA_DIR=/data

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/web/dist ./web/dist
COPY --from=build --chown=node:node /app/scripts/docker-healthcheck.mjs ./scripts/docker-healthcheck.mjs

USER node
VOLUME ["/data"]
EXPOSE 3040/tcp 39087/udp 40000-40099/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "scripts/docker-healthcheck.mjs"]

CMD ["node", "dist/index.js"]
