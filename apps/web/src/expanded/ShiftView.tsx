import type { PlantEvent } from '@desal/schema';
import { Trend } from '../controls/Trend';
import { DASH, clamp01, fmt, get, label, num, ticksToHm, usd } from '../equipment/format';
import { ShiftAccount } from '../equipment/ShiftAccount';
import { clock, eventText } from './eventText';
import { MODE_TEXT, PLANT_TEXT, STEP_TEXT, TRIP_TEXT } from './labels';
import { Detail, Row, ViewLayout } from './Layout';
import type { ExpandedProps } from './types';

export const EVENT_LOG_SIZE = 20;

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
    >
      <EventLog events={events} />
    </ViewLayout>
  );
}
