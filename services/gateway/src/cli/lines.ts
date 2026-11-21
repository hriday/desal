import { CommandSchema, PumpIdSchema, RestartStepSchema, type Command } from '@desal/schema';

export type LineResult = { ok: true; command: Command } | { ok: false; error: string };

export const HELP = [
  'startShift auto|manual | setpoint <loop> <value> | output <loop> <value> | pump <id> start|stop',
  'trip | restart | step <vacuum|recirc|ignition|ramp> | order <tonnes> | pause | resume | quit',
  'or raw JSON, e.g. {"type":"ballCleaning","on":true}',
].join('\n');

/** Turn one typed line (a short word command, or a raw JSON Command) into a validated Command. */
export function parseLine(line: string): LineResult {
  const text = line.trim();
  if (text.startsWith('{')) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: 'not valid JSON' };
    }
    const r = CommandSchema.safeParse(json);
    return r.success ? { ok: true, command: r.data } : { ok: false, error: 'not a valid command' };
  }
  const [word = '', a, b, ...rest] = text.split(/\s+/);
  const arity: Record<string, number> = { startShift: 1, setpoint: 2, output: 2, pump: 2, step: 1, order: 1 };
  const num = (s: string | undefined) => (s !== undefined && s !== '' && Number.isFinite(Number(s)) ? Number(s) : NaN);
  let candidate: unknown;
  switch (word) {
    case 'startShift':
      candidate = { type: 'startShift', mode: a };
      break;
    case 'setpoint':
      candidate = { type: 'setSetpoint', loop: a, value: num(b) };
      break;
    case 'output':
      candidate = { type: 'setOutput', loop: a, value: num(b) };
      break;
    case 'pump':
      candidate = { type: 'pump', pumpId: PumpIdSchema.safeParse(a).success ? a : a?.toUpperCase(), action: b };
      break;
    case 'trip':
      candidate = { type: 'manualTrip' };
      break;
    case 'restart':
      candidate = { type: 'restart' };
      break;
    case 'step':
      candidate = { type: 'restartStep', step: RestartStepSchema.safeParse(a).success ? a : undefined };
      break;
    case 'order':
      candidate = { type: 'orderFuel', tonnes: num(a) };
      break;
    case 'pause':
      candidate = { type: 'pause' };
      break;
    case 'resume':
      candidate = { type: 'resume' };
      break;
    case 'quit':
      candidate = { type: 'quitGame' };
      break;
    default:
      return { ok: false, error: `unknown command "${word}"` };
  }
  if (rest.length + (b !== undefined ? 1 : 0) + (a !== undefined ? 1 : 0) > (arity[word] ?? 0)) return { ok: false, error: 'too many arguments' };
  const r = CommandSchema.safeParse(candidate);
  return r.success ? { ok: true, command: r.data } : { ok: false, error: `bad arguments for "${word}"` };
}
