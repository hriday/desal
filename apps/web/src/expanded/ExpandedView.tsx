import { useEffect, useRef, type ComponentType } from 'react';
import { worstLevel, type MonitorId } from '../alarms/rules';
import { MONITOR_TITLES } from '../wall/Monitor';
import { FuelView } from './FuelView';
import { HeaterView } from './HeaterView';
import { IntakeView } from './IntakeView';
import { ProductView } from './ProductView';
import { ShiftView } from './ShiftView';
import { StagesView } from './StagesView';
import type { ExpandedProps } from './types';
import './expanded.css';

const VIEWS: Record<MonitorId, ComponentType<ExpandedProps>> = {
  intake: IntakeView, heater: HeaterView, stages: StagesView, product: ProductView, fuel: FuelView, shift: ShiftView,
};

export interface ExpandedViewProps extends ExpandedProps {
  id: MonitorId;
  onClose: () => void;
}

/** One monitor at full size. Back or Esc returns to the wall; the frame follows the monitor's worst alarm. */
export function ExpandedView({ id, onClose, ...props }: ExpandedViewProps) {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // A field that used Esc to cancel its edit marks the event handled; only an unhandled Esc closes.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => { back.current?.focus(); }, [id]);
  const level = worstLevel(props.alarms ?? [], id);
  const View = VIEWS[id];
  const title = MONITOR_TITLES[id];
  return (
    <section className={`expanded expanded--${level}`} data-expanded={id} aria-label={`${title}, expanded`}>
      <header className="expanded__head">
        <button ref={back} type="button" className="btn" onClick={onClose}>← Back</button>
        <h2 className="expanded__title">{title}</h2>
        <span className={`tone--${level}`} aria-label={level === 'ok' ? 'normal' : level === 'warn' ? 'warning' : 'alarm'}>●</span>
        <span className="expanded__hint">Esc to return</span>
      </header>
      <View {...props} />
    </section>
  );
}
