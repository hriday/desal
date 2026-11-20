import { z } from 'zod';

const num = z.number().finite();

const LEVEL_RE = /^level([1-9]|1[0-9]|20)$/;

export type LoopId = 'tbt' | 'intakeFlow' | 'recirc' | 'blowdown' | 'vacuum' | `level${number}`;

export const LoopIdSchema: z.ZodType<LoopId> = z.custom<LoopId>(
  (v) =>
    typeof v === 'string' &&
    (['tbt', 'intakeFlow', 'recirc', 'blowdown', 'vacuum'].includes(v) || LEVEL_RE.test(v)),
  { message: 'Invalid loop id' },
);

export const PumpIdSchema = z.enum(['P-101', 'P-102', 'P-103']);
export type PumpId = z.infer<typeof PumpIdSchema>;

export const RestartStepSchema = z.enum(['vacuum', 'recirc', 'ignition', 'ramp']);
export type RestartStep = z.infer<typeof RestartStepSchema>;

export const LoopModeSchema = z.enum(['auto', 'manual']);
export type LoopMode = z.infer<typeof LoopModeSchema>;

export const FuelKindSchema = z.enum(['gas', 'backup']);
export type FuelKind = z.infer<typeof FuelKindSchema>;

export const FuelGradeSchema = z.enum(['standard', 'offgrade']);
export type FuelGrade = z.infer<typeof FuelGradeSchema>;

export const GameModeSchema = z.enum(['normal', 'hard']);
export type GameMode = z.infer<typeof GameModeSchema>;

export const CrewJobSchema = z.enum(['plugTubes', 'repairEjector', 'replaceSensor', 'cleanScreens', 'flushFuel']);
export type CrewJob = z.infer<typeof CrewJobSchema>;

export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('startShift'), mode: LoopModeSchema }),
  z.object({ type: z.literal('setSetpoint'), loop: LoopIdSchema, value: num }),
  z.object({ type: z.literal('setOutput'), loop: LoopIdSchema, value: num }),
  z.object({ type: z.literal('setLoopMode'), loop: LoopIdSchema, mode: LoopModeSchema }),
  z.object({ type: z.literal('pump'), pumpId: PumpIdSchema, action: z.enum(['start', 'stop']) }),
  z.object({ type: z.literal('setDose'), chemical: z.enum(['chlorine', 'antiscalant']), mgL: num }),
  z.object({ type: z.literal('ballCleaning'), on: z.boolean() }),
  z.object({ type: z.literal('divertToDrain'), on: z.boolean() }),
  z.object({ type: z.literal('selectFuel'), fuel: FuelKindSchema }),
  z.object({ type: z.literal('orderFuel'), tonnes: num }),
  z.object({ type: z.literal('manualTrip') }),
  z.object({ type: z.literal('restart') }),
  z.object({ type: z.literal('restartStep'), step: RestartStepSchema }),
  z.object({ type: z.literal('acidClean') }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('startGame'), mode: GameModeSchema.default('normal') }),
  z.object({ type: z.literal('quitGame') }),
  z.object({ type: z.literal('heartbeat') }),
  z.object({ type: z.literal('overhaulPump'), pumpId: PumpIdSchema }),
  z.object({ type: z.literal('dispatchCrew'), job: CrewJobSchema }),
]);
export type Command = z.infer<typeof CommandSchema>;

export const CommandEnvelopeSchema = z.object({
  commandId: z.uuid(),
  issuedAt: num,
  gameId: z.uuid(),
  shiftId: num.nullable(),
  command: CommandSchema,
});
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;
