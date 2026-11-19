import type { LoopId } from '@desal/schema';
import { useState } from 'react';
import { acidClean, ballCleaning, setpoint } from '../commands';
import { ActionButton } from '../controls/ActionButton';
import { canSend, pendingCommand, type ControlCtx } from '../controls/ctx';
import { CrewButton } from '../controls/CrewButton';
import { LoopSetpoint, Setpoint } from '../controls/Setpoint';
import { LoopModeToggle, Toggle } from '../controls/Toggle';
import { Trend } from '../controls/Trend';
import { FlashStages, scaleTint } from '../equipment/FlashStages';
import { DASH, fmt, get, num, stageKey } from '../equipment/format';
import { ACID_CLEAN_COST_USD, loopRange } from '../limits';
import { STAGE_COUNT, TICK_PLANT_S } from '../plantConstants';
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

const levelLoop = (n: number) => `level${n}` as LoopId;
const STAGE_NS = Array.from({ length: STAGE_COUNT }, (_, i) => i + 1);

/** Stage level setpoints (setpoint-driven in both modes): all stages at once, or one picked stage. */
function LevelControls(ctl: ControlCtx) {
  const [stage, setStage] = useState(1);
  // Its own pending state: the value last sent to all stages, shown while any stage still awaits it.
  const [sentAll, setSentAll] = useState<number | undefined>(undefined);
  const sps = STAGE_NS.map((n) => ctl.status?.loops?.[levelLoop(n)]?.setpoint);
  const common = sps.every((v) => num(v) && v === sps[0]) ? sps[0] : undefined;
  const allPending = sentAll !== undefined && STAGE_NS.some((n) => {
    const c = pendingCommand(ctl, `setSetpoint:${levelLoop(n)}`);
    return c?.type === 'setSetpoint' && c.value === sentAll;
  });
  const { min, max } = loopRange(levelLoop(1), 'setSetpoint');
  return (
    <>
      <Setpoint
        label="All stage levels"
        reported={common}
        pending={allPending ? sentAll : undefined}
        min={min}
        max={max}
        step={0.01}
        unit="m"
        digits={2}
        disabled={!canSend(ctl)}
        note={common === undefined && sps.some(num) ? 'stages differ' : undefined}
        onCommit={(v) => {
          setSentAll(v);
          for (const n of STAGE_NS) if (!ctl.send?.(setpoint(levelLoop(n), v))) break;
        }}
      />
      <div className="ctl-group">
        <label className="ctl">
          <span className="ctl__label">Stage</span>
          <select className="btn" aria-label="Stage" value={stage} disabled={!canSend(ctl)} onChange={(e) => setStage(Number(e.target.value))}>
            {STAGE_NS.map((n) => <option key={n} value={n}>S{n}</option>)}
          </select>
        </label>
        <LoopSetpoint key={stage} loop={levelLoop(stage)} name={`S${stage} level`} unit="m" step={0.01} digits={2} {...ctl} />
      </div>
    </>
  );
}

export function StagesView(props: ExpandedProps) {
  const { status, readings, trends } = props;
  const vac = get(readings, 'vacuum.quality');
  const ball = status?.ballCleaning;
  const ctl: ControlCtx = { status, pending: props.pending, send: props.send };
  const ok = canSend(ctl);
  const bal = status?.balanceUsd;
  const affordable = num(bal) && bal >= ACID_CLEAN_COST_USD;
  const cleaning = status?.status === 'acidCleaning';
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
      controls={
        <>
          <LoopSetpoint loop="recirc" name="Recirc" unit="m³/h" step={50} digits={0} {...ctl} />
          <LoopSetpoint loop="blowdown" name="Blowdown" unit="CF" step={0.01} digits={2} {...ctl} />
          <LoopSetpoint loop="vacuum" name="Vacuum" unit="quality" step={0.01} digits={2} {...ctl} />
          {status?.controlMode === 'auto' && (
            <div className="ctl-group">
              <LoopModeToggle loop="recirc" name="Recirc" {...ctl} />
              <LoopModeToggle loop="blowdown" name="Blowdown" {...ctl} />
              <LoopModeToggle loop="vacuum" name="Vacuum" {...ctl} />
            </div>
          )}
          <LevelControls {...ctl} />
          <Toggle
            label="Ball cleaning"
            on={typeof ball === 'boolean' ? ball : undefined}
            pending={pendingCommand(ctl, 'ballCleaning') !== undefined}
            disabled={!ok}
            onChange={(on) => props.send?.(ballCleaning(on))}
          />
          {status?.status === 'tripped' && (
            <ActionButton
              label="Acid clean"
              costUsd={ACID_CLEAN_COST_USD}
              confirm
              disabled={!ok || !affordable}
              hint={affordable ? 'removes hard scale; plant stays down for 2 h' : 'not enough budget'}
              pending={pendingCommand(ctl, 'acidClean') !== undefined}
              onAction={() => props.send?.(acidClean())}
            />
          )}
          <CrewButton job="repairEjector" {...ctl} />
          {cleaning && (
            <span className="ctl__meta">
              Acid cleaning, {fmt(num(status.acidCleanRemainingTicks) ? (status.acidCleanRemainingTicks * TICK_PLANT_S) / 60 : undefined, 0, 'min')} left
            </span>
          )}
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
