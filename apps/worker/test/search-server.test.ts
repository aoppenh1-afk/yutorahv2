import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createSearchServer } from '../src/search-server.js';
import { GET as websiteSearch } from '../../../app/api/transcript-search/route.js';

void test('read-only search server requires bearer auth and bounds requests', async () => {
  const calls: string[] = [];
  const server = createSearchServer(
    {
      search: async (query: string) => {
        calls.push(query);
        return [{ shiurId: '123', startMs: 1834000, text: 'חזרה' }];
      },
    } as never,
    'a'.repeat(48),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/v1/transcripts/search?q=חזרה`)).status, 401);
    const headers = { Authorization: `Bearer ${'a'.repeat(48)}` };
    assert.equal(
      (await fetch(`${origin}/v1/transcripts/search?q=חזרה&limit=500`, { headers })).status,
      400,
    );
    const result = await fetch(`${origin}/v1/transcripts/search?q=חזרה`, { headers });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    const body = (await result.json()) as { results: unknown[] };
    assert.deepEqual(body.results[0], {
      shiurId: '123', startMs: 1834000, text: 'חזרה',
    });
    assert.deepEqual(calls, ['חזרה']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

void test('website bridge keeps the VM token server-side and returns timestamped hits', async () => {
  const token = 'b'.repeat(48);
  const server = createSearchServer(
    {
      search: async () => [{
        shiurId: '42', title: 'Hilchos Shabbos', teacher: 'Rabbi X',
        mediaUrl: 'https://download.yutorah.org/42.mp3', startMs: 1834000,
        endMs: 1840000, text: 'the concept of חזרה', matched: 'חזרה',
        href: '/?shiur=42&t=1834', aliasesExpanded: true,
      }],
    } as never,
    token,
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const priorUrl = process.env.TRANSCRIPT_API_URL;
  const priorToken = process.env.TRANSCRIPT_API_TOKEN;
  process.env.TRANSCRIPT_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.TRANSCRIPT_API_TOKEN = token;
  try {
    const response = await websiteSearch(new Request('http://localhost/api/transcript-search?q=חזרה'));
    assert.equal(response.status, 200);
    const body = (await response.json()) as { results: Array<{ startMs: number; href: string }> };
    assert.equal(body.results[0].startMs, 1834000);
    assert.equal(body.results[0].href, '/?shiur=42&t=1834');
    assert.equal(JSON.stringify(body).includes(token), false);
  } finally {
    if (priorUrl === undefined) delete process.env.TRANSCRIPT_API_URL;
    else process.env.TRANSCRIPT_API_URL = priorUrl;
    if (priorToken === undefined) delete process.env.TRANSCRIPT_API_TOKEN;
    else process.env.TRANSCRIPT_API_TOKEN = priorToken;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
