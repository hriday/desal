import { z } from 'zod';
import { FuelGradeSchema, GameModeSchema, FuelKindSchema, LoopModeSchema, PumpIdSchema, RestartStepSchema } from './commands.js';
import { ShiftOrdersSchema, TripCauseSchema } from './status.js';

const num = z.number().finite();

export const ShiftTargetSchema = z.object({ productM3: num, maxSalinityPpm: num, fuelBudgetUsd: num });
export type ShiftTarget = z.infer<typeof ShiftTargetSchema>;

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
  'pumpTrip',
  'tubeLeak',
  'vacuumLoss',
  'powerDip',
  'storm',
  'sensorFailure',
  'fuelContamination',
  'earthquake',
  'tsunami',
  'lowSteam',
]);
export type ScenarioKind = z.infer<typeof ScenarioKindSchema>;

export const DISASTER_KINDS: readonly ScenarioKind[] = ['fuelContamination', 'earthquake', 'tsunami'];

export const SHARP_KINDS: readonly ScenarioKind[] = ['pumpTrip', 'tubeLeak', 'vacuumLoss', 'powerDip', 'storm', 'sensorFailure'];

export const EventClearHowSchema = z.enum(['player', 'crew', 'expired', 'noted']);
export type EventClearHow = z.infer<typeof EventClearHowSchema>;

// Water first: productM3 is in-spec water only (off-spec is offSpecM3 and counts for nothing).
// spentUsd = gas burned + backup ordered + repairs + crew jobs + standing cost + standby steam line this shift;
// nextAllocationUsd is what the next shift will be allocated given this shift's in-spec water
// against its target.
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
  hell: z.boolean(),
  events: z.array(z.object({ eventId: z.number().int().min(1), kind: ScenarioKindSchema, atMinute: num, cleared: z.boolean(), how: EventClearHowSchema.nullable() })),
});
export type ShiftSummary = z.infer<typeof ShiftSummarySchema>;

export const GameEndReasonSchema = z.enum(['bankrupt', 'outOfFuel', 'burnerFailed', 'noIntakePumps', 'quit', 'abandoned', 'error']);
export type GameEndReason = z.infer<typeof GameEndReasonSchema>;

// Ranked by totalProductM3 (in-spec water), then shiftsCompleted; balanceUsd is informational.
// totalProductM3 includes the water of a shift still in progress when the game ended; that shift
// does not count in shiftsCompleted.
export const GameScoreSchema = z.object({ shiftsCompleted: num, totalProductM3: num, balanceUsd: num });
export type GameScore = z.infer<typeof GameScoreSchema>;

export const AccountCauseSchema = z.enum(['allocation', 'fuel', 'delivery', 'acidClean', 'overhaul', 'crew', 'standing', 'standbySteam', 'standbyEjectors']);
export type AccountCause = z.infer<typeof AccountCauseSchema>;


export const DamageComponentSchema = z.enum(['stageScale', 'pump', 'burner']);
export type DamageComponent = z.infer<typeof DamageComponentSchema>;

// shiftId is null outside a shift (e.g. a commandRejected during handover).
// seq is a per-game monotonically increasing counter so consumers can de-duplicate at-least-once deliveries.
// epoch counts how often the game was restored from a snapshot. A restore can rewind seq (and tick) to
// the snapshot's, so consumers de-duplicate on (gameId, epoch, seq), and a higher epoch resets their marks.
// host: true marks a host-level event (the simulator's GameHost answering for a game it does not hold, e.g.
// a commandRejected 'no such game' or a gameRejected): seq 0, epoch 0, tick 0, wall-clock plantTime. It is
// not part of the game's seq order, so consumers must never de-duplicate host events.
const base = {
  gameId: z.uuid(),
  epoch: z.number().int().min(0),
  seq: z.number().int().min(0),
  tick: num,
  plantTime: num,
  shiftId: num.nullable(),
  host: z.boolean().optional(),
};

export const PlantEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('shiftStart'), scenarioId: z.string(), mode: LoopModeSchema, target: ShiftTargetSchema, hell: z.boolean(), orders: ShiftOrdersSchema }),
  // runId is always present on Kafka; the gateway strips it before a browser sees the event.
  z.object({ ...base, type: z.literal('shiftEnd'), summary: ShiftSummarySchema, runId: z.uuid().optional() }),
  z.object({ ...base, type: z.literal('trip'), cause: TripCauseSchema }),
  z.object({ ...base, type: z.literal('restartProgress'), step: RestartStepSchema, ok: z.boolean(), reason: z.string().optional() }),
  z.object({ ...base, type: z.literal('online') }),
  z.object({ ...base, type: z.literal('scenario'), eventId: z.number().int().min(1), kind: ScenarioKindSchema, message: z.string(), radio: z.string() }),
  z.object({ ...base, type: z.literal('eventCleared'), eventId: z.number().int().min(1), kind: ScenarioKindSchema, how: EventClearHowSchema }),
  z.object({ ...base, type: z.literal('fuelChangeover'), from: FuelKindSchema, to: FuelKindSchema, phase: z.enum(['started', 'done', 'flameOut']) }),
  z.object({ ...base, type: z.literal('deliveryArrived'), tonnes: num, grade: FuelGradeSchema }),
  z.object({ ...base, type: z.literal('commandRejected'), commandId: z.string(), reason: z.string() }),
  z.object({ ...base, type: z.literal('damage'), component: DamageComponentSchema, value: num }),
  z.object({ ...base, type: z.literal('gameStart'), callSign: z.string(), mode: GameModeSchema.default('normal') }),
  z.object({ ...base, type: z.literal('gameRejected'), reason: z.enum(['capacity', 'duplicate']) }),
  z.object({ ...base, type: z.literal('gameEnd'), callSign: z.string(), runId: z.uuid().optional(), mode: GameModeSchema.default('normal'), reason: GameEndReasonSchema, score: GameScoreSchema }),
  z.object({ ...base, type: z.literal('accountChange'), deltaUsd: num, balanceUsd: num, cause: AccountCauseSchema }),
]);
export type PlantEvent = z.infer<typeof PlantEventSchema>;
