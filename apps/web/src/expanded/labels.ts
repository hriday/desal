// Plain-language labels for the schema's enum values. Look them up with format.ts `label` (prototype-safe).

import type { CrewJob, PlantStatus, ScenarioKind } from '@desal/schema';
import { CREW_JOBS } from '../plantConstants';

export const TRIP_TEXT: Record<string, string> = {
  tbtHighHigh: 'TBT high-high', stageFlood: 'stage flood', lossOfVacuum: 'loss of vacuum', noIntakeFlow: 'no intake flow',
  noFuel: 'no fuel', flameOut: 'burner flame-out', manual: 'manual trip',
};

/**
 * What to do about each trip cause before restarting: one or two short imperative sentences naming
 * on-screen controls. The S24 brine pool feeds the recirc pump, so an empty pool shows as a TBT
 * high-high (no recirculation to carry the heat) and a full one as a stage flood; only Makeup moves it.
 */
export const TRIP_FIX: Record<string, string> = {
  tbtHighHigh: 'Lower the TBT setpoint. If recirculation is low, the Brine pool (S24) may be empty: raise Makeup until it refills, then press Restart.',
  stageFlood: 'Bring the stage levels down (level valves, brine recirculation). If the Brine pool (S24) is the flooded stage, lower Makeup instead, then press Restart.',
  lossOfVacuum: 'Get vacuum back first (repair the ejector if it has failed), then press Restart.',
  noIntakeFlow: 'Get intake flow back first: clean the intake screens and run every healthy intake pump. Let Makeup refill the Brine pool (S24), then press Restart.',
  noFuel: 'Switch to a fuel that is available, then press Restart.',
  flameOut: 'Check the fuel (a changeover or bad fuel puts the flame out), then press Restart.',
  manual: 'Press Restart when you are ready.',
};

export const STEP_TEXT: Record<string, string> = { vacuum: 'Vacuum', recirc: 'Recirculation', ignition: 'Ignition', ramp: 'Ramp' };

export const PLANT_TEXT: Record<string, string> = { online: 'Online', tripped: 'Tripped', restarting: 'Restarting', acidCleaning: 'Acid cleaning' };

export const MODE_TEXT: Record<string, string> = { auto: 'Auto', manual: 'Manual' };

export const FUEL_TEXT: Record<string, string> = { gas: 'Gas', backup: 'Backup' };

export const GRADE_TEXT: Record<string, string> = { standard: 'Standard', offgrade: 'Off-grade' };

export const END_TEXT: Record<string, string> = {
  bankrupt: 'the operating budget ran out', outOfFuel: 'the plant ran out of fuel', burnerFailed: 'the burner failed',
  noIntakePumps: 'no intake pumps are left', quit: 'the run was quit', abandoned: 'the run was abandoned', error: 'a plant error',
};

export const CAUSE_TEXT: Record<string, string> = {
  allocation: 'the shift allocation', fuel: 'gas', delivery: 'a backup fuel delivery', acidClean: 'an acid clean', overhaul: 'a pump overhaul', crew: 'a crew job',
  standing: 'staff and standby',
};

export const KIND_TEXT: Record<string, string> = {
  bloom: 'Algal bloom', seawaterTemp: 'Seawater temperature change', pumpBearing: 'Pump bearing wear', gasCurtailNotice: 'Gas curtailment notice',
  gasPriceSpike: 'Gas price spike', offgradeOnly: 'Off-grade fuel only', deliveryDelay: 'Fuel delivery delay', demandChange: 'Demand change',
  controllerFault: 'Controller fault', pumpTrip: 'Pump trip', tubeLeak: 'Tube leak', vacuumLoss: 'Vacuum loss', powerDip: 'Power dip',
  storm: 'Storm', sensorFailure: 'Instrument failure',
  fuelContamination: 'Contaminated fuel', earthquake: 'Earthquake', tsunami: 'Tsunami',
};

/**
 * What to do about each scenario kind: one imperative line naming on-screen controls and crew jobs.
 * `hint` says when the radio hints it on Normal (state/hints.ts): 'delay' once the event has been open
 * HINT_DELAY_MIN, 'atOnce' when it fires, 'none' never (informational kinds). `underway` holds a
 * 'delay' hint back while the fix shows as in progress in the status.
 */
export interface FixEntry { text: string; hint: 'delay' | 'atOnce' | 'none'; underway?: (st: PlantStatus) => boolean }

const crewOn = (job: CrewJob) => (st: PlantStatus) => st.crew?.job === job;
const sendCrew = (job: CrewJob) => `send the crew to ${CREW_JOBS[job].plain}`;

export const FIX: Record<ScenarioKind, FixEntry> = {
  bloom: { text: 'Raise the Chlorine dose to keep the bloom out of the plant.', hint: 'delay' },
  seawaterTemp: { text: 'Watch the TBT and intake flow while the sea temperature settles.', hint: 'none' },
  pumpBearing: { text: 'Plan an Overhaul for the worn intake pump before it fails.', hint: 'none' },
  gasCurtailNotice: { text: 'Get ready to switch the Burner fuel to Backup before the gas cap starts.', hint: 'none' },
  gasPriceSpike: { text: 'Think about switching the Burner fuel to Backup while gas is dear.', hint: 'none' },
  offgradeOnly: { text: 'Order only the backup fuel you need: off-grade is all that is on offer.', hint: 'none' },
  deliveryDelay: { text: 'Watch the Backup tank and order fuel early.', hint: 'none' },
  demandChange: { text: 'Check the new target in the shift orders and adjust the TBT to meet it.', hint: 'none' },
  controllerFault: { text: 'Put the faulty loop in Manual and set its output by hand.', hint: 'delay' },
  pumpTrip: { text: 'Start a standby intake pump so two are Running.', hint: 'delay' },
  powerDip: { text: 'Start a standby intake pump so two are Running; recirculation comes back when the dip passes.', hint: 'delay' },
  tubeLeak: { text: `Turn on Divert to drain if the product is off-spec, and ${sendCrew('plugTubes')}.`, hint: 'delay', underway: crewOn('plugTubes') },
  vacuumLoss: { text: `Watch the vacuum and ${sendCrew('repairEjector')}.`, hint: 'delay', underway: crewOn('repairEjector') },
  storm: { text: `Keep two intake pumps Running and ${sendCrew('cleanScreens')}.`, hint: 'delay', underway: crewOn('cleanScreens') },
  sensorFailure: { text: `Find the reading that makes no sense (its loop is safer in Manual), and ${sendCrew('replaceSensor')}.`, hint: 'delay', underway: crewOn('replaceSensor') },
  fuelContamination: {
    text: 'Switch to the other fuel, then send the crew to flush it.',
    hint: 'delay',
    underway: (st) => st.fuel.changeoverTo !== null || st.crew?.job === 'flushFuel',
  },
  earthquake: { text: 'Everything breaks at once; fix what hurts most first.', hint: 'atOnce' },
  // No under-way check: the status does not say whether the surge has passed, and a screen clean
  // started during the surge does not count towards clearing it.
  tsunami: {
    text: 'When the siren sounds, run on your healthiest intake pump until the surge passes, then clean the screens and run two pumps again.',
    hint: 'delay',
  },
};

/** How an event ended, as the debrief and the event log say it. */
export const HOW_TEXT: Record<string, string> = { player: 'cleared by you', crew: 'fixed by crew', expired: 'passed', noted: 'noted' };
