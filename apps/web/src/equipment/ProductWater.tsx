import { salinityLimit } from '../alarms/rules';
import { DESIGN_PRODUCT_M3H } from '../plantConstants';
import { C, clamp01, fmt, get, num } from './format';
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
  const fillH = (frac ?? 0) * 66;
  const pFlow = flowFrac(flow, DESIGN_PRODUCT_M3H);
  return (
    <svg viewBox="0 0 200 104" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Product water">
      <Pipe name="distillate" d="M0 40 H60" stroke={C.water} width={5} flow={pFlow} />
      <rect x={60} y={12} width={70} height={72} rx={6} fill={C.body} stroke={C.line} strokeWidth={2} />
      <rect x={62} y={82 - fillH} width={66} height={fillH} rx={4} fill={C.water} opacity={0.7} />
      <text x={95} y={52} fill={C.text} fontSize={10} textAnchor="middle">{fmt(frac === undefined ? undefined : frac * 100, 0, '%')}</text>
      <text x={95} y={64} fill={C.muted} fontSize={6} textAnchor="middle">of target</text>
      <Pipe name="analyser" d="M130 40 H145" stroke={C.water} width={3} flow={pFlow} />
      <rect x={145} y={25} width={50} height={30} rx={3} fill={C.screen} stroke={salColor} />
      <text x={170} y={44} fill={salColor === C.line ? C.muted : salColor} fontSize={9} textAnchor="middle">{fmt(sal, 0, 'ppm')}</text>
      <text x={170} y={64} fill={C.muted} fontSize={6} textAnchor="middle">limit {limit} ppm</text>
      {divert && <Pipe name="drain" d="M95 84 V92 H140" stroke={C.warn} width={3} flow={pFlow} />}
      <text x={4} y={102} fill={C.text} fontSize={8}>{fmt(flow, 0, 'm³/h')}</text>
      <text x={196} y={102} fill={divert ? C.warn : salColor === C.line ? C.muted : salColor} fontSize={8} textAnchor="end">{verdict}</text>
    </svg>
  );
}
