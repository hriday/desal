import type { Comparison, PacePoint, ShiftReport, Verdict } from '@desal/schema';
import { fmt, label } from '../equipment/format';
import { KIND_TEXT } from '../expanded/labels';
import type { ReportWait } from '../state/store';
import { clockAt, whatToDo } from './Handover';

export interface ReportCardProps {
  /** Flink's report for the shift just ended; undefined until it comes (or if Flink is down). */
  report: ShiftReport | undefined;
  wait: ReportWait;
}

const W = 160;
const H = 44;
const PAD = 4;

/** Cumulative in-spec water by plant hour against the hour's share of the target (dashed). */
function Sparkline({ pace }: { pace: readonly PacePoint[] }) {
  const top = Math.max(1, ...pace.map((p) => Math.max(p.productM3, p.targetM3)));
  const x = (hour: number) => PAD + (hour / 8) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - (Math.max(0, v) / top) * (H - 2 * PAD);
  const line = (v: (p: PacePoint) => number) => [`${x(0)},${y(0)}`, ...pace.map((p) => `${x(p.hour)},${y(v(p))}`)].join(' ');
  const last = pace[pace.length - 1];
  return (
    <svg className="report__pace" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={last ? `Hourly pace: ${fmt(last.productM3)} of ${fmt(last.targetM3)} m³ by hour ${last.hour}` : 'Hourly pace'}>
      <polyline className="report__target" points={line((p) => p.targetM3)} />
      <polyline className="report__product" points={line((p) => p.productM3)} />
      {pace.map((p) => <circle key={p.hour} data-pace-point={p.hour} cx={x(p.hour)} cy={y(p.productM3)} r={1.8} />)}
    </svg>
  );
}

function verdictText(v: Verdict, responseMinutes: number | null): string {
  return v !== 'missed' && responseMinutes !== null ? `${v} · ${fmt(responseMinutes)} min` : v;
}

/** The card's "What to do" line for an event: the FIX text under a slow or missed verdict, else null. */
export function cardFix(e: ShiftReport['events'][number]): string | null {
  return e.verdict === 'slow' || e.verdict === 'missed' ? whatToDo({ kind: e.kind, cleared: false }) : null;
}

const handled = (c: Comparison) => `${c.handledWell}/${c.handledOf}`;

/** "vs last shift: 96 % of target (was 88 %) · handled well 2/4 (was 1/2) · tripped 7 min (was 0 min)". */
function compareLine(title: string, self: Comparison, other: Comparison): string {
  return `${title}: ${fmt(self.targetPct)} % of target (was ${fmt(other.targetPct)} %)`
    + ` · handled well ${handled(self)} (was ${handled(other)})`
    + ` · tripped ${fmt(self.minutesTripped)} min (was ${fmt(other.minutesTripped)} min)`;
}

/**
 * The handover's report card from Flink: the grade stamped on the sheet, each event with its verdict
 * (and the FIX line under a slow or missed one), the hourly pace and the comparisons. While the
 * report is awaited it says "Grading…"; once the wait has expired it is simply left out, and a
 * report that turns up later still shows.
 */
export function ReportCard({ report, wait }: ReportCardProps) {
  if (!report) {
    if (wait !== 'waiting') return null;
    return (
      <section className="report report--waiting" aria-label="Report card">
        <h2>Report card</h2>
        <p className="report__grading">Grading…</p>
      </section>
    );
  }
  const { vsPrevious, vsBest } = report;
  return (
    <section className="report" aria-label="Report card">
      <h2>Report card{report.mode === 'hard' && <> <span className="tone--bad report__hard">HARD</span></>}</h2>
      <div className="report__top">
        <span className="report__grade" data-grade={report.grade} title={`Grade ${report.grade}, score ${fmt(report.score)}`}>{report.grade}</span>
        <div className="report__pacebox">
          <span className="report__k">Hourly pace</span>
          <Sparkline pace={report.pace} />
        </div>
      </div>
      {report.events.length > 0
        ? (
          <ul className="report__events" aria-label="Graded events">
            {report.events.map((e) => {
              const fix = cardFix(e);
              return (
                <li key={e.eventId}>
                  <span>{e.outcome === 'noted' ? '' : `${clockAt(e.atMinute)} `}{label(KIND_TEXT, e.kind) ?? 'Plant event'} — {e.outcome}</span>
                  {e.verdict && <> <span className="report__verdict" data-verdict={e.verdict}>{verdictText(e.verdict, e.responseMinutes)}</span></>}
                  {fix && <div className="debrief__todo">{fix}</div>}
                </li>
              );
            })}
          </ul>
        )
        : <p>No events to grade this shift.</p>}
      {vsPrevious && <p className="report__vs">{compareLine('vs last shift', report.self, vsPrevious)}</p>}
      {vsBest && vsBest.shiftId !== vsPrevious?.shiftId && (
        <p className="report__vs">{compareLine(`vs your best (shift ${vsBest.shiftId})`, report.self, vsBest)}</p>
      )}
    </section>
  );
}
