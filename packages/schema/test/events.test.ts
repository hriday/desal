import { PlantEventSchema, ScenarioKindSchema, SHARP_KINDS, type PlantEvent } from '../src/index.js';

const G = '3f2b8c1e-5d4a-4e7b-9a10-2c6d8e4f1a7b';
const base = { gameId: G, epoch: 0, seq: 0, tick: 10, plantTime: 600, shiftId: 3 };
const summary = {
  productM3: 1200, targetM3: 1500, offSpecMinutes: 4, fuelCostUsd: 900, fuelBudgetUsd: 1000, trips: 1, spentUsd: 900, offSpecM3: 12, nextAllocationUsd: 7760, balanceUsd: 14100, hell: false,
  events: [{ eventId: 1, kind: 'pumpTrip' as const, atMinute: 12, cleared: true, how: 'crew' as const }, { eventId: 2, kind: 'storm' as const, atMinute: 30, cleared: false, how: null }],
  damage: { maxHardScaleMm: 0.4, pumpWear: { 'P-101': 0.1, 'P-102': 0.2, 'P-103': 0.3 }, burnerCondition: 0.9 },
};

const events: PlantEvent[] = [
  { ...base, type: 'shiftStart', scenarioId: 's1', mode: 'auto', target: { productM3: 1500, maxSalinityPpm: 25, fuelBudgetUsd: 1000 }, hell: false, orders: { targetM3: 1500, maxSalinityPpm: 25, budgetUsd: 1000, lines: ['a'], briefing: [] } },
  { ...base, type: 'shiftEnd', summary },
  { ...base, type: 'trip', cause: 'tbtHighHigh' },
  { ...base, type: 'restartProgress', step: 'vacuum', ok: false, reason: 'low vacuum' },
  { ...base, type: 'restartProgress', step: 'ramp', ok: true },
  { ...base, type: 'online' },
  { ...base, type: 'scenario', kind: 'gasCurtailNotice', message: 'gas cut', eventId: 1, radio: 'Gas is being cut.' },
  { ...base, type: 'eventCleared', eventId: 1, kind: 'pumpTrip', how: 'player' },
  { ...base, type: 'fuelChangeover', from: 'gas', to: 'backup', phase: 'flameOut' },
  { ...base, type: 'deliveryArrived', tonnes: 20, grade: 'offgrade' },
  { ...base, type: 'commandRejected', commandId: 'c1', reason: 'tripped', shiftId: null },
  { ...base, type: 'damage', component: 'pump', value: 0.5 },
  { ...base, type: 'gameStart', callSign: 'Kestrel-42', mode: 'normal' },
  { ...base, type: 'gameRejected', reason: 'capacity' },
  { ...base, type: 'gameEnd', callSign: 'Kestrel-42', mode: 'normal', reason: 'bankrupt', score: { shiftsCompleted: 2, totalProductM3: 7000, balanceUsd: -5 } },
  { ...base, type: 'accountChange', deltaUsd: -6000, balanceUsd: 34000, cause: 'acidClean' },
  { ...base, type: 'accountChange', deltaUsd: 9700, balanceUsd: 24000, cause: 'allocation' },
];

test.each(events.map((e) => [e.type, e] as const))('round-trips %s through JSON', (_t, ev) => {
  expect(PlantEventSchema.parse(JSON.parse(JSON.stringify(ev)))).toEqual(ev);
});

test('covers every event type', () => {
  expect(new Set(events.map((e) => e.type)).size).toBe(15);
});

test('the account has no revenue or fines: those causes and summary fields are gone', () => {
  for (const cause of ['revenue', 'offSpecFine', 'shortfallFine']) {
    expect(PlantEventSchema.safeParse({ ...base, type: 'accountChange', deltaUsd: 1, balanceUsd: 1, cause }).success).toBe(false);
  }
  const { spentUsd: _s, ...noSpent } = summary;
  expect(PlantEventSchema.safeParse({ ...base, type: 'shiftEnd', summary: noSpent }).success).toBe(false);
});

test('gameEnd without runId parses (the browser view); gameStart needs a callSign', () => {
  const end = { ...base, type: 'gameEnd', callSign: 'Kestrel-42', reason: 'quit', score: { shiftsCompleted: 1, totalProductM3: 10, balanceUsd: 0 } };
  expect(PlantEventSchema.safeParse(end).success).toBe(true);
  expect(PlantEventSchema.safeParse({ ...end, runId: G }).success).toBe(true);
  expect(PlantEventSchema.safeParse({ ...base, type: 'gameStart', mode: 'normal' }).success).toBe(false);
  expect(PlantEventSchema.safeParse({ ...base, type: 'shiftEnd', summary, runId: G }).success).toBe(true);
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

test('a scenario event needs an eventId', () => {
  const ev = { ...base, type: 'scenario', kind: 'storm', message: 'm', radio: 'r' };
  expect(PlantEventSchema.safeParse(ev).success).toBe(false);
  expect(PlantEventSchema.safeParse({ ...ev, eventId: 1 }).success).toBe(true);
  expect(PlantEventSchema.safeParse({ ...ev, eventId: 0 }).success).toBe(false);
});

test('SHARP_KINDS lists the six sharp scenario kinds', () => {
  expect(SHARP_KINDS).toHaveLength(6);
  for (const k of SHARP_KINDS) expect(ScenarioKindSchema.safeParse(k).success).toBe(true);
});
