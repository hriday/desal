import type { FuelKind } from '@desal/schema';
import { useRef, useState } from 'react';
import { orderFuel, selectFuel } from '../commands';
import { ActionButton } from '../controls/ActionButton';
import { canSend, pendingCommand, type ControlCtx } from '../controls/ctx';
import { Stepper } from '../controls/Stepper';
import { Trend } from '../controls/Trend';
import { DASH, fmt, get, label, num, usd } from '../equipment/format';
import { Fuel } from '../equipment/Fuel';
import { backupOrderCostUsd, ORDER_MAX_T, ORDER_MIN_T } from '../limits';
import { TICK_PLANT_S } from '../plantConstants';
import { FUEL_TEXT, GRADE_TEXT } from './labels';
import { Detail, Row, ViewLayout } from './Layout';
import type { ExpandedProps } from './types';

const FUELS: readonly FuelKind[] = ['gas', 'backup'];

/** Gas or backup; both disabled during a changeover. */
function FuelSelect(ctl: ControlCtx) {
  const fuel = ctl.status?.fuel;
  const changing = fuel?.changeoverTo != null;
  const pending = pendingCommand(ctl, 'selectFuel') !== undefined;
  return (
    <div className="ctl">
      <span className="ctl__label">Burner fuel</span>
      <span className="ctl__row">
        {FUELS.map((f) => (
          <button
            key={f}
            type="button"
            className={`btn toggle${fuel?.active === f ? ' toggle--on' : ''}`}
            aria-pressed={fuel?.active === f}
            disabled={!canSend(ctl) || changing || pending || fuel?.active === f}
            onClick={() => ctl.send?.(selectFuel(f))}
          >
            Use {label(FUEL_TEXT, f)?.toLowerCase()}
          </button>
        ))}
        {pending && <span className="ctl__pending">sending…</span>}
      </span>
      {changing && <span className="ctl__meta">changeover in progress</span>}
    </div>
  );
}

/** Order backup fuel of the offered grade, with its live cost; disabled when unaffordable. */
function FuelOrder(ctl: ControlCtx) {
  const [tonnes, setTonnes] = useState('50');
  const t = Number(tonnes);
  const valid = tonnes.trim() !== '' && Number.isFinite(t) && t >= ORDER_MIN_T && t <= ORDER_MAX_T;
  const grade = ctl.status?.offeredGrade ?? 'standard';
  const cost = valid ? backupOrderCostUsd(t, grade) : undefined;
  const bal = ctl.status?.balanceUsd;
  const affordable = cost !== undefined && num(bal) && bal >= cost;
  const pending = pendingCommand(ctl, 'orderFuel') !== undefined;
  // A paid order has no status echo and the balance only moves on the next status, so allow one
  // order per status: block while one is pending, and also until a new status after a send.
  const sentAt = useRef<unknown>(null);
  const sentThisStatus = () => sentAt.current !== null && sentAt.current === ctl.status;
  const blocked = pending || sentThisStatus();
  const order = () => {
    if (!valid || !affordable || pending || sentThisStatus()) return; // read the ref now, not at render
    if (ctl.send?.(orderFuel(t))) sentAt.current = ctl.status;
  };
  return (
    <div className="ctl">
      <span className="ctl__label">Order backup fuel ({(label(GRADE_TEXT, grade) ?? DASH).toLowerCase()})</span>
      <span className="ctl__row">
        <Stepper label="Tonnes" value={tonnes} onChange={setTonnes} onEnter={order} min={ORDER_MIN_T} max={ORDER_MAX_T} step={10} unit="t" disabled={!canSend(ctl)} />
        <ActionButton
          label="Order"
          costUsd={cost}
          disabled={!canSend(ctl) || !affordable || blocked}
          hint={!valid ? `${ORDER_MIN_T}–${ORDER_MAX_T} t` : affordable ? undefined : 'not enough budget'}
          pending={pending}
          onAction={order}
        />
      </span>
      <span className="ctl__meta">cost {usd(cost)} · balance {usd(bal)}</span>
    </div>
  );
}

export function FuelView(props: ExpandedProps) {
  const { status, readings, trends } = props;
  const price = get(readings, 'fuel.gasPriceUsdPerGJ');
  const tonnes = get(readings, 'fuel.backupTonnes');
  const cost = get(readings, 'fuel.shiftCostUsd');
  const made = get(readings, 'product.shiftProductM3');
  const perM3 = cost !== undefined && made !== undefined && made > 0 ? cost / made : undefined;
  const fuel = status?.fuel;
  const notice = typeof fuel?.gasCurtailmentNotice === 'string' ? fuel.gasCurtailmentNotice : null;
  const deliveries = Array.isArray(status?.deliveries) ? status.deliveries : [];
  const ctl: ControlCtx = { status, pending: props.pending, send: props.send };
  return (
    <ViewLayout
      drawing={<Fuel {...props} />}
      detail={
        <>
          <Detail title="Fuel">
            <Row k="Active fuel" v={label(FUEL_TEXT, fuel?.active) ?? DASH} />
            <Row k="Gas cap" v={fmt(get(readings, 'fuel.gasCapMW'), 0, 'MW')} tone={notice ? 'warn' : undefined} />
            <Row k="Gas price" v={price === undefined ? DASH : `$${price.toFixed(2)}/GJ`} />
            <Row k="Curtailment notice" v={notice ?? 'None'} tone={notice ? 'warn' : undefined} />
            <Row k="Burner demand" v={fmt(get(readings, 'fuel.burnMW'), 1, 'MW')} />
            <Row k="Backup tank" v={fmt(tonnes, 0, 't')} tone={tonnes === undefined ? undefined : tonnes < 10 ? 'bad' : tonnes < 40 ? 'warn' : undefined} />
            <Row k="Tank grade" v={label(GRADE_TEXT, fuel?.backupGrade) ?? DASH} />
            <Row k="Offered grade" v={label(GRADE_TEXT, status?.offeredGrade) ?? DASH} tone={status?.offeredGrade === 'offgrade' ? 'warn' : undefined} />
            <Row k="Fuel cost this shift" v={usd(cost)} />
            <Row k="Fuel cost per m³" v={perM3 === undefined ? DASH : `$${perM3.toFixed(2)}/m³`} />
          </Detail>
          <Detail title="Deliveries in transit">
            {deliveries.length === 0 && <Row k="None" v="" />}
            {deliveries.map((d, i) => (
              <Row
                key={i}
                k={`#${i + 1}`}
                v={`${fmt(d?.tonnes, 0, 't')} ${(label(GRADE_TEXT, d?.grade) ?? DASH).toLowerCase()}, arrives in ${fmt(
                  num(d?.arrivesInTicks) ? (d.arrivesInTicks * TICK_PLANT_S) / 60 : undefined, 0)} plant-min`}
              />
            ))}
          </Detail>
        </>
      }
      trends={
        <>
          <Trend label="Burner demand" unit="MW" digits={1} data={trends['fuel.burnMW']} />
          <Trend label="Gas price" unit="$/GJ" digits={2} data={trends['fuel.gasPriceUsdPerGJ']} />
          <Trend label="Backup tank" unit="t" data={trends['fuel.backupTonnes']} />
        </>
      }
      controls={
        <>
          <FuelSelect {...ctl} />
          <FuelOrder {...ctl} />
        </>
      }
    />
  );
}
