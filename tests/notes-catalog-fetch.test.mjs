import assert from 'node:assert/strict';
import test from 'node:test';
import { vmCatalogText } from '../deploy/notes-only/catalog-fetch.mjs';

const endpoint = 'https://yutorah.org/api/search/get?start=1';
const signal = new AbortController().signal;

test('catalog uses the managed fetch transport for the fixed public endpoint', async () => {
  const text = await vmCatalogText(
    endpoint,
    signal,
    100,
    async (url, options) => {
      assert.equal(url, endpoint);
      assert.equal(options.redirect, 'error');
      return Response.json({ response: { docs: [] } });
    },
  );
  assert.deepEqual(JSON.parse(text), { response: { docs: [] } });
});

test('catalog rejects arbitrary destinations and redirects', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return new Response('', { status: 302 });
  };
  for (const url of [
    'http://yutorah.org/api/search/get',
    'https://127.0.0.1/api/search/get',
    'https://yutorah.org/private',
    'https://user:password@yutorah.org/api/search/get',
  ])
    await assert.rejects(vmCatalogText(url, signal, 100, fetcher));
  assert.equal(calls, 0);
  await assert.rejects(vmCatalogText(endpoint, signal, 100, fetcher));
});

test('catalog bounds streamed responses and rejects invalid UTF-8', async () => {
  await assert.rejects(
    vmCatalogText(endpoint, signal, 2, async () => new Response('תורה')),
  );
  await assert.rejects(
    vmCatalogText(
      endpoint,
      signal,
      100,
      async () => new Response(Uint8Array.of(0xff)),
    ),
  );
});
