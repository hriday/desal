/** Exact first-order lag of x toward target over dtS with time constant tauS. */
export const lag = (x: number, target: number, dtS: number, tauS: number): number =>
  x + (target - x) * (1 - Math.exp(-dtS / tauS));
