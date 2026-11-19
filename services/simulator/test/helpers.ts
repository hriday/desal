/** True when every number reachable in obj is finite. */
export function allFinite(obj: unknown): boolean {
  if (typeof obj === 'number') return Number.isFinite(obj);
  if (Array.isArray(obj)) return obj.every(allFinite);
  if (obj !== null && typeof obj === 'object') return Object.values(obj).every(allFinite);
  return true;
}
