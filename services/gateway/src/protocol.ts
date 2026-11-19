import { ClientMsgSchema, type ClientMsg, type ServerErrorReason } from '@desal/schema';

/** Largest client message accepted, in bytes; larger ones close the socket. */
export const MAX_MSG_BYTES = 16384;
/**
 * Client messages allowed per socket in any sliding 1 s window; the rest are dropped. 50 leaves
 * room for the UI's "set all stage levels" burst (20 commands at once).
 */
export const MAX_MSGS_PER_S = 50;
/** Concurrent sockets per gateway; extra ones are closed with code 1013 (try again later). */
export const MAX_SOCKETS = 50;
/** How often each bound game gets a heartbeat (the simulator abandons a game after 90 s without one). */
export const HEARTBEAT_MS = 15_000;
/** A game can be resumed if the gateway saw a status for it within this window. */
export const RESUME_WINDOW_MS = 90_000;

/** WebSocket close codes used by the gateway. */
export const CLOSE_TOO_LARGE = 1009;
export const CLOSE_TRY_AGAIN_LATER = 1013;
export const CLOSE_GOING_AWAY = 1001;

export type ParseResult = { ok: true; msg: ClientMsg } | { ok: false; reason: ServerErrorReason };

/** Parse one client text message: non-JSON and schema-invalid both answer 'invalid message'. */
export function parseClientMsg(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid message' };
  }
  const r = ClientMsgSchema.safeParse(json);
  return r.success ? { ok: true, msg: r.data } : { ok: false, reason: 'invalid message' };
}
