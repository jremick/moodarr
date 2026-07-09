FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS runtime

LABEL org.opencontainers.image.source="https://github.com/jremick/moodarr" \
      org.opencontainers.image.description="Moodarr Plex and Seerr companion app" \
      org.opencontainers.image.licenses="Apache-2.0"

ARG MOODARR_VERSION=
ARG MOODARR_BUILD_REVISION=

ENV NODE_ENV=production \
    MOODARR_VERSION=${MOODARR_VERSION} \
    MOODARR_BUILD_REVISION=${MOODARR_BUILD_REVISION} \
    MOODARR_API_HOST=0.0.0.0 \
    MOODARR_API_PORT=4401 \
    MOODARR_SERVE_CLIENT=true \
    MOODARR_DATA_DIR=/data \
    MOODARR_CONFIG_PATH=/data/config.json \
    MOODARR_DB_PATH=/data/moodarr.sqlite

WORKDIR /app

RUN groupadd --system moodarr \
  && useradd --system --gid moodarr --home-dir /app --shell /usr/sbin/nologin moodarr \
  && mkdir -p /data \
  && chown moodarr:moodarr /app /data \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

COPY --from=build --chown=moodarr:moodarr /app/package*.json ./
COPY --from=build --chown=moodarr:moodarr /app/node_modules ./node_modules
COPY --from=build --chown=moodarr:moodarr /app/dist ./dist

USER moodarr

EXPOSE 4401
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=15s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4401/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
