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

COPY --chown=node:node --from=build /workspace /workspace

USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
