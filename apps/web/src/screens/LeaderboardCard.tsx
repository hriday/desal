import type { KindBoardStat, PublicLeaderboard, PublicLeaderboardRow, ScenarioKind } from '@desal/schema';
import { useEffect, useId, useRef, useState } from 'react';
import { fmt } from '../equipment/format';
import { fetchLeaderboard, leaderboardUrl } from '../net/leaderboard';
import { defaultWsUrl } from '../net/socket';

/** No board within this long of mounting shows "Leaderboard offline" (Flink or the gateway is down). */
export const OFFLINE_AFTER_MS = 5_000;
/** The board is fetched again this often while the card is on screen. */
export const REFRESH_MS = 30_000;
/** Each board's stats line moves on to its next stat this often. */
export const STAT_ROTATE_MS = 6_000;
const MAX_STATS = 3;

/** The noun in "handled their first <noun> well". Earthquake is noted, not graded, so it has no stats line. */
const KIND_NOUN: Partial<Record<ScenarioKind, string>> = {
  pumpTrip: 'pump trip', tubeLeak: 'tube leak', vacuumLoss: 'vacuum loss', powerDip: 'power dip', storm: 'storm',
  sensorFailure: 'sensor failure', fuelContamination: 'fuel contamination', tsunami: 'tsunami',
};

export const statLine = (s: KindBoardStat): string =>
  `${Math.round(s.firstHandledWellPct)} % of operators handled their first ${KIND_NOUN[s.kind]} well`;

const dayMonth = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

const defaultLoad = (signal: AbortSignal) => fetchLeaderboard(leaderboardUrl(defaultWsUrl()), signal);

type View = { kind: 'loading' } | { kind: 'offline' } | { kind: 'ready'; board: PublicLeaderboard };

export interface LeaderboardCardProps {
  /** Fetches the board (injected in tests); defaults to GET /api/leaderboard next to the game socket. */
  load?: (signal: AbortSignal) => Promise<PublicLeaderboard>;
}

function Rows({ rows }: { rows: readonly PublicLeaderboardRow[] }) {
  if (rows.length === 0) return <p className="lb__empty">No runs yet</p>;
  return (
    <ol className="lb__rows">
      {rows.map((r) => (
        <li key={`${r.rank}:${r.callSign}:${r.endedAt}`}>
          <span className="lb__rank">{r.rank}</span>
          <span className="lb__who">{r.callSign} · {dayMonth(r.endedAt)}</span>
          <span className="lb__water">{fmt(r.totalProductM3, 0, 'm³')}</span>
          <span className="lb__shifts">{r.shiftsCompleted === 1 ? '1 shift' : `${fmt(r.shiftsCompleted)} shifts`}</span>
        </li>
      ))}
    </ol>
  );
}

function Board({ title, board, tick }: { title: string; board: PublicLeaderboard['normal']; tick: number }) {
  const [period, setPeriod] = useState<'allTime' | 'today'>('allTime');
  const id = useId();
  const stats = board.stats.filter((s) => KIND_NOUN[s.kind] !== undefined && s.operators > 0).slice(0, MAX_STATS);
  const stat = stats.length > 0 ? stats[tick % stats.length]! : null;
  return (
    <section className="lb__board" aria-labelledby={id}>
      <div className="lb__head">
        <h3 id={id}>{title}</h3>
        <div className="lb__toggle" role="group" aria-label={`${title} period`}>
          <button type="button" aria-pressed={period === 'allTime'} onClick={() => setPeriod('allTime')}>All time</button>
          <button type="button" aria-pressed={period === 'today'} onClick={() => setPeriod('today')}>Today</button>
        </div>
      </div>
      <Rows rows={board[period]} />
      {stat && <p className="lb__stat">{statLine(stat)}</p>}
    </section>
  );
}

/**
 * The start screen's leaderboard: the Normal and the Hard board side by side, each with its own
 * All time / Today toggle and stats line. The game never needs it: a board that does not come in
 * OFFLINE_AFTER_MS, or a failed fetch, shows "Leaderboard offline" and nothing else.
 */
export function LeaderboardCard({ load = defaultLoad }: LeaderboardCardProps) {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [tick, setTick] = useState(0);
  // The latest loader, so a parent re-render with a new function does not restart the fetching.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);

  useEffect(() => {
    let alive = true;
    let have = false;
    let inFlight: AbortController | null = null;
    const fetchOnce = () => {
      inFlight?.abort(); // a refresh replaces a request that never answered
      const ctl = new AbortController();
      inFlight = ctl;
      loadRef.current(ctl.signal).then(
        (board) => {
          if (!alive || ctl.signal.aborted) return;
          have = true;
          setView({ kind: 'ready', board });
        },
        () => {
          // A failed refresh keeps the board already shown.
          if (alive && !ctl.signal.aborted && !have) setView({ kind: 'offline' });
        },
      );
    };
    fetchOnce();
    const offline = setTimeout(() => { if (!have) setView({ kind: 'offline' }); }, OFFLINE_AFTER_MS);
    const refresh = setInterval(fetchOnce, REFRESH_MS);
    return () => {
      alive = false;
      inFlight?.abort();
      clearTimeout(offline);
      clearInterval(refresh);
    };
  }, []);

  const rotating = view.kind === 'ready';
  useEffect(() => {
    if (!rotating) return;
    const t = setInterval(() => setTick((n) => n + 1), STAT_ROTATE_MS);
    return () => clearInterval(t);
  }, [rotating]);

  return (
    <section className="lb" aria-label="Leaderboard">
      <h2>Leaderboard</h2>
      {view.kind === 'loading' && <p className="lb__note">Loading the leaderboard…</p>}
      {view.kind === 'offline' && <p className="lb__note">Leaderboard offline</p>}
      {view.kind === 'ready' && (
        <>
          <p className="lb__online">{view.board.online === 1 ? '1 plant running now' : `${fmt(view.board.online)} plants running now`}</p>
          <div className="lb__boards">
            <Board title="Normal" board={view.board.normal} tick={tick} />
            <Board title="Hard" board={view.board.hard} tick={tick} />
          </div>
        </>
      )}
    </section>
  );
}
