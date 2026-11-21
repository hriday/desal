import type { LoopMode, PlantEvent, PlantStatus, ShiftReport, ShiftSummary } from '@desal/schema';
import { useId, useState } from 'react';
import { fmt, get, label, num, stageKey, usd } from '../equipment/format';
import { FIX, HOW_TEXT, KIND_TEXT } from '../expanded/labels';
import { nextTargetEstimateM3 } from '../limits';
import { STAGE_COUNT } from '../plantConstants';
import type { ReportWait } from '../state/store';
import { cardFix, ReportCard } from './ReportCard';
import { SheetHead } from './Sheet';
import './screens.css';

export interface HandoverProps {
  status: PlantStatus | null;
  readings: Record<string, number>;
  events: readonly PlantEvent[];
  onStartShift: (mode: LoopMode) => void;
  onQuit: () => void;
  /** A start or quit is in flight: both buttons stay disabled until the plant answers. */
  busy?: boolean;
  /** Flink's report cards by shiftId; the one for the shift just ended shows above "Last shift". */
  reports?: Readonly<Record<number, ShiftReport>>;
  reportWait?: ReportWait;
}

export function lastSummary(events: readonly PlantEvent[]): ShiftSummary | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'shiftEnd') return e.summary;
  }
  return null;
}

const PUMPS = ['P-101', 'P-102', 'P-103'] as const;
const pct = (v: number | undefined) => (num(v) ? `${Math.round(v * 100)} %` : fmt(undefined));

/** Plant minutes into the shift as "02:10". */
export function clockAt(atMinute: number): string {
  const m = Number.isFinite(atMinute) ? Math.max(0, Math.floor(atMinute)) : 0;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** "02:10 Pump trip — cleared by you". A noted (informational) event has no time; an uncleared one says so. */
export function debriefLine(e: ShiftSummary['events'][number]): string {
  const kind = label(KIND_TEXT, e.kind) ?? 'Plant event';
  if (e.how === 'noted') return `${kind} — noted`;
  return `${clockAt(e.atMinute)} ${kind} — ${(e.how && label(HOW_TEXT, e.how)) || 'not cleared'}`;
}

/**
 * "What to do: ..." (the FIX text) for an event the player left uncleared; null when it was cleared or
 * this client has no fix for its kind. The report card asks it for every slow or missed verdict.
 */
export function whatToDo(e: Pick<ShiftSummary['events'][number], 'kind' | 'cleared'>): string | null {
  if (e.cleared || !Object.hasOwn(FIX, e.kind)) return null;
  return `What to do: ${FIX[e.kind].text}`;
}

/** `fixedAbove`: eventIds whose "What to do" the report card above already shows; they are not repeated here. */
function Summary({ s, fixedAbove }: { s: ShiftSummary; fixedAbove: ReadonlySet<number> }) {
  return (
    <section aria-label="Last shift">
      <h2>Last shift{s.hell && <> <span className="tone--bad" data-hell>HELL SHIFT</span></>}</h2>
      <dl>
        <dt>In-spec water</dt><dd>{fmt(s.productM3)} / {fmt(s.targetM3)} m³</dd>
        <dt>Off-spec water</dt><dd>{fmt(s.offSpecM3)} m³ ({fmt(s.offSpecMinutes)} min)</dd>
        <dt>Spent (fuel, repairs, staff)</dt><dd>{usd(s.spentUsd)}</dd>
        <dt>Next allocation</dt><dd>{usd(s.nextAllocationUsd)}</dd>
        <dt>Trips</dt><dd>{fmt(s.trips)}</dd>
        <dt>Balance</dt><dd>{usd(s.balanceUsd)}</dd>
      </dl>
      {s.events.length > 0 && (
        <ul aria-label="Shift events">
          {s.events.map((e) => {
            const todo = fixedAbove.has(e.eventId) ? null : whatToDo(e);
            return (
              <li key={e.eventId}>
                {debriefLine(e)}
                {todo && <div className="debrief__todo">{todo}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Condition({ readings, summary }: { readings: Record<string, number>; summary: ShiftSummary | null }) {
  let scale: number | undefined;
  for (let i = 1; i <= STAGE_COUNT; i++) {
    const v = get(readings, `stages.${stageKey(i)}.hardScaleMm`);
    if (v !== undefined && (scale === undefined || v > scale)) scale = v;
  }
  scale ??= summary?.damage.maxHardScaleMm;
  const burner = get(readings, 'heater.burnerCondition') ?? summary?.damage.burnerCondition;
  const backup = get(readings, 'fuel.backupTonnes');
  return (
    <section aria-label="Plant condition">
      <h2>Plant condition</h2>
      <dl>
        <dt>Worst stage scale</dt><dd>{fmt(scale, 2, 'mm')}</dd>
        {PUMPS.map((p) => (
          <div key={p} style={{ display: 'contents' }}>
            <dt>Pump {p} wear</dt><dd>{pct(get(readings, `intake.${p}.wear`) ?? summary?.damage.pumpWear[p])}</dd>
          </div>
        ))}
        <dt>Burner condition</dt><dd>{pct(burner)}</dd>
        <dt>Backup fuel</dt><dd>{fmt(backup, 0, 't')}</dd>
      </dl>
    </section>
  );
}

export function Handover({ status, readings, events, onStartShift, onQuit, busy = false, reports = {}, reportWait = null }: HandoverProps) {
  const [mode, setMode] = useState<LoopMode>('auto');
  const titleId = useId();
  const ordersId = useId();
  const summary = lastSummary(events);
  // status.shiftNumber is the last STARTED shift (0 before the first), so the shift about to start is one more.
  const n = (status?.shiftNumber ?? 0) + 1;
  // shiftId is the shift number, so the shift just ended is the last one started.
  const report = status && status.shiftNumber > 0 ? reports[status.shiftNumber] : undefined;
  const fixedAbove = new Set(report?.events.filter((e) => cardFix(e) !== null).map((e) => e.eventId) ?? []);
  // status.shiftTarget is null outside a shift, so before it starts we show the estimate.
  const orders = status?.orders ?? null;
  const target = orders
    ? fmt(orders.targetM3, 0, 'm³')
    : status?.shiftTarget ? fmt(status.shiftTarget.productM3, 0, 'm³') : `≈ ${fmt(nextTargetEstimateM3(n))} m³`;
  return (
    <main className="screen screen--board" data-screen="handover">
      <article className="sheet" aria-labelledby={titleId}>
        <SheetHead kicker="Shift log" title={`Shift ${n} handover`} id={titleId} sign={status?.callSign} />
        <section aria-labelledby={ordersId}>
          <h2 id={ordersId}>Orders for shift {n}</h2>
          <dl>
            <dt>Mode</dt><dd>{status?.mode === 'hard' ? 'Hard' : 'Normal'}</dd>
            <dt>Water target</dt><dd>{target}</dd>
            {orders && <><dt>Salinity limit</dt><dd>{fmt(orders.maxSalinityPpm, 0, 'ppm')}</dd></>}
            {orders && <><dt>Fuel budget</dt><dd>{usd(orders.budgetUsd)}</dd></>}
            <dt>Balance</dt><dd>{usd(status?.balanceUsd)}</dd>
          </dl>
          {orders && orders.briefing.length > 0 && (
            <>
              <h3>Briefing</h3>
              <ul aria-label="Briefing">{orders.briefing.map((l, i) => <li key={i}>{l}</li>)}</ul>
            </>
          )}
          {orders && orders.lines.length > 0 && (
            <>
              <h3>Supervisor's notes</h3>
              <ul aria-label="Supervisor's notes">{orders.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
            </>
          )}
        </section>
        <ReportCard report={report} wait={reportWait} />
        {summary && <Summary s={summary} fixedAbove={fixedAbove} />}
        <Condition readings={readings} summary={summary} />
        <fieldset>
          <legend>Control mode</legend>
          <label>
            <input type="radio" name="mode" checked={mode === 'auto'} onChange={() => setMode('auto')} />
            {' '}Auto: the plant holds the setpoints you choose.
          </label>
          <label>
            <input type="radio" name="mode" checked={mode === 'manual'} onChange={() => setMode('manual')} />
            {' '}Manual: you set every output yourself.
          </label>
        </fieldset>
        <div className="screen__actions sheet__actions">
          <button type="button" className="primary sheet__go" disabled={busy} onClick={() => onStartShift(mode)}>Start shift {n}</button>
          <button type="button" className="sheet__quit" disabled={busy} onClick={onQuit}>Quit run</button>
        </div>
      </article>
    </main>
  );
}
