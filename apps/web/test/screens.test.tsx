import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { GameEndReasonSchema, type PlantEvent } from '@desal/schema';
import { Screens } from '../src/App';
import { demoReadings, demoStatus } from '../src/demo';
import { nextTargetEstimateM3 } from '../src/limits';
import { GAME_ID_KEY } from '../src/net/socket';
import { GameOver, REASON_TEXT } from '../src/screens/GameOver';
import { Handover } from '../src/screens/Handover';
import { Start } from '../src/screens/Start';
import { GameProvider } from '../src/state/GameProvider';

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
  it('shows the copy and starts a run', () => {
    const onStart = vi.fn();
    const { getByText, getByRole } = render(<Start onStart={onStart} />);
    expect(getByText(/You run a seawater desalination plant/)).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'Start a run' }));
    expect(onStart).toHaveBeenCalled();
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
  it('shows no HELL SHIFT tag on a normal shift', () => {
    const { container } = render(<Handover {...base} status={demoStatus({ phase: 'handover', shiftNumber: 1, shiftTarget: null })} events={[shiftEnd]} />);
    expect(container.textContent).not.toContain('HELL SHIFT');
  });
  it('before the first shift (shiftNumber 0) offers shift 1 at about 3,900 m³; after shift 2 offers shift 3', () => {
    const first = render(<Handover {...base} status={demoStatus({ phase: 'handover', shiftNumber: 0, shiftTarget: null })} events={[]} />);
    expect(first.getByRole('button', { name: 'Start shift 1' })).toBeTruthy();
    expect(first.container.textContent).toContain('≈ 3,900 m³');
    cleanup();
    const third = render(<Handover {...base} status={demoStatus({ phase: 'handover', shiftNumber: 2, shiftTarget: null })} events={[]} />);
    expect(third.getByRole('button', { name: 'Start shift 3' })).toBeTruthy();
    expect(third.container.textContent).toContain(`≈ ${nextTargetEstimateM3(3).toLocaleString('en-US')} m³`);
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
    const t = container.textContent!;
    expect(t).toContain('The budget ran out');
    expect(t.indexOf('18,250')).toBeLessThan(t.indexOf('Shifts completed'));
    expect(t).toContain('$400');
    fireEvent.click(getByRole('button', { name: 'Play again' }));
    expect(sessionStorage.getItem(GAME_ID_KEY)).toBeNull();
    expect(onPlayAgain).toHaveBeenCalled();
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
  beforeEach(() => { socks.length = 0; sessionStorage.clear(); });
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
});
