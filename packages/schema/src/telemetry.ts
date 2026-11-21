import { z } from 'zod';

const num = z.number().finite();

export const UnitIdSchema = z.enum([
  'intake',
  'pretreat',
  'heater',
  'stages',
  'brine',
  'vacuum',
  'product',
  'fuel',
]);
export type UnitId = z.infer<typeof UnitIdSchema>;

/**
 * Readings per tick per game: one per simulator sensor (SENSOR_IDS in services/simulator/src/emit.ts,
 * whose test pins it to this). The gateway treats a tick's frame as complete at this many.
 */
export const TELEMETRY_SENSOR_COUNT = 128;

export const TelemetryReadingSchema = z.object({
  gameId: z.uuid(),
  /** Restores from a snapshot so far (see the events' epoch); tick can rewind when it goes up. */
  epoch: z.number().int().min(0),
  sensorId: z.string(),
  unitId: UnitIdSchema,
  shiftId: num,
  tick: num,
  plantTime: num,
  value: num,
});
export type TelemetryReading = z.infer<typeof TelemetryReadingSchema>;
