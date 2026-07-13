FROM node:22.23.1-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter web build

FROM node:22.23.1-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /workspace/apps/web

COPY --chown=node:node --from=build /workspace/node_modules /workspace/node_modules
COPY --chown=node:node --from=build /workspace/apps/web/node_modules ./node_modules
COPY --chown=node:node --from=build /workspace/apps/web/package.json ./package.json
COPY --chown=node:node --from=build /workspace/apps/web/.next ./.next
COPY --chown=node:node --from=build /workspace/packages/security/package.json /workspace/packages/security/package.json
COPY --chown=node:node --from=build /workspace/packages/security/dist /workspace/packages/security/dist

USER node
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start"]
