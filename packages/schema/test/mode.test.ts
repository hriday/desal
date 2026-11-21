import { ClientMsgSchema, CommandSchema, CrewJobSchema, DISASTER_KINDS, PlantEventSchema, ScenarioKindSchema } from '../src/index.js';

const G = '3f2b8c1e-5d4a-4e7b-9a10-2c6d8e4f1a7b';
const base = { gameId: G, epoch: 0, seq: 0, tick: 10, plantTime: 600, shiftId: 3 };

test('startGame mode defaults to normal, keeps hard, rejects unknown', () => {
  expect(CommandSchema.parse({ type: 'startGame' })).toEqual({ type: 'startGame', mode: 'normal' });
  expect(CommandSchema.parse({ type: 'startGame', mode: 'hard' })).toEqual({ type: 'startGame', mode: 'hard' });
  expect(CommandSchema.safeParse({ type: 'startGame', mode: 'easy' }).success).toBe(false);
});
test('newGame mode defaults to normal', () => {
  expect(ClientMsgSchema.parse({ t: 'newGame' })).toEqual({ t: 'newGame', mode: 'normal' });
});
test('gameEnd and gameStart without mode parse as normal', () => {
  const end = PlantEventSchema.parse({ ...base, type: 'gameEnd', reason: 'bankrupt', score: { shiftsCompleted: 2, totalProductM3: 7000, balanceUsd: -5 } });
  expect(end.type === 'gameEnd' && end.mode).toBe('normal');
  const start = PlantEventSchema.parse({ ...base, type: 'gameStart' });
  expect(start.type === 'gameStart' && start.mode).toBe('normal');
});
test('flushFuel crew job and disaster kinds', () => {
  expect(CrewJobSchema.parse('flushFuel')).toBe('flushFuel');
  expect([...DISASTER_KINDS]).toEqual(['fuelContamination', 'earthquake', 'tsunami']);
  for (const k of DISASTER_KINDS) expect(ScenarioKindSchema.options).toContain(k);
});
