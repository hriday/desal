import { z } from 'zod';
import { CommandSchema } from './commands.js';
import { PlantEventSchema } from './events.js';
import { PlantStatusSchema } from './status.js';

const num = z.number().finite();

// Client -> gateway.
export const ClientMsgSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('newGame') }),
  z.object({ t: z.literal('resume'), gameId: z.uuid() }),
  z.object({ t: z.literal('cmd'), command: CommandSchema }),
  z.object({ t: z.literal('ping') }),
]);
export type ClientMsg = z.infer<typeof ClientMsgSchema>;

// Gateway -> client.
export const ServerMsgSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('game'), gameId: z.uuid() }),
  z.object({ t: z.literal('status'), status: PlantStatusSchema }),
  z.object({ t: z.literal('frame'), tick: num, plantTime: num, readings: z.record(z.string(), num) }),
  z.object({ t: z.literal('event'), event: PlantEventSchema }),
  z.object({ t: z.literal('error'), reason: z.string() }),
  z.object({ t: z.literal('pong') }),
]);
export type ServerMsg = z.infer<typeof ServerMsgSchema>;
