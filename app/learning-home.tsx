'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Bookmark,
  BookOpen,
  CalendarDays,
  Check,
  ChevronRight,
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
import { Avatar, SeriesCover, ShiurCard, ShiurRow, StatePanel } from './ui';
import { noFilters, type Filters } from './advanced-search';
import { MobileDiscover } from './mobile-discover';
import type { Directory, HomeData, Shiur } from '@/lib/yutorah';
import { mediaKind, selectHomeFeature } from '@/lib/yutorah';
import type { LibraryState } from '@/lib/library';
import type { DiscoveryData } from '@/lib/discovery';
import {
  isLearned,
  learningStats,
  recommend,
  mergeShiurim,
  relatedShiurim,
  type Follow,
} from '@/lib/learning';

export function FollowButton({
  follow,
  library,
  onFollow,
  compact = false,
}: {
  follow: Follow;
  library: LibraryState;
  onFollow: (follow: Follow) => void;
  compact?: boolean;
}) {
  const following = library.following.some(
    (f) => f.kind === follow.kind && f.id === follow.id,
  );
  return (
    <button
      className={
        'follow-button ' +
        (following ? 'is-following' : '') +
        (compact ? ' compact-follow' : '')
      }
      onClick={() => onFollow(follow)}
      aria-pressed={following}
      aria-label={`${following ? 'Unfollow' : 'Follow'} ${follow.name}`}
    >
      {following ? <Check size={14} /> : <Plus size={14} />}
      <span>{following ? 'Following' : 'Follow'}</span>
    </button>
  );
}

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
  const [tab, setTab] = useState('for-you');
  const [minutes, setMinutes] = useState('all');
  const [limit, setLimit] = useState(8);
  const [preferences, setPreferences] = useState(false);
  const [feedItems, setFeedItems] = useState<Shiur[]>([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedError, setFeedError] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoveryData | null>(null);
  const [discoveryError, setDiscoveryError] = useState(false);
  const [discoveryLoading, setDiscoveryLoading] = useState(true);
  const [relatedItems, setRelatedItems] = useState<Shiur[]>([]);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [relatedError, setRelatedError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const currentTab = followingPage
    ? 'following'
    : trendingPage
      ? 'trending'
      : tab;
  const anchor = library.history[0]?.shiur || library.saved[0];
  const anchorId = anchor?.id;

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
    const selected = JSON.parse(sourceQuery) as Pick<Follow, 'kind' | 'id'>[];
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
          const res = await fetch('/api/feed?' + query, {
            signal: abort.signal,
          });
          if (!res.ok) throw new Error('Feed unavailable');
          const data = (await res.json()) as {
            items: Shiur[];
            partial: boolean;
          };
          if (abort.signal.aborted) return;
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
  }, [sourceQuery, refresh]);

  useEffect(() => {
    const abort = new AbortController();
    setDiscoveryLoading(true);
    setDiscoveryError(false);
    fetch('/api/discover', { signal: abort.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error('Discovery unavailable');
        const data = (await res.json()) as DiscoveryData;
        if (!abort.signal.aborted) setDiscovery(data);
      })
      .catch(() => {
        if (!abort.signal.aborted) setDiscoveryError(true);
      })
      .finally(() => {
        if (!abort.signal.aborted) setDiscoveryLoading(false);
      });
    return () => abort.abort();
  }, [refresh]);

  useEffect(() => {
    setRelatedItems([]);
    setRelatedError(false);
    if (!anchorId) return;
    const abort = new AbortController();
    setRelatedLoading(true);
    fetch('/api/related?id=' + anchorId, { signal: abort.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error('Related learning unavailable');
        const data = (await res.json()) as { items: Shiur[]; partial: boolean };
        if (!abort.signal.aborted) {
          setRelatedItems(data.items);
          setRelatedError(data.partial);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setRelatedError(true);
      })
      .finally(() => {
        if (!abort.signal.aborted) setRelatedLoading(false);
      });
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
    currentTab === 'latest'
      ? [...ranked].sort(
          (a, b) =>
            (Date.parse(b.shiur.date) || 0) - (Date.parse(a.shiur.date) || 0),
        )
      : ranked;
  const continuing = library.history.filter(
    (h) => h.seconds > 0 && !isLearned(h.shiur, library),
  );
  const stats = learningStats(library.learningDays);
  const followups = useMemo(
    () =>
      anchor
        ? relatedShiurim(anchor, [...relatedItems, ...allItems], library)
        : [],
    [anchor, relatedItems, allItems, library],
  );
  const teachers = (directory?.teachers || []).slice(0, 6);
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
  const markComplete = (s: Shiur) => {
    update((old) => ({
      ...old,
      completed: [...new Set([...old.completed, s.id])],
      history: old.history.some((h) => h.shiur.id === s.id)
        ? old.history
        : [
            {
              shiur: s,
              seconds: 0,
              duration: s.duration,
              updatedAt: new Date().toISOString(),
            },
            ...old.history,
          ].slice(0, 200),
    }));
    notify('Marked as learned. Find it in your learning history.');
  };
  const refreshAll = () => {
    setRefresh((n) => n + 1);
    onRefresh();
  };
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
        <button className="text-button" onClick={action}>
          {label}
          <ArrowRight size={15} />
        </button>
      )}
    </div>
  );
  const cards = (entries: typeof ranked, count = limit) => (
    <div className="discovery-card-grid">
      {entries.slice(0, count).map(({ shiur: s, reason }) => (
        <div className="recommendation-item" key={s.id}>
          <ShiurCard
            shiur={s}
            onPlay={onPlay}
            onDetails={onDetails}
            onSave={onSave}
            saved={library.saved.some((v) => v.id === s.id)}
            active={activeId === s.id && playing}
          />
          <div className="recommendation-foot">
            <span title={reason}>
              {hasInterests && <Sparkles size={12} />}
              {reason}
            </span>
            <button
              className="icon-button"
              aria-label={'Mark as learned: ' + s.title}
              onClick={() => markComplete(s)}
            >
              <Check size={15} />
            </button>
            <button
              className="icon-button"
              aria-label={'Hide suggestion: ' + s.title}
              onClick={() => {
                update((old) => ({
                  ...old,
                  hidden: [...new Set([...old.hidden, s.id])],
                }));
                notify(
                  'Suggestion hidden. Restore it in your learning preferences.',
                );
              }}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
  const trendingList = (count: number) => (
    <div className="trending-list">
      {trending.slice(0, count).map((s, i) => (
        <article className="trending-item" key={s.id}>
          <span className="trending-rank">
            {String(i + 1).padStart(2, '0')}
          </span>
          <button
            className="trending-cover"
            aria-label={'Play ' + s.title}
            onClick={() => onPlay(s)}
          >
            <Avatar src={s.image} name={s.teacher} />
            <span>
              <Play size={16} fill="currentColor" />
            </span>
          </button>
          <div className="trending-copy">
            <button dir="auto" onClick={() => onDetails(s)}>
              {s.title}
            </button>
            <p>{s.teacher}</p>
            <small>
              <Eye size={12} />
              {s.views?.toLocaleString()} views<span>·</span>
              {s.duration ? Math.round(s.duration / 60) + ' min' : mediaKind(s)}
            </small>
          </div>
          <button
            className="icon-button"
            aria-label={
              (library.saved.some((v) => v.id === s.id) ? 'Unsave ' : 'Save ') +
              s.title
            }
            aria-pressed={library.saved.some((v) => v.id === s.id)}
            onClick={() => onSave(s)}
          >
            <Bookmark
              size={17}
              fill={
                library.saved.some((v) => v.id === s.id)
                  ? 'currentColor'
                  : 'none'
              }
            />
          </button>
        </article>
      ))}
    </div>
  );

  return (
    <div className={'listening-home ' + (isHome ? 'has-mobile-home' : '')}>
      {isHome && (
        <MobileDiscover
          home={home}
          directory={directory}
          library={library}
          pick={pick}
          items={items.map(({ shiur }) => shiur)}
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
      <div className="discover-heading">
        <div>
          <span className="eyebrow">LEARNING, WHEREVER YOU ARE</span>
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
                : 'Shiurim from Yeshiva University’s roshei yeshiva and Torah educators around the world.'}
          </p>
        </div>
        <button
          className="outline-button discover-preferences"
          aria-label="Customize learning preferences"
          onClick={() => setPreferences(true)}
        >
          <Settings2 size={16} />
          <span>Learning preferences</span>
        </button>
      </div>
      {!followingPage && !trendingPage && (
        <div className="discovery-tabs" aria-label="Discovery views">
          {[
            { value: 'for-you', label: 'For you', icon: Sparkles },
            { value: 'trending', label: 'Trending', icon: Flame },
            { value: 'following', label: 'Following', icon: Users },
            { value: 'latest', label: 'Recently added', icon: CalendarDays },
            { value: 'continue', label: 'Continue learning', icon: History },
          ].map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              aria-pressed={currentTab === value}
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
                <Avatar src={h.shiur.image} name={h.shiur.teacher} />
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
                      ? Math.max(1, Math.ceil((h.duration - h.seconds) / 60)) +
                        ' min left'
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
      {isHome && (
        <>
          <section
            className="desktop-archive-feature"
            aria-label="Featured shiur"
          >
            <div className="desktop-feature-heading">
              <span>
                FEATURED SHIUR
                {pick?.category ? ' · ' + pick.category.toUpperCase() : ''}
              </span>
              {home && (
                <span>
                  <strong>{home.total.toLocaleString()}</strong> shiurim in the
                  library
                </span>
              )}
            </div>
            <div className="desktop-feature-main">
              <div>
                <h2>
                  {pick ? (
                    <button dir="auto" onClick={() => onDetails(pick)}>
                      {pick.title}
                    </button>
                  ) : (
                    'Explore the Torah library'
                  )}
                </h2>
                {pick && <p>{pick.teacher}</p>}
                <div className="desktop-feature-actions">
                  {pick && (
                    <button
                      className="desktop-feature-play"
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
                        <Pause size={16} fill="currentColor" />
                      ) : (
                        <Play size={16} fill="currentColor" />
                      )}
                      {activeId === pick.id && playing ? 'Pause' : 'Listen'}
                      {pick.duration > 0 && (
                        <span>{Math.round(pick.duration / 60)} min</span>
                      )}
                    </button>
                  )}
                  <button
                    className="desktop-feature-browse"
                    onClick={() => onNavigate('search')}
                  >
                    Search the library <ArrowRight size={17} />
                  </button>
                </div>
              </div>
              {pick && (
                <Avatar
                  className="desktop-feature-portrait"
                  src={pick.image}
                  name={pick.teacher}
                />
              )}
            </div>
          </section>

          <section className="discovery-section collections-section">
            {sectionHeading(
              'Explore the library',
              undefined,
              () => onNavigate('topics'),
              'All topics',
            )}
            <div className="collection-grid">
              <button
                className="collection-tile collection-halacha"
                onClick={() =>
                  shortSeries
                    ? onSearch('', {
                        ...noFilters,
                        series: String(shortSeries.id),
                      })
                    : onSearch('halacha', { ...noFilters, max: '10' })
                }
              >
                <div className="collection-top">
                  <Timer size={20} />
                  <span>PRACTICAL HALACHA</span>
                </div>
                <h3>
                  Ten Minute
                  <br />
                  Halacha
                </h3>
                <div className="collection-bottom">
                  <span>
                    {shortSeries
                      ? 'The series you can return to daily'
                      : 'Practical learning in 10 minutes'}
                  </span>
                  <ArrowRight size={18} />
                </div>
                <span className="collection-letter" lang="he">
                  הלכה
                </span>
              </button>
              <button
                className="collection-tile collection-parsha"
                onClick={() => onSearch(home?.parsha || 'parsha')}
              >
                <div className="collection-top">
                  <BookOpen size={20} />
                  <span>THE WEEKLY TORAH PORTION</span>
                </div>
                <h3>
                  Parsha
                  <br />
                  perspectives
                </h3>
                <div className="collection-bottom">
                  <span>{home?.parsha || 'Shiurim on the weekly parsha'}</span>
                  <ArrowRight size={18} />
                </div>
                <span className="collection-letter" lang="he">
                  פרשה
                </span>
              </button>
              <button
                className="collection-tile collection-daf"
                onClick={() => onSearch(home?.daf || 'Daf Yomi')}
              >
                <div className="collection-top">
                  <CalendarDays size={20} />
                  <span>DAILY TALMUD STUDY</span>
                </div>
                <h3>
                  Your daily
                  <br />
                  Daf Yomi
                </h3>
                <div className="collection-bottom">
                  <span>{home?.daf || 'Daily learning'}</span>
                  <ArrowRight size={18} />
                </div>
                <span className="collection-letter" lang="he">
                  דף
                </span>
              </button>
              <button
                className="collection-tile collection-thought"
                onClick={() => onSearch('machshava')}
              >
                <div className="collection-top">
                  <Lightbulb size={20} />
                  <span>JEWISH THOUGHT</span>
                </div>
                <h3>
                  Jewish
                  <br />
                  thought
                </h3>
                <div className="collection-bottom">
                  <span>Explore the questions that matter</span>
                  <ArrowRight size={18} />
                </div>
                <span className="collection-letter" lang="he">
                  מחשבה
                </span>
              </button>
            </div>
          </section>
          {home && (
            <section
              className="daily-learning-band"
              aria-label="Today's daily learning"
            >
              <div className="daily-band-heading">
                <CalendarDays size={20} />
                <div>
                  <h2>Today, in Torah</h2>
                  <span lang="he" dir="rtl">
                    {home.hebrewDate}
                  </span>
                </div>
              </div>
              {[
                ['Daf Yomi', home.daf],
                ['Mishna Yomi', home.mishna],
                ['Nach Yomi', home.nach],
              ]
                .filter(([, value]) => value)
                .map(([label, value]) => (
                  <button key={label} onClick={() => onSearch(value)}>
                    <span>
                      <small>{label}</small>
                      <strong>{value}</strong>
                    </span>
                    <ChevronRight size={17} />
                  </button>
                ))}
            </section>
          )}
        </>
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
            continuing.map((h) => (
              <ShiurRow
                key={h.shiur.id}
                shiur={h.shiur}
                onPlay={(s) => onPlay(s, h.seconds)}
                onDetails={onDetails}
                onSave={onSave}
                onQueue={onQueue}
                saved={library.saved.some((s) => s.id === h.shiur.id)}
                progress={h}
              />
            ))
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
            discovery
              ? `Ranked by total YUTorah views across ${discovery.sampled} recent recordings.${discovery.partial ? ' Some recordings could not load.' : ''}`
              : 'View counts come directly from YUTorah.',
          )}
          <div className="discovery-toolbar">
            <div className="time-chips">
              <Timer size={15} />
              {['all', '10', '20', '30'].map((v) => (
                <button
                  key={v}
                  aria-pressed={minutes === v}
                  onClick={() => setMinutes(v)}
                >
                  {v === 'all' ? 'Any length' : 'Under ' + v + ' min'}
                </button>
              ))}
            </div>
            <button
              className="icon-button"
              aria-label="Refresh trending"
              onClick={refreshAll}
              disabled={discoveryLoading}
            >
              <RefreshCw size={16} className={discoveryLoading ? 'spin' : ''} />
            </button>
          </div>
          <p className="trending-source">
            YUTorah supplies total views for these recordings. Views for the
            past 24 hours, week, month, or year are unavailable from the public
            API, so this chart uses lifetime views.
          </p>
          {discoveryLoading && !discovery ? (
            <div className="discovery-loading">
              <Loader2 size={18} className="spin" />
              Finding trending shiurim…
            </div>
          ) : discoveryError ? (
            <StatePanel
              title="Trending couldn't load."
              description="YUTorah's popularity data is temporarily unavailable."
            >
              <button className="outline-button" onClick={refreshAll}>
                Try again
              </button>
            </StatePanel>
          ) : trending.length ? (
            trendingList(12)
          ) : (
            <StatePanel
              title="No recordings match this length."
              description="Choose a longer time budget to see more trending shiurim."
            />
          )}
        </section>
      ) : (
        <section className="discovery-section recommended-section">
          {sectionHeading(
            currentTab === 'following'
              ? 'From your follows'
              : currentTab === 'latest'
                ? 'Recently added'
                : hasInterests
                  ? 'Recommended for you'
                  : 'Discover something new',
            currentTab === 'following'
              ? 'A selection from your teachers, topics, and series.'
              : currentTab === 'latest'
                ? 'New learning, straight from the YUTorah library.'
                : hasInterests
                  ? 'Inspired by what you listen to, save, and follow.'
                  : 'Featured and recent shiurim from the YUTorah library.',
            isHome ? () => setTab('latest') : undefined,
            'New shiurim',
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
              {cards(items, isHome ? Math.min(limit, 4) : limit)}
              {items.length > (isHome ? Math.min(limit, 4) : limit) && (
                <button
                  className="outline-button discovery-more"
                  onClick={() =>
                    isHome ? setTab('latest') : setLimit((n) => n + 8)
                  }
                >
                  More to discover
                  <ArrowRight size={15} />
                </button>
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
        <>
          {anchor && (
            <section className="discovery-section based-on-section">
              {sectionHeading(
                'Keep the learning going',
                `Because you listened to “${anchor.title}”`,
                () => onDetails(anchor),
                'View shiur',
              )}
              {relatedLoading && !followups.length ? (
                <output className="feed-loading">
                  <Loader2 size={14} className="spin" />
                  Finding related series, topics, and teachers…
                </output>
              ) : followups.length ? (
                cards(followups, 4)
              ) : (
                <p className="discovery-muted">
                  No related shiurim are available in this selection yet.{' '}
                  <button
                    className="text-button"
                    onClick={() =>
                      onSearch('', {
                        ...noFilters,
                        teacher: String(anchor.teacherId),
                      })
                    }
                  >
                    Explore this teacher
                    <ArrowRight size={14} />
                  </button>
                </p>
              )}
              {relatedError && (
                <p className="feed-notice">
                  Some related learning could not load.{' '}
                  <button onClick={refreshAll}>Try again</button>
                </p>
              )}
            </section>
          )}
          <section className="discovery-section trending-section">
            {sectionHeading(
              'Trending in the library',
              'Popular recordings from a sample of recent shiurim.',
              () => onNavigate('trending'),
              'Explore trending',
            )}
            {discoveryLoading && !discovery ? (
              <div className="discovery-loading">
                <Loader2 size={16} className="spin" />
                Loading YUTorah view counts…
              </div>
            ) : discoveryError ? (
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
                Total YUTorah views across {discovery.sampled} recent
                recordings.{' '}
                {discovery.partial && 'Some recordings could not load.'}
              </p>
            )}
          </section>
          {teachers.length > 0 && (
            <section className="discovery-section teacher-shelf-section">
              {sectionHeading(
                'Teachers to know',
                'Meet the teachers of the YUTorah community.',
                () => onNavigate('teachers'),
                'All teachers',
              )}
              <div className="teacher-shelf">
                {teachers.map((t) => (
                  <article key={t.id}>
                    <button
                      className="teacher-shelf-profile"
                      onClick={() =>
                        onSearch('', { ...noFilters, teacher: String(t.id) })
                      }
                    >
                      <Avatar src={t.image} name={t.name} />
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
          {home && home.series.length > 0 && (
            <section className="discovery-section series-shelf-section">
              {sectionHeading(
                'Go deeper with a series',
                'Find a series to make part of your routine.',
                () => onNavigate('series'),
                'All series',
              )}
              <div className="series-shelf">
                {home.series.slice(0, 4).map((s) => (
                  <article key={s.id}>
                    <button
                      onClick={() =>
                        onSearch('', { ...noFilters, series: String(s.id) })
                      }
                    >
                      <SeriesCover name={s.name} id={s.id} />
                      <h3 dir="auto">{s.name}</h3>
                      <p>
                        {(
                          directory?.series.find((series) => series.id === s.id)
                            ?.count ?? s.count
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
            <span className="learning-goal-icon">
              <Target size={27} />
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
