import type { CSSProperties } from 'react';
import { num } from './format';

/** Seconds per dash cycle at nominal flow; faster flow shortens it, within [MIN_S, MAX_S]. */
const NOMINAL_S = 1.2;
const MIN_S = 0.5;
const MAX_S = 6;

/** Dash-cycle duration for a flow given as a fraction of nominal; a stopped pipe gets MAX_S (and is paused by CSS). */
export function flowSpeedS(flow: number | undefined): number {
  if (!num(flow) || flow <= 0) return MAX_S;
  return Math.round(Math.min(MAX_S, Math.max(MIN_S, NOMINAL_S / flow)) * 100) / 100;
}

/** A flow as a fraction of its nominal, or undefined when unknown. */
export const flowFrac = (v: number | undefined, nominal: number): number | undefined =>
  num(v) && nominal > 0 ? Math.max(0, v / nominal) : undefined;

export interface PipeProps {
  d: string;
  stroke: string;
  width: number;
  /** Flow as a fraction of nominal (1 = design flow); 0 or missing stops the dashes. */
  flow: number | undefined;
  /** Names the pipe for tests (`data-pipe`). */
  name?: string;
  opacity?: number;
}

/** A pipe run with moving dashes over it; their speed follows the flow (motion.css animates stroke-dashoffset). */
export function Pipe({ d, stroke, width, flow, name, opacity }: PipeProps) {
  const flowing = num(flow) && flow > 0;
  const style = { '--flow-speed': `${flowSpeedS(flow)}s` } as CSSProperties;
  return (
    <g className="pipe" data-pipe={name} data-flowing={String(flowing)} style={style} opacity={opacity}>
      <path d={d} stroke={stroke} strokeWidth={width} fill="none" />
      <path className="pipe__flow" d={d} stroke="var(--text)" strokeWidth={Math.max(0.8, width * 0.4)} fill="none" />
    </g>
  );
}
