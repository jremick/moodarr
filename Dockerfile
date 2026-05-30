FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    FEELERR_API_HOST=0.0.0.0 \
    FEELERR_API_PORT=4401 \
    FEELERR_SERVE_CLIENT=true \
    FEELERR_DATA_DIR=/data \
    FEELERR_CONFIG_PATH=/data/config.json \
    FEELERR_DB_PATH=/data/feelerr.sqlite

WORKDIR /app

RUN groupadd --system feelerr \
  && useradd --system --gid feelerr --home-dir /app --shell /usr/sbin/nologin feelerr \
  && mkdir -p /data \
  && chown feelerr:feelerr /app /data

COPY --from=build --chown=feelerr:feelerr /app/package*.json ./
COPY --from=build --chown=feelerr:feelerr /app/node_modules ./node_modules
COPY --from=build --chown=feelerr:feelerr /app/dist ./dist

USER feelerr

EXPOSE 4401
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4401/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
