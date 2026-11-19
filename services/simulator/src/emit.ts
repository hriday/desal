import type { LoopId, PlantStatus, PumpId, TelemetryReading, UnitId } from '@desal/schema';
import { PUMP_WEAR_FLOW_LOSS, SHIFT_TICKS, STAGE_COUNT } from './constants.js';
import type { Loop, PlantState } from './state.js';

type Sensor = { id: string; unitId: UnitId; read: (s: PlantState) => number };

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

function stageSensors(i: number): Sensor[] {
  const k = stageKey(i);
  const st = (s: PlantState) => s.stages[i]!;
  return [
    { id: `stages.${k}.tempC`, unitId: 'stages', read: (s) => st(s).tempC },
    { id: `stages.${k}.levelM`, unitId: 'stages', read: (s) => st(s).levelM },
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
  { id: 'intake.flowM3h', unitId: 'intake', read: (s) => s.intake.flowM3h },
  { id: 'intake.screenFouling', unitId: 'intake', read: (s) => s.intake.screenFouling },
  { id: 'intake.seawaterTempC', unitId: 'intake', read: (s) => s.seawater.tempC },
  { id: 'pretreat.chlorophyllUgL', unitId: 'pretreat', read: (s) => s.seawater.chlorophyllUgL },
  { id: 'heater.tbtC', unitId: 'heater', read: (s) => s.heater.tbtC },
  { id: 'heater.firingPct', unitId: 'heater', read: (s) => s.heater.firingPct },
  { id: 'heater.heatMW', unitId: 'heater', read: (s) => s.heater.heatMW },
  { id: 'heater.burnerCondition', unitId: 'heater', read: (s) => s.heater.burnerCondition },
  ...Array.from({ length: STAGE_COUNT }, (_, i) => stageSensors(i)).flat(),
  { id: 'brine.recircM3h', unitId: 'brine', read: (s) => s.brine.recircM3h },
  { id: 'brine.concentrationFactor', unitId: 'brine', read: (s) => s.brine.concentrationFactor },
  { id: 'brine.blowdownM3h', unitId: 'brine', read: (s) => s.brine.blowdownM3h },
  { id: 'vacuum.quality', unitId: 'vacuum', read: (s) => s.vacuum.quality },
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
  return SENSORS.map(({ id, unitId, read }) => ({
    gameId: s.run.gameId,
    sensorId: id,
    unitId,
    shiftId,
    tick: s.tick,
    plantTime: s.plantTime,
    value: read(s),
  }));
}

const loopView = (l: Loop) => ({ mode: l.mode, setpoint: l.setpoint, output: l.output });

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
    shiftTicksRemaining: inShift ? Math.max(0, SHIFT_TICKS - (s.tick - s.shift!.startTick)) : 0,
    deliveries: deliveryView(s),
    acidCleanRemainingTicks: s.acidCleanRemainingTicks,
    restartAuto: s.restart?.auto ?? null,
    offeredGrade: s.scenario.effects.offgradeOnly ? 'offgrade' : 'standard',
  };
}
