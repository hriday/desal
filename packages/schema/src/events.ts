import { z } from 'zod';
import { FuelGradeSchema, FuelKindSchema, LoopModeSchema, PumpIdSchema, RestartStepSchema } from './commands.js';
import { TripCauseSchema } from './status.js';

const num = z.number().finite();

export const ShiftTargetSchema = z.object({ productM3: num, maxSalinityPpm: num, fuelBudgetUsd: num });
export type ShiftTarget = z.infer<typeof ShiftTargetSchema>;

// Water first: productM3 is in-spec water only (off-spec is offSpecM3 and counts for nothing).
// spentUsd = gas burned + backup ordered + repairs this shift; nextAllocationUsd is what the next
// shift will be allocated given this shift's in-spec water against its target.
export const ShiftSummarySchema = z.object({
  productM3: num,
  targetM3: num,
  offSpecMinutes: num,
  offSpecM3: num,
  fuelCostUsd: num,
  fuelBudgetUsd: num,
  trips: num,
  spentUsd: num,
  nextAllocationUsd: num,
  balanceUsd: num,
  damage: z.object({
    maxHardScaleMm: num,
    pumpWear: z.record(PumpIdSchema, num),
    burnerCondition: num,
  }),
});
export type ShiftSummary = z.infer<typeof ShiftSummarySchema>;

export const GameEndReasonSchema = z.enum(['bankrupt', 'outOfFuel', 'burnerFailed', 'noIntakePumps', 'quit', 'abandoned', 'error']);
export type GameEndReason = z.infer<typeof GameEndReasonSchema>;

// Ranked by totalProductM3 (in-spec water), then shiftsCompleted; balanceUsd is informational.
// totalProductM3 includes the water of a shift still in progress when the game ended; that shift
// does not count in shiftsCompleted.
export const GameScoreSchema = z.object({ shiftsCompleted: num, totalProductM3: num, balanceUsd: num });
export type GameScore = z.infer<typeof GameScoreSchema>;

export const AccountCauseSchema = z.enum(['allocation', 'fuel', 'delivery', 'acidClean', 'overhaul']);
export type AccountCause = z.infer<typeof AccountCauseSchema>;

export const ScenarioKindSchema = z.enum([
  'bloom',
  'seawaterTemp',
  'pumpBearing',
  'gasCurtailNotice',
  'gasPriceSpike',
  'offgradeOnly',
  'deliveryDelay',
  'demandChange',
  'controllerFault',
]);
export type ScenarioKind = z.infer<typeof ScenarioKindSchema>;

export const DamageComponentSchema = z.enum(['stageScale', 'pump', 'burner']);
export type DamageComponent = z.infer<typeof DamageComponentSchema>;

// shiftId is null outside a shift (e.g. a commandRejected during handover).
// seq is a per-game monotonically increasing counter so consumers can de-duplicate at-least-once deliveries.
const base = { gameId: z.uuid(), seq: z.number().int().min(0), tick: num, plantTime: num, shiftId: num.nullable() };

export const PlantEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('shiftStart'), scenarioId: z.string(), mode: LoopModeSchema, target: ShiftTargetSchema }),
  z.object({ ...base, type: z.literal('shiftEnd'), summary: ShiftSummarySchema }),
  z.object({ ...base, type: z.literal('trip'), cause: TripCauseSchema }),
  z.object({ ...base, type: z.literal('restartProgress'), step: RestartStepSchema, ok: z.boolean(), reason: z.string().optional() }),
  z.object({ ...base, type: z.literal('online') }),
  z.object({ ...base, type: z.literal('scenario'), kind: ScenarioKindSchema, message: z.string() }),
  z.object({ ...base, type: z.literal('fuelChangeover'), from: FuelKindSchema, to: FuelKindSchema, phase: z.enum(['started', 'done', 'flameOut']) }),
  z.object({ ...base, type: z.literal('deliveryArrived'), tonnes: num, grade: FuelGradeSchema }),
  z.object({ ...base, type: z.literal('commandRejected'), commandId: z.string(), reason: z.string() }),
  z.object({ ...base, type: z.literal('damage'), component: DamageComponentSchema, value: num }),
  z.object({ ...base, type: z.literal('gameStart') }),
  z.object({ ...base, type: z.literal('gameRejected'), reason: z.enum(['capacity', 'duplicate']) }),
  z.object({ ...base, type: z.literal('gameEnd'), reason: GameEndReasonSchema, score: GameScoreSchema }),
  z.object({ ...base, type: z.literal('accountChange'), deltaUsd: num, balanceUsd: num, cause: AccountCauseSchema }),
]);
export type PlantEvent = z.infer<typeof PlantEventSchema>;
