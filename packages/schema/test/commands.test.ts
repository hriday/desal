import { CommandEnvelopeSchema, CommandSchema } from '../src/index.js';
test('accepts a valid setSetpoint', () => {
  expect(CommandSchema.parse({ type: 'setSetpoint', loop: 'tbt', value: 108 })).toEqual({ type: 'setSetpoint', loop: 'tbt', value: 108 });
});
test('accepts level loops 1..20 only', () => {
  expect(CommandSchema.safeParse({ type: 'setLoopMode', loop: 'level20', mode: 'manual' }).success).toBe(true);
  expect(CommandSchema.safeParse({ type: 'setLoopMode', loop: 'level21', mode: 'manual' }).success).toBe(false);
});
test('rejects NaN and unknown types', () => {
  expect(CommandSchema.safeParse({ type: 'setSetpoint', loop: 'tbt', value: NaN }).success).toBe(false);
  expect(CommandSchema.safeParse({ type: 'selfDestruct' }).success).toBe(false);
});
test('envelope requires uuid commandId', () => {
  expect(CommandEnvelopeSchema.safeParse({ commandId: 'x', issuedAt: 1, shiftId: 1, command: { type: 'pause' } }).success).toBe(false);
});
