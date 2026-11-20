import type { GameEndReason, GameMode, GameScore } from '@desal/schema';
import { useId } from 'react';
import { fmt, usd } from '../equipment/format';
import { GAME_ID_KEY } from '../net/socket';
import { SheetHead } from './Sheet';
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
  mode?: GameMode;
  score: GameScore | null;
  onPlayAgain: () => void;
}

export function GameOver({ reason, mode = 'normal', score, onPlayAgain }: GameOverProps) {
  const titleId = useId();
  const playAgain = () => {
    try { sessionStorage.removeItem(GAME_ID_KEY); } catch { /* storage unavailable */ }
    onPlayAgain();
  };
  return (
    <main className="screen screen--board" data-screen="over">
      <article className="sheet" aria-labelledby={titleId}>
        <SheetHead kicker="Run over" title="Final report" id={titleId} />
        <p className="sheet__reason">{reason ? REASON_TEXT[reason] : REASON_TEXT.error}</p>
        <p className="screen__big" aria-label="Water delivered">{fmt(score?.totalProductM3)}</p>
        <p className="screen__unit">m³ of in-spec water delivered</p>
        <dl className="sheet__figures">
          <div><dt>Mode</dt><dd>{mode === 'hard' ? 'Hard' : 'Normal'}</dd></div>
          <div><dt>Shifts completed</dt><dd>{fmt(score?.shiftsCompleted)}</dd></div>
          <div><dt>Final balance</dt><dd>{usd(score?.balanceUsd)}</dd></div>
        </dl>
        <div className="screen__actions sheet__actions">
          <button type="button" className="primary sheet__go" onClick={playAgain}>Play again</button>
        </div>
      </article>
    </main>
  );
}
