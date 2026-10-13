import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectionImage,
  catalogCollection,
  catalogLanding,
} from '../lib/catalog';
import { GET } from '../app/api/catalog-artwork/route';
import type { Directory } from '../lib/yutorah';

const portrait =
  'https://cdnyutorah.cachefly.net/_images/roshei_yeshiva/teacher.jpg';
const cover = 'https://cdnyutorah.cachefly.net/_images/series/course.jpg';
const directory: Directory = {
  teachers: [
    {
      id: 8,
      name: 'Teacher',
      firstName: '',
      lastName: '',
      count: 2,
      image: portrait,
    },
  ],
  series: [{ id: 9, name: 'Series', count: 2, image: cover, description: '' }],
  topics: [],
  groups: [],
};
void test('collection artwork resolves the supplied catalog image without inventing a cover', () => {
  assert.equal(collectionImage('///teacher.jpg', directory), portrait);
  assert.equal(collectionImage('///missing.jpg', directory), '');
  assert.equal(collectionImage('///../teacher.jpg', directory), '');
  assert.equal(
    collectionImage('https://images.example.test/course.jpg', directory),
    'https://images.example.test/course.jpg',
  );
  assert.equal(collectionImage('javascript:alert(1)', directory), '');
});
void test('catalog profiles, related series and lazy collection images retain official artwork', async () => {
  const original = globalThis.fetch;
  const paths: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    paths.push(url);
    if (url.pathname.endsWith('/browse/teachers'))
      return Response.json([
        { ID: 8, firstName: 'Teacher', shiurCount: 2, imageURL: portrait },
      ]);
    if (url.pathname.endsWith('/browse/series'))
      return Response.json([
        { ID: 9, name: 'Series', shiurCount: 2, imageURL: cover },
      ]);
    if (url.pathname.endsWith('/browse/categories'))
      return Response.json([
        {
          name: 'Halacha',
          shortName: 'Halacha',
          subCategories: [
            {
              ID: 10,
              name: 'Tefillah',
              shiurCount: 500,
              middleTierName: 'Orach Chaim',
            },
          ],
        },
      ]);
    if (url.pathname.endsWith('/landingpage/landingpagedetails'))
      return Response.json({
        series: [{ typeID: 9, typeName: 'Series', numShiurim: 2 }],
        categories: [{ typeID: 10, typeName: 'Tefillah', numShiurim: 2 }],
      });
    if (url.pathname.endsWith('/landingpage/landing'))
      return Response.json({ name: 'Series', imageURL: cover });
    const id = Number(url.searchParams.get('collectionID'));
    return Response.json({
      collectionID: id,
      collectionTitle: 'Collection',
      collectionImageURL: id === 20 ? '///teacher.jpg' : '',
      collectionShiurim: [
        {
          shiurID: 1,
          shiurTitle: 'Lesson',
          shiurTeachers: [
            { teacherID: 8, teacherName: 'Teacher', teacherPhoto: portrait },
          ],
        },
      ],
    });
  };
  try {
    const invalid = await GET(
      new Request('https://example.test/api/catalog-artwork?id=-1'),
    );
    assert.equal(invalid.status, 400);
    assert.equal(paths.length, 0);
    const image = await GET(
      new Request('https://example.test/api/catalog-artwork?id=20'),
    );
    assert.equal(image.status, 302);
    assert.equal(image.headers.get('Location'), portrait);
    const metadata = await GET(
      new Request('https://example.test/api/catalog-artwork?id=20&format=json'),
    );
    assert.equal(metadata.status, 200);
    assert.deepEqual(
      await metadata.json(),
      { image: portrait },
      'Client receives the original image URL so the shared sharp-portrait loader can choose its larger variant',
    );
    const count = paths.length;
    await GET(new Request('https://example.test/api/catalog-artwork?id=20'));
    assert.equal(paths.length, count, 'Artwork lookups are cached');
    assert.equal(
      (await GET(new Request('https://example.test/api/catalog-artwork?id=21')))
        .status,
      404,
    );
    assert.deepEqual(
      await (
        await GET(
          new Request(
            'https://example.test/api/catalog-artwork?id=21&format=json',
          ),
        )
      ).json(),
      { image: '' },
    );
    assert.equal(
      (
        await GET(
          new Request(
            'https://example.test/api/catalog-artwork?id=20&format=unsupported',
          ),
        )
      ).status,
      400,
    );
    const collection = await catalogCollection(21);
    assert.equal(
      collection.image,
      '',
      'Missing collection artwork does not become a lesson teacher portrait',
    );
    assert.equal(collection.items[0].collections?.[0].id, 21);
    const series = await catalogLanding('series', 9);
    assert.equal(series.image, cover);
    assert.equal(series.facets.series[0].image, cover);
    assert.equal(series.facets.topics[0].group, 'Halacha');
    assert.equal(
      series.facets.topics[0].count,
      2,
      'Topic styling metadata preserves the profile-specific shiur count',
    );
  } finally {
    globalThis.fetch = original;
  }
});
