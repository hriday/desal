import { Trend } from '../controls/Trend';
import { FlashStages, scaleTint } from '../equipment/FlashStages';
import { DASH, fmt, get, stageKey } from '../equipment/format';
import { STAGE_COUNT } from '../plantConstants';
import { Detail, Row, ViewLayout } from './Layout';
import type { ExpandedProps } from './types';

const ROW = 10;

function StageCell({ n, readings }: { n: number; readings: Record<string, number> }) {
  const k = stageKey(n);
  const level = get(readings, `stages.${k}.levelM`);
  const hard = get(readings, `stages.${k}.hardScaleMm`);
  const tint = scaleTint(hard);
  const levelTone = level === undefined ? '' : level >= 0.65 ? 'tone--bad' : level >= 0.5 ? 'tone--warn' : '';
  return (
    <div className={`xv-stage xv-stage--${tint}`} data-stage-cell={n}>
      <div className="xv-stage__n">S{n}</div>
      <div>{fmt(get(readings, `stages.${k}.tempC`), 1, '°C')}</div>
      <div className={levelTone}>{fmt(level, 3, 'm')}</div>
      <div className="xv-stage__scale">soft {fmt(get(readings, `stages.${k}.softScaleMm`), 2)}</div>
      <div className={`xv-stage__scale${tint === 'ok' ? '' : ` tone--${tint}`}`}>hard {fmt(hard, 2, 'mm')}</div>
    </div>
  );
}

export function StagesView(props: ExpandedProps) {
  const { status, readings, trends } = props;
  const vac = get(readings, 'vacuum.quality');
  const ball = status?.ballCleaning;
  const rows = [0, 1].map((r) => Array.from({ length: ROW }, (_, i) => r * ROW + i + 1).filter((n) => n <= STAGE_COUNT));
  return (
    <ViewLayout
      drawing={<FlashStages {...props} />}
      detail={
        <Detail title="Flash stages">
          <Row k="Condenser line (recirc)" v={fmt(get(readings, 'brine.recircM3h'), 0, 'm³/h')} />
          <Row k="Distillate trough" v={fmt(get(readings, 'product.flowM3h'), 0, 'm³/h')} />
          <Row k="Concentration factor" v={fmt(get(readings, 'brine.concentrationFactor'), 2)} />
          <Row k="Blowdown" v={fmt(get(readings, 'brine.blowdownM3h'), 0, 'm³/h')} />
          <Row k="Vacuum quality" v={fmt(vac, 2)} tone={vac === undefined ? undefined : vac < 0.7 ? 'bad' : vac < 0.8 ? 'warn' : undefined} />
          <Row k="Ball cleaning" v={ball === true ? 'On' : ball === false ? 'Off' : DASH} />
        </Detail>
      }
      trends={
        <>
          <Trend label="Vacuum quality" digits={2} data={trends['vacuum.quality']} />
          <Trend label="Concentration factor" digits={2} data={trends['brine.concentrationFactor']} />
          <Trend label="Recirculation" unit="m³/h" data={trends['brine.recircM3h']} />
        </>
      }
    >
      <div className="xv-stages" aria-label="Stages">
        {rows.map((ns, r) => (
          <div key={r} className="xv-stages__row">
            {ns.map((n) => <StageCell key={n} n={n} readings={readings} />)}
          </div>
        ))}
      </div>
    </ViewLayout>
  );
}
