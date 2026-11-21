import { z } from 'zod';
import { GameModeSchema } from './commands.js';
import { GameEndReasonSchema, ScenarioKindSchema } from './events.js';

const num = z.number().finite();
const int = z.number().int();

// Records produced by the Flink jobs (shift report card, run results, leaderboard, run ranks).
// The game never depends on them: with Flink down the browser just does not receive them.

export const GradeSchema = z.enum(['A', 'B', 'C', 'D', 'F']);
export type Grade = z.infer<typeof GradeSchema>;

// quick <= 5, ok <= 15, slow > 15 plant minutes; missed = no response by shift end.
export const VerdictSchema = z.enum(['quick', 'ok', 'slow', 'missed']);
export type Verdict = z.infer<typeof VerdictSchema>;

// The debrief's wording for how an event ended.
export const OutcomeSchema = z.enum(['cleared by you', 'fixed by crew', 'passed', 'noted', 'not cleared']);
export type Outcome = z.infer<typeof OutcomeSchema>;

/** One shift's headline numbers, used to compare a shift with the same player's other shifts. */
export const ComparisonSchema = z.object({
  shiftId: int,
  targetPct: num,
  handledWell: int,
  handledOf: int,
  minutesTripped: num,
});
export type Comparison = z.infer<typeof ComparisonSchema>;

export const ReportEventSchema = z.object({
  eventId: int.min(1),
  kind: ScenarioKindSchema,
  atMinute: num,
  responseMinutes: num.nullable(),
  clearMinutes: num.nullable(),
  outcome: OutcomeSchema,
  verdict: VerdictSchema.nullable(),
});
export type ReportEvent = z.infer<typeof ReportEventSchema>;

/** Cumulative in-spec water at the end of plant hour `hour` (1..8) against the pro-rata target. */
export const PacePointSchema = z.object({ hour: int.min(1).max(8), productM3: num, targetM3: num });
export type PacePoint = z.infer<typeof PacePointSchema>;

// Totals (targetM3, productM3, offSpecM3, offSpecMinutes, trips, spentUsd) are copied from the shiftEnd summary.
export const ShiftReportSchema = z.object({
  shiftId: int.min(1),
  epoch: int.min(0),
  mode: GameModeSchema,
  grade: GradeSchema,
  score: num.min(0).max(100),
  targetM3: num,
  productM3: num,
  offSpecM3: num,
  offSpecMinutes: num,
  trips: num,
  spentUsd: num,
  minutesTripped: num,
  self: ComparisonSchema,
  events: z.array(ReportEventSchema),
  pace: z.array(PacePointSchema).max(8),
  vsPrevious: ComparisonSchema.nullable(),
  vsBest: ComparisonSchema.nullable(),
});
export type ShiftReport = z.infer<typeof ShiftReportSchema>;

export const KindStatSchema = z.object({
  kind: ScenarioKindSchema,
  count: int,
  handledWell: int,
  meanResponseMinutes: num.nullable(),
  firstHandledWell: z.boolean(),
});
export type KindStat = z.infer<typeof KindStatSchema>;

// One finished run. endedAt is epoch milliseconds. Carries no gameId.
export const RunResultSchema = z.object({
  runId: z.uuid(),
  callSign: z.string(),
  mode: GameModeSchema,
  endedAt: int,
  shiftsCompleted: int,
  totalProductM3: num,
  endReason: GameEndReasonSchema,
  kinds: z.array(KindStatSchema),
});
export type RunResult = z.infer<typeof RunResultSchema>;

export const LeaderboardRowSchema = z.object({
  rank: int.min(1),
  callSign: z.string(),
  shiftsCompleted: int,
  totalProductM3: num,
  endedAt: int,
  runId: z.uuid(),
});
export type LeaderboardRow = z.infer<typeof LeaderboardRowSchema>;

// A row as a browser sees it: strict, so a leaked runId fails validation.
export const PublicLeaderboardRowSchema = LeaderboardRowSchema.omit({ runId: true }).strict();
export type PublicLeaderboardRow = z.infer<typeof PublicLeaderboardRowSchema>;

// Stats are for the graded kinds: the sharp kinds, the two disasters graded on time-to-clear, and lowSteam.
export const KindBoardStatSchema = z.object({
  kind: ScenarioKindSchema,
  operators: int,
  firstHandledWellPct: num.min(0).max(100),
});
export type KindBoardStat = z.infer<typeof KindBoardStatSchema>;

const boardOf = <R extends z.ZodType>(row: R) =>
  z.object({ allTime: z.array(row).max(10), today: z.array(row).max(10), stats: z.array(KindBoardStatSchema) });

// One board per mode: Normal and Hard runs never mix.
export const ModeBoardSchema = boardOf(LeaderboardRowSchema);
export type ModeBoard = z.infer<typeof ModeBoardSchema>;

// online counts plants in both modes.
export const LeaderboardSchema = z.object({
  updatedAt: int,
  online: int.min(0),
  normal: ModeBoardSchema,
  hard: ModeBoardSchema,
});
export type Leaderboard = z.infer<typeof LeaderboardSchema>;

// The body of GET /api/leaderboard: the same board without runIds.
export const PublicLeaderboardSchema = z.object({
  updatedAt: int,
  online: int.min(0),
  normal: boardOf(PublicLeaderboardRowSchema),
  hard: boardOf(PublicLeaderboardRowSchema),
});
export type PublicLeaderboard = z.infer<typeof PublicLeaderboardSchema>;

// Ranks are within the run's own mode.
export const RunRankSchema = z.object({
  runId: z.uuid(),
  allTime: int.min(1),
  today: int.min(1).nullable(),
});
export type RunRank = z.infer<typeof RunRankSchema>;
