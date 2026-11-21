import type { PlantEvent, PlantStatus, ScenarioKind } from '@desal/schema';
import { salinityLimit } from '../alarms/rules';
import { FIX } from '../expanded/labels';
import type { TrendPoint } from './trends';

/** Plant minutes an event stays open before the radio hints its fix (Normal only), unless its FIX entry sets `delayMin`. */
export const HINT_DELAY_MIN = 20;

export interface DueHint { key: string; eventId: number; kind: ScenarioKind; text: string }

/**
 * The hints due now, not yet in `hinted` (pure). None on Hard or outside a running shift. Only this
 * shift's scenario events count: 'delay' kinds once open their delay (FIX `delayMin`, else HINT_DELAY_MIN) and their fix is not under
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
      (fix.hint === 'delay' && !cleared.has(e.eventId) && status.plantTime - e.plantTime >= (fix.delayMin ?? HINT_DELAY_MIN) * 60_000 && !fix.underway?.(status));
    if (due) out.push({ key, eventId: e.eventId, kind: e.kind, text: `Hint: ${fix.text}` });
  }
  return out;
}

/** Plant minutes the product must stay in spec, with Divert to drain still on by hand, before the radio says so (Normal only). */
export const DIVERT_HINT_MIN = 5;

/**
 * The "put Divert back on Auto" hint (pure): Normal, running, Manual with the valve to drain, and the
 * salinity trend under the limit for DIVERT_HINT_MIN plant minutes. The stretch starts at the first
 * point after the last off-spec one (or the first point), and its key is per stretch, so it shows once each.
 */
export function divertHint(status: PlantStatus, salinity: TrendPoint[] | undefined, hinted: ReadonlySet<string>): { key: string; text: string } | null {
  if (status.mode === 'hard' || status.phase !== 'running' || status.divertMode !== 'manual' || status.divertToDrain !== true) return null;
  if (!salinity || salinity.length === 0) return null;
  const limit = salinityLimit(status.shiftTarget);
  let since = salinity[0]!.t;
  // The key names the last off-spec point (or 'start'), not `since`, so it stays put as the trend window slides.
  // `hinted` and the trends live in memory only, so a reload can repeat the hint once.
  let lastOff = 'start';
  for (let i = salinity.length - 1; i >= 0; i--) {
    if (salinity[i]!.v > limit) {
      const next = salinity[i + 1];
      if (!next) return null; // off-spec right now
      since = next.t;
      lastOff = String(salinity[i]!.t);
      break;
    }
  }
  if (salinity[salinity.length - 1]!.t - since < DIVERT_HINT_MIN * 60_000) return null;
  const key = `${status.shiftId}:divert:${lastOff}`;
  if (hinted.has(key)) return null;
  return { key, text: "Hint: Product's back in spec — put Divert back on Auto." };
}
