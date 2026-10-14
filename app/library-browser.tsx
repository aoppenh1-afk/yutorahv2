/* oxlint-disable next/no-img-element -- Public YUTorah collection covers and daf scans. */
'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  ListPlus,
  Loader2,
  Play,
  Search,
} from 'lucide-react';
import type {
  BrowseKind as CatalogKind,
  CatalogEntry,
  CatalogLanding,
  CollectionData,
  DafData,
} from '@/lib/catalog';
import type { Shiur, Directory } from '@/lib/yutorah';
import type { LibraryState } from '@/lib/library';
import type { Follow } from '@/lib/learning';
import { isLearned } from '@/lib/learning';
import { noFilters, type Filters } from '@/lib/search-filters';
import { dafTractates, type DafSelection } from '@/lib/daf';
import { Avatar, StatePanel, tone } from './ui';
import { FollowButton } from './follow-button';
import { PagedItems } from './paged-items';
import { TopicCard } from './topic-card';
import { CatalogCover } from './catalog-cover';
import { TeacherPopularShiurim } from './teacher-popular-shiurim';
import { orderedTopicGroups } from '@/lib/topic-groups';
import {
  cachedCatalogResource,
  invalidateCatalogResource,
  loadCatalogResource,
  prefetchCatalogDirectories,
} from '@/lib/catalog-client';
export { prefetchCatalogDirectories } from '@/lib/catalog-client';

export const catalogLabels: Record<CatalogKind, string> = {
  teacher: 'Teachers',
  series: 'Series',
  topic: 'Topics',
  collection: 'Collections',
  venue: 'Venues',
};
const kinds = Object.keys(catalogLabels) as CatalogKind[];
function useCatalog<T>(params: Record<string, string>) {
  const url = '/api/catalog?' + new URLSearchParams(params).toString();
  const cached = cachedCatalogResource<T>(url);
  const [state, setState] = useState<{
    url: string;
    data: T | null;
    error: string;
    loading: boolean;
  }>(() => ({
    url,
    data: cached ?? null,
    error: '',
    loading: cached === undefined,
  }));
  const [retry, setRetry] = useState(0);
  const current =
    state.url === url
      ? state
      : { url, data: cached ?? null, error: '', loading: cached === undefined };
  useEffect(() => {
    let active = true;
    const hit = cachedCatalogResource<T>(url);
    setState({ url, data: hit ?? null, error: '', loading: hit === undefined });
    loadCatalogResource<T>(url)
      .then((d) => {
        if (active) setState({ url, data: d, error: '', loading: false });
      })
      .catch((e) => {
        if (active)
          setState({ url, data: null, error: e.message, loading: false });
      });
    return () => {
      active = false;
    };
  }, [url, retry]);
  return {
    ...current,
    retry: () => {
      invalidateCatalogResource(url);
      setRetry((n) => n + 1);
    },
  };
}
type Shared = {
  library: LibraryState;
  follow: (f: Follow) => void;
  onOpen: (kind: CatalogKind, id?: number) => void;
  onSearch: (q: string, filters: Filters) => void;
  rows: (items: Shiur[]) => React.ReactNode;
  onPlay: (s: Shiur) => void;
  onQueue: (items: Shiur[]) => void;
};
function Loading({ label = 'Loading library…' }: { label?: string }) {
  return (
    <output className="catalog-loading">
      <Loader2 size={17} className="spin" />
      {label}
    </output>
  );
}
function Entries({
  entries,
  kind,
  onOpen,
  library,
  follow,
}: {
  entries: CatalogEntry[];
  kind: CatalogKind;
  onOpen: Shared['onOpen'];
  library: LibraryState;
  follow: Shared['follow'];
}) {
  if (kind === 'teacher')
    return (
      <div className="teacher-grid">
        {entries.map((e) => (
          <article className="teacher-card-wrap" key={e.id}>
            <button className="teacher-card" onClick={() => onOpen(kind, e.id)}>
              <span className={'teacher-portrait ' + tone(e.id)}>
                <Avatar src={e.image || ''} name={e.name} />
              </span>
              <h2>{e.name}</h2>
              <p>{e.count.toLocaleString()} shiurim</p>
              <span>
                Explore shiurim <ArrowRight size={14} />
              </span>
            </button>
            <FollowButton
              follow={{ kind, id: e.id, name: e.name, image: e.image }}
              library={library}
              onFollow={follow}
            />
          </article>
        ))}
      </div>
    );
  if (kind === 'topic') {
    return (
      <div className="catalog-grid catalog-topic">
        {entries.map((e) => (
          <TopicCard
            key={e.id + '-' + e.group}
            topic={e}
            heading="h2"
            onOpen={() => onOpen(kind, e.id)}
            library={library}
            follow={follow}
          />
        ))}
      </div>
    );
  }
  return (
    <div className={'catalog-grid catalog-' + kind}>
      {entries.map((e) => (
        <article className="catalog-card" key={e.id}>
          <button
            className="catalog-card-main"
            onClick={() => onOpen(kind, e.id)}
          >
            <CatalogCover kind={kind} id={e.id} image={e.image} />
            <div>
              {e.path && (
                <span className="catalog-path">
                  {e.path.slice(0, -1).join(' / ')}
                </span>
              )}
              <h2 dir="auto">{e.name}</h2>
              {e.description && (
                <p className="catalog-description" dir="auto">
                  {e.description}
                </p>
              )}
              <span>{e.count.toLocaleString()} shiurim</span>
            </div>
            <ArrowRight size={17} />
          </button>
          {
            <FollowButton
              follow={{
                kind: kind as Follow['kind'],
                id: e.id,
                name: e.name,
                image: e.image,
              }}
              library={library}
              onFollow={follow}
            />
          }
        </article>
      ))}
    </div>
  );
}
function CatalogHeading({
  kind,
  onKind,
}: {
  kind: CatalogKind;
  onKind: (k: CatalogKind) => void;
}) {
  return (
    <>
      <div className="view-heading">
        <div className="eyebrow">Explore the library</div>
        <h1>Browse.</h1>
        <p>
          Find a teacher, follow a subject, or learn your way through a
          collection.
        </p>
      </div>
      <nav className="catalog-tabs" aria-label="Library sections">
        {kinds.map((k) => (
          <button
            key={k}
            aria-current={kind === k ? 'page' : undefined}
            onClick={() => onKind(k)}
          >
            {catalogLabels[k]}
          </button>
        ))}
      </nav>
    </>
  );
}
type BrowserProps = Shared & {
  kind: CatalogKind;
  onKind: (k: CatalogKind) => void;
  initialQuery?: string;
  directory: Directory | null;
  directoryError: string;
  retryDirectory: () => void;
};
export function LibraryBrowser(props: BrowserProps) {
  useEffect(() => {
    prefetchCatalogDirectories();
  }, []);
  return props.kind === 'topic' ? (
    <TopicsBrowser {...props} />
  ) : (
    <PagedBrowser key={props.kind} {...props} />
  );
}
function TopicsBrowser({
  directory,
  directoryError,
  retryDirectory,
  initialQuery = '',
  ...props
}: BrowserProps) {
  const [query, setQuery] = useState(initialQuery),
    [group, setGroup] = useState('all'),
    [limit, setLimit] = useState(36);
  useEffect(() => {
    setQuery(initialQuery);
    setLimit(36);
  }, [initialQuery]);
  const groups = orderedTopicGroups(directory?.groups || []);
  const groupRank = new Map(groups.map((g, i) => [g, i]));
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const entries = (directory?.topics || [])
    .filter(
      (t) =>
        (group === 'all' || t.group === group) &&
        words.every((word) =>
          [t.name, ...(t.path || [t.group])]
            .join(' ')
            .toLocaleLowerCase()
            .includes(word),
        ),
    )
    .sort(
      (a, b) =>
        (groupRank.get(a.group) ?? groups.length) -
          (groupRank.get(b.group) ?? groups.length) || b.count - a.count,
    );
  const chooseGroup = (g: string) => {
    setGroup(g);
    setLimit(36);
  };
  const cards = (list: CatalogEntry[], heading: 'h2' | 'h3') =>
    list.map((t) => (
      <TopicCard
        key={t.id + '-' + t.group}
        topic={t}
        heading={heading}
        onOpen={() => props.onOpen('topic', t.id)}
        library={props.library}
        follow={props.follow}
      />
    ));
  return (
    <section className="catalog-view">
      <CatalogHeading kind="topic" onKind={props.onKind} />
      <div className="catalog-toolbar">
        <label className="catalog-search">
          <Search size={18} />
          <input
            type="search"
            aria-label="Find topics"
            placeholder="Find topics…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(36);
            }}
          />
        </label>
        <span aria-live="polite">
          {directory
            ? entries.length.toLocaleString() +
              (entries.length === 1 ? ' topic' : ' topics')
            : ''}
        </span>
      </div>
      {directoryError ? (
        <StatePanel
          title="The directory could not load"
          description={directoryError}
          action="Try again"
          onAction={retryDirectory}
        />
      ) : !directory ? (
        <Loading />
      ) : (
        <>
          <div className="topic-groups" aria-label="Subjects">
            {['all', ...groups].map((g) => (
              <button
                key={g}
                aria-pressed={group === g}
                onClick={() => chooseGroup(g)}
              >
                {g === 'all' ? 'All subjects' : g}
              </button>
            ))}
          </div>
          <div className="catalog-grid catalog-topic">
            {cards(entries.slice(0, limit), 'h2')}
          </div>
          {!entries.length && (
            <StatePanel
              title="No matches"
              description="Try another name or subject."
            />
          )}
          {entries.length > limit && (
            <div className="load-more">
              <button
                className="outline-button"
                onClick={() => setLimit((n) => n + 36)}
              >
                Show more topics <ArrowRight size={16} />
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
function PagedBrowser({
  kind,
  onKind,
  initialQuery = '',
  ...props
}: Shared & {
  kind: CatalogKind;
  onKind: (kind: CatalogKind) => void;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery),
    [debounced, setDebounced] = useState(initialQuery),
    [offset, setOffset] = useState(0),
    [entries, setEntries] = useState<CatalogEntry[]>([]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setOffset(0);
      setDebounced(query);
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    setQuery(initialQuery);
    setDebounced(initialQuery);
    setOffset(0);
    setEntries([]);
  }, [kind, initialQuery]);
  const result = useCatalog<{
    entries: CatalogEntry[];
    total: number;
    next: number | null;
  }>({ kind, q: debounced, offset: String(offset) });
  useEffect(() => {
    if (result.data)
      setEntries((old) =>
        offset
          ? [
              ...new Map(
                [...old, ...result.data!.entries].map((e) => [e.id, e]),
              ).values(),
            ]
          : result.data!.entries,
      );
  }, [result.data, offset]);
  return (
    <section className="catalog-view">
      <CatalogHeading kind={kind} onKind={onKind} />
      <div className="catalog-toolbar">
        <label className="catalog-search">
          <Search size={18} />
          <input
            type="search"
            aria-label={'Find ' + catalogLabels[kind].toLowerCase()}
            placeholder={
              'Find ' +
              (kind === 'series'
                ? 'a series'
                : catalogLabels[kind].toLowerCase()) +
              '…'
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span aria-live="polite">
          {result.data
            ? `${result.data.total.toLocaleString()} ${result.data.total === 1 ? kind : catalogLabels[kind].toLowerCase()}`
            : ''}
        </span>
      </div>
      {result.error ? (
        <StatePanel
          title="The directory could not load"
          description={result.error}
          action="Try again"
          onAction={result.retry}
        />
      ) : (
        <>
          <Entries
            entries={offset === 0 ? result.data?.entries || [] : entries}
            kind={kind}
            {...props}
          />
          {result.loading && <Loading />}
          {!result.loading &&
            !(offset === 0 ? result.data?.entries.length : entries.length) && (
              <StatePanel
                title="No matches"
                description="Try another name or subject."
              />
            )}
          {result.data?.next !== null && result.data?.next !== undefined && (
            <button
              className="load-more"
              disabled={result.loading}
              onClick={() => setOffset(result.data!.next!)}
            >
              Load more {catalogLabels[kind].toLowerCase()}{' '}
              <ArrowRight size={16} />
            </button>
          )}
        </>
      )}
    </section>
  );
}
const facetKind = {
  teachers: 'teacher',
  series: 'series',
  topics: 'topic',
  venues: 'venue',
  collections: 'collection',
} as const;
export function EntityPage({
  kind,
  id,
  ...props
}: Shared & { kind: Exclude<CatalogKind, 'collection'>; id: number }) {
  const result = useCatalog<CatalogLanding>({
      action: 'entity',
      kind,
      id: String(id),
    }),
    [tab, setTab] = useState('recent');
  useEffect(() => setTab('recent'), [kind, id]);
  if (result.loading) return <Loading />;
  if (result.error || !result.data)
    return (
      <StatePanel
        title="This library page could not load"
        description={result.error}
        action="Try again"
        onAction={result.retry}
      />
    );
  const d = result.data;
  const tabs = [
    {
      key: 'recent',
      label: 'Recent shiurim',
    },
    ...(kind === 'teacher' || d.popular.length
      ? [{ key: 'popular', label: 'Most viewed' }]
      : []),
    ...(d.featured.length ? [{ key: 'featured', label: 'Featured' }] : []),
    ...(kind === 'teacher' && d.facets.collections.length
      ? [{ key: 'collections', label: 'Collections' }]
      : []),
    ...Object.entries(facetKind)
      .filter(
        ([key]) =>
          !(kind === 'teacher' && key === 'collections') &&
          d.facets[key as keyof typeof facetKind].length,
      )
      .map(([key, k]) => ({ key, label: catalogLabels[k] })),
  ];
  return (
    <section className="catalog-view">
      <button
        className="text-button catalog-back"
        onClick={() => props.onOpen(kind)}
      >
        <ArrowLeft size={16} /> {catalogLabels[kind]}
      </button>
      <header className="catalog-profile">
        {kind === 'teacher' ? (
          <Avatar src={d.image} name={d.name} />
        ) : (
          d.image && <CatalogCover kind={kind} id={id} image={d.image} large />
        )}
        <div>
          <div className="eyebrow">
            {kind === 'teacher' ? 'Torah educator' : catalogLabels[kind]}
          </div>
          <h1 dir="auto">{d.name}</h1>
          {d.count > 0 && <p>{d.count.toLocaleString()} shiurim</p>}
          {d.description && (
            <p className="catalog-bio" dir="auto">
              {d.description}
            </p>
          )}
          <div className="catalog-actions">
            <button
              className="primary-button"
              onClick={() =>
                props.onSearch('', {
                  ...noFilters,
                  [kind === 'venue' ? 'venue' : kind]: String(id),
                })
              }
            >
              <Search size={16} /> Search{' '}
              {kind === 'teacher' ? 'this teacher' : 'this ' + kind}
            </button>
            {
              <FollowButton
                follow={{
                  kind: kind as Follow['kind'],
                  id,
                  name: d.name,
                  image: d.image,
                }}
                library={props.library}
                onFollow={props.follow}
              />
            }
          </div>
        </div>
      </header>
      <nav className="catalog-tabs" aria-label={'Explore ' + d.name}>
        {tabs.map((t) => (
          <button
            key={t.key}
            aria-current={tab === t.key ? 'page' : undefined}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tab === 'popular' && kind === 'teacher' ? (
        <TeacherPopularShiurim key={id} teacherId={id} rows={props.rows} />
      ) : ['recent', 'popular', 'featured'].includes(tab) ? (
        props.rows(d[tab as 'recent' | 'popular' | 'featured'])
      ) : (
        <PagedItems
          key={tab}
          items={d.facets[tab as keyof typeof facetKind]}
          size={36}
        >
          {(items) => (
            <Entries
              entries={items}
              kind={facetKind[tab as keyof typeof facetKind]}
              {...props}
            />
          )}
        </PagedItems>
      )}
    </section>
  );
}
export function CollectionPage({ id, ...props }: Shared & { id: number }) {
  const result = useCatalog<CollectionData>({
      action: 'entity',
      kind: 'collection',
      id: String(id),
    }),
    [sort, setSort] = useState('old'),
    [query, setQuery] = useState('');
  useEffect(() => {
    setSort('old');
    setQuery('');
  }, [id]);
  const items = useMemo(() => {
    const list = (result.data?.items || []).filter((s) =>
      [s.title, s.teacher, s.description]
        .join(' ')
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
    return [...list].sort((a, b) =>
      sort === 'title'
        ? a.title.localeCompare(b.title)
        : sort === 'new'
          ? Date.parse(b.date) - Date.parse(a.date) || b.id - a.id
          : Date.parse(a.date) - Date.parse(b.date) || a.id - b.id,
    );
  }, [result.data, sort, query]);
  if (result.loading) return <Loading label="Loading collection…" />;
  if (result.error || !result.data)
    return (
      <StatePanel
        title="This collection could not load"
        description={result.error}
        action="Try again"
        onAction={result.retry}
      />
    );
  const d = result.data,
    hasLearned = d.items.some((s) => isLearned(s, props.library)),
    next = d.items.find((s) => !isLearned(s, props.library));
  return (
    <section className="catalog-view">
      <button
        className="text-button catalog-back"
        onClick={() => props.onOpen('collection')}
      >
        <ArrowLeft size={16} /> Collections
      </button>
      <header className="catalog-profile">
        <CatalogCover kind="collection" id={id} image={d.image} large />
        <div>
          <div className="eyebrow">YUTorah collection</div>
          <h1 dir="auto">{d.name}</h1>
          <p>
            {d.count} lessons
            {d.updatedAt
              ? ' · Updated ' +
                new Date(d.updatedAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  timeZone: 'UTC',
                })
              : ''}
          </p>
          {d.description && (
            <p className="catalog-bio" dir="auto">
              {d.description}
            </p>
          )}
          <div className="catalog-actions">
            {next && (
              <button
                className="primary-button"
                onClick={() => props.onPlay(next)}
              >
                <Play size={16} />{' '}
                {hasLearned ? 'Continue learning' : 'Start learning'}
              </button>
            )}
            <button
              className="outline-button"
              onClick={() => props.onQueue(d.items)}
            >
              <ListPlus size={16} /> Queue collection
            </button>
            <FollowButton
              follow={{ kind: 'collection', id, name: d.name, image: d.image }}
              library={props.library}
              onFollow={props.follow}
            />
          </div>
        </div>
      </header>
      <div className="catalog-toolbar">
        <label className="catalog-search">
          <Search size={17} />
          <input
            type="search"
            aria-label="Find in this collection"
            placeholder="Find a lesson…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          aria-label="Collection order"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="old">First to last</option>
          <option value="new">Newest first</option>
          <option value="title">Title A–Z</option>
        </select>
      </div>
      {props.rows(items)}
      {!items.length && (
        <p className="catalog-empty">No lessons match your search.</p>
      )}
      {d.related.length > 0 && (
        <section className="catalog-related">
          <h2>Related collections</h2>
          <Entries entries={d.related} kind="collection" {...props} />
        </section>
      )}
    </section>
  );
}
export function DafWorkspace({
  selection,
  onChange,
  ...props
}: Shared & { selection: DafSelection; onChange: (s: DafSelection) => void }) {
  const result = useCatalog<DafData>({
      action: 'daf',
      tractate: selection.tractate,
      page: String(selection.page),
      side: selection.side,
    }),
    [speaker, setSpeaker] = useState(''),
    [zoom, setZoom] = useState(false),
    [imageFailed, setImageFailed] = useState(false);
  useEffect(() => {
    setSpeaker('');
    setImageFailed(false);
  }, [selection.tractate, selection.page, selection.side]);
  const tractate =
      dafTractates.find((t) => t.name === selection.tractate) ||
      dafTractates[0],
    d = result.data;
  const teachers = [
    ...new Map(
      (d?.items || [])
        .flatMap(
          (s) =>
            s.speakers || [
              { id: s.teacherId, name: s.teacher, image: s.image },
            ],
        )
        .map((t) => [t.id, t]),
    ).values(),
  ];
  const items = (d?.items || []).filter(
    (s) =>
      !speaker ||
      (s.speakers || [{ id: s.teacherId }]).some(
        (t) => String(t.id) === speaker,
      ),
  );
  const step = (delta: number) => {
    const index =
      (selection.page - 2) * 2 + (selection.side === 'b' ? 1 : 0) + delta;
    onChange({
      ...selection,
      page: Math.floor(index / 2) + 2,
      side: index % 2 ? 'b' : 'a',
    });
  };
  return (
    <section className="catalog-view daf-workspace">
      <div className="view-heading">
        <div className="eyebrow">Daf study</div>
        <h1>
          {selection.tractate} {selection.page}
          {selection.side}
        </h1>
        <p>The daf, its recordings, and related learning in one place.</p>
      </div>
      <div className="daf-controls">
        <select
          aria-label="Tractate"
          value={selection.tractate}
          onChange={(e) =>
            onChange({ tractate: e.target.value, page: 2, side: 'a' })
          }
        >
          {dafTractates.map((t) => (
            <option key={t.id}>{t.name}</option>
          ))}
        </select>
        <select
          aria-label="Daf page"
          value={selection.page}
          onChange={(e) =>
            onChange({ ...selection, page: Number(e.target.value) })
          }
        >
          {Array.from({ length: tractate.lastPage - 1 }, (_, i) => (
            <option key={i + 2}>{i + 2}</option>
          ))}
        </select>
        <div className="daf-sides">
          {(['a', 'b'] as const).map((side) => (
            <button
              key={side}
              aria-pressed={selection.side === side}
              onClick={() => onChange({ ...selection, side })}
            >
              Side {side.toUpperCase()}
              {d?.sideCounts?.[side] !== undefined && (
                <span> · {d.sideCounts[side]}</span>
              )}
            </button>
          ))}
        </div>
        <button
          className="outline-button"
          aria-label="Previous amud"
          disabled={selection.page === 2 && selection.side === 'a'}
          onClick={() => step(-1)}
        >
          <ChevronLeft size={17} />
        </button>
        <button
          className="outline-button"
          aria-label="Next amud"
          disabled={
            selection.page === tractate.lastPage && selection.side === 'b'
          }
          onClick={() => step(1)}
        >
          <ChevronRight size={17} />
        </button>
        <a
          className="text-button"
          href={`https://www.sefaria.org/${selection.tractate.replace(/ /g, '_')}.${selection.page}${selection.side}?lang=he-en`}
          target="_blank"
          rel="noreferrer"
        >
          Sefaria <ExternalLink size={15} />
        </a>
      </div>
      {result.loading ? (
        <Loading label="Loading the daf…" />
      ) : result.error ? (
        <StatePanel
          title="The daf could not load"
          description={result.error}
          action="Try again"
          onAction={result.retry}
        />
      ) : (
        d && (
          <div className="daf-columns">
            <div className={'daf-scan ' + (zoom ? 'is-zoomed' : '')}>
              <button
                className="text-button"
                aria-pressed={zoom}
                onClick={() => setZoom(!zoom)}
              >
                {zoom ? 'Fit page' : 'Enlarge daf'}
              </button>
              {imageFailed ? (
                <StatePanel
                  title="The daf image could not load"
                  action="Retry image"
                  onAction={() => setImageFailed(false)}
                />
              ) : (
                <img
                  src={d.image}
                  alt={`${selection.tractate} ${selection.page}${selection.side}, scanned daf`}
                  onError={() => setImageFailed(true)}
                />
              )}
            </div>
            <div className="daf-recordings">
              <div className="catalog-subheading">
                <h2>
                  Shiurim on this daf <span>{items.length}</span>
                </h2>
                <select
                  aria-label="Daf speaker"
                  value={speaker}
                  onChange={(e) => setSpeaker(e.target.value)}
                >
                  <option value="">All teachers</option>
                  {teachers.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
              {props.rows(items)}
              {!items.length && (
                <p className="catalog-empty">
                  No recordings for this selection.
                </p>
              )}
              {d.related.length > 0 && (
                <>
                  <h2 className="catalog-related-title">Related learning</h2>
                  {props.rows(d.related)}
                </>
              )}
            </div>
          </div>
        )
      )}
    </section>
  );
}
