FROM node:22.23.1-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @geo-content-os/worker-sohu-browser build

FROM mcr.microsoft.com/playwright:v1.61.1-noble AS runtime

ENV NODE_ENV=production
WORKDIR /workspace

COPY --chown=pwuser:pwuser --from=build /workspace /workspace
RUN mkdir -p /var/lib/geo-content-os/sohu && \
    chown -R pwuser:pwuser /var/lib/geo-content-os

USER pwuser
EXPOSE 9096
CMD ["node", "workers/sohu-browser/dist/main.js"]
