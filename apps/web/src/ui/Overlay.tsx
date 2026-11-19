import type { Conn } from '../state/store';
import { GATEWAY_FULL_MESSAGE } from '../state/store';

/**
 * Covers and blocks the page while a socket exists but is not open: "Connecting…" on first load,
 * "Reconnecting…" once it has been open (the socket retries with backoff and resumes the game), and
 * at capacity (close 1013) a message with Retry, since the socket then retries only slowly. With no
 * socket at all (idle: the Start screen) there is nothing to show.
 */
export function ConnOverlay({ conn, everOpen, onRetry }: { conn: Conn; everOpen: boolean; onRetry?: () => void }) {
  if (conn === 'open' || conn === 'idle') return null;
  if (conn === 'full') {
    return (
      <div className="overlay" role="alert" aria-live="assertive">
        <div className="overlay__body">
          <p>{GATEWAY_FULL_MESSAGE}</p>
          <button type="button" className="primary" onClick={onRetry}>Retry</button>
        </div>
      </div>
    );
  }
  return (
    <div className="overlay" role="alert" aria-live="assertive">
      {everOpen ? 'Reconnecting…' : 'Connecting…'}
    </div>
  );
}
