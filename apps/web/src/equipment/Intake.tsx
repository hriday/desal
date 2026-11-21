import type { PumpId } from '@desal/schema';
import { C, clamp01, fmt, get } from './format';
import type { EquipmentProps } from './types';

const PUMPS: readonly PumpId[] = ['P-101', 'P-102', 'P-103'];
// Fixed algae positions in the sea, drawn in order as chlorophyll rises.
const ALGAE: readonly [number, number, number][] = [
  [18, 72, 2], [34, 80, 2.5], [50, 70, 2], [12, 84, 1.5], [44, 86, 2.5], [26, 66, 1.5], [56, 82, 2], [8, 74, 2],
  [38, 74, 1.5], [22, 88, 2], [52, 64, 1.5], [30, 84, 2], [14, 64, 1.5], [46, 78, 2], [58, 72, 1.5], [6, 88, 1.5],
];
const ALGAE_PER_UGL = 1.5;

const wearColor = (w: number) => (w >= 0.7 ? C.bad : w >= 0.4 ? C.warn : C.ok);
const levelColor = (v: number | undefined, warn: number, bad: number) =>
  v === undefined ? C.line : v >= bad ? C.bad : v >= warn ? C.warn : C.line;

/** Sea, algae, screen and the three intake pumps feeding the header. */
export function Intake({ status, readings }: EquipmentProps) {
  const chl = get(readings, 'pretreat.chlorophyllUgL');
  const fouling = get(readings, 'intake.screenFouling');
  const flow = get(readings, 'intake.flowM3h');
  const algae = chl === undefined ? 0 : Math.min(ALGAE.length, Math.round(chl * ALGAE_PER_UGL));
  return (
    <svg viewBox="0 0 200 104" role="img" aria-label="Intake">
      <path d="M0 58 Q8 52 16 58 T32 58 T48 58 T64 58 V92 H0Z" fill={C.deep} />
      <g className="algae" fill={C.ok} opacity={0.8}>
        {ALGAE.slice(0, algae).map(([x, y, r], i) => <circle key={i} cx={x} cy={y} r={r} />)}
      </g>
      <rect x={64} y={44} width={8} height={48} fill={C.plate} stroke={levelColor(fouling, 0.3, 0.5)} />
      <text x={56} y={40} fill={C.muted} fontSize={7}>screen {fmt(fouling, 2)}</text>
      <path d="M72 68 H196" stroke={C.water} strokeWidth={5} />
      {PUMPS.map((id, i) => {
        const p = status?.pumps?.[id];
        const running = p?.running === true;
        const wear = get(readings, `intake.${id}.wear`);
        const cx = 98 + i * 36;
        return (
          <g key={id} data-pump={id} data-running={String(running)}>
            <text x={cx - 12} y={50} fill={C.muted} fontSize={7}>{id}</text>
            <circle cx={cx} cy={68} r={11} fill={C.body} stroke={C.line} strokeWidth={1.5} />
            <path d={`M${cx - 6} 68 L${cx} 61 L${cx + 6} 68 L${cx} 75Z`} fill={running ? C.ok : C.plate} />
            {p && p.overhaulRemainingTicks > 0 && <text x={cx - 8} y={90} fill={C.warn} fontSize={6}>OVHL</text>}
            <rect x={cx - 12} y={82} width={24} height={3} fill={C.track} />
            {wear !== undefined && <rect x={cx - 12} y={82} width={24 * clamp01(wear)} height={3} fill={wearColor(wear)} />}
            <text x={cx - 12} y={93} fill={C.muted} fontSize={6}>wear {fmt(wear === undefined ? undefined : wear * 100, 0, '%')}</text>
          </g>
        );
      })}
      <text x={4} y={14} fill={C.text} fontSize={9}>Flow {fmt(flow, 0, 'm³/h')}</text>
      <text x={4} y={102} fill={C.muted} fontSize={8}>{fmt(get(readings, 'intake.seawaterTempC'), 1, '°C')} sea</text>
      <text x={196} y={102} fill={levelColor(chl, 4, Infinity)} fontSize={8} textAnchor="end">Chl-a {fmt(chl, 1)} µg/L</text>
    </svg>
  );
}
