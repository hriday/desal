import {
  BURNER_MAX_MW,
  CHANGEOVER_CAP_FRACTION,
  CONTAMINATION_HEAT_FACTOR,
  FLAMEOUT_FIRING_PCT,
  LHV_OFFGRADE_MJkg,
  LHV_STANDARD_MJkg,
  OFFGRADE_CAP_FRACTION,
} from '../constants.js';
import { contaminationActive } from '../scenario/disaster/fuelContamination.js';
import type { Delivery, PlantState, SimEvent } from '../state.js';

export interface FuelStep {
  state: PlantState;
  deliveredMW: number;
  /** Fuel paid this step: gas burned; backup fuel is paid on order, so 0 while it burns. */
  costUsd: number;
  events: SimEvent[];
}

/**
 * Advance the fuel system one step: apply due curtailment and deliveries, deliver heat from the
 * active source, drain the tank, and run the changeover timer. A manual-mode flame-out during a
 * changeover is only reported as an event; the orchestrator turns it into a trip.
 */
export function stepFuel(s: PlantState, demandMW: number, dtS: number): FuelStep {
  const base = { tick: s.tick, plantTime: s.plantTime, shiftId: s.shift?.id ?? null };
  const events: SimEvent[] = [];

  let gas = s.fuel.gas;
  if (gas.curtailmentNotice && gas.curtailmentNotice.atTick <= s.tick) {
    gas = { ...gas, capMW: gas.curtailmentNotice.capMW, curtailmentNotice: null };
  }

  let backup = s.fuel.backup;
  const deliveries: Delivery[] = [];
  for (const d of s.fuel.deliveries) {
    if (d.arrivesAtTick <= s.tick) {
      backup = { ...backup, tonnes: backup.tonnes + d.tonnes, grade: d.grade };
      events.push({ ...base, type: 'deliveryArrived', tonnes: d.tonnes, grade: d.grade });
    } else {
      deliveries.push(d);
    }
  }

  const active = s.fuel.active;
  let capMW = Math.max(0, demandMW);
  if (s.fuel.changeover) {
    capMW = Math.min(capMW, CHANGEOVER_CAP_FRACTION * BURNER_MAX_MW);
    if (s.controlMode === 'manual' && s.heater.firingPct > FLAMEOUT_FIRING_PCT) {
      events.push({ ...base, type: 'fuelChangeover', from: active, to: s.fuel.changeover.to, phase: 'flameOut' });
    }
  }

  // Contaminated fuel burns poor: the heat that reaches the brine is cut.
  if (contaminationActive(s)) capMW *= CONTAMINATION_HEAT_FACTOR;

  let deliveredMW: number;
  // Gas is paid as it burns; backup fuel was paid in full when ordered, so it burns at no cost.
  let priceUsdPerGJ = 0;
  if (active === 'gas') {
    deliveredMW = Math.min(capMW, Math.max(0, gas.capMW));
    priceUsdPerGJ = gas.priceUsdPerGJ;
  } else {
    const lhv = backup.grade === 'offgrade' ? LHV_OFFGRADE_MJkg : LHV_STANDARD_MJkg;
    if (backup.grade === 'offgrade') capMW = Math.min(capMW, OFFGRADE_CAP_FRACTION * BURNER_MAX_MW);
    const tankMW = (Math.max(0, backup.tonnes) * 1000 * lhv) / dtS;
    deliveredMW = Math.min(capMW, tankMW);
    const drained = (deliveredMW * dtS) / (lhv * 1000);
    backup = { ...backup, tonnes: Math.max(0, backup.tonnes - drained) };
  }
  const costUsd = (deliveredMW * dtS * priceUsdPerGJ) / 1000;

  let changeover = s.fuel.changeover;
  let nextActive = active;
  if (changeover) {
    const remainingTicks = changeover.remainingTicks - 1;
    if (remainingTicks <= 0) {
      events.push({ ...base, type: 'fuelChangeover', from: active, to: changeover.to, phase: 'done' });
      nextActive = changeover.to;
      changeover = null;
    } else {
      changeover = { ...changeover, remainingTicks };
    }
  }

  const state: PlantState = {
    ...s,
    fuel: { ...s.fuel, active: nextActive, changeover, gas, backup, deliveries, burnMW: deliveredMW },
  };
  return { state, deliveredMW, costUsd, events };
}
