/**
 * Snake draft turn calculator for N users.
 * Round 1: indices 0, 1, 2, ..., N-1
 * Round 2: N-1, N-2, ..., 0
 * Round 3: 0, 1, 2, ...
 *
 * pickCount is 0-based (0 = first pick not yet made).
 */
export function currentPicker(order: string[], pickCount: number): string {
  const n = order.length;
  const round = Math.floor(pickCount / n);
  const posInRound = pickCount % n;
  const idx = round % 2 === 0 ? posInRound : n - 1 - posInRound;
  return order[idx];
}

export function isDraftComplete(
  order: string[],
  pickCount: number,
  picksPerUser: number,
  backupsPerUser: number
): boolean {
  const totalPicks = order.length * (picksPerUser + backupsPerUser);
  return pickCount >= totalPicks;
}
