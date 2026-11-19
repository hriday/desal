import { salinityLimit } from '../alarms/rules';
import { DESIGN_PRODUCT_M3H } from '../plantConstants';
import { C, VIEWBOX, clamp01, fmt, get, num } from './format';
import { Pipe, flowFrac } from './Pipe';
import type { EquipmentProps } from './types';

/** Distillate into the product tank (filled by in-spec water this shift against target) and the salinity analyser. */
export function ProductWater({ status, readings, target }: EquipmentProps) {
  const flow = get(readings, 'product.flowM3h');
  const sal = get(readings, 'product.salinityPpm');
  const made = get(readings, 'product.shiftProductM3');
  const limit = salinityLimit(target);
  const goal = target?.productM3;
  const frac = made !== undefined && num(goal) && goal > 0 ? clamp01(made / goal) : undefined;
  const salColor = sal === undefined ? C.line : sal > limit ? C.bad : sal >= 0.8 * limit ? C.warn : C.ok;
  const divert = status?.divertToDrain === true;
  const verdict = divert ? 'to drain' : sal === undefined ? '—' : sal > limit ? 'off spec' : sal >= 0.8 * limit ? 'near limit' : 'in spec';
  const fillH = (frac ?? 0) * 104;
  const pFlow = flowFrac(flow, DESIGN_PRODUCT_M3H);
  return (
    <svg viewBox={VIEWBOX} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Product water">
      <Pipe name="distillate" d="M0 56 H58" stroke={C.water} width={6} flow={pFlow} />
      <rect x={58} y={14} width={76} height={108} rx={7} fill={C.body} stroke={C.line} strokeWidth={2} />
      <rect x={60} y={120 - fillH} width={72} height={fillH} rx={5} fill={C.water} opacity={0.7} />
      <text x={96} y={70} fill={C.text} fontSize={16} textAnchor="middle">{fmt(frac === undefined ? undefined : frac * 100, 0, '%')}</text>
      <text x={96} y={84} fill={C.muted} fontSize={9} textAnchor="middle">of target</text>
      <Pipe name="analyser" d="M134 56 H144" stroke={C.water} width={4} flow={pFlow} />
      <rect x={144} y={36} width={52} height={40} rx={4} fill={C.screen} stroke={salColor} />
      <text x={170} y={61} fill={salColor === C.line ? C.muted : salColor} fontSize={12} textAnchor="middle">{fmt(sal, 0, 'ppm')}</text>
      <text x={170} y={92} fill={C.muted} fontSize={8} textAnchor="middle">limit {limit} ppm</text>
      {divert && <Pipe name="drain" d="M96 122 V130 H150" stroke={C.warn} width={4} flow={pFlow} />}
      <text x={4} y={146} fill={C.text} fontSize={12}>{fmt(flow, 0, 'm³/h')}</text>
      <text x={196} y={146} fill={divert ? C.warn : salColor === C.line ? C.muted : salColor} fontSize={12} textAnchor="end">{verdict}</text>
    </svg>
  );
}
