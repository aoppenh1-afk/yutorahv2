import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptGateway } from '../lib/transcript-gateway';

void test('transcript proxy uses fetch cache options supported by Workers', async (t) => {
  const original = { ...process.env };
  t.after(() => {
    process.env = original;
  });
  delete process.env.TRANSCRIPT_DATABASE_URL;
  delete process.env.TRANSCRIPT_ARCHIVE_URL;
  process.env.TRANSCRIPT_API_URL = 'https://transcripts.example.test';
  process.env.TRANSCRIPT_API_TOKEN = 'test-only-token';
  const requests: RequestInit[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options: RequestInit) => {
      // workerd accepts no-store/no-cache; an explicit default throws before I/O.
      if (options.cache && !['no-store', 'no-cache'].includes(options.cache))
        throw new TypeError('Unsupported cache mode: ' + options.cache);
      requests.push(options);
      return Response.json({ transcriptId: 'published', segments: [] });
    },
  );
  const cached = await transcriptGateway(
    '/v1/transcripts/42',
    new URLSearchParams(),
  );
  assert.equal(cached.status, 200, await cached.clone().text());
  assert.match(cached.headers.get('cache-control')!, /s-maxage=3600/);
  const fresh = await transcriptGateway(
    '/v1/transcripts/42',
    new URLSearchParams({ fresh: 'true' }),
  );
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers.get('cache-control'), 'no-store');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].cache, 'no-store');
  assert.equal(
    new Headers(requests[0].headers).get('Authorization'),
    'Bearer test-only-token',
  );
});
