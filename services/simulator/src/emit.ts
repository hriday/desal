import type { LoopId, PlantStatus, PumpId, TelemetryReading, UnitId } from '@desal/schema';
import { PUMP_WEAR_FLOW_LOSS, SHIFT_TICKS, STAGE_COUNT } from './constants.js';
import { paceOf } from './pace.js';
import { measured } from './sensors.js';
import type { Loop, LoopSensorId, PlantState } from './state.js';

type Sensor = { id: string; unitId: UnitId; read: (s: PlantState) => number; loop?: LoopSensorId };

const PUMP_IDS: readonly PumpId[] = ['P-101', 'P-102', 'P-103'];

/**
 * Flow through one pump: its share of the intake flow by available capacity among running pumps.
 * Screen fouling and speed are common to all pumps, so only wear differentiates them.
 */
function pumpFlowM3h(s: PlantState, id: PumpId): number {
  const capacity = (p: PlantState['intake']['pumps'][PumpId]): number =>
    p.running ? 1 - PUMP_WEAR_FLOW_LOSS * p.wear : 0;
  const total = PUMP_IDS.reduce((sum, p) => sum + capacity(s.intake.pumps[p]), 0);
  return total > 0 ? (s.intake.flowM3h * capacity(s.intake.pumps[id])) / total : 0;
}

const stageKey = (i: number): string => `s${String(i + 1).padStart(2, '0')}`;

/** Four readings per stage. The last stage's level is the brine pool, the makeup loop's process value. */
function stageSensors(i: number): Sensor[] {
  const k = stageKey(i);
  const st = (s: PlantState) => s.stages[i]!;
  const pool = i === STAGE_COUNT - 1;
  return [
    { id: `stages.${k}.tempC`, unitId: 'stages', read: (s) => st(s).tempC },
    { id: `stages.${k}.levelM`, unitId: 'stages', read: (s) => st(s).levelM, ...(pool ? { loop: 'makeup' as const } : {}) },
    { id: `stages.${k}.softScaleMm`, unitId: 'stages', read: (s) => st(s).softScaleMm },
    { id: `stages.${k}.hardScaleMm`, unitId: 'stages', read: (s) => st(s).hardScaleMm },
  ];
}

const SENSORS: readonly Sensor[] = [
  ...PUMP_IDS.flatMap((id): Sensor[] => [
    { id: `intake.${id}.flowM3h`, unitId: 'intake', read: (s) => pumpFlowM3h(s, id) },
    { id: `intake.${id}.wear`, unitId: 'intake', read: (s) => s.intake.pumps[id].wear },
    { id: `intake.${id}.cavitation`, unitId: 'intake', read: (s) => s.intake.pumps[id].cavitation },
  ]),
  { id: 'intake.flowM3h', unitId: 'intake', read: (s) => s.intake.flowM3h, loop: 'intakeFlow' },
  { id: 'intake.screenFouling', unitId: 'intake', read: (s) => s.intake.screenFouling },
  { id: 'intake.seawaterTempC', unitId: 'intake', read: (s) => s.seawater.tempC },
  { id: 'pretreat.chlorophyllUgL', unitId: 'pretreat', read: (s) => s.seawater.chlorophyllUgL },
  { id: 'heater.tbtC', unitId: 'heater', read: (s) => s.heater.tbtC, loop: 'tbt' },
  { id: 'heater.firingPct', unitId: 'heater', read: (s) => s.heater.firingPct },
  { id: 'heater.heatMW', unitId: 'heater', read: (s) => s.heater.heatMW },
  { id: 'heater.burnerCondition', unitId: 'heater', read: (s) => s.heater.burnerCondition },
  ...Array.from({ length: STAGE_COUNT }, (_, i) => stageSensors(i)).flat(),
  { id: 'brine.recircM3h', unitId: 'brine', read: (s) => s.brine.recircM3h, loop: 'recirc' },
  { id: 'brine.concentrationFactor', unitId: 'brine', read: (s) => s.brine.concentrationFactor, loop: 'blowdown' },
  { id: 'brine.blowdownM3h', unitId: 'brine', read: (s) => s.brine.blowdownM3h },
  { id: 'brine.makeupM3h', unitId: 'brine', read: (s) => s.brine.makeupM3h },
  // Cooling seawater returned to sea after the reject-stage tubes: what the makeup does not take.
  { id: 'brine.coolingRejectM3h', unitId: 'brine', read: (s) => s.intake.flowM3h - s.brine.makeupM3h },
  { id: 'vacuum.quality', unitId: 'vacuum', read: (s) => s.vacuum.quality, loop: 'vacuum' },
  { id: 'vacuum.motiveSteamBar', unitId: 'vacuum', read: (s) => s.steam.motiveBar },
  { id: 'product.flowM3h', unitId: 'product', read: (s) => s.product.flowM3h },
  { id: 'product.salinityPpm', unitId: 'product', read: (s) => s.product.salinityPpm },
  { id: 'product.shiftProductM3', unitId: 'product', read: (s) => s.shift?.acc.productM3 ?? 0 },
  { id: 'fuel.gasCapMW', unitId: 'fuel', read: (s) => s.fuel.gas.capMW },
  { id: 'fuel.gasPriceUsdPerGJ', unitId: 'fuel', read: (s) => s.fuel.gas.priceUsdPerGJ },
  { id: 'fuel.backupTonnes', unitId: 'fuel', read: (s) => s.fuel.backup.tonnes },
  { id: 'fuel.burnMW', unitId: 'fuel', read: (s) => s.fuel.burnMW },
  { id: 'fuel.shiftCostUsd', unitId: 'fuel', read: (s) => s.shift?.acc.fuelCostUsd ?? 0 },
];

/** Every telemetry sensor id, in emission order. Dotted form, e.g. `stages.s02.levelM`, `intake.P-101.wear`. */
export const SENSOR_IDS: readonly string[] = Object.freeze(SENSORS.map((x) => x.id));

/** One reading per SENSOR_IDS entry for the current state. Requires a shift (telemetry is emitted only while running). */
export function toTelemetry(s: PlantState): TelemetryReading[] {
  const shiftId = s.shift?.id ?? 0;
  return SENSORS.map(({ id, unitId, read, loop }) => ({
    gameId: s.run.gameId,
    epoch: s.run.epoch,
    sensorId: id,
    unitId,
    shiftId,
    tick: s.tick,
    plantTime: s.plantTime,
    value: loop ? measured(s, loop, read(s)) : read(s),
  }));
}

const loopView = (l: Loop) => ({ mode: l.mode, setpoint: l.setpoint, output: l.output, fault: l.fault?.kind ?? null });

/** Pending fuel deliveries as the player sees them: time until arrival, never absolute ticks. */
const deliveryView = (s: PlantState) =>
  s.fuel.deliveries.map((d) => ({ arrivesInTicks: Math.max(0, d.arrivesAtTick - s.tick), tonnes: d.tonnes, grade: d.grade }));

export function toStatus(s: PlantState): PlantStatus {
  const loops: Partial<Record<LoopId, ReturnType<typeof loopView>>> = {
    tbt: loopView(s.loops.tbt),
    intakeFlow: loopView(s.loops.intakeFlow),
    recirc: loopView(s.loops.recirc),
    blowdown: loopView(s.loops.blowdown),
    vacuum: loopView(s.loops.vacuum),
    makeup: loopView(s.loops.makeup),
  };
  s.loops.levels.forEach((l, i) => {
    loops[`level${i + 1}`] = loopView(l);
  });
  const notice = s.fuel.gas.curtailmentNotice;
  // endShift keeps s.shift (the finished shift's record) until the next startShift, so the phase
  // decides: in handover or over there is no live shift, hence no target and no ticks remaining.
  const inShift = s.shift !== null && (s.phase === 'running' || s.phase === 'paused');
  return {
    gameId: s.run.gameId,
    epoch: s.run.epoch,
    callSign: s.run.callSign,
    shiftNumber: s.run.shiftNumber,
    balanceUsd: s.run.balanceUsd,
    tick: s.tick,
    plantTime: s.plantTime,
    shiftId: s.shift?.id ?? null,
    phase: s.phase,
    status: s.status,
    controlMode: s.controlMode,
    tripCause: s.trip?.cause ?? null,
    restartStep: s.restart?.step ?? null,
    loops: loops as PlantStatus['loops'],
    pumps: Object.fromEntries(PUMP_IDS.map((id) => [id, { running: s.intake.pumps[id].running, overhaulRemainingTicks: s.intake.pumps[id].overhaulRemainingTicks }])) as PlantStatus['pumps'],
    fuel: {
      active: s.fuel.active,
      changeoverTo: s.fuel.changeover?.to ?? null,
      changeoverRemainingTicks: s.fuel.changeover?.remainingTicks ?? null,
      backupGrade: s.fuel.backup.grade,
      gasCurtailmentNotice: notice ? `Gas capped at ${notice.capMW} MW from tick ${notice.atTick}` : null,
      gasPriceUsdPerGJ: s.fuel.gas.priceUsdPerGJ,
      gasCapMW: s.fuel.gas.capMW,
      backupPriceUsdPerGJ: s.fuel.backup.priceUsdPerGJ,
    },
    doses: { chlorineMgL: s.pretreat.chlorineMgL, antiscalantMgL: s.pretreat.antiscalantMgL },
    shiftTarget: inShift ? { ...s.shift!.target } : null,
    ballCleaning: s.ballCleaning,
    divertToDrain: s.product.divertToDrain,
    divertMode: s.product.divertMode,
    standbySteam: s.steam.standby,
    standbyEjectors: s.ejectors.standby,
    shiftTicksRemaining: inShift ? Math.max(0, SHIFT_TICKS - (s.tick - s.shift!.startTick)) : 0,
    deliveries: deliveryView(s),
    acidCleanRemainingTicks: s.acidCleanRemainingTicks,
    restartAuto: s.restart?.auto ?? null,
    offeredGrade: s.scenario.effects.offgradeOnly ? 'offgrade' : 'standard',
    shiftProductM3: s.shift?.acc.productM3 ?? 0,
    shiftOffSpecM3: s.shift?.acc.offSpecM3 ?? 0,
    productFlowM3h: s.product.flowM3h,
    crew: s.crew ? { job: s.crew.job, remainingTicks: s.crew.remainingTicks } : null,
    // Handover shows the pending orders; a live shift shows the active ones.
    orders: s.phase === 'handover' ? (s.chaos.pending?.orders ?? null) : inShift ? (s.chaos.active?.plan.orders ?? null) : null,
    mode: s.run.mode,
    // Never exposed in handover, so an unwarned hell shift cannot be peeked at.
    hell: s.phase === 'running' ? (s.chaos.active?.plan.hell ?? null) : null,
    pace: paceOf(s),
  };
}
