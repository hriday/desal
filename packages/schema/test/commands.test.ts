import { CommandEnvelopeSchema, CommandSchema } from '../src/index.js';
const G = '3f2b8c1e-5d4a-4e7b-9a10-2c6d8e4f1a7b';
test('accepts a valid setSetpoint', () => {
  expect(CommandSchema.parse({ type: 'setSetpoint', loop: 'tbt', value: 108 })).toEqual({ type: 'setSetpoint', loop: 'tbt', value: 108 });
});
test('accepts level loops 1..23 and the makeup loop only', () => {
  expect(CommandSchema.safeParse({ type: 'setLoopMode', loop: 'level23', mode: 'manual' }).success).toBe(true);
  expect(CommandSchema.safeParse({ type: 'setLoopMode', loop: 'makeup', mode: 'manual' }).success).toBe(true);
  expect(CommandSchema.safeParse({ type: 'setLoopMode', loop: 'level24', mode: 'manual' }).success).toBe(false);
  expect(CommandSchema.safeParse({ type: 'setLoopMode', loop: 'level0', mode: 'manual' }).success).toBe(false);
});
test('rejects NaN and unknown types', () => {
  expect(CommandSchema.safeParse({ type: 'setSetpoint', loop: 'tbt', value: NaN }).success).toBe(false);
  expect(CommandSchema.safeParse({ type: 'selfDestruct' }).success).toBe(false);
});
test('envelope requires uuid commandId', () => {
  expect(CommandEnvelopeSchema.safeParse({ commandId: 'x', issuedAt: 1, gameId: G, shiftId: 1, command: { type: 'pause' } }).success).toBe(false);
});
test('envelope requires a gameId', () => {
  const env = { commandId: G, issuedAt: 1, shiftId: null, command: { type: 'pause' } };
  expect(CommandEnvelopeSchema.safeParse(env).success).toBe(false);
  expect(CommandEnvelopeSchema.safeParse({ ...env, gameId: G }).success).toBe(true);
});
test('newCareer is gone; game lifecycle commands parse', () => {
  expect(CommandSchema.safeParse({ type: 'newCareer' }).success).toBe(false);
  for (const type of ['startGame', 'quitGame', 'heartbeat']) expect(CommandSchema.safeParse({ type }).success).toBe(true);
  expect(CommandSchema.safeParse({ type: 'overhaulPump', pumpId: 'P-103' }).success).toBe(true);
  expect(CommandSchema.safeParse({ type: 'overhaulPump', pumpId: 'P-9' }).success).toBe(false);
});
test('dispatchCrew takes a crew job', () => {
  expect(CommandSchema.safeParse({ type: 'dispatchCrew', job: 'plugTubes' }).success).toBe(true);
  expect(CommandSchema.safeParse({ type: 'dispatchCrew', job: 'nope' }).success).toBe(false);
});
