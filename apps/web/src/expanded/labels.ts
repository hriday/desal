// Plain-language labels for the schema's enum values. Look them up with format.ts `label` (prototype-safe).

export const TRIP_TEXT: Record<string, string> = {
  tbtHighHigh: 'TBT high-high', stageFlood: 'stage flood', lossOfVacuum: 'loss of vacuum', noIntakeFlow: 'no intake flow',
  noFuel: 'no fuel', flameOut: 'burner flame-out', manual: 'manual trip',
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
  allocation: 'the shift allocation', fuel: 'gas', delivery: 'a backup fuel delivery', acidClean: 'an acid clean', overhaul: 'a pump overhaul',
};
