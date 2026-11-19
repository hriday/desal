import { useEffect, useState, type KeyboardEvent } from 'react';
import { usd } from '../equipment/format';

export interface ActionButtonProps {
  label: string;
  onAction: () => void;
  /** Shown on the button when the action costs money. */
  costUsd?: number;
  /** Ask before acting (actions with cost or risk). */
  confirm?: boolean;
  disabled?: boolean;
  pending?: boolean;
  /** Why it is disabled, or what it does. */
  hint?: string;
  danger?: boolean;
}

/** A one-shot action. With `confirm`, the first press asks "Confirm … / Cancel". */
export function ActionButton({ label, onAction, costUsd, confirm, disabled, pending, hint, danger }: ActionButtonProps) {
  const [asking, setAsking] = useState(false);
  const text = costUsd !== undefined ? `${label} (${usd(costUsd)})` : label;
  const off = disabled || pending;
  const cls = `btn${danger ? ' btn--danger' : ''}`;
  // A confirm armed before the action became unavailable must not come back armed.
  useEffect(() => { if (off) setAsking(false); }, [off]);
  // Esc backs out of an open confirm (and is marked handled, so the expanded view stays open).
  const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setAsking(false); } };
  if (asking && !off) {
    return (
      <span className="ctl__row action action--confirm" onKeyDown={onKeyDown}>
        <button type="button" className={cls} aria-label={`Confirm ${label}`} onClick={() => { setAsking(false); onAction(); }}>
          Confirm {text}
        </button>
        <button type="button" className="btn" autoFocus onClick={() => setAsking(false)}>Cancel</button>
      </span>
    );
  }
  return (
    <span className="ctl__row action">
      <button type="button" className={cls} disabled={off} title={hint} onClick={() => (confirm ? setAsking(true) : onAction())}>
        {text}
      </button>
      {pending && <span className="ctl__pending">sending…</span>}
      {hint && off && !pending && <span className="ctl__meta">{hint}</span>}
    </span>
  );
}
