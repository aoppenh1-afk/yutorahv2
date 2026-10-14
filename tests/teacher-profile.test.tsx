import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { EntityPage } from '../app/library-browser';
import { loadCatalogResource } from '../lib/catalog-client';
import { emptyFacets, type CatalogLanding } from '../lib/catalog';
import { restoreLibrary } from '../lib/library';

void test('teacher collections follow Featured and Most viewed is available without a landing-page shortlist', async (t) => {
  const data: CatalogLanding = {
    kind: 'teacher',
    id: 73,
    name: 'Teacher',
    description: '',
    image: '',
    count: 200,
    recent: [],
    popular: [],
    featured: [{ id: 1 } as CatalogLanding['featured'][number]],
    facets: {
      ...emptyFacets(),
      topics: [{ id: 2, name: 'Topic', count: 3 }],
      venues: [{ id: 3, name: 'Venue', count: 4 }],
      collections: [{ id: 4, name: 'Collection', count: 5 }],
    },
  };
  t.mock.method(globalThis, 'fetch', async () => Response.json(data));
  await loadCatalogResource('/api/catalog?action=entity&kind=teacher&id=73');
  const markup = renderToStaticMarkup(
    <EntityPage
      kind="teacher"
      id={73}
      library={restoreLibrary(null)}
      follow={() => {}}
      onOpen={() => {}}
      onSearch={() => {}}
      rows={() => null}
      onPlay={() => {}}
      onQueue={() => {}}
    />,
  );
  const tabs = markup.match(/<nav.*?<\/nav>/)?.[0] || '';
  assert.match(tabs, /Most viewed/);
  assert.ok(tabs.indexOf('Featured') < tabs.indexOf('Collections'));
  assert.ok(tabs.indexOf('Collections') < tabs.indexOf('Topics'));
  assert.ok(tabs.indexOf('Collections') < tabs.indexOf('Venues'));
});
