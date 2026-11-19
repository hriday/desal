import { C, DASH, clamp01, fmt, get, label, usd } from './format';
import { Pipe, flowFrac } from './Pipe';
import type { EquipmentProps } from './types';

/** Tank level drawn as full (t). Deliveries can exceed it; the fill clamps, the number does not. */
const BACKUP_FULL_T = 200;
/** Burn rate drawn as nominal fuel flow (MW), for the dash speed only. */
const BURN_NOMINAL_MW = 45;
const FUEL_TEXT: Record<string, string> = { gas: 'gas', backup: 'backup' };
const GRADE_TEXT: Record<string, string> = { standard: 'standard', offgrade: 'off-grade' };

/** Gas supply (cap and price), the backup oil tank with its grade, and which fuel feeds the burner. */
export function Fuel({ status, readings }: EquipmentProps) {
  const cap = get(readings, 'fuel.gasCapMW');
  const price = get(readings, 'fuel.gasPriceUsdPerGJ');
  const tonnes = get(readings, 'fuel.backupTonnes');
  const burn = get(readings, 'fuel.burnMW');
  const fuel = status?.fuel;
  const active = fuel?.active;
  const notice = typeof fuel?.gasCurtailmentNotice === 'string' ? fuel.gasCurtailmentNotice : null;
  const tankColor = tonnes === undefined ? C.line : tonnes < 10 ? C.bad : tonnes < 40 ? C.warn : C.line;
  const fillH = tonnes === undefined ? 0 : clamp01(tonnes / BACKUP_FULL_T) * 44;
  // A changeover to an unknown fuel still shows as a changeover ("→ —"), never as steady running.
  const to = fuel?.changeoverTo != null ? label(FUEL_TEXT, fuel.changeoverTo) ?? DASH : undefined;
  const feeding = to ? `→ ${to}` : `on ${label(FUEL_TEXT, active) ?? DASH}`;
  const grade = label(GRADE_TEXT, fuel?.backupGrade) ?? DASH;
  const burnFlow = flowFrac(burn, BURN_NOMINAL_MW);
  const deliveries = Array.isArray(status?.deliveries) ? status.deliveries.length : 0;
  return (
    <svg viewBox="0 0 200 104" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Fuel">
      {/* gas main along the top into the burner feed */}
      <Pipe name="gas" d="M0 22 H150 V58 H196" stroke={notice ? C.warn : C.line} width={active === 'gas' ? 4 : 2}
        opacity={active === 'gas' ? 1 : 0.5} flow={active === 'gas' ? burnFlow : 0} />
      <text x={4} y={14} fill={C.text} fontSize={8}>Gas cap {fmt(cap, 0, 'MW')}</text>
      <text x={146} y={14} fill={C.muted} fontSize={8} textAnchor="end">{price === undefined ? '—' : `$${price.toFixed(2)}/GJ`}</text>
      {notice && <text x={4} y={34} fill={C.warn} fontSize={6}>curtailment notice</text>}
      {/* backup tank */}
      <ellipse cx={60} cy={42} rx={36} ry={6} fill={C.plate} stroke={tankColor} />
      <path d="M24 42 V86 A36 6 0 0 0 96 86 V42" fill={C.body} stroke={tankColor} />
      <rect x={25} y={88 - fillH} width={70} height={fillH} fill={C.oil} opacity={0.7} />
      <text x={60} y={68} fill={C.text} fontSize={10} textAnchor="middle">{fmt(tonnes, 0, 't')}</text>
      <text x={60} y={79} fill={fuel?.backupGrade === 'offgrade' ? C.warn : C.muted} fontSize={6} textAnchor="middle">{grade}</text>
      <Pipe name="backup" d="M96 70 H150 V58" stroke={C.oil} width={active === 'backup' ? 4 : 2}
        opacity={active === 'backup' ? 1 : 0.5} flow={active === 'backup' ? burnFlow : 0} />
      <rect x={150} y={48} width={46} height={20} rx={3} fill={C.screen} stroke={C.line} />
      <text x={173} y={61} fill={C.text} fontSize={7} textAnchor="middle">{fmt(burn, 0, 'MW')}</text>
      {deliveries > 0 && <text x={104} y={86} fill={C.muted} fontSize={6}>{deliveries} {deliveries > 1 ? 'deliveries' : 'delivery'} due</text>}
      <text x={4} y={102} fill={to ? C.warn : C.text} fontSize={8}>{feeding}</text>
      <text x={196} y={102} fill={C.muted} fontSize={8} textAnchor="end">Shift fuel {usd(get(readings, 'fuel.shiftCostUsd'))}</text>
    </svg>
  );
}
