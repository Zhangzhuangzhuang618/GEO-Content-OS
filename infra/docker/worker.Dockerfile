FROM node:22.23.1-bookworm-slim

ENV NODE_ENV=development
WORKDIR /app

COPY --chown=node:node infra/docker/worker-health.mjs ./worker-health.mjs

USER node
EXPOSE 9090
CMD ["node", "worker-health.mjs"]
