import { randomUUID } from 'node:crypto';
import { PlantStatusSchema, TOPICS } from '@desal/schema';
import { createKafka, topicName, type KafkaInstance } from '../kafka/client.js';
import { readToEnd } from '../kafka/read.js';

const USAGE = `usage: send --new
       send --game <gameId> '<command json>'   e.g. send --game <id> '{"type":"startShift","mode":"auto"}'`;

function fail(msg: string, code = 2): never {
  console.error(msg);
  process.exit(code);
}

/** The shift a game's latest status names, or undefined when there is no readable status for it. */
async function liveShift(kafka: KafkaInstance, gameId: string): Promise<number | null | undefined> {
  // plant.status is keyed by gameId but shared by every game, so read it to the end
  // and take the last record with this key (the key filters without parsing).
  const records = await readToEnd(kafka, topicName(TOPICS.status));
  const latest = records.filter((r) => r.key === gameId).at(-1);
  if (!latest?.value) return undefined;
  try {
    const parsed = PlantStatusSchema.safeParse(JSON.parse(latest.value));
    return parsed.success ? parsed.data.shiftId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Usage:
 *   pnpm --filter @desal/simulator send --new
 *   pnpm --filter @desal/simulator send --game <gameId> '{"type":"startShift","mode":"auto"}'
 *
 * --new sends startGame for a fresh gameId and prints the id. --game wraps the command in an
 * envelope for that game's current shift (from its latest plant.status). The simulator validates
 * the command; an invalid one comes back as a commandRejected event.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const kafka = createKafka();
  let gameId: string;
  let shiftId: number | null;
  let command: unknown;

  if (args[0] === '--new' && args.length === 1) {
    gameId = randomUUID();
    shiftId = null;
    command = { type: 'startGame' };
  } else if (args[0] === '--game' && args[1] && args[2] && args.length === 3) {
    gameId = args[1];
    try {
      command = JSON.parse(args[2]);
    } catch {
      fail(`not valid JSON: ${args[2]}`);
    }
    // Commands for any other shift than the live one are rejected as stale.
    const live = await liveShift(kafka, gameId);
    if (live === undefined) fail(`no status for game ${gameId} on ${topicName(TOPICS.status)} (is it live?)`, 1);
    shiftId = live;
  } else {
    fail(USAGE);
  }

  // Not validated here: the simulator is the single place commands are validated.
  const envelope = { commandId: randomUUID(), issuedAt: Date.now(), gameId, shiftId, command };
  const producer = kafka.producer();
  await producer.connect();
  try {
    // Keyed by gameId like every topic: one game's commands stay ordered on one partition.
    await producer.send({
      topic: topicName(TOPICS.commands),
      messages: [{ key: gameId, value: JSON.stringify(envelope) }],
    });
  } finally {
    await producer.disconnect();
  }
  if (args[0] === '--new') console.log(gameId);
  else console.log(JSON.stringify(envelope, null, 2));
}

main().catch((e: unknown) => {
  console.error('send failed:', e);
  process.exit(1);
});
