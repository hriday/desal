import { z } from 'zod';
import { CrewJobSchema, FuelGradeSchema, GameModeSchema, FuelKindSchema, LoopIdSchema, LoopModeSchema, PumpIdSchema, RestartStepSchema } from './commands.js';

const num = z.number().finite();

// The shift's orders card: what the foreman asks for. briefing is non-empty only on shift 1.
export const ShiftOrdersSchema = z.object({
  targetM3: num,
  maxSalinityPpm: num,
  budgetUsd: num,
  lines: z.array(z.string()),
  briefing: z.array(z.string()),
});
export type ShiftOrders = z.infer<typeof ShiftOrdersSchema>;

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

/** A scenario's controller fault on a loop; it lasts until the next shift starts. */
export const LoopFaultKindSchema = z.enum(['stuck', 'drift', 'oscillate']);
export type LoopFaultKind = z.infer<typeof LoopFaultKindSchema>;

export const PlantStatusKindSchema = z.enum(['online', 'tripped', 'restarting', 'acidCleaning']);
export type PlantStatusKind = z.infer<typeof PlantStatusKindSchema>;

/** How fast the game runs: calm is 3 ticks per real second, busy (an open event, a trip) 1. */
export const PaceSchema = z.enum(['calm', 'busy']);
export type Pace = z.infer<typeof PaceSchema>;

export const PlantStatusSchema = z.object({
  gameId: z.uuid(),
  callSign: z.string(),
  /** Restores from a snapshot so far (see the events' epoch); tick can rewind when it goes up. */
  epoch: z.number().int().min(0),
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
  /** fault: the loop's controller fault, null when healthy (optional: older simulators did not report it). */
  loops: z.record(
    LoopIdSchema,
    z.object({ mode: LoopModeSchema, setpoint: num, output: num, fault: LoopFaultKindSchema.nullable().optional() }),
  ),
  pumps: z.record(PumpIdSchema, z.object({ running: z.boolean(), overhaulRemainingTicks: num })),
  fuel: z.object({
    active: FuelKindSchema,
    changeoverTo: FuelKindSchema.nullable(),
    /** Ticks left in the current changeover; null when none is in progress. */
    changeoverRemainingTicks: num.nullable(),
    backupGrade: FuelGradeSchema,
    gasCurtailmentNotice: z.string().nullable(),
    gasPriceUsdPerGJ: num,
    gasCapMW: num,
    /** Price of backup fuel (USD/GJ); orders cost tonnes x LHV x this. */
    backupPriceUsdPerGJ: num,
  }),
  doses: z.object({ chlorineMgL: num, antiscalantMgL: num }),
  /** The live shift target (reflects a mid-shift demandChange); null outside a shift. */
  shiftTarget: z.object({ productM3: num, maxSalinityPpm: num, fuelBudgetUsd: num }).nullable(),
  ballCleaning: z.boolean(),
  divertToDrain: z.boolean(),
  shiftTicksRemaining: num,
  deliveries: z.array(z.object({ arrivesInTicks: num, tonnes: num, grade: FuelGradeSchema })),
  acidCleanRemainingTicks: num,
  restartAuto: z.boolean().nullable(),
  offeredGrade: FuelGradeSchema,
  shiftProductM3: num,
  shiftOffSpecM3: num,
  productFlowM3h: num,
  crew: z.object({ job: CrewJobSchema, remainingTicks: num }).nullable(),
  /** Pending orders during handover, the active ones while running, null otherwise. */
  orders: ShiftOrdersSchema.nullable(),
  /** The active shift's hell flag; null in handover so an unwarned hell can't be peeked at. */
  hell: z.boolean().nullable(),
  mode: GameModeSchema.default('normal'),
  /** Optional on the wire: older simulators did not report it. */
  pace: PaceSchema.default('calm'),
});
export type PlantStatus = z.infer<typeof PlantStatusSchema>;
