import type { PlantEvent, PlantStatus, ScenarioKind } from '@desal/schema';
import { FIX } from '../expanded/labels';

/** Plant minutes an event stays open before the radio hints its fix (Normal only). */
export const HINT_DELAY_MIN = 20;

export interface DueHint { key: string; eventId: number; kind: ScenarioKind; text: string }

/**
 * The hints due now, not yet in `hinted` (pure). None on Hard or outside a running shift. Only this
 * shift's scenario events count: 'delay' kinds once open HINT_DELAY_MIN and their fix is not under
 * way; 'atOnce' kinds as soon as they fire, cleared (noted) or not.
 */
export function dueHints(events: PlantEvent[], status: PlantStatus, hinted: ReadonlySet<string>): DueHint[] {
  if (status.mode === 'hard' || status.phase !== 'running') return [];
  const shiftId = status.shiftId;
  const cleared = new Set<number>();
  for (const e of events) if (e.type === 'eventCleared' && e.shiftId === shiftId) cleared.add(e.eventId);
  const out: DueHint[] = [];
  for (const e of events) {
    if (e.type !== 'scenario' || e.shiftId !== shiftId) continue;
    const key = `${e.shiftId}:${e.eventId}:hint`;
    // An event can be listed twice (a restore replays it): one hint per (shift, eventId).
    if (hinted.has(key) || out.some((h) => h.key === key)) continue;
    const fix = FIX[e.kind];
    const due =
      fix.hint === 'atOnce' ||
      (fix.hint === 'delay' && !cleared.has(e.eventId) && status.plantTime - e.plantTime >= HINT_DELAY_MIN * 60_000 && !fix.underway?.(status));
    if (due) out.push({ key, eventId: e.eventId, kind: e.kind, text: `Hint: ${fix.text}` });
  }
  return out;
}
