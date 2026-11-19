import './screens.css';

export interface StartProps {
  onStart: () => void;
  /** True while a start request is in flight. */
  starting?: boolean;
  /** Set when the plant refused the game for capacity. */
  capacityMessage?: string | null;
}

export function Start({ onStart, starting = false, capacityMessage = null }: StartProps) {
  return (
    <main className="screen" data-screen="start">
      <h1>Desalination Control Room</h1>
      <p>
        You run a seawater desalination plant. Make as much clean water as you can each shift without running out
        of budget, fuel or working equipment. Every shift gets harder.
      </p>
      {capacityMessage && <p className="screen__note" role="alert">{capacityMessage}</p>}
      <div className="screen__actions">
        <button type="button" className="primary" onClick={onStart} disabled={starting}>
          {starting ? 'Starting…' : capacityMessage ? 'Try again' : 'Start a run'}
        </button>
      </div>
    </main>
  );
}
