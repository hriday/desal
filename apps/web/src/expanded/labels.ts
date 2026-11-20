// Plain-language labels for the schema's enum values. Look them up with format.ts `label` (prototype-safe).

export const TRIP_TEXT: Record<string, string> = {
  tbtHighHigh: 'TBT high-high', stageFlood: 'stage flood', lossOfVacuum: 'loss of vacuum', noIntakeFlow: 'no intake flow',
  noFuel: 'no fuel', flameOut: 'burner flame-out', manual: 'manual trip',
};

/** What to do about each trip cause before restarting: one imperative line, naming on-screen controls. */
export const TRIP_FIX: Record<string, string> = {
  tbtHighHigh: 'Lower the TBT setpoint, then press Restart.',
  stageFlood: 'Bring the stage levels down (level valves, brine recirculation), then press Restart.',
  lossOfVacuum: 'Get vacuum back first (repair the ejector if it has failed), then press Restart.',
  noIntakeFlow: 'Get intake flow back first: clean the intake screens and run every healthy intake pump, then press Restart.',
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

/** How an event ended, as the debrief and the event log say it. */
export const HOW_TEXT: Record<string, string> = { player: 'cleared by you', crew: 'fixed by crew', expired: 'passed', noted: 'noted' };
