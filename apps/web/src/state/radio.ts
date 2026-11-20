import type { ScenarioKind } from '@desal/schema';
import { faultMonitor, type MonitorId } from '../alarms/rules';

/** How long a radio message stays up (ms). */
export const RADIO_MS = 6000;

/** `key` is shift + eventId: the simulator numbers each shift's events from 1 again. */
export interface RadioMsg { key: string; eventId: number; kind: ScenarioKind; text: string; monitor: MonitorId }
/** `seen` holds RadioMsg keys. */
export interface RadioState { current: RadioMsg | null; queue: RadioMsg[]; seen: string[] }
export type RadioAction =
  | { type: 'push'; eventId: number; shiftId?: number | null; kind: ScenarioKind; text: string; message?: string }
  | { type: 'expire' }
  | { type: 'dismiss' };

export const initialRadio: RadioState = { current: null, queue: [], seen: [] };

/** The monitor a radio call opens. sensorFailure's line does not name the loop, so it opens Shift. */
export function monitorFor(kind: ScenarioKind, message = ''): MonitorId {
  switch (kind) {
    case 'pumpTrip': case 'powerDip': case 'storm': case 'bloom': case 'seawaterTemp': case 'pumpBearing': return 'intake';
    case 'tubeLeak': return 'product';
    case 'vacuumLoss': return 'stages';
    case 'controllerFault': return faultMonitor(message);
    case 'gasCurtailNotice': case 'gasPriceSpike': case 'offgradeOnly': case 'deliveryDelay': case 'fuelContamination': return 'fuel';
    case 'demandChange': case 'sensorFailure': case 'earthquake': case 'tsunami': return 'shift';
  }
}

/** One message at a time; later ones queue; an event already pushed in the same shift is ignored. */
export function radioReducer(s: RadioState, a: RadioAction): RadioState {
  switch (a.type) {
    case 'push': {
      const key = `${a.shiftId ?? '-'}:${a.eventId}`;
      if (s.seen.includes(key)) return s;
      const msg: RadioMsg = { key, eventId: a.eventId, kind: a.kind, text: a.text, monitor: monitorFor(a.kind, a.message) };
      const seen = [...s.seen, key];
      return s.current ? { ...s, seen, queue: [...s.queue, msg] } : { ...s, seen, current: msg };
    }
    case 'expire':
    case 'dismiss': {
      const [next, ...rest] = s.queue;
      return { ...s, current: next ?? null, queue: rest };
    }
  }
}
