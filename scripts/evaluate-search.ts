import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const value = (flag: string) => {
  const index = args.indexOf(flag);
  return index < 0 ? '' : (args[index + 1] ?? '');
};
const corpus = JSON.parse(
  readFileSync('tests/fixtures/search-relevance.json', 'utf8'),
) as { query: string; relevant: string[]; distractors: string[] }[];
async function load(root: string, path: string) {
  const result = await build({
    entryPoints: [resolve(root, path)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
  });
  return import(
    'data:text/javascript;base64,' +
      Buffer.from(result.outputFiles[0].text).toString('base64')
  );
}
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function evaluate(root: string) {
  const search = (await load(
    root,
    'lib/yutorah.ts',
  )) as typeof import('../lib/yutorah.js');
  const ranking = (await load(
    root,
    'packages/yutorah-core/src/search-ranking.ts',
  )) as typeof import('../packages/yutorah-core/src/search-ranking.js');
  const document = (title: string) => search.normalize({ shiurid: 1, shiurtitle: title });
  let top1 = 0,
    reciprocalRank = 0,
    relevantFound = 0,
    relevantTotal = 0;
  const failures: unknown[] = [];
  for (const entry of corpus) {
    const plan = search.parseSearch(entry.query, { scope: 'title' });
    const score = ranking.createRelevanceScorer(plan.term);
    const candidates = [...entry.distractors, ...entry.relevant]
      .filter((title) => search.matchesPlan(document(title), plan))
      .map((title) => ({ title, score: score(document(title)) }))
      .sort((a, b) => b.score - a.score);
    const position = candidates.findIndex(({ title }) =>
      entry.relevant.includes(title),
    );
    if (position === 0) top1++;
    if (position >= 0) reciprocalRank += 1 / (position + 1);
    relevantFound += candidates.filter(({ title }) =>
      entry.relevant.includes(title),
    ).length;
    relevantTotal += entry.relevant.length;
    if (position !== 0)
      failures.push({
        query: entry.query,
        term: plan.term,
        top: candidates[0]?.title ?? null,
      });
  }
  const documents = Array.from({ length: 2000 }, (_, i) => ({
    ...document(
      [
        'Coffee on Shabbos',
        'Kidney Donation',
        'Lashon Hara and Medical Ethics',
        'General Halacha',
      ][i % 4],
    ),
    description:
      'A discussion of prayer, medicine, ethics, daily life and practical questions. '.repeat(
        3,
      ),
    topics: ['Halacha', 'Practical Questions'],
    series: 'Weekly Halacha',
    teacher: 'Rabbi Example',
  }));
  const score = ranking.createRelevanceScorer('coffee shabbos');
  let checksum = 0;
  for (const doc of documents) checksum += score(doc);
  const scoreTimes: number[] = [];
  for (let pass = 0; pass < 5; pass++) {
    const started = performance.now();
    for (const doc of documents) checksum += score(doc);
    scoreTimes.push(performance.now() - started);
  }
  const directory = {
    teachers: Array.from({ length: 1000 }, (_, i) => ({
      id: i + 1,
      name: `Rabbi Teacher${i} Example${i}`,
      firstName: `Teacher${i}`,
      lastName: `Example${i}`,
      count: 1,
      image: '',
    })),
    topics: Array.from({ length: 500 }, (_, i) => ({
      id: i + 1,
      name: `Topic ${i}`,
      count: 1,
      group: 'Halacha',
    })),
    series: Array.from({ length: 500 }, (_, i) => ({
      id: i + 1,
      name: `Series ${i}`,
      count: 1,
      description: '',
      image: '',
    })),
    groups: [],
  };
  const parseTimes: number[] = [];
  search.parseSearch('coffee on shabbos', {}, directory);
  for (let pass = 0; pass < 5; pass++) {
    const started = performance.now();
    for (let i = 0; i < 40; i++)
      search.parseSearch(
        i % 2 ? 'coffee on shabbos' : 'perek kirah',
        {},
        directory,
      );
    parseTimes.push(performance.now() - started);
  }
  return {
    cases: corpus.length,
    top1,
    mrr: reciprocalRank / corpus.length,
    recall: relevantFound / relevantTotal,
    ranking2000MedianMs: median(scoreTimes),
    parse40MedianMs: median(parseTimes),
    failures,
    checksum,
  };
}
const baseline = value('--baseline')
  ? await evaluate(value('--baseline'))
  : undefined;
const current = await evaluate('.');
const report = {
  measuredAt: new Date().toISOString(),
  scope:
    'Offline, curated subject/relevance fixtures and local CPU benchmarks. No production latency claim.',
  baseline,
  current,
  speedup: baseline
    ? {
        ranking: baseline.ranking2000MedianMs / current.ranking2000MedianMs,
        parsing: baseline.parse40MedianMs / current.parse40MedianMs,
      }
    : undefined,
};
if (value('--output'))
  writeFileSync(value('--output'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (current.top1 !== current.cases) process.exitCode = 1;
