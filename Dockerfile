FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS build

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

FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS runtime-download

WORKDIR /apks
COPY docker/runtime-packages.sha256 /runtime-packages.sha256
COPY docker/fetch-runtime-packages.mjs /fetch-runtime-packages.mjs
RUN node /fetch-runtime-packages.mjs

FROM cgr.dev/chainguard/wolfi-base@sha256:9c2092b053779e14c82fb50f77b37bcc38b7d2c83972352d5813280f9d035b03 AS runtime-packages

COPY docker/runtime-packages.sha256 /tmp/runtime-packages.sha256
COPY docker/runtime-packages.lock /tmp/runtime-packages.lock
COPY docker/runtime-APKINDEX.tar.gz /apks/x86_64/APKINDEX.tar.gz
COPY --from=runtime-download /apks/ /apks/x86_64/

# The vendor-signed index authenticates package identities during offline
# installation. Only the assembled root filesystem enters the final image.
RUN test "$(apk --print-arch)" = x86_64 \
  && echo 'f0031424cf46f7db780ce63a45f0fd6aa6f85f601e6bb3b7a91fe3d4d5b7d2cc  /etc/apk/keys/wolfi-signing.rsa.pub' | sha256sum -c - \
  && echo '2f609cdf0577ea862ef0133c83cfa98023fb936b6730a7960f2a21f733592df1  /apks/x86_64/APKINDEX.tar.gz' | sha256sum -c - \
  && mkdir -p /runtime/etc/apk/keys \
  && cp /etc/apk/keys/wolfi-signing.rsa.pub /runtime/etc/apk/keys/ \
  && cd /apks/x86_64 \
  && sha256sum -c /tmp/runtime-packages.sha256 \
  && apk --root /runtime --arch x86_64 --initdb --no-scripts --no-cache --no-network \
       --repositories-file /dev/null --repository /apks add $(cat /tmp/runtime-packages.lock) \
  && mkdir -p /runtime/nodejs/bin /runtime/app \
  && ln -s /usr/bin/node /runtime/nodejs/bin/node \
  && chown 999:999 /runtime/app \
  && printf 'root:x:0:0:root:/root:/sbin/nologin\nmoodarr:x:999:999:Moodarr:/app:/sbin/nologin\n' > /runtime/etc/passwd \
  && printf 'root:x:0:\nmoodarr:x:999:\n' > /runtime/etc/group \
  && test -s /runtime/lib/apk/db/installed \
  && test -s /runtime/etc/ssl/certs/ca-certificates.crt \
  && for tool in /bin/sh /bin/bash /bin/busybox /usr/bin/busybox /usr/bin/npm /usr/bin/npx /sbin/apk /usr/bin/apk /usr/sbin/apk; do \
       test ! -e "/runtime$tool" || exit 1; \
     done

FROM scratch AS runtime

COPY --from=runtime-packages /runtime/ /

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

ENV PATH=/nodejs/bin:/usr/bin \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    NODE_ENV=production \
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

ENTRYPOINT ["/nodejs/bin/node"]
CMD ["dist/server/index.js"]
