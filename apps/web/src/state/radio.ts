import type { ScenarioKind } from '@desal/schema';
import { faultMonitor, type MonitorId } from '../alarms/rules';

/** How long a radio message stays up (ms). */
export const RADIO_MS = 6000;

export interface RadioMsg { eventId: number; kind: ScenarioKind; text: string; monitor: MonitorId }
export interface RadioState { current: RadioMsg | null; queue: RadioMsg[]; seen: number[] }
export type RadioAction =
  | { type: 'push'; eventId: number; kind: ScenarioKind; text: string; message?: string }
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
    case 'gasCurtailNotice': case 'gasPriceSpike': case 'offgradeOnly': case 'deliveryDelay': return 'fuel';
    case 'demandChange': case 'sensorFailure': return 'shift';
  }
}

/** One message at a time; later ones queue; a repeated eventId is ignored. */
export function radioReducer(s: RadioState, a: RadioAction): RadioState {
  switch (a.type) {
    case 'push': {
      if (s.seen.includes(a.eventId)) return s;
      const msg: RadioMsg = { eventId: a.eventId, kind: a.kind, text: a.text, monitor: monitorFor(a.kind, a.message) };
      const seen = [...s.seen, a.eventId];
      return s.current ? { ...s, seen, queue: [...s.queue, msg] } : { ...s, seen, current: msg };
    }
    case 'expire':
    case 'dismiss': {
      const [next, ...rest] = s.queue;
      return { ...s, current: next ?? null, queue: rest };
    }
  }
}
