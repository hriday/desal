import { RECIRC_NOMINAL_M3H } from '../plantConstants';
import { C, VIEWBOX, clamp01, fmt, get } from './format';
import { Pipe, flowFrac } from './Pipe';
import type { EquipmentProps } from './types';

const tbtColor = (t: number | undefined) => (t === undefined ? C.line : t >= 116 ? C.bad : t >= 112 ? C.warn : C.ok);

/** Heater shell with brine tubes, a burner flame sized by firing, and the steam/brine outlet. */
export function BrineHeater({ status, readings }: EquipmentProps) {
  const tbt = get(readings, 'heater.tbtC');
  const firing = get(readings, 'heater.firingPct');
  const flame = Math.round(clamp01((firing ?? 0) / 100) * 100) / 100;
  const sp = status?.loops?.tbt?.setpoint;
  const cond = get(readings, 'heater.burnerCondition');
  const brine = flowFrac(get(readings, 'brine.recircM3h'), RECIRC_NOMINAL_M3H);
  return (
    <svg viewBox={VIEWBOX} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Brine heater">
      <rect x={30} y={28} width={140} height={58} rx={29} fill={C.body} stroke={C.line} strokeWidth={2} />
      <g stroke={C.water} strokeWidth={2.5}>
        <path d="M50 45 H150" /><path d="M50 57 H150" /><path d="M50 69 H150" />
      </g>
      <Pipe name="brine-in" d="M0 57 H30" stroke={C.water} width={5} flow={brine} />
      <Pipe name="brine-out" d="M170 57 H200" stroke={tbtColor(tbt)} width={5} flow={brine} />
      <text x={172} y={48} fill={C.muted} fontSize={9}>to S1</text>
      <path d="M75 86 v10 M125 86 v10" stroke={C.line} strokeWidth={3} />
      <rect x={68} y={96} width={64} height={5} fill={C.plate} />
      {/* The flame grows up from the burner; base at (100, 132). */}
      <g data-flame={flame} transform={`translate(100 132) scale(${0.45 + flame * 1.2}) translate(-10 -18)`} opacity={flame > 0 ? 1 : 0}>
        {/* Size comes from the transform above; motion.css flickers this inner group from its base. */}
        <g className="flame__flicker">
          <path d="M10 18 C0 10 6 4 10 0 C14 6 22 10 10 18Z" fill={C.flame} />
          <path d="M10 18 C6 13 9 9 10 6 C12 10 15 13 10 18Z" fill="#ffd33d" />
        </g>
      </g>
      <text x={4} y={16} fill={C.muted} fontSize={10}>SP {fmt(sp, 1, '°C')}</text>
      <text x={196} y={16} fill={C.muted} fontSize={10} textAnchor="end">burner health {fmt(cond === undefined ? undefined : cond * 100, 0, '%')}</text>
      <text x={4} y={146} fill={tbt !== undefined && tbt >= 112 ? tbtColor(tbt) : C.text} fontSize={12}>TBT {fmt(tbt, 1, '°C')}</text>
      <text x={196} y={146} fill={C.text} fontSize={12} textAnchor="end">Firing {fmt(firing, 0, '%')}</text>
    </svg>
  );
}
