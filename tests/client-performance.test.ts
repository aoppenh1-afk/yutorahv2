import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clientMetrics,
  dataCommitTiming,
  performanceCount,
  performanceReadyEvent,
  recordDataOperation,
  responseDataSource,
} from '../lib/client-performance';
import { performanceMetrics } from '../lib/performance-report-schema';
import { reportClientPerformance } from '../lib/performance-reporter';
import {
  invalidateCatalogResource,
  loadCatalogResource,
} from '../lib/catalog-client';

void test('client timing samples measure commits independently and remain bounded until acknowledged', async (t) => {
  const descriptors = ['window', 'sessionStorage'].map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const window = new EventTarget();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: window,
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: { getItem: () => '1' },
  });
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const sent: {
    metrics: Record<string, number>;
    operations: { ms: number; phase: string; source: string }[];
  }[] = [];
  const send = () =>
    reportClientPerformance('mobile', (body) => {
      assert.ok(new TextEncoder().encode(body).byteLength <= 2048);
      sent.push(JSON.parse(body));
      return true;
    });
  try {
    const first = dataCommitTiming('search', now, 'network');
    now += 100;
    assert.equal(
      send(),
      false,
      'data readiness alone must not report a DOM commit',
    );
    first?.();
    first?.();
    const second = dataCommitTiming('search', now, 'memory');
    now += 200;
    second?.();
    const aborted = new AbortController();
    const canceled = dataCommitTiming(
      'search',
      now,
      'network',
      'complete',
      aborted.signal,
    );
    aborted.abort();
    canceled?.();
    performanceCount('dataApiCalls', 2);
    clientMetrics.privateQuery = 123;
    assert.equal(
      reportClientPerformance('mobile', () => false),
      false,
    );
    assert.equal(
      reportClientPerformance('mobile', () => {
        throw new Error('Beacon unavailable');
      }),
      false,
    );
    assert.equal(send(), true);
    assert.deepEqual(sent[0], {
      device: 'mobile',
      metrics: { dataApiCalls: 2 },
      operations: [
        { area: 'search', phase: 'first', ms: 100, source: 'network' },
        { area: 'search', phase: 'first', ms: 200, source: 'memory' },
      ],
    });
    assert.equal(
      send(),
      false,
      'successful sends must not repeat prior samples or counters',
    );
    delete clientMetrics.privateQuery;

    let ready = 0;
    window.addEventListener(performanceReadyEvent, () => ready++);
    for (const name of performanceMetrics) clientMetrics[name] = 1e8;
    clientMetrics.operationSamplesDropped = 0;
    for (let index = 0; index < 9; index++)
      recordDataOperation({
        area: 'collection',
        phase: 'complete',
        ms: 600_000,
        source: 'server-memory',
      });
    await Promise.resolve();
    assert.equal(ready, 1);
    assert.equal(
      send(),
      true,
      'the maximum payload must still fit the API byte limit',
    );
    assert.equal(sent[1].operations.length, 8);
    assert.equal(sent[1].metrics.operationSamplesDropped, 1);
    assert.equal(send(), false);

    let entries: PerformanceEntry[] = [];
    t.mock.method(performance, 'getEntriesByName', () => entries);
    const response = (headers: HeadersInit) => {
      const value = new Response('{}', { headers });
      Object.defineProperty(value, 'url', {
        value: 'https://example.test/api/home',
      });
      return value;
    };
    assert.equal(
      responseDataSource(response({ 'X-Yutorah-Cache': 'snapshot' }), 100),
      'snapshot',
    );
    assert.equal(
      responseDataSource(response({ 'X-Yutorah-Cache': 'private text' }), 100),
      'network',
    );
    assert.equal(
      responseDataSource(
        response({ 'X-Yutorah-Cache': 'refresh', Age: '120' }),
        100,
      ),
      'edge-cache',
    );
    assert.equal(
      responseDataSource(response({ 'CF-Cache-Status': 'UPDATING' }), 100),
      'edge-cache',
    );
    entries = [
      {
        initiatorType: 'fetch',
        startTime: 200,
        transferSize: 0,
        encodedBodySize: 500,
      } as unknown as PerformanceEntry,
    ];
    assert.equal(
      responseDataSource(response({ 'X-Yutorah-Cache': 'refresh' }), 100),
      'http-cache',
    );
    assert.equal(
      responseDataSource(response({ 'X-Yutorah-Cache': 'refresh' }), 250),
      'refresh',
      'older resource entries cannot classify this request',
    );
    entries = [
      {
        initiatorType: 'fetch',
        startTime: 200,
        transferSize: 300,
        encodedBodySize: 500,
        responseStatus: 304,
      } as unknown as PerformanceEntry,
    ];
    assert.equal(
      responseDataSource(response({ 'X-Yutorah-Cache': 'refresh' }), 100),
      'http-cache',
    );
    entries = [];
    let release!: () => void;
    const fetchReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fail = false;
    t.mock.method(globalThis, 'fetch', async () => {
      await fetchReady;
      if (fail) throw new Error('Offline');
      return Response.json(
        { items: [1] },
        { headers: { 'X-Yutorah-Cache': 'snapshot' } },
      );
    });
    const sources: string[] = [];
    const observe = (value: string) => sources.push(value);
    const url = '/api/home';
    invalidateCatalogResource(url);
    const a = loadCatalogResource(url, undefined, observe);
    const b = loadCatalogResource(url, undefined, observe);
    release();
    await Promise.all([a, b]);
    await loadCatalogResource(url, undefined, observe);
    let clock = Date.now() + 60_001;
    t.mock.method(Date, 'now', () => clock);
    fail = true;
    await loadCatalogResource(url, undefined, observe);
    assert.deepEqual(sources, [
      'snapshot',
      'snapshot',
      'memory',
      'memory-stale',
    ]);
    assert.equal(clientMetrics.dataApiCalls, 2);
    assert.equal(clientMetrics.dataCacheCoalesced, 1);
    clock++;
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    for (const name of Object.keys(clientMetrics)) delete clientMetrics[name];
  }
});
