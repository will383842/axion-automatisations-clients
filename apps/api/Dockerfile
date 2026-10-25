# Image de l'API : amont épinglé par empreinte, dépendances de production seules, utilisateur non root.
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS base
RUN corepack enable
WORKDIR /app

FROM base AS construction
COPY . .
RUN pnpm install --frozen-lockfile --filter @axion-auto/api...
RUN pnpm --filter @axion-auto/api deploy --prod /sortie

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS final
ENV NODE_ENV=production
WORKDIR /app
COPY --from=construction --chown=node:node /sortie ./
USER node
CMD ["node", "src/index.ts"]
