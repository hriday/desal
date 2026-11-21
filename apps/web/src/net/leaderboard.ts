import { PublicLeaderboardSchema, type PublicLeaderboard } from '@desal/schema';

/**
 * The gateway serves the public leaderboard over HTTP next to its socket: `wss://h/ws` ->
 * `https://h/api/leaderboard`, `ws://localhost:8081/ws` -> `http://localhost:8081/api/leaderboard`.
 */
export function leaderboardUrl(wsUrl: string): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = `${u.pathname.replace(/\/ws\/?$/, '')}/api/leaderboard`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** GET the board; throws on anything but a 200 with a valid public board (503 means Flink is down). */
export async function fetchLeaderboard(url: string, signal: AbortSignal): Promise<PublicLeaderboard> {
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`leaderboard ${res.status}`);
  return PublicLeaderboardSchema.parse(await res.json());
}
