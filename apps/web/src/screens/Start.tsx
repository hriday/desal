import { Fragment } from 'react';
import { demoReadings, demoStatus, demoTarget } from '../demo';
import { BrineHeater } from '../equipment/BrineHeater';
import { FlashStages } from '../equipment/FlashStages';
import { Intake } from '../equipment/Intake';
import { ProductWater } from '../equipment/ProductWater';
import './screens.css';

export interface StartProps {
  onStart: () => void;
  /** True while a start request is in flight. */
  starting?: boolean;
  /** Set when the plant refused the game for capacity. */
  capacityMessage?: string | null;
}

/**
 * The strip's fixed demo plant: the wall's drawings, animated by motion.css as on the wall. The demo's
 * scaled stage and rising chlorophyll are healed so the title screen shows a healthy plant, not alarms.
 */
const STRIP_DATA = {
  status: demoStatus(),
  readings: demoReadings({ 'stages.s02.hardScaleMm': 0.08, 'pretreat.chlorophyllUgL': 1.2 }),
  target: demoTarget,
};
const STRIP = [Intake, BrineHeater, FlashStages, ProductWater] as const;

/** Intake → Heater → Stages → Product, decorative (the screen's text says what the game is). */
function PlantStrip() {
  return (
    <div className="start__plant" aria-hidden="true">
      {STRIP.map((Drawing, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="start__link" />}
          <div className="start__panel"><Drawing {...STRIP_DATA} /></div>
        </Fragment>
      ))}
    </div>
  );
}

export function Start({ onStart, starting = false, capacityMessage = null }: StartProps) {
  return (
    <main className="screen screen--start" data-screen="start">
      <h1 className="start__title">Desal Operator</h1>
      <p className="start__pitch">
        <span>You run a thermal desalination plant.</span>
        <span>Deliver the water, shift after shift — until the money, the fuel or the plant gives out.</span>
      </p>
      <PlantStrip />
      {capacityMessage && <p className="screen__note" role="alert">{capacityMessage}</p>}
      <div className="screen__actions start__actions">
        <button type="button" className="primary start__go" onClick={onStart} disabled={starting}>
          {starting ? 'Starting…' : capacityMessage ? 'Try again' : 'Start a run'}
        </button>
      </div>
    </main>
  );
}
