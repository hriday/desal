import type { LoopId } from '@desal/schema';
import { useState } from 'react';
import { acidClean, ballCleaning, setpoint, standbySteam } from '../commands';
import { ActionButton } from '../controls/ActionButton';
import { canSend, pendingCommand, type ControlCtx } from '../controls/ctx';
import { CrewButton } from '../controls/CrewButton';
import { LoopSetpoint, Setpoint } from '../controls/Setpoint';
import { LoopModeToggle, Toggle } from '../controls/Toggle';
import { Trend } from '../controls/Trend';
import { FlashStages, scaleTint } from '../equipment/FlashStages';
import { DASH, fmt, get, num, stageKey, usd } from '../equipment/format';
import { ACID_CLEAN_COST_USD, loopRange, STANDBY_STEAM_COST_USD_PER_H } from '../limits';
import { POOL_LOW_BAD_M, POOL_LOW_WARN_M } from '../alarms/rules';
import { EJECTOR_FULL_REACH_BAR, LEVEL_LOOP_COUNT, RECOVERY_STAGES, STAGE_COUNT, STEAM_BAD_BAR, TICK_PLANT_S } from '../plantConstants';
import { Detail, Row, ViewLayout, type Tone } from './Layout';
import type { ExpandedProps } from './types';

/** A stage level's tone: high levels flood (the stage-level alarm's thresholds). */
const highLevelTone = (level: number | undefined): Tone =>
  level === undefined ? undefined : level >= 0.65 ? 'bad' : level >= 0.5 ? 'warn' : undefined;
/** The brine pool's tone: high like any stage, and low on the brine-pool alarm's thresholds (bad once the recirc pump is losing suction). */
const poolTone = (level: number | undefined): Tone =>
  level === undefined ? undefined : level <= POOL_LOW_BAD_M ? 'bad' : level <= POOL_LOW_WARN_M ? 'warn' : highLevelTone(level);

const POOL_KEY = `stages.${stageKey(STAGE_COUNT)}.levelM`;

function StageCell({ n, readings }: { n: number; readings: Record<string, number> }) {
  const k = stageKey(n);
  const level = get(readings, `stages.${k}.levelM`);
  const hard = get(readings, `stages.${k}.hardScaleMm`);
  const tint = scaleTint(hard);
  const tone = n === STAGE_COUNT ? poolTone(level) : highLevelTone(level);
  return (
    <div className={`xv-stage xv-stage--${tint}`} data-stage-cell={n}>
      <div className="xv-stage__n">S{n}{n === STAGE_COUNT && <span className="xv-stage__name"> Brine pool</span>}</div>
      <div>{fmt(get(readings, `stages.${k}.tempC`), 1, '°C')}</div>
      <div className={tone ? `tone--${tone}` : undefined}>{fmt(level, 3, 'm')}</div>
      <div className="xv-stage__scale">soft {fmt(get(readings, `stages.${k}.softScaleMm`), 2)}</div>
      <div className={`xv-stage__scale${tint === 'ok' ? '' : ` tone--${tint}`}`}>hard {fmt(hard, 2, 'mm')}</div>
    </div>
  );
}

const GROUPS = [
  { id: 'recovery', title: `Heat recovery 1–${RECOVERY_STAGES}`, from: 1, to: RECOVERY_STAGES },
  { id: 'reject', title: `Heat rejection ${RECOVERY_STAGES + 1}–${STAGE_COUNT}`, from: RECOVERY_STAGES + 1, to: STAGE_COUNT },
] as const;

const levelLoop = (n: number) => `level${n}` as LoopId;
/** The stages with an interstage level loop (S1-S23); the S24 brine pool is the makeup loop's. */
const LEVEL_NS = Array.from({ length: LEVEL_LOOP_COUNT }, (_, i) => i + 1);

/** Stage level setpoints (setpoint-driven in both modes): all level loops at once, or one picked stage. */
function LevelControls(ctl: ControlCtx) {
  const [stage, setStage] = useState(1);
  // Its own pending state: the value last sent to all stages, shown while any stage still awaits it.
  const [sentAll, setSentAll] = useState<number | undefined>(undefined);
  const sps = LEVEL_NS.map((n) => ctl.status?.loops?.[levelLoop(n)]?.setpoint);
  const common = sps.every((v) => num(v) && v === sps[0]) ? sps[0] : undefined;
  const allPending = sentAll !== undefined && LEVEL_NS.some((n) => {
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
          for (const n of LEVEL_NS) if (!ctl.send?.(setpoint(levelLoop(n), v))) break;
        }}
      />
      <div className="ctl-group">
        <label className="ctl">
          <span className="ctl__label">Stage</span>
          <select className="btn" aria-label="Stage" value={stage} disabled={!canSend(ctl)} onChange={(e) => setStage(Number(e.target.value))}>
            {LEVEL_NS.map((n) => <option key={n} value={n}>S{n}</option>)}
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
  const steam = get(readings, 'vacuum.motiveSteamBar');
  const valve = status?.loops?.vacuum?.output;
  const ball = status?.ballCleaning;
  const ctl: ControlCtx = { status, pending: props.pending, send: props.send };
  const ok = canSend(ctl);
  const bal = status?.balanceUsd;
  const affordable = num(bal) && bal >= ACID_CLEAN_COST_USD;
  const cleaning = status?.status === 'acidCleaning';
  const pool = get(readings, POOL_KEY);
  return (
    <ViewLayout
      drawing={<FlashStages {...props} />}
      detail={
        <Detail title="Flash stages">
          <Row k="Brine recycle (recirc)" v={fmt(get(readings, 'brine.recircM3h'), 0, 'm³/h')} />
          <Row k="Distillate trough" v={fmt(get(readings, 'product.flowM3h'), 0, 'm³/h')} />
          <Row k="Concentration factor" v={fmt(get(readings, 'brine.concentrationFactor'), 2)} />
          <Row k="Blowdown" v={fmt(get(readings, 'brine.blowdownM3h'), 0, 'm³/h')} />
          <Row k="Makeup to brine pool" v={fmt(get(readings, 'brine.makeupM3h'), 0, 'm³/h')} />
          <Row k="Cooling water reject" v={fmt(get(readings, 'brine.coolingRejectM3h'), 0, 'm³/h')} />
          <Row k={`Brine pool (S${STAGE_COUNT}) level`} v={fmt(pool, 2, 'm')} tone={poolTone(pool)} />
          <Row k="Vacuum quality" v={fmt(vac, 2)} tone={vac === undefined ? undefined : vac < 0.7 ? 'bad' : vac < 0.8 ? 'warn' : undefined} />
          <Row k="Motive steam" v={fmt(steam, 1, 'bar')} tone={steam === undefined ? undefined : steam < STEAM_BAD_BAR ? 'bad' : steam < EJECTOR_FULL_REACH_BAR ? 'warn' : undefined} />
          <Row k="Ejector steam valve" v={fmt(num(valve) ? valve : undefined, 0, '%')} />
          <Row k="Ball cleaning" v={ball === true ? 'On' : ball === false ? 'Off' : DASH} />
        </Detail>
      }
      trends={
        <>
          <Trend label="Vacuum quality" digits={2} data={trends['vacuum.quality']} />
          <Trend label="Motive steam" unit="bar" digits={1} data={trends['vacuum.motiveSteamBar']} />
          <Trend label="Concentration factor" digits={2} data={trends['brine.concentrationFactor']} />
          <Trend label="Recirculation" unit="m³/h" data={trends['brine.recircM3h']} />
        </>
      }
      controls={
        <>
          <LoopSetpoint loop="recirc" name="Recirc" unit="m³/h" step={50} digits={0} {...ctl} />
          <LoopSetpoint loop="blowdown" name="Blowdown" unit="CF" step={0.01} digits={2} {...ctl} />
          <LoopSetpoint loop="vacuum" name="Vacuum" outputName="Ejector steam valve" unit="quality" step={0.01} digits={2} {...ctl} />
          {status?.controlMode === 'auto' && (
            <div className="ctl-group">
              <LoopModeToggle loop="recirc" name="Recirc" {...ctl} />
              <LoopModeToggle loop="blowdown" name="Blowdown" {...ctl} />
              <LoopModeToggle loop="vacuum" name="Vacuum" {...ctl} />
            </div>
          )}
          <LoopSetpoint loop="makeup" name="Makeup" unit="m" step={0.01} digits={2} {...ctl} />
          {/* An inventory loop: its mode can change in both control modes (and a controller fault on it clears in Manual). */}
          <LoopModeToggle loop="makeup" name="Makeup" {...ctl} />
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
          <Toggle
            label="Standby steam line"
            on={typeof status?.standbySteam === 'boolean' ? status.standbySteam : undefined}
            pending={pendingCommand(ctl, 'standbySteam') !== undefined}
            disabled={!ok}
            note={`${usd(STANDBY_STEAM_COST_USD_PER_H)}/h while on`}
            onChange={(on) => props.send?.(standbySteam(on))}
          />
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
        {GROUPS.map((g) => (
          <section key={g.id} className={`xv-stages__group xv-stages__group--${g.id}`} data-stage-group={g.id} aria-label={g.title}>
            <h4 className="xv-stages__title">{g.title}</h4>
            <div className="xv-stages__grid">
              {Array.from({ length: g.to - g.from + 1 }, (_, i) => g.from + i).map((n) => <StageCell key={n} n={n} readings={readings} />)}
            </div>
          </section>
        ))}
      </div>
    </ViewLayout>
  );
}
