/**
 * Turn calculator for N users.
 * For N=2: simple alternating 0,1,0,1,...
 * For N>2: snake draft (round 1 A→B→C, round 2 C→B→A, ...)
 */
export function currentPicker(order: string[], pickCount: number): string {
  const n = order.length;
  if (n === 2) {
    return order[pickCount % 2];
  }
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
