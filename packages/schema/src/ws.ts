import { z } from 'zod';
import { CommandSchema, GameModeSchema } from './commands.js';
import { PlantEventSchema } from './events.js';
import { PlantStatusSchema } from './status.js';
import { ShiftReportSchema } from './flink.js';

const num = z.number().finite();

// Client -> gateway.
export const ClientMsgSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('newGame'), mode: GameModeSchema.default('normal') }),
  z.object({ t: z.literal('resume'), gameId: z.uuid() }),
  // commandId is optional: the gateway uses it as the envelope commandId so rejections can be matched to a send.
  z.object({ t: z.literal('cmd'), command: CommandSchema, commandId: z.uuid().optional() }),
  z.object({ t: z.literal('ping') }),
]);
export type ClientMsg = z.infer<typeof ClientMsgSchema>;

export const ServerErrorReasonSchema = z.enum([
  'game ended',
  'no game',
  'capacity',
  'invalid message',
  'rate limited',
  'too large',
  'already in a game',
]);
export type ServerErrorReason = z.infer<typeof ServerErrorReasonSchema>;

// Gateway -> client.
export const ServerMsgSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('game'), gameId: z.uuid() }),
  z.object({ t: z.literal('status'), status: PlantStatusSchema }),
  z.object({ t: z.literal('frame'), tick: num, plantTime: num, readings: z.record(z.string(), num) }),
  z.object({ t: z.literal('event'), event: PlantEventSchema }),
  z.object({ t: z.literal('shiftReport'), report: ShiftReportSchema }),
  z.object({ t: z.literal('rank'), allTime: z.number().int(), today: z.number().int().nullable() }),
  z.object({ t: z.literal('error'), reason: ServerErrorReasonSchema }),
  z.object({ t: z.literal('pong') }),
]);
export type ServerMsg = z.infer<typeof ServerMsgSchema>;
