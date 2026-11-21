import type { LoopId } from '@desal/schema';
import { useState } from 'react';
import { commandKey, controlFor } from '../commands';
import { fmt, num } from '../equipment/format';
import { loopRange } from '../limits';
import { canSend, effectiveMode, pendingCommand, type ControlCtx } from './ctx';
import { clampTo, Stepper } from './Stepper';

export interface SetpointProps {
  label: string;
  /** The value the plant reports; undefined when it doesn't. */
  reported: number | undefined;
  /** A sent value not yet confirmed. */
  pending?: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  digits?: number;
  disabled?: boolean;
  /** Extra context under the field, e.g. "last sent 1.5 mg/L". */
  note?: string;
  onCommit: (value: number) => void;
}

/**
 * A setpoint-style control. The field shows the in-flight value while one is pending, else the
 * reported one; an edit is local until Enter (or Set) sends it. When a send is rejected its pending
 * entry goes away and the field falls back to the reported value.
 */
export function Setpoint({ label, reported, pending, min, max, step, unit = '', digits = 0, disabled, note, onCommit }: SetpointProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = pending ?? reported;
  const value = draft ?? (num(shown) ? shown.toFixed(digits) : '');
  const commit = () => {
    const n = Number(value);
    setDraft(null);
    if (value.trim() === '' || !Number.isFinite(n)) return;
    onCommit(clampTo(n, min, max));
  };
  const cancel = () => { if (draft === null) return false; setDraft(null); return true; };
  return (
    <div className="ctl" data-control={label}>
      <span className="ctl__label">{label}</span>
      <span className="ctl__row">
        <Stepper label={label} value={value} onChange={setDraft} onEnter={commit} onEscape={cancel} min={min} max={max} step={step} unit={unit} disabled={disabled} />
        <button type="button" className="btn" aria-label={`Set ${label}`} disabled={disabled} onClick={commit}>Set</button>
      </span>
      <span className="ctl__meta">
        reported {fmt(reported, digits, unit)} · {min}–{max}{unit ? ` ${unit}` : ''}
        {pending !== undefined && <span className="ctl__pending"> · sending…</span>}
      </span>
      {note && <span className="ctl__meta">{note}</span>}
    </div>
  );
}

export interface LoopSetpointProps extends ControlCtx {
  loop: LoopId;
  /** Human name, e.g. "TBT"; the control is labelled "<name> setpoint" or "<name> output". */
  name: string;
  /** Replaces "<name> output" as the label in output (Manual) mode. */
  outputName?: string;
  unit: string;
  step: number;
  digits: number;
}

/** A loop's control: a setpoint in Auto, the output (percent) in Manual, via controlFor. */
export function LoopSetpoint({ loop, name, outputName, unit, step, digits, ...ctl }: LoopSetpointProps) {
  const mode = effectiveMode(ctl.status, loop);
  const probe = controlFor(mode, loop, 0);
  const isOut = probe.type === 'setOutput';
  const { min, max } = loopRange(loop, isOut ? 'setOutput' : 'setSetpoint');
  const reported = isOut ? ctl.status?.loops?.[loop]?.output : ctl.status?.loops?.[loop]?.setpoint;
  const p = pendingCommand(ctl, commandKey(probe));
  const pending = p && (p.type === 'setSetpoint' || p.type === 'setOutput') ? p.value : undefined;
  return (
    <Setpoint
      key={probe.type}
      label={isOut ? (outputName ?? `${name} output`) : `${name} setpoint`}
      reported={num(reported) ? reported : undefined}
      pending={pending}
      min={min}
      max={max}
      step={isOut ? 1 : step}
      unit={isOut ? '%' : unit}
      digits={isOut ? 0 : digits}
      disabled={!canSend(ctl)}
      onCommit={(v) => ctl.send?.(controlFor(mode, loop, v))}
    />
  );
}
