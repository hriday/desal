import type { PlantEvent, PlantStatus, TelemetryReading } from '@desal/schema';

export const GAME_A = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
export const GAME_B = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';

/** A schema-valid status for `gameId` at `tick`. */
export function status(gameId: string, tick: number, shiftId: number | null = 1): PlantStatus {
  const pump = { running: true, overhaulRemainingTicks: 0 };
  const loop = { mode: 'auto' as const, setpoint: 1, output: 50 };
  return {
    gameId,
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
    loops: { tbt: loop, intakeFlow: loop, recirc: loop, blowdown: loop, vacuum: loop },
    pumps: { 'P-101': pump, 'P-102': pump, 'P-103': { running: false, overhaulRemainingTicks: 0 } },
    fuel: { active: 'gas', changeoverTo: null, backupGrade: 'standard', gasCurtailmentNotice: null },
    ballCleaning: false,
    divertToDrain: false,
    shiftTicksRemaining: 720 - tick,
    deliveries: [],
    acidCleanRemainingTicks: 0,
    restartAuto: null,
    offeredGrade: 'standard',
  };
}

const base = (gameId: string, tick = 0) => ({ gameId, seq: tick, tick, plantTime: tick * 40, shiftId: null });

export const gameStart = (gameId: string): PlantEvent => ({ ...base(gameId), type: 'gameStart' });
export const gameRejected = (gameId: string): PlantEvent => ({ ...base(gameId), type: 'gameRejected', reason: 'capacity' });
export const gameEnd = (gameId: string, tick = 10): PlantEvent => ({
  ...base(gameId, tick),
  type: 'gameEnd',
  reason: 'quit',
  score: { shiftsCompleted: 0, totalProductM3: 0, balanceUsd: 15000 },
});
export const online = (gameId: string, tick = 1): PlantEvent => ({ ...base(gameId, tick), type: 'online' });

export function reading(gameId: string, tick: number, sensorId: string, value = tick): TelemetryReading {
  return { gameId, sensorId, unitId: 'stages', shiftId: 1, tick, plantTime: tick * 40, value };
}
