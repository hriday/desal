import { createKafka, GatewayKafka } from './kafka.js';
import { createGateway } from './server.js';

const log = (m: string) => console.log(`[gateway] ${m}`);

/** Usage: pnpm --filter @desal/gateway start  (env: PORT, KAFKA_BROKERS, ALLOWED_ORIGINS) */
async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8081);
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '');

  const kafka = new GatewayKafka(createKafka(), { log });
  const gateway = createGateway({ kafka, allowedOrigins });

  // Registered before Kafka starts: a SIGTERM during startup still closes Kafka and deletes the group.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: closing sockets and Kafka`);
    await gateway.close();
    await kafka.stop();
    process.exit(0);
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
  log(`listening on :${port} (/ws, /healthz); origins: ${allowedOrigins.length ? allowedOrigins.join(', ') : 'any'}`);
  log(`consumer group ${kafka.groupId}`);
}

main().catch((e: unknown) => {
  console.error('[gateway] fatal:', e);
  process.exit(1);
});
