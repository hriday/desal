import type { PlantEvent, PlantStatus, TelemetryReading } from '@desal/schema';

export const GAME_A = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
export const GAME_B = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';

/** A schema-valid status for `gameId` at `tick`. */
export function status(gameId: string, tick: number, shiftId: number | null = 1): PlantStatus {
  const pump = { running: true, overhaulRemainingTicks: 0 };
  const loop = { mode: 'auto' as const, setpoint: 1, output: 50 };
  return {
    gameId,
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

export const gameStart = (gameId: string): PlantEvent => ({ ...base(gameId), type: 'gameStart', mode: 'normal' });
export const gameRejected = (gameId: string): PlantEvent => ({ ...base(gameId), type: 'gameRejected', reason: 'capacity' });
export const gameEnd = (gameId: string, tick = 10): PlantEvent => ({
  ...base(gameId, tick),
  type: 'gameEnd',
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
