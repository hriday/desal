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

export const TelemetryReadingSchema = z.object({
  gameId: z.uuid(),
  sensorId: z.string(),
  unitId: UnitIdSchema,
  shiftId: num,
  tick: num,
  plantTime: num,
  value: num,
});
export type TelemetryReading = z.infer<typeof TelemetryReadingSchema>;
