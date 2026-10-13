import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { LibraryBrowser } from '../app/library-browser';
import { loadCatalogResource } from '../lib/catalog-client';
import { restoreLibrary } from '../lib/library';

const props = {
  library: restoreLibrary(null),
  directory: null,
  directoryError: '',
  retryDirectory: () => {},
  onKind: () => {},
  onOpen: () => {},
  onSearch: () => {},
  follow: () => {},
  rows: () => null,
  onPlay: () => {},
  onQueue: () => {},
};
void test('a returning collection visitor sees cached cards and covers on the first render', async (t) => {
  const image = 'https://images.example.test/course.jpg';
  t.mock.method(globalThis, 'fetch', async (url: string) =>
    Response.json(
      url.includes('artwork')
        ? { image }
        : {
            entries: [{ id: 42, name: 'Saved collection', count: 5 }],
            total: 1,
            next: null,
          },
    ),
  );
  await loadCatalogResource('/api/catalog?kind=collection&q=&offset=0');
  await loadCatalogResource('/api/catalog-artwork?id=42&format=json');
  const markup = renderToStaticMarkup(
    <LibraryBrowser {...props} kind="collection" />,
  );
  assert.match(markup, /Saved collection/);
  assert.match(markup, /https:\/\/images.example.test\/course.jpg/);
  assert.doesNotMatch(markup, /Loading library/);
  const coldVenue = renderToStaticMarkup(
    <LibraryBrowser {...props} kind="venue" />,
  );
  assert.doesNotMatch(coldVenue, /Saved collection|course.jpg/);
  assert.match(coldVenue, /Loading library/);
});
