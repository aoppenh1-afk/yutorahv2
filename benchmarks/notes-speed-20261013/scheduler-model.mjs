// Exercises the actual queue scheduler with virtual time and synthetic jobs.
// These scenarios explain scheduling limits; they are not provider benchmarks.
import { setImmediate as nextTurn } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { runNotesPool } from '../../deploy/notes-only/pool.mjs';

async function scenario({ name, candidates, yieldEvery = 4, noteMs = 60_000, concurrency = 10, paceMs = 2000 }) {
  let clock = 0;
  let ended = false;
  const timers = [];
  const events = [];
  const jobs = Array.from({ length: candidates }, (_, index) => ({ id: String(index + 1), attempts: 1 }));
  function timer(ms, signal) {
    return new Promise((resolve, reject) => {
      const entry = { at: clock + ms, active: true, resolve: () => { entry.active = false; signal?.removeEventListener('abort', abort); resolve(); } };
      const abort = () => { entry.active = false; reject(new Error('aborted')); };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      timers.push(entry);
    });
  }
  let result;
  let failure;
  const run = runNotesPool({
    queue: { claim: () => jobs.shift() ?? null, recheckMissing() {}, retry() {}, blocked() {} },
    signal: new AbortController().signal,
    concurrency, paceMs, follow: true, runUntil: 1_800_000,
    now: () => clock,
    sleep: timer,
    log: event => events.push({ ...event, at: clock }),
    processJob: async job => {
      const available = Number(job.id) % yieldEvery === 0;
      await timer(available ? noteMs : 250);
      return available ? 'completed' : 'missing';
    },
  }).then(value => { result = value; ended = true; }, error => { failure = error; ended = true; });
  for (let step = 0; !ended && step < 100_000; step++) {
    await nextTurn();
    if (ended) break;
    const pending = timers.filter(entry => entry.active).sort((a, b) => a.at - b.at);
    if (!pending.length) throw new Error('Virtual scheduler stalled');
    clock = pending[0].at;
    for (const entry of pending) if (entry.at === clock) entry.resolve();
  }
  if (!ended) throw new Error('Virtual scheduler exceeded its bound');
  await run;
  if (failure) throw failure;
  const completed = events.filter(event => event.status === 'completed');
  const missing = events.filter(event => event.status === 'missing');
  return { name, assumptions: { candidates, yieldEvery, noteMs, concurrency, paceMs }, simulatedSeconds: clock / 1000,
    notes: completed.length, missing: missing.length, lastCandidateSettledSeconds: Math.max(...events.filter(event => ['completed', 'missing'].includes(event.status)).map(event => event.at)) / 1000,
    notesPerHour: Math.round(completed.length * 3_600_000 / clock), result };
}

const scenarios = [
  { name: 'Current discovery-sized queue, 25% transcripts', candidates: 600 },
  { name: 'Larger ready inventory, same candidate pacing', candidates: 3000 },
  { name: 'Prefetched transcript-ready jobs, same pacing', candidates: 3000, yieldEvery: 1 },
  { name: 'Two usable lanes with ready transcripts', candidates: 3000, yieldEvery: 1, concurrency: 2 },
];
const results = [];
for (const config of scenarios) results.push(await scenario(config));
const artifact = { method: 'Actual runNotesPool with virtual time, no network, models, database, retries, or memory admission. Synthetic note duration 60 seconds; missing source lookup 250 ms. Does not establish the live bottleneck or predict sustained free-provider capacity.', results };
await writeFile(new URL('./scheduler-model.json', import.meta.url), JSON.stringify(artifact, null, 2) + '\n');
console.log(JSON.stringify(artifact, null, 2));
