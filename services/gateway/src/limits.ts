import { MAX_GAMES_PER_CLIENT, MAX_SOCKETS_PER_CLIENT, NEW_GAME_INTERVAL_MS } from './protocol.js';

/** Per-client caps (a client = one IPv4 address or IPv6 /64, see clients.ts); env-configurable in main.ts. */
export interface PerClientLimits {
  /** Concurrent sockets; extras are closed with 1013. */
  maxSockets: number;
  /** Live games; an extra newGame answers 'capacity'. */
  maxGames: number;
  /** Minimum ms between two newGames. */
  newGameIntervalMs: number;
}

export const DEFAULT_PER_CLIENT: PerClientLimits = {
  maxSockets: MAX_SOCKETS_PER_CLIENT,
  maxGames: MAX_GAMES_PER_CLIENT,
  newGameIntervalMs: NEW_GAME_INTERVAL_MS,
};

interface Client {
  lastNewGame: number;
  /** Games this client started that may still be live: gameId -> when it was started. */
  games: Map<string, number>;
}

/**
 * Per-client game limits: at most one newGame per newGameIntervalMs, and at most maxGames live
 * games. A game counts until it ends, is rejected, or `isLive` says it is gone (no recent status),
 * so a client cannot fill the simulator's 10 slots by opening games and walking away from them.
 */
export class ClientLimits {
  private readonly clients = new Map<string, Client>();
  private readonly owner = new Map<string, string>();

  constructor(
    private readonly now: () => number,
    private readonly limits: Pick<PerClientLimits, 'maxGames' | 'newGameIntervalMs'> = DEFAULT_PER_CLIENT,
  ) {}

  /** May `clientId` start a game now? Prunes its games that `isLive` reports gone. */
  canStart(clientId: string, isLive: (gameId: string, startedAt: number) => boolean): boolean {
    const c = this.clients.get(clientId);
    if (!c) return true;
    for (const [gameId, at] of c.games) if (!isLive(gameId, at)) this.ended(gameId);
    return this.now() - c.lastNewGame >= this.limits.newGameIntervalMs && c.games.size < this.limits.maxGames;
  }

  started(clientId: string, gameId: string): void {
    let c = this.clients.get(clientId);
    if (!c) this.clients.set(clientId, (c = { lastNewGame: 0, games: new Map() }));
    c.lastNewGame = this.now();
    c.games.set(gameId, this.now());
    this.owner.set(gameId, clientId);
  }

  /** The game ended, was rejected, or never started: it no longer counts. */
  ended(gameId: string): void {
    const clientId = this.owner.get(gameId);
    if (clientId === undefined) return;
    this.owner.delete(gameId);
    this.clients.get(clientId)?.games.delete(gameId);
  }

  /** Forget clients with no games whose newGame interval has passed (keeps the map bounded). */
  prune(): void {
    const now = this.now();
    for (const [id, c] of this.clients) {
      if (c.games.size === 0 && now - c.lastNewGame >= this.limits.newGameIntervalMs) this.clients.delete(id);
    }
  }
}
