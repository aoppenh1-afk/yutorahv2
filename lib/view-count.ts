/** Missing counters must remain distinct from a genuine zero. */
export function viewCount(value: unknown): number | undefined {
  const count =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

export function viewCountLabel(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'view' : 'views'}`;
}
