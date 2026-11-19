import type { PlantEvent, RestartStep } from '@desal/schema';
import {
  ACID_CLEAN_TICKS,
  AUTO_RAMP_PCT_PER_TICK,
  IGNITION_FIRING_PCT,
  LOOP_ACTION,
  LOOP_GAINS,
  LOOP_RANGES,
  ONLINE_MARGIN_C,
  RAMP_BURNER_WEAR,
  RAMP_SCALE_MM,
  RAMP_TRIP_PCT_PER_TICK,
  RAMP_WARN_PCT_PER_TICK,
  RESTART_RECIRC_FRACTION,
  RESTART_VACUUM_MIN,
  TICK_PLANT_S,
  TRIP_SCALE_STAGES,
} from '../constants.js';
import { pidStep } from '../control/pid.js';
import { BALANCE, type PlantState } from '../state.js';
import { applyTrip } from './interlocks.js';

export type Result = { state: PlantState; events: PlantEvent[] } | { rejected: string };

const STEPS: readonly RestartStep[] = ['vacuum', 'recirc', 'ignition', 'ramp'];

const eventBase = (s: PlantState) => ({ tick: s.tick, plantTime: s.plantTime, shiftId: s.shift?.id ?? null });

function fuelAvailable(s: PlantState): boolean {
  return s.fuel.active === 'gas' ? s.fuel.gas.capMW > 0 : s.fuel.backup.tonnes > 0;
}

/** What a step needs before it may start, or null when it is ready. Phrased to follow "requires". */
function unmetPrecondition(s: PlantState, step: RestartStep): string | null {
  switch (step) {
    case 'vacuum':
      return null;
    case 'recirc':
      return s.vacuum.quality >= RESTART_VACUUM_MIN ? null : `vacuum ≥ ${RESTART_VACUUM_MIN}`;
    case 'ignition':
      if (s.brine.recircM3h < RESTART_RECIRC_FRACTION * s.loops.recirc.setpoint) {
        return `recirc ≥ ${RESTART_RECIRC_FRACTION * 100} %`;
      }
      return fuelAvailable(s) ? null : 'an available fuel source';
    case 'ramp':
      return s.heater.heatMW > 0 ? null : 'a lit burner';
  }
}

/**
 * Start a step: the restart sequence owns the vacuum, recirc and tbt (firing) actuators and sets
 * them here. Emits restartProgress ok:true.
 */
function enterStep(s: PlantState, step: RestartStep, auto: boolean): { state: PlantState; events: PlantEvent[] } {
  let loops = s.loops;
  if (step === 'vacuum') loops = { ...loops, vacuum: { ...loops.vacuum, output: BALANCE.vacuumPct } };
  if (step === 'recirc') loops = { ...loops, recirc: { ...loops.recirc, output: BALANCE.recircPct } };
  if (step === 'vacuum' || step === 'recirc') loops = { ...loops, tbt: { ...loops.tbt, output: 0 } };
  if (step === 'ignition') loops = { ...loops, tbt: { ...loops.tbt, output: IGNITION_FIRING_PCT } };
  // Ignition's own jump to IGNITION_FIRING_PCT is not a ramp; ramp keeps the reference from the
  // ignition step so a firing jump issued together with the ramp command is still caught.
  const prevFiringPct =
    step === 'ramp' && s.restart ? s.restart.prevFiringPct : loops.tbt.output;
  const state: PlantState = {
    ...s,
    status: 'restarting',
    loops,
    restart: { step, stepStartedTick: s.tick, auto, prevFiringPct },
  };
  return { state, events: [{ ...eventBase(s), type: 'restartProgress', step, ok: true }] };
}

/** One-button automatic restart from a trip. The sequence then advances itself in stepRestart. */
export function beginRestart(s: PlantState): Result {
  if (s.status === 'acidCleaning') return { rejected: 'acid clean in progress' };
  if (s.status !== 'tripped') return { rejected: 'restart requires a tripped plant' };
  if (s.controlMode !== 'auto') return { rejected: 'one-button restart is Auto-mode only' };
  return enterStep(s, 'vacuum', true);
}

/** Manual restart: the operator issues each step in order; each must have its precondition met. */
export function restartStep(s: PlantState, step: RestartStep): Result {
  if (s.status === 'acidCleaning') return { rejected: 'acid clean in progress' };
  if (s.status !== 'tripped' && s.status !== 'restarting') return { rejected: 'restart requires a tripped plant' };
  if (s.controlMode !== 'manual') return { rejected: 'manual restart steps are Manual-mode only' };
  if (s.restart?.auto) return { rejected: 'automatic restart in progress' };
  const idx = STEPS.indexOf(step);
  const doneIdx = s.status === 'restarting' && s.restart ? STEPS.indexOf(s.restart.step) : -1;
  if (idx <= doneIdx) return { rejected: `step ${step} already done` };
  if (idx > doneIdx + 1) return { rejected: `step ${step} requires ${STEPS[idx - 1]}` };
  const unmet = unmetPrecondition(s, step);
  if (unmet) return { rejected: `step ${step} requires ${unmet}` };
  return enterStep(s, step, false);
}

/** Extra burner wear and hot-stage scale from one tick of an over-fast manual firing rise. */
function rampPenalty(s: PlantState): { state: PlantState; events: PlantEvent[] } {
  const state: PlantState = {
    ...s,
    heater: { ...s.heater, burnerCondition: Math.max(0, s.heater.burnerCondition - RAMP_BURNER_WEAR) },
    stages: s.stages.map((st, i) =>
      i < TRIP_SCALE_STAGES ? { ...st, hardScaleMm: st.hardScaleMm + RAMP_SCALE_MM } : st,
    ),
  };
  const base = eventBase(s);
  return {
    state,
    events: [
      { ...base, type: 'damage', component: 'burner', value: RAMP_BURNER_WEAR },
      { ...base, type: 'damage', component: 'stageScale', value: RAMP_SCALE_MM },
    ],
  };
}

/**
 * Advance a restart by one tick (call after the units have run).
 * - Auto: advance a step whenever the next step's precondition holds. In the ramp, firing follows
 *   what the TBT PID asks for, but rises by at most AUTO_RAMP_PCT_PER_TICK; the PID state is kept
 *   so it takes over bumplessly once online.
 * - Manual (ignition and ramp): the operator's firing rise per tick is policed. Above
 *   RAMP_WARN_PCT_PER_TICK the burner wears and the hot stages scale; above RAMP_TRIP_PCT_PER_TICK
 *   the burner flames out and the plant re-trips.
 * TBT within ONLINE_MARGIN_C of setpoint during the ramp brings the plant online.
 */
export function stepRestart(s: PlantState): { state: PlantState; events: PlantEvent[] } {
  const r = s.restart;
  if (s.status !== 'restarting' || !r) return { state: s, events: [] };
  const withPrev = (st: PlantState): PlantState =>
    st.restart ? { ...st, restart: { ...st.restart, prevFiringPct: st.loops.tbt.output } } : st;

  let state = s;
  const events: PlantEvent[] = [];
  if (r.step === 'vacuum' || r.step === 'recirc') {
    // Burner locked out before ignition: hold firing at 0 whatever the operator set.
    state = { ...s, loops: { ...s.loops, tbt: { ...s.loops.tbt, output: 0 } } };
  }
  if (r.auto && r.step !== 'ramp') {
    const next = STEPS[STEPS.indexOf(r.step) + 1];
    if (!next || unmetPrecondition(state, next)) return { state: withPrev(state), events: [] };
    return enterStep(state, next, true);
  }
  if (r.auto) {
    const tbt = s.loops.tbt;
    const { outMin, outMax } = LOOP_RANGES.tbt;
    const pid = pidStep({ ...tbt, mode: 'auto' }, s.heater.tbtC, LOOP_GAINS.tbt, outMin, outMax, TICK_PLANT_S, LOOP_ACTION.tbt);
    const output = Math.min(tbt.output + AUTO_RAMP_PCT_PER_TICK, pid.output);
    state = { ...s, loops: { ...s.loops, tbt: { ...pid, mode: tbt.mode, output } } };
  } else if (r.step === 'ignition' || r.step === 'ramp') {
    const risePct = s.loops.tbt.output - r.prevFiringPct;
    if (risePct > RAMP_TRIP_PCT_PER_TICK) return applyTrip(s, 'flameOut');
    if (risePct > RAMP_WARN_PCT_PER_TICK) {
      const p = rampPenalty(s);
      state = p.state;
      events.push(...p.events);
    }
  }

  if (r.step === 'ramp' && state.heater.tbtC >= state.loops.tbt.setpoint - ONLINE_MARGIN_C) {
    state = { ...state, status: 'online', restart: null, trip: null };
    events.push({ ...eventBase(s), type: 'online' });
    return { state, events };
  }
  return { state: withPrev(state), events };
}

/** Acid clean from a trip: 2 plant hours, then all hard scale is gone and the plant waits, tripped. */
export function beginAcidClean(s: PlantState): Result {
  if (s.status !== 'tripped') return { rejected: 'acid clean requires a tripped plant' };
  return { state: { ...s, status: 'acidCleaning', acidCleanRemainingTicks: ACID_CLEAN_TICKS }, events: [] };
}

/** Count down a running acid clean by one tick; no-op otherwise. */
export function stepAcidClean(s: PlantState): PlantState {
  if (s.status !== 'acidCleaning') return s;
  const remaining = Math.max(0, s.acidCleanRemainingTicks - 1);
  if (remaining > 0) return { ...s, acidCleanRemainingTicks: remaining };
  return {
    ...s,
    status: 'tripped',
    acidCleanRemainingTicks: 0,
    stages: s.stages.map((st) => ({ ...st, hardScaleMm: 0 })),
  };
}
