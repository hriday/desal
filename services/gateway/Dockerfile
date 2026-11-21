# Gateway image. Build context is the repo root:
#   docker build -f services/gateway/Dockerfile -t desal-gateway:<commit> .
# Built on the server itself (scripts/deploy/deploy.sh), so the native librdkafka
# binding is fetched or compiled for the server's own CPU (linux/amd64).

FROM node:22-bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.8.1
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/schema/package.json packages/schema/
# The simulator is a devDependency of the gateway (integration tests only), but the
# workspace link needs its package.json for a frozen-lockfile install.
COPY services/simulator/package.json services/simulator/
COPY services/gateway/package.json services/gateway/
RUN pnpm install --frozen-lockfile --filter @desal/gateway...
COPY packages/schema packages/schema
COPY services/gateway services/gateway

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/services/gateway
USER node
# node runs directly (not via pnpm) so SIGTERM reaches main.ts, which closes
# sockets and Kafka before exiting. tsx loads the TypeScript sources.
ENTRYPOINT ["node", "--import", "tsx", "src/main.ts"]
