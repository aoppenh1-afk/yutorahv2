import { parseArgs } from 'node:util';
import { trendingPeriods, type DiscoveryData } from '../lib/trending';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:3000' },
    period: { type: 'string' },
    minutes: { type: 'string', default: '0' },
    'max-passes': { type: 'string', default: '20000' },
  },
});
const base = new URL(values.url!);
const minutes = values.minutes!;
const maxPasses = Number(values['max-passes']);
const periods = trendingPeriods
  .map((p) => p.value)
  .filter((p) => !values.period || values.period === p);
if (
  !['http:', 'https:'].includes(base.protocol) ||
  !periods.length ||
  !['0', '10', '20', '30'].includes(minutes) ||
  !Number.isSafeInteger(maxPasses) ||
  maxPasses < 1 ||
  maxPasses > 20000
)
  throw new RangeError(
    'Choose a valid URL, period, minutes and 1–20000 passes.',
  );

let passes = 0;
for (const period of periods) {
  const url = new URL('/api/discover', base);
  url.search = new URLSearchParams({ period, minutes }).toString();
  let complete = false;
  while (passes < maxPasses) {
    passes++;
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (response.status === 503) {
      const seconds = Number(response.headers.get('Retry-After')) || 5;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(30, Math.max(3, seconds)) * 1000),
      );
      continue;
    }
    if (!response.ok)
      throw new Error(
        `${period}: server returned ${response.status}; rerun to resume the saved cursor.`,
      );
    const data = (await response.json()) as DiscoveryData;
    if (data.period !== period || data.minutes !== Number(minutes))
      throw new Error('The server returned a different chart.');
    if (data.stale)
      throw new Error(
        `${period}: upstream unavailable; the cached chart was preserved.`,
      );
    console.log(
      data.refreshing
        ? `${period}: rebuilding the shared index; the completed chart is still available`
        : `${period}: ${data.sampled}/${data.libraryTotal ?? data.total} indexed${data.partial ? '' : ', complete'}`,
    );
    if (!data.partial && !data.refreshing) {
      complete = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 3100));
  }
  if (!complete) {
    console.log('Pass limit reached. Rerun this command to resume.');
    process.exitCode = 2;
    break;
  }
}
