import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { advanceSources, type SourceTranscript } from '../lib/sources';
import type { LinkerBody, SefariaFetch } from '../lib/sefaria';
import type { SearchDatabase, SearchStatement } from '../lib/search-storage';

type Sample = SourceTranscript & {
  shiurId: string;
  expectedRefs: string[];
  unavailableCitations: string[];
};
type Recording = {
  recordedAt: string;
  linker: Record<string, Partial<Record<'en' | 'he', LinkerBody>>>;
  metadata: Record<string, unknown>;
  metadataStatus?: Record<string, number>;
};
const corpusPath = resolve('tests/fixtures/sources-corpus.json');
const recordingPath = resolve('tests/fixtures/sources-corpus-sefaria.json');

export async function evaluateSourcesCorpus(live = false) {
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as {
    samples: Sample[];
    scope: string;
    reviewedBy: string;
  };
  const recording: Recording =
    live && !existsSync(recordingPath)
      ? { recordedAt: new Date().toISOString(), linker: {}, metadata: {} }
      : JSON.parse(readFileSync(recordingPath, 'utf8'));
  const evaluate = async (sample: Sample) => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(readFileSync('drizzle/0004_sources.sql', 'utf8'));
    const prepare = (sql: string, params: unknown[] = []): SearchStatement => ({
      bind: (...values) => prepare(sql, values),
      first: async <T>() =>
        (sqlite.prepare(sql).get(...(params as never[])) as T) || null,
      all: async <T>() => ({
        results: sqlite.prepare(sql).all(...(params as never[])) as T[],
      }),
      run: async () => ({
        meta: {
          changes: Number(
            sqlite.prepare(sql).run(...(params as never[])).changes,
          ),
        },
      }),
    });
    const db: SearchDatabase = {
      prepare,
      batch: async (statements) => Promise.all(statements.map((s) => s.run())),
    };
    let language: 'en' | 'he' = 'en';
    const fetcher: SefariaFetch = async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      if (url.pathname === '/api/find-refs')
        language = JSON.parse(init!.body as string).lang;
      const ref = url.pathname.startsWith('/api/ref/')
        ? decodeURIComponent(url.pathname.slice('/api/ref/'.length))
        : null;
      if (
        !live ||
        (ref !== null
          ? Object.hasOwn(recording.metadata, ref)
          : url.pathname === '/api/find-refs' &&
            recording.linker[sample.shiurId]?.[language])
      ) {
        if (ref !== null) {
          if (
            !Object.hasOwn(recording.metadata, ref) &&
            !recording.metadataStatus?.[ref]
          )
            throw new Error(`Missing recorded metadata: ${ref}`);
          return Response.json(recording.metadata[ref] || {}, {
            status: recording.metadataStatus?.[ref] || 200,
          });
        }
        const body = recording.linker[sample.shiurId]?.[language];
        if (!body)
          throw new Error(
            `Missing recorded ${language} model: ${sample.shiurId}`,
          );
        return Response.json({ body });
      }
      const response = await fetch(input, init);
      const data = await response
        .clone()
        .json()
        .catch(() => null);
      if (ref !== null && (response.status === 404 || (response.ok && data)))
        recording.metadata[ref] =
          response.status === 404 ? { is_ref: false } : data;
      if (ref !== null)
        (recording.metadataStatus ||= {})[ref] =
          response.status === 404 ? 200 : response.status;
      const body = data?.result?.body || data?.body;
      if (body) (recording.linker[sample.shiurId] ||= {})[language] = body;
      if (live)
        writeFileSync(recordingPath, JSON.stringify(recording, null, 2) + '\n');
      return response;
    };
    const resultCase = (accepted: string[], error?: string) => ({
      shiurId: sample.shiurId,
      expected: sample.expectedRefs,
      accepted,
      incorrect: accepted.filter((ref) => !sample.expectedRefs.includes(ref)),
      missed: sample.expectedRefs.filter((ref) => !accepted.includes(ref)),
      error,
    });
    let partial: string[] = [];
    try {
      let failures = 0;
      for (let pass = 0; pass < 150; pass++) {
        let result;
        try {
          result = await advanceSources(db, sample, fetcher);
          failures = 0;
        } catch (error) {
          if (!live || ++failures > 5) throw error;
          process.stderr.write(
            `Retrying ${sample.shiurId} after upstream failure\n`,
          );
          await new Promise((resolve) => setTimeout(resolve, 2000 * failures));
          continue;
        }
        if (result.status === 'ready') {
          const accepted = result.sources.map((s) => s.ref);
          return {
            error: undefined as string | undefined,
            shiurId: sample.shiurId,
            expected: sample.expectedRefs,
            accepted,
            incorrect: accepted.filter(
              (ref) => !sample.expectedRefs.includes(ref),
            ),
            missed: sample.expectedRefs.filter(
              (ref) => !accepted.includes(ref),
            ),
            omissionCounts: result.omissionCounts,
          };
        }
        partial = result.sources.map((s) => s.ref);
        if (live) await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      throw new Error(`Sources did not complete: ${sample.shiurId}`);
    } catch (error) {
      if (
        !live &&
        !(
          error instanceof Error &&
          error.message === 'Sefaria is temporarily unavailable.'
        )
      )
        throw error;
      return resultCase(
        partial,
        error instanceof Error ? error.message : 'Source evaluation failed',
      );
    } finally {
      sqlite.close();
    }
  };
  // Three concurrent transcripts bound load on Sefaria; the replay uses the identical public interface.
  const cases: Awaited<ReturnType<typeof evaluate>>[] = [];
  const pending = [...corpus.samples];
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (pending.length) {
        const result = await evaluate(pending.shift()!);
        cases.push(result);
        if (live)
          process.stderr.write(
            `Evaluated ${result.shiurId}: ${result.accepted.length} accepted, ${result.incorrect.length} incorrect, ${result.missed.length} missed\n`,
          );
      }
    }),
  );
  cases.sort((a, b) => a.shiurId.localeCompare(b.shiurId));
  if (live)
    writeFileSync(recordingPath, JSON.stringify(recording, null, 2) + '\n');
  const expected = cases.reduce((n, c) => n + c.expected.length, 0);
  const accepted = cases.reduce((n, c) => n + c.accepted.length, 0);
  const incorrect = cases.reduce((n, c) => n + c.incorrect.length, 0);
  const missed = cases.reduce((n, c) => n + c.missed.length, 0);
  return {
    scope: corpus.scope,
    reviewedBy: corpus.reviewedBy,
    recordedAt: recording.recordedAt,
    sampleCount: cases.length,
    expected,
    accepted,
    incorrect,
    missed,
    precision: accepted ? (accepted - incorrect) / accepted : null,
    recall: expected ? (expected - missed) / expected : null,
    unavailableCitations: corpus.samples.reduce(
      (n, s) => n + s.unavailableCitations.length,
      0,
    ),
    failedSamples: cases.filter((c) => c.error).length,
    cases,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const report = await evaluateSourcesCorpus(process.argv.includes('--record'));
  const output = process.argv.indexOf('--output');
  if (output !== -1)
    writeFileSync(
      process.argv[output + 1],
      JSON.stringify(report, null, 2) + '\n',
    );
  console.log(JSON.stringify(report, null, 2));
}
