import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createOfficialTranscriptReader } from '../../../lib/official-transcript';
import { websiteTranscript } from '../../../lib/website-transcript';
import { GET as transcriptText } from '../../../app/api/transcript-text/route';
import { GET as transcriptRoute } from '../../../app/api/transcript/route';

const vtt =
  'WEBVTT\r\n\r\n1\r\n00:00:00.123 --> 00:00:02.100\r\n<v Rabbi><i>שָׁלוֹם</i> &amp; hello.\r\n\r\n2\r\n00:00:02.000 --> 00:00:03.999\r\nSecond passage.\r\n';
const vttResponse = (text = vtt) =>
  new Response(text, { headers: { 'Content-Type': 'text/vtt' } });

void test('official text preserves exact timings, Unicode and overlaps and fetches only public VTT', async () => {
  const reads: Array<{ url: string; options?: RequestInit }> = [];
  const reader = createOfficialTranscriptReader({
    fetcher: async (url, options) => {
      reads.push({
        url:
          typeof url === 'string'
            ? url
            : url instanceof URL
              ? url.href
              : url.url,
        options,
      });
      return vttResponse();
    },
    metadata: async () => ({ title: 'The shiur', teacher: 'Rabbi Example' }),
  });
  const response = await reader('42', new URLSearchParams());
  assert.equal(response.status, 200);
  const content = await response.json();
  assert.equal(content.source, 'official-yutorah');
  assert.equal(content.title, 'The shiur');
  assert.equal(content.notes, null);
  assert.match(content.transcriptId, /^official-42-/);
  assert.match(content.version, /^[a-f0-9]{64}$/);
  assert.equal(content.durationMs, 3999);
  assert.deepEqual(
    content.segments.map(
      ({
        startMs,
        endMs,
        text,
      }: {
        startMs: number;
        endMs: number;
        text: string;
      }) => ({ startMs, endMs, text }),
    ),
    [
      { startMs: 123, endMs: 2100, text: 'שָׁלוֹם & hello.' },
      { startMs: 2000, endMs: 3999, text: 'Second passage.' },
    ],
  );
  assert.equal(
    reads[0].url,
    'https://api.yutorah.org/transcriptions/shiur/42/vtt',
  );
  assert.equal(
    new Headers(reads[0].options?.headers).get('Authorization'),
    null,
  );
  assert.equal(
    new Headers(reads[0].options?.headers).get('Accept'),
    'text/vtt',
  );
  assert.equal(reads[0].options?.cache, undefined);
  assert.equal(reads[0].options?.redirect, 'manual');
});

void test('shared reads and cache avoid repeated upstream calls; refresh and version pins remain correct', async () => {
  let reads = 0;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reader = createOfficialTranscriptReader({
    fetcher: async (_url, options) => {
      reads++;
      if (reads === 1) await waiting;
      if (reads === 2) assert.equal(options?.cache, 'no-store');
      return vttResponse(
        reads === 1 ? vtt : vtt.replace('Second passage.', 'Updated passage.'),
      );
    },
  });
  const one = reader('43', new URLSearchParams());
  const two = reader('43', new URLSearchParams());
  release();
  const [first, concurrent] = await Promise.all([one, two]);
  assert.equal(reads, 1);
  assert.equal(await first.clone().text(), await concurrent.text());
  const old = await first.json();
  const unchanged = await reader(
    '43',
    new URLSearchParams(),
    first.headers.get('ETag')!,
  );
  assert.equal(unchanged.status, 304);
  assert.equal(reads, 1);
  const fresh = await reader('43', new URLSearchParams({ fresh: 'true' }));
  const updated = await fresh.json();
  assert.equal(reads, 2);
  assert.equal(fresh.headers.get('Cache-Control'), 'no-store');
  assert.notEqual(updated.version, old.version);
  const pinned = await reader(
    '43',
    new URLSearchParams({ version: old.version }),
  );
  assert.equal(pinned.status, 404);
  assert.equal(pinned.headers.get('Cache-Control'), 'no-store');
});

void test('empty VTT is missing; upstream failures and malformed text are retriable errors', async () => {
  const empty = createOfficialTranscriptReader({
    fetcher: async () => vttResponse('WEBVTT\r\n\r\n'),
  });
  assert.equal((await empty('44', new URLSearchParams())).status, 404);
  const replies = [
    new Response('Please verify', { status: 403 }),
    new Response('<html>Challenge</html>', {
      headers: { 'Content-Type': 'text/html' },
    }),
    vttResponse(vtt.replace('00:00:03.999', '00:00:01.999')),
    vttResponse(),
  ];
  let reads = 0;
  const reader = createOfficialTranscriptReader({
    fetcher: async () => {
      reads++;
      return replies.shift()!;
    },
  });
  for (let index = 0; index < 3; index++) {
    const response = await reader('45', new URLSearchParams());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.equal((await reader('45', new URLSearchParams())).status, 200);
  assert.equal(reads, 4, 'errors must not become cached missing transcripts');
});

void test('invalid IDs never reach the API; oversized streaming responses are cancelled', async () => {
  let reads = 0,
    cancelled = false;
  const reader = createOfficialTranscriptReader({
    fetcher: async () => {
      reads++;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'Content-Type': 'text/vtt' } },
      );
    },
  });
  assert.equal((await reader('../queue', new URLSearchParams())).status, 400);
  assert.equal(reads, 0);
  assert.equal((await reader('46', new URLSearchParams())).status, 503);
  assert.equal(cancelled, true);
});

function configureLocal(t: TestContext) {
  const original = { ...process.env };
  t.after(() => {
    process.env = original;
  });
  delete process.env.TRANSCRIPT_DATABASE_URL;
  delete process.env.TRANSCRIPT_ARCHIVE_URL;
  process.env.TRANSCRIPT_API_URL = 'https://transcripts.example.test';
  process.env.TRANSCRIPT_API_TOKEN = 'test-only-token';
}

void test('website reading prefers official text and complete-text links keep its source and version', async (t) => {
  configureLocal(t);
  const urls: string[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (url: unknown, options: RequestInit) => {
      urls.push(String(url));
      assert.equal(new Headers(options?.headers).get('Authorization'), null);
      if (String(url).includes('/vtt')) return vttResponse();
      return Response.json({
        shiurID: 700001,
        shiurTitle: 'Official title',
        shiurTeachers: [{ teacherName: 'Rabbi Example' }],
      });
    },
  );
  const response = await transcriptRoute(
    new Request('https://app.test/api/transcript?id=700001'),
  );
  assert.equal(response.status, 200);
  const content = await response.json();
  assert.equal(content.source, 'official-yutorah');
  assert.ok(
    !urls.some((url) => url.startsWith('https://transcripts.example.test')),
  );
  const text = await transcriptText(
    new Request(
      `https://app.test/api/transcript-text?id=700001&source=official-yutorah&version=${content.version}`,
    ),
  );
  assert.equal(text.status, 200);
  assert.match(
    await text.text(),
    /Official title\nRabbi Example\n\n\[0:00\] שָׁלוֹם & hello\./,
  );
  const changed = await transcriptText(
    new Request(
      `https://app.test/api/transcript-text?id=700001&source=official-yutorah&version=${'0'.repeat(64)}`,
    ),
  );
  assert.equal(changed.status, 404);
});

void test('empty official text falls back to existing completed transcripts with tokens confined to that service', async (t) => {
  configureLocal(t);
  const urls: string[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (url: unknown, options: RequestInit) => {
      urls.push(String(url));
      if (String(url).includes('api.yutorah.org')) {
        assert.equal(new Headers(options.headers).get('Authorization'), null);
        return vttResponse('WEBVTT\n\n');
      }
      assert.equal(
        new Headers(options.headers).get('Authorization'),
        'Bearer test-only-token',
      );
      return Response.json({
        transcriptId: 'existing',
        segments: [{ text: 'Existing transcript' }],
      });
    },
  );
  const response = await websiteTranscript('700002', new URLSearchParams());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).transcriptId, 'existing');
  assert.equal(urls.length, 2);
});

void test('archive version requests stay pinned to the archive and never fetch official text', async (t) => {
  configureLocal(t);
  process.env.TRANSCRIPT_ARCHIVE_URL = 'https://archive.example.test';
  process.env.TRANSCRIPT_ARCHIVE_READ_TOKEN = 'archive-test-token';
  let reads = 0;
  const version = 'a'.repeat(64);
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    reads++;
    assert.equal(
      String(url),
      `https://archive.example.test/v1/transcripts/700003?version=${version}`,
    );
    return Response.json({ transcriptId: 'archived', version });
  });
  const response = await websiteTranscript(
    '700003',
    new URLSearchParams({ version }),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).transcriptId, 'archived');
  assert.equal(reads, 1);
});

void test('an official outage stays an error when the fallback has no transcript', async (t) => {
  configureLocal(t);
  t.mock.method(globalThis, 'fetch', async (url: unknown) =>
    String(url).includes('api.yutorah.org')
      ? new Response('Unavailable', { status: 503 })
      : new Response('Not found', { status: 404 }),
  );
  const response = await websiteTranscript('700004', new URLSearchParams());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});
