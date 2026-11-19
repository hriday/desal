# Simulator image. Build context is the repo root:
#   docker build -f services/simulator/Dockerfile -t desal-simulator:<commit> .
# Built on the server itself (scripts/deploy/deploy.sh), so the native librdkafka
# binding is fetched or compiled for the server's own CPU (linux/amd64).

FROM node:22-bookworm-slim AS build
# The Kafka client's install script downloads a prebuilt librdkafka binding; the
# toolchain is the fallback if no prebuilt binary matches this platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.8.1
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/schema/package.json packages/schema/
COPY services/simulator/package.json services/simulator/
RUN pnpm install --frozen-lockfile --filter @desal/simulator...
COPY packages/schema packages/schema
COPY services/simulator services/simulator

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/services/simulator
USER node
# node runs directly (not via pnpm) so SIGTERM reaches main.ts, which writes a
# final snapshot before exiting. tsx loads the TypeScript sources.
ENTRYPOINT ["node", "--import", "tsx", "src/main.ts"]
