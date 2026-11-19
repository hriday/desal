import { z } from 'zod';
import { FuelGradeSchema, FuelKindSchema, LoopIdSchema, LoopModeSchema, PumpIdSchema, RestartStepSchema } from './commands.js';

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

export const PhaseSchema = z.enum(['handover', 'running', 'paused', 'over']);
export type Phase = z.infer<typeof PhaseSchema>;

export const PlantStatusKindSchema = z.enum(['online', 'tripped', 'restarting', 'acidCleaning']);
export type PlantStatusKind = z.infer<typeof PlantStatusKindSchema>;

export const PlantStatusSchema = z.object({
  gameId: z.uuid(),
  shiftNumber: num,
  balanceUsd: num,
  tick: num,
  plantTime: num,
  shiftId: num.nullable(),
  phase: PhaseSchema,
  status: PlantStatusKindSchema,
  controlMode: LoopModeSchema,
  tripCause: TripCauseSchema.nullable(),
  restartStep: RestartStepSchema.nullable(),
  loops: z.record(LoopIdSchema, z.object({ mode: LoopModeSchema, setpoint: num, output: num })),
  pumps: z.record(PumpIdSchema, z.object({ running: z.boolean(), overhaulRemainingTicks: num })),
  fuel: z.object({
    active: FuelKindSchema,
    changeoverTo: FuelKindSchema.nullable(),
    backupGrade: FuelGradeSchema,
    gasCurtailmentNotice: z.string().nullable(),
  }),
  ballCleaning: z.boolean(),
  divertToDrain: z.boolean(),
  shiftTicksRemaining: num,
  deliveries: z.array(z.object({ arrivesInTicks: num, tonnes: num, grade: FuelGradeSchema })),
  acidCleanRemainingTicks: num,
  restartAuto: z.boolean().nullable(),
  offeredGrade: FuelGradeSchema,
});
export type PlantStatus = z.infer<typeof PlantStatusSchema>;
