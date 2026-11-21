import { DEFAULT_TRUSTED_PROXIES } from './clients.js';
import { FlinkFeeds } from './flinkFeeds.js';
import { createKafka, GatewayKafka } from './kafka.js';
import { DEFAULT_PER_CLIENT } from './limits.js';
import { createGateway } from './server.js';

const log = (m: string) => console.log(`[gateway] ${m}`);
/** How long to wait before retrying a failed FlinkFeeds start. */
const FEEDS_RETRY_MS = 30_000;

/** A non-negative integer from the environment, or the default when unset; throws when malformed. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name}: expected a non-negative integer, got "${raw}"`);
  return n;
}

/**
 * Usage: pnpm --filter @desal/gateway start
 * env: PORT, KAFKA_BROKERS, ALLOWED_ORIGINS, TRUSTED_PROXIES, MAX_SOCKETS_PER_CLIENT,
 * MAX_GAMES_PER_CLIENT, NEW_GAME_INTERVAL_MS
 */
async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8081);
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '');

  const perClient = {
    maxSockets: envInt('MAX_SOCKETS_PER_CLIENT', DEFAULT_PER_CLIENT.maxSockets),
    maxGames: envInt('MAX_GAMES_PER_CLIENT', DEFAULT_PER_CLIENT.maxGames),
    newGameIntervalMs: envInt('NEW_GAME_INTERVAL_MS', DEFAULT_PER_CLIENT.newGameIntervalMs),
  };
  // Throws on a malformed CIDR: better to fail at startup than to mis-identify every player.
  const trustedProxies = process.env.TRUSTED_PROXIES ?? DEFAULT_TRUSTED_PROXIES;

  const client = createKafka();
  const kafka = new GatewayKafka(client, { log });
  const gateway = createGateway({ kafka, allowedOrigins, perClient, trustedProxies });
  log(`per client: ${JSON.stringify(perClient)}; trusted proxies: ${trustedProxies}`);

  // Registered before Kafka starts: a SIGTERM during startup still closes Kafka and deletes the group.
  let stopping = false;
  let feeds: FlinkFeeds | undefined;
  let feedsRetry: NodeJS.Timeout | undefined;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: closing sockets and Kafka`);
    clearTimeout(feedsRetry);
    await gateway.close();
    await feeds?.stop();
    await kafka.stop();
    process.exit(0);
  };

  // Flink's records (report cards, leaderboard, ranks) are optional: a failed start is logged and
  // retried, and never stops the gateway, /ws or /healthz.
  const startFeeds = async (): Promise<void> => {
    if (stopping) return;
    const f = new FlinkFeeds(client, {
      onReport: gateway.onReport,
      onBoard: gateway.onBoard,
      onRank: gateway.onRank,
      onRankDeleted: gateway.onRankDeleted,
      log,
    });
    feeds = f;
    try {
      await f.start();
      log(`flink feeds: consumer group ${f.groupId}`);
    } catch (e) {
      log(`flink feeds failed to start, retrying in ${FEEDS_RETRY_MS / 1000} s: ${e instanceof Error ? e.message : String(e)}`);
      await f.stop(); // start may have failed after joining: delete the group
      if (feeds === f) feeds = undefined;
      if (!stopping) feedsRetry = setTimeout(() => void startFeeds(), FEEDS_RETRY_MS);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Listen first: a taken port fails before we join Kafka (and leave a consumer group behind).
  // Until Kafka is up, /healthz answers 503 and /ws upgrades are refused.
  await gateway.listen(port);
  try {
    await kafka.start(gateway.onRecord);
  } catch (e) {
    await kafka.stop(); // start may have failed after joining: delete the group
    throw e;
  }
  log(`listening on :${port} (/ws, /healthz, /api/leaderboard); origins: ${allowedOrigins.length ? allowedOrigins.join(', ') : 'any'}`);
  log(`consumer group ${kafka.groupId}`);
  void startFeeds();
}

main().catch((e: unknown) => {
  console.error('[gateway] fatal:', e);
  process.exit(1);
});
