import type { GameMode } from '@desal/schema';

/** How hard a game mode is on the director: how often shifts are hell shifts, and how often disasters strike. */
export interface DifficultyProfile {
  /** Every shift is a hell shift (Hard), not only the occasional one (Normal). */
  hellEveryShift: boolean;
  /** Chance per shift that a disaster is planned. */
  disasterChance: number;
  /** The first shift a disaster can happen in. */
  disasterFromShift: number;
  /** Chance per shift that low motive steam is planned. */
  lowSteamChance: number;
  /** The first shift low motive steam can happen in. */
  lowSteamFromShift: number;
}

export const PROFILES: Record<GameMode, DifficultyProfile> = {
  normal: { hellEveryShift: false, disasterChance: 0.08, disasterFromShift: 3, lowSteamChance: 0.15, lowSteamFromShift: 2 },
  hard: { hellEveryShift: true, disasterChance: 0.4, disasterFromShift: 2, lowSteamChance: 0.3, lowSteamFromShift: 2 },
};

/** Salt for the disaster draw, so it never consumes the game seed. */
export const DISASTER_SALT = 0xd15a5;
/** The plant-minute window a disaster's earliestMinute is drawn from. */
export const DISASTER_MINUTE = [90, 300] as const;

/** Salt for the low-steam draws (planning and fire-time params), so they never consume the game seed. */
export const LOW_STEAM_SALT = 0x57ea3;
/** The plant-minute window a planned low steam's earliestMinute is drawn from. */
export const LOW_STEAM_MINUTE = [60, 360] as const;
