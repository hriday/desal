import type { PlantEvent, PlantStatus, RestartStep } from '@desal/schema';
import { manualTrip, pause, quit, restart, restartStep, resume } from '../commands';
import { ActionButton } from '../controls/ActionButton';
import { canSend, pendingCommand, type ControlCtx } from '../controls/ctx';
import { CrewButton } from '../controls/CrewButton';
import { Trend } from '../controls/Trend';
import { DASH, clamp01, fmt, get, label, num, ticksToHm, usd } from '../equipment/format';
import { ShiftAccount } from '../equipment/ShiftAccount';
import { CREW_JOBS } from '../plantConstants';
import { crewMinutesLeft } from '../screens/quota';
import { clock, eventText } from './eventText';
import { MODE_TEXT, PLANT_TEXT, STEP_TEXT, TRIP_FIX, TRIP_TEXT } from './labels';
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

/**
 * Why the burner is locked out and what to do, while the plant is tripped or restarting; nothing otherwise.
 * Shown wherever the player may look for the burner (the shift and heater views).
 */
export function TripNotice({ status }: { status: PlantStatus | null | undefined }) {
  if (status?.status === 'tripped') {
    const cause = typeof status.tripCause === 'string' ? status.tripCause : undefined;
    const why = cause ? label(TRIP_TEXT, cause) ?? cause : undefined;
    return (
      <div className="ctl ctl--notice" role="status">
        <span className="ctl__label">Plant tripped{why ? `: ${why}` : ''}</span>
        <span className="ctl__meta">
          The burner is locked out until the plant restarts. {(cause && TRIP_FIX[cause]) || 'Fix the cause, then press Restart.'}
        </span>
      </div>
    );
  }
  if (status?.status === 'restarting') {
    const step = label(STEP_TEXT, status.restartStep);
    return (
      <div className="ctl ctl--notice" role="status">
        <span className="ctl__label">Restarting{step ? `: ${step.toLowerCase()}` : ''}</span>
        <span className="ctl__meta">The restart sequence controls the burner until it reaches ignition.</span>
      </div>
    );
  }
  return null;
}

/** The restart control: one button in Auto, the four steps in order in Manual. */
export function RestartControl(ctl: ControlCtx) {
  const st = ctl.status;
  const ok = canSend(ctl);
  const busy = (key: string) => pendingCommand(ctl, key) !== undefined;
  const next = nextRestartStep(st);
  return st?.controlMode === 'manual' ? (
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
  );
}

function ShiftControls(ctl: ControlCtx) {
  const st = ctl.status;
  const ok = canSend(ctl);
  const busy = (key: string) => pendingCommand(ctl, key) !== undefined;
  const paused = st?.phase === 'paused';
  return (
    <>
      <TripNotice status={st} />
      <RestartControl {...ctl} />
      <div className="ctl">
        <span className="ctl__label">Crew</span>
        <CrewButton job="replaceSensor" {...ctl} />
        {st?.crew && (
          <span className="ctl__meta">
            {CREW_JOBS[st.crew.job]?.doing ?? st.crew.job}, {crewMinutesLeft(st.crew.remainingTicks)} min left
          </span>
        )}
      </div>
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

/**
 * This shift's allocation, repair charges, crew charges, standing cost and standby steam line cost, from its
 * accountChange events. The standing and standby steam costs are reported once per plant hour, so they lag by up
 * to an hour.
 */
export function shiftAccount(events: readonly PlantEvent[], shiftId: number | null | undefined) {
  let allocationUsd: number | undefined;
  let repairsUsd = 0;
  let crewUsd = 0;
  let standingUsd = 0;
  let standbySteamUsd = 0;
  if (!num(shiftId)) return { allocationUsd, repairsUsd, crewUsd, standingUsd, standbySteamUsd };
  for (const e of events) {
    if (e?.type !== 'accountChange' || e.shiftId !== shiftId || !num(e.deltaUsd)) continue;
    if (e.cause === 'allocation') allocationUsd = (allocationUsd ?? 0) + e.deltaUsd;
    else if (e.cause === 'acidClean' || e.cause === 'overhaul') repairsUsd -= e.deltaUsd;
    else if (e.cause === 'crew') crewUsd -= e.deltaUsd;
    else if (e.cause === 'standing') standingUsd -= e.deltaUsd;
    else if (e.cause === 'standbySteam') standbySteamUsd -= e.deltaUsd;
  }
  return { allocationUsd, repairsUsd, crewUsd, standingUsd, standbySteamUsd };
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
  const { allocationUsd, repairsUsd, crewUsd, standingUsd, standbySteamUsd } = shiftAccount(events, status?.shiftId);
  const spent = fuelUsd === undefined ? undefined : fuelUsd + repairsUsd + crewUsd + standingUsd + standbySteamUsd;
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
          <Row k="of which crew" v={usd(crewUsd)} />
          <Row k="of which staff and standby" v={usd(standingUsd)} />
          <Row k="of which standby steam" v={usd(standbySteamUsd)} />
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
