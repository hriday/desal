import type { TripCause } from '@desal/schema';
import {
  INTAKE_TRIP_FRACTION,
  LEVEL_FLOOD_M,
  TBT_HH_C,
  TRIP_BURNER_DAMAGE,
  TRIP_SCALE_MM,
  TRIP_SCALE_STAGES,
  VACUUM_TRIP,
} from '../constants.js';
import type { PlantState, SimEvent } from '../state.js';

/**
 * True when the burner should be lit: online, or restarting from the tick after ignition began
 * (fuel runs before the restart step, so the ignition tick itself has not been fired yet).
 */
function firingExpected(s: PlantState): boolean {
  if (s.status === 'online') return true;
  if (s.status !== 'restarting' || !s.restart) return false;
  const { step, stepStartedTick } = s.restart;
  return step === 'ramp' || (step === 'ignition' && stepStartedTick < s.tick);
}

/**
 * Safety interlocks, checked after the units each tick while the plant is online or restarting.
 * `deliveredMW` is this tick's delivered fuel heat. Returns the first cause that trips, or null.
 */
export function checkInterlocks(s: PlantState, deliveredMW: number): TripCause | null {
  if (s.status !== 'online' && s.status !== 'restarting') return null;
  if (s.heater.tbtC >= TBT_HH_C) return 'tbtHighHigh';
  if (s.stages.some((st) => st.levelM >= LEVEL_FLOOD_M)) return 'stageFlood';
  // The restart's vacuum step is pulling vacuum back up; it cannot advance until >= 0.85.
  const pullingVacuum = s.status === 'restarting' && s.restart?.step === 'vacuum';
  if (s.vacuum.quality < VACUUM_TRIP && !pullingVacuum) return 'lossOfVacuum';
  if (s.intake.flowM3h < INTAKE_TRIP_FRACTION * s.intake.requiredM3h) return 'noIntakeFlow';
  if (firingExpected(s) && deliveredMW <= 0) return 'noFuel';
  return null;
}

/**
 * Trip the plant: shut the burner, abandon any restart, and apply thermal-cycling damage
 * (hard scale on the hottest stages, burner condition). Emits `trip` then `damage` events.
 */
export function applyTrip(s: PlantState, cause: TripCause): { state: PlantState; events: SimEvent[] } {
  const base = { tick: s.tick, plantTime: s.plantTime, shiftId: s.shift?.id ?? null };
  const state: PlantState = {
    ...s,
    status: 'tripped',
    trip: { cause, atTick: s.tick },
    restart: null,
    loops: { ...s.loops, tbt: { ...s.loops.tbt, output: 0 } },
    heater: {
      ...s.heater,
      firingPct: 0,
      heatMW: 0,
      burnerCondition: Math.max(0, s.heater.burnerCondition - TRIP_BURNER_DAMAGE),
    },
    stages: s.stages.map((st, i) =>
      i < TRIP_SCALE_STAGES ? { ...st, hardScaleMm: st.hardScaleMm + TRIP_SCALE_MM } : st,
    ),
  };
  const events: SimEvent[] = [
    { ...base, type: 'trip', cause },
    { ...base, type: 'damage', component: 'stageScale', value: TRIP_SCALE_MM },
    { ...base, type: 'damage', component: 'burner', value: TRIP_BURNER_DAMAGE },
  ];
  return { state, events };
}
