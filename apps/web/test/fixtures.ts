import type { PublicLeaderboard, ShiftReport } from '@desal/schema';

/** A shift 2 report: one event of each verdict, an earthquake noted, 8 pace points, compared with shift 1. */
export function report(over: Partial<ShiftReport> = {}): ShiftReport {
  return {
    shiftId: 2, epoch: 0, mode: 'normal', grade: 'B', score: 84,
    targetM3: 4056, productM3: 3900, offSpecM3: 20, offSpecMinutes: 4, trips: 0, spentUsd: 7000, minutesTripped: 6.5,
    self: { shiftId: 2, targetPct: 96, handledWell: 2, handledOf: 4, minutesTripped: 6.5 },
    events: [
      { eventId: 1, kind: 'pumpTrip', atMinute: 130, responseMinutes: 4, clearMinutes: 4, outcome: 'cleared by you', verdict: 'quick' },
      { eventId: 2, kind: 'tubeLeak', atMinute: 200, responseMinutes: 12, clearMinutes: 40, outcome: 'fixed by crew', verdict: 'ok' },
      { eventId: 3, kind: 'vacuumLoss', atMinute: 300, responseMinutes: 22, clearMinutes: 30, outcome: 'fixed by crew', verdict: 'slow' },
      { eventId: 4, kind: 'storm', atMinute: 400, responseMinutes: null, clearMinutes: null, outcome: 'not cleared', verdict: 'missed' },
      { eventId: 5, kind: 'earthquake', atMinute: 410, responseMinutes: null, clearMinutes: 0, outcome: 'noted', verdict: null },
    ],
    pace: Array.from({ length: 8 }, (_, i) => ({ hour: i + 1, productM3: 480 * (i + 1), targetM3: 507 * (i + 1) })),
    vsPrevious: { shiftId: 1, targetPct: 88, handledWell: 1, handledOf: 2, minutesTripped: 0 },
    vsBest: { shiftId: 1, targetPct: 88, handledWell: 1, handledOf: 2, minutesTripped: 0 },
    ...over,
  };
}

// 19 Nov 2026 at noon UTC, so the shown date is 19 Nov in any time zone within ±11 h.
const NOV19 = Date.UTC(2026, 10, 19, 12);
const row = (rank: number, callSign: string, totalProductM3: number, shiftsCompleted: number) =>
  ({ rank, callSign, totalProductM3, shiftsCompleted, endedAt: NOV19 });

/** Normal and Hard boards with distinct call signs, so a row shows in only its own section. */
export function board(over: Partial<PublicLeaderboard> = {}): PublicLeaderboard {
  return {
    updatedAt: NOV19, online: 3,
    normal: {
      allTime: [row(1, 'Kestrel-42', 41200, 11), row(2, 'Heron-17', 30100, 8)],
      today: [row(1, 'Plover-88', 12000, 3)],
      stats: [{ kind: 'vacuumLoss', operators: 40, firstHandledWellPct: 62 }, { kind: 'pumpTrip', operators: 40, firstHandledWellPct: 81.6 }],
    },
    hard: {
      allTime: [row(1, 'Osprey-23', 9800, 3)],
      today: [row(1, 'Gannet-11', 4100, 1)],
      stats: [{ kind: 'storm', operators: 5, firstHandledWellPct: 20 }],
    },
    ...over,
  };
}
