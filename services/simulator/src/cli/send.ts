import { randomUUID } from 'node:crypto';
import { PLANT_KEY, PlantStatusSchema, TOPICS } from '@desal/schema';
import { createKafka, topicName } from '../kafka/client.js';
import { readToEnd } from '../kafka/read.js';

function shiftIdOf(statusJson: string): number | null {
  try {
    const parsed = PlantStatusSchema.safeParse(JSON.parse(statusJson));
    return parsed.success ? parsed.data.shiftId : null;
  } catch {
    return null;
  }
}

/**
 * Usage: pnpm --filter @desal/simulator send '{"type":"startShift","mode":"auto"}'
 *
 * Wraps the command in an envelope addressed to the current shift (read from the
 * latest plant.status) and produces it to plant.commands. The simulator validates
 * it; an invalid command comes back as a commandRejected event.
 */
async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error(`usage: send '<command json>'   e.g. send '{"type":"startShift","mode":"auto"}'`);
    process.exit(2);
  }
  let command: unknown;
  try {
    command = JSON.parse(arg);
  } catch {
    console.error(`not valid JSON: ${arg}`);
    process.exit(2);
  }

  const kafka = createKafka();
  // The latest status says which shift is live; commands for any other shift are
  // rejected as stale. lastOnly seeks straight to the final record.
  const [latest] = await readToEnd(kafka, topicName(TOPICS.status), { lastOnly: true });
  const shiftId = latest?.value ? shiftIdOf(latest.value) : null;

  // Not validated here: the simulator is the single place commands are validated.
  const envelope = { commandId: randomUUID(), issuedAt: Date.now(), shiftId, command };
  const producer = kafka.producer();
  await producer.connect();
  try {
    // plant.commands has one partition, so the key does not pick a partition here;
    // keying by plant keeps it correct if more plants (partitions) are ever added.
    await producer.send({
      topic: topicName(TOPICS.commands),
      messages: [{ key: PLANT_KEY, value: JSON.stringify(envelope) }],
    });
  } finally {
    await producer.disconnect();
  }
  console.log(JSON.stringify(envelope, null, 2));
}

main().catch((e: unknown) => {
  console.error('send failed:', e);
  process.exit(1);
});
