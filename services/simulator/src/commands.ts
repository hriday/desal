import { CommandEnvelopeSchema, type Command, type LoopId, type PlantEvent } from '@desal/schema';
import { CHANGEOVER_TICKS, LOOP_RANGES } from './constants.js';
import { loopKind } from './control/loops.js';
import { nextRandom } from './rng.js';
import { applyTrip } from './safety/interlocks.js';
import { beginAcidClean, beginRestart, restartStep, type Result } from './safety/restart.js';
import { startShift } from './shift.js';
import { createInitialState, type Loop, type PlantState } from './state.js';

type Out = { state: PlantState; events: PlantEvent[] };

/** Ticks between ordering backup fuel and its arrival. */
export const DELIVERY_TICKS = 90;
const DOSE_MAX_MGL = 10;
const ORDER_MIN_T = 1;
const ORDER_MAX_T = 500;

const reject = (s: PlantState, commandId: string, reason: string): Out => ({
  state: s,
  events: [
    { type: 'commandRejected', tick: s.tick, plantTime: s.plantTime, shiftId: s.shift?.id ?? null, commandId, reason },
  ],
});

const fromResult = (s: PlantState, commandId: string, r: Result): Out =>
  'rejected' in r ? reject(s, commandId, r.rejected) : r;

const isLevel = (id: LoopId): boolean => loopKind(id) === 'level';
const levelIndex = (id: LoopId): number => Number(id.slice(5)) - 1;

function getLoop(s: PlantState, id: LoopId): Loop {
  return isLevel(id) ? s.loops.levels[levelIndex(id)]! : s.loops[id as 'tbt'];
}

function withLoop(s: PlantState, id: LoopId, patch: Partial<Loop>): PlantState {
  if (isLevel(id)) {
    const i = levelIndex(id);
    return { ...s, loops: { ...s.loops, levels: s.loops.levels.map((l, j) => (j === i ? { ...l, ...patch } : l)) } };
  }
  return { ...s, loops: { ...s.loops, [id]: { ...s.loops[id as 'tbt'], ...patch } } };
}

function apply(s: PlantState, id: string, c: Command): Out {
  const ok = (state: PlantState, events: PlantEvent[] = []): Out => ({ state, events });
  const no = (reason: string): Out => reject(s, id, reason);
  const base = { tick: s.tick, plantTime: s.plantTime, shiftId: s.shift?.id ?? null };

  switch (c.type) {
    case 'startShift':
      return s.phase === 'handover' ? startShift(s, c.mode) : no('startShift only allowed during handover');
    case 'newCareer': {
      const [v] = nextRandom(s.seed);
      return ok(createInitialState(Math.floor(v * 4294967296), s.plantTime));
    }
    case 'setSetpoint': {
      const r = LOOP_RANGES[loopKind(c.loop)];
      if (c.value < r.spMin || c.value > r.spMax) return no(`setpoint ${c.value} out of range ${r.spMin}..${r.spMax}`);
      if (!isLevel(c.loop) && s.controlMode !== 'auto') return no('setpoint changes are Auto-mode only');
      return ok(withLoop(s, c.loop, { setpoint: c.value }));
    }
    case 'setOutput': {
      const r = LOOP_RANGES[loopKind(c.loop)];
      if (c.value < r.outMin || c.value > r.outMax) return no(`output ${c.value} out of range ${r.outMin}..${r.outMax}`);
      if (getLoop(s, c.loop).mode !== 'manual') return no('loop is not in manual');
      return ok(withLoop(s, c.loop, { output: c.value }));
    }
    case 'setLoopMode':
      if (s.controlMode === 'manual' && !isLevel(c.loop)) return no('only level loops can change mode in Manual');
      return ok(withLoop(s, c.loop, { mode: c.mode }));
    case 'pump':
      return ok({
        ...s,
        intake: {
          ...s.intake,
          pumps: { ...s.intake.pumps, [c.pumpId]: { ...s.intake.pumps[c.pumpId], running: c.action === 'start' } },
        },
      });
    case 'setDose':
      if (c.mgL < 0 || c.mgL > DOSE_MAX_MGL) return no(`dose ${c.mgL} out of range 0..${DOSE_MAX_MGL}`);
      return ok({
        ...s,
        pretreat: { ...s.pretreat, [c.chemical === 'chlorine' ? 'chlorineMgL' : 'antiscalantMgL']: c.mgL },
      });
    case 'ballCleaning':
      return ok({ ...s, ballCleaning: c.on });
    case 'divertToDrain':
      return ok({ ...s, product: { ...s.product, divertToDrain: c.on } });
    case 'selectFuel':
      if (s.fuel.changeover) return no('fuel changeover in progress');
      if (c.fuel === s.fuel.active) return no(`${c.fuel} is already the active fuel`);
      return ok({ ...s, fuel: { ...s.fuel, changeover: { to: c.fuel, remainingTicks: CHANGEOVER_TICKS } } }, [
        { ...base, type: 'fuelChangeover', from: s.fuel.active, to: c.fuel, phase: 'started' },
      ]);
    case 'orderFuel': {
      if (c.tonnes < ORDER_MIN_T || c.tonnes > ORDER_MAX_T) {
        return no(`order ${c.tonnes} t out of range ${ORDER_MIN_T}..${ORDER_MAX_T}`);
      }
      const fx = s.scenario.effects;
      const delivery = {
        arrivesAtTick: s.tick + DELIVERY_TICKS + fx.deliveryDelayTicks,
        tonnes: c.tonnes,
        grade: fx.offgradeOnly ? ('offgrade' as const) : ('standard' as const),
      };
      return ok({ ...s, fuel: { ...s.fuel, deliveries: [...s.fuel.deliveries, delivery] } });
    }
    case 'manualTrip':
      if (s.status !== 'online' && s.status !== 'restarting') {
        return no('manual trip requires an online or restarting plant');
      }
      return applyTrip(s, 'manual');
    case 'restart':
      return fromResult(s, id, beginRestart(s));
    case 'restartStep':
      return fromResult(s, id, restartStep(s, c.step));
    case 'acidClean':
      return fromResult(s, id, beginAcidClean(s));
    case 'pause':
      return s.phase === 'running' ? ok({ ...s, phase: 'paused' }) : no('not running');
    case 'resume':
      return s.phase === 'paused' ? ok({ ...s, phase: 'running' }) : no('not paused');
  }
}

/** Validate and apply one command envelope. Never throws; a rejection returns the input state and one commandRejected event. */
export function applyCommand(s: PlantState, env: unknown): Out {
  const parsed = CommandEnvelopeSchema.safeParse(env);
  if (!parsed.success) {
    let raw: unknown;
    try {
      raw = (env as { commandId?: unknown } | null | undefined)?.commandId;
    } catch {
      raw = undefined;
    }
    const commandId = typeof raw === 'string' ? raw : 'unknown';
    return reject(s, commandId, `invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  const { commandId, shiftId, command } = parsed.data;
  const exempt = command.type === 'startShift' || command.type === 'newCareer';
  if (!exempt && s.phase === 'handover') return reject(s, commandId, 'not allowed during handover');
  if (!exempt && shiftId !== (s.shift?.id ?? null)) return reject(s, commandId, 'stale shift');
  return apply(s, commandId, command);
}
