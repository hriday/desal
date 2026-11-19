import type { PlantStatus } from '@desal/schema';
import { fmt, ticksToHm, usd } from '../equipment/format';
import { crewMinutesLeft, paceState, progress, type Pace } from './quota';

const PACE: Record<Pace, { text: string; tone: 'ok' | 'warn' | 'bad' }> = {
  onPace: { text: 'ON PACE', tone: 'ok' },
  behind: { text: 'BEHIND', tone: 'warn' },
  outOfReach: { text: 'OUT OF REACH', tone: 'bad' },
  done: { text: 'TARGET MET', tone: 'ok' },
};

const CREW_TEXT: Record<string, string> = {
  plugTubes: 'Plugging tubes', repairEjector: 'Repairing ejector', replaceSensor: 'Replacing sensor', cleanScreens: 'Cleaning screens',
};

/** The shift quota: progress, pace, time left, balance, off-spec note and crew job. Only in a running or paused shift. */
export function QuotaBar({ status }: { status: PlantStatus | null }) {
  if (!status || (status.phase !== 'running' && status.phase !== 'paused')) return null;
  const target = status.shiftTarget?.productM3 ?? 0;
  const pace = PACE[paceState({
    productM3: status.shiftProductM3, targetM3: target, flowM3h: status.productFlowM3h, ticksRemaining: status.shiftTicksRemaining,
  })];
  const pct = Math.round(progress(status.shiftProductM3, target) * 100);
  return (
    <section className="quota" aria-label="Shift quota" data-pace={pace.text}>
      <div className="quota__track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className={`quota__fill quota__fill--${pace.tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="quota__item">{fmt(status.shiftProductM3)} / {fmt(target)} m³</span>
      <span className={`quota__item quota__pace tone--${pace.tone}`}>{pace.text}</span>
      <span className="quota__item">{ticksToHm(status.shiftTicksRemaining)} left</span>
      <span className="quota__item">Balance {usd(status.balanceUsd)}</span>
      {status.shiftOffSpecM3 > 0 && (
        <span className="quota__item tone--warn">+{fmt(status.shiftOffSpecM3)} m³ off-spec, not counted</span>
      )}
      {status.crew && (
        <span className="quota__item">
          Crew: {CREW_TEXT[status.crew.job] ?? status.crew.job}, {crewMinutesLeft(status.crew.remainingTicks)} min left
        </span>
      )}
    </section>
  );
}
