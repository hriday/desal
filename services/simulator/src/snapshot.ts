import {
  CrewJobSchema,
  FuelGradeSchema,
  GameEndReasonSchema,
  FuelKindSchema,
  LoopModeSchema,
  PhaseSchema,
  PlantStatusKindSchema,
  RestartStepSchema,
  ShiftOrdersSchema,
  ScenarioKindSchema,
  TripCauseSchema,
} from '@desal/schema';
import { z } from 'zod';
import { STAGE_COUNT } from './constants.js';
import type { PlantState } from './state.js';

const num = z.number().finite();

const LoopSchema = z.object({
  mode: LoopModeSchema,
  setpoint: num,
  output: num,
  integral: num,
  prevError: num,
  fault: z.object({ kind: z.enum(['stuck', 'drift', 'oscillate']), bias: num }).nullable(),
});
const QueuedEventSchema = z.object({
  eventId: num,
  kind: ScenarioKindSchema,
  params: z.record(z.string(), z.union([num, z.string()])),
  earliestMinute: num,
  cascade: z.boolean(),
});
const ChaosPlanSchema = z.object({
  shiftNumber: num,
  hell: z.boolean(),
  warned: z.boolean(),
  targetM3: num,
  orders: ShiftOrdersSchema,
  queue: z.array(QueuedEventSchema),
});
const FiredEventSchema = z.object({
  eventId: num,
  kind: ScenarioKindSchema,
  atMinute: num,
  cleared: z.boolean(),
  how: z.enum(['player', 'crew', 'expired', 'noted']).nullable(),
});
const SensorFaultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('freeze'), value: num }),
  z.object({ kind: z.literal('noise'), amplitude: num }),
]);
const PumpSchema = z.object({ running: z.boolean(), wear: num, cavitation: num, bearingWearMult: num, overhaulRemainingTicks: num });
const StageSchema = z.object({ tempC: num, levelM: num, softScaleMm: num, hardScaleMm: num });
const TargetSchema = z.object({ productM3: num, maxSalinityPpm: num, fuelBudgetUsd: num });
const ScenarioSchema = z.object({
  id: z.string(),
  target: TargetSchema,
  initial: z.object({
    seawaterTempC: num,
    chlorophyllUgL: num,
    gasCapMW: num.optional(),
    gasPriceUsdPerGJ: num.optional(),
  }),
  events: z.array(
    z.object({
      atMinute: num,
      kind: ScenarioKindSchema,
      params: z.record(z.string(), z.union([num, z.string()])),
      message: z.string(),
    }),
  ),
  randomPerHour: z.array(z.object({ kind: ScenarioKindSchema, p: num })),
});

/** Mirrors PlantState exactly; the assignability checks below fail to compile if the two drift. */
export const PlantStateSchema = z.object({
  version: z.literal(1),
  seed: num,
  tick: num,
  plantTime: num,
  phase: PhaseSchema,
  controlMode: LoopModeSchema,
  status: PlantStatusKindSchema,
  trip: z.object({ cause: TripCauseSchema, atTick: num }).nullable(),
  restart: z
    .object({
      step: RestartStepSchema,
      stepStartedTick: num,
      auto: z.boolean(),
      prevFiringPct: num,
      // Absent in saves from before the stall timeout: the stall clock then starts at the step start.
      progressTick: num.optional(),
      bestTbtC: num.optional(),
    })
    .transform((r) => ({ ...r, progressTick: r.progressTick ?? r.stepStartedTick, bestTbtC: r.bestTbtC ?? 0 }))
    .nullable(),
  acidCleanRemainingTicks: num,
  loops: z.object({
    tbt: LoopSchema,
    intakeFlow: LoopSchema,
    recirc: LoopSchema,
    blowdown: LoopSchema,
    vacuum: LoopSchema,
    levels: z.array(LoopSchema).length(STAGE_COUNT),
  }),
  seawater: z.object({ tempC: num, salinityGL: num, chlorophyllUgL: num }),
  intake: z.object({
    pumps: z.object({ 'P-101': PumpSchema, 'P-102': PumpSchema, 'P-103': PumpSchema }),
    screenFouling: num,
    flowM3h: num,
    requiredM3h: num,
  }),
  pretreat: z.object({ chlorineMgL: num, antiscalantMgL: num, biofouling: num }),
  heater: z.object({ tbtC: num, firingPct: num, burnerCondition: num, heatMW: num }),
  stages: z.array(StageSchema).length(STAGE_COUNT),
  brine: z.object({ recircM3h: num, concentrationFactor: num, blowdownM3h: num }),
  vacuum: z.object({ quality: num }),
  product: z.object({ flowM3h: num, salinityPpm: num, divertToDrain: z.boolean() }),
  fuel: z.object({
    active: FuelKindSchema,
    changeover: z.object({ to: FuelKindSchema, remainingTicks: num }).nullable(),
    gas: z.object({
      capMW: num,
      priceUsdPerGJ: num,
      curtailmentNotice: z.object({ atTick: num, capMW: num }).nullable(),
    }),
    backup: z.object({ tonnes: num, grade: FuelGradeSchema, priceUsdPerGJ: num }),
    deliveries: z.array(z.object({ arrivesAtTick: num, tonnes: num, grade: FuelGradeSchema })),
    burnMW: num,
  }),
  ballCleaning: z.boolean(),
  shift: z
    .object({
      id: num,
      startTick: num,
      mode: LoopModeSchema,
      target: TargetSchema,
      acc: z.object({ productM3: num, offSpecM3: num, offSpecTicks: num, fuelCostUsd: num, trips: num, spentUsd: num }),
    })
    .nullable(),
  scenario: z.object({
    id: z.string(),
    definition: ScenarioSchema.nullable(),
    nextEventIndex: num,
    effects: z.object({
      offgradeOnly: z.boolean(),
      deliveryDelayTicks: num,
      chlorophyllTarget: num,
      chlorophyllRampPerTick: num,
    }),
  }),
  run: z.object({
    gameId: z.uuid(),
    balanceUsd: num,
    shiftNumber: num,
    totalProductM3: num,
    shiftsCompleted: num,
    eventSeq: num,
    // Saves written before epochs existed have none: they start at 0.
    epoch: z.number().int().min(0).default(0),
    over: z.object({ reason: GameEndReasonSchema, atTick: num }).nullable(),
  }),
  chaos: z.object({
    pending: ChaosPlanSchema.nullable(),
    active: z
      .object({ plan: ChaosPlanSchema, fired: z.array(FiredEventSchema), lastFiredMinute: num.nullable(), nextEventId: num })
      .nullable(),
    lastWasHell: z.boolean(),
  }),
  crew: z.object({ job: CrewJobSchema, remainingTicks: num }).nullable(),
  faults: z.object({
    tubeLeak: z.object({ stage: num, ppm: num }).nullable(),
    ejectorFailed: z.boolean(),
    powerDipRemainingTicks: num,
    stormRemainingTicks: num,
    stormFouling: num,
    sensors: z.object({
      tbt: SensorFaultSchema.optional(),
      intakeFlow: SensorFaultSchema.optional(),
      recirc: SensorFaultSchema.optional(),
      blowdown: SensorFaultSchema.optional(),
      vacuum: SensorFaultSchema.optional(),
    }),
    stageDerate: z.array(num).length(STAGE_COUNT),
  }),
});

// Compile-time drift guard: the schema's type and PlantState must be mutually assignable.
type Inferred = z.infer<typeof PlantStateSchema>;
export const _schemaToState = (x: Inferred): PlantState => x;
export const _stateToSchema = (x: PlantState): Inferred => x;

const FORMAT = 'desal-snapshot';
/**
 * 2 = the multi-game era (economy and game-over state, one save per gameId). Version 1 saves are
 * single-career saves from before games existed; they are rejected and skipped on load.
 * 3 = chaos plan, crew and fault fields.
 */
const VERSION = 3;

export function serialize(s: PlantState): string {
  return JSON.stringify({ format: FORMAT, version: VERSION, savedAt: Date.now(), state: s });
}

function issueText(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = ['state', ...(issue?.path ?? [])].join('.');
  return `invalid state at ${path}: ${issue?.message ?? 'unknown'}`;
}

/** Why `s` would not restore (e.g. a NaN, which JSON writes as null), or null when it is a valid save. */
export function snapshotIssue(s: PlantState): string | null {
  const parsed = PlantStateSchema.safeParse(s);
  return parsed.success ? null : issueText(parsed.error);
}

export type RestoreResult = { ok: true; state: PlantState } | { ok: false; reason: string };

/** Decode and validate a snapshot. Never throws; anything suspect is reported, never loaded. */
export function restore(json: string): RestoreResult {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'invalid JSON' };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, reason: 'snapshot is not an object' };
  }
  const d = doc as Record<string, unknown>;
  if (d.format !== FORMAT) return { ok: false, reason: `wrong format: ${JSON.stringify(d.format)}` };
  if (d.version !== VERSION) return { ok: false, reason: `unknown version: ${JSON.stringify(d.version)}` };
  const parsed = PlantStateSchema.safeParse(d.state);
  if (!parsed.success) return { ok: false, reason: issueText(parsed.error) };
  return { ok: true, state: parsed.data };
}
