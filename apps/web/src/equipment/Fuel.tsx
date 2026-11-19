import { C, DASH, VIEWBOX, clamp01, fmt, get, label, usd } from './format';
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
  const fillH = tonnes === undefined ? 0 : clamp01(tonnes / BACKUP_FULL_T) * 64;
  // A changeover to an unknown fuel still shows as a changeover ("→ —"), never as steady running.
  const to = fuel?.changeoverTo != null ? label(FUEL_TEXT, fuel.changeoverTo) ?? DASH : undefined;
  const feeding = to ? `→ ${to}` : `on ${label(FUEL_TEXT, active) ?? DASH}`;
  const grade = label(GRADE_TEXT, fuel?.backupGrade) ?? DASH;
  const burnFlow = flowFrac(burn, BURN_NOMINAL_MW);
  const deliveries = Array.isArray(status?.deliveries) ? status.deliveries.length : 0;
  return (
    <svg viewBox={VIEWBOX} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Fuel">
      {/* gas main along the top into the burner feed */}
      <Pipe name="gas" d="M0 30 H152 V84 H196" stroke={notice ? C.warn : C.line} width={active === 'gas' ? 5 : 2.5}
        opacity={active === 'gas' ? 1 : 0.5} flow={active === 'gas' ? burnFlow : 0} />
      <text x={4} y={18} fill={C.text} fontSize={11}>Gas cap {fmt(cap, 0, 'MW')}</text>
      <text x={148} y={18} fill={C.muted} fontSize={11} textAnchor="end">{price === undefined ? '—' : `$${price.toFixed(2)}/GJ`}</text>
      {notice && <text x={4} y={44} fill={C.warn} fontSize={8}>curtailment notice</text>}
      {/* backup tank */}
      <ellipse cx={60} cy={56} rx={38} ry={7} fill={C.plate} stroke={tankColor} />
      <path d="M22 56 V120 A38 7 0 0 0 98 120 V56" fill={C.body} stroke={tankColor} />
      <rect x={23} y={122 - fillH} width={74} height={fillH} fill={C.oil} opacity={0.7} />
      <text x={60} y={92} fill={C.text} fontSize={15} textAnchor="middle">{fmt(tonnes, 0, 't')}</text>
      <text x={60} y={106} fill={fuel?.backupGrade === 'offgrade' ? C.warn : C.muted} fontSize={9} textAnchor="middle">{grade}</text>
      <Pipe name="backup" d="M98 104 H152 V84" stroke={C.oil} width={active === 'backup' ? 5 : 2.5}
        opacity={active === 'backup' ? 1 : 0.5} flow={active === 'backup' ? burnFlow : 0} />
      <rect x={146} y={70} width={50} height={28} rx={4} fill={C.screen} stroke={C.line} />
      <text x={171} y={89} fill={C.text} fontSize={11} textAnchor="middle">{fmt(burn, 0, 'MW')}</text>
      {deliveries > 0 && <text x={104} y={124} fill={C.muted} fontSize={8}>{deliveries} {deliveries > 1 ? 'deliveries' : 'delivery'} due</text>}
      <text x={4} y={146} fill={to ? C.warn : C.text} fontSize={11}>{feeding}</text>
      <text x={196} y={146} fill={C.muted} fontSize={11} textAnchor="end">Shift fuel {usd(get(readings, 'fuel.shiftCostUsd'))}</text>
    </svg>
  );
}
