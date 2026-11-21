import { C, clamp01, fmt, get, stageKey } from './format';
import type { EquipmentProps } from './types';

const STAGES = 20;
const LEVEL_MAX_M = 1.0;
const TOP = 20;
const H = 56;
const W = 9.4;

export type ScaleTint = 'ok' | 'warn' | 'bad';
export const scaleTint = (mm: number | undefined): ScaleTint =>
  mm === undefined ? 'ok' : mm >= 0.6 ? 'bad' : mm >= 0.3 ? 'warn' : 'ok';

/** All 20 flash stages: brine level fills each, the shell tints by hard scale, condenser tubes along the top. */
export function FlashStages({ readings }: EquipmentProps) {
  const vac = get(readings, 'vacuum.quality');
  const stages = Array.from({ length: STAGES }, (_, i) => {
    const n = i + 1;
    const k = stageKey(n);
    const level = get(readings, `stages.${k}.levelM`);
    const hard = get(readings, `stages.${k}.hardScaleMm`);
    return { n, level, hard, tint: scaleTint(hard) };
  });
  const w = stages.reduce<{ n: number; mm: number } | null>(
    (acc, s) => (s.hard !== undefined && (acc === null || s.hard > acc.mm) ? { n: s.n, mm: s.hard } : acc), null);
  const worstTint = scaleTint(w?.mm);
  return (
    <svg viewBox="0 0 200 104" role="img" aria-label="Flash stages">
      {stages.map(({ n, level, tint }) => {
        const x = 4 + (n - 1) * W;
        const fill = level === undefined ? 0 : clamp01(level / LEVEL_MAX_M) * (H - 2);
        return (
          <g key={n} data-stage={n} data-scale={tint}>
            <rect x={x} y={TOP} width={W - 1} height={H} fill={C.body} stroke={tint === 'ok' ? C.line : C[tint]} strokeWidth={tint === 'ok' ? 0.8 : 1.4} />
            {tint !== 'ok' && <rect x={x} y={TOP} width={W - 1} height={H} fill={C[tint]} opacity={0.25} />}
            <rect className="brine" x={x + 0.5} y={TOP + H - 1 - fill} width={W - 2} height={fill} fill={C.deep} />
          </g>
        );
      })}
      <path d={`M4 ${TOP + 6} H${4 + STAGES * W - 1}`} stroke={C.water} strokeWidth={3} />
      <path d={`M4 ${TOP + H + 6} H${4 + STAGES * W - 1}`} stroke={C.ok} strokeWidth={2} opacity={0.7} />
      <text x={4} y={TOP + H + 16} fill={C.muted} fontSize={7}>S1</text>
      <text x={4 + STAGES * W - 1} y={TOP + H + 16} fill={C.muted} fontSize={7} textAnchor="end">S20</text>
      <text x={4} y={12} fill={C.muted} fontSize={7}>CF {fmt(get(readings, 'brine.concentrationFactor'), 2)}</text>
      <text x={196} y={12} fill={vac !== undefined && vac < 0.8 ? (vac < 0.7 ? C.bad : C.warn) : C.muted} fontSize={7} textAnchor="end">Vac {fmt(vac, 2)}</text>
      <text x={4} y={102} fill={C.text} fontSize={8}>20 stages</text>
      <text x={196} y={102} fill={worstTint === 'ok' ? C.muted : C[worstTint]} fontSize={8} textAnchor="end">
        {w ? `S${w.n} scale ${fmt(w.mm, 2, 'mm')}` : `scale ${fmt(undefined)}`}
      </text>
    </svg>
  );
}
