import { z } from 'zod';
import { FuelSchema, LoopModeSchema, PumpIdSchema, RestartStepSchema } from './commands.js';
import { TripCauseSchema } from './status.js';

const num = z.number().finite();

export const ShiftSummarySchema = z.object({
  productM3: num,
  targetM3: num,
  offSpecMinutes: num,
  fuelCostUsd: num,
  fuelBudgetUsd: num,
  trips: num,
  damage: z.object({
    maxHardScaleMm: num,
    pumpWear: z.record(PumpIdSchema, num),
    burnerCondition: num,
  }),
});
export type ShiftSummary = z.infer<typeof ShiftSummarySchema>;

// shiftId is null outside a shift (e.g. a commandRejected during handover).
const base = { tick: num, plantTime: num, shiftId: num.nullable() };

export const PlantEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('shiftStart'), scenarioId: z.string(), mode: LoopModeSchema, target: num }),
  z.object({ ...base, type: z.literal('shiftEnd'), summary: ShiftSummarySchema }),
  z.object({ ...base, type: z.literal('trip'), cause: TripCauseSchema }),
  z.object({ ...base, type: z.literal('restartProgress'), step: RestartStepSchema, ok: z.boolean(), reason: z.string().optional() }),
  z.object({ ...base, type: z.literal('online') }),
  z.object({ ...base, type: z.literal('scenario'), kind: z.string(), message: z.string() }),
  z.object({ ...base, type: z.literal('fuelChangeover'), from: FuelSchema, to: FuelSchema, phase: z.enum(['started', 'done', 'flameOut']) }),
  z.object({ ...base, type: z.literal('deliveryArrived'), tonnes: num, grade: z.string() }),
  z.object({ ...base, type: z.literal('commandRejected'), commandId: z.string(), reason: z.string() }),
  z.object({ ...base, type: z.literal('damage'), component: z.string(), value: num }),
]);
export type PlantEvent = z.infer<typeof PlantEventSchema>;
