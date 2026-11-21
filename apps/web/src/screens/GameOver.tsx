import type { GameEndReason, GameScore } from '@desal/schema';
import { fmt, usd } from '../equipment/format';
import { GAME_ID_KEY } from '../net/socket';
import './screens.css';

export const REASON_TEXT: Record<GameEndReason, string> = {
  bankrupt: 'The budget ran out',
  outOfFuel: 'No fuel left and no budget to buy more',
  burnerFailed: 'The burner gave out',
  noIntakePumps: 'No working intake pumps',
  quit: 'You ended the run',
  abandoned: 'Connection lost',
  error: 'Something went wrong',
};

export interface GameOverProps {
  reason: GameEndReason | null;
  score: GameScore | null;
  onPlayAgain: () => void;
}

export function GameOver({ reason, score, onPlayAgain }: GameOverProps) {
  const playAgain = () => {
    try { sessionStorage.removeItem(GAME_ID_KEY); } catch { /* storage unavailable */ }
    onPlayAgain();
  };
  return (
    <main className="screen" data-screen="over">
      <h1>Run over</h1>
      <p>{reason ? REASON_TEXT[reason] : REASON_TEXT.error}</p>
      <p className="screen__big" aria-label="Water delivered">{fmt(score?.totalProductM3)}</p>
      <p className="screen__unit">m³ of in-spec water delivered</p>
      <dl>
        <dt>Shifts completed</dt><dd>{fmt(score?.shiftsCompleted)}</dd>
        <dt>Final balance</dt><dd>{usd(score?.balanceUsd)}</dd>
      </dl>
      <div className="screen__actions">
        <button type="button" className="primary" onClick={playAgain}>Play again</button>
      </div>
    </main>
  );
}
