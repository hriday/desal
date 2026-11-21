import type { PumpId } from '@desal/schema';
import { useId } from 'react';
import { INTAKE_REQUIRED_BASE_M3H } from '../plantConstants';
import { C, VIEWBOX, clamp01, fmt, get } from './format';
import { Pipe, flowFrac } from './Pipe';
import type { EquipmentProps } from './types';

const PUMPS: readonly PumpId[] = ['P-101', 'P-102', 'P-103'];
// Fixed algae positions in the sea, drawn in order as chlorophyll rises.
const ALGAE: readonly [number, number, number][] = [
  [18, 72, 2], [34, 80, 2.5], [50, 70, 2], [12, 84, 1.5], [44, 86, 2.5], [26, 66, 1.5], [56, 82, 2], [8, 74, 2],
  [38, 74, 1.5], [22, 88, 2], [52, 64, 1.5], [30, 84, 2], [14, 64, 1.5], [46, 78, 2], [58, 72, 1.5], [6, 88, 1.5],
];
const ALGAE_PER_UGL = 1.5;
/** ALGAE was laid out for a sea surface at y 58; the sea now starts at 82. */
const ALGAE_DY = 24;
/** Header and pump centre line. */
const PUMP_Y = 98;

const wearColor = (w: number) => (w >= 0.7 ? C.bad : w >= 0.4 ? C.warn : C.ok);
const levelColor = (v: number | undefined, warn: number, bad: number) =>
  v === undefined ? C.line : v >= bad ? C.bad : v >= warn ? C.warn : C.line;

/** Sea, algae, screen and the three intake pumps feeding the header. */
export function Intake({ status, readings }: EquipmentProps) {
  const chl = get(readings, 'pretreat.chlorophyllUgL');
  const fouling = get(readings, 'intake.screenFouling');
  const flow = get(readings, 'intake.flowM3h');
  const algae = chl === undefined ? 0 : Math.min(ALGAE.length, Math.round(chl * ALGAE_PER_UGL));
  const seaClip = `sea${useId().replace(/[^\w-]/g, '')}`;
  return (
    <svg viewBox={VIEWBOX} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Intake">
      <defs><clipPath id={seaClip}><rect x={0} y={70} width={64} height={62} /></clipPath></defs>
      {/* The surface is one wavelength (16) wider than the sea; motion.css slides it by that much and loops. */}
      <g clipPath={`url(#${seaClip})`}>
        <rect x={0} y={84} width={64} height={48} fill={C.deep} />
        <path className="sea__surface" d="M-16 82 Q-8 75 0 82 T16 82 T32 82 T48 82 T64 82 V86 H-16Z" fill={C.deep} />
      </g>
      <g className="algae" fill={C.ok} opacity={0.8}>
        {ALGAE.slice(0, algae).map(([x, y, r], i) => <circle key={i} cx={x} cy={y + ALGAE_DY} r={r * 1.2} />)}
      </g>
      <rect x={64} y={62} width={8} height={70} fill={C.plate} stroke={levelColor(fouling, 0.3, 0.5)} />
      <text x={52} y={54} fill={C.muted} fontSize={9}>screen {fmt(fouling, 2)}</text>
      <Pipe name="header" d={`M72 ${PUMP_Y} H196`} stroke={C.water} width={6} flow={flowFrac(flow, INTAKE_REQUIRED_BASE_M3H)} />
      {PUMPS.map((id, i) => {
        const p = status?.pumps?.[id];
        const running = p?.running === true;
        const wear = get(readings, `intake.${id}.wear`);
        const cx = 94 + i * 40;
        return (
          <g key={id} className={running ? 'pump is-running' : 'pump'} data-pump={id} data-running={String(running)}>
            <text x={cx} y={74} fill={C.muted} fontSize={9} textAnchor="middle">{id}</text>
            <circle cx={cx} cy={PUMP_Y} r={13} fill={C.body} stroke={C.line} strokeWidth={1.5} />
            <path className="pump__rotor" d={`M${cx - 7} ${PUMP_Y} L${cx} ${PUMP_Y - 8} L${cx + 7} ${PUMP_Y} L${cx} ${PUMP_Y + 8}Z`} fill={running ? C.ok : C.plate} />
            <rect x={cx - 15} y={116} width={30} height={4} fill={C.track} />
            {wear !== undefined && <rect x={cx - 15} y={116} width={30 * clamp01(wear)} height={4} fill={wearColor(wear)} />}
            {/* "wear 12%" (no space before %) so three labels fit side by side. */}
            <text x={cx} y={129} fill={C.muted} fontSize={7} textAnchor="middle">wear {wear === undefined ? fmt(undefined) : `${fmt(wear * 100)}%`}</text>
            {p && p.overhaulRemainingTicks > 0 && <text x={cx} y={62} fill={C.warn} fontSize={8} textAnchor="middle">OVHL</text>}
          </g>
        );
      })}
      <text x={4} y={20} fill={C.text} fontSize={13}>Flow {fmt(flow, 0, 'm³/h')}</text>
      <text x={4} y={146} fill={C.muted} fontSize={11}>{fmt(get(readings, 'intake.seawaterTempC'), 1, '°C')} sea</text>
      <text x={196} y={146} fill={levelColor(chl, 4, Infinity)} fontSize={11} textAnchor="end">Chl-a {fmt(chl, 1)} µg/L</text>
    </svg>
  );
}
