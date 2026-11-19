import { CommandEnvelopeSchema, type AccountCause, type Command, type LoopId } from '@desal/schema';
import {
  ACID_CLEAN_COST_USD,
  CHANGEOVER_TICKS,
  LOOP_RANGES,
  PUMP_OVERHAUL_COST_USD,
  PUMP_OVERHAUL_TICKS,
} from './constants.js';
import { loopKind } from './control/loops.js';
import { backupOrderCostUsd, canAfford, charge } from './economy.js';
import { applyTrip } from './safety/interlocks.js';
import { beginAcidClean, beginRestart, restartStep, type Result } from './safety/restart.js';
import { startShift } from './shift.js';
import type { Loop, PlantState, SimEvent } from './state.js';

type Out = { state: PlantState; events: SimEvent[] };

/** Ticks between ordering backup fuel and its arrival. */
export const DELIVERY_TICKS = 90;
const DOSE_MAX_MGL = 10;
const ORDER_MIN_T = 1;
const ORDER_MAX_T = 500;

/** Longest commandId echoed back: a huge one from a bad client must not make an unproducible event. */
const COMMAND_ID_ECHO_MAX = 64;

const reject = (s: PlantState, commandId: string, reason: string): Out => ({
  state: s,
  events: [
    {
      type: 'commandRejected',
      tick: s.tick,
      plantTime: s.plantTime,
      shiftId: s.shift?.id ?? null,
      commandId: commandId.slice(0, COMMAND_ID_ECHO_MAX),
      reason,
    },
  ],
});

const fromResult = (s: PlantState, commandId: string, r: Result): Out =>
  'rejected' in r ? reject(s, commandId, r.rejected) : r;

/**
 * Pay for an action that `act` has already validated: reject 'insufficient funds' when the balance
 * is below the cost (nothing changes), otherwise charge and keep the action's result.
 */
function paid(s: PlantState, commandId: string, usd: number, cause: AccountCause, act: Out): Out {
  if (act.events.some((e) => e.type === 'commandRejected')) return act;
  if (!canAfford(s, usd)) return reject(s, commandId, 'insufficient funds');
  const c = charge(act.state, usd, cause);
  return { state: c.state, events: [c.event, ...act.events] };
}

/** Add a backup-fuel purchase to the shift's fuel spend (gas is added as it burns). */
function withFuelSpend(s: PlantState, usd: number): PlantState {
  if (!s.shift) return s;
  return { ...s, shift: { ...s.shift, acc: { ...s.shift.acc, fuelCostUsd: s.shift.acc.fuelCostUsd + usd } } };
}

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
  const ok = (state: PlantState, events: SimEvent[] = []): Out => ({ state, events });
  const no = (reason: string): Out => reject(s, id, reason);
  const base = { tick: s.tick, plantTime: s.plantTime, shiftId: s.shift?.id ?? null };

  switch (c.type) {
    case 'startShift':
      return s.phase === 'handover' ? startShift(s, c.mode) : no('startShift only allowed during handover');
    // Game lifecycle arrives with game over and the multi-game host.
    case 'startGame':
    case 'quitGame':
    case 'heartbeat':
      return no('not implemented');
    case 'overhaulPump': {
      const p = s.intake.pumps[c.pumpId];
      if (p.overhaulRemainingTicks > 0) return no('under overhaul');
      if (p.running) return no('stop the pump before an overhaul (pump is running)');
      const pumps = { ...s.intake.pumps, [c.pumpId]: { ...p, overhaulRemainingTicks: PUMP_OVERHAUL_TICKS } };
      return paid(s, id, PUMP_OVERHAUL_COST_USD, 'overhaul', ok({ ...s, intake: { ...s.intake, pumps } }));
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
      if (c.action === 'start' && s.intake.pumps[c.pumpId].overhaulRemainingTicks > 0) return no('under overhaul');
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
      const cost = backupOrderCostUsd(s, c.tonnes);
      const ordered = withFuelSpend({ ...s, fuel: { ...s.fuel, deliveries: [...s.fuel.deliveries, delivery] } }, cost);
      return paid(s, id, cost, 'delivery', ok(ordered));
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
      return paid(s, id, ACID_CLEAN_COST_USD, 'acidClean', fromResult(s, id, beginAcidClean(s)));
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
  const { commandId, gameId, shiftId, command } = parsed.data;
  if (gameId !== s.run.gameId) return reject(s, commandId, 'wrong game');
  const exempt =
    command.type === 'startShift' ||
    command.type === 'startGame' ||
    command.type === 'quitGame' ||
    command.type === 'heartbeat';
  if (!exempt && s.phase === 'handover') return reject(s, commandId, 'not allowed during handover');
  if (!exempt && shiftId !== (s.shift?.id ?? null)) return reject(s, commandId, 'stale shift');
  return apply(s, commandId, command);
}
