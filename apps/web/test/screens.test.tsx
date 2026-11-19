import { cleanup, fireEvent, render } from '@testing-library/react';
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
    const status = demoStatus({ phase: 'handover', shiftNumber: 2, shiftTarget: null });
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
  it('sends the chosen mode, and quit', () => {
    const onStartShift = vi.fn();
    const onQuit = vi.fn();
    const status = demoStatus({ phase: 'handover', shiftNumber: 1, shiftTarget: null });
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
  it('shows start, and sends newGame through the socket', async () => {
    const socks: FakeWS[] = [];
    class FakeWS {
      readyState = 1; sent: string[] = [];
      onopen: (() => void) | null = null; onmessage: unknown; onclose: unknown; onerror: unknown;
      send(m: string) { this.sent.push(m); }
      close() {}
      constructor() { socks.push(this); setTimeout(() => this.onopen?.(), 0); }
    }
    const { getByRole, container } = render(
      <GameProvider url="ws://x" factory={() => new FakeWS() as unknown as WebSocket}><Screens /></GameProvider>,
    );
    expect(container.querySelector('[data-screen="start"]')).not.toBeNull();
    fireEvent.click(getByRole('button', { name: 'Start a run' }));
    expect(socks[0]!.sent.map((s) => JSON.parse(s).t)).toContain('newGame');
    expect(container.querySelector('[data-screen="start"]')).not.toBeNull(); // still waiting for the plant
    expect(getByRole('button', { name: 'Starting…' })).toBeTruthy();
  });
});
