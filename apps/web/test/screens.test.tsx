import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { GameEndReasonSchema, type PlantEvent } from '@desal/schema';
import { Screens } from '../src/App';
import { demoReadings, demoStatus } from '../src/demo';
import { nextTargetEstimateM3 } from '../src/limits';
import { GAME_ID_KEY } from '../src/net/socket';
import { GameOver, REASON_TEXT } from '../src/screens/GameOver';
import { Handover } from '../src/screens/Handover';
import { Start } from '../src/screens/Start';
import { TopBar } from '../src/screens/TopBar';
import { FIX } from '../src/expanded/labels';
import { GameProvider, RANK_WAIT_MS, REPORT_WAIT_MS } from '../src/state/GameProvider';
import { board, report } from './fixtures';

afterEach(cleanup);

const shiftEnd = {
  seq: 1, type: 'shiftEnd',
  summary: {
    productM3: 3600, targetM3: 3900, offSpecMinutes: 12, offSpecM3: 80, fuelCostUsd: 5000, fuelBudgetUsd: 12000, trips: 2,
    spentUsd: 7000, nextAllocationUsd: 9000, balanceUsd: 12450,
    damage: { maxHardScaleMm: 0.8, pumpWear: { 'P-101': 0.1, 'P-102': 0.2, 'P-103': 0.3 }, burnerCondition: 0.9 },
    hell: false, events: [],
  },
} as unknown as PlantEvent;

describe('Start', () => {
  // The leaderboard card's default loader: never answers (its own tests cover it).
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))); });
  afterEach(() => vi.unstubAllGlobals());
  it('shows the title, the pitch and starts a run', () => {
    const onStart = vi.fn();
    const { getByText, getByRole } = render(<Start onStart={onStart} />);
    expect(getByRole('heading', { level: 1, name: 'Desal Operator' })).toBeTruthy();
    expect(getByText('You run a thermal desalination plant.')).toBeTruthy();
    expect(getByText(/Deliver the water, shift after shift — until the money, the fuel or the plant gives out\./)).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'Start a run' }));
    expect(onStart).toHaveBeenCalledWith('normal');
  });
  it('offers a Hard run with its line, and no disaster cheat sheet', () => {
    const onStart = vi.fn();
    const { getByRole, queryByText } = render(<Start onStart={onStart} />);
    const hard = getByRole('button', { name: 'Start a Hard run' });
    expect(hard.parentElement!.nextElementSibling!.textContent).toBe('Every shift is a bad one, and disasters strike.');
    fireEvent.click(hard);
    expect(onStart).toHaveBeenCalledWith('hard');
    expect(queryByText('When disaster strikes')).toBeNull();
  });
  it('the plant picture shows all 24 flash stages', () => {
    const { container } = render(<Start onStart={vi.fn()} />);
    expect(container.querySelectorAll('.start__plant [data-stage]')).toHaveLength(24);
  });
  it('shows the leaderboard card under the Start buttons', async () => {
    const { getByRole } = render(<Start onStart={vi.fn()} loadLeaderboard={() => Promise.resolve(board())} />);
    await act(async () => { await Promise.resolve(); });
    const card = getByRole('region', { name: 'Leaderboard' });
    expect(card.textContent).toContain('Kestrel-42 · 19 Nov');
    expect(getByRole('button', { name: 'Start a Hard run' }).compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('capacity shows the message and a retry button', () => {
    const onStart = vi.fn();
    const { getByRole, getByText } = render(<Start onStart={onStart} capacityMessage="The plant is at capacity, try again in a minute" />);
    expect(getByText(/at capacity/)).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'Try again' }));
    expect(onStart).toHaveBeenCalled();
  });
});

describe('Handover', () => {
  const base = { readings: demoReadings(), onStartShift: vi.fn(), onQuit: vi.fn() };
  it('shows the last shift, condition and the estimated target before the shift starts', () => {
    const status = demoStatus({ phase: 'handover', shiftNumber: 1, shiftTarget: null });
    const { container, getByRole } = render(<Handover {...base} status={status} events={[shiftEnd]} />);
    const t = container.textContent!;
    expect(t).toContain('3,600 / 3,900 m³');
    expect(t).toContain('80 m³');
    expect(t).toContain('$7,000');
    expect(t).toContain('$9,000');
    expect(t).toContain('0.80 mm');
    expect(t).toContain('128 t');
    expect(t).toContain(`≈ ${nextTargetEstimateM3(2).toLocaleString('en-US')} m³`);
    expect(getByRole('button', { name: 'Start shift 2' })).toBeTruthy();
  });
  it('shows the pending orders: target, limit, budget, supervisor notes and the shift 1 briefing', () => {
    const orders = {
      targetM3: 4100, maxSalinityPpm: 22, budgetUsd: 13000,
      lines: ['Watch the vacuum pump.', 'Gas is dear today.'],
      briefing: ['Welcome to the plant.', 'Keep the product in spec.', 'Send the crew when a fault stays.'],
    };
    const status = demoStatus({ phase: 'handover', shiftNumber: 0, shiftTarget: null, orders });
    const { container, getByRole } = render(<Handover {...base} status={status} events={[]} />);
    const t = container.textContent!;
    expect(t).toContain('4,100 m³');
    expect(t).toContain('22 ppm');
    expect(t).toContain('$13,000');
    // The orders' budget is fuel guidance, not the allocation the account is credited.
    expect(getByRole('region', { name: 'Orders for shift 1' }).querySelector('dl')?.textContent).toContain('Fuel budget$13,000');
    expect(t).not.toContain('≈');
    const notes = getByRole('list', { name: "Supervisor's notes" });
    expect(notes.querySelectorAll('li')).toHaveLength(2);
    expect(notes.textContent).toContain('Watch the vacuum pump.');
    const brief = getByRole('list', { name: 'Briefing' });
    expect(brief.querySelectorAll('li')).toHaveLength(3);
  });
  it('lists the last shift events with a HELL SHIFT tag', () => {
    const s = (shiftEnd as unknown as { summary: object }).summary;
    const ev = { ...shiftEnd, summary: { ...s, hell: true, events: [
      { eventId: 1, kind: 'pumpTrip', atMinute: 130.7, cleared: true, how: 'player' },
      { eventId: 2, kind: 'tubeLeak', atMinute: 340, cleared: true, how: 'crew' },
      { eventId: 3, kind: 'gasPriceSpike', atMinute: 10, cleared: true, how: 'noted' },
      { eventId: 4, kind: 'vacuumLoss', atMinute: 400, cleared: false, how: null },
      { eventId: 5, kind: 'storm', atMinute: 60, cleared: true, how: 'expired' },
    ] } } as unknown as PlantEvent;
    const { container } = render(<Handover {...base} status={demoStatus({ phase: 'handover', shiftNumber: 1, shiftTarget: null })} events={[ev]} />);
    const t = container.textContent!;
    expect(t).toContain('HELL SHIFT');
    expect(t).toContain('02:10 Pump trip — cleared by you');
    expect(t).toContain('05:40 Tube leak — fixed by crew');
    expect(t).toContain('Gas price spike — noted');
    expect(t).not.toContain('00:10 Gas price spike');
    expect(t).toContain('06:40 Vacuum loss — not cleared');
    expect(t).toContain('01:00 Storm — passed');
  });
  describe('what to do', () => {
    const withEvents = (events: object[]) => {
      const s = (shiftEnd as unknown as { summary: object }).summary;
      return { ...shiftEnd, summary: { ...s, events } } as unknown as PlantEvent;
    };
    const evs = [
      { eventId: 1, kind: 'tubeLeak', atMinute: 340, cleared: false, how: null },
      { eventId: 2, kind: 'pumpTrip', atMinute: 130, cleared: true, how: 'player' },
      { eventId: 3, kind: 'earthquake', atMinute: 20, cleared: true, how: 'noted' },
      { eventId: 4, kind: 'martianInvasion', atMinute: 30, cleared: false, how: null },
    ];
    for (const mode of ['normal', 'hard'] as const) {
      it(`shows the fix under the uncleared event only (${mode})`, () => {
        const status = demoStatus({ phase: 'handover', shiftNumber: 1, shiftTarget: null, mode });
        const { container } = render(<Handover {...base} status={status} events={[withEvents(evs)]} />);
        const lis = container.querySelectorAll('[aria-label="Shift events"] li');
        expect(lis).toHaveLength(4);
        expect(lis[0]!.textContent).toContain(`What to do: ${FIX.tubeLeak.text}`);
        expect(container.textContent!.match(/What to do:/g)).toHaveLength(1);
      });
    }
  });
  describe('report card', () => {
    const withEvents = (events: object[]) => {
      const s = (shiftEnd as unknown as { summary: object }).summary;
      return { ...shiftEnd, shiftId: 2, summary: { ...s, events } } as unknown as PlantEvent;
    };
    const evs = [
      { eventId: 3, kind: 'vacuumLoss', atMinute: 300, cleared: true, how: 'crew' },
      { eventId: 4, kind: 'storm', atMinute: 400, cleared: false, how: null },
    ];
    const status = demoStatus({ phase: 'handover', shiftNumber: 2, shiftId: null, shiftTarget: null });
    it("shows the previous shift's report card above Last shift", () => {
      const { getByRole } = render(<Handover {...base} status={status} events={[withEvents(evs)]}
        reports={{ 1: report({ shiftId: 1, grade: 'D' }), 2: report({ grade: 'B' }) }} reportWait="waiting" />);
      const card = getByRole('region', { name: 'Report card' });
      expect(card.querySelector('[data-grade]')!.textContent).toBe('B');
      expect(card.compareDocumentPosition(getByRole('region', { name: 'Last shift' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
    it('with a report card, Last shift does not repeat the What to do lines', () => {
      const { getByRole } = render(<Handover {...base} status={status} events={[withEvents(evs)]} reports={{ 2: report() }} reportWait="waiting" />);
      expect(getByRole('region', { name: 'Last shift' }).textContent).not.toContain('What to do');
      expect(getByRole('region', { name: 'Report card' }).textContent).toContain(`What to do: ${FIX.storm.text}`);
    });
    it("keeps a Last shift fix the card does not show (verdict ok, or not in the report)", () => {
      const more = [...evs,
        { eventId: 2, kind: 'tubeLeak', atMinute: 200, cleared: false, how: null }, // in the report as 'ok'
        { eventId: 7, kind: 'bloom', atMinute: 20, cleared: false, how: null }, // not in the report
      ];
      const { getByRole } = render(<Handover {...base} status={status} events={[withEvents(more)]} reports={{ 2: report() }} reportWait="waiting" />);
      const last = getByRole('region', { name: 'Last shift' }).textContent!;
      expect(last).toContain(`What to do: ${FIX.tubeLeak.text}`);
      expect(last).toContain(`What to do: ${FIX.bloom.text}`);
      expect(last).not.toContain(FIX.storm.text); // the card shows it under 'missed'
      expect(last.match(/What to do:/g)).toHaveLength(2);
    });
    it('without one (Flink down, after the 10 s wait) Last shift shows them as before', () => {
      for (const reportWait of ['waiting', 'expired'] as const) {
        const { getByRole, container, unmount } = render(<Handover {...base} status={status} events={[withEvents(evs)]} reports={{}} reportWait={reportWait} />);
        expect(getByRole('region', { name: 'Last shift' }).textContent).toContain(`What to do: ${FIX.storm.text}`);
        expect(container.textContent!.includes('Grading…')).toBe(reportWait === 'waiting');
        unmount();
      }
    });
    it('shows the call sign on the sheet', () => {
      const { getByRole } = render(<Handover {...base} status={status} events={[]} />);
      expect(getByRole('article', { name: 'Shift 3 handover' }).textContent).toContain('Kestrel-42');
    });
  });
  it('shows no HELL SHIFT tag on a normal shift', () => {
    const { container } = render(<Handover {...base} status={demoStatus({ phase: 'handover', shiftNumber: 1, shiftTarget: null })} events={[shiftEnd]} />);
    expect(container.textContent).not.toContain('HELL SHIFT');
  });
  it('before the first shift (shiftNumber 0) offers shift 1 at about 3,900 m³; after shift 2 offers shift 3', () => {
    const first = render(<Handover {...base} status={demoStatus({ phase: 'handover', shiftNumber: 0, shiftTarget: null })} events={[]} />);
    expect(first.getByRole('button', { name: 'Start shift 1' })).toBeTruthy();
    // The whole handover is one shift-log sheet: orders, condition, mode and the Start button.
    const sheet = first.getByRole('article', { name: 'Shift 1 handover' });
    for (const name of ['Plant condition', 'Orders for shift 1']) expect(sheet.contains(first.getByRole('region', { name }))).toBe(true);
    expect(sheet.contains(first.getByRole('group', { name: 'Control mode' }))).toBe(true);
    expect(sheet.contains(first.getByRole('button', { name: 'Start shift 1' }))).toBe(true);
    expect(first.container.textContent).toContain('≈ 3,900 m³');
    cleanup();
    const third = render(<Handover {...base} status={demoStatus({ phase: 'handover', shiftNumber: 2, shiftTarget: null })} events={[]} />);
    expect(third.getByRole('button', { name: 'Start shift 3' })).toBeTruthy();
    expect(third.container.textContent).toContain(`≈ ${nextTargetEstimateM3(3).toLocaleString('en-US')} m³`);
  });
  it('shows the run mode, Normal or Hard', () => {
    for (const [mode, text] of [['normal', 'Normal'], ['hard', 'Hard']] as const) {
      const status = demoStatus({ phase: 'handover', shiftNumber: 1, shiftTarget: null, mode });
      const { getByText, unmount } = render(<Handover {...base} status={status} events={[]} />);
      expect(getByText('Mode').nextElementSibling!.textContent).toBe(text);
      unmount();
    }
  });
  it('sends the chosen mode, and quit', () => {
    const onStartShift = vi.fn();
    const onQuit = vi.fn();
    const status = demoStatus({ phase: 'handover', shiftNumber: 0, shiftTarget: null });
    const { getByRole, getByLabelText } = render(<Handover {...base} onStartShift={onStartShift} onQuit={onQuit} status={status} events={[]} />);
    fireEvent.click(getByLabelText(/Manual/));
    fireEvent.click(getByRole('button', { name: 'Start shift 1' }));
    expect(onStartShift).toHaveBeenCalledWith('manual');
    fireEvent.click(getByRole('button', { name: 'Quit run' }));
    expect(onQuit).toHaveBeenCalled();
  });
});

describe('GameOver', () => {
  it('has a sentence for every reason', () => {
    for (const r of GameEndReasonSchema.options) expect(REASON_TEXT[r].length).toBeGreaterThan(3);
  });
  it('shows water first, then shifts and balance; Play again clears the stored game', () => {
    sessionStorage.setItem(GAME_ID_KEY, 'abc');
    const onPlayAgain = vi.fn();
    const { container, getByRole } = render(
      <GameOver reason="bankrupt" score={{ totalProductM3: 18250, shiftsCompleted: 5, balanceUsd: 400 }} onPlayAgain={onPlayAgain} />,
    );
    expect(getByRole('article', { name: 'Final report' }).contains(getByRole('heading', { level: 1, name: 'Final report' }))).toBe(true);
    const t = container.textContent!;
    expect(t).toContain('The budget ran out');
    expect(t.indexOf('18,250')).toBeLessThan(t.indexOf('Shifts completed'));
    expect(t).toContain('$400');
    fireEvent.click(getByRole('button', { name: 'Play again' }));
    expect(sessionStorage.getItem(GAME_ID_KEY)).toBeNull();
    expect(onPlayAgain).toHaveBeenCalled();
  });
});

describe('TopBar HARD tag', () => {
  it('shows HARD only in hard mode', () => {
    const props = { conn: 'open' as const, quitting: false, onQuit: vi.fn() };
    const hard = render(<TopBar status={demoStatus({ mode: 'hard' })} {...props} />);
    expect(hard.queryByText('HARD')).not.toBeNull();
    cleanup();
    const normal = render(<TopBar status={demoStatus({ mode: 'normal' })} {...props} />);
    expect(normal.queryByText('HARD')).toBeNull();
  });
});

describe('TopBar call sign', () => {
  it('shows the call sign', () => {
    const { container } = render(<TopBar status={demoStatus({ callSign: 'Heron-17' })} conn="open" quitting={false} onQuit={vi.fn()} />);
    expect(container.textContent).toContain('Heron-17');
  });
});

describe('GameOver call sign and rank', () => {
  const props = { reason: 'quit' as const, score: null, onPlayAgain: vi.fn(), callSign: 'Kestrel-42' };
  it('shows the call sign and the rank', () => {
    const { container } = render(<GameOver {...props} rank={{ allTime: 57, today: 3 }} />);
    expect(container.textContent).toContain('Kestrel-42');
    expect(container.textContent).toContain('Rank #57 all time · #3 today');
    expect(container.textContent).not.toContain('Hard');
  });
  it("labels a Hard run's rank with its mode", () => {
    const { getByText } = render(<GameOver {...props} mode="hard" rank={{ allTime: 57, today: 3 }} />);
    expect(getByText(/Rank #57 all time · #3 today/).textContent).toContain('Hard');
  });
  it('shows only the all-time rank when the run is not ranked today', () => {
    const { container } = render(<GameOver {...props} rank={{ allTime: 57, today: null }} />);
    expect(container.textContent).toContain('Rank #57 all time');
    expect(container.textContent).not.toContain('today');
  });
  it('shows "Ranking…" until the rank comes', () => {
    const { container } = render(<GameOver {...props} rank={null} />);
    expect(container.textContent).toContain('Ranking…');
  });
  it('leaves the rank out once the wait has expired, and shows a rank that comes later', () => {
    const r = render(<GameOver {...props} rank={null} rankWait="expired" />);
    expect(r.container.textContent).not.toContain('Ranking');
    expect(r.container.textContent).not.toContain('Rank');
    expect(r.container.querySelector('.sheet__rank')).toBeNull();
    r.rerender(<GameOver {...props} rank={{ allTime: 57, today: 3 }} rankWait="expired" />);
    expect(r.container.textContent).toContain('Rank #57 all time · #3 today');
  });
});

describe('GameOver mode', () => {
  it.each([['hard', 'Hard'], ['normal', 'Normal']] as const)('shows %s', (mode, text) => {
    const { getByText } = render(<GameOver reason="quit" mode={mode} score={null} onPlayAgain={vi.fn()} />);
    expect(getByText(text)).toBeTruthy();
  });
});

describe('Screens with provider', () => {
  const socks: FakeWS[] = [];
  class FakeWS {
    readyState = 0; sent: string[] = [];
    onopen: (() => void) | null = null; onmessage: unknown; onclose: unknown; onerror: unknown;
    closed = false;
    send(m: string) { this.sent.push(m); }
    close() { this.closed = true; }
    constructor() { socks.push(this); }
    open() { this.readyState = 1; act(() => this.onopen?.()); }
  }
  beforeEach(() => {
    socks.length = 0;
    sessionStorage.clear();
    // The Start screen's leaderboard card: never answers (the card's own tests cover it).
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  });
  afterEach(() => vi.unstubAllGlobals());
  const mount = () => render(
    <GameProvider url="ws://x" factory={() => new FakeWS() as unknown as WebSocket}><Screens /></GameProvider>,
  );

  it('the Start screen holds no socket (and shows no connection overlay); Start opens one and sends newGame', () => {
    const { getByRole, queryByRole, container } = mount();
    expect(container.querySelector('[data-screen="start"]')).not.toBeNull();
    expect(socks).toHaveLength(0);
    expect(queryByRole('alert')).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Start a run' }));
    expect(socks).toHaveLength(1);
    expect(getByRole('button', { name: 'Starting…' })).toBeTruthy();
    socks[0]!.open();
    expect(socks[0]!.sent.map((m) => JSON.parse(m).t)).toEqual(['newGame']);
    expect(container.querySelector('[data-screen="start"]')).not.toBeNull(); // still waiting for the plant
  });

  it('Start a Hard run sends newGame with mode hard on the next open', () => {
    const { getByRole } = mount();
    fireEvent.click(getByRole('button', { name: 'Start a Hard run' }));
    socks[0]!.open();
    expect(JSON.parse(socks[0]!.sent[0]!)).toMatchObject({ t: 'newGame', mode: 'hard' });
  });

  it('a stored game opens the socket at once, to resume', () => {
    sessionStorage.setItem(GAME_ID_KEY, '11111111-1111-4111-8111-111111111111');
    mount();
    expect(socks).toHaveLength(1);
    socks[0]!.open();
    expect(socks[0]!.sent.map((m) => JSON.parse(m).t)).toEqual(['resume']);
  });

  it('closes the socket when the session returns to Start', () => {
    sessionStorage.setItem(GAME_ID_KEY, '11111111-1111-4111-8111-111111111111');
    const { container } = mount();
    socks[0]!.open();
    act(() => (socks[0]!.onmessage as (e: { data: string }) => void)({ data: JSON.stringify({ t: 'error', reason: 'no game' }) }));
    expect(container.querySelector('[data-screen="start"]')).not.toBeNull();
    expect(socks[0]!.closed).toBe(true);
  });

  describe('the handover report card', () => {
    afterEach(() => vi.useRealTimers());
    const push = (msg: object) => act(() => (socks[0]!.onmessage as (e: { data: string }) => void)({ data: JSON.stringify(msg) }));
    const handover = () => {
      vi.useFakeTimers();
      sessionStorage.setItem(GAME_ID_KEY, '11111111-1111-4111-8111-111111111111');
      const r = mount();
      socks[0]!.open();
      const status = demoStatus({ phase: 'handover', shiftNumber: 2, shiftId: null, shiftTarget: null });
      push({ t: 'status', status });
      const s = (shiftEnd as unknown as { summary: object }).summary;
      push({ t: 'event', event: { ...shiftEnd, gameId: status.gameId, epoch: 0, tick: 1440, plantTime: 1, shiftId: 2,
        summary: { ...s, events: [{ eventId: 4, kind: 'storm', atMinute: 400, cleared: false, how: null }] } } });
      return { ...r, status };
    };

    it('shows "Grading…" after a shiftEnd and gives up after 10 s, leaving the debrief and its fixes', () => {
      const { container, getByRole } = handover();
      expect(container.textContent).toContain('Grading…');
      act(() => { vi.advanceTimersByTime(REPORT_WAIT_MS - 1); });
      expect(container.textContent).toContain('Grading…');
      act(() => { vi.advanceTimersByTime(1); });
      expect(container.textContent).not.toContain('Grading…');
      expect(getByRole('region', { name: 'Last shift' }).textContent).toContain(`What to do: ${FIX.storm.text}`);
    });

    it('the final report says "Ranking…", leaves it out after 10 s, and shows a late rank', () => {
      const { container, status } = handover();
      push({ t: 'event', event: { type: 'gameEnd', gameId: status.gameId, epoch: 0, seq: 2, tick: 1441, plantTime: 2, shiftId: null,
        callSign: 'Kestrel-42', mode: 'normal', reason: 'quit', score: { totalProductM3: 100, shiftsCompleted: 2, balanceUsd: 5 } } });
      expect(container.querySelector('[data-screen="over"]')).not.toBeNull();
      expect(container.textContent).toContain('Ranking…');
      act(() => { vi.advanceTimersByTime(RANK_WAIT_MS - 1); });
      expect(container.textContent).toContain('Ranking…');
      act(() => { vi.advanceTimersByTime(1); });
      expect(container.textContent).not.toContain('Ranking…');
      expect(container.textContent).not.toContain('Rank #');
      push({ t: 'rank', allTime: 57, today: null });
      expect(container.textContent).toContain('Rank #57 all time');
    });

    it('a report that comes shows above Last shift, which drops its fixes', () => {
      const { getByRole } = handover();
      push({ t: 'shiftReport', report: report() });
      expect(getByRole('region', { name: 'Report card' }).querySelector('[data-grade]')!.textContent).toBe('B');
      expect(getByRole('region', { name: 'Last shift' }).textContent).not.toContain('What to do');
    });
  });
});
