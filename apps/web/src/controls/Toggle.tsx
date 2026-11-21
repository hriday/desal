import type { LoopId } from '@desal/schema';
import { commandKey, loopMode } from '../commands';
import { DASH } from '../equipment/format';
import { canSend, pendingCommand, type ControlCtx } from './ctx';

export interface ToggleProps {
  label: string;
  /** The reported state; undefined when unknown (the toggle is then disabled). */
  on: boolean | undefined;
  onText?: string;
  offText?: string;
  pending?: boolean;
  disabled?: boolean;
  /** A short caption beside the button (e.g. a running cost). */
  note?: string;
  onChange: (next: boolean) => void;
}

/** An on/off control showing the plant's reported state; pressing asks for the other state. */
export function Toggle({ label, on, onText = 'On', offText = 'Off', pending, disabled, note, onChange }: ToggleProps) {
  return (
    <div className="ctl" data-control={label}>
      <span className="ctl__label">{label}</span>
      <span className="ctl__row">
        <button
          type="button"
          className={`btn toggle${on ? ' toggle--on' : ''}`}
          aria-label={label}
          aria-pressed={on === undefined ? undefined : on}
          disabled={disabled || on === undefined || pending}
          onClick={() => on !== undefined && onChange(!on)}
        >
          {on === undefined ? DASH : on ? onText : offText}
        </button>
        {note && <span className="ctl__meta">{note}</span>}
        {pending && <span className="ctl__pending">sending…</span>}
      </span>
    </div>
  );
}

/**
 * A loop's Auto/Manual toggle. The caller shows it in Auto plant mode only, except for the inventory
 * loops (makeup), whose mode the plant accepts in both control modes.
 */
export function LoopModeToggle({ loop, name, ...ctl }: ControlCtx & { loop: LoopId; name: string }) {
  const mode = ctl.status?.loops?.[loop]?.mode;
  const manual = mode === 'manual' ? true : mode === 'auto' ? false : undefined;
  return (
    <Toggle
      label={`${name} loop mode`}
      on={manual}
      onText="Manual"
      offText="Auto"
      pending={pendingCommand(ctl, commandKey(loopMode(loop, 'auto'))) !== undefined}
      disabled={!canSend(ctl)}
      onChange={(m) => ctl.send?.(loopMode(loop, m ? 'manual' : 'auto'))}
    />
  );
}
