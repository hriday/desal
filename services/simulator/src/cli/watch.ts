import { randomUUID } from 'node:crypto';
import { TOPICS } from '@desal/schema';
import { createKafka, topicName } from '../kafka/client.js';

/**
 * Usage: pnpm --filter @desal/simulator watch [events|status|telemetry <sensorId>]
 *
 * Live tail of a topic (default: events), pretty-printed. Ctrl-C to quit.
 */
const USAGE = 'usage: watch [events|status|telemetry <sensorId>]';

const plantClock = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

function format(kind: string, v: Record<string, unknown>): string {
  const head = `#${String(v.tick).padStart(5)}  ${plantClock(Number(v.plantTime))}`;
  if (kind === 'telemetry') return `${head}  ${String(v.sensorId)} = ${String(v.value)}`;
  if (kind === 'status') {
    return `${head}  shift ${String(v.shiftId)}  ${String(v.phase)}/${String(v.status)}  ${String(v.controlMode)}  ${String(v.shiftTicksRemaining)} ticks left`;
  }
  const { type, tick: _t, plantTime: _p, shiftId, ...rest } = v;
  return `${head}  shift ${String(shiftId)}  ${String(type)}  ${JSON.stringify(rest)}`;
}

async function main(): Promise<void> {
  const [kind = 'events', sensorId] = process.argv.slice(2);
  const base = { events: TOPICS.events, status: TOPICS.status, telemetry: TOPICS.telemetry }[kind];
  if (!base || (kind === 'telemetry' && !sensorId)) {
    console.error(USAGE);
    process.exit(2);
  }

  const kafka = createKafka();
  // A throwaway group per watcher: every watcher sees every record (consumers in
  // the same group would split the partitions between them). fromBeginning false
  // = a new group starts at the end of the topic, i.e. a live tail.
  const groupId = `desal-watch-${randomUUID()}`;
  const consumer = kafka.consumer({ kafkaJS: { groupId, fromBeginning: false, autoCommit: false } });
  await consumer.connect();
  await consumer.subscribe({ topics: [topicName(base)] });
  console.error(`watching ${topicName(base)}${sensorId ? ` for ${sensorId}` : ''} (Ctrl-C to quit)`);
  await consumer.run({
    eachMessage: async ({ message }) => {
      // Telemetry is keyed by sensorId, so the key filters without parsing the value.
      if (sensorId && message.key?.toString() !== sensorId) return;
      if (!message.value) return;
      try {
        console.log(format(kind, JSON.parse(message.value.toString()) as Record<string, unknown>));
      } catch {
        console.log(`(unparseable) ${message.value.toString()}`);
      }
    },
  });

  const quit = async () => {
    await consumer.disconnect();
    // The empty throwaway group would otherwise linger in Kafka UI for a while.
    const admin = kafka.admin();
    await admin.connect();
    await admin.deleteGroups([groupId]).catch(() => {});
    await admin.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void quit());
  process.on('SIGTERM', () => void quit());
}

main().catch((e: unknown) => {
  console.error('watch failed:', e);
  process.exit(1);
});
