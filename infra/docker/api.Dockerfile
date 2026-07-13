FROM node:22.23.1-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter api build

FROM node:22.23.1-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /workspace

COPY --chown=node:node --from=build /workspace/node_modules ./node_modules
COPY --chown=node:node --from=build /workspace/apps/api/node_modules ./apps/api/node_modules
COPY --chown=node:node --from=build /workspace/apps/api/package.json ./apps/api/package.json
COPY --chown=node:node --from=build /workspace/apps/api/dist ./apps/api/dist
COPY --chown=node:node --from=build /workspace/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --chown=node:node --from=build /workspace/packages/contracts/package.json ./packages/contracts/package.json
COPY --chown=node:node --from=build /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --chown=node:node --from=build /workspace/packages/observability/node_modules ./packages/observability/node_modules
COPY --chown=node:node --from=build /workspace/packages/observability/package.json ./packages/observability/package.json
COPY --chown=node:node --from=build /workspace/packages/observability/dist ./packages/observability/dist

USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
