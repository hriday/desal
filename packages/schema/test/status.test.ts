import { PlantStatusSchema } from '../src/index.js';
import { status } from './fixtures.js';

test('a valid status round-trips through JSON', () => {
  expect(PlantStatusSchema.parse(JSON.parse(JSON.stringify(status)))).toEqual(status);
});

test('rejects an invalid phase, status and loop key', () => {
  expect(PlantStatusSchema.safeParse({ ...status, phase: 'napping' }).success).toBe(false);
  expect(PlantStatusSchema.safeParse({ ...status, status: 'exploded' }).success).toBe(false);
  expect(PlantStatusSchema.safeParse({ ...status, loops: { level24: status.loops.tbt } }).success).toBe(false);
});

test('accepts the over phase', () => {
  expect(PlantStatusSchema.safeParse({ ...status, phase: 'over' }).success).toBe(true);
});

test('rejects non-finite new fields and accepts null shiftTarget / changeoverRemainingTicks', () => {
  const nulls = { ...status, shiftTarget: null, fuel: { ...status.fuel, changeoverRemainingTicks: null } };
  expect(PlantStatusSchema.safeParse(nulls).success).toBe(true);
  expect(PlantStatusSchema.safeParse({ ...status, doses: { chlorineMgL: Infinity, antiscalantMgL: 1 } }).success).toBe(false);
  expect(PlantStatusSchema.safeParse({ ...status, fuel: { ...status.fuel, gasCapMW: NaN } }).success).toBe(false);
});

test('crew, orders and hell are required; null crew parses', () => {
  const { crew: _c, ...noCrew } = status;
  expect(PlantStatusSchema.safeParse(noCrew).success).toBe(false);
  expect(PlantStatusSchema.safeParse({ ...status, crew: null, orders: null, hell: true }).success).toBe(true);
});

test('pace defaults to calm when missing; only calm and busy parse', () => {
  const { pace: _p, ...noPace } = status;
  expect(PlantStatusSchema.parse(noPace).pace).toBe('calm');
  expect(PlantStatusSchema.parse({ ...status, pace: 'busy' }).pace).toBe('busy');
  expect(PlantStatusSchema.safeParse({ ...status, pace: 'fast' }).success).toBe(false);
});

test('a status without divertMode and standbySteam (an older simulator) parses to manual and off', () => {
  const { divertMode: _m, standbySteam: _s, ...old } = status;
  const parsed = PlantStatusSchema.parse(old);
  expect(parsed.divertMode).toBe('manual');
  expect(parsed.standbySteam).toBe(false);
});
