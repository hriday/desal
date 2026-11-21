import { PlantEventSchema, type PlantEvent } from '../src/index.js';

const G = '3f2b8c1e-5d4a-4e7b-9a10-2c6d8e4f1a7b';
const base = { gameId: G, epoch: 0, seq: 0, tick: 10, plantTime: 600, shiftId: 3 };
const summary = {
  productM3: 1200, targetM3: 1500, offSpecMinutes: 4, fuelCostUsd: 900, fuelBudgetUsd: 1000, trips: 1, spentUsd: 900, offSpecM3: 12, nextAllocationUsd: 7760, balanceUsd: 14100,
  damage: { maxHardScaleMm: 0.4, pumpWear: { 'P-101': 0.1, 'P-102': 0.2, 'P-103': 0.3 }, burnerCondition: 0.9 },
};

const events: PlantEvent[] = [
  { ...base, type: 'shiftStart', scenarioId: 's1', mode: 'auto', target: { productM3: 1500, maxSalinityPpm: 25, fuelBudgetUsd: 1000 } },
  { ...base, type: 'shiftEnd', summary },
  { ...base, type: 'trip', cause: 'tbtHighHigh' },
  { ...base, type: 'restartProgress', step: 'vacuum', ok: false, reason: 'low vacuum' },
  { ...base, type: 'restartProgress', step: 'ramp', ok: true },
  { ...base, type: 'online' },
  { ...base, type: 'scenario', kind: 'gasCurtailNotice', message: 'gas cut' },
  { ...base, type: 'fuelChangeover', from: 'gas', to: 'backup', phase: 'flameOut' },
  { ...base, type: 'deliveryArrived', tonnes: 20, grade: 'offgrade' },
  { ...base, type: 'commandRejected', commandId: 'c1', reason: 'tripped', shiftId: null },
  { ...base, type: 'damage', component: 'pump', value: 0.5 },
  { ...base, type: 'gameStart' },
  { ...base, type: 'gameRejected', reason: 'capacity' },
  { ...base, type: 'gameEnd', reason: 'bankrupt', score: { shiftsCompleted: 2, totalProductM3: 7000, balanceUsd: -5 } },
  { ...base, type: 'accountChange', deltaUsd: -6000, balanceUsd: 34000, cause: 'acidClean' },
  { ...base, type: 'accountChange', deltaUsd: 9700, balanceUsd: 24000, cause: 'allocation' },
];

test.each(events.map((e) => [e.type, e] as const))('round-trips %s through JSON', (_t, ev) => {
  expect(PlantEventSchema.parse(JSON.parse(JSON.stringify(ev)))).toEqual(ev);
});

test('covers every event type', () => {
  expect(new Set(events.map((e) => e.type)).size).toBe(14);
});

test('the account has no revenue or fines: those causes and summary fields are gone', () => {
  for (const cause of ['revenue', 'offSpecFine', 'shortfallFine']) {
    expect(PlantEventSchema.safeParse({ ...base, type: 'accountChange', deltaUsd: 1, balanceUsd: 1, cause }).success).toBe(false);
  }
  const { spentUsd: _s, ...noSpent } = summary;
  expect(PlantEventSchema.safeParse({ ...base, type: 'shiftEnd', summary: noSpent }).success).toBe(false);
});

test('rejects unknown trip cause and missing envelope fields', () => {
  expect(PlantEventSchema.safeParse({ ...base, type: 'trip', cause: 'gremlins' }).success).toBe(false);
  expect(PlantEventSchema.safeParse({ type: 'online' }).success).toBe(false);
});

test('rejects a negative or fractional seq and a missing gameId', () => {
  expect(PlantEventSchema.safeParse({ ...base, type: 'online', seq: -1 }).success).toBe(false);
  expect(PlantEventSchema.safeParse({ ...base, type: 'online', seq: 1.5 }).success).toBe(false);
  const { gameId: _g, ...noGame } = base;
  expect(PlantEventSchema.safeParse({ ...noGame, type: 'online' }).success).toBe(false);
});

test('epoch is required on every event: a non-negative integer', () => {
  const { epoch: _e, ...noEpoch } = base;
  expect(PlantEventSchema.safeParse({ ...noEpoch, type: 'online' }).success).toBe(false);
  expect(PlantEventSchema.safeParse({ ...base, type: 'online', epoch: -1 }).success).toBe(false);
  expect(PlantEventSchema.safeParse({ ...base, type: 'online', epoch: 2 }).success).toBe(true);
});
