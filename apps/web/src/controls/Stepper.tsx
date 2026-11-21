import type { KeyboardEvent } from 'react';

export interface StepperProps {
  label: string;
  /** The field's text (owned by the caller). */
  value: string;
  onChange: (value: string) => void;
  /** Enter in the field. */
  onEnter?: () => void;
  /** Esc in the field; return true when it was handled (an edit was cancelled), so Esc does not also close the view. */
  onEscape?: () => boolean;
  min: number;
  max: number;
  step: number;
  unit?: string;
  disabled?: boolean;
}

const decimals = (step: number) => (String(step).split('.')[1] ?? '').length;

export const clampTo = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** A number field with − and + buttons. − and + step the field; Enter is the caller's "send". */
export function Stepper({ label, value, onChange, onEnter, onEscape, min, max, step, unit, disabled }: StepperProps) {
  const n = Number(value);
  const base = value.trim() !== '' && Number.isFinite(n) ? n : min;
  const bump = (dir: number) => onChange(clampTo(base + dir * step, min, max).toFixed(decimals(step)));
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); onEnter?.(); }
    else if (e.key === 'Escape' && onEscape?.()) e.preventDefault();
  };
  return (
    <span className="stepper">
      <button type="button" className="btn stepper__btn" aria-label={`Decrease ${label}`} disabled={disabled} onClick={() => bump(-1)}>−</button>
      <input
        type="number"
        className="stepper__input"
        aria-label={label}
        inputMode="decimal"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="button" className="btn stepper__btn" aria-label={`Increase ${label}`} disabled={disabled} onClick={() => bump(1)}>+</button>
      {unit && <span className="stepper__unit">{unit}</span>}
    </span>
  );
}
