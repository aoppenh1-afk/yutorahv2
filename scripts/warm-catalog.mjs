import { parseArgs } from 'node:util';
import { runCatalogWarm } from './catalog-runner.mjs';
import { appendFile } from 'node:fs/promises';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:5173' },
    collections: { type: 'string', default: '12' },
    teachers: { type: 'string', default: '4' },
    'max-minutes': { type: 'string', default: '6' },
  },
});
const base = new URL(values.url);
const token = process.env.TRENDING_REFRESH_TOKEN;
const collections = Number(values.collections),
  teachers = Number(values.teachers),
  minutes = Number(values['max-minutes']);
if (
  !['http:', 'https:'].includes(base.protocol) ||
  !token ||
  !Number.isSafeInteger(collections) ||
  collections < 0 ||
  collections > 200 ||
  !Number.isSafeInteger(teachers) ||
  teachers < 0 ||
  teachers > 50 ||
  !Number.isFinite(minutes) ||
  minutes < 1 ||
  minutes > 30
)
  throw new Error('Set TRENDING_REFRESH_TOKEN and choose valid cache budgets.');
try {
  const result = await runCatalogWarm({
    base,
    token,
    collections,
    teachers,
    maxRuntimeMs: minutes * 60000,
    report: (event) => console.log(JSON.stringify(event)),
  });
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `Catalog refresh: ${JSON.stringify(result)}. Pending work resumes from saved checkpoints.\n`,
    );
  if (result.partial) process.exitCode = 2;
} catch (error) {
  const reason = /^http-\d+$|^network$/.test(error.message)
    ? error.message
    : 'invalid-response';
  console.error(`Catalog refresh could not load its plan: ${reason}.`);
  process.exitCode = 1;
}
