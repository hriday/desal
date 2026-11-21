import { LoopSetpoint } from '../controls/Setpoint';
import { LoopModeToggle } from '../controls/Toggle';
import { Trend } from '../controls/Trend';
import { BrineHeater } from '../equipment/BrineHeater';
import { DASH, fmt, get, label, num } from '../equipment/format';
import { TICK_PLANT_S } from '../plantConstants';
import { FUEL_TEXT } from './labels';
import { Detail, Row, ViewLayout } from './Layout';
import { RestartControl, TripNotice } from './ShiftView';
import type { ExpandedProps } from './types';

export function HeaterView(props: ExpandedProps) {
  const { status, readings, trends } = props;
  const tbt = get(readings, 'heater.tbtC');
  const sp = status?.loops?.tbt?.setpoint;
  const cond = get(readings, 'heater.burnerCondition');
  const fuel = status?.fuel;
  const to = fuel?.changeoverTo != null ? label(FUEL_TEXT, fuel.changeoverTo) ?? DASH : undefined;
  const left = fuel?.changeoverRemainingTicks;
  const leftMin = num(left) ? (left * TICK_PLANT_S) / 60 : undefined;
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
            v={to ? `Changing over to ${to.toLowerCase()}, ${fmt(leftMin, 0, 'min')} left` : 'None'}
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
          <TripNotice status={status} />
          {(status?.status === 'tripped' || status?.status === 'restarting') && <RestartControl {...ctl} />}
          <LoopSetpoint loop="tbt" name="TBT" unit="°C" step={0.5} digits={1} {...ctl} />
          {status?.controlMode === 'auto' && <LoopModeToggle loop="tbt" name="TBT" {...ctl} />}
        </>
      }
    />
  );
}
