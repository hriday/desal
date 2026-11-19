import type { PlantStatus } from '@desal/schema';
import { useState } from 'react';
import { DASH, fmt, label, plantClock, ticksToHm, usd } from '../equipment/format';
import type { Conn } from '../state/store';

const MODE_TEXT: Record<string, string> = { auto: 'Auto', manual: 'Manual' };
const CONN_TEXT: Record<Conn, string> = { open: 'Connected', connecting: 'Connecting', closed: 'Disconnected' };
const CONN_TONE: Record<Conn, 'ok' | 'warn' | 'bad'> = { open: 'ok', connecting: 'warn', closed: 'bad' };

export interface TopBarProps {
  status: PlantStatus | null;
  conn: Conn;
  /** A quit has been sent and the plant has not ended the run yet. */
  quitting: boolean;
  onQuit: () => void;
}

/** Shift, plant clock, time left, balance, mode, connection light, and Quit run (with a confirm step). */
export function TopBar({ status, conn, quitting, onQuit }: TopBarProps) {
  const [confirming, setConfirming] = useState(false);
  const bal = status?.balanceUsd;
  const balTone = typeof bal === 'number' ? (bal < 0 ? 'bad' : bal < 5000 ? 'warn' : undefined) : undefined;
  return (
    <header className="topbar">
      <span className="topbar__item topbar__shift">Shift {fmt(status?.shiftNumber)}</span>
      <span className="topbar__item" title="Plant clock">
        <span className="topbar__k">Plant</span> {plantClock(status?.plantTime)}
      </span>
      <span className="topbar__item">{ticksToHm(status?.shiftTicksRemaining)} left</span>
      <span className={`topbar__item${balTone ? ` tone--${balTone}` : ''}`}>
        <span className="topbar__k">Balance</span> {usd(bal)}
      </span>
      <span className="topbar__item">
        <span className="topbar__k">Mode</span> {label(MODE_TEXT, status?.controlMode) ?? DASH}
      </span>
      <span className="topbar__item topbar__conn" data-conn={conn}>
        <span className={`tone--${CONN_TONE[conn]}`} aria-hidden="true">●</span> {CONN_TEXT[conn]}
      </span>
      <span className="topbar__quit">
        {confirming ? (
          <>
            <span>End the run?</span>
            <button type="button" className="btn btn--danger" onClick={() => { setConfirming(false); onQuit(); }}>Yes, quit</button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>Cancel</button>
          </>
        ) : (
          <button type="button" className="btn" disabled={quitting} onClick={() => setConfirming(true)}>
            {quitting ? 'Quitting…' : 'Quit run'}
          </button>
        )}
      </span>
    </header>
  );
}
