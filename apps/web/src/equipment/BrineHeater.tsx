import { C, clamp01, fmt, get } from './format';
import type { EquipmentProps } from './types';

const tbtColor = (t: number | undefined) => (t === undefined ? C.line : t >= 116 ? C.bad : t >= 112 ? C.warn : C.ok);

/** Heater shell with brine tubes, a burner flame sized by firing, and the steam/brine outlet. */
export function BrineHeater({ status, readings }: EquipmentProps) {
  const tbt = get(readings, 'heater.tbtC');
  const firing = get(readings, 'heater.firingPct');
  const flame = Math.round(clamp01((firing ?? 0) / 100) * 100) / 100;
  const sp = status?.loops?.tbt?.setpoint;
  const cond = get(readings, 'heater.burnerCondition');
  return (
    <svg viewBox="0 0 200 104" role="img" aria-label="Brine heater">
      <rect x={40} y={16} width={120} height={44} rx={22} fill={C.body} stroke={C.line} strokeWidth={2} />
      <g stroke={C.water} strokeWidth={2}>
        <path d="M55 30 H145" /><path d="M55 38 H145" /><path d="M55 46 H145" />
      </g>
      <path d="M0 38 H40" stroke={C.water} strokeWidth={4} />
      <path d="M160 38 H200" stroke={tbtColor(tbt)} strokeWidth={4} />
      <text x={164} y={30} fill={C.muted} fontSize={7}>to S1</text>
      <path d="M80 60 v8 M120 60 v8" stroke={C.line} strokeWidth={3} />
      <rect x={76} y={68} width={48} height={4} fill={C.plate} />
      {/* The flame grows up from the burner; base at (100, 94). */}
      <g data-flame={flame} transform={`translate(100 94) scale(${0.4 + flame * 1.0}) translate(-10 -18)`} opacity={flame > 0 ? 1 : 0}>
        <path d="M10 18 C0 10 6 4 10 0 C14 6 22 10 10 18Z" fill={C.flame} />
        <path d="M10 18 C6 13 9 9 10 6 C12 10 15 13 10 18Z" fill="#ffd33d" />
      </g>
      <text x={4} y={12} fill={C.muted} fontSize={7}>SP {fmt(sp, 1, '°C')}</text>
      <text x={196} y={12} fill={C.muted} fontSize={7} textAnchor="end">burner health {fmt(cond === undefined ? undefined : cond * 100, 0, '%')}</text>
      <text x={4} y={102} fill={tbt !== undefined && tbt >= 112 ? tbtColor(tbt) : C.text} fontSize={8}>TBT {fmt(tbt, 1, '°C')}</text>
      <text x={196} y={102} fill={C.text} fontSize={8} textAnchor="end">Firing {fmt(firing, 0, '%')}</text>
    </svg>
  );
}
