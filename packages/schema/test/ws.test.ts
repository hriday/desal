import { ClientMsgSchema, ServerMsgSchema } from '../src/index.js';
import { status } from './fixtures.js';

const G = '3f2b8c1e-5d4a-4e7b-9a10-2c6d8e4f1a7b';

const client = [
  { t: 'newGame' },
  { t: 'resume', gameId: G },
  { t: 'cmd', command: { type: 'pause' } },
  { t: 'ping' },
];
const server = [
  { t: 'game', gameId: G },
  { t: 'status', status },
  { t: 'frame', tick: 3, plantTime: 120, readings: { 'tbt.temp': 108 } },
  { t: 'event', event: { gameId: G, seq: 0, tick: 1, plantTime: 40, shiftId: null, type: 'online' } },
  { t: 'error', reason: 'nope' },
  { t: 'pong' },
];

test.each(client.map((m) => [m.t, m] as const))('client %s round-trips', (_t, m) => {
  expect(ClientMsgSchema.parse(JSON.parse(JSON.stringify(m)))).toEqual(m);
});
test.each(server.map((m) => [m.t, m] as const))('server %s round-trips', (_t, m) => {
  expect(ServerMsgSchema.parse(JSON.parse(JSON.stringify(m)))).toEqual(m);
});
test('unknown t is rejected', () => {
  expect(ClientMsgSchema.safeParse({ t: 'hack' }).success).toBe(false);
  expect(ServerMsgSchema.safeParse({ t: 'hack' }).success).toBe(false);
  expect(ClientMsgSchema.safeParse({ t: 'resume', gameId: 'nope' }).success).toBe(false);
});
