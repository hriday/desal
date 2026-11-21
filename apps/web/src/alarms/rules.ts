import type { PlantEvent, PlantStatus, ShiftTarget } from '@desal/schema';
import { usd } from '../equipment/format';
import { TRIP_TEXT } from '../expanded/labels';
import { DEFAULT_MAX_SALINITY_PPM, INTAKE_REQUIRED_BASE_M3H, INTAKE_REQUIRED_PER_C, STAGE_COUNT } from '../plantConstants';

export type MonitorId = 'intake' | 'heater' | 'stages' | 'product' | 'fuel' | 'shift';
/** The wall's monitors, in display order. */
export const MONITORS: readonly MonitorId[] = ['intake', 'heater', 'stages', 'product', 'fuel', 'shift'];

export type AlarmLevel = 'warn' | 'bad';
export interface Alarm { id: string; monitor: MonitorId; level: AlarmLevel; text: string }

/** What the rules need beyond status and readings: the current shift's target and its controller-fault hints. */
export interface AlarmContext { target?: ShiftTarget | null; faults?: string[] }

/** The shift's salinity limit when finite and positive, else DEFAULT_MAX_SALINITY_PPM. */
export function salinityLimit(target: ShiftTarget | null | undefined): number {
  const v = target?.maxSalinityPpm;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_SALINITY_PPM;
}

export function requiredIntakeM3h(seawaterC: number | undefined): number {
  const hot = Number.isFinite(seawaterC) ? Math.max(0, seawaterC! - 30) : 0;
  return INTAKE_REQUIRED_BASE_M3H * (1 + INTAKE_REQUIRED_PER_C * hot);
}

const PUMP_IDS = ['P-101', 'P-102', 'P-103'] as const;

const stageKey = (i: number) => `s${String(i).padStart(2, '0')}`;

/** The worst stage (1-based) for a per-stage reading, or null when none is known. */
function worstStage(readings: Record<string, number>, field: string): { n: number; v: number } | null {
  let best: { n: number; v: number } | null = null;
  for (let n = 1; n <= STAGE_COUNT; n++) {
    const v = readings[`stages.${stageKey(n)}.${field}`];
    if (Number.isFinite(v) && (best === null || v! > best.v)) best = { n, v: v! };
  }
  return best;
}

/** Monitor that owns a loop, for controller-fault hints ("Controller fault on loop tbt: drift."). */
export function faultMonitor(text: string): MonitorId {
  const loop = /loop (\w+)/.exec(text)?.[1];
  if (loop === 'tbt') return 'heater';
  if (loop === 'intakeFlow') return 'intake';
  if (loop === 'recirc' || loop === 'blowdown' || loop === 'vacuum' || loop === 'makeup' || loop?.startsWith('level')) return 'stages';
  return 'shift';
}

/** Client-side alarm rules (Plan 3 Task 3). A missing reading raises nothing. */
export function alarmsFor(status: PlantStatus | null, readings: Record<string, number>, ctx: AlarmContext = {}): Alarm[] {
  const out: Alarm[] = [];
  const r = (id: string): number | undefined => (Number.isFinite(readings[id]) ? readings[id] : undefined);
  const add = (id: string, monitor: MonitorId, level: AlarmLevel | null, text: string) => {
    if (level) out.push({ id, monitor, level, text });
  };
  const high = (v: number | undefined, warn: number, bad: number): AlarmLevel | null =>
    v === undefined ? null : v >= bad ? 'bad' : v >= warn ? 'warn' : null;
  const low = (v: number | undefined, warn: number, bad: number): AlarmLevel | null =>
    v === undefined ? null : v < bad ? 'bad' : v < warn ? 'warn' : null;

  // Intake
  const flow = r('intake.flowM3h');
  if (flow !== undefined) {
    const req = requiredIntakeM3h(r('intake.seawaterTempC'));
    const lvl = flow < req ? 'bad' : flow < req * 1.05 ? 'warn' : null;
    add('intakeFlow', 'intake', lvl, `Intake flow ${Math.round(flow).toLocaleString('en-US')} m³/h, need ${Math.round(req).toLocaleString('en-US')}`);
  }
  const fouling = r('intake.screenFouling');
  add('screen', 'intake', high(fouling, 0.3, 0.5), `Intake screen fouling ${fouling?.toFixed(2)}`);
  // A fast pump on fouled screens cavitates and wears (e.g. a storm's stopgap of more pump speed).
  for (const id of PUMP_IDS) {
    const cav = r(`intake.${id}.cavitation`);
    add(`cavitation-${id}`, 'intake', high(cav, 0.1, 0.5), `${id} cavitating ${cav?.toFixed(2)}: slow it or clean the screens`);
  }
  const chl = r('pretreat.chlorophyllUgL');
  add('chlorophyll', 'intake', high(chl, 4, Infinity), `Intake chlorophyll ${chl?.toFixed(1)} µg/L`);

  // Brine heater
  const tbt = r('heater.tbtC');
  // Warn where scaling turns severe (105 C); alarm short of the 115 C high-high trip.
  add('tbt', 'heater', high(tbt, 105, 113), `TBT high ${tbt?.toFixed(1)} °C`);

  // Flash stages
  const lvl = worstStage(readings, 'levelM');
  if (lvl) add('stageLevel', 'stages', high(lvl.v, 0.5, 0.65), `S${lvl.n} level high ${lvl.v.toFixed(2)} m`);
  const vac = r('vacuum.quality');
  add('vacuum', 'stages', low(vac, 0.8, 0.7), `Vacuum low ${vac?.toFixed(2)}`);
  const scale = worstStage(readings, 'hardScaleMm');
  if (scale) add('scale', 'stages', high(scale.v, 0.3, 0.6), `S${scale.n} hard scale ${scale.v.toFixed(2)} mm`);

  // Product water
  const sal = r('product.salinityPpm');
  if (sal !== undefined) {
    const limit = salinityLimit(ctx.target);
    const level = sal > limit ? 'bad' : sal >= 0.8 * limit ? 'warn' : null;
    add('salinity', 'product', level, `Salinity ${sal.toFixed(1)} ppm, limit ${limit}`);
  }

  // Fuel
  const tank = r('fuel.backupTonnes');
  add('backupTank', 'fuel', low(tank, 40, 10), `Backup tank low ${tank?.toFixed(0)} t`);
  if (typeof status?.fuel?.gasCurtailmentNotice === 'string') add('gasCurtail', 'fuel', 'warn', status.fuel.gasCurtailmentNotice);

  // Shift & account
  if (status?.status === 'tripped') add('tripped', 'shift', 'bad', `Plant tripped${typeof status.tripCause === 'string' ? `: ${TRIP_TEXT[status.tripCause] ?? status.tripCause}` : ''}`);
  const bal = Number.isFinite(status?.balanceUsd) ? status!.balanceUsd : undefined;
  add('balance', 'shift', low(bal, 5000, 0), `Balance ${usd(bal)}`);

  (ctx.faults ?? []).forEach((text, i) => add(`fault${i}`, faultMonitor(text), 'warn', text));
  return out;
}

/**
 * The alarm context for the current shift. The target is the status's live `shiftTarget` when given
 * (it follows a mid-shift demandChange), else the one from this shift's shiftStart event.
 *
 * Controller faults come from the status loops (`fault`), so a fault alarm lasts exactly as long as
 * the plant reports the fault. Only a status that carries no fault fields at all (an older
 * simulator) falls back to this shift's controllerFault events.
 */
export function alarmContext(
  events: readonly PlantEvent[], shiftId: number | null, liveTarget?: ShiftTarget | null, loops?: PlantStatus['loops'] | null,
): Required<AlarmContext> {
  let target: ShiftTarget | null = null;
  const eventFaults: string[] = [];
  if (shiftId === null) return { target, faults: [] };
  for (const e of events) {
    if (e.shiftId !== shiftId) continue;
    if (e.type === 'shiftStart') target = e.target;
    else if (e.type === 'scenario' && e.kind === 'controllerFault') eventFaults.push(e.message);
  }
  const reported = loops ? Object.entries(loops).filter(([, l]) => l !== undefined && 'fault' in l) : [];
  const faults = reported.length > 0
    ? reported.flatMap(([id, l]) => (l?.fault ? [`Controller fault on loop ${id}: ${l.fault}.`] : []))
    : eventFaults;
  return { target: liveTarget ?? target, faults };
}

/** What "seen" tracks: the alarm at its level, so a warning escalating to high alerts afresh. */
export const seenKey = (a: Alarm): string => `${a.id}:${a.level}`;

/** Alarms worst first (bad before warn), otherwise in their original order. */
export function byWorst(alarms: readonly Alarm[]): Alarm[] {
  return [...alarms].sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1));
}

/** A monitor's colour: its worst active alarm, or ok. */
export function worstLevel(alarms: readonly Alarm[], monitor: MonitorId): 'ok' | AlarmLevel {
  let w: 'ok' | AlarmLevel = 'ok';
  for (const a of alarms) {
    if (a.monitor !== monitor) continue;
    if (a.level === 'bad') return 'bad';
    w = 'warn';
  }
  return w;
}
