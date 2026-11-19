import { describe, expect, it } from 'vitest';
import { LOOP_RANGES } from '../src/constants.js';
import { nextRandom } from '../src/rng.js';
import { createInitialState, type PlantState } from '../src/state.js';
import { tick } from '../src/tick.js';
import { env, nextId, GAME_ID } from './envelope.js';
import { allFinite } from './helpers.js';

const SEQUENCES = 20;
const TICKS = 2000;

/** Seeded random source for command generation (independent of the plant's own seed). */
class Rand {
  constructor(private seed: number) {}
  next(): number {
    const [v, s] = nextRandom(this.seed);
    this.seed = s;
    return v;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)] as T;
  }
  /** Mostly in range, sometimes exactly at a bound, sometimes just beyond. */
  value(lo: number, hi: number): number {
    const r = this.next();
    if (r < 0.15) return lo;
    if (r < 0.3) return hi;
    if (r < 0.4) return this.pick([lo - 1, hi + 1, lo - 1e-9, hi * 10]);
    return lo + this.next() * (hi - lo);
  }
}

const LOOPS = ['tbt', 'intakeFlow', 'recirc', 'blowdown', 'vacuum', 'level1', 'level7', 'level20'] as const;
const SP: Record<string, [number, number]> = Object.fromEntries(
  (['tbt', 'intakeFlow', 'recirc', 'blowdown', 'vacuum'] as const).map((k) => [k, [LOOP_RANGES[k].spMin, LOOP_RANGES[k].spMax]]),
);
const PUMPS = ['P-101', 'P-102', 'P-103'] as const;

function randomCommand(r: Rand, s: PlantState): unknown {
  const k = r.int(0, 21);
  const loop = r.pick(LOOPS);
  const [lo, hi] = SP[loop] ?? [0.15, 0.6];
  switch (k) {
    case 0:
      return env(s, { type: 'setSetpoint', loop, value: r.value(lo, hi) });
    case 1:
      return env(s, { type: 'setOutput', loop, value: r.value(0, 100) });
    case 2:
      return env(s, { type: 'setLoopMode', loop, mode: r.pick(['auto', 'manual']) });
    case 3:
    case 4:
      return env(s, { type: 'pump', pumpId: r.pick(PUMPS), action: r.pick(['start', 'stop']) });
    case 5:
      return env(s, { type: 'setDose', chemical: r.pick(['chlorine', 'antiscalant']), mgL: r.value(0, 10) });
    case 6:
      return env(s, { type: 'ballCleaning', on: r.next() < 0.5 });
    case 7:
      return env(s, { type: 'divertToDrain', on: r.next() < 0.5 });
    case 8:
      return env(s, { type: 'selectFuel', fuel: r.pick(['gas', 'backup']) });
    case 9:
      return env(s, { type: 'orderFuel', tonnes: r.value(1, 500) });
    case 10:
      return env(s, { type: 'manualTrip' });
    case 11:
    case 12:
      return env(s, { type: 'restart' });
    case 13:
      return env(s, { type: 'restartStep', step: r.pick(['vacuum', 'recirc', 'ignition', 'ramp']) });
    case 14:
      return env(s, { type: 'acidClean' });
    case 15:
      return env(s, { type: r.pick(['pause', 'resume']) });
    case 16:
      return env(s, { type: 'startShift', mode: r.pick(['auto', 'manual']) }, null);
    case 17:
      return r.next() < 0.1 ? env(s, { type: 'quitGame' }) : env(s, { type: 'resume' });
    case 18:
      return env(s, { type: 'setSetpoint', loop, value: r.pick([NaN, Infinity, -1e308]) });
    case 19:
      return { commandId: nextId(), issuedAt: 0, gameId: s.run.gameId, shiftId: 99, command: { type: 'manualTrip' } };
    case 20:
      return r.pick([null, undefined, 'junk', {}, { command: { type: 'restart' } }, [1, 2, 3]]);
    default:
      return env(s, { type: 'setSetpoint', loop: 'level99', value: 0.3 });
  }
}

/** Start states: nominal, all pumps stopped, and fuel exhausted (no gas, near-empty backup). */
function startState(i: number): PlantState {
  const s = createInitialState(1000 + i, 0, GAME_ID);
  if (i % 3 === 1) {
    for (const p of Object.values(s.intake.pumps)) p.running = false;
  } else if (i % 3 === 2) {
    s.fuel.gas.capMW = 0;
    s.fuel.backup.tonnes = 0.5;
  }
  return s;
}

describe('fuzz: random command sequences', () => {
  it(`${SEQUENCES} seeded sequences x ${TICKS} ticks stay finite and never throw`, () => {
    const seen = { running: 0, trip: 0, online: 0, shiftEnd: 0, rejected: 0, gameEnd: 0 };
    for (let seq = 0; seq < SEQUENCES; seq++) {
      const r = new Rand(seq * 7919 + 1);
      let s = startState(seq);
      for (let t = 0; t < TICKS; t++) {
        const commands: unknown[] = [];
        // In handover, usually start the next shift so most ticks run the plant.
        if (s.phase === 'handover' && r.next() < 0.5) {
          commands.push(env(s, { type: 'startShift', mode: r.pick(['auto', 'manual']) }, null));
        }
        if (s.phase === 'paused' && r.next() < 0.3) commands.push(env(s, { type: 'resume' }));
        const n = r.next() < 0.7 ? 0 : r.int(1, 4);
        for (let c = 0; c < n; c++) commands.push(randomCommand(r, s));
        const out = tick(s, commands);
        s = out.state;
        if (out.telemetry.length > 0) seen.running++;
        for (const e of out.events) {
          if (e.type === 'trip') seen.trip++;
          if (e.type === 'online') seen.online++;
          if (e.type === 'shiftEnd') seen.shiftEnd++;
          if (e.type === 'commandRejected') seen.rejected++;
          if (e.type === 'gameEnd') seen.gameEnd++;
        }
        if (!allFinite(s) || !allFinite(out.telemetry) || !allFinite(out.status)) {
          throw new Error(`non-finite state at sequence ${seq}, tick ${t}`);
        }
        // A game that has ended stays over; carry on with a fresh one, as the host would.
        if (s.phase === 'over') s = createInitialState(s.seed, s.plantTime, GAME_ID);
      }
      expect(allFinite(s)).toBe(true);
    }
    // The sequences really exercised the plant, not just handover and pause.
    expect(seen.running).toBeGreaterThan(0.5 * SEQUENCES * TICKS);
    expect(seen.trip).toBeGreaterThan(0);
    expect(seen.online).toBeGreaterThan(0);
    expect(seen.shiftEnd).toBeGreaterThan(0);
    expect(seen.rejected).toBeGreaterThan(0);
    expect(seen.gameEnd).toBeGreaterThan(0);
  });
});
