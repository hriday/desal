import type { LoopMode, PlantEvent, PlantStatus, ShiftSummary } from '@desal/schema';
import { useState } from 'react';
import { fmt, get, num, stageKey, usd } from '../equipment/format';
import { nextTargetEstimateM3 } from '../limits';
import { STAGE_COUNT } from '../plantConstants';
import './screens.css';

export interface HandoverProps {
  status: PlantStatus | null;
  readings: Record<string, number>;
  events: readonly PlantEvent[];
  onStartShift: (mode: LoopMode) => void;
  onQuit: () => void;
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

function Summary({ s }: { s: ShiftSummary }) {
  return (
    <section aria-label="Last shift">
      <h2>Last shift</h2>
      <dl>
        <dt>In-spec water</dt><dd>{fmt(s.productM3)} / {fmt(s.targetM3)} m³</dd>
        <dt>Off-spec water</dt><dd>{fmt(s.offSpecM3)} m³ ({fmt(s.offSpecMinutes)} min)</dd>
        <dt>Spent (fuel and repairs)</dt><dd>{usd(s.spentUsd)}</dd>
        <dt>Next allocation</dt><dd>{usd(s.nextAllocationUsd)}</dd>
        <dt>Trips</dt><dd>{fmt(s.trips)}</dd>
        <dt>Balance</dt><dd>{usd(s.balanceUsd)}</dd>
      </dl>
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

export function Handover({ status, readings, events, onStartShift, onQuit }: HandoverProps) {
  const [mode, setMode] = useState<LoopMode>('auto');
  const summary = lastSummary(events);
  const n = status?.shiftNumber ?? 1;
  // status.shiftTarget is null outside a shift, so before it starts we show the estimate.
  const target = status?.shiftTarget ? fmt(status.shiftTarget.productM3, 0, 'm³') : `≈ ${fmt(nextTargetEstimateM3(n))} m³`;
  return (
    <main className="screen" data-screen="handover">
      <h1>Shift {n} handover</h1>
      {summary && <Summary s={summary} />}
      <Condition readings={readings} summary={summary} />
      <section aria-label="Next shift">
        <h2>Next shift</h2>
        <dl>
          <dt>Water target</dt><dd>{target}</dd>
          <dt>Balance</dt><dd>{usd(status?.balanceUsd)}</dd>
        </dl>
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
      </section>
      <div className="screen__actions">
        <button type="button" className="primary" onClick={() => onStartShift(mode)}>Start shift {n}</button>
        <button type="button" onClick={onQuit}>Quit run</button>
      </div>
    </main>
  );
}
