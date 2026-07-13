FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS build

ARG MOODARR_BUILD_AI_PROVIDER_POLICY=none
ARG MOODARR_BUILD_TMDB_CONTENT_POLICY=none

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN MOODARR_BUILD_AI_PROVIDER_POLICY="$MOODARR_BUILD_AI_PROVIDER_POLICY" \
  MOODARR_BUILD_TMDB_CONTENT_POLICY="$MOODARR_BUILD_TMDB_CONTENT_POLICY" npm run build \
  && npm prune --omit=dev \
  && install -d -o 999 -g 999 /empty-data

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:70a2c12a0d76018b54d7bd01c5e3677632eeed9f890ba318d6db55fc54cf3baa AS runtime

ARG MOODARR_VERSION=
ARG MOODARR_BUILD_REVISION=
ARG MOODARR_BUILD_AI_PROVIDER_POLICY=none
ARG MOODARR_BUILD_TMDB_CONTENT_POLICY=none

LABEL org.opencontainers.image.source="https://github.com/jremick/moodarr" \
      org.opencontainers.image.description="Moodarr Plex and Seerr companion app" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${MOODARR_VERSION}" \
      org.opencontainers.image.revision="${MOODARR_BUILD_REVISION}" \
      io.moodarr.ai-provider-policy="${MOODARR_BUILD_AI_PROVIDER_POLICY}" \
      io.moodarr.tmdb-content-policy="${MOODARR_BUILD_TMDB_CONTENT_POLICY}"

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

COPY --from=build --chown=999:999 /empty-data /data
COPY --from=build --chown=999:999 /app/package*.json ./
COPY --from=build --chown=999:999 /app/LICENSE /app/THIRD_PARTY_NOTICES.md ./
COPY --from=build --chown=999:999 /app/node_modules ./node_modules
COPY --from=build --chown=999:999 /app/dist ./dist

USER 999:999

EXPOSE 4401
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=15s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:4401/api/health').then(async(r)=>{const h=await r.json();process.exit(r.ok&&h.ok===true&&h.ready===true?0:1)}).catch(()=>process.exit(1))"]

CMD ["dist/server/index.js"]
