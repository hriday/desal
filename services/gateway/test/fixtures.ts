import type { Leaderboard, PlantEvent, PlantStatus, ShiftReport, TelemetryReading } from '@desal/schema';

export const GAME_A = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
export const GAME_B = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
export const CALL_SIGN = 'Kestrel-42';
/** The private runId the simulator puts on gameEnd and shiftEnd (never sent to a browser). */
export const RUN_A = '3f2a7c1e-8d4b-4e6f-a1b2-c3d4e5f60718';

/** A schema-valid status for `gameId` at `tick`. */
export function status(gameId: string, tick: number, shiftId: number | null = 1): PlantStatus {
  const pump = { running: true, overhaulRemainingTicks: 0 };
  const loop = { mode: 'auto' as const, setpoint: 1, output: 50 };
  return {
    gameId,
    callSign: CALL_SIGN,
    epoch: 0,
    mode: 'normal',
    pace: 'calm',
    shiftNumber: 1,
    balanceUsd: 15000,
    tick,
    plantTime: tick * 40,
    shiftId,
    phase: 'running',
    status: 'online',
    controlMode: 'auto',
    tripCause: null,
    restartStep: null,
    loops: { tbt: loop, intakeFlow: loop, recirc: loop, blowdown: loop, vacuum: loop, makeup: loop },
    pumps: { 'P-101': pump, 'P-102': pump, 'P-103': { running: false, overhaulRemainingTicks: 0 } },
    fuel: {
      active: 'gas',
      changeoverTo: null,
      changeoverRemainingTicks: null,
      backupGrade: 'standard',
      gasCurtailmentNotice: null,
      gasPriceUsdPerGJ: 8,
      gasCapMW: 100,
      backupPriceUsdPerGJ: 12,
    },
    doses: { chlorineMgL: 1.5, antiscalantMgL: 2 },
    shiftTarget: null,
    ballCleaning: false,
    divertToDrain: false,
    divertMode: 'auto',
    standbySteam: false,
    shiftTicksRemaining: 720 - tick,
    deliveries: [],
    acidCleanRemainingTicks: 0,
    restartAuto: null,
    offeredGrade: 'standard',
    shiftProductM3: 0,
    shiftOffSpecM3: 0,
    productFlowM3h: 0,
    crew: null,
    orders: null,
    hell: null,
  };
}

const base = (gameId: string, tick = 0) => ({ gameId, epoch: 0, seq: tick, tick, plantTime: tick * 40, shiftId: null });

export const gameStart = (gameId: string): PlantEvent => ({ ...base(gameId), type: 'gameStart', callSign: CALL_SIGN, mode: 'normal' });
export const gameRejected = (gameId: string): PlantEvent => ({ ...base(gameId), type: 'gameRejected', reason: 'capacity' });
export const gameEnd = (gameId: string, tick = 10, runId?: string): PlantEvent => ({
  ...base(gameId, tick),
  type: 'gameEnd',
  callSign: CALL_SIGN,
  ...(runId ? { runId } : {}),
  mode: 'normal',
  reason: 'quit',
  score: { shiftsCompleted: 0, totalProductM3: 0, balanceUsd: 15000 },
});
export const online = (gameId: string, tick = 1): PlantEvent => ({ ...base(gameId, tick), type: 'online' });
/** The simulator's answer to a command for a game it does not have (a host-level event). */
export const noSuchGame = (gameId: string): PlantEvent => ({
  ...base(gameId),
  host: true,
  type: 'commandRejected',
  commandId: '00000000-0000-4000-8000-00000000abcd',
  reason: 'no such game',
});

export function reading(gameId: string, tick: number, sensorId: string, value = tick, epoch = 0): TelemetryReading {
  return { gameId, epoch, sensorId, unitId: 'stages', shiftId: 1, tick, plantTime: tick * 40, value };
}

export const shiftEnd = (gameId: string, runId?: string, tick = 720): PlantEvent => ({
  ...base(gameId, tick),
  shiftId: 1,
  type: 'shiftEnd',
  ...(runId ? { runId } : {}),
  summary: {
    productM3: 4000,
    targetM3: 4500,
    offSpecMinutes: 12,
    offSpecM3: 80,
    fuelCostUsd: 9000,
    fuelBudgetUsd: 10000,
    trips: 1,
    spentUsd: 11000,
    nextAllocationUsd: 14000,
    balanceUsd: 18000,
    damage: { maxHardScaleMm: 0.1, pumpWear: { 'P-101': 0.1, 'P-102': 0.1, 'P-103': 0 }, burnerCondition: 0.9 },
    hell: false,
    events: [{ eventId: 1, kind: 'pumpTrip', atMinute: 30, cleared: true, how: 'player' }],
  },
});

/** A schema-valid shift report card (a shift.reports value). */
export function report(shiftId = 1): ShiftReport {
  return {
    shiftId,
    epoch: 0,
    mode: 'normal',
    grade: 'B',
    score: 81,
    targetM3: 4500,
    productM3: 4000,
    offSpecM3: 80,
    offSpecMinutes: 12,
    trips: 1,
    spentUsd: 11000,
    minutesTripped: 4,
    self: { shiftId, targetPct: 89, handledWell: 1, handledOf: 1, minutesTripped: 4 },
    events: [{ eventId: 1, kind: 'pumpTrip', atMinute: 30, responseMinutes: 2, clearMinutes: 6, outcome: 'cleared by you', verdict: 'quick' }],
    pace: [{ hour: 1, productM3: 500, targetM3: 562.5 }],
    vsPrevious: null,
    vsBest: null,
  };
}

export const RUN_B = '8e7d6c5b-4a39-4281-b7f6-e5d4c3b2a190';
export const RUN_C = 'c0ffee00-1234-4abc-8def-0123456789ab';

/** A leaderboard record (the leaderboard topic's value) with rows, and so runIds, on both boards. */
export function board(): Leaderboard {
  const row = (rank: number, callSign: string, runId: string) => ({
    rank,
    callSign,
    shiftsCompleted: 3,
    totalProductM3: 12000 - rank,
    endedAt: 1_763_500_000_000,
    runId,
  });
  return {
    updatedAt: 1_763_500_005_000,
    online: 4,
    normal: {
      allTime: [row(1, 'Kestrel-42', RUN_A), row(2, 'Heron-7', RUN_B)],
      today: [row(1, 'Kestrel-42', RUN_A)],
      stats: [{ kind: 'pumpTrip', operators: 5, firstHandledWellPct: 60 }],
    },
    hard: { allTime: [row(1, 'Osprey-3', RUN_C)], today: [], stats: [] },
  };
}
