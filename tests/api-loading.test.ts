import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { build } from 'esbuild';

async function freshModule<T>(entry: string): Promise<T> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'request-lifecycle-fixture',
        setup(builder) {
          builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: 'bindings',
            namespace: 'lifecycle',
          }));
          builder.onResolve({ filter: /^vinext\/shims\/server$/ }, () => ({
            path: 'lifecycle',
            namespace: 'lifecycle',
          }));
          builder.onLoad(
            { filter: /.*/, namespace: 'lifecycle' },
            ({ path }) => ({
              contents:
                path === 'bindings'
                  ? 'export const env = {}'
                  : 'export function after() {}',
              loader: 'js',
            }),
          );
        },
      },
    ],
  });
  return import(
    'data:text/javascript;base64,' +
      Buffer.from(result.outputFiles[0].text).toString('base64') +
      '#' +
      crypto.randomUUID()
  );
}

function fixture(t: TestContext) {
  const paths: URL[] = [];
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lesson = {
    shiurID: 77,
    shiurTitle: 'A lesson',
    shiurFileURL: 'https://example.test/lesson.mp3',
    shiurTeachers: [{ teacherID: 8, teacherName: 'Teacher' }],
  };
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    paths.push(url);
    await ready;
    if (url.pathname.endsWith('/browse/teachers'))
      return Response.json([{ ID: 8, firstName: 'Teacher', shiurCount: 1 }]);
    if (url.pathname.endsWith('/browse/daf'))
      return Response.json({
        dafImageURL_a: 'https://example.test/daf-a.jpg',
        dafImageURL_b: 'https://example.test/daf-b.jpg',
        dafYomiShiurim: [lesson],
        relatedShiurim: [],
      });
    if (url.pathname.includes('/browse/')) return Response.json([]);
    if (url.pathname.endsWith('/collections/get'))
      return Response.json({
        collectionID: Number(url.searchParams.get('collectionID')),
        collectionTitle: 'Collection',
        collectionImageURL: 'https://example.test/cover.jpg',
        collectionShiurim: [lesson],
      });
    if (url.pathname.endsWith('/collections/forshiurim'))
      return Response.json({
        data: [{ ID: 20, name: 'Collection', shiurList: [77] }],
      });
    if (url.pathname.endsWith('/landingpage/landingpagedetails'))
      return Response.json({
        collections: [
          { typeID: 20, typeName: 'Collection', numShiurim: 1 },
          {
            typeID: 21,
            typeName: 'Related',
            numShiurim: 2,
            imageURL: 'https://example.test/related.jpg',
          },
        ],
      });
    if (url.pathname.endsWith('/landingpage/landing'))
      return Response.json({ name: 'Teacher', recentlyAddedShiurim: [lesson] });
    if (url.pathname.endsWith('/shiur/details')) return Response.json(lesson);
    if (url.pathname.endsWith('/search/get'))
      return Response.json({
        response: { docs: [{ shiurid: 77, shiurvisitsnum: 12 }] },
      });
    throw new Error('Unexpected request: ' + url.pathname);
  });
  return { paths, release };
}

void test('a cold profile starts its content and facets while the directory is still loading', async (t) => {
  const { catalogLanding } =
    await freshModule<typeof import('../lib/catalog')>('lib/catalog.ts');
  const { paths, release } = fixture(t);
  const request = catalogLanding('teacher', 8);
  try {
    await setImmediate();
    assert.ok(
      paths.some((u) => u.pathname.endsWith('/landingpage/landing')),
      'The first shiur list should not wait for the directory round trip',
    );
    assert.ok(
      paths.some((u) => u.pathname.endsWith('/landingpage/landingpagedetails')),
      'Profile facets should load alongside the directory',
    );
  } finally {
    release();
    await request;
  }
  assert.equal((await request).recent[0].id, 77);
});

void test('a cold collection overlaps its directory read and avoids fetching a teacher shiur list for related links', async (t) => {
  const { catalogCollection } =
    await freshModule<typeof import('../lib/catalog')>('lib/catalog.ts');
  const { paths, release } = fixture(t);
  const request = catalogCollection(20);
  try {
    await setImmediate();
    assert.ok(paths.some((u) => u.pathname.endsWith('/collections/get')));
    assert.ok(
      paths.some((u) => u.pathname.endsWith('/browse/teachers')),
      'Collection metadata and directory enrichment should start together',
    );
  } finally {
    release();
    await request;
  }
  const collection = await request;
  assert.equal(collection.items[0].collections?.[0].id, 20);
  assert.deepEqual(collection.related, [
    {
      id: 21,
      name: 'Related',
      count: 2,
      image: 'https://example.test/related.jpg',
    },
  ]);
  assert.ok(
    !paths.some((u) => u.pathname.endsWith('/landingpage/landing')),
    'Related collection links need facets, not the teacher recording lists',
  );
});

void test('absolute collection artwork does not load the teacher, series, and topic directories', async (t) => {
  const { catalogCollectionArtwork } =
    await freshModule<typeof import('../lib/catalog')>('lib/catalog.ts');
  const { paths, release } = fixture(t);
  release();
  assert.equal(
    await catalogCollectionArtwork(20),
    'https://example.test/cover.jpg',
  );
  assert.equal(
    paths.length,
    1,
    'An absolute image URL needs only its collection request',
  );
});

void test('a cold daf loads both amud counts and its directory in parallel', async (t) => {
  const { catalogDaf } =
    await freshModule<typeof import('../lib/catalog')>('lib/catalog.ts');
  const { paths, release } = fixture(t);
  const request = catalogDaf('Berachot', 2, 'a');
  try {
    await setImmediate();
    assert.equal(
      paths.filter((u) => u.pathname.endsWith('/browse/daf')).length,
      2,
      'The other amud count should not add a second network round trip',
    );
    assert.ok(paths.some((u) => u.pathname.endsWith('/browse/teachers')));
  } finally {
    release();
    await request;
  }
  const daf = await request;
  assert.equal(daf.items[0].id, 77);
  assert.deepEqual(daf.sideCounts, { a: 1, b: 1 });
  assert.equal(daf.image, 'https://example.test/daf-a.jpg');
});

void test('a cold shiur starts directory and collection enrichment alongside its detail request', async (t) => {
  const { GET } = await freshModule<typeof import('../app/api/shiur/route')>(
    'app/api/shiur/route.ts',
  );
  const { paths, release } = fixture(t);
  const request = GET(new Request('https://example.test/api/shiur?id=77'));
  try {
    await setImmediate();
    assert.ok(paths.some((u) => u.pathname.endsWith('/shiur/details')));
    assert.ok(
      paths.some((u) => u.pathname.endsWith('/browse/teachers')),
      'Directory enrichment should not wait for shiur details',
    );
    assert.ok(
      paths.some((u) => u.pathname.endsWith('/collections/forshiurim')),
      'Collection membership should not wait for shiur details',
    );
  } finally {
    release();
    await request;
  }
  const response = await request;
  assert.equal(response.status, 200);
  const shiur = await response.json();
  assert.equal(shiur.audio, 'https://example.test/lesson.mp3');
  assert.equal(shiur.collections[0].id, 20);
  assert.equal(shiur.views, 12);
});
