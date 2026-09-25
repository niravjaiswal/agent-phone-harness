# syntax=docker/dockerfile:1

# ---- build -------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: `prepare` builds, and the sources are not here yet.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim

# adb from Debian rather than Google's platform-tools: Google only ships a Linux
# x86_64 build, and this image must also run on ARM hosts — the cheapest place
# to run a phone.
RUN apt-get update \
 && apt-get install -y --no-install-recommends adb ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE NOTICE ./
COPY config ./config
RUN chmod +x dist/cli.js && ln -s /app/dist/cli.js /usr/local/bin/agent-phone \
 && useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin phone \
 && mkdir -p /data && chown phone:phone /data

# /data holds tokens, secrets, approvals, traces and adb's key. HOME points
# there too so the adb key survives container rebuilds.
ENV NODE_ENV=production \
    HOME=/data \
    PHONE_HOME=/data \
    PHONE_HOST=0.0.0.0 \
    PHONE_PORT=8712

USER phone
VOLUME ["/data"]
EXPOSE 8712
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8712/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/http/serve.js"]
