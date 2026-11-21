import { ScenarioKindSchema, type PlantEvent, type PlantStatus } from '@desal/schema';
import { FIX } from '../src/expanded/labels';
import { divertHint, DIVERT_HINT_MIN, dueHints, HINT_DELAY_MIN } from '../src/state/hints';
import type { TrendPoint } from '../src/state/trends';

const gameId = '11111111-1111-4111-8111-111111111111';
const MIN = 60_000;
const T = Date.UTC(2026, 0, 1, 6, 0);

function status(over: Partial<PlantStatus> = {}): PlantStatus {
  return {
    gameId, epoch: 0, shiftNumber: 1, balanceUsd: 1000, tick: 0, plantTime: T, shiftId: 1,
    phase: 'running', mode: 'normal', pace: 'busy', status: 'online', controlMode: 'auto', tripCause: null, restartStep: null,
    loops: {} as PlantStatus['loops'], pumps: {} as PlantStatus['pumps'],
    fuel: {
      active: 'gas', changeoverTo: null, changeoverRemainingTicks: null, backupGrade: 'standard', gasCurtailmentNotice: null,
      gasPriceUsdPerGJ: 8, gasCapMW: 60, backupPriceUsdPerGJ: 14,
    },
    doses: { chlorineMgL: 1, antiscalantMgL: 2 }, shiftTarget: null,
    ballCleaning: false, divertToDrain: false, divertMode: 'auto', standbySteam: false, standbyEjectors: false, shiftTicksRemaining: 100, deliveries: [],
    acidCleanRemainingTicks: 0, restartAuto: null, offeredGrade: 'standard', shiftProductM3: 0, shiftOffSpecM3: 0, productFlowM3h: 0,
    crew: null, orders: null, hell: null, ...over,
  } as PlantStatus;
}
const fired = (kind: string, over: Record<string, unknown> = {}): PlantEvent =>
  ({ gameId, epoch: 0, seq: 1, tick: 0, plantTime: T, shiftId: 1, type: 'scenario', eventId: 1, kind, message: '', radio: '', ...over }) as PlantEvent;
const cleared = (kind: string, how = 'crew', over: Record<string, unknown> = {}): PlantEvent =>
  ({ gameId, epoch: 0, seq: 2, tick: 0, plantTime: T, shiftId: 1, type: 'eventCleared', eventId: 1, kind, how, ...over }) as PlantEvent;
const none: ReadonlySet<string> = new Set();
const at = (min: number, over: Partial<PlantStatus> = {}) => status({ plantTime: T + min * MIN, ...over });

describe('FIX', () => {
  it('has a non-empty entry for every scenario kind', () => {
    for (const kind of ScenarioKindSchema.options) expect(FIX[kind]?.text.trim().length, kind).toBeGreaterThan(0);
  });
  it('has the three disaster texts verbatim', () => {
    expect(FIX.fuelContamination.text).toBe('Switch to the other fuel, then send the crew to flush it.');
    expect(FIX.earthquake.text).toBe('Everything breaks at once; fix what hurts most first.');
    expect(FIX.tsunami.text).toBe('When the siren sounds, run on your healthiest intake pump until the surge passes, then clean the screens and run two pumps again.');
  });
  it('sends lowSteam to the standby steam line, held back while it is on', () => {
    expect(FIX.lowSteam.text).toBe('Switch on the standby steam line on the Stages screen.');
    expect(FIX.lowSteam.hint).toBe('delay');
    expect(FIX.lowSteam.underway!(status({ standbySteam: true }))).toBe(true);
    expect(FIX.lowSteam.underway!(status({ standbySteam: false }))).toBe(false);
    expect(FIX.lowSteam.delayMin).toBe(8);
  });
  it('tells a tube leak to put Divert on Auto', () => {
    expect(FIX.tubeLeak.text).toBe('Put Divert on Auto so off-spec water goes to drain, and send the crew to plug tubes.');
  });
  it('gives informational kinds no hint and the earthquake one at once', () => {
    for (const k of ['seawaterTemp', 'gasCurtailNotice', 'gasPriceSpike', 'offgradeOnly', 'deliveryDelay', 'demandChange', 'pumpBearing'] as const) {
      expect(FIX[k].hint, k).toBe('none');
    }
    expect(FIX.earthquake.hint).toBe('atOnce');
    expect(FIX.tubeLeak.hint).toBe('delay');
  });
});

describe('dueHints', () => {
  const leak = [fired('tubeLeak')];
  it('hints a tube leak once, 20 plant minutes after it fired', () => {
    expect(HINT_DELAY_MIN).toBe(20);
    expect(dueHints(leak, at(19), none)).toEqual([]);
    const due = dueHints(leak, at(20), none);
    expect(due).toEqual([{ key: '1:1:hint', eventId: 1, kind: 'tubeLeak', text: `Hint: ${FIX.tubeLeak.text}` }]);
    expect(dueHints(leak, at(21), new Set([due[0]!.key]))).toEqual([]);
  });
  it('hints lowSteam after its own 8-minute delay, well before the earliest 20.7-minute trip', () => {
    const ev = [fired('lowSteam')];
    expect(dueHints(ev, at(7.9), none)).toEqual([]);
    expect(dueHints(ev, at(8), none)).toEqual([{ key: '1:1:hint', eventId: 1, kind: 'lowSteam', text: `Hint: ${FIX.lowSteam.text}` }]);
    expect(FIX.lowSteam.delayMin!).toBeLessThan(20.7);
    expect(dueHints(ev, at(8, { standbySteam: true }), none)).toEqual([]);
  });
  it('kinds without their own delay keep HINT_DELAY_MIN', () => {
    expect(FIX.tubeLeak.delayMin).toBeUndefined();
    expect(dueHints([fired('vacuumLoss')], at(19.9), none)).toEqual([]);
  });
  it('gives no hints on Hard', () => {
    expect(dueHints(leak, at(20, { mode: 'hard' }), none)).toEqual([]);
  });
  it('gives no hints outside a running shift', () => {
    expect(dueHints(leak, at(20, { phase: 'paused' }), none)).toEqual([]);
  });
  it('waits while the fix is under way, and hints once the crew finishes with the event still open', () => {
    expect(dueHints(leak, at(20, { crew: { job: 'plugTubes', remainingTicks: 10 } }), none)).toEqual([]);
    const due = dueHints(leak, at(45), none);
    expect(due.map((h) => h.key)).toEqual(['1:1:hint']);
    expect(dueHints(leak, at(46), new Set(['1:1:hint']))).toEqual([]);
  });
  it('a different crew job does not hold a hint back', () => {
    expect(dueHints(leak, at(20, { crew: { job: 'cleanScreens', remainingTicks: 10 } }), none)).toHaveLength(1);
  });
  it('a fuel changeover or a fuel flush holds back the contaminated-fuel hint', () => {
    const ev = [fired('fuelContamination')];
    expect(dueHints(ev, at(30, { fuel: { ...status().fuel, changeoverTo: 'backup' } }), none)).toEqual([]);
    expect(dueHints(ev, at(30, { crew: { job: 'flushFuel', remainingTicks: 5 } }), none)).toEqual([]);
    expect(dueHints(ev, at(30), none)).toHaveLength(1);
  });
  it('a screen clean does not hold back the tsunami hint (the status cannot tell whether the surge has passed)', () => {
    expect(dueHints([fired('tsunami')], at(20, { crew: { job: 'cleanScreens', remainingTicks: 10 } }), none)).toHaveLength(1);
  });
  it('gives no hint for a cleared event', () => {
    expect(dueHints([...leak, cleared('tubeLeak')], at(30), none)).toEqual([]);
  });
  it('a clear from another shift with the same eventId does not count', () => {
    expect(dueHints([...leak, cleared('tubeLeak', 'crew', { shiftId: 2 })], at(30), none)).toHaveLength(1);
  });
  it('hints an earthquake at once on Normal, even though it is noted, and never on Hard', () => {
    const quake = [fired('earthquake'), cleared('earthquake', 'noted')];
    expect(dueHints(quake, at(0), none)).toEqual([{ key: '1:1:hint', eventId: 1, kind: 'earthquake', text: `Hint: ${FIX.earthquake.text}` }]);
    expect(dueHints(quake, at(0, { mode: 'hard' }), none)).toEqual([]);
  });
  it('never hints a gas price spike', () => {
    expect(dueHints([fired('gasPriceSpike')], at(120), none)).toEqual([]);
  });
  it('never hints an event from a previous shift', () => {
    expect(dueHints([fired('tubeLeak', { shiftId: 2 })], at(60, { shiftId: 3 }), none)).toEqual([]);
  });
});

describe('divertHint', () => {
  const TEXT = "Hint: Product's back in spec — put Divert back on Auto.";
  const manualDrain = (over: Partial<PlantStatus> = {}) => at(0, { divertMode: 'manual', divertToDrain: true, ...over });
  /** Salinity points one minute apart from minute `from` to `to`, every one at `v`. */
  const run = (from: number, to: number, v: number): TrendPoint[] =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ t: T + (from + i) * MIN, v }));

  it('is due once the product has been in spec for 5 plant minutes, not before', () => {
    expect(DIVERT_HINT_MIN).toBe(5);
    expect(divertHint(manualDrain(), [{ t: T, v: 10 }, { t: T + 4.9 * MIN, v: 10 }], none)).toBeNull();
    expect(divertHint(manualDrain(), [{ t: T, v: 10 }, { t: T + 5 * MIN, v: 10 }], none)).toEqual({ key: '1:divert:start', text: TEXT });
  });
  it('uses the shift target limit', () => {
    const st = manualDrain({ shiftTarget: { productM3: 1, maxSalinityPpm: 8 } as PlantStatus['shiftTarget'] });
    expect(divertHint(st, run(0, 5, 10), none)).toBeNull();
    expect(divertHint(st, run(0, 5, 7), none)).not.toBeNull();
  });
  it('is null on Hard, in Auto, with the valve to the tank, and outside running', () => {
    const pts = run(0, 6, 10);
    expect(divertHint(manualDrain({ mode: 'hard' }), pts, none)).toBeNull();
    expect(divertHint(manualDrain({ divertMode: 'auto' }), pts, none)).toBeNull();
    expect(divertHint(manualDrain({ divertToDrain: false }), pts, none)).toBeNull();
    expect(divertHint(manualDrain({ phase: 'paused' }), pts, none)).toBeNull();
  });
  it('is null with an empty or undefined trend', () => {
    expect(divertHint(manualDrain(), [], none)).toBeNull();
    expect(divertHint(manualDrain(), undefined, none)).toBeNull();
  });
  it('an off-spec point resets the stretch, so a second stretch gets a new key', () => {
    const pts = [...run(0, 3, 10), { t: T + 4 * MIN, v: 30 }, ...run(5, 9, 10)];
    expect(divertHint(manualDrain(), pts, none)).toBeNull(); // only 4 min since the spike
    const more = [...pts, ...run(10, 11, 10)];
    expect(divertHint(manualDrain(), more, none)).toEqual({ key: `1:divert:${T + 4 * MIN}`, text: TEXT });
  });
  it('keeps the same key as the trend window slides, so it is not re-pushed once hinted', () => {
    const full = run(0, 20, 10);
    const h = divertHint(manualDrain(), full, none)!;
    expect(h.key).toBe('1:divert:start');
    const slid = full.slice(7);
    const again = divertHint(manualDrain(), slid, none)!;
    expect(again.key).toBe(h.key);
    expect(divertHint(manualDrain(), slid, new Set([h.key]))).toBeNull();
  });
  it('an off-spec point then a new in-spec stretch gives a new key', () => {
    const h1 = divertHint(manualDrain(), run(0, 6, 10), none)!;
    const h2 = divertHint(manualDrain(), [...run(0, 6, 10), { t: T + 7 * MIN, v: 30 }, ...run(8, 14, 10)], new Set([h1.key]))!;
    expect(h2.key).toBe(`1:divert:${T + 7 * MIN}`);
    expect(h2.key).not.toBe(h1.key);
  });
  it('shows once per stretch: a key already hinted gives null', () => {
    const pts = run(0, 6, 10);
    const h = divertHint(manualDrain(), pts, none)!;
    expect(divertHint(manualDrain(), pts, new Set([h.key]))).toBeNull();
  });
});
