import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fetchOfficialVtt } from '../lib/official-transcript.mjs';

const execFile = promisify(execFileCallback);
const signal = new AbortController().signal;
const outOfOrder =
  'WEBVTT\n\n00:00:02.000 --> 00:00:04.000\nFirst\n\n00:00:01.000 --> 00:00:03.000\nSecond\n';
const fetchResponse = (response) => async () => response;

void test('official transcript transport accepts unordered cues and retains the raw source', async () => {
  assert.equal(
    await fetchOfficialVtt(
      '42',
      signal,
      fetchResponse(new Response(outOfOrder)),
    ),
    outOfOrder,
  );
});

void test('transcript validation errors have a permanent code, including invalid encoding and limits', async () => {
  for (const body of [
    '<html>challenge</html>',
    'WEBVTT\n\nbad timing\nWords\n',
    new Uint8Array([0xff]),
    'x'.repeat(8 * 1024 * 1024 + 1),
    'WEBVTT\n\n' + '00:00:00.000 --> 00:00:01.000\nWords\n\n'.repeat(5001),
  ]) {
    await assert.rejects(
      fetchOfficialVtt('42', signal, fetchResponse(new Response(body))),
      { code: 'invalid_transcript' },
    );
  }
});

void test('missing transcripts stay missing and transport errors stay retryable', async () => {
  for (const response of [
    new Response(null, { status: 404 }),
    new Response(null, { status: 204 }),
    new Response(''),
    new Response('WEBVTT\n\n'),
  ])
    assert.equal(
      await fetchOfficialVtt('42', signal, fetchResponse(response)),
      null,
    );
  const error = new Error('connection reset');
  await assert.rejects(
    fetchOfficialVtt('42', signal, async () => {
      throw error;
    }),
    (e) => e === error && !e.code,
  );
});

void test('HTTP failures preserve status and Retry-After metadata for the pool', async () => {
  for (const status of [429, 503, 500])
    await assert.rejects(
      fetchOfficialVtt(
        '42',
        signal,
        fetchResponse(new Response('', { status })),
      ),
      { status, code: `transcript_http_${status}` },
    );
  await assert.rejects(
    fetchOfficialVtt(
      '42',
      signal,
      fetchResponse(
        new Response('', { status: 502, headers: { 'Retry-After': '180' } }),
      ),
    ),
    { status: 502, retryAfterMs: 180000, retryAfter: '180' },
  );
  await assert.rejects(
    fetchOfficialVtt(
      '42',
      signal,
      fetchResponse(
        new Response('', {
          status: 502,
          headers: { 'Retry-After': 'invalid' },
        }),
      ),
    ),
    (e) => e.retryAfter === 'invalid' && e.retryAfterMs === undefined,
  );
});

void test('reinstallation replaces old bundled transcript code and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notes-transcript-'));
  const filename = join(root, 'notes-pipeline.mjs');
  try {
    // Minimal bundle with the existing concurrency and catalog patches applied.
    await writeFile(
      filename,
      `// VM concurrent notes support v2
import { vmCatalogText } from "../catalog-fetch.mjs";
// lib/webvtt.mjs
function parseVtt() { throw new Error('Empty or invalid WebVTT cue.'); }
// packages/notes-only/src/pipeline.ts
async function fetchOfficialVtt() { throw new Error('old fetcher'); }
// packages/antigravity-acp/src/errors.ts
const FREE_NOTES_MODEL = 'opencode/muse-spark-1.3-contributor-free';
async function main(credential, queue) {
    const result = await runNotesPool({
      queue,
    });
}
`,
      { mode: 0o600 },
    );
    const prepare = new URL(
      '../deploy/notes-only/prepare-runtime.mjs',
      import.meta.url,
    );
    await execFile(process.execPath, [prepare.pathname, filename]);
    const first = await readFile(filename, 'utf8');
    await execFile(process.execPath, [prepare.pathname, filename]);
    assert.equal(await readFile(filename, 'utf8'), first);
    assert.match(
      first,
      /secrets: \[credential.username, credential.password\]/,
    );
    const moduleSource =
      first.replace(/^import[^\n]+\n/m, '') +
      '\nexport { parseVtt, fetchOfficialVtt, FREE_NOTES_MODEL };';
    const runtime = await import(
      'data:text/javascript;base64,' +
        Buffer.from(moduleSource).toString('base64')
    );
    assert.deepEqual(
      runtime.parseVtt(outOfOrder).map((c) => c.startMs),
      [1000, 2000],
    );
    assert.equal(
      await runtime.fetchOfficialVtt(
        '42',
        signal,
        fetchResponse(new Response(outOfOrder)),
      ),
      outOfOrder,
    );
    assert.equal(
      runtime.FREE_NOTES_MODEL,
      'opencode/muse-spark-1.3-contributor-free',
    );
    assert.throws(() => runtime.parseVtt('bad'), {
      code: 'invalid_transcript',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
