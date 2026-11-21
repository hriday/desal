import type { GameMode } from '@desal/schema';

/** How hard a game mode is on the director: how often shifts are hell shifts, and how often disasters strike. */
export interface DifficultyProfile {
  /** Every shift is a hell shift (Hard), not only the occasional one (Normal). */
  hellEveryShift: boolean;
  /** Chance per shift that a disaster is planned. */
  disasterChance: number;
  /** The first shift a disaster can happen in. */
  disasterFromShift: number;
}

export const PROFILES: Record<GameMode, DifficultyProfile> = {
  normal: { hellEveryShift: false, disasterChance: 0.08, disasterFromShift: 3 },
  hard: { hellEveryShift: true, disasterChance: 0.4, disasterFromShift: 2 },
};

/** Salt for the disaster draw, so it never consumes the game seed. */
export const DISASTER_SALT = 0xd15a5;
/** The plant-minute window a disaster's earliestMinute is drawn from. */
export const DISASTER_MINUTE = [90, 300] as const;
