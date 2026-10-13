import { parseArgs } from 'node:util';
import { trendingPeriods } from '../lib/trending';
import { runTrendingWarm } from './trending-runner';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:3000' },
    period: { type: 'string' },
    refresh: { type: 'boolean', default: false },
    minutes: { type: 'string', default: '0' },
    'max-passes': { type: 'string', default: '100' },
    'max-minutes': { type: 'string', default: '20' },
  },
});
const base = new URL(values.url!);
const token = process.env.TRENDING_REFRESH_TOKEN;
if (values.refresh && !token)
  throw new Error(
    'Set TRENDING_REFRESH_TOKEN to use the protected refresh endpoint.',
  );
const minutes = values.minutes!;
const maxPasses = Number(values['max-passes']);
const maxMinutes = Number(values['max-minutes'] ?? '20');
const periods = trendingPeriods
  .map((p) => p.value)
  .filter((p) => !values.period || values.period === p);
if (
  !['http:', 'https:'].includes(base.protocol) ||
  !periods.length ||
  !['0', '10', '20', '30'].includes(minutes) ||
  !Number.isSafeInteger(maxPasses) ||
  maxPasses < 1 ||
  maxPasses > 20000 ||
  !Number.isFinite(maxMinutes) ||
  maxMinutes < 1 ||
  maxMinutes > 120
)
  throw new RangeError(
    'Choose a valid URL, period, minutes, 1–20000 passes and 1–120 runtime minutes.',
  );

const result = await runTrendingWarm({
  base,
  token,
  refresh: values.refresh!,
  minutes: Number(minutes),
  periods,
  maxPasses,
  maxRuntimeMs: maxMinutes * 60000,
});
if (result === 'pass-limit') process.exitCode = 2;
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `Trending refresh outcome: ${result}. Deferred scans keep their persisted checkpoint; no completeness claim is made.\n`,
  );
}
