/* oxlint-disable next/no-img-element -- Subject art is pre-sized, lazy-loaded local WebP. */
'use client';
import { ShiurViews } from './shiur-views';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useIsMobile } from '@/hooks/use-mobile';
import { BoundedCache } from '@/lib/bounded-cache';
const feedBatches = new BoundedCache<{ items: Shiur[]; partial: boolean }>(
  64,
  4 * 1024 * 1024,
);
import {
  ArrowRight,
  Bookmark,
  BookOpen,
  Check,
  Eye,
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
  Target,
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
  SeriesCover,
  ShiurCard,
  ShiurRow,
  StatePanel,
  tone,
  useSeriesWithArt,
} from './ui';
import { noFilters, type Filters } from '@/lib/search-filters';
import { MobileDiscover } from './mobile-discover';
import type { Directory, HomeData, Shiur } from '@/lib/yutorah';
import { mediaKind, selectHomeFeature } from '@/lib/yutorah';
import type { LibraryState } from '@/lib/library';
import {
  trendingPeriods,
  type DiscoveryData,
  type TrendingPeriod,
} from '@/lib/trending';
import {
  isLearned,
  learningStats,
  recommend,
  mergeShiurim,
  type Follow,
} from '@/lib/learning';

import { FollowButton } from './follow-button';
export { FollowButton } from './follow-button';

type Props = {
  home: HomeData | null;
  directory: Directory | null;
  library: LibraryState;
  update: (fn: (old: LibraryState) => LibraryState) => void;
  onPlay: (shiur: Shiur, seconds?: number) => void;
  onDetails: (shiur: Shiur) => void;
  onSave: (shiur: Shiur) => void;
  onQueue: (shiur: Shiur) => void;
  onFollow: (follow: Follow) => void;
  onSearch: (query: string, filters?: Filters) => void;
  onNavigate: (
    view:
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
  const [minutes, setMinutes] = useState('all');
  const [limit, setLimit] = useState(8);
  const [browseMore, setBrowseMore] = useState(false);
  const [preferences, setPreferences] = useState(false);
  const [feedItems, setFeedItems] = useState<Shiur[]>([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedError, setFeedError] = useState(false);
  const [trendingPeriod, setTrendingPeriod] = useState<TrendingPeriod>('week');
  const [trendingLimit, setTrendingLimit] = useState(12);
  const [discoveryCharts, setDiscoveryCharts] = useState<
    Record<string, DiscoveryData>
  >({});
  const trendingMinutes = minutes === 'all' ? 0 : Number(minutes);
  const discoveryKey = `${trendingPeriod}:${trendingMinutes}`;
  const discovery = discoveryCharts[discoveryKey] ?? null;
  const [discoveryError, setDiscoveryError] = useState(false);
  const [discoveryLoading, setDiscoveryLoading] = useState(true);
  const [relatedItems, setRelatedItems] = useState<Shiur[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [discoveryPass, setDiscoveryPass] = useState(0);
  const [discoveryRetry, setDiscoveryRetry] = useState(0);
  const currentTab = followingPage
    ? 'following'
    : trendingPage
      ? 'trending'
      : tab;
  useEffect(() => {
    if (currentTab !== 'trending' || discoveryLoading) return;
    const indexing =
      (discovery?.partial || discovery?.refreshing) &&
      !discovery.stale &&
      !discoveryError;
    if (!indexing && !discoveryRetry) return;
    const timer = window.setTimeout(
      () => setDiscoveryPass((n) => n + 1),
      discoveryRetry ? discoveryRetry * 1000 : 3500,
    );
    return () => window.clearTimeout(timer);
  }, [currentTab, discovery, discoveryLoading, discoveryError, discoveryRetry]);
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
  const anchorId = (library.history[0]?.shiur || library.saved[0])?.id;

  const sources = useMemo(() => {
    const chosen = [...library.following];
    for (const h of library.history.slice(0, 4)) {
      if (
        h.shiur.teacherId > 0 &&
        !chosen.some((f) => f.kind === 'teacher' && f.id === h.shiur.teacherId)
      )
        chosen.push({
          kind: 'teacher',
          id: h.shiur.teacherId,
          name: h.shiur.teacher,
        });
    }
    return chosen;
  }, [library.following, library.history]);
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
        for (const kind of ['teacher', 'topic', 'series'])
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
            : await fetch('/api/feed?' + query, {
                signal: abort.signal,
              });
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
    if (currentTab !== 'trending' && !trendingWanted) {
      setDiscoveryLoading(false);
      return;
    }
    const abort = new AbortController();
    setDiscoveryLoading(true);
    setDiscoveryError(false);
    setDiscoveryRetry(0);
    const query = new URLSearchParams({
      period: trendingPeriod,
      minutes: String(trendingMinutes),
    });
    fetch('/api/discover?' + query, { signal: abort.signal })
      .then(async (res) => {
        if (!res.ok) {
          if (
            (res.status === 503 || res.status === 502) &&
            !abort.signal.aborted
          )
            setDiscoveryRetry(
              Math.min(
                30,
                Math.max(5, Number(res.headers.get('Retry-After')) || 30),
              ),
            );
          throw new Error('Discovery unavailable');
        }
        const data = (await res.json()) as DiscoveryData;
        if (data.period !== trendingPeriod || data.minutes !== trendingMinutes)
          throw new Error('Discovery returned a different chart');
        if (!abort.signal.aborted) {
          setDiscoveryCharts((old) => ({ ...old, [discoveryKey]: data }));
          if (data.stale) setDiscoveryRetry(30);
        }
      })
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
    trendingPeriod,
    trendingMinutes,
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
          minutes === 'all' &&
          home?.featured.length
          ? home.featured
          : allItems,
        library,
        {
          followingOnly: currentTab === 'following',
          minutes: minutes === 'all' ? undefined : Number(minutes),
          now: home?.fetchedAt ? Date.parse(home.fetchedAt) : 0,
        },
      ),
    [allItems, home, library, currentTab, minutes],
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
  const stats = learningStats(library.learningDays);
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
      minutes === 'all' ||
      (s.duration > 0 && s.duration <= Number(minutes) * 60),
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
  const goalProgress = Math.min(1, stats.today / 60 / (library.dailyGoal || 1));
  const sectionHeading = (
    title: string,
    description?: string,
    action?: () => void,
    label = 'View all',
  ) => (
    <div className="discovery-section-heading">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {action && (
        <button className="section-link" onClick={action}>
          {label}
          <ArrowRight size={15} />
        </button>
      )}
    </div>
  );
  const cards = (entries: typeof ranked, count = limit, row = false) => (
    <div className={'discovery-card-grid' + (row ? ' is-row' : '')}>
      {entries.slice(0, count).map(({ shiur: s }) => (
        <div className="recommendation-item" key={s.id}>
          <ShiurCard
            shiur={s}
            onPlay={onPlay}
            onDetails={onDetails}
            onSave={onSave}
            saved={savedIds.has(s.id)}
            active={activeId === s.id && playing}
          />
        </div>
      ))}
    </div>
  );
  const trendingList = (count: number) => (
    <ol className="trending-list">
      {trending.slice(0, count).map((s, i) => (
        <li
          className={
            'trending-item' + (activeId === s.id && playing ? ' is-playing' : '')
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
            <p>{s.teacher}</p>
            <small>
              <ShiurViews shiur={s} /><span>·</span>
              {s.duration ? Math.round(s.duration / 60) + ' min' : mediaKind(s)}
            </small>
          </div>
          <button
            className="icon-button"
            aria-label={(savedIds.has(s.id) ? 'Unsave ' : 'Save ') + s.title}
            aria-pressed={savedIds.has(s.id)}
            onClick={() => onSave(s)}
          >
            <Bookmark size={17} fill={savedIds.has(s.id) ? 'currentColor' : 'none'} />
          </button>
        </li>
      ))}
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
          ? onSearch('', { ...noFilters, series: String(shortSeries.id) })
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
    <div className={'listening-home ' + (isHome ? 'has-mobile-home' : '')}>
      {isHome && isMobile && (
        <MobileDiscover
          onTrending={() => setTrendingWanted(true)}
          subjects={subjects}
          home={home}
          directory={directory}
          library={library}
          pick={pick}
          items={items.map(({ shiur }) => shiur)}
          trending={discoveryCharts['week:0']?.trending ?? []}
          trendingLoading={discoveryLoading}
          trendingError={discoveryError}
          continuing={continuing}
          activeId={activeId}
          playing={playing}
          refreshing={refreshing}
          onPlay={onPlay}
          onDetails={onDetails}
          onSave={onSave}
          onSearch={onSearch}
          onNavigate={onNavigate}
          onPreferences={() => setPreferences(true)}
          onRefresh={refreshAll}
        />
      )}
      {(!isHome || !isMobile) && (
        <>
          <header className="discover-heading">
            <div>
              <span className="eyebrow">
                {followingPage
                  ? 'Your teachers & subjects'
                  : trendingPage
                    ? 'Across the library'
                    : 'Yeshiva University · RIETS'}
              </span>
              <h1>
                {followingPage
                  ? 'Following'
                  : trendingPage
                    ? 'Trending in the library.'
                    : 'The Torah library.'}
              </h1>
              <p>
                {followingPage
                  ? 'New learning from the teachers and subjects you follow.'
                  : trendingPage
                    ? 'Discover the recordings listeners are exploring.'
                    : home
                      ? `${home.total.toLocaleString()} shiurim from Yeshiva University’s roshei yeshiva and Torah educators around the world.`
                      : 'Shiurim from Yeshiva University’s roshei yeshiva and Torah educators around the world.'}
              </p>
            </div>
            <div className="discover-heading-tools">
              <button
                className="outline-button discover-preferences"
                aria-label="Customize learning preferences"
                onClick={() => setPreferences(true)}
              >
                <Settings2 size={16} />
                <span>Preferences</span>
              </button>
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
                  aria-pressed={currentTab === value}
                  onClick={() => {
                    setTab(value);
                    setLimit(8);
                    setBrowseMore(false);
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
                <h2>
                  {pick ? (
                    <button dir="auto" onClick={() => onDetails(pick)}>
                      {pick.title}
                    </button>
                  ) : (
                    'Explore the Torah library'
                  )}
                </h2>
                {pick && (
                  <p className="home-hero-byline">
                    <strong>{pick.teacher}</strong>
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
                <figure className={'home-hero-portrait ' + tone(pick.teacherId)}>
                  <Avatar src={pick.image} name={pick.teacher} />
                </figure>
              )}
              {upNext.length > 0 && (
                <aside className="home-hero-next" aria-label="More featured shiurim">
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
                <p>Daily learning cycles, ready when you are.</p>
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
                    <button key={label} onClick={() => onSearch(value)}>
                      <small>{label}</small>
                      <strong dir="auto">{value}</strong>
                      <span className="today-go">
                        Find shiurim <ArrowRight size={14} />
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
            <section className="discovery-section">
              {sectionHeading(
                'What listeners are exploring',
                discovery?.refreshing
                  ? 'Updating rankings. Showing the last complete chart.'
                  : discovery?.partial
                    ? `Indexing ${discovery.sampled.toLocaleString()} of ${(discovery.libraryTotal ?? discovery.total).toLocaleString()} ${discovery.source === 'mobile' ? 'library records' : 'matching shiurim'}. Rankings may change.`
                    : discovery
                      ? `Most viewed among ${discovery.total.toLocaleString()} matching shiurim${trendingPeriod === 'all' ? ' across the library' : ' in this date range'}.`
                      : 'View counts come directly from YUTorah.',
              )}
              <div className="discovery-toolbar">
                <fieldset
                  className="trending-periods"
                  aria-label="Trending period"
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
                      {label}
                    </button>
                  ))}
                </fieldset>
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
                <button
                  className="icon-button"
                  aria-label="Refresh trending"
                  onClick={refreshAll}
                  disabled={discoveryLoading}
                >
                  <RefreshCw
                    size={16}
                    className={discoveryLoading ? 'spin' : ''}
                  />
                </button>
              </div>
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
              {discovery && (
                <p className="trending-freshness">
                  {discovery.stale
                    ? 'Showing cached results. Last updated '
                    : 'Updated '}
                  <time dateTime={discovery.fetchedAt}>
                    {new Date(discovery.fetchedAt).toLocaleString()}
                  </time>
                  {discoveryLoading && ' · Refreshing…'}
                  <span>
                    {' '}
                    · Upload window ends{' '}
                    <time dateTime={discovery.before}>
                      {new Date(discovery.before).toLocaleString()}
                    </time>
                  </span>
                </p>
              )}
              {discoveryLoading && !discovery ? (
                <div className="discovery-loading">
                  <Loader2 size={18} className="spin" />
                  Finding trending shiurim…
                </div>
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
                      ? 'Indexing this range…'
                      : 'No viewed shiurim match this range.'
                  }
                  description={
                    discovery?.partial
                      ? 'The chart will update as more shiurim are indexed.'
                      : 'Choose another period or length to see more shiurim.'
                  }
                />
              )}
            </section>
          ) : (
            <section className="discovery-section recommended-section">
              {sectionHeading(
                currentTab === 'following'
                  ? 'From your follows'
                  : currentTab === 'featured'
                    ? 'Featured shiurim'
                    : hasInterests
                      ? 'Recommended for you'
                      : 'Discover something new',
                currentTab === 'following'
                  ? 'A selection from your teachers, topics, and series.'
                  : currentTab === 'featured'
                    ? 'Selected by the YUTorah editors.'
                    : hasInterests
                      ? 'Inspired by what you listen to, save, and follow.'
                      : 'Featured and recent shiurim from the YUTorah library.',
                isHome ? () => setTab('featured') : undefined,
                'Editors’ picks',
              )}
              {currentTab === 'following' && library.following.length > 0 && (
                <div className="following-chips">
                  {library.following.map((f) => (
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
              {(!followingPage || library.following.length > 0) && (
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
                </div>
              )}
              {feedLoading && (
                <output className="feed-loading">
                  <Loader2 size={14} className="spin" />
                  Finding learning from your follows…
                </output>
              )}
              {feedError && (
                <p className="feed-notice">
                  Some followed sources could not load.{' '}
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
                  title="Follow teachers and subjects"
                  description="Follow a teacher, topic, or series. Their latest shiurim will appear here."
                >
                  <button
                    className="primary-button"
                    onClick={() => onNavigate('teachers')}
                  >
                    Discover teachers
                    <ArrowRight size={16} />
                  </button>
                </StatePanel>
              ) : items.length ? (
                <>
                  {isHome
                    ? cards(items, browseMore ? limit : 5, !browseMore)
                    : cards(items)}
                  {items.length > (isHome && !browseMore ? 5 : limit) ? (
                    <button
                      className="outline-button discovery-more"
                      onClick={() => {
                        if (isHome && !browseMore) {
                          setBrowseMore(true);
                          setLimit(15);
                        } else setLimit((n) => n + 10);
                      }}
                    >
                      Browse more shiurim
                      <ArrowRight size={15} />
                    </button>
                  ) : (
                    isHome &&
                    browseMore && (
                      <button
                        className="outline-button discovery-more"
                        onClick={() => onNavigate('search')}
                      >
                        Search the full library
                        <ArrowRight size={15} />
                      </button>
                    )
                  )}
                </>
              ) : (
                !feedLoading && (
                  <StatePanel
                    title="A little more time opens more possibilities."
                    description="Choose a different time budget or explore another teacher."
                  >
                    <button
                      className="outline-button"
                      onClick={() => setMinutes('all')}
                    >
                      See all lengths
                    </button>
                  </StatePanel>
                )
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
                    <div className="trending-skeleton" aria-hidden="true">
                      {Array.from({ length: 6 }, (_, i) => (
                        <span key={i} />
                      ))}
                    </div>
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
                  {discovery && (
                    <p className="trending-source">
                      <Eye size={12} />
                      {discovery.partial ? (
                        `Indexing ${discovery.sampled.toLocaleString()} of ${(discovery.libraryTotal ?? discovery.total).toLocaleString()} ${discovery.source === 'mobile' ? 'library records' : 'matching shiurim'}. Rankings may change.`
                      ) : (
                        <>
                          Most viewed among {discovery.total.toLocaleString()}{' '}
                          matching shiurim
                          {discovery.period === 'all'
                            ? ' across the library'
                            : ' in this date range'}
                          , using YUTorah&apos;s upload date.
                        </>
                      )}
                      {discovery.stale && ' Showing cached results.'}
                    </p>
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
                  {subjects.map(({ key, label, title, hebrew, note, icon: Icon, go }) => (
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
                  ))}
                </div>
              </section>
              {teachers.length > 0 && (
                <section className="discovery-section teacher-shelf-section">
                  {sectionHeading(
                    'Teachers to know',
                    'The roshei yeshiva and educators of the YUTorah community.',
                    () => onNavigate('teachers'),
                    'All teachers',
                  )}
                  <div className="teacher-shelf">
                    {teachers.map((t) => (
                      <article key={t.id}>
                        <button
                          className="teacher-shelf-profile"
                          onClick={() =>
                            onSearch('', {
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
                    'Courses and cycles to make part of your routine.',
                    () => onNavigate('series'),
                    'All series',
                  )}
                  <div className="series-shelf">
                    {shelfSeries.map((s) => (
                      <article key={s.id}>
                        <button
                          onClick={() =>
                            onSearch('', { ...noFilters, series: String(s.id) })
                          }
                        >
                          <SeriesCover name={s.name} id={s.id} image={s.image} />
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
              <section className="learning-goal-band">
                <span
                  className="goal-ring"
                  style={
                    { '--goal': goalProgress } as React.CSSProperties
                  }
                  aria-hidden="true"
                >
                  <Target size={24} />
                </span>
                <div className="learning-goal-copy">
                  <h2>A little learning, every day.</h2>
                  <p>
                    {stats.streak
                      ? `${stats.streak} day streak. Keep it going.`
                      : 'Set a small goal. Make time to return.'}
                  </p>
                </div>
                <div className="learning-goal-progress">
                  <strong>
                    {Math.floor(stats.today / 60)}
                    <span> / {library.dailyGoal} min today</span>
                  </strong>
                  <progress
                    aria-label="Daily learning goal"
                    value={Math.min(stats.today / 60, library.dailyGoal)}
                    max={library.dailyGoal}
                  />
                  <small>
                    {Math.floor(stats.weekSeconds / 60)} minutes this week
                  </small>
                </div>
                <button
                  className="outline-button"
                  onClick={() => setPreferences(true)}
                >
                  Set your goal
                  <ArrowRight size={15} />
                </button>
              </section>
              <p className="learning-local-note">
                Your saved shiurim, progress, and follows stay on this device.
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
                <Target size={18} />
                Your daily listening goal
              </h3>
              <p>Count time spent listening, starting today.</p>
              <div className="goal-options">
                {[5, 10, 15, 20, 30, 45, 60].map((value) => (
                  <button
                    key={value}
                    aria-pressed={library.dailyGoal === value}
                    onClick={() =>
                      update((old) => ({ ...old, dailyGoal: value }))
                    }
                  >
                    {value}
                    <span>min</span>
                  </button>
                ))}
              </div>
            </section>
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
