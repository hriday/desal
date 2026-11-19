import { describe, expect, it } from 'vitest';
import { GameHost } from '../src/host.js';
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

  it('quitGame ends the game with one gameEnd and removes it', () => {
    const h = started([gid(1)]);
    const r = h.step([cmd(gid(1), { type: 'quitGame' })], 1000);
    expect(r.ended).toEqual([gid(1)]);
    expect(types(r.perGame.get(gid(1))!.events)).toEqual(['gameEnd']);
    expect(h.games().size).toBe(0);
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
