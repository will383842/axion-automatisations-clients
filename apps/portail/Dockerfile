# Image de l'application portail : amont épinglé par empreinte, construction puis exécution sans outils, utilisateur non root.
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS base
RUN corepack enable
WORKDIR /app

FROM base AS construction
COPY . .
RUN pnpm install --frozen-lockfile --filter @axion-auto/portail...
RUN pnpm --filter @axion-auto/portail build

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS final
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=construction --chown=node:node /app/apps/portail/.next/standalone ./
COPY --from=construction --chown=node:node /app/apps/portail/.next/static ./apps/portail/.next/static
COPY --from=construction --chown=node:node /app/apps/portail/public ./apps/portail/public
USER node
EXPOSE 3000
CMD ["node", "apps/portail/server.js"]
