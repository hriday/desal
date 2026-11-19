import type { Conn } from '../state/store';

/**
 * Covers and blocks the page while the socket is not open: "Connecting…" on first load,
 * "Reconnecting…" once it has been open (the socket retries with backoff and resumes the game).
 */
export function ConnOverlay({ conn, everOpen }: { conn: Conn; everOpen: boolean }) {
  if (conn === 'open') return null;
  return (
    <div className="overlay" role="alert" aria-live="assertive">
      {everOpen ? 'Reconnecting…' : 'Connecting…'}
    </div>
  );
}
