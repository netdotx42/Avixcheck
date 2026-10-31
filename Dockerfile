# One image, three uses: `web` (Next.js), `worker` (background jobs) and ops
# tasks (migrations, backups, restore drills). Select with the command:
#   web:      npm run start            (default)
#   worker:   npm run worker
#   release:  npm run db:migrate       (run once per deploy, before web/worker start)
#   backup:   npm run ops:backup       (scheduled)
FROM node:22.20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22.20-bookworm-slim AS run
WORKDIR /app
# Set by the deploy pipeline to the git SHA; reported by /api/health and attached to Sentry events.
ARG APP_RELEASE=
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 APP_RELEASE=$APP_RELEASE
# PostgreSQL 16 client tools (pg_dump/pg_restore must match the server major version) from the PGDG repo.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 \
  && apt-get purge -y curl gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
RUN groupadd -r app && useradd -r -g app -d /app app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/tsconfig.json /app/next.config.ts ./
RUN mkdir -p /app/backups && chown app:app /app/backups
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "run", "start"]
