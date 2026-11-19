import type { CrewJob } from '@desal/schema';
import { LOOP_RANGES, SHIFT_TICKS } from '../src/constants.js';
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
function crewJobFor(f: PlantState['faults']): CrewJob | null {
  if (f.ejectorFailed) return 'repairEjector';
  if (f.tubeLeak) return 'plugTubes';
  if (Object.keys(f.sensors).length > 0) return 'replaceSensor';
  if (f.stormRemainingTicks > 0 && !f.stormCleanedByCrew) return 'cleanScreens';
  return null;
}

export interface BotOptions {
  /** false: never dispatch the crew and live with the faults (default true). */
  crew?: boolean;
}

/**
 * The commands an engaged operator sends this tick: it answers every event the way the spec
 * intends, and otherwise leaves the Auto plant alone (nominal setpoints, no chasing the target).
 * - a tripped or dipped pump: start a spare so two run;
 * - a tripped plant: restart it (the Auto sequence does the rest);
 * - a failed ejector: cut the TBT setpoint to slow the vacuum loss until the crew has repaired it;
 * - a controller fault: put that loop in Manual;
 * - a bloom: raise the chlorine dose (back to normal at the next shift);
 * - a tube leak, failed ejector, failed sensor or storm: dispatch the matching crew job.
 */
export function engagedCommands(s: PlantState, ticks: number, opts: BotOptions = {}): Record<string, unknown>[] {
  if (s.phase === 'handover') return [env(s, { type: 'startShift', mode: 'auto' }, s.shift?.id ?? null)];
  if (s.phase !== 'running') return [];
  const out: Record<string, unknown>[] = [];
  const cmd = (command: Record<string, unknown>) => out.push(env(s, command));
  const fired = s.chaos.active?.fired ?? [];
  const startedTick = s.shift?.startTick ?? s.tick;

  if (s.tick === startedTick && s.pretreat.chlorineMgL !== NORMAL_CHLORINE_MGL) {
    cmd({ type: 'setDose', chemical: 'chlorine', mgL: NORMAL_CHLORINE_MGL });
  }

  const pumps = Object.entries(s.intake.pumps);
  if (pumps.filter(([, p]) => p.running).length < 2) {
    const spare = pumps.find(([, p]) => !p.running && p.overhaulRemainingTicks === 0 && p.wear < 1);
    if (spare) cmd({ type: 'pump', pumpId: spare[0], action: 'start' });
  }

  if (s.status === 'tripped' && !s.restart && ticks % RESTART_RETRY_TICKS === 0) cmd({ type: 'restart' });

  const tbtSp = s.faults.ejectorFailed ? EJECTOR_CUT_TBT_C : NOMINAL.tbtC;
  if (s.loops.tbt.setpoint !== tbtSp) cmd({ type: 'setSetpoint', loop: 'tbt', value: tbtSp });

  for (const e of fired) {
    if (e.cleared) continue;
    if (e.kind === 'controllerFault') cmd({ type: 'setLoopMode', loop: String(e.params.loop), mode: 'manual' });
    if (e.kind === 'bloom' && s.pretreat.chlorineMgL < BLOOM_CHLORINE_MGL) {
      cmd({ type: 'setDose', chemical: 'chlorine', mgL: BLOOM_CHLORINE_MGL });
    }
  }

  if (opts.crew !== false && !s.crew) {
    const job = crewJobFor(s.faults);
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
}

/** Play seed `seed` for up to `maxShifts` with the engaged bot. */
export function engagedRun(seed: number, maxShifts: number, opts: BotOptions = {}): RunResult {
  let s = createInitialState(seed, 0, GAME_ID);
  let crewSpentUsd = 0;
  let ticks = 0;
  while (s.phase !== 'over' && ticks < maxShifts * (SHIFT_TICKS + 1)) {
    const r = tick(s, engagedCommands(s, ticks, opts));
    s = r.state;
    ticks++;
    for (const e of r.events) if (e.type === 'accountChange' && e.cause === 'crew') crewSpentUsd -= e.deltaUsd;
    if (s.phase === 'handover' && s.run.shiftNumber >= maxShifts) break;
  }
  return { state: s, shifts: s.run.shiftNumber, reason: s.run.over?.reason ?? null, crewSpentUsd };
}

export const median = (xs: number[]): number => {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
};
