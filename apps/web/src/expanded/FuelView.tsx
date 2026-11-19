import { Trend } from '../controls/Trend';
import { DASH, fmt, get, label, num, usd } from '../equipment/format';
import { Fuel } from '../equipment/Fuel';
import { TICK_PLANT_S } from '../plantConstants';
import { FUEL_TEXT, GRADE_TEXT } from './labels';
import { Detail, Row, ViewLayout } from './Layout';
import type { ExpandedProps } from './types';

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
    />
  );
}
