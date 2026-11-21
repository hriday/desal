import type { PumpId } from '@desal/schema';
import { requiredIntakeM3h } from '../alarms/rules';
import { dose, overhaul, pump } from '../commands';
import { ActionButton } from '../controls/ActionButton';
import { canSend, pendingCommand, type ControlCtx } from '../controls/ctx';
import { LoopSetpoint, Setpoint } from '../controls/Setpoint';
import { LoopModeToggle, Toggle } from '../controls/Toggle';
import { Trend } from '../controls/Trend';
import { DASH, fmt, get, num } from '../equipment/format';
import { Intake } from '../equipment/Intake';
import { DOSE_MAX_MGL, PUMP_OVERHAUL_COST_USD } from '../limits';
import { TICK_PLANT_S } from '../plantConstants';
import { Detail, Row, ViewLayout } from './Layout';
import type { ExpandedProps } from './types';

export const PUMPS: readonly PumpId[] = ['P-101', 'P-102', 'P-103'];
const pct = (v: number | undefined) => fmt(v === undefined ? undefined : v * 100, 0, '%');

/** Pump state as words: running, stopped, or under overhaul with the plant-minutes left. */
export function pumpState(p: { running?: unknown; overhaulRemainingTicks?: unknown } | undefined): string {
  if (!p) return DASH;
  if (num(p.overhaulRemainingTicks as number) && (p.overhaulRemainingTicks as number) > 0) {
    return `Overhaul, ${fmt(((p.overhaulRemainingTicks as number) * TICK_PLANT_S) / 60, 0, 'min')} left`;
  }
  return p.running === true ? 'Running' : p.running === false ? 'Stopped' : DASH;
}

/** Start/stop for one pump, and an overhaul (with its cost) only while it is stopped and not already under one. */
function PumpControl({ id, ...ctl }: ControlCtx & { id: PumpId }) {
  const p = ctl.status?.pumps?.[id];
  const running = typeof p?.running === 'boolean' ? p.running : undefined;
  const overhauling = num(p?.overhaulRemainingTicks) && p.overhaulRemainingTicks > 0;
  const bal = ctl.status?.balanceUsd;
  const affordable = num(bal) && bal >= PUMP_OVERHAUL_COST_USD;
  const ok = canSend(ctl);
  return (
    <div className="ctl-group" data-pump-control={id}>
      <Toggle
        label={id}
        on={running}
        onText="Running"
        offText="Stopped"
        pending={pendingCommand(ctl, `pump:${id}`) !== undefined}
        disabled={!ok || (overhauling && running === false)}
        onChange={(on) => ctl.send?.(pump(id, on ? 'start' : 'stop'))}
      />
      {overhauling && <span className="ctl__meta">{pumpState(p)}</span>}
      {running === false && !overhauling && (
        <ActionButton
          label="Overhaul"
          costUsd={PUMP_OVERHAUL_COST_USD}
          confirm
          disabled={!ok || !affordable}
          hint={affordable ? undefined : 'not enough budget'}
          pending={pendingCommand(ctl, `overhaulPump:${id}`) !== undefined}
          onAction={() => ctl.send?.(overhaul(id))}
        />
      )}
    </div>
  );
}

/** Chlorine and antiscalant doses, against the doses the plant reports. */
function DoseControls(ctl: ControlCtx) {
  const ok = canSend(ctl);
  return (
    <>
      {(['chlorine', 'antiscalant'] as const).map((c) => {
        const p = pendingCommand(ctl, `setDose:${c}`);
        const reported = c === 'chlorine' ? ctl.status?.doses?.chlorineMgL : ctl.status?.doses?.antiscalantMgL;
        return (
          <Setpoint
            key={c}
            label={c === 'chlorine' ? 'Chlorine dose' : 'Antiscalant dose'}
            reported={num(reported) ? reported : undefined}
            pending={p?.type === 'setDose' ? p.mgL : undefined}
            min={0}
            max={DOSE_MAX_MGL}
            step={0.1}
            unit="mg/L"
            digits={1}
            disabled={!ok}
            onCommit={(v) => ctl.send?.(dose(c, v))}
          />
        );
      })}
    </>
  );
}

export function IntakeView(props: ExpandedProps) {
  const { status, readings, trends } = props;
  const flow = get(readings, 'intake.flowM3h');
  const sea = get(readings, 'intake.seawaterTempC');
  const req = sea === undefined ? undefined : requiredIntakeM3h(sea);
  const fouling = get(readings, 'intake.screenFouling');
  const chl = get(readings, 'pretreat.chlorophyllUgL');
  const ctl: ControlCtx = { status, pending: props.pending, send: props.send };
  return (
    <ViewLayout
      drawing={<Intake {...props} />}
      detail={
        <>
          <Detail title="Intake">
            <Row k="Intake flow" v={fmt(flow, 0, 'm³/h')} tone={flow !== undefined && req !== undefined && flow < req ? 'bad' : undefined} />
            <Row k="Required" v={fmt(req, 0, 'm³/h')} />
            <Row k="Seawater" v={fmt(sea, 1, '°C')} />
            <Row k="Screen fouling" v={fmt(fouling, 2)} tone={fouling === undefined ? undefined : fouling >= 0.5 ? 'bad' : fouling >= 0.3 ? 'warn' : undefined} />
            <Row k="Chlorophyll" v={fmt(chl, 1, 'µg/L')} tone={chl !== undefined && chl >= 4 ? 'warn' : undefined} />
          </Detail>
          <table className="xv-table">
            <thead><tr><th>Pump</th><th>State</th><th>Flow</th><th>Wear</th><th>Cavitation</th></tr></thead>
            <tbody>
              {PUMPS.map((id) => (
                <tr key={id} data-pump-row={id}>
                  <th scope="row">{id}</th>
                  <td>{pumpState(status?.pumps?.[id])}</td>
                  <td>{fmt(get(readings, `intake.${id}.flowM3h`), 0, 'm³/h')}</td>
                  <td>{pct(get(readings, `intake.${id}.wear`))}</td>
                  <td>{pct(get(readings, `intake.${id}.cavitation`))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      }
      trends={
        <>
          <Trend label="Intake flow" unit="m³/h" data={trends['intake.flowM3h']} />
          <Trend label="Chlorophyll" unit="µg/L" digits={1} data={trends['pretreat.chlorophyllUgL']} />
          <Trend label="Screen fouling" digits={2} data={trends['intake.screenFouling']} />
        </>
      }
      controls={
        <>
          <LoopSetpoint loop="intakeFlow" name="Intake flow" unit="m³/h" step={100} digits={0} {...ctl} />
          {status?.controlMode === 'auto' && <LoopModeToggle loop="intakeFlow" name="Intake flow" {...ctl} />}
          {PUMPS.map((id) => <PumpControl key={id} id={id} {...ctl} />)}
          <DoseControls {...ctl} />
        </>
      }
    />
  );
}
