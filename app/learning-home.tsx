/* oxlint-disable next/no-img-element -- Subject art is pre-sized, lazy-loaded local WebP. */
'use client';
import type { BrowseKind as CatalogKind } from '@/lib/catalog';
import { ShiurViews } from './shiur-views';
import { TeacherLink } from './teacher-link';
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useIsMobile } from '@/hooks/use-mobile';
import { DataCommitMarker } from './performance-monitor';
import type { DataCommitTiming } from '@/lib/client-performance';
import { BoundedCache } from '@/lib/bounded-cache';
import { loadDiscovery, loadSavedDiscovery } from '@/lib/discovery-client';
import { pollDelay } from '@/lib/poll-delay';
import {
  readLocalDiscoveryCharts,
  preferDiscoveryChart,
} from '@/lib/trending-local';
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  BookOpen,
  Check,
  Flame,
  History,
  Lightbulb,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Star,
  Timer,
  Users,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Avatar,
  MobileRecordingCard,
  SeriesCover,
  ShiurCard,
  ShiurRow,
  StatePanel,
  tone,
  useSeriesWithArt,
} from './ui';
import { noFilters, type Filters } from '@/lib/search-filters';
import { FeaturedTitle } from './featured-title';
import type { Directory, HomeData, Shiur } from '@/lib/yutorah';
import { mediaKind, selectHomeFeature } from '@/lib/yutorah';
import type { LibraryState } from '@/lib/library';
import {
  trendingPeriods,
  type DiscoveryData,
  type TrendingPeriod,
} from '@/lib/trending';
import {
  followKinds,
  isLearned,
  recommend,
  recommendationAnchor,
  recommendationSources,
  mergeShiurim,
  type Follow,
} from '@/lib/learning';

import { FollowButton } from './follow-button';
export { FollowButton } from './follow-button';

const MobileDiscover = lazy(() =>
  import('./mobile-discover').then((module) => ({
    default: module.MobileDiscover,
  })),
);
const feedBatches = new BoundedCache<{ items: Shiur[]; partial: boolean }>(
  64,
  4 * 1024 * 1024,
);

type Props = {
  dataTiming?: DataCommitTiming;
  home: HomeData | null;
  directory: Directory | null;
  library: LibraryState;
  update: (fn: (old: LibraryState) => LibraryState) => void;
  onPlay: (shiur: Shiur, seconds?: number) => void;
  onDetails: (shiur: Shiur) => void;
  onSave: (shiur: Shiur) => void;
  onQueue: (shiur: Shiur) => void;
  onFollow: (follow: Follow) => void;
  onEntity?: (kind: CatalogKind, id?: number) => void;
  onDaf?: (value: string) => void;
  onSearch: (query: string, filters?: Filters) => void;
  homeSearch: ReactNode;
  onNavigate: (
    view:
      | 'discover'
      | 'teachers'
      | 'series'
      | 'topics'
      | 'history'
      | 'saved'
      | 'search'
      | 'following'
      | 'trending',
  ) => void;
  notify: (message: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  followingPage?: boolean;
  trendingPage?: boolean;
  activeId?: number;
  playing?: boolean;
};

export function LearningHome(props: Props) {
  const {
    home,
    directory,
    library,
    update,
    onPlay,
    onDetails,
    onSave,
    onQueue,
    onFollow,
    onSearch,
    homeSearch,
    onEntity,
    onDaf,
    onNavigate,
    notify,
    onRefresh,
    refreshing,
    followingPage = false,
    trendingPage = false,
    activeId,
    playing = false,
  } = props;
  const isMobile = useIsMobile();
  const [trendingWanted, setTrendingWanted] = useState(false);
  const [sourceLimit, setSourceLimit] = useState(8);
  const [tab, setTab] = useState('for-you');
  const currentTab = followingPage
    ? 'following'
    : trendingPage
      ? 'trending'
      : tab;

  const [minutes, setMinutes] = useState('all');
  const [followingKind, setFollowingKind] = useState<Follow['kind'] | 'all'>(
    'all',
  );
  const recommendationView =
    currentTab === 'for-you' || currentTab === 'recommended';
  const filterMinutes =
    recommendationView || currentTab === 'following' || minutes === 'all'
      ? 0
      : Number(minutes);
  const [limit, setLimit] = useState(8);
  const [preferences, setPreferences] = useState(false);
  const [feedItems, setFeedItems] = useState<Shiur[]>([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedError, setFeedError] = useState(false);
  const [trendingPeriod, setTrendingPeriod] = useState<TrendingPeriod>('week');
  const [trendingLimit, setTrendingLimit] = useState(12);
  const [discoveryCharts, setDiscoveryCharts] = useState<
    Record<string, DiscoveryData>
  >({});
  const discoveryChartsRef = useRef(discoveryCharts);
  discoveryChartsRef.current = discoveryCharts;
  const trendingMinutes =
    (isMobile && currentTab === 'trending') || minutes === 'all'
      ? 0
      : Number(minutes);
  const discoveryPeriod = currentTab === 'trending' ? trendingPeriod : 'week';
  const discoveryMinutes = recommendationView ? 0 : trendingMinutes;
  const discoveryKey = `${discoveryPeriod}:${discoveryMinutes}`;
  const discovery = discoveryCharts[discoveryKey] ?? null;
  const [discoveryError, setDiscoveryError] = useState(false);
  const [discoveryLoading, setDiscoveryLoading] = useState(true);
  const [relatedItems, setRelatedItems] = useState<Shiur[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [discoveryPass, setDiscoveryPass] = useState(0);
  const [discoveryRetry, setDiscoveryRetry] = useState(0);
  useEffect(() => {
    if (
      (currentTab !== 'trending' &&
        !(currentTab === 'for-you' && trendingWanted)) ||
      discoveryLoading
    )
      return;
    const indexing =
      (discovery?.partial || discovery?.refreshing) &&
      (!discovery.stale || discovery.refreshing) &&
      discovery.coverage?.status !== 'paused' &&
      !discoveryError;
    if (!indexing && !discoveryRetry) return;
    const abort = new AbortController();
    void pollDelay(discoveryRetry ? discoveryRetry * 1000 : 3500, abort.signal)
      .then(() => setDiscoveryPass((n) => n + 1))
      .catch(() => {});
    return () => abort.abort();
  }, [
    currentTab,
    discovery,
    discoveryLoading,
    discoveryError,
    discoveryRetry,
    trendingWanted,
  ]);
  const trendingSection = useRef<HTMLElement>(null);
  useEffect(() => {
    const target = trendingSection.current;
    if (trendingWanted || !target) return;
    const want = () => {
      // Initial layout shifts must not spend Home's discovery request budget.
      if (window.scrollY <= 0) return;
      const { top, bottom } = target.getBoundingClientRect();
      if (top < window.innerHeight + 240 && bottom > -240)
        setTrendingWanted(true);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) want();
      },
      { rootMargin: '240px 0px' },
    );
    observer.observe(target);
    window.addEventListener('scroll', want, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', want);
    };
  }, [trendingWanted, tab, followingPage, trendingPage, isMobile]);
  const anchorId = recommendationAnchor(library)?.id;

  const sources = useMemo(() => {
    return currentTab === 'following'
      ? library.following.filter(
          (follow) => followingKind === 'all' || follow.kind === followingKind,
        )
      : recommendationSources(library);
  }, [currentTab, library, followingKind]);
  const sourceQuery = JSON.stringify(
    sources.map(({ kind, id }) => ({ kind, id })),
  );
  useEffect(() => {
    const selected = (
      JSON.parse(sourceQuery) as Pick<Follow, 'kind' | 'id'>[]
    ).slice(0, currentTab === 'following' ? sourceLimit : 8);
    const abort = new AbortController();
    setFeedItems([]);
    setFeedError(false);
    setFeedLoading(selected.length > 0);
    const load = async () => {
      let collected: Shiur[] = [];
      for (let start = 0; start < selected.length; start += 8) {
        const query = new URLSearchParams();
        for (const kind of followKinds)
          query.set(
            kind,
            selected
              .slice(start, start + 8)
              .filter((s) => s.kind === kind)
              .map((s) => s.id)
              .join(','),
          );
        try {
          const cached =
            refresh === 0 ? feedBatches.get(query.toString()) : undefined;
          const res = cached
            ? Response.json(cached)
            : await fetch('/api/feed?' + query, { signal: abort.signal });
          if (!res.ok) throw new Error('Feed unavailable');
          const data = (await res.json()) as {
            items: Shiur[];
            partial: boolean;
          };
          if (abort.signal.aborted) return;
          if (!cached && !data.partial)
            feedBatches.set(query.toString(), data, 5 * 60_000);
          collected = mergeShiurim([...collected, ...data.items]);
          setFeedItems(collected);
          if (data.partial) setFeedError(true);
        } catch {
          if (abort.signal.aborted) return;
          setFeedError(true);
        }
      }
      if (!abort.signal.aborted) setFeedLoading(false);
    };
    void load();
    return () => abort.abort();
  }, [sourceQuery, refresh, currentTab, sourceLimit]);

  useEffect(() => {
    const local = readLocalDiscoveryCharts();
    setDiscoveryCharts((current) => {
      const charts = { ...current };
      for (const [key, data] of Object.entries(local))
        charts[key] = preferDiscoveryChart(data, charts[key] ?? data);
      return charts;
    });
    if (followingPage || trendingPage) return;
    const abort = new AbortController();
    // Home can show the shared saved chart before scrolling, without indexing.
    void loadSavedDiscovery(
      { period: 'week', minutes: 0 },
      abort.signal,
      (data) => {
        setDiscoveryCharts((current) => ({
          ...current,
          'week:0': preferDiscoveryChart(current['week:0'], data),
        }));
      },
    ).catch(() => {
      /* Keep the local chart; visible Trending will retry normally. */
    });
    return () => abort.abort();
  }, [followingPage, trendingPage]);

  useEffect(() => {
    if (currentTab !== 'trending' && !trendingWanted) {
      setDiscoveryLoading(false);
      return;
    }
    const abort = new AbortController();
    setDiscoveryLoading(true);
    setDiscoveryError(false);
    setDiscoveryRetry(0);
    loadDiscovery(
      {
        period: discoveryPeriod,
        minutes: discoveryMinutes as 0 | 10 | 20 | 30,
      },
      abort.signal,
      (data) => {
        setDiscoveryCharts((old) => ({
          ...old,
          [discoveryKey]: preferDiscoveryChart(old[discoveryKey], data),
        }));
      },
      setDiscoveryRetry,
      !discoveryChartsRef.current[discoveryKey],
    )
      .catch(() => {
        if (!abort.signal.aborted) setDiscoveryError(true);
      })
      .finally(() => {
        if (!abort.signal.aborted) setDiscoveryLoading(false);
      });
    return () => abort.abort();
  }, [
    refresh,
    discoveryPass,
    discoveryPeriod,
    discoveryMinutes,
    discoveryKey,
    currentTab,
    trendingWanted,
  ]);

  useEffect(() => {
    setRelatedItems([]);
    if (!anchorId) return;
    const abort = new AbortController();
    fetch('/api/related?id=' + anchorId, { signal: abort.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error('Related learning unavailable');
        const data = (await res.json()) as { items: Shiur[] };
        if (!abort.signal.aborted) setRelatedItems(data.items);
      })
      .catch(() => {});
    return () => abort.abort();
  }, [anchorId, refresh]);

  const allItems = useMemo(
    () =>
      mergeShiurim([
        ...feedItems,
        ...relatedItems,
        ...(home?.featured || []),
        ...(home?.recent || []),
        ...(home?.daily || []),
        ...(discovery?.trending || []),
      ]),
    [home, feedItems, relatedItems, discovery],
  );
  const ranked = useMemo(
    () =>
      recommend(
        currentTab === 'for-you' &&
          !library.history.length &&
          !library.saved.length &&
          !library.following.length &&
          !filterMinutes &&
          home?.featured.length
          ? home.featured
          : allItems,
        currentTab === 'following'
          ? { ...library, following: sources }
          : library,
        {
          followingOnly: currentTab === 'following',
          minutes: filterMinutes || undefined,
          now: home?.fetchedAt ? Date.parse(home.fetchedAt) : 0,
        },
      ),
    [allItems, home, library, currentTab, filterMinutes, sources],
  );
  const followingItems = useMemo(
    () =>
      recommend(allItems, library, {
        followingOnly: true,
        minutes: filterMinutes || undefined,
        now: home?.fetchedAt ? Date.parse(home.fetchedAt) : 0,
      }),
    [allItems, library, filterMinutes, home?.fetchedAt],
  );
  const items =
    currentTab === 'featured'
      ? (home?.featured || [])
          .filter(
            (s) =>
              !library.hidden.includes(s.id) &&
              (minutes === 'all' ||
                (s.duration > 0 && s.duration <= Number(minutes) * 60)),
          )
          .map((shiur) => ({ shiur, reason: 'Editors’ pick', score: 0 }))
      : ranked;
  const continuing = library.history.filter(
    (h) => h.seconds > 0 && !isLearned(h.shiur, library),
  );
  const teachers = (directory?.teachers || []).slice(0, 7);
  const suggestedTopics = [
    ...new Map(
      (directory?.topics || [])
        .filter((t) =>
          /^(Halacha|Parsha|Tefillah|Shabbat|Machshava|Emunah|Teshuva|Gemara|Jewish Thought)$/i.test(
            t.name,
          ),
        )
        .map((t) => [t.name, t]),
    ).values(),
  ].slice(0, 10);
  const shortSeries = directory?.series.find((s) =>
    /^ten minute halacha$/i.test(s.name),
  );
  const pick = selectHomeFeature(home);
  const shelfSeries = useSeriesWithArt(
    [...(home?.series || []), ...(directory?.series || [])],
    5,
  );
  const hasInterests = !!(
    library.history.length ||
    library.saved.length ||
    library.following.length
  );
  const trending = (discovery?.trending || []).filter(
    (s) =>
      trendingMinutes === 0 ||
      (s.duration > 0 && s.duration <= trendingMinutes * 60),
  );
  const isHome = currentTab === 'for-you';
  const refreshAll = () => {
    setRefresh((n) => n + 1);
    onRefresh();
  };
  const savedIds = new Set(library.saved.map((v) => v.id));
  const upNext = (home?.featured || [])
    .filter((s) => s.id !== pick?.id)
    .slice(0, 3);
  const refreshRecommendations = (
    <button
      className="icon-button"
      aria-label="Refresh recommendations"
      onClick={refreshAll}
      disabled={feedLoading || refreshing}
    >
      <RefreshCw
        size={16}
        className={feedLoading || refreshing ? 'spin' : ''}
      />
    </button>
  );
  const sectionHeading = (
    title: string,
    description?: string,
    action?: () => void,
    label = 'View all',
    refresh = false,
  ) => (
    <div className="discovery-section-heading">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {(action || refresh) && (
        <div className="discovery-section-actions">
          {action && (
            <button className="section-link" onClick={action}>
              {label}
              <ArrowRight size={15} />
            </button>
          )}
          {refresh && refreshRecommendations}
        </div>
      )}
    </div>
  );
  const cards = (
    entries: typeof ranked,
    count = limit,
    row = false,
    reasons = false,
  ) => (
    <div className={'discovery-card-grid' + (row ? ' is-row' : '')}>
      {entries.slice(0, count).map(({ shiur: s, reason }) => (
        <div className="recommendation-item" key={s.id}>
          <ShiurCard
            shiur={s}
            onPlay={onPlay}
            onDetails={onDetails}
            onTeacher={(s) =>
              onEntity
                ? onEntity('teacher', s.teacherId)
                : onSearch('', { ...noFilters, teacher: String(s.teacherId) })
            }
            onSave={onSave}
            saved={savedIds.has(s.id)}
            active={activeId === s.id && playing}
          />
          {reasons && <p className="recommendation-reason">{reason}</p>}
        </div>
      ))}
    </div>
  );
  const trendingList = (count: number) => (
    <ol className={isMobile ? 'mobile-trending-list' : 'trending-list'}>
      {trending.slice(0, count).map((s, i) =>
        isMobile ? (
          <li key={s.id}>
            <span className="mobile-trending-rank">{i + 1}</span>
            <MobileRecordingCard
              showCategory={false}
              shiur={s}
              onPlay={onPlay}
              onDetails={onDetails}
              onTeacher={(s) =>
                onEntity
                  ? onEntity('teacher', s.teacherId)
                  : onSearch('', { ...noFilters, teacher: String(s.teacherId) })
              }
              onSave={onSave}
              saved={savedIds.has(s.id)}
              active={activeId === s.id && playing}
            />
          </li>
        ) : (
          <li
            className={
              'trending-item' +
              (activeId === s.id && playing ? ' is-playing' : '')
            }
            key={s.id}
          >
            <span className="trending-rank">{i + 1}</span>
            <button
              className={'trending-cover ' + tone(s.teacherId)}
              aria-label={
                (mediaKind(s) === 'audio' ? 'Play ' : 'Open ') + s.title
              }
              onClick={() =>
                mediaKind(s) === 'audio' ? onPlay(s) : onDetails(s)
              }
            >
              <Avatar src={s.image} name={s.teacher} />
              <span>
                {mediaKind(s) === 'audio' ? (
                  <Play size={16} fill="currentColor" />
                ) : (
                  <ArrowRight size={16} />
                )}
              </span>
            </button>
            <div className="trending-copy">
              <button dir="auto" onClick={() => onDetails(s)}>
                {s.title}
              </button>
              <p>
                <TeacherLink
                  shiur={s}
                  onTeacher={(s) =>
                    onEntity
                      ? onEntity('teacher', s.teacherId)
                      : onSearch('', {
                          ...noFilters,
                          teacher: String(s.teacherId),
                        })
                  }
                />
              </p>
              <small>
                <ShiurViews shiur={s} />
                <span>·</span>
                {s.duration
                  ? Math.round(s.duration / 60) + ' min'
                  : mediaKind(s)}
              </small>
            </div>
            <button
              className="icon-button"
              aria-label={(savedIds.has(s.id) ? 'Unsave ' : 'Save ') + s.title}
              aria-pressed={savedIds.has(s.id)}
              onClick={() => onSave(s)}
            >
              <Bookmark
                size={17}
                fill={savedIds.has(s.id) ? 'currentColor' : 'none'}
              />
            </button>
          </li>
        ),
      )}
    </ol>
  );
  const subjects = [
    {
      key: 'halacha',
      label: 'Practical halacha',
      title: 'Ten Minute Halacha',
      hebrew: 'הלכה',
      note: shortSeries
        ? `${shortSeries.count.toLocaleString()} shiurim`
        : 'Practical learning in 10 minutes',
      icon: Timer,
      go: () =>
        shortSeries
          ? onEntity
            ? onEntity('series', shortSeries.id)
            : onSearch('', { ...noFilters, series: String(shortSeries.id) })
          : onSearch('halacha', { ...noFilters, max: '10' }),
    },
    {
      key: 'gemara',
      label: 'Talmud',
      title: 'Gemara shiurim',
      hebrew: 'גמרא',
      note: 'From the beis medrash',
      icon: BookOpen,
      go: () => onSearch('gemara'),
    },
    {
      key: 'thought',
      label: 'Jewish thought',
      title: 'Machshava',
      hebrew: 'מחשבה',
      note: 'The questions that matter',
      icon: Lightbulb,
      go: () => onSearch('machshava'),
    },
    {
      key: 'tefillah',
      label: 'Prayer',
      title: 'Tefillah',
      hebrew: 'תפילה',
      note: 'Understanding our prayers',
      icon: Sparkles,
      go: () => onSearch('tefillah'),
    },
  ];

  return (
    <div
      className={
        'listening-home ' +
        (isHome ? 'has-mobile-home' : '') +
        (followingPage ? ' following-page' : '') +
        (trendingPage ? ' trending-page' : '')
      }
    >
      {isHome && isMobile && (
        <Suspense fallback={<output>Loading recommendations…</output>}>
          <MobileDiscover
            onTrending={() => setTrendingWanted(true)}
            subjects={subjects}
            home={home}
            directory={directory}
            library={library}
            pick={pick}
            items={items.map(({ shiur }) => shiur)}
            trending={discoveryCharts['week:0']?.trending ?? []}
            trendingLoading={discoveryLoading && !discoveryCharts['week:0']}
            trendingError={discoveryError}
            continuing={continuing}
            activeId={activeId}
            playing={playing}
            refreshing={refreshing}
            onPlay={onPlay}
            onDetails={onDetails}
            onSave={onSave}
            onSearch={onSearch}
            homeSearch={homeSearch}
            onEntity={onEntity}
            onDaf={onDaf}
            onNavigate={onNavigate}
            onPreferences={() => setPreferences(true)}
            onRefresh={refreshAll}
          />
          {props.dataTiming && <DataCommitMarker timings={props.dataTiming} />}
        </Suspense>
      )}
      {(!isHome || !isMobile) && (
        <>
          {props.dataTiming && <DataCommitMarker timings={props.dataTiming} />}
          {trendingPage && isMobile && (
            <button
              className="mobile-trending-back"
              onClick={() => onNavigate('discover')}
            >
              <ArrowLeft size={16} /> Home
            </button>
          )}
          <header className="discover-heading">
            <div>
              <span className="eyebrow">
                {followingPage
                  ? 'Your follows'
                  : trendingPage
                    ? 'Across the library'
                    : 'Yeshiva University · RIETS'}
              </span>
              <h1>
                {followingPage
                  ? 'Following'
                  : trendingPage
                    ? isMobile
                      ? 'Trending shiurim'
                      : 'Trending in the library.'
                    : 'The Torah library.'}
              </h1>
              {(followingPage || trendingPage) && (
                <p>
                  {followingPage
                    ? 'New shiurim from the teachers and library pages you follow.'
                    : 'Discover the recordings listeners are exploring.'}
                </p>
              )}
            </div>
            <div className="discover-heading-tools">
              {trendingPage && isMobile ? (
                <button
                  className="icon-button"
                  aria-label="Refresh trending"
                  onClick={refreshAll}
                  disabled={discoveryLoading}
                >
                  <RefreshCw
                    size={18}
                    className={discoveryLoading ? 'spin' : ''}
                  />
                </button>
              ) : (
                <button
                  className="outline-button discover-preferences"
                  aria-label="Customize learning preferences"
                  onClick={() => setPreferences(true)}
                >
                  <Settings2 size={16} />
                  <span>Preferences</span>
                </button>
              )}
            </div>
          </header>
          {!followingPage && !trendingPage && (
            <div className="discovery-tabs" aria-label="Discovery views">
              {[
                { value: 'for-you', label: 'For you', icon: Sparkles },
                { value: 'trending', label: 'Trending', icon: Flame },
                { value: 'following', label: 'Following', icon: Users },
                { value: 'featured', label: 'Featured', icon: Star },
                {
                  value: 'continue',
                  label: 'Continue learning',
                  icon: History,
                },
              ].map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  aria-pressed={
                    currentTab === value ||
                    (value === 'for-you' && currentTab === 'recommended')
                  }
                  onClick={() => {
                    setTab(value);
                    setLimit(8);
                  }}
                >
                  <Icon size={15} />
                  {label}
                </button>
              ))}
            </div>
          )}
          {isHome && (
            <section className="home-hero" aria-label="Featured shiur">
              <div className="home-hero-main">
                <span className="home-hero-eyebrow">
                  Featured shiur
                  {pick?.category ? ' · ' + pick.category : ''}
                </span>
                <FeaturedTitle>
                  {pick ? (
                    <button dir="auto" onClick={() => onDetails(pick)}>
                      {pick.title}
                    </button>
                  ) : (
                    'Explore the Torah library'
                  )}
                </FeaturedTitle>
                {pick && (
                  <p className="home-hero-byline">
                    <strong>
                      <TeacherLink
                        shiur={pick}
                        onTeacher={(s) =>
                          onEntity
                            ? onEntity('teacher', s.teacherId)
                            : onSearch('', {
                                ...noFilters,
                                teacher: String(s.teacherId),
                              })
                        }
                      />
                    </strong>
                    {pick.duration > 0 && (
                      <span>{Math.round(pick.duration / 60)} min</span>
                    )}
                    {pick.topics[0] && <span dir="auto">{pick.topics[0]}</span>}
                    <ShiurViews shiur={pick} />
                  </p>
                )}
                <div className="home-hero-actions">
                  {pick && (
                    <button
                      className="hero-play"
                      onClick={() =>
                        mediaKind(pick) === 'audio'
                          ? onPlay(pick)
                          : onDetails(pick)
                      }
                      aria-label={
                        (activeId === pick.id && playing ? 'Pause ' : 'Play ') +
                        pick.title
                      }
                    >
                      {activeId === pick.id && playing ? (
                        <Pause size={18} fill="currentColor" />
                      ) : (
                        <Play size={18} fill="currentColor" />
                      )}
                      {activeId === pick.id && playing ? 'Pause' : 'Listen now'}
                    </button>
                  )}
                  {pick && (
                    <button
                      className="hero-icon"
                      aria-label={
                        (savedIds.has(pick.id) ? 'Unsave ' : 'Save ') +
                        pick.title
                      }
                      aria-pressed={savedIds.has(pick.id)}
                      onClick={() => onSave(pick)}
                    >
                      <Bookmark
                        size={18}
                        fill={savedIds.has(pick.id) ? 'currentColor' : 'none'}
                      />
                    </button>
                  )}
                  <button
                    className="hero-link"
                    onClick={() =>
                      pick ? onDetails(pick) : onNavigate('search')
                    }
                  >
                    {pick ? 'Shiur details' : 'Search the library'}
                    <ArrowRight size={16} />
                  </button>
                </div>
              </div>
              {pick && (
                <figure
                  className={'home-hero-portrait ' + tone(pick.teacherId)}
                >
                  <Avatar src={pick.image} name={pick.teacher} />
                </figure>
              )}
              {upNext.length > 0 && (
                <aside
                  className="home-hero-next"
                  aria-label="More featured shiurim"
                >
                  <h3>Also featured</h3>
                  {upNext.map((s) => (
                    <div className="hero-next-item" key={s.id}>
                      <button
                        className={'hero-next-art ' + tone(s.teacherId)}
                        aria-label={
                          (mediaKind(s) === 'audio'
                            ? activeId === s.id && playing
                              ? 'Pause '
                              : 'Play '
                            : 'Open ') + s.title
                        }
                        onClick={() =>
                          mediaKind(s) === 'audio' ? onPlay(s) : onDetails(s)
                        }
                      >
                        <Avatar src={s.image} name={s.teacher} />
                        <span>
                          {activeId === s.id && playing ? (
                            <Pause size={13} fill="currentColor" />
                          ) : (
                            <Play size={13} fill="currentColor" />
                          )}
                        </span>
                      </button>
                      <button
                        className="hero-next-copy"
                        onClick={() => onDetails(s)}
                      >
                        <strong dir="auto">{s.title}</strong>
                        <small>
                          {s.teacher}
                          {s.duration > 0 &&
                            ` · ${Math.round(s.duration / 60)} min`}
                          <ShiurViews shiur={s} />
                        </small>
                      </button>
                    </div>
                  ))}
                </aside>
              )}
            </section>
          )}
          {isHome && continuing.length > 0 && (
            <section className="discovery-section resume-section">
              {sectionHeading(
                'Pick up where you left off',
                undefined,
                () => setTab('continue'),
                'Your history',
              )}
              <div className="resume-card-grid">
                {continuing.slice(0, 3).map((h) => (
                  <article className="listening-resume" key={h.shiur.id}>
                    <span className={'resume-art ' + tone(h.shiur.teacherId)}>
                      <Avatar src={h.shiur.image} name={h.shiur.teacher} />
                    </span>
                    <div>
                      <button onClick={() => onDetails(h.shiur)} dir="auto">
                        {h.shiur.title}
                      </button>
                      <p>{h.shiur.teacher}</p>
                      <progress
                        value={h.seconds}
                        max={h.duration || 1}
                        aria-label={'Listening progress for ' + h.shiur.title}
                      />
                      <small>
                        {h.duration > 0
                          ? Math.max(
                              1,
                              Math.ceil((h.duration - h.seconds) / 60),
                            ) + ' min left'
                          : 'Resume your shiur'}
                      </small>
                    </div>
                    <button
                      className="resume-control"
                      aria-label={'Resume ' + h.shiur.title}
                      onClick={() => onPlay(h.shiur, h.seconds)}
                    >
                      <Play size={17} fill="currentColor" />
                    </button>
                  </article>
                ))}
              </div>
            </section>
          )}
          {isHome && home && (
            <section className="today-band" aria-label="Today's daily learning">
              <div className="today-band-heading">
                <span className="eyebrow">Today in Torah</span>
                <h2 lang="he" dir="rtl">
                  {home.hebrewDate}
                </h2>
              </div>
              <div className="today-band-items">
                {[
                  ['This week’s parsha', home.parsha || ''],
                  ['Daf Yomi', home.daf],
                  ['Mishna Yomi', home.mishna],
                  ['Nach Yomi', home.nach],
                ]
                  .filter(([, value]) => value)
                  .map(([label, value]) => (
                    <button
                      key={label}
                      onClick={() =>
                        label === 'Daf Yomi' && onDaf
                          ? onDaf(value)
                          : onSearch(value)
                      }
                    >
                      <small>{label}</small>
                      <strong dir="auto">{value}</strong>
                      <span className="today-go">
                        {label === 'Daf Yomi'
                          ? 'Study the daf'
                          : 'Find shiurim'}{' '}
                        <ArrowRight size={14} />
                      </span>
                    </button>
                  ))}
              </div>
            </section>
          )}
          {!home && (
            <StatePanel
              title="The library is taking a moment."
              description="We couldn't load YUTorah's latest shiurim. Your saved learning is still available."
            >
              <button
                className="primary-button"
                onClick={onRefresh}
                disabled={refreshing}
              >
                {refreshing && <Loader2 className="spin" size={15} />}Try again
              </button>
            </StatePanel>
          )}
          {currentTab === 'continue' ? (
            <section className="discovery-section">
              {sectionHeading(
                'Continue learning',
                'Your place is saved. Just press play.',
                () => onNavigate('history'),
                'Full history',
              )}
              {continuing.length ? (
                <div className="results-list">
                  {continuing.map((h) => (
                    <ShiurRow
                      key={h.shiur.id}
                      shiur={h.shiur}
                      onPlay={(s) => onPlay(s, h.seconds)}
                      onDetails={onDetails}
                      onTeacher={(s) =>
                        onEntity
                          ? onEntity('teacher', s.teacherId)
                          : onSearch('', {
                              ...noFilters,
                              teacher: String(s.teacherId),
                            })
                      }
                      onSave={onSave}
                      onQueue={onQueue}
                      saved={savedIds.has(h.shiur.id)}
                      progress={h}
                    />
                  ))}
                </div>
              ) : (
                <StatePanel
                  title="Your place will be waiting here."
                  description="Start listening to a shiur. We'll remember where you pause, even after you close the page."
                >
                  <button
                    className="primary-button"
                    onClick={() => setTab('for-you')}
                  >
                    Find a shiur
                    <ArrowRight size={16} />
                  </button>
                </StatePanel>
              )}
            </section>
          ) : currentTab === 'trending' ? (
            <section
              className="discovery-section"
              aria-label="Trending shiurim"
            >
              {!isMobile &&
                sectionHeading(
                  'What listeners are exploring',
                  discovery?.coverage?.status === 'paused'
                    ? 'Indexing paused while coverage is unresolved. Saved rankings remain available.'
                    : discovery?.refreshing
                      ? 'Updating rankings. Showing the last saved chart.'
                      : discovery?.partial
                        ? `Observed ${discovery.sampled.toLocaleString()} unique records; the library reports ${(discovery.libraryTotal ?? discovery.total).toLocaleString()}. Coverage is unresolved. Rankings may change.`
                        : discovery?.source === 'mobile'
                          ? 'Rankings use an observed library census. YUTorah does not provide a fixed snapshot.'
                          : undefined,
                )}
              <div className="discovery-toolbar">
                <fieldset
                  className="trending-periods"
                  aria-label="Trending period"
                  style={
                    {
                      '--period-index': trendingPeriods.findIndex(
                        ({ value }) => value === trendingPeriod,
                      ),
                    } as CSSProperties
                  }
                >
                  {trendingPeriods.map(({ value, label }) => (
                    <button
                      key={value}
                      aria-pressed={trendingPeriod === value}
                      onClick={() => {
                        setTrendingPeriod(value);
                        setTrendingLimit(12);
                      }}
                    >
                      {isMobile && value === 'day' ? 'Day' : label}
                    </button>
                  ))}
                </fieldset>
                {!isMobile && (
                  <fieldset className="time-chips" aria-label="Trending length">
                    <Timer size={15} />
                    {['all', '10', '20', '30'].map((v) => (
                      <button
                        key={v}
                        aria-pressed={minutes === v}
                        onClick={() => {
                          setMinutes(v);
                          setTrendingLimit(12);
                        }}
                      >
                        {v === 'all' ? 'Any length' : 'Under ' + v + ' min'}
                      </button>
                    ))}
                  </fieldset>
                )}
                <button
                  className="icon-button"
                  aria-label="Refresh trending"
                  onClick={refreshAll}
                  disabled={discoveryLoading}
                >
                  <RefreshCw size={16} />
                </button>
              </div>
              {isMobile &&
                (discovery?.partial ||
                  discovery?.refreshing ||
                  discovery?.coverage?.status === 'paused') && (
                  <output className="mobile-trending-status">
                    {discovery?.coverage?.status === 'paused'
                      ? 'Showing saved rankings'
                      : 'Rankings are updating'}
                  </output>
                )}
              {!isMobile && (
                <p className="trending-source">
                  {trendingPeriod === 'all'
                    ? 'Ranked by total YUTorah views across the library.'
                    : `Ranked by total YUTorah views for shiurim uploaded in the past ${
                        trendingPeriods.find((p) => p.value === trendingPeriod)!
                          .days === 1
                          ? '24 hours'
                          : trendingPeriods.find(
                              (p) => p.value === trendingPeriod,
                            )!.days + ' days'
                      }.`}{' '}
                  Dates use YUTorah&apos;s upload date. View counts are lifetime
                  totals. Some source dates have day precision.
                </p>
              )}
              {discoveryLoading && !discovery ? (
                <StatePanel
                  title="No saved chart yet."
                  description="Rankings will appear here when the background refresh is ready."
                />
              ) : discoveryError && !discovery ? (
                <StatePanel
                  title="Trending couldn't load."
                  description="YUTorah's popularity data is temporarily unavailable."
                >
                  <button className="outline-button" onClick={refreshAll}>
                    Try again
                  </button>
                </StatePanel>
              ) : trending.length ? (
                <>
                  {discoveryError && (
                    <output className="feed-notice">
                      Refresh couldn&apos;t load. Showing the last chart for
                      this range.{' '}
                      <button onClick={refreshAll}>Try again</button>
                    </output>
                  )}
                  {trendingList(trendingLimit)}
                  {trending.length > trendingLimit && (
                    <button
                      className="outline-button discovery-more"
                      onClick={() => setTrendingLimit((n) => n + 12)}
                    >
                      Browse more shiurim <ArrowRight size={15} />
                    </button>
                  )}
                </>
              ) : (
                <StatePanel
                  title={
                    discovery?.partial
                      ? isMobile
                        ? 'Updating this chart…'
                        : 'Indexing this range…'
                      : 'No viewed shiurim match this range.'
                  }
                  description={
                    discovery?.partial
                      ? isMobile
                        ? 'More shiurim will appear as rankings update.'
                        : 'The chart will update as more shiurim are indexed.'
                      : isMobile
                        ? 'Choose another period to see more shiurim.'
                        : 'Choose another period or length to see more shiurim.'
                  }
                />
              )}
            </section>
          ) : (
            <section className="discovery-section recommended-section">
              {currentTab !== 'following' &&
                sectionHeading(
                  currentTab === 'featured'
                    ? 'Featured shiurim'
                    : 'Recommended for you',
                  currentTab === 'featured'
                    ? 'Selected by the YUTorah editors.'
                    : hasInterests
                      ? 'Based on the series, collections, teachers, and subjects you learn.'
                      : 'Featured and recent shiurim from the YUTorah library.',
                  isHome
                    ? () => {
                        setTab('recommended');
                        setLimit(10);
                      }
                    : undefined,
                  'View all',
                  recommendationView,
                )}
              {currentTab === 'following' && library.following.length > 0 && (
                <div className="discovery-toolbar">
                  <fieldset className="time-chips" aria-label="Follow type">
                    {[
                      { value: 'all', label: 'All follows' },
                      { value: 'teacher', label: 'Teachers' },
                      { value: 'series', label: 'Series' },
                      { value: 'collection', label: 'Collections' },
                      { value: 'topic', label: 'Topics' },
                      { value: 'venue', label: 'Venues' },
                    ].map(({ value, label }) => (
                      <button
                        key={value}
                        aria-pressed={followingKind === value}
                        onClick={() => {
                          setFollowingKind(value as typeof followingKind);
                          setLimit(8);
                          setSourceLimit(8);
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </fieldset>
                  {refreshRecommendations}
                </div>
              )}
              {currentTab === 'following' && sources.length > 0 && (
                <div className="following-chips">
                  {sources.map((f) => (
                    <div key={f.kind + f.id}>
                      <button
                        onClick={() =>
                          onSearch('', { ...noFilters, [f.kind]: String(f.id) })
                        }
                      >
                        {f.name}
                      </button>
                      <button
                        aria-label={'Unfollow ' + f.name}
                        onClick={() => onFollow(f)}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {!recommendationView && currentTab !== 'following' && (
                <div className="discovery-toolbar">
                  <div className="time-chips" aria-label="Time available">
                    <Timer size={15} />
                    {['all', '10', '20', '30'].map((v) => (
                      <button
                        key={v}
                        aria-pressed={minutes === v}
                        onClick={() => {
                          setMinutes(v);
                          setLimit(8);
                        }}
                      >
                        {v === 'all' ? 'Any length' : 'Under ' + v + ' min'}
                      </button>
                    ))}
                  </div>
                  {refreshRecommendations}
                </div>
              )}
              {feedLoading && (
                <output className="feed-loading">
                  <Loader2 size={14} className="spin" />
                  Finding shiurim for you…
                </output>
              )}
              {feedError && (
                <p className="feed-notice">
                  Some learning sources could not load.{' '}
                  <button onClick={refreshAll}>Try again</button>
                </p>
              )}
              {currentTab === 'following' && sourceLimit < sources.length && (
                <button
                  className="outline-button"
                  onClick={() => setSourceLimit((n) => n + 8)}
                >
                  Load more followed sources (
                  {Math.min(sourceLimit, sources.length)} of {sources.length})
                </button>
              )}
              {currentTab === 'following' && !library.following.length ? (
                <StatePanel
                  title="Choose what to follow"
                  description="Follow teachers, topics, series, venues, or collections to see their latest shiurim here."
                >
                  <button
                    className="primary-button"
                    onClick={() => onNavigate('teachers')}
                  >
                    Discover teachers
                    <ArrowRight size={16} />
                  </button>
                </StatePanel>
              ) : currentTab === 'following' && !sources.length ? (
                <StatePanel
                  title="No follows of this type yet."
                  description="Follow a page in Browse to see its latest shiurim here, or choose All follows."
                >
                  <button
                    className="outline-button"
                    onClick={() => {
                      setFollowingKind('all');
                      setLimit(8);
                      setSourceLimit(8);
                    }}
                  >
                    All follows
                  </button>
                </StatePanel>
              ) : items.length ? (
                <>
                  {cards(
                    items,
                    isHome ? 5 : limit,
                    recommendationView,
                    recommendationView,
                  )}
                  {!isHome && items.length > limit && (
                    <button
                      className="outline-button discovery-more"
                      onClick={() => setLimit((n) => n + 10)}
                    >
                      Browse more shiurim
                      <ArrowRight size={15} />
                    </button>
                  )}
                </>
              ) : currentTab === 'following' ? (
                !feedLoading && (
                  <StatePanel
                    title="No new shiurim from these follows."
                    description="Try another follow type or check back for new uploads."
                  />
                )
              ) : (
                !feedLoading && (
                  <StatePanel
                    title={
                      recommendationView
                        ? 'Find your next shiur.'
                        : 'A little more time opens more possibilities.'
                    }
                    description={
                      recommendationView
                        ? 'Save a shiur or follow a teacher, series, or collection to shape your recommendations.'
                        : 'Choose a different time budget or explore another teacher.'
                    }
                  >
                    <button
                      className="outline-button"
                      onClick={() =>
                        recommendationView
                          ? onNavigate('teachers')
                          : setMinutes('all')
                      }
                    >
                      {recommendationView
                        ? 'Discover teachers'
                        : 'See all lengths'}
                    </button>
                  </StatePanel>
                )
              )}
            </section>
          )}
          {isHome && (
            <section className="discovery-section following-section">
              {sectionHeading(
                'Following',
                'The latest shiurim from teachers and library pages you follow.',
                () => onNavigate('following'),
              )}
              {!library.following.length ? (
                <StatePanel
                  title="Choose what to follow"
                  description="Follow teachers, topics, or series to see their latest shiurim here."
                >
                  <button
                    className="outline-button"
                    onClick={() => onNavigate('teachers')}
                  >
                    Discover teachers <ArrowRight size={15} />
                  </button>
                </StatePanel>
              ) : followingItems.length ? (
                cards(followingItems, 5, true)
              ) : feedLoading ? (
                <output className="feed-loading">
                  <Loader2 size={14} className="spin" /> Loading your follows…
                </output>
              ) : (
                <StatePanel
                  title="No followed shiurim to show here yet."
                  description="Open Following to browse more of your follows."
                />
              )}
            </section>
          )}
          {isHome && (
            <section
              className="discovery-section trending-section"
              ref={trendingSection}
            >
              {sectionHeading(
                'Trending this week',
                'The most viewed new shiurim in the library.',
                () => onNavigate('trending'),
                'Full chart',
              )}
              {(discoveryLoading || !trendingWanted) && !discovery ? (
                <p className="discovery-muted">
                  Saved weekly rankings will appear here when available.
                </p>
              ) : discoveryError && !discovery ? (
                <p className="discovery-muted">
                  Popularity data couldn&apos;t load.{' '}
                  <button className="text-button" onClick={refreshAll}>
                    Try again
                  </button>
                </p>
              ) : (
                trendingList(6)
              )}
            </section>
          )}
          {isHome && (
            <>
              <section className="discovery-section collections-section">
                {sectionHeading(
                  'Explore by subject',
                  undefined,
                  () => onNavigate('topics'),
                  'All topics',
                )}
                <div className="collection-grid">
                  {subjects.map(
                    ({ key, label, title, hebrew, note, icon: Icon, go }) => (
                      <button
                        key={key}
                        className={'collection-tile collection-' + key}
                        onClick={go}
                      >
                        <span className="collection-top">
                          <Icon size={16} />
                          {label}
                        </span>
                        <span
                          className="collection-letter"
                          data-he={hebrew}
                          aria-hidden="true"
                        />
                        <h3>{title}</h3>
                        <span className="collection-bottom">
                          {note}
                          <ArrowRight size={16} />
                        </span>
                      </button>
                    ),
                  )}
                </div>
              </section>
              {teachers.length > 0 && (
                <section className="discovery-section teacher-shelf-section">
                  {sectionHeading(
                    'Teachers to know',
                    undefined,
                    () => onNavigate('teachers'),
                    'All teachers',
                  )}
                  <div className="teacher-shelf">
                    {teachers.map((t) => (
                      <article key={t.id}>
                        <button
                          className="teacher-shelf-profile"
                          onClick={() =>
                            onEntity
                              ? onEntity('teacher', t.id)
                              : onSearch('', {
                                  ...noFilters,
                                  teacher: String(t.id),
                                })
                          }
                        >
                          <span className={'teacher-portrait ' + tone(t.id)}>
                            <Avatar src={t.image} name={t.name} />
                          </span>
                          <h3>{t.name}</h3>
                          <p>{t.count.toLocaleString()} shiurim</p>
                        </button>
                        <FollowButton
                          compact
                          follow={{
                            kind: 'teacher',
                            id: t.id,
                            name: t.name,
                            image: t.image,
                          }}
                          library={library}
                          onFollow={onFollow}
                        />
                      </article>
                    ))}
                  </div>
                </section>
              )}
              {!!shelfSeries?.length && (
                <section className="discovery-section series-shelf-section">
                  {sectionHeading(
                    'Go deeper with a series',
                    undefined,
                    () => onNavigate('series'),
                    'All series',
                  )}
                  <div className="series-shelf">
                    {shelfSeries.map((s) => (
                      <article key={s.id}>
                        <button
                          onClick={() =>
                            onEntity
                              ? onEntity('series', s.id)
                              : onSearch('', {
                                  ...noFilters,
                                  series: String(s.id),
                                })
                          }
                        >
                          <SeriesCover
                            name={s.name}
                            id={s.id}
                            image={s.image}
                          />
                          <h3 dir="auto">{s.name}</h3>
                          <p>
                            {(
                              directory?.series.find(
                                (series) => series.id === s.id,
                              )?.count ?? s.count
                            ).toLocaleString()}{' '}
                            shiurim
                          </p>
                        </button>
                        <FollowButton
                          compact
                          follow={{ kind: 'series', id: s.id, name: s.name }}
                          library={library}
                          onFollow={onFollow}
                        />
                      </article>
                    ))}
                  </div>
                </section>
              )}
              <p className="learning-local-note">
                Your library stays on this device and syncs across devices when
                you sign in.
              </p>
            </>
          )}
        </>
      )}
      <Dialog open={preferences} onOpenChange={setPreferences}>
        <DialogContent className="learning-preferences">
          <DialogHeader>
            <DialogTitle>Make this space yours</DialogTitle>
            <DialogDescription>
              Choose what you want to learn. You can change this any time.
            </DialogDescription>
          </DialogHeader>
          <div className="preferences-body">
            <section>
              <h3>
                <Users size={18} />
                Your follows <span>{library.following.length}</span>
              </h3>
              {library.following.length ? (
                <div className="preferences-follows">
                  {library.following.map((f) => (
                    <div key={f.kind + f.id}>
                      <span>
                        {f.name}
                        <small>{f.kind}</small>
                      </span>
                      <FollowButton
                        follow={f}
                        library={library}
                        onFollow={onFollow}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <p>Follow a few teachers or topics below to get started.</p>
              )}
            </section>
            <section>
              <h3>Choose a few interests</h3>
              <div className="interest-chips">
                {suggestedTopics.map((t) => (
                  <button
                    key={t.id}
                    aria-pressed={library.following.some(
                      (f) => f.kind === 'topic' && f.id === t.id,
                    )}
                    onClick={() =>
                      onFollow({ kind: 'topic', id: t.id, name: t.name })
                    }
                  >
                    {library.following.some(
                      (f) => f.kind === 'topic' && f.id === t.id,
                    ) ? (
                      <Check size={14} />
                    ) : (
                      <Plus size={14} />
                    )}
                    {t.name}
                  </button>
                ))}
              </div>
              <button
                className="text-button"
                onClick={() => {
                  setPreferences(false);
                  onNavigate('teachers');
                }}
              >
                Choose teachers from the directory <ArrowRight size={15} />
              </button>
            </section>
            {library.hidden.length > 0 && (
              <section>
                <h3>Hidden suggestions</h3>
                <p>{library.hidden.length} shiurim hidden from your feed.</p>
                <button
                  className="outline-button"
                  onClick={() => {
                    update((old) => ({ ...old, hidden: [] }));
                    notify('Hidden suggestions restored.');
                  }}
                >
                  Restore hidden suggestions
                </button>
              </section>
            )}
            <button
              className="primary-button preferences-done"
              onClick={() => setPreferences(false)}
            >
              Back to learning <ArrowRight size={16} />
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
