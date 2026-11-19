import { byWorst, type Alarm } from '../alarms/rules';
import { C, DASH, VIEWBOX, clamp01, fmt, get, label, num, ticksToHm, usd } from './format';
import type { EquipmentProps } from './types';

const STATUS_TEXT: Record<string, string> = { online: 'ONLINE', tripped: 'TRIPPED', restarting: 'RESTARTING', acidCleaning: 'ACID CLEAN' };
const MODE_TEXT: Record<string, string> = { auto: 'Auto mode', manual: 'Manual mode' };

/** Shift number and time left, in-spec water against target (the score), the operating balance, and the top alarms. */
export function ShiftAccount({ status, readings, target, alarms = [] }: EquipmentProps & { alarms?: readonly Alarm[] }) {
  const made = get(readings, 'product.shiftProductM3');
  const goal = target?.productM3;
  const frac = made !== undefined && num(goal) && goal > 0 ? clamp01(made / goal) : 0;
  const bal = num(status?.balanceUsd) ? status.balanceUsd : undefined;
  const balColor = bal === undefined ? C.text : bal < 0 ? C.bad : bal < 5000 ? C.warn : C.text;
  const plant = label(STATUS_TEXT, status?.status) ?? DASH;
  const plantColor = plant === DASH ? C.muted : status?.status === 'tripped' ? C.bad : status?.status === 'online' ? C.ok : C.warn;
  const top = byWorst(alarms).slice(0, 2);
  return (
    <svg viewBox={VIEWBOX} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Shift and account">
      <text x={4} y={20} fill={C.text} fontSize={15} fontWeight={700}>Shift {fmt(status?.shiftNumber)}</text>
      <text x={196} y={20} fill={C.muted} fontSize={11} textAnchor="end">{ticksToHm(status?.shiftTicksRemaining)} left</text>
      <text x={4} y={42} fill={C.muted} fontSize={9}>In-spec water</text>
      <text x={196} y={42} fill={C.text} fontSize={11} textAnchor="end">{fmt(made)} / {fmt(goal, 0, 'm³')}</text>
      <rect x={4} y={48} width={192} height={10} rx={5} fill={C.track} />
      <rect x={4} y={48} width={192 * frac} height={10} rx={5} fill={C.water} />
      <text x={4} y={80} fill={C.muted} fontSize={9}>Balance</text>
      <text x={52} y={80} fill={balColor} fontSize={13}>{usd(bal)}</text>
      <text x={196} y={80} fill={plantColor} fontSize={11} textAnchor="end">{plant}</text>
      {top.map((a, i) => (
        <text key={a.id} x={4} y={102 + i * 15} fill={a.level === 'bad' ? C.bad : C.warn} fontSize={9}>▲ {a.text}</text>
      ))}
      {top.length === 0 && <text x={4} y={102} fill={C.muted} fontSize={9}>No active alarms</text>}
      <text x={196} y={146} fill={C.muted} fontSize={10} textAnchor="end">{label(MODE_TEXT, status?.controlMode) ?? DASH}</text>
    </svg>
  );
}
