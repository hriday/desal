import { fmt, num } from '../equipment/format';
import type { TrendPoint } from '../state/trends';

const W = 240;
const H = 48;
const PAD = 2;

export interface TrendProps {
  label: string;
  data: readonly TrendPoint[] | undefined;
  unit?: string;
  digits?: number;
  /** Scale shown values, e.g. 100 for a 0..1 fraction shown as percent. */
  scale?: number;
}

/** SVG sparkline over the sensor's ring buffer (the last 10 minutes), with its latest value and range. */
export function Trend({ label, data, unit = '', digits = 0, scale = 1 }: TrendProps) {
  const pts = (data ?? []).filter((p) => num(p?.t) && num(p?.v));
  const last = pts.at(-1);
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); }
  const t0 = pts[0]?.t ?? 0;
  const span = (last?.t ?? 0) - t0;
  const range = hi - lo;
  const points = pts
    .map((p) => {
      const x = span > 0 ? PAD + ((p.t - t0) / span) * (W - 2 * PAD) : W - PAD;
      const y = range > 0 ? H - PAD - ((p.v - lo) / range) * (H - 2 * PAD) : H / 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const show = (v: number | undefined) => fmt(v === undefined ? undefined : v * scale, digits, unit);
  return (
    <figure className="trend" data-trend={label}>
      <figcaption className="trend__head">
        <span>{label}</span>
        <span className="trend__now">{show(last?.v)}</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label} trend, last 10 minutes`}>
        <rect x={0} y={0} width={W} height={H} fill="var(--bg)" />
        {pts.length > 0 && <polyline points={points} fill="none" stroke="var(--water)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="trend__range">
        {pts.length > 0 ? `${show(lo)} – ${show(hi)}` : fmt(undefined)} · 10 min
      </div>
    </figure>
  );
}
