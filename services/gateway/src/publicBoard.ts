import {
  PublicLeaderboardSchema,
  type Leaderboard,
  type LeaderboardRow,
  type ModeBoard,
  type PlantEvent,
  type PublicLeaderboard,
} from '@desal/schema';

// A runId identifies a player's run across Kafka topics (run.results, run.ranks). It never reaches a
// browser: these helpers are what the gateway sends instead.

/** The event without its runId (gameEnd and shiftEnd carry one on Kafka). Always a copy. */
export function stripRunId(e: PlantEvent): PlantEvent {
  const copy = { ...e } as PlantEvent & { runId?: string };
  delete copy.runId;
  return copy;
}

const rows = (list: LeaderboardRow[]) => list.map(({ runId: _runId, ...row }) => row);
const modeBoard = (b: ModeBoard) => ({ allTime: rows(b.allTime), today: rows(b.today), stats: b.stats });

/**
 * The board as GET /api/leaderboard serves it: both modes, every runId removed. The result is
 * parsed with the public schema (strict rows), so any key it does not define is dropped and a
 * leaked runId would throw rather than be served.
 */
export function toPublic(board: Leaderboard): PublicLeaderboard {
  return PublicLeaderboardSchema.parse({
    updatedAt: board.updatedAt,
    online: board.online,
    normal: modeBoard(board.normal),
    hard: modeBoard(board.hard),
  });
}
