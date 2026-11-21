import {
  DESIGN_PRODUCT_M3H, INTAKE_REQUIRED_BASE_M3H, MAKEUP_NOMINAL_M3H, RECIRC_NOMINAL_M3H, RECOVERY_STAGES, STAGE_COUNT,
} from '../plantConstants';
import { C, VIEWBOX, clamp01, fmt, get, stageKey } from './format';
import { Pipe, flowFrac } from './Pipe';
import type { EquipmentProps } from './types';

const LEVEL_MAX_M = 1.0;
const TOP = 30;
const H = 76;
/** Stage pitch; each shell is one unit narrower. */
const W = 7.6;
/** Extra space between the heat-recovery (1-21) and heat-rejection (22-24) sections. */
const GAP = 8;
/** Height of the tube line along the top of every stage. */
const TUBES = TOP + 8;

const stageX = (n: number) => 4 + (n - 1) * W + (n > RECOVERY_STAGES ? GAP : 0);
const stageMid = (n: number) => stageX(n) + (W - 1) / 2;
const LAST = STAGE_COUNT;
const RIGHT = stageX(LAST) + W - 1;
/** In the gap: where the recycle line rises into S21's tubes, and where the seawater leaving S22's tubes splits. */
const RECYCLE_X = stageX(RECOVERY_STAGES) + W + 1.4;
const SPLIT_X = stageX(RECOVERY_STAGES + 1) - 2.2;

export type ScaleTint = 'ok' | 'warn' | 'bad';
export const scaleTint = (mm: number | undefined): ScaleTint =>
  mm === undefined ? 'ok' : mm >= 0.6 ? 'bad' : mm >= 0.3 ? 'warn' : 'ok';

/**
 * All 24 flash stages: brine level fills each, the shell tints by hard scale, tubes along the top. Heat
 * recovery (S1-S21) and heat rejection (S22-S24, S24 holding the brine pool) are drawn apart. Seawater runs
 * through the reject tubes S24 -> S22, then splits: makeup into the S24 pool, the rest back to sea; the
 * recirculation pump draws from the pool into S21's tubes, through S21 -> S1 to the heater.
 */
export function FlashStages({ readings }: EquipmentProps) {
  const vac = get(readings, 'vacuum.quality');
  const stages = Array.from({ length: STAGE_COUNT }, (_, i) => {
    const n = i + 1;
    const k = stageKey(n);
    const level = get(readings, `stages.${k}.levelM`);
    const hard = get(readings, `stages.${k}.hardScaleMm`);
    return { n, level, hard, tint: scaleTint(hard) };
  });
  const w = stages.reduce<{ n: number; mm: number } | null>(
    (acc, s) => (s.hard !== undefined && (acc === null || s.hard > acc.mm) ? { n: s.n, mm: s.hard } : acc), null);
  const worstTint = scaleTint(w?.mm);
  const shell = ({ n, level, tint }: (typeof stages)[number]) => {
    const x = stageX(n);
    const fill = level === undefined ? 0 : clamp01(level / LEVEL_MAX_M) * (H - 2);
    return (
      <g key={n} data-stage={n} data-scale={tint}>
        <rect x={x} y={TOP} width={W - 1} height={H} fill={C.body} stroke={tint === 'ok' ? C.line : C[tint]} strokeWidth={tint === 'ok' ? 0.8 : 1.4} />
        {tint !== 'ok' && <rect x={x} y={TOP} width={W - 1} height={H} fill={C[tint]} opacity={0.25} />}
        <rect className="brine" style={{ animationDelay: `${-((n * 0.37) % 2.4).toFixed(2)}s` }} x={x + 0.5} y={TOP + H - 1 - fill} width={W - 2} height={fill} fill={C.deep} />
      </g>
    );
  };
  const intake = get(readings, 'intake.flowM3h');
  return (
    <svg viewBox={VIEWBOX} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Flash stages">
      <g data-section="recovery">{stages.filter((s) => s.n <= RECOVERY_STAGES).map(shell)}</g>
      <g data-section="reject">{stages.filter((s) => s.n > RECOVERY_STAGES).map(shell)}</g>
      {/* Distillate collects S1 -> S24. */}
      <Pipe name="distillate" d={`M4 ${TOP + H + 5} H${RIGHT}`} stroke={C.ok} width={2.5} opacity={0.7}
        flow={flowFrac(get(readings, 'product.flowM3h'), DESIGN_PRODUCT_M3H)} />
      {/* Recycle: from the S24 pool, up the gap into S21's tubes, through S21 -> S1 to the heater. */}
      <Pipe name="recycle" d={`M${stageMid(LAST)} ${TOP + H} V${TOP + H + 12} H${RECYCLE_X} V${TUBES} H4`} stroke={C.water} width={3.5}
        flow={flowFrac(get(readings, 'brine.recircM3h'), RECIRC_NOMINAL_M3H)} />
      {/* Cooling seawater: in through the reject tubes S24 -> S22, then split. */}
      <Pipe name="seawater" d={`M199 ${TUBES} H${SPLIT_X}`} stroke={C.water} width={3}
        flow={flowFrac(intake, INTAKE_REQUIRED_BASE_M3H)} />
      <Pipe name="coolingReject" d={`M${SPLIT_X} ${TUBES} V${TOP - 10} H199`} stroke={C.water} width={2} opacity={0.7}
        flow={flowFrac(get(readings, 'brine.coolingRejectM3h'), INTAKE_REQUIRED_BASE_M3H - MAKEUP_NOMINAL_M3H)} />
      <Pipe name="makeup" d={`M${SPLIT_X} ${TUBES} V${TOP - 4} H${stageMid(LAST)} V${TUBES + 8}`} stroke={C.water} width={2}
        flow={flowFrac(get(readings, 'brine.makeupM3h'), MAKEUP_NOMINAL_M3H)} />
      <text x={4} y={TOP + H + 24} fill={C.muted} fontSize={9}>S1</text>
      <text x={stageX(RECOVERY_STAGES) + W - 1} y={TOP + H + 24} fill={C.muted} fontSize={9} textAnchor="end">S{RECOVERY_STAGES}</text>
      <text x={RIGHT} y={TOP + H + 24} fill={C.muted} fontSize={9} textAnchor="end">S{LAST}</text>
      <text x={4} y={13} fill={C.muted} fontSize={10}>CF {fmt(get(readings, 'brine.concentrationFactor'), 2)}</text>
      <text x={196} y={13} fill={vac !== undefined && vac < 0.8 ? (vac < 0.7 ? C.bad : C.warn) : C.muted} fontSize={10} textAnchor="end">Vac {fmt(vac, 2)}</text>
      <text x={4} y={146} fill={C.text} fontSize={11}>{STAGE_COUNT} stages</text>
      <text x={196} y={146} fill={worstTint === 'ok' ? C.muted : C[worstTint]} fontSize={11} textAnchor="end">
        {w ? `S${w.n} scale ${fmt(w.mm, 2, 'mm')}` : `scale ${fmt(undefined)}`}
      </text>
    </svg>
  );
}
