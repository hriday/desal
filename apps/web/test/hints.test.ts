import { ScenarioKindSchema, type PlantEvent, type PlantStatus } from '@desal/schema';
import { FIX } from '../src/expanded/labels';
import { dueHints, HINT_DELAY_MIN } from '../src/state/hints';

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
    ballCleaning: false, divertToDrain: false, divertMode: 'auto', standbySteam: false, shiftTicksRemaining: 100, deliveries: [],
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
