import { PlantStatusSchema } from '../src/index.js';
import { status } from './fixtures.js';

test('a valid status round-trips through JSON', () => {
  expect(PlantStatusSchema.parse(JSON.parse(JSON.stringify(status)))).toEqual(status);
});

test('rejects an invalid phase, status and loop key', () => {
  expect(PlantStatusSchema.safeParse({ ...status, phase: 'napping' }).success).toBe(false);
  expect(PlantStatusSchema.safeParse({ ...status, status: 'exploded' }).success).toBe(false);
  expect(PlantStatusSchema.safeParse({ ...status, loops: { level21: status.loops.tbt } }).success).toBe(false);
});

test('accepts the over phase', () => {
  expect(PlantStatusSchema.safeParse({ ...status, phase: 'over' }).success).toBe(true);
});
