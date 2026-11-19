import { createInterface } from 'node:readline';
import { ServerMsgSchema, type PlantStatus } from '@desal/schema';
import { WebSocket } from 'ws';
import { HELP, parseLine } from './lines.js';

/**
 * Terminal client. Usage: pnpm --filter @desal/gateway play [--url ws://localhost:8081/ws]
 *
 * Starts a new game, prints one status line per second, sends typed lines as commands and exits
 * with the score when the game ends. Sends no Origin header (the gateway allows that, ruling R2).
 */
function argUrl(): string {
  const i = process.argv.indexOf('--url');
  return (i >= 0 ? process.argv[i + 1] : undefined) ?? 'ws://localhost:8081/ws';
}

const num = (n: number | undefined, d = 1) => (n === undefined ? '-' : n.toFixed(d));

function summary(s: PlantStatus, flow: number | undefined, tbt: number | undefined): string {
  const bal = `$${Math.round(s.balanceUsd)}`;
  return `shift ${s.shiftNumber} ${s.phase}/${s.status} tick ${s.tick} left ${s.shiftTicksRemaining} TBT ${num(tbt)}C flow ${num(flow)} m3/h balance ${bal}`;
}

const ws = new WebSocket(argUrl());
let latest: PlantStatus | undefined;
let flow: number | undefined;
let tbt: number | undefined;
let ended = false;

ws.on('open', () => ws.send(JSON.stringify({ t: 'newGame' })));
ws.on('error', (e) => {
  console.error(`connection error: ${e.message}`);
  process.exit(1);
});
ws.on('close', () => {
  if (!ended) {
    console.error('connection closed');
    process.exit(1);
  }
});

ws.on('message', (data) => {
  const parsed = ServerMsgSchema.safeParse(JSON.parse(data.toString()));
  if (!parsed.success) return;
  const m = parsed.data;
  switch (m.t) {
    case 'game':
      console.log(`game ${m.gameId}\n${HELP}`);
      break;
    case 'status':
      latest = m.status;
      break;
    case 'frame':
      flow = m.readings['product.flowM3h'];
      tbt = m.readings['heater.tbtC'];
      break;
    case 'event':
      if (m.event.type === 'gameEnd') {
        ended = true;
        const { reason, score } = m.event;
        console.log(`game over (${reason}): ${score.totalProductM3.toFixed(0)} m3 in spec, ${score.shiftsCompleted} shifts, balance $${Math.round(score.balanceUsd)}`);
        ws.close();
        process.exit(0);
      }
      console.log(`event: ${JSON.stringify(m.event)}`);
      break;
    case 'error':
      console.error(`error: ${m.reason}`);
      break;
    case 'pong':
      break;
  }
});

// One status line per second; statuses arrive once per tick.
setInterval(() => {
  if (latest) console.log(summary(latest, flow, tbt));
}, 1000).unref();

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (line.trim() === '') return;
  const r = parseLine(line);
  if (!r.ok) {
    console.error(`${r.error}\n${HELP}`);
    return;
  }
  ws.send(JSON.stringify({ t: 'cmd', command: r.command }));
});
// stdin closed (piped input ended): keep playing until the game ends or the socket drops.
