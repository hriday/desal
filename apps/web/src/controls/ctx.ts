import type { Command, LoopId, LoopMode, PlantStatus } from '@desal/schema';
import type { PendingEntry } from '../state/store';

/** What every control needs: the plant's reported state, what is in flight, and a way to send. */
export interface ControlCtx {
  status: PlantStatus | null;
  pending?: ReadonlyMap<string, PendingEntry>;
  /** Sends one command; true when it went out (only then is it recorded as pending). */
  send?: (command: Command) => boolean;
}

/** Nothing can be sent before the first status, or without a sender. */
export const canSend = (c: ControlCtx): boolean => c.status !== null && typeof c.send === 'function';

export const pendingCommand = (c: ControlCtx, key: string): Command | undefined => c.pending?.get(key)?.command;

/**
 * The mode a loop's control works in: Manual plant mode puts every loop in manual; in Auto a loop
 * switched to manual takes outputs too (the simulator accepts setOutput only for a loop in manual).
 */
export function effectiveMode(st: PlantStatus | null, loop: LoopId): LoopMode {
  if (st?.controlMode === 'manual') return 'manual';
  return st?.loops?.[loop]?.mode === 'manual' ? 'manual' : 'auto';
}
