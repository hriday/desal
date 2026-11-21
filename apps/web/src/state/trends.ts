export const MAX_POINTS = 600; // 10 minutes at one frame per second

export interface TrendPoint { t: number; v: number }
export type Trends = Record<string, TrendPoint[]>;

/** Append one frame's readings; each sensor keeps its latest MAX_POINTS points. Returns a new object. */
export function pushFrame(trends: Trends, plantTime: number, readings: Record<string, number>): Trends {
  const next: Trends = { ...trends };
  for (const [id, v] of Object.entries(readings)) {
    const prev = next[id];
    const arr = prev ? (prev.length >= MAX_POINTS ? prev.slice(prev.length - MAX_POINTS + 1) : prev.slice()) : [];
    arr.push({ t: plantTime, v });
    next[id] = arr;
  }
  return next;
}
