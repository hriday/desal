import { describe, expect, it } from 'vitest';
import { GameHost, type HostTick } from '../src/host.js';
import { isBusy, paceOf } from '../src/pace.js';
import type { FiredEvent } from '../src/scenario/chaosTypes.js';
import type { PlantState } from '../src/state.js';
import { nextId } from './envelope.js';

const gid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, '0')}`;
const cmd = (gameId: string, command: Record<string, unknown>, shiftId: number | null = null) => ({
  commandId: nextId(),
  issuedAt: 0,
  gameId,
  shiftId,
  command,
});
const types = (evs: { type: string }[]) => evs.map((e) => e.type);

/** A host with the given games started. */
function started(ids: string[], opts = {}) {
  const h = new GameHost(opts);
  h.step(
    ids.map((g) => cmd(g, { type: 'startGame' })),
    0,
  );
  return h;
}

describe('GameHost', () => {
  it('startGame creates a game and emits gameStart at seq 0 of that game', () => {
    const h = new GameHost();
    const r = h.step([cmd(gid(1), { type: 'startGame' })], 1000);
    expect(h.games().has(gid(1))).toBe(true);
    const evs = r.perGame.get(gid(1))!.events;
    expect(types(evs)).toEqual(['gameStart']);
    expect(evs[0]).toMatchObject({ gameId: gid(1), seq: 0 });
    expect(r.hostEvents).toEqual([]);
  });

  it('startGame carries the mode into the run, gameStart and status; it defaults to normal', () => {
    const h = new GameHost();
    const r = h.step([cmd(gid(1), { type: 'startGame', mode: 'hard' }), cmd(gid(2), { type: 'startGame' })], 1000);
    expect(h.games().get(gid(1))!.state.run.mode).toBe('hard');
    expect(r.perGame.get(gid(1))!.events[0]).toMatchObject({ type: 'gameStart', mode: 'hard' });
    expect(h.games().get(gid(2))!.state.run.mode).toBe('normal');
    expect(r.perGame.get(gid(2))!.events[0]).toMatchObject({ type: 'gameStart', mode: 'normal' });
    const out = h.step([], 2000).perGame.get(gid(1))!;
    expect(out.status).toMatchObject({ mode: 'hard' });
  });

  it('draws shift 1 pending plan at creation, deterministically from the host seed', () => {
    const a = started([gid(1)], { seed: 9 }).games().get(gid(1))!.state;
    const b = started([gid(1)], { seed: 9 }).games().get(gid(1))!.state;
    expect(a.chaos.pending?.shiftNumber).toBe(1);
    expect(a.chaos.pending).toEqual(b.chaos.pending);
  });

  it('isolates games: a command to A does not change B', () => {
    const h = started([gid(1), gid(2)]);
    const before = h.games().get(gid(2))!.state;
    h.step([cmd(gid(1), { type: 'startShift', mode: 'auto' })], 1000);
    expect(h.games().get(gid(1))!.state.phase).toBe('running');
    expect(h.games().get(gid(2))!.state).toEqual(before);
  });

  it('rejects the 11th startGame with capacity', () => {
    const ids = Array.from({ length: 10 }, (_, i) => gid(i + 1));
    const h = started(ids);
    const r = h.step([cmd(gid(11), { type: 'startGame' })], 1000);
    expect(h.games().size).toBe(10);
    expect(r.hostEvents).toHaveLength(1);
    expect(r.hostEvents[0]).toMatchObject({
      type: 'gameRejected',
      reason: 'capacity',
      gameId: gid(11),
      seq: 0,
      tick: 0,
      plantTime: 1000,
      shiftId: null,
    });
  });

  it('marks host-level events host: true (seq 0, no plant to stamp from); plant events carry no host flag', () => {
    const h = started([gid(1)]);
    const r = h.step([cmd(gid(9), { type: 'pause' }), cmd(gid(1), { type: 'resume' })], 1000);
    expect(r.hostEvents).toEqual([expect.objectContaining({ host: true, seq: 0, type: 'commandRejected', reason: 'no such game' })]);
    const plant = r.perGame.get(gid(1))!.events;
    expect(plant.map((e) => e.type)).toEqual(['commandRejected']);
    expect(plant[0]!.host).toBeUndefined();
  });

  it('rejects a duplicate startGame', () => {
    const h = started([gid(1)]);
    const r = h.step([cmd(gid(1), { type: 'startGame' })], 1000);
    expect(r.hostEvents[0]).toMatchObject({ type: 'gameRejected', reason: 'duplicate', gameId: gid(1) });
    expect(h.games().size).toBe(1);
  });

  it('rejects a command to an unknown game and creates nothing', () => {
    const h = new GameHost();
    const r = h.step([cmd(gid(9), { type: 'pause' })], 1000);
    expect(r.hostEvents[0]).toMatchObject({ type: 'commandRejected', reason: 'no such game', gameId: gid(9) });
    expect(h.games().size).toBe(0);
    expect(r.perGame.size).toBe(0);
  });

  it('turns an unparseable envelope into a commandRejected on the all-zero game', () => {
    const h = new GameHost();
    const r = h.step([{ nope: 1 }, null], 5);
    expect(r.hostEvents).toHaveLength(2);
    for (const e of r.hostEvents) {
      expect(e).toMatchObject({ type: 'commandRejected', gameId: '00000000-0000-0000-0000-000000000000', seq: 0 });
    }
  });

  it('ends an idle game as abandoned after 90 s; a heartbeat at 89 s keeps it alive', () => {
    const h = started([gid(1), gid(2)]);
    const hb = h.step([cmd(gid(1), { type: 'heartbeat' })], 89_000);
    expect(hb.ended).toEqual([]);
    const r = h.step([], 90_001);
    expect(r.ended).toEqual([gid(2)]);
    const evs = r.perGame.get(gid(2))!.events;
    expect(types(evs)).toEqual(['gameEnd']);
    expect(evs[0]).toMatchObject({ reason: 'abandoned' });
    expect(h.games().has(gid(2))).toBe(false);
    expect(h.games().has(gid(1))).toBe(true);
  });

  describe('idle players (heartbeats alone do not keep a game forever)', () => {
    /** Step with a heartbeat for every game every 15 s, from `from` (exclusive) to `to` (inclusive); returns the games ended. */
    function heartbeats(h: GameHost, from: number, to: number): string[] {
      const ended: string[] = [];
      for (let t = from + 15_000; t <= to; t += 15_000) {
        ended.push(...h.step([...h.games().keys()].map((g) => cmd(g, { type: 'heartbeat' })), t).ended);
      }
      return ended;
    }

    it('ends a game in handover after 10 minutes without a player action', () => {
      const h = started([gid(1)]); // created at 0, in handover
      expect(heartbeats(h, 0, 600_000)).toEqual([]);
      const r = h.step([cmd(gid(1), { type: 'heartbeat' })], 600_001);
      expect(r.ended).toEqual([gid(1)]);
      expect(r.perGame.get(gid(1))!.events.at(-1)).toMatchObject({ type: 'gameEnd', reason: 'abandoned' });
    });

    it('ends a running game after 30 minutes without a player action, not after 10', () => {
      const h = started([gid(1)]);
      h.step([cmd(gid(1), { type: 'startShift', mode: 'auto' })], 1000);
      expect(heartbeats(h, 1000, 1000 + 1_800_000)).toEqual([]);
      expect(h.games().get(gid(1))!.state.phase).toBe('running');
      const r = h.step([cmd(gid(1), { type: 'heartbeat' })], 1000 + 1_800_001);
      expect(r.ended).toEqual([gid(1)]);
    });

    it('ends a paused game after 10 minutes without a player action', () => {
      const h = started([gid(1)]);
      h.step([cmd(gid(1), { type: 'startShift', mode: 'auto' })], 1000);
      h.step([cmd(gid(1), { type: 'pause' }, 1)], 2000);
      expect(h.games().get(gid(1))!.state.phase).toBe('paused');
      expect(heartbeats(h, 2000, 602_000)).toEqual([]);
      expect(h.step([], 602_001).ended).toEqual([gid(1)]);
    });

    it('any command but a heartbeat counts as a player action, even a rejected one', () => {
      const h = started([gid(1)]);
      expect(heartbeats(h, 0, 540_000)).toEqual([]);
      h.step([cmd(gid(1), { type: 'resume' })], 550_000); // rejected (not paused), still the player acting
      expect(heartbeats(h, 550_000, 1_140_000)).toEqual([]);
      expect(h.step([], 1_150_001).ended).toEqual([gid(1)]);
    });

    it('both limits are host options', () => {
      const h = started([gid(1), gid(2)], { idleHandoverMs: 1000, idleRunningMs: 5000, paced: false });
      h.step([cmd(gid(2), { type: 'startShift', mode: 'auto' })], 0);
      expect(h.step([], 1001).ended).toEqual([gid(1)]);
      expect(h.step([], 5000).ended).toEqual([]);
      expect(h.step([], 5001).ended).toEqual([gid(2)]);
    });

    it('a shift that ends on its own starts a fresh handover clock (a passive player is not dropped at shift end)', () => {
      const h = started([gid(1)], { idleHandoverMs: 1000, idleRunningMs: 5000, paced: false });
      h.step([cmd(gid(1), { type: 'startShift', mode: 'auto' })], 0);
      let t = 0;
      while (h.games().get(gid(1))!.state.phase === 'running') {
        t += 5;
        expect(h.step([], t).ended).toEqual([]);
      }
      expect(h.games().get(gid(1))!.state.phase).toBe('handover');
      expect(t).toBeGreaterThan(1000); // the shift outlasted the handover limit
      expect(h.step([], t + 1000).ended).toEqual([]);
      expect(h.step([], t + 1001).ended).toEqual([gid(1)]);
    });

    it('a restored game counts its player-action clock from the restore', () => {
      const s = started([gid(1)]).games().get(gid(1))!.state;
      const h = new GameHost();
      h.restore([s], 10_000_000);
      expect(heartbeats(h, 10_000_000, 10_600_000)).toEqual([]);
      expect(h.step([], 10_600_001).ended).toEqual([gid(1)]);
    });
  });

  it('quitGame ends the game with one gameEnd and removes it', () => {
    const h = started([gid(1)]);
    const r = h.step([cmd(gid(1), { type: 'quitGame' })], 1000);
    expect(r.ended).toEqual([gid(1)]);
    expect(types(r.perGame.get(gid(1))!.events)).toEqual(['gameEnd']);
    expect(h.games().size).toBe(0);
  });

  it('quitGame emits a gameEnd with the run mode', () => {
    const h = new GameHost();
    h.step([cmd(gid(1), { type: 'startGame', mode: 'hard' })], 0);
    const r = h.step([cmd(gid(1), { type: 'quitGame' })], 1000);
    expect(r.perGame.get(gid(1))!.events.at(-1)).toMatchObject({ type: 'gameEnd', mode: 'hard' });
  });

  it('a throwing game ends with reason error; the others continue', () => {
    const h = started([gid(1), gid(2)]);
    h.step(
      [gid(1), gid(2)].map((g) => cmd(g, { type: 'startShift', mode: 'auto' })),
      1000,
    );
    const good = h.games().get(gid(2))!.state;
    const bad = { ...h.games().get(gid(1))!.state, stages: [] } as PlantState;
    const h2 = new GameHost();
    h2.restore([bad, good], 1000);
    const r = h2.step([], 2000);
    expect(r.ended).toEqual([gid(1)]);
    const evs = r.perGame.get(gid(1))!.events;
    expect(evs.filter((e) => e.type === 'gameEnd')).toHaveLength(1);
    expect(evs.find((e) => e.type === 'gameEnd')).toMatchObject({ reason: 'error' });
    expect(types(r.perGame.get(gid(2))!.events)).not.toContain('gameEnd');
    expect(h2.games().get(gid(2))!.state.tick).toBe(good.tick + 1);
  });

  it('a state that breaks tick and toStatus still ends only that game, with a gameEnd and the error message', () => {
    const h = started([gid(1), gid(2)]);
    h.step(
      [gid(1), gid(2)].map((g) => cmd(g, { type: 'startShift', mode: 'auto' })),
      1000,
    );
    const good = h.games().get(gid(2))!.state;
    const bad = { ...h.games().get(gid(1))!.state, fuel: undefined } as unknown as PlantState;
    const h2 = new GameHost();
    h2.restore([bad, good], 1000);
    const r = h2.step([], 2000);
    expect(r.ended).toEqual([gid(1)]);
    const out = r.perGame.get(gid(1))!;
    expect(out.status).toBeNull();
    expect(out.snapshotDue).toBe(false);
    expect(out.events.filter((e) => e.type === 'gameEnd')).toMatchObject([{ reason: 'error' }]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ gameId: gid(1) });
    expect(r.errors[0]!.message.length).toBeGreaterThan(0);
    expect(r.perGame.get(gid(2))!.status).not.toBeNull();
    expect(h2.games().has(gid(1))).toBe(false);
  });

  it('an abandoned game whose status cannot be rendered still ends with a gameEnd', () => {
    const h = started([gid(1)]);
    const bad = { ...h.games().get(gid(1))!.state, fuel: undefined } as unknown as PlantState;
    const h2 = new GameHost();
    h2.restore([bad], 0);
    const r = h2.step([], 90_001);
    expect(r.ended).toEqual([gid(1)]);
    expect(r.perGame.get(gid(1))!.events).toMatchObject([{ type: 'gameEnd', reason: 'abandoned' }]);
    expect(r.perGame.get(gid(1))!.snapshotDue).toBe(false);
    expect(r.errors).toEqual([]);
  });

  it('restore then step continues the restored games', () => {
    const h = started([gid(1)]);
    h.step([cmd(gid(1), { type: 'startShift', mode: 'auto' })], 1000);
    const s = h.games().get(gid(1))!.state;
    const h2 = new GameHost();
    h2.restore([s], 5000);
    const r = h2.step([], 6000);
    expect(r.perGame.get(gid(1))!.status).toBeDefined();
    expect(h2.games().get(gid(1))!.state.tick).toBe(s.tick + 1);
  });

  it('restore increments the run epoch; records stamped after it carry the new epoch', () => {
    const h = started([gid(1)]);
    const created = h.games().get(gid(1))!.state;
    expect(created.run.epoch).toBe(0);
    const h2 = new GameHost();
    h2.restore([created], 5000);
    expect(h2.games().get(gid(1))!.state.run.epoch).toBe(1);
    const r = h2.step([cmd(gid(1), { type: 'startShift', mode: 'auto' })], 6000);
    const out = r.perGame.get(gid(1))!;
    expect(out.events.map((e) => [e.type, e.epoch, e.seq])).toEqual([
      ['shiftStart', 1, 1],
      ['accountChange', 1, 2],
    ]);
    expect(out.status!.epoch).toBe(1);
    expect(out.telemetry.every((t) => t.epoch === 1)).toBe(true);
    // Restored again (a second crash): the epoch keeps counting.
    const h3 = new GameHost();
    h3.restore([h2.games().get(gid(1))!.state], 7000);
    expect(h3.games().get(gid(1))!.state.run.epoch).toBe(2);
  });

  it('new-game seeds are reproducible from the host seed and differ between games', () => {
    const a = started([gid(1), gid(2)], { seed: 7 });
    const b = started([gid(1), gid(2)], { seed: 7 });
    expect(a.games().get(gid(1))!.state.seed).toBe(b.games().get(gid(1))!.state.seed);
    expect(a.games().get(gid(1))!.state.seed).not.toBe(a.games().get(gid(2))!.state.seed);
  });

  it('flags snapshotDue on the step a game is created, so a crash before any shift still finds it', () => {
    const h = new GameHost();
    const r = h.step([cmd(gid(1), { type: 'startGame' })], 1000);
    expect(r.perGame.get(gid(1))!.snapshotDue).toBe(true);
    expect(h.step([], 2000).perGame.get(gid(1))!.snapshotDue).toBe(false);
  });
});

describe('GameHost pace (3 ticks/s calm, 1 tick/s busy)', () => {
  /** Host steps at k * CALM_TICK_MS, k = 0..8. */
  const STEPS = Array.from({ length: 9 }, (_, k) => k);
  const at = (k: number) => (k * 1000) / 3;

  /** A running game (one tick into shift 1) with no events planned, so nothing fires on its own. */
  function runningState(id: string): PlantState {
    const h = new GameHost({ paced: false });
    h.step([cmd(id, { type: 'startGame' })], 0);
    h.step([cmd(id, { type: 'startShift', mode: 'auto' })], 0);
    const s = h.games().get(id)!.state;
    expect(s.phase).toBe('running');
    return { ...s, chaos: { ...s.chaos, active: { ...s.chaos.active!, plan: { ...s.chaos.active!.plan, queue: [] }, fired: [] } } };
  }

  const fired = (kind: FiredEvent['kind']): FiredEvent => ({
    eventId: 1,
    kind,
    params: {},
    atMinute: 0,
    cleared: false,
    how: null,
    disaster: false,
  });
  /** pumpBearing never clears on its own (it is informational; forced open here): busy for the whole test. */
  const busyState = (id: string): PlantState => {
    const s = runningState(id);
    return { ...s, chaos: { ...s.chaos, active: { ...s.chaos.active!, fired: [fired('pumpBearing')] } } };
  };

  /** Restore `states` at 0 into a paced host and run the steps; returns the k's at which each game ticked. */
  function run(states: PlantState[], perStep: (k: number) => unknown[] = () => [], opts = {}) {
    const h = new GameHost(opts);
    h.restore(states, 0);
    const ticked = new Map<string, number[]>(states.map((s) => [s.run.gameId, []]));
    const outs: HostTick[] = [];
    for (const k of STEPS) {
      const before = new Map([...h.games()].map(([id, e]) => [id, e.state]));
      const r = h.step(perStep(k), at(k));
      outs.push(r);
      for (const [id, ks] of ticked) {
        if (r.perGame.has(id)) ks.push(k);
        // A game skipped this step emits nothing and is not ticked (its state is the very same object).
        else if (h.games().has(id)) expect(h.games().get(id)!.state, `${id} at k=${k}`).toBe(before.get(id));
      }
    }
    return { h, ticked, outs };
  }

  it('a calm running game ticks every step; a busy one on k = 0, 3, 6 only and is absent from perGame otherwise', () => {
    const calm = runningState(gid(1));
    const busy = busyState(gid(2));
    expect(paceOf(calm)).toBe('calm');
    expect(paceOf(busy)).toBe('busy');
    const { h, ticked, outs } = run([calm, busy]);
    expect(ticked.get(gid(1))).toEqual(STEPS);
    expect(ticked.get(gid(2))).toEqual([0, 3, 6]);
    expect(h.games().get(gid(1))!.state.tick).toBe(calm.tick + 9);
    expect(h.games().get(gid(2))!.state.tick).toBe(busy.tick + 3);
    expect(STEPS.filter((k) => outs[k]!.perGame.has(gid(2)))).toEqual([0, 3, 6]);
    // The status says which pace the game is at.
    expect(outs[0]!.perGame.get(gid(1))!.status!.pace).toBe('calm');
    expect(outs[0]!.perGame.get(gid(2))!.status!.pace).toBe('busy');
  });

  it('a command sent to a busy game between its ticks is applied exactly once, on its next due tick', () => {
    const busy = busyState(gid(2));
    const sp0 = busy.loops.tbt.setpoint;
    const { h, outs } = run([busy], (k) =>
      k === 1
        ? [
            cmd(gid(2), { type: 'setSetpoint', loop: 'tbt', value: 100 }, 1),
            cmd(gid(2), { type: 'setSetpoint', loop: 'tbt', value: 999 }, 1), // rejected: shows when it is applied
            cmd(gid(9), { type: 'pause' }), // no such game: a host event, out at once
          ]
        : [],
    );
    expect(sp0).not.toBe(100);
    expect(outs[1]!.hostEvents).toEqual([expect.objectContaining({ type: 'commandRejected', reason: 'no such game', gameId: gid(9) })]);
    expect(outs[1]!.perGame.has(gid(2))).toBe(false);
    expect(outs[2]!.perGame.has(gid(2))).toBe(false);
    const rejections = outs.map((r) => (r.perGame.get(gid(2))?.events ?? []).filter((e) => e.type === 'commandRejected').length);
    expect(rejections).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 0]);
    expect(outs[3]!.perGame.get(gid(2))!.status!.loops.tbt!.setpoint).toBe(100);
    expect(h.games().get(gid(2))!.state.loops.tbt.setpoint).toBe(100);
  });

  it('a game that goes calm on a tick ticks again on the very next step', () => {
    // An open tube leak whose fault is already gone: the director clears it on the first tick.
    const s = runningState(gid(3));
    const leaking = { ...s, chaos: { ...s.chaos, active: { ...s.chaos.active!, fired: [fired('tubeLeak')] } } };
    expect(isBusy(leaking)).toBe(true);
    const { h, ticked, outs } = run([leaking]);
    expect(outs[0]!.perGame.get(gid(3))!.status!.pace).toBe('calm');
    expect(isBusy(h.games().get(gid(3))!.state)).toBe(false);
    expect(ticked.get(gid(3))).toEqual(STEPS);
  });

  it('a paused game keeps 1 tick/s', () => {
    const h0 = new GameHost({ paced: false });
    h0.restore([runningState(gid(4))], 0);
    h0.step([cmd(gid(4), { type: 'pause' }, 1)], 0);
    const paused = h0.games().get(gid(4))!.state;
    expect(paused.phase).toBe('paused');
    expect(run([paused]).ticked.get(gid(4))).toEqual([0, 3, 6]);
  });

  it('a handover game keeps 1 tick/s', () => {
    const h0 = new GameHost({ paced: false });
    h0.step([cmd(gid(5), { type: 'startGame' })], 0);
    expect(run([h0.games().get(gid(5))!.state]).ticked.get(gid(5))).toEqual([0, 3, 6]);
  });

  it('the idle check abandons a game that is not due, on time', () => {
    const { outs } = run([busyState(gid(6))], () => [], { idleMs: 500 });
    expect(outs[1]!.ended).toEqual([]);
    expect(outs[2]!.ended).toEqual([gid(6)]); // 666 ms > 500 ms, before its next tick (1000 ms) is due
    expect(outs[2]!.perGame.get(gid(6))!.events.at(-1)).toMatchObject({ type: 'gameEnd', reason: 'abandoned' });
  });

  it('a new game is due at once (gameStart and its first save come out on the creation step)', () => {
    const h = new GameHost();
    h.step([], 0);
    const r = h.step([cmd(gid(7), { type: 'startGame' })], 100);
    expect(types(r.perGame.get(gid(7))!.events)).toEqual(['gameStart']);
    expect(r.perGame.get(gid(7))!.snapshotDue).toBe(true);
  });

  it('unpaced, every step ticks every game', () => {
    const { ticked } = run([busyState(gid(8))], () => [], { paced: false });
    expect(ticked.get(gid(8))).toEqual(STEPS);
  });
});
