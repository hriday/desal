import type { PlantEvent, PlantStatus, RestartStep } from '@desal/schema';
import { manualTrip, pause, quit, restart, restartStep, resume } from '../commands';
import { ActionButton } from '../controls/ActionButton';
import { canSend, pendingCommand, type ControlCtx } from '../controls/ctx';
import { Trend } from '../controls/Trend';
import { DASH, clamp01, fmt, get, label, num, ticksToHm, usd } from '../equipment/format';
import { ShiftAccount } from '../equipment/ShiftAccount';
import { clock, eventText } from './eventText';
import { MODE_TEXT, PLANT_TEXT, STEP_TEXT, TRIP_TEXT } from './labels';
import { Detail, Row, ViewLayout } from './Layout';
import type { ExpandedProps } from './types';

export const EVENT_LOG_SIZE = 20;

const STEPS: readonly RestartStep[] = ['vacuum', 'recirc', 'ignition', 'ramp'];

/**
 * The one Manual restart step the simulator will accept next, or null: vacuum from a trip, then each
 * step after the reported one. None during an automatic restart or outside Manual mode.
 */
export function nextRestartStep(st: PlantStatus | null): RestartStep | null {
  if (!st || st.controlMode !== 'manual' || st.restartAuto === true) return null;
  if (st.status === 'tripped') return 'vacuum';
  if (st.status !== 'restarting') return null;
  const i = STEPS.indexOf(st.restartStep as RestartStep);
  return i < 0 ? null : STEPS[i + 1] ?? null;
}

function ShiftControls(ctl: ControlCtx) {
  const st = ctl.status;
  const ok = canSend(ctl);
  const busy = (key: string) => pendingCommand(ctl, key) !== undefined;
  const next = nextRestartStep(st);
  const paused = st?.phase === 'paused';
  return (
    <>
      {st?.controlMode === 'manual' ? (
        <div className="ctl">
          <span className="ctl__label">Restart, step by step</span>
          <span className="ctl__row">
            {STEPS.map((step) => (
              <ActionButton
                key={step}
                label={label(STEP_TEXT, step)!}
                disabled={!ok || step !== next}
                pending={busy(`restartStep:${step}`)}
                onAction={() => ctl.send?.(restartStep(step))}
              />
            ))}
          </span>
        </div>
      ) : (
        <div className="ctl">
          <span className="ctl__label">Restart</span>
          <ActionButton
            label="Restart"
            disabled={!ok || st?.status !== 'tripped'}
            pending={busy('restart')}
            onAction={() => ctl.send?.(restart())}
          />
        </div>
      )}
      <div className="ctl">
        <span className="ctl__label">Plant</span>
        <span className="ctl__row">
          <ActionButton
            label="Manual trip"
            confirm
            danger
            disabled={!ok || (st?.status !== 'online' && st?.status !== 'restarting')}
            pending={busy('manualTrip')}
            onAction={() => ctl.send?.(manualTrip())}
          />
          <ActionButton
            label={paused ? 'Resume' : 'Pause'}
            disabled={!ok || (st?.phase !== 'running' && !paused)}
            pending={busy(paused ? 'resume' : 'pause')}
            onAction={() => ctl.send?.(paused ? resume() : pause())}
          />
          <ActionButton label="Quit run" confirm danger disabled={!ok} pending={busy('quitGame')} onAction={() => ctl.send?.(quit())} />
        </span>
      </div>
    </>
  );
}

/** This shift's allocation and repair charges, from its accountChange events. */
export function shiftAccount(events: readonly PlantEvent[], shiftId: number | null | undefined) {
  let allocationUsd: number | undefined;
  let repairsUsd = 0;
  if (!num(shiftId)) return { allocationUsd, repairsUsd };
  for (const e of events) {
    if (e?.type !== 'accountChange' || e.shiftId !== shiftId || !num(e.deltaUsd)) continue;
    if (e.cause === 'allocation') allocationUsd = (allocationUsd ?? 0) + e.deltaUsd;
    else if (e.cause === 'acidClean' || e.cause === 'overhaul') repairsUsd -= e.deltaUsd;
  }
  return { allocationUsd, repairsUsd };
}

/** The last EVENT_LOG_SIZE known events, newest first, as plain sentences. */
export function EventLog({ events }: { events: readonly PlantEvent[] }) {
  const items: { seq: number; at: string; text: string }[] = [];
  for (let i = events.length - 1; i >= 0 && items.length < EVENT_LOG_SIZE; i--) {
    const e = events[i]!;
    const text = eventText(e);
    if (text) items.push({ seq: num(e.seq) ? e.seq : -i, at: clock(e.plantTime), text });
  }
  return (
    <section className="event-log" aria-label="Event log">
      <h3 className="detail__title">Event log</h3>
      {items.length === 0 && <p className="event-log__none">No events yet</p>}
      <ol data-event-log>
        {items.map((it, i) => (
          <li key={`${it.seq}-${i}`}><span className="event-log__at">{it.at}</span> {it.text}</li>
        ))}
      </ol>
    </section>
  );
}

export function ShiftView(props: ExpandedProps) {
  const { status, readings, trends, events, target } = props;
  const made = get(readings, 'product.shiftProductM3');
  const goal = num(target?.productM3) ? target.productM3 : undefined;
  const frac = made !== undefined && goal !== undefined && goal > 0 ? clamp01(made / goal) : undefined;
  const fuelUsd = get(readings, 'fuel.shiftCostUsd');
  const { allocationUsd, repairsUsd } = shiftAccount(events, status?.shiftId);
  const spent = fuelUsd === undefined ? undefined : fuelUsd + repairsUsd;
  const bal = num(status?.balanceUsd) ? status.balanceUsd : undefined;
  const plant = label(PLANT_TEXT, status?.status);
  const trip = label(TRIP_TEXT, status?.tripCause);
  const step = label(STEP_TEXT, status?.restartStep);
  return (
    <ViewLayout
      drawing={<ShiftAccount {...props} />}
      detail={
        <Detail title="Shift & account">
          <Row k="Shift" v={`Shift ${fmt(status?.shiftNumber)}`} />
          <Row k="Time left" v={ticksToHm(status?.shiftTicksRemaining)} />
          <Row k="In-spec water" v={`${fmt(made)} / ${fmt(goal, 0, 'm³')} (${fmt(frac === undefined ? undefined : frac * 100, 0, '%')})`} />
          <Row k="Balance" v={usd(bal)} tone={bal === undefined ? undefined : bal < 0 ? 'bad' : bal < 5000 ? 'warn' : undefined} />
          <Row k="Allocation this shift" v={usd(allocationUsd)} />
          <Row k="Spent this shift" v={usd(spent)} />
          <Row k="of which fuel" v={usd(fuelUsd)} />
          <Row k="of which repairs" v={usd(repairsUsd)} />
          <Row k="Mode" v={label(MODE_TEXT, status?.controlMode) ?? DASH} />
          <Row k="Plant" v={plant ?? DASH} tone={status?.status === 'tripped' ? 'bad' : plant && status?.status !== 'online' ? 'warn' : undefined} />
          <Row k="Restart step" v={step ?? (status?.status === 'restarting' ? DASH : 'None')} />
          <Row k="Trip cause" v={trip ? trip.charAt(0).toUpperCase() + trip.slice(1) : status?.tripCause ? DASH : 'None'} />
        </Detail>
      }
      trends={
        <>
          <Trend label="In-spec water" unit="m³" data={trends['product.shiftProductM3']} />
          <Trend label="Fuel spend" unit="$" data={trends['fuel.shiftCostUsd']} />
        </>
      }
      controls={<ShiftControls status={status} pending={props.pending} send={props.send} />}
    >
      <EventLog events={events} />
    </ViewLayout>
  );
}
