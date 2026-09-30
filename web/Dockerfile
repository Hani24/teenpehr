# The web app as one image (docs/DEPLOY.md): Coolify builds it from this directory (base directory /web).
# The build needs no database and no secret; configuration comes from the environment at run time.
#
#   docker build -t tabayyun-web web/
#   docker run -p 3100:3000 -v tabayyun-data:/data -e DATABASE_URL=… -e WORKER_TOKEN=… -e SITE_URL=… tabayyun-web
#
# At start, scripts/docker-entrypoint.sh checks /data, applies db/migrations (scripts/migrate.mjs) and runs the
# standalone server on port 3000 as the unprivileged `node` user.

FROM node:22-trixie-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
# --include=dev: the build needs TypeScript and Tailwind even if a NODE_ENV=production build variable is set.
RUN npm ci --include=dev --no-audit --no-fund

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
# The migrator's own dependencies, whole: the standalone output keeps only the files the server traces.
RUN mkdir -p /migrator/node_modules \
 && cp -R node_modules/drizzle-orm node_modules/postgres /migrator/node_modules/ \
 && find /migrator -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.cts' -o -name '*.d.mts' \) -delete

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    MEDIA_DIR=/data/media \
    EDITION_SNAPSHOT_DIR=/data/snapshots
# /data is where published images and edition snapshots live; mount a persistent volume there. It is not
# declared as a VOLUME: an anonymous volume would hide a missing mount, and the entrypoint refuses to start
# without a real one. A new empty volume takes this directory's ownership (node).
RUN mkdir -p /data/media /data/snapshots && chown -R node:node /data
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /migrator/node_modules ./node_modules
COPY --from=build --chown=node:node /app/db/migrations ./db/migrations
# Read at run time by the admin's group page (lib/admin/x-proposals.ts), from the working directory.
COPY --from=build --chown=node:node /app/db/seed/x-list-proposals.json ./db/seed/x-list-proposals.json
COPY --from=build --chown=node:node /app/scripts/migrate.mjs /app/scripts/docker-entrypoint.sh ./scripts/
USER node
EXPOSE 3000
# Coolify uses this instead of its own check. /robots.txt is outside the login wall and touches no database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/robots.txt').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["sh", "/app/scripts/docker-entrypoint.sh"]
