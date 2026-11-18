import { PlantStatusSchema, type PlantStatus } from '../src/index.js';

const status: PlantStatus = {
  tick: 5,
  plantTime: 300,
  shiftId: null,
  phase: 'handover',
  status: 'online',
  controlMode: 'auto',
  tripCause: null,
  restartStep: null,
  loops: {
    tbt: { mode: 'auto', setpoint: 108, output: 50 },
    intakeFlow: { mode: 'auto', setpoint: 1, output: 2 },
    recirc: { mode: 'auto', setpoint: 1, output: 2 },
    blowdown: { mode: 'auto', setpoint: 1, output: 2 },
    vacuum: { mode: 'auto', setpoint: 1, output: 2 },
    level3: { mode: 'manual', setpoint: 1, output: 2 },
  },
  pumps: { 'P-101': { running: true }, 'P-102': { running: false }, 'P-103': { running: true } },
  fuel: { active: 'gas', changeoverTo: null, backupGrade: 'standard', gasCurtailmentNotice: null },
  ballCleaning: false,
  divertToDrain: false,
  shiftTicksRemaining: 100,
};

test('a valid status round-trips through JSON', () => {
  expect(PlantStatusSchema.parse(JSON.parse(JSON.stringify(status)))).toEqual(status);
});

test('rejects an invalid phase, status and loop key', () => {
  expect(PlantStatusSchema.safeParse({ ...status, phase: 'napping' }).success).toBe(false);
  expect(PlantStatusSchema.safeParse({ ...status, status: 'exploded' }).success).toBe(false);
  expect(PlantStatusSchema.safeParse({ ...status, loops: { level21: status.loops.tbt } }).success).toBe(false);
});
