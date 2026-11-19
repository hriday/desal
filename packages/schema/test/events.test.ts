import { PlantEventSchema, type PlantEvent } from '../src/index.js';

const base = { tick: 10, plantTime: 600, shiftId: 3 };
const summary = {
  productM3: 1200, targetM3: 1500, offSpecMinutes: 4, fuelCostUsd: 900, fuelBudgetUsd: 1000, trips: 1,
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
];

test.each(events.map((e) => [e.type, e] as const))('round-trips %s through JSON', (_t, ev) => {
  expect(PlantEventSchema.parse(JSON.parse(JSON.stringify(ev)))).toEqual(ev);
});

test('covers every event type', () => {
  expect(new Set(events.map((e) => e.type)).size).toBe(10);
});

test('rejects unknown trip cause and missing envelope fields', () => {
  expect(PlantEventSchema.safeParse({ ...base, type: 'trip', cause: 'gremlins' }).success).toBe(false);
  expect(PlantEventSchema.safeParse({ type: 'online' }).success).toBe(false);
});
