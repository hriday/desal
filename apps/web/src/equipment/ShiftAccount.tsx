import type { Alarm } from '../alarms/rules';
import { C, clamp01, fmt, get, ticksToHm, usd } from './format';
import type { EquipmentProps } from './types';

const STATUS_TEXT = { online: 'ONLINE', tripped: 'TRIPPED', restarting: 'RESTARTING', acidCleaning: 'ACID CLEAN' } as const;

/** Shift number and time left, in-spec water against target (the score), the operating balance, and the top alarms. */
export function ShiftAccount({ status, readings, target, alarms = [] }: EquipmentProps & { alarms?: readonly Alarm[] }) {
  const made = get(readings, 'product.shiftProductM3');
  const goal = target?.productM3;
  const frac = made !== undefined && goal ? clamp01(made / goal) : 0;
  const bal = status?.balanceUsd;
  const balColor = bal === undefined ? C.text : bal < 0 ? C.bad : bal < 5000 ? C.warn : C.text;
  const plant = status ? STATUS_TEXT[status.status] : '—';
  const plantColor = status?.status === 'tripped' ? C.bad : status && status.status !== 'online' ? C.warn : C.ok;
  const top = [...alarms].sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1)).slice(0, 2);
  return (
    <svg viewBox="0 0 200 104" role="img" aria-label="Shift and account">
      <text x={4} y={14} fill={C.text} fontSize={10} fontWeight={700}>Shift {fmt(status?.shiftNumber)}</text>
      <text x={196} y={14} fill={C.muted} fontSize={8} textAnchor="end">{ticksToHm(status?.shiftTicksRemaining)} left</text>
      <text x={4} y={30} fill={C.muted} fontSize={7}>In-spec water</text>
      <text x={196} y={30} fill={C.text} fontSize={8} textAnchor="end">{fmt(made)} / {fmt(goal, 0, 'm³')}</text>
      <rect x={4} y={34} width={192} height={8} rx={4} fill={C.track} />
      <rect x={4} y={34} width={192 * frac} height={8} rx={4} fill={C.water} />
      <text x={4} y={56} fill={C.muted} fontSize={7}>Balance</text>
      <text x={60} y={56} fill={balColor} fontSize={9}>{usd(bal)}</text>
      <text x={196} y={56} fill={plantColor} fontSize={8} textAnchor="end">{plant}</text>
      {top.map((a, i) => (
        <text key={a.id} x={4} y={72 + i * 11} fill={a.level === 'bad' ? C.bad : C.warn} fontSize={7}>▲ {a.text}</text>
      ))}
      {top.length === 0 && <text x={4} y={72} fill={C.muted} fontSize={7}>No active alarms</text>}
      <text x={196} y={102} fill={C.muted} fontSize={7} textAnchor="end">{status ? `${status.controlMode === 'auto' ? 'Auto' : 'Manual'} mode` : '—'}</text>
    </svg>
  );
}
