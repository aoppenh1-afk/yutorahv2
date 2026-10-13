// Read-only public-source sample. No model calls or transcript persistence.
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchOfficialVtt } from '../../lib/official-transcript.mjs';
import { parseVtt } from '../../lib/webvtt.mjs';

const startedAt = new Date().toISOString();
const results = [];
for (const page of [1, 21]) {
  const response = await fetch(
    `https://yutorah.org/api/search/get?searchTerm=&getFacets=false&start=${page}`,
    { signal: AbortSignal.timeout(15_000), redirect: 'error' },
  );
  if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
  const catalog = await response.json();
  for (const item of catalog.response.docs.slice(0, 10)) {
    const id = String(item.shiurid);
    const start = performance.now();
    let result;
    try {
      const source = await fetchOfficialVtt(id, new AbortController().signal);
      const cues = source ? parseVtt(source) : [];
      result = {
        status: source ? 'available' : 'missing',
        sourceBytes: source ? Buffer.byteLength(source) : 0,
        sourceWords: cues.reduce((n, c) => n + c.text.split(/\s+/u).filter(Boolean).length, 0),
        durationMinutes: cues.length ? Math.max(...cues.map(c => c.endMs)) / 60000 : null,
      };
    } catch (error) {
      result = { status: 'error', code: error.code ?? error.name, httpStatus: error.status ?? null };
    }
    results.push({ page, id, category: item.mediatypecategory, ...result, fetchMs: Math.round(performance.now() - start) });
    console.log(JSON.stringify(results.at(-1)));
    if (result.httpStatus === 429 || result.httpStatus === 503) break;
    await delay(1000);
  }
  if (results.some(r => r.httpStatus === 429 || r.httpStatus === 503)) break;
}
const summaries = [1, 21].map(page => {
  const rows = results.filter(r => r.page === page);
  return { page, sampled: rows.length, available: rows.filter(r => r.status === 'available').length, missing: rows.filter(r => r.status === 'missing').length, errors: rows.filter(r => r.status === 'error').length };
});
await writeFile(new URL('./transcript-probe.json', import.meta.url), JSON.stringify({
  startedAt, completedAt: new Date().toISOString(),
  method: 'First ten records from catalog pages 1 and 21. Sequential official VTT reads with one-second spacing. No AI, credentials, or persisted transcripts. Not a representative sample or VM throughput measurement.',
  summaries, results,
}, null, 2) + '\n');
console.log(JSON.stringify({ summaries }));
