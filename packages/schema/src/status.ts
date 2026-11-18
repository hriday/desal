import { z } from 'zod';
import { FuelSchema, LoopIdSchema, LoopModeSchema, PumpIdSchema, RestartStepSchema } from './commands.js';

const num = z.number().finite();

export const TripCauseSchema = z.enum([
  'tbtHighHigh',
  'stageFlood',
  'lossOfVacuum',
  'noIntakeFlow',
  'noFuel',
  'flameOut',
  'manual',
]);
export type TripCause = z.infer<typeof TripCauseSchema>;

// phase/status/backupGrade values are owned by the simulator; the contract only requires strings for now.
export const PlantStatusSchema = z.object({
  tick: num,
  plantTime: num,
  shiftId: num.nullable(),
  phase: z.string(),
  status: z.string(),
  controlMode: LoopModeSchema,
  tripCause: TripCauseSchema.nullable(),
  restartStep: RestartStepSchema.nullable(),
  loops: z.record(LoopIdSchema, z.object({ mode: LoopModeSchema, setpoint: num, output: num })),
  pumps: z.record(PumpIdSchema, z.object({ running: z.boolean() })),
  fuel: z.object({
    active: FuelSchema,
    changeoverTo: FuelSchema.nullable(),
    backupGrade: z.string(),
    gasCurtailmentNotice: z.string().nullable(),
  }),
  ballCleaning: z.boolean(),
  divertToDrain: z.boolean(),
  shiftTicksRemaining: num,
});
export type PlantStatus = z.infer<typeof PlantStatusSchema>;
