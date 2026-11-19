import { salinityLimit } from '../alarms/rules';
import { divert as divertCmd } from '../commands';
import { canSend } from '../controls/ctx';
import { Toggle } from '../controls/Toggle';
import { Trend } from '../controls/Trend';
import { DASH, fmt, get, num } from '../equipment/format';
import { ProductWater } from '../equipment/ProductWater';
import { Detail, Row, ViewLayout } from './Layout';
import type { ExpandedProps } from './types';

export function ProductView(props: ExpandedProps) {
  const { status, readings, trends, target } = props;
  const sal = get(readings, 'product.salinityPpm');
  const limit = salinityLimit(target);
  const made = get(readings, 'product.shiftProductM3');
  const goal = num(target?.productM3) ? target.productM3 : undefined;
  const frac = made !== undefined && goal !== undefined && goal > 0 ? made / goal : undefined;
  const divert = status?.divertToDrain;
  return (
    <ViewLayout
      drawing={<ProductWater {...props} />}
      detail={
        <Detail title="Product water">
          <Row k="Flow" v={fmt(get(readings, 'product.flowM3h'), 0, 'm³/h')} />
          <Row k="Salinity" v={fmt(sal, 1, 'ppm')} tone={sal === undefined ? undefined : sal > limit ? 'bad' : sal >= 0.8 * limit ? 'warn' : undefined} />
          <Row k="Salinity limit" v={fmt(limit, 0, 'ppm')} />
          <Row k="Routing" v={divert === true ? 'Diverted to drain' : divert === false ? 'To tank' : DASH} tone={divert === true ? 'warn' : undefined} />
          <Row k="In-spec water this shift" v={`${fmt(made)} / ${fmt(goal, 0, 'm³')}`} />
          <Row k="Of target" v={fmt(frac === undefined ? undefined : frac * 100, 0, '%')} />
        </Detail>
      }
      trends={
        <>
          <Trend label="Product flow" unit="m³/h" data={trends['product.flowM3h']} />
          <Trend label="Salinity" unit="ppm" digits={1} data={trends['product.salinityPpm']} />
          <Trend label="In-spec water" unit="m³" data={trends['product.shiftProductM3']} />
        </>
      }
      controls={
        <Toggle
          label="Divert to drain"
          on={typeof divert === 'boolean' ? divert : undefined}
          pending={props.pending?.has('divertToDrain') === true}
          disabled={!canSend({ status, send: props.send })}
          onChange={(on) => props.send?.(divertCmd(on))}
        />
      }
    />
  );
}
