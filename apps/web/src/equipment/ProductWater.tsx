import { C, clamp01, fmt, get } from './format';
import type { EquipmentProps } from './types';

const DEFAULT_MAX_SALINITY_PPM = 25;

/** Distillate into the product tank (filled by in-spec water this shift against target) and the salinity analyser. */
export function ProductWater({ status, readings, target }: EquipmentProps) {
  const flow = get(readings, 'product.flowM3h');
  const sal = get(readings, 'product.salinityPpm');
  const made = get(readings, 'product.shiftProductM3');
  const limit = target?.maxSalinityPpm ?? DEFAULT_MAX_SALINITY_PPM;
  const frac = made !== undefined && target ? clamp01(made / target.productM3) : undefined;
  const salColor = sal === undefined ? C.line : sal > limit ? C.bad : sal >= 0.8 * limit ? C.warn : C.ok;
  const divert = status?.divertToDrain ?? false;
  const verdict = divert ? 'to drain' : sal === undefined ? '—' : sal > limit ? 'off spec' : sal >= 0.8 * limit ? 'near limit' : 'in spec';
  const fillH = (frac ?? 0) * 66;
  return (
    <svg viewBox="0 0 200 104" role="img" aria-label="Product water">
      <path d="M0 40 H60" stroke={C.water} strokeWidth={5} />
      <rect x={60} y={12} width={70} height={72} rx={6} fill={C.body} stroke={C.line} strokeWidth={2} />
      <rect x={62} y={82 - fillH} width={66} height={fillH} rx={4} fill={C.water} opacity={0.7} />
      <text x={95} y={52} fill={C.text} fontSize={10} textAnchor="middle">{fmt(frac === undefined ? undefined : frac * 100, 0, '%')}</text>
      <text x={95} y={64} fill={C.muted} fontSize={6} textAnchor="middle">of target</text>
      <path d="M130 40 H145" stroke={C.water} strokeWidth={3} />
      <rect x={145} y={25} width={50} height={30} rx={3} fill={C.screen} stroke={salColor} />
      <text x={170} y={44} fill={salColor === C.line ? C.muted : salColor} fontSize={9} textAnchor="middle">{fmt(sal, 0, 'ppm')}</text>
      <text x={170} y={64} fill={C.muted} fontSize={6} textAnchor="middle">limit {limit} ppm</text>
      {divert && <path d="M95 84 V92 H140" stroke={C.warn} strokeWidth={3} />}
      <text x={4} y={102} fill={C.text} fontSize={8}>{fmt(flow, 0, 'm³/h')}</text>
      <text x={196} y={102} fill={divert ? C.warn : salColor === C.line ? C.muted : salColor} fontSize={8} textAnchor="end">{verdict}</text>
    </svg>
  );
}
