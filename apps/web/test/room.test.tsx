import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { PlantEvent, PlantStatus, ServerMsg } from '@desal/schema';
import { ErrorBoundary, Screens } from '../src/App';
import { DEMO_GAME_ID, demoReadings, demoStatus } from '../src/demo';
import { plantClock } from '../src/equipment/format';
import { GAME_ID_KEY } from '../src/net/socket';
import { GameProvider } from '../src/state/GameProvider';

afterEach(() => { cleanup(); sessionStorage.clear(); });

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: unknown;
  constructor() { FakeWS.all.push(this); }
  send(m: string) { this.sent.push(m); }
  close() {}
  open() { this.readyState = 1; act(() => this.onopen?.()); }
  drop() { this.readyState = 3; act(() => this.onclose?.()); }
  push(msg: ServerMsg) { act(() => this.onmessage?.({ data: JSON.stringify(msg) })); }
  sentTypes() { return this.sent.map((s) => JSON.parse(s)).map((m) => (m.t === 'cmd' ? m.command.type : m.t)); }
}

function mount(status?: PlantStatus) {
  FakeWS.all = [];
  const r = render(
    <GameProvider url="ws://x" factory={() => new FakeWS() as unknown as WebSocket}><Screens /></GameProvider>,
  );
  const ws = FakeWS.all[0]!;
  ws.open();
  if (status) {
    ws.push({ t: 'game', gameId: status.gameId });
    ws.push({ t: 'status', status });
    ws.push({ t: 'frame', tick: status.tick, plantTime: status.plantTime, readings: demoReadings() });
  }
  return { ...r, ws };
}

const running = (over: Partial<PlantStatus> = {}) => demoStatus({ phase: 'running', ...over });
const ev = (e: Record<string, unknown>) => ({ gameId: DEMO_GAME_ID, tick: 1, plantTime: 0, shiftId: 3, ...e }) as unknown as PlantEvent;

describe('ControlRoom', () => {
  it('shows the wall and a top bar with shift, plant clock, time left, balance, mode and connection', () => {
    const plantTime = Date.UTC(2026, 0, 1, 6, 5);
    const { container, getByRole } = mount(running({ shiftNumber: 3, plantTime, shiftTicksRemaining: 330, balanceUsd: 12450 }));
    const room = container.querySelector('[data-screen="room"]')!;
    expect(room.getAttribute('data-game-id')).toBe(DEMO_GAME_ID);
    expect(container.querySelectorAll('[data-monitor]')).toHaveLength(6);
    const bar = getByRole('banner');
    const t = bar.textContent!;
    expect(t).toContain('Shift 3');
    expect(t).toContain(plantClock(plantTime));
    expect(t).toContain('3h 40m left');
    expect(t).toContain('$12,450');
    expect(t).toContain('Auto');
    expect(bar.querySelector('[data-conn="open"]')).not.toBeNull();
  });

  it('formats the plant clock as HH:MM', () => {
    expect(plantClock(new Date(2026, 0, 1, 7, 4).getTime())).toBe('07:04');
    expect(plantClock(undefined)).toBe('—');
  });

  it('opens a monitor, shows the alarm strip, and Esc returns to the wall', () => {
    const { container, getByRole } = mount(running());
    fireEvent.click(container.querySelector('[data-monitor="stages"]')!);
    expect(container.querySelector('[data-expanded="stages"]')).not.toBeNull();
    expect(getByRole('navigation', { name: 'Active alarms' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelector('[data-expanded]')).toBeNull();
    expect(container.querySelectorAll('[data-monitor]')).toHaveLength(6);
  });

  it('passes pending commands to the controls ("sending…")', () => {
    const { container, getByRole } = mount(running());
    fireEvent.click(container.querySelector('[data-monitor="heater"]')!);
    fireEvent.click(getByRole('button', { name: 'Increase TBT setpoint' }));
    fireEvent.click(getByRole('button', { name: 'Set TBT setpoint' }));
    expect(container.querySelector('[data-control="TBT setpoint"]')!.textContent).toContain('sending…');
  });

  it('uses the live shift target for alarms', () => {
    const { container, ws } = mount(running({ shiftTarget: { productM3: 3900, maxSalinityPpm: 15, fuelBudgetUsd: 12000 } }));
    ws.push({ t: 'frame', tick: 2, plantTime: 0, readings: { 'product.salinityPpm': 18 } });
    expect(container.querySelector('[data-monitor="product"]')!.className).toContain('monitor--bad');
  });

  it('a gameEnd switches to game over at once, even with a monitor expanded', () => {
    const { container, ws } = mount(running());
    fireEvent.click(container.querySelector('[data-monitor="fuel"]')!);
    ws.push({ t: 'event', event: ev({ seq: 9, type: 'gameEnd', reason: 'bankrupt', score: { totalProductM3: 100, shiftsCompleted: 2, balanceUsd: -5 } }) });
    const over = container.querySelector('[data-screen="over"]')!;
    expect(over).not.toBeNull();
    expect(container.querySelector('[data-expanded]')).toBeNull();
    const t = over.textContent!;
    expect(t).toContain('The budget ran out');
    expect(over.querySelector('[aria-label="Water delivered"]')!.textContent).toBe('100');
    expect(t).toMatch(/Shifts completed\s*2/);
    expect(t).toMatch(/Final balance\s*-\$5/);
    // The run is over: a reload must not try to resume it.
    expect(sessionStorage.getItem(GAME_ID_KEY)).toBeNull();
  });

  it('quit asks for confirmation and sends quitGame once', () => {
    const { getByRole, queryByRole, ws } = mount(running());
    fireEvent.click(getByRole('button', { name: 'Quit run' }));
    fireEvent.click(getByRole('button', { name: 'Cancel' }));
    expect(ws.sentTypes()).not.toContain('quitGame');
    fireEvent.click(getByRole('button', { name: 'Quit run' }));
    fireEvent.click(getByRole('button', { name: 'Yes, quit' }));
    expect(ws.sentTypes().filter((t) => t === 'quitGame')).toHaveLength(1);
    expect(queryByRole('button', { name: 'Yes, quit' })).toBeNull();
    expect((getByRole('button', { name: /Quitting/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a rejection toast in the room', () => {
    const { getByText, ws } = mount(running());
    ws.push({ t: 'event', event: ev({ seq: 4, type: 'commandRejected', commandId: 'x', reason: 'not in this mode' }) });
    expect(getByText(/not in this mode/)).toBeTruthy();
  });
});

describe('Connection overlay', () => {
  it('says Connecting… before the first open and Reconnecting… after a drop, blocking the page', () => {
    FakeWS.all = [];
    const { getByRole, queryByRole } = render(
      <GameProvider url="ws://x" factory={() => new FakeWS() as unknown as WebSocket}><Screens /></GameProvider>,
    );
    expect(getByRole('alert').textContent).toContain('Connecting…');
    FakeWS.all[0]!.open();
    expect(queryByRole('alert')).toBeNull();
    FakeWS.all[0]!.drop();
    const overlay = getByRole('alert');
    expect(overlay.textContent).toContain('Reconnecting…');
    expect(overlay.className).toContain('overlay');
  });

  it('makes the page inert while dropped (clicks do nothing) and live again on reconnect', () => {
    vi.useFakeTimers();
    try {
      const { container, ws } = mount(running());
      const app = container.querySelector('.app')!;
      expect(app.hasAttribute('inert')).toBe(false);
      ws.drop();
      expect(app.hasAttribute('inert')).toBe(true);
      fireEvent.click(container.querySelector('[data-monitor="stages"]')!);
      expect(container.querySelector('[data-expanded]')).toBeNull();
      act(() => { vi.advanceTimersByTime(1000); }); // the socket's first backoff
      FakeWS.all[1]!.open();
      expect(app.hasAttribute('inert')).toBe(false);
      fireEvent.click(container.querySelector('[data-monitor="stages"]')!);
      expect(container.querySelector('[data-expanded="stages"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Resuming a stored game', () => {
  const mountStored = () => {
    sessionStorage.setItem(GAME_ID_KEY, DEMO_GAME_ID);
    FakeWS.all = [];
    const r = render(
      <GameProvider url="ws://x" factory={() => new FakeWS() as unknown as WebSocket}><Screens /></GameProvider>,
    );
    FakeWS.all[0]!.open();
    return { ...r, ws: FakeWS.all[0]! };
  };

  it('shows "Resuming your game…" with no Start button until the status arrives', () => {
    const { container, queryByRole, getByText, ws } = mountStored();
    expect(ws.sentTypes()).toEqual(['resume']);
    expect(getByText('Resuming your game…')).toBeTruthy();
    expect(queryByRole('button', { name: /Start a run/ })).toBeNull();
    ws.push({ t: 'game', gameId: DEMO_GAME_ID });
    expect(container.querySelector('[data-screen="resuming"]')).not.toBeNull();
    ws.push({ t: 'status', status: running() });
    expect(container.querySelector('[data-screen="room"]')).not.toBeNull();
  });

  it('"no game" returns to start', () => {
    const { container, ws } = mountStored();
    ws.push({ t: 'error', reason: 'no game' });
    expect(container.querySelector('[data-screen="start"]')).not.toBeNull();
  });

  it('gives up after 5 s: back to start and the stored id is cleared', () => {
    vi.useFakeTimers();
    try {
      const { container } = mountStored();
      act(() => { vi.advanceTimersByTime(4900); });
      expect(container.querySelector('[data-screen="resuming"]')).not.toBeNull();
      act(() => { vi.advanceTimersByTime(200); });
      expect(container.querySelector('[data-screen="start"]')).not.toBeNull();
      expect(sessionStorage.getItem(GAME_ID_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Play again clears the stored id through reset', () => {
    const { getByRole, ws } = mountStored();
    ws.push({ t: 'status', status: running({ phase: 'over' }) });
    sessionStorage.setItem(GAME_ID_KEY, DEMO_GAME_ID);
    fireEvent.click(getByRole('button', { name: 'Play again' }));
    expect(sessionStorage.getItem(GAME_ID_KEY)).toBeNull();
  });
});

describe('Handover in-flight guard', () => {
  it('Start shift sends once until the next status', () => {
    const { getByRole, ws } = mount(demoStatus({ phase: 'handover', shiftNumber: 0, shiftTarget: null }));
    const btn = getByRole('button', { name: 'Start shift 1' }) as HTMLButtonElement;
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(ws.sentTypes().filter((t) => t === 'startShift')).toHaveLength(1);
    expect(btn.disabled).toBe(true);
    expect((getByRole('button', { name: 'Quit run' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ErrorBoundary', () => {
  it('shows "Something went wrong, reload" and leaves the stored game alone', () => {
    sessionStorage.setItem(GAME_ID_KEY, 'abc');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const Boom = () => { throw new Error('boom'); };
    const { getByText, getByRole } = render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(getByText(/Something went wrong/)).toBeTruthy();
    expect(getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(sessionStorage.getItem(GAME_ID_KEY)).toBe('abc');
    spy.mockRestore();
  });
});
