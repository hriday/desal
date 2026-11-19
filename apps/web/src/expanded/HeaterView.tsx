import type { PlantEvent, PlantStatus } from '@desal/schema';
import { LoopSetpoint } from '../controls/Setpoint';
import { LoopModeToggle } from '../controls/Toggle';
import { Trend } from '../controls/Trend';
import { BrineHeater } from '../equipment/BrineHeater';
import { DASH, clamp01, fmt, get, label, num } from '../equipment/format';
import { CHANGEOVER_TICKS } from '../plantConstants';
import { FUEL_TEXT } from './labels';
import { Detail, Row, ViewLayout } from './Layout';
import type { ExpandedProps } from './types';

/** Fraction of the current fuel changeover done, from its 'started' event; undefined when unknown. */
export function changeoverProgress(status: PlantStatus | null, events: readonly PlantEvent[]): number | undefined {
  const to = status?.fuel?.changeoverTo;
  if (!to || !num(status?.tick)) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === 'fuelChangeover' && e.phase === 'started' && e.to === to && num(e.tick)) {
      return clamp01((status.tick - e.tick) / CHANGEOVER_TICKS);
    }
  }
  return undefined;
}

export function HeaterView(props: ExpandedProps) {
  const { status, readings, trends, events } = props;
  const tbt = get(readings, 'heater.tbtC');
  const sp = status?.loops?.tbt?.setpoint;
  const cond = get(readings, 'heater.burnerCondition');
  const fuel = status?.fuel;
  const to = fuel?.changeoverTo != null ? label(FUEL_TEXT, fuel.changeoverTo) ?? DASH : undefined;
  const progress = changeoverProgress(status, events);
  const ctl = { status, pending: props.pending, send: props.send };
  return (
    <ViewLayout
      drawing={<BrineHeater {...props} />}
      detail={
        <Detail title="Brine heater">
          <Row k="TBT" v={fmt(tbt, 1, '°C')} tone={tbt === undefined ? undefined : tbt >= 116 ? 'bad' : tbt >= 112 ? 'warn' : undefined} />
          <Row k="TBT setpoint" v={fmt(sp, 1, '°C')} />
          <Row k="Firing" v={fmt(get(readings, 'heater.firingPct'), 0, '%')} />
          <Row k="Heat to brine" v={fmt(get(readings, 'heater.heatMW'), 1, 'MW')} />
          <Row k="Burner condition" v={fmt(cond === undefined ? undefined : cond * 100, 0, '%')} tone={cond !== undefined && cond < 0.5 ? 'warn' : undefined} />
          <Row k="Active fuel" v={label(FUEL_TEXT, fuel?.active) ?? DASH} />
          <Row
            k="Changeover"
            v={to ? `Changing over to ${to.toLowerCase()}, ${fmt(progress === undefined ? undefined : progress * 100, 0, '%')}` : 'None'}
            tone={to ? 'warn' : undefined}
          />
        </Detail>
      }
      trends={
        <>
          <Trend label="TBT" unit="°C" digits={1} data={trends['heater.tbtC']} />
          <Trend label="Firing" unit="%" data={trends['heater.firingPct']} />
          <Trend label="Heat to brine" unit="MW" digits={1} data={trends['heater.heatMW']} />
        </>
      }
      controls={
        <>
          <LoopSetpoint loop="tbt" name="TBT" unit="°C" step={0.5} digits={1} {...ctl} />
          {status?.controlMode === 'auto' && <LoopModeToggle loop="tbt" name="TBT" {...ctl} />}
        </>
      }
    />
  );
}
