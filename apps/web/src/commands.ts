import type { ClientMsg, Command, CrewJob, FuelKind, LoopId, LoopMode, PumpId, RestartStep } from '@desal/schema';

type Chemical = Extract<Command, { type: 'setDose' }>['chemical'];

export const setpoint = (loop: LoopId, value: number): Command => ({ type: 'setSetpoint', loop, value });
export const output = (loop: LoopId, value: number): Command => ({ type: 'setOutput', loop, value });
export const loopMode = (loop: LoopId, mode: LoopMode): Command => ({ type: 'setLoopMode', loop, mode });
export const pump = (pumpId: PumpId, action: 'start' | 'stop'): Command => ({ type: 'pump', pumpId, action });
export const dose = (chemical: Chemical, mgL: number): Command => ({ type: 'setDose', chemical, mgL });
export const ballCleaning = (on: boolean): Command => ({ type: 'ballCleaning', on });
export const divert = (on: boolean): Command => ({ type: 'divertToDrain', on });
export const selectFuel = (fuel: FuelKind): Command => ({ type: 'selectFuel', fuel });
export const orderFuel = (tonnes: number): Command => ({ type: 'orderFuel', tonnes });
export const restart = (): Command => ({ type: 'restart' });
export const restartStep = (step: RestartStep): Command => ({ type: 'restartStep', step });
export const acidClean = (): Command => ({ type: 'acidClean' });
export const overhaul = (pumpId: PumpId): Command => ({ type: 'overhaulPump', pumpId });
export const dispatchCrew = (job: CrewJob): Command => ({ type: 'dispatchCrew', job });
export const manualTrip = (): Command => ({ type: 'manualTrip' });
export const pause = (): Command => ({ type: 'pause' });
export const resume = (): Command => ({ type: 'resume' });
export const startShift = (mode: LoopMode): Command => ({ type: 'startShift', mode });
export const quit = (): Command => ({ type: 'quitGame' });

const isLevel = (loop: LoopId) => loop.startsWith('level');

/** Auto: a setpoint. Manual: an output, except level loops, which stay setpoint-driven. */
export function controlFor(mode: LoopMode, loop: LoopId, value: number): Command {
  return mode === 'manual' && !isLevel(loop) ? output(loop, value) : setpoint(loop, value);
}

/** Pending-entry key: command type plus its target, e.g. `setSetpoint:tbt`, `pump:P-101`, `setDose:chlorine`. */
export function commandKey(cmd: Command): string {
  switch (cmd.type) {
    case 'setSetpoint':
    case 'setOutput':
    case 'setLoopMode':
      return `${cmd.type}:${cmd.loop}`;
    case 'pump':
    case 'overhaulPump':
      return `${cmd.type}:${cmd.pumpId}`;
    case 'setDose':
      return `${cmd.type}:${cmd.chemical}`;
    case 'restartStep':
      return `${cmd.type}:${cmd.step}`;
    default:
      return cmd.type;
  }
}

/** Build a `cmd` message with a fresh commandId so a later rejection can be matched to this send. */
export function cmdMsg(command: Command): { msg: ClientMsg; commandId: string } {
  const commandId = crypto.randomUUID();
  return { msg: { t: 'cmd', command, commandId }, commandId };
}
