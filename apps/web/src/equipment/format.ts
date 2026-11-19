import { TICK_PLANT_S } from '../plantConstants';

/** Shared value formatting for the drawings. Anything missing or non-finite renders as an em dash. */
export const DASH = '—';

export const num = (v: number | undefined | null): v is number => typeof v === 'number' && Number.isFinite(v);

/** A reading, or undefined when missing. */
export const get = (readings: Record<string, number>, id: string): number | undefined =>
  num(readings[id]) ? readings[id] : undefined;

/** `fmt(108, 1, '°C')` -> "108.0 °C"; thousands separated; "—" when missing. */
export function fmt(v: number | undefined | null, digits = 0, unit = ''): string {
  if (!num(v)) return DASH;
  const s = v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return unit ? `${s} ${unit}` : s;
}

export function usd(v: number | undefined | null): string {
  if (!num(v)) return DASH;
  return `${v < 0 ? '-' : ''}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
}


/** "3h 40m" from a tick count. */
export function ticksToHm(ticks: number | undefined | null): string {
  if (!num(ticks)) return DASH;
  const min = Math.round((Math.max(0, ticks) * TICK_PLANT_S) / 60);
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
}

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Stage index (1-based) to its sensor key, e.g. 2 -> "s02". */
export const stageKey = (n: number) => `s${String(n).padStart(2, '0')}`;

/** Status colours (tokens.css). */
export const C = {
  ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)', water: 'var(--water)', flame: 'var(--flame)',
  line: 'var(--muted)', text: 'var(--text)', muted: 'var(--muted)',
  body: '#1d2b3a', plate: '#2a3b4d', deep: '#164a6b', screen: '#152231', track: '#1f2d3d', oil: '#8b5a2b',
} as const;
