import type { PlantEvent, RestartStep } from '@desal/schema';
import {
  ACID_CLEAN_TICKS,
  AUTO_RAMP_C_PER_MIN,
  AUTO_RAMP_FIRING_GAIN,
  IGNITION_FIRING_PCT,
  ONLINE_MARGIN_C,
  RAMP_BURNER_WEAR,
  RAMP_SCALE_MM,
  RAMP_TRIP_C_PER_MIN,
  RAMP_WARN_C_PER_MIN,
  RESTART_RECIRC_FRACTION,
  RESTART_VACUUM_MIN,
  TICK_PLANT_S,
  TRIP_SCALE_STAGES,
} from '../constants.js';
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
  if (step === 'ignition') loops = { ...loops, tbt: { ...loops.tbt, output: IGNITION_FIRING_PCT } };
  const state: PlantState = {
    ...s,
    status: 'restarting',
    loops,
    restart: { step, stepStartedTick: s.tick, auto, prevTbtC: s.heater.tbtC },
  };
  return { state, events: [{ ...eventBase(s), type: 'restartProgress', step, ok: true }] };
}

/** One-button automatic restart from a trip. The sequence then advances itself in stepRestart. */
export function beginRestart(s: PlantState): Result {
  if (s.status === 'acidCleaning') return { rejected: 'acid clean in progress' };
  if (s.status !== 'tripped') return { rejected: 'restart requires a tripped plant' };
  return enterStep(s, 'vacuum', true);
}

/** Manual restart: the operator issues each step in order; each must have its precondition met. */
export function restartStep(s: PlantState, step: RestartStep): Result {
  if (s.status === 'acidCleaning') return { rejected: 'acid clean in progress' };
  if (s.status !== 'tripped' && s.status !== 'restarting') return { rejected: 'restart requires a tripped plant' };
  if (s.restart?.auto) return { rejected: 'automatic restart in progress' };
  const idx = STEPS.indexOf(step);
  const doneIdx = s.status === 'restarting' && s.restart ? STEPS.indexOf(s.restart.step) : -1;
  if (idx <= doneIdx) return { rejected: `step ${step} already done` };
  if (idx > doneIdx + 1) return { rejected: `step ${step} requires ${STEPS[idx - 1]}` };
  const unmet = unmetPrecondition(s, step);
  if (unmet) return { rejected: `step ${step} requires ${unmet}` };
  return enterStep(s, step, false);
}

/** Extra burner wear and hot-stage scale from one tick of an over-fast manual ramp. */
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
 * Advance a restart by one tick (call after the units have run). Auto restarts advance a step
 * whenever the next step's precondition holds and ramp the firing toward a target TBT rise rate.
 * Manual ramps are policed: too fast wears the burner and scales the hot stages; far too fast
 * flames out and re-trips. TBT within ONLINE_MARGIN_C of setpoint during the ramp brings the
 * plant online.
 */
export function stepRestart(s: PlantState): { state: PlantState; events: PlantEvent[] } {
  const r = s.restart;
  if (s.status !== 'restarting' || !r) return { state: s, events: [] };
  const tbtC = s.heater.tbtC;
  const withPrev = (st: PlantState): PlantState =>
    st.restart ? { ...st, restart: { ...st.restart, prevTbtC: tbtC } } : st;

  if (r.step !== 'ramp') {
    if (!r.auto) return { state: withPrev(s), events: [] };
    const next = STEPS[STEPS.indexOf(r.step) + 1];
    if (!next || unmetPrecondition(s, next)) return { state: withPrev(s), events: [] };
    return enterStep(s, next, true);
  }

  const rateCPerMin = ((tbtC - r.prevTbtC) / TICK_PLANT_S) * 60;
  let state = s;
  const events: PlantEvent[] = [];
  if (r.auto) {
    const tbt = state.loops.tbt;
    const output = Math.min(
      100,
      Math.max(IGNITION_FIRING_PCT, tbt.output + AUTO_RAMP_FIRING_GAIN * (AUTO_RAMP_C_PER_MIN - rateCPerMin)),
    );
    state = { ...state, loops: { ...state.loops, tbt: { ...tbt, output } } };
  } else if (rateCPerMin > RAMP_TRIP_C_PER_MIN) {
    return applyTrip(s, 'flameOut');
  } else if (rateCPerMin > RAMP_WARN_C_PER_MIN) {
    const p = rampPenalty(state);
    state = p.state;
    events.push(...p.events);
  }

  if (tbtC >= state.loops.tbt.setpoint - ONLINE_MARGIN_C) {
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
