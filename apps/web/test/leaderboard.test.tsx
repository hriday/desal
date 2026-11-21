import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { fetchLeaderboard, leaderboardUrl } from '../src/net/leaderboard';
import { LeaderboardCard, OFFLINE_AFTER_MS } from '../src/screens/LeaderboardCard';
import { board } from './fixtures';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Lets the loader's promise settle and React apply it. */
const settle = () => act(async () => { await Promise.resolve(); });

describe('LeaderboardCard', () => {
  it('shows the Normal and Hard top rows, each in its own section', async () => {
    const { getByRole } = render(<LeaderboardCard load={() => Promise.resolve(board())} />);
    await settle();
    const normal = getByRole('region', { name: 'Normal' });
    const hard = getByRole('region', { name: 'Hard' });
    const first = normal.querySelector('li')!;
    expect(first.textContent).toContain('Kestrel-42 · 19 Nov');
    expect(first.textContent).toContain('41,200 m³');
    expect(first.textContent).toContain('11 shifts');
    expect(normal.textContent).toContain('Heron-17');
    expect(hard.textContent).toContain('Osprey-23 · 19 Nov');
    expect(hard.textContent).not.toContain('Kestrel-42');
    expect(normal.textContent).not.toContain('Osprey-23');
  });

  it('"Today" shows each board\'s today rows', async () => {
    const { getByRole } = render(<LeaderboardCard load={() => Promise.resolve(board())} />);
    await settle();
    const normal = getByRole('region', { name: 'Normal' });
    fireEvent.click(within(normal).getByRole('button', { name: 'Today' }));
    expect(normal.textContent).toContain('Plover-88');
    expect(normal.textContent).not.toContain('Kestrel-42');
    // The Hard board keeps its own toggle.
    const hard = getByRole('region', { name: 'Hard' });
    expect(hard.textContent).toContain('Osprey-23');
    fireEvent.click(within(hard).getByRole('button', { name: 'Today' }));
    expect(hard.textContent).toContain('Gannet-11');
    fireEvent.click(within(normal).getByRole('button', { name: 'All time' }));
    expect(normal.textContent).toContain('Kestrel-42');
  });

  it('shows how many plants are running, and the stats lines', async () => {
    const { container, getByRole } = render(<LeaderboardCard load={() => Promise.resolve(board())} />);
    await settle();
    expect(container.textContent).toContain('3 plants running now');
    expect(getByRole('region', { name: 'Normal' }).textContent).toContain('62 % of operators handled their first vacuum loss well');
    expect(getByRole('region', { name: 'Hard' }).textContent).toContain('20 % of operators handled their first storm well');
  });

  it('rotates the stats lines every 6 s', async () => {
    vi.useFakeTimers();
    const { getByRole } = render(<LeaderboardCard load={() => Promise.resolve(board())} />);
    await settle();
    const normal = () => getByRole('region', { name: 'Normal' }).textContent!;
    expect(normal()).toContain('first vacuum loss');
    act(() => { vi.advanceTimersByTime(6000); });
    expect(normal()).toContain('82 % of operators handled their first pump trip well');
    act(() => { vi.advanceTimersByTime(6000); });
    expect(normal()).toContain('first vacuum loss');
  });

  it('a loader that never answers shows "Leaderboard offline" after 5 s', () => {
    vi.useFakeTimers();
    const { container } = render(<LeaderboardCard load={() => new Promise(() => {})} />);
    expect(container.textContent).not.toContain('Leaderboard offline');
    act(() => { vi.advanceTimersByTime(OFFLINE_AFTER_MS - 1); });
    expect(container.textContent).not.toContain('Leaderboard offline');
    act(() => { vi.advanceTimersByTime(1); });
    expect(container.textContent).toContain('Leaderboard offline');
  });

  it('a failing loader shows "Leaderboard offline" at once', async () => {
    const { container } = render(<LeaderboardCard load={() => Promise.reject(new Error('503'))} />);
    await settle();
    expect(container.textContent).toContain('Leaderboard offline');
  });

  it('refreshes every 30 s while mounted', async () => {
    vi.useFakeTimers();
    const load = vi.fn(() => Promise.resolve(board()));
    const { unmount } = render(<LeaderboardCard load={load} />);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(30_000); await Promise.resolve(); });
    expect(load).toHaveBeenCalledTimes(2);
    unmount();
    vi.advanceTimersByTime(60_000);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('leaderboardUrl', () => {
  it.each([
    ['wss://desal.moosha.org/ws', 'https://desal.moosha.org/api/leaderboard'],
    ['ws://localhost:8081/ws', 'http://localhost:8081/api/leaderboard'],
  ])('%s -> %s', (ws, http) => {
    expect(leaderboardUrl(ws)).toBe(http);
  });
});

describe('fetchLeaderboard', () => {
  const respond = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))));
  const signal = () => new AbortController().signal;

  it('returns a valid board', async () => {
    respond(200, board());
    await expect(fetchLeaderboard('http://x/api/leaderboard', signal())).resolves.toEqual(board());
  });
  it('throws on 503', async () => {
    respond(503, { error: 'leaderboard offline' });
    await expect(fetchLeaderboard('http://x/api/leaderboard', signal())).rejects.toThrow();
  });
  it('throws on a body that is not a public board (a leaked runId)', async () => {
    const b = board();
    respond(200, { ...b, normal: { ...b.normal, allTime: [{ ...b.normal.allTime[0]!, runId: '11111111-1111-4111-8111-111111111111' }] } });
    await expect(fetchLeaderboard('http://x/api/leaderboard', signal())).rejects.toThrow();
  });
});
