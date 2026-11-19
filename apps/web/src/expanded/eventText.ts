import type { PlantEvent } from '@desal/schema';
import { DASH, fmt, label, num, usd } from '../equipment/format';
import { CAUSE_TEXT, END_TEXT, FUEL_TEXT, GRADE_TEXT, MODE_TEXT, STEP_TEXT, TRIP_TEXT } from './labels';

const lower = (s: string | undefined) => (s ?? DASH).toLowerCase();
const pct = (v: unknown) => fmt(num(v as number) ? (v as number) * 100 : undefined, 0, '%');

/** One event as a plain sentence for the event log, or null for a type this client doesn't know (skipped). */
export function eventText(e: PlantEvent): string | null {
  if (!e || typeof e !== 'object') return null;
  switch (e.type) {
    case 'shiftStart':
      return `Shift started in ${lower(label(MODE_TEXT, e.mode))} mode: target ${fmt(e.target?.productM3, 0, 'm³')} at ≤ ${fmt(e.target?.maxSalinityPpm, 0, 'ppm')}`;
    case 'shiftEnd':
      return `Shift ended: ${fmt(e.summary?.productM3)} of ${fmt(e.summary?.targetM3, 0, 'm³')} in spec, spent ${usd(e.summary?.spentUsd)}`;
    case 'trip': {
      const cause = label(TRIP_TEXT, e.cause);
      return cause ? `Plant tripped: ${cause}` : 'Plant tripped';
    }
    case 'restartProgress': {
      const step = lower(label(STEP_TEXT, e.step));
      if (e.ok) return `Restart step ${step} started`;
      return `Restart step ${step} failed${typeof e.reason === 'string' && e.reason ? `: ${e.reason}` : ''}`;
    }
    case 'online':
      return 'Plant back online';
    case 'scenario':
      return typeof e.message === 'string' && e.message ? e.message.replace(/\bug\/L/g, 'µg/L') : 'Plant conditions changed';
    case 'eventCleared': // Plan 4 Task 11 replaces
      return 'A plant problem was cleared';
    case 'fuelChangeover': {
      const from = lower(label(FUEL_TEXT, e.from));
      const to = lower(label(FUEL_TEXT, e.to));
      if (e.phase === 'started') return `Fuel changeover from ${from} to ${to} started`;
      if (e.phase === 'done') return `Fuel changeover to ${to} complete`;
      if (e.phase === 'flameOut') return `Burner flamed out during the changeover to ${to}`;
      return `Fuel changeover to ${to}`;
    }
    case 'deliveryArrived':
      return `Backup fuel delivery arrived: ${fmt(e.tonnes, 0, 't')} ${lower(label(GRADE_TEXT, e.grade))}`;
    case 'commandRejected':
      return `Command rejected: ${typeof e.reason === 'string' && e.reason ? e.reason : DASH}`;
    case 'damage':
      if (e.component === 'stageScale') return `Damage: stage hard scale reached ${fmt(e.value, 2, 'mm')}`;
      if (e.component === 'pump') return `Damage: pump wear reached ${pct(e.value)}`;
      if (e.component === 'burner') return `Damage: burner condition down to ${pct(e.value)}`;
      return 'Equipment damage reported';
    case 'gameStart':
      return 'Run started';
    case 'gameRejected':
      return e.reason === 'capacity' ? 'Run refused: the plant is at capacity' : 'Run refused: a game is already running in another tab';
    case 'gameEnd':
      return `Game over: ${label(END_TEXT, e.reason) ?? 'the run ended'}`;
    case 'accountChange': {
      const cause = label(CAUSE_TEXT, e.cause) ?? 'an expense';
      const bal = `balance ${usd(e.balanceUsd)}`;
      if (num(e.deltaUsd) && e.deltaUsd >= 0) return `Received ${usd(e.deltaUsd)} from ${cause}; ${bal}`;
      return `Paid ${usd(num(e.deltaUsd) ? -e.deltaUsd : undefined)} for ${cause}; ${bal}`;
    }
    default:
      return null;
  }
}

/** Plant clock "hh:mm" from plant seconds. */
export function clock(plantTimeS: number | undefined): string {
  if (!num(plantTimeS)) return DASH;
  const m = Math.floor(plantTimeS / 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
