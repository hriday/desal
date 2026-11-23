import type { CrewJob, GameMode, ShiftSummary } from '@desal/schema';
import { LOOP_RANGES, SHIFT_TICKS } from '../src/constants.js';
import { contaminationActive } from '../src/scenario/disaster/fuelContamination.js';
import { createInitialState, NOMINAL, type PlantState } from '../src/state.js';
import { tick } from '../src/tick.js';
import { env, GAME_ID } from './envelope.js';

/** Chlorine dose (mg/L) the bot runs while a bloom is on; the plant's normal dose is 1. */
const BLOOM_CHLORINE_MGL = 2;
const NORMAL_CHLORINE_MGL = 1;
/** TBT setpoint (C) the bot cuts to while the ejector is failed, to slow the vacuum loss (spec §4.3). */
const EJECTOR_CUT_TBT_C = LOOP_RANGES.tbt.spMin;
/** Ticks between restart attempts while the plant is tripped. */
const RESTART_RETRY_TICKS = 10;

/** The crew job that answers the worst fault on the plant now (most urgent first), or null. */
function crewJobFor(s: PlantState): CrewJob | null {
  const f = s.faults;
  if (f.ejectorFailed) return 'repairEjector';
  // The ejector-train faults trip the plant on vacuum within 15-36 minutes if left.
  if (f.airLeak) return 'sealLeak';
  if (f.coolingLoss) return 'cleanStrainer';
  if (f.tubeLeak) return 'plugTubes';
  if (f.fuelContamination && !contaminationActive(s)) return 'flushFuel';
  if (Object.keys(f.sensors).length > 0) return 'replaceSensor';
  if (f.stormRemainingTicks > 0 && !f.stormCleanedByCrew) return 'cleanScreens';
  if (f.tsunami?.surgeDone && !f.tsunami.cleanedAfterSurge) return 'cleanScreens';
  return null;
}

/** A tsunami is on and its screens are not yet cleaned after the surge: run one pump only. */
const tsunamiOn = (s: PlantState): boolean => s.faults.tsunami !== null && !s.faults.tsunami.cleanedAfterSurge;

export interface BotOptions {
  /** false: never dispatch the crew and live with the faults (default true). */
  crew?: boolean;
  /** The run's game mode (default Normal). */
  mode?: GameMode;
  /** true: only start each shift (in Auto) and send nothing else, the spec's "passive" player. */
  passive?: boolean;
}

/**
 * The commands an engaged operator sends this tick: it answers every event the way the spec
 * intends, and otherwise leaves the Auto plant alone (nominal setpoints, no chasing the target).
 * - a tripped or dipped pump: start a spare so two run;
 * - a tripped plant: restart it (the Auto sequence does the rest);
 * - a failed ejector: cut the TBT setpoint to slow the vacuum loss until the crew has repaired it;
 * - a controller fault: put that loop in Manual;
 * - low motive steam: switch on the standby steam line;
 * - an air leak: switch on the standby ejectors (off again once it is sealed);
 * - a bloom: raise the chlorine dose (back to normal at the next shift);
 * - a tube leak, failed ejector, failed sensor, storm, condenser cooling loss or air leak: dispatch
 *   the matching crew job;
 * - contaminated fuel: switch to the other fuel, have the crew flush the contaminated one, then
 *   switch back;
 * - a tsunami warning: stop pumps until one runs, and keep it at one through the surge; after the
 *   surge, have the crew clean the screens, then start the spare (the two-pumps rule).
 * With `passive`, it only starts each shift in Auto.
 */
export function engagedCommands(s: PlantState, ticks: number, opts: BotOptions = {}): Record<string, unknown>[] {
  if (s.phase === 'handover') return [env(s, { type: 'startShift', mode: 'auto' }, s.shift?.id ?? null)];
  if (s.phase !== 'running' || opts.passive) return [];
  const out: Record<string, unknown>[] = [];
  const cmd = (command: Record<string, unknown>) => out.push(env(s, command));
  const fired = s.chaos.active?.fired ?? [];
  const startedTick = s.shift?.startTick ?? s.tick;

  if (s.tick === startedTick && s.pretreat.chlorineMgL !== NORMAL_CHLORINE_MGL) {
    cmd({ type: 'setDose', chemical: 'chlorine', mgL: NORMAL_CHLORINE_MGL });
  }

  const pumps = Object.entries(s.intake.pumps);
  const running = pumps.filter(([, p]) => p.running);
  if (tsunamiOn(s)) {
    // Keep the least-worn running pump; stop the rest.
    const keep = [...running].sort(([, a], [, b]) => a.wear - b.wear)[0];
    for (const [id] of running) if (id !== keep?.[0]) cmd({ type: 'pump', pumpId: id, action: 'stop' });
  } else if (running.length < 2) {
    const spare = pumps.find(([, p]) => !p.running && p.overhaulRemainingTicks === 0 && p.wear < 1);
    if (spare) cmd({ type: 'pump', pumpId: spare[0], action: 'start' });
  }

  const contaminated = s.faults.fuelContamination?.fuel;
  const other = s.fuel.active === 'gas' ? 'backup' : 'gas';
  if (!s.fuel.changeover) {
    if (contaminationActive(s)) cmd({ type: 'selectFuel', fuel: other });
    else if (!contaminated) {
      // Back to the fuel the shift was on once the crew has flushed it.
      const flushed = fired.find((e) => e.kind === 'fuelContamination' && e.cleared);
      if (flushed && s.fuel.active !== flushed.params.fuel) cmd({ type: 'selectFuel', fuel: String(flushed.params.fuel) });
    }
  }

  if (s.status === 'tripped' && !s.restart && ticks % RESTART_RETRY_TICKS === 0) cmd({ type: 'restart' });

  const tbtSp = s.faults.ejectorFailed ? EJECTOR_CUT_TBT_C : NOMINAL.tbtC;
  if (s.loops.tbt.setpoint !== tbtSp) cmd({ type: 'setSetpoint', loop: 'tbt', value: tbtSp });

  for (const e of fired) {
    if (e.cleared) continue;
    if (e.kind === 'controllerFault') cmd({ type: 'setLoopMode', loop: String(e.params.loop), mode: 'manual' });
    if (e.kind === 'lowSteam' && !s.steam.standby) cmd({ type: 'standbySteam', on: true });
    if (e.kind === 'airLeak' && !s.ejectors.standby) cmd({ type: 'standbyEjectors', on: true });
    if (e.kind === 'bloom' && s.pretreat.chlorineMgL < BLOOM_CHLORINE_MGL) {
      cmd({ type: 'setDose', chemical: 'chlorine', mgL: BLOOM_CHLORINE_MGL });
    }
  }

  // The standby ejectors go back to standby once no airLeak is open (they cost money to run).
  if (s.ejectors.standby && !fired.some((e) => e.kind === 'airLeak' && !e.cleared)) cmd({ type: 'standbyEjectors', on: false });

  if (opts.crew !== false && !s.crew) {
    const job = crewJobFor(s);
    if (job) cmd({ type: 'dispatchCrew', job });
  }
  return out;
}

export interface RunResult {
  state: PlantState;
  /** The shift the run ended in (or reached), and why it ended (null if still alive). */
  shifts: number;
  reason: string | null;
  crewSpentUsd: number;
  /** The summary of every shift that ended, in order. */
  shiftEnds: ShiftSummary[];
}

/**
 * Play from `s` with the bot until the run ends or shift `maxShifts` has ended. `atHandover` may
 * change the state at each handover before the next shift starts (e.g. to force an event into the
 * pending plan).
 */
export function playFrom(
  start: PlantState,
  maxShifts: number,
  opts: BotOptions = {},
  atHandover: (s: PlantState) => PlantState = (s) => s,
): RunResult {
  let s = start;
  let crewSpentUsd = 0;
  let ticks = 0;
  const shiftEnds: ShiftSummary[] = [];
  while (s.phase !== 'over' && ticks < maxShifts * (SHIFT_TICKS + 1)) {
    if (s.phase === 'handover') s = atHandover(s);
    const r = tick(s, engagedCommands(s, ticks, opts));
    s = r.state;
    ticks++;
    for (const e of r.events) {
      if (e.type === 'accountChange' && e.cause === 'crew') crewSpentUsd -= e.deltaUsd;
      if (e.type === 'shiftEnd') shiftEnds.push(e.summary);
    }
    if (s.phase === 'handover' && s.run.shiftNumber >= maxShifts) break;
  }
  return { state: s, shifts: s.run.shiftNumber, reason: s.run.over?.reason ?? null, crewSpentUsd, shiftEnds };
}

/** Play seed `seed` for up to `maxShifts` with the engaged bot (or the passive one). */
export function engagedRun(seed: number, maxShifts: number, opts: BotOptions = {}): RunResult {
  return playFrom(createInitialState(seed, 0, GAME_ID, opts.mode ?? 'normal'), maxShifts, opts);
}

export const median = (xs: number[]): number => {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
};
