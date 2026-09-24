'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Bookmark,
  BookOpen,
  CalendarDays,
  Check,
  ChevronRight,
  Compass,
  Headphones,
  History,
  ListPlus,
  Loader2,
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Avatar, SeriesCover, StatePanel } from './ui';
import { noFilters, type Filters } from './advanced-search';
import type { Directory, HomeData, Shiur } from '@/lib/yutorah';
import { mediaKind } from '@/lib/yutorah';
import type { LibraryState } from '@/lib/library';
import {
  isLearned,
  learningStats,
  recommend,
  mergeShiurim,
  relatedShiurim,
  type Follow,
  type Recommendation,
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
      | 'following',
  ) => void;
  notify: (message: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  followingPage?: boolean;
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
  } = props;
  const [tab, setTab] = useState('for-you');
  const [minutes, setMinutes] = useState('all');
  const [limit, setLimit] = useState(8);
  const [preferences, setPreferences] = useState(false);
  const [feedItems, setFeedItems] = useState<Shiur[]>([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedError, setFeedError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const currentTab = followingPage ? 'following' : tab;
  const sources = useMemo(() => {
    const follows = [...library.following];
    for (const h of library.history.slice(0, 4)) {
      if (
        !follows.some((f) => f.kind === 'teacher' && f.id === h.shiur.teacherId)
      )
        follows.push({
          kind: 'teacher',
          id: h.shiur.teacherId,
          name: h.shiur.teacher,
        });
    }
    return follows;
  }, [library.following, library.history]);
  const sourceQuery = JSON.stringify(
    sources.map(({ kind, id }) => ({ kind, id })),
  );
  useEffect(() => {
    const selected = JSON.parse(sourceQuery) as Pick<Follow, 'kind' | 'id'>[];
    if (!selected.length) {
      setFeedItems([]);
      setFeedError(false);
      setFeedLoading(false);
      return;
    }
    const abort = new AbortController();
    setFeedLoading(true);
    setFeedError(false);
    setFeedItems([]);
    const load = async () => {
      let collected: Shiur[] = [];
      for (let start = 0; start < selected.length; start += 8) {
        const group = selected.slice(start, start + 8);
        const query = new URLSearchParams();
        for (const kind of ['teacher', 'topic', 'series'])
          query.set(
            kind,
            group
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
  const allItems = useMemo(
    () =>
      mergeShiurim([
        ...feedItems,
        ...(home?.featured || []),
        ...(home?.recent || []),
        ...(home?.daily || []),
      ]),
    [home, feedItems],
  );
  const ranked = useMemo(
    () =>
      recommend(allItems, library, {
        followingOnly: currentTab === 'following',
        minutes: minutes === 'all' ? undefined : Number(minutes),
      }),
    [allItems, library, currentTab, minutes],
  );
  const items =
    currentTab === 'latest'
      ? [...ranked].sort(
          (a, b) =>
            (Date.parse(b.shiur.date) || 0) - (Date.parse(a.shiur.date) || 0),
        )
      : ranked;
  const continuing = library.history.filter(
    (h) => h.seconds > 5 && !isLearned(h.shiur, library),
  );
  const stats = learningStats(library.learningDays);
  const anchor = library.history[0]?.shiur || library.saved[0];
  const followups = anchor ? relatedShiurim(anchor, allItems, library) : [];
  const teachers = (directory?.teachers || [])
    .filter(
      (t) =>
        !library.following.some((f) => f.kind === 'teacher' && f.id === t.id),
    )
    .slice(0, 4);
  const suggestedTopics = [
    ...new Map(
      [...(directory?.topics || [])]
        .sort((a, b) => a.count - b.count)
        .filter((t) =>
          /^(Halacha|Parsha|Tefillah|Shabbat|Machshava|Emunah|Teshuva|Gemara|Jewish Thought)$/i.test(
            t.name,
          ),
        )
        .map((t) => [t.name, t]),
    ).values(),
  ].slice(0, 10);
  const pick =
    currentTab === 'for-you' && minutes === 'all' ? items[0] : undefined;
  const visibleItems = pick ? items.slice(1) : items;
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
  const hide = (s: Shiur) => {
    update((old) => ({ ...old, hidden: [...new Set([...old.hidden, s.id])] }));
    notify('Hidden from your feed. You can restore suggestions in Customize.');
  };
  const card = ({ shiur: s, reason }: Recommendation) => (
    <article className="feed-card" key={s.id}>
      <div className="feed-card-top">
        <span>
          <Sparkles size={13} />
          {reason}
        </span>
        <button
          className="icon-button"
          aria-label={'Hide suggestion: ' + s.title}
          onClick={() => hide(s)}
        >
          <X size={15} />
        </button>
      </div>
      <div className="feed-author">
        <button
          onClick={() =>
            onSearch('', { ...noFilters, teacher: String(s.teacherId) })
          }
        >
          <Avatar src={s.image} name={s.teacher} />
          <span>{s.teacher}</span>
        </button>
        <FollowButton
          compact
          follow={{
            kind: 'teacher',
            id: s.teacherId,
            name: s.teacher,
            image: s.image,
          }}
          library={library}
          onFollow={onFollow}
        />
      </div>
      <h3 dir="auto">
        <button onClick={() => onDetails(s)}>{s.title}</button>
      </h3>
      <div className="feed-card-meta">
        <span>{s.topics[0] || s.category || 'Torah learning'}</span>
        <span>
          {s.duration
            ? Math.max(1, Math.round(s.duration / 60)) + ' min'
            : mediaKind(s) === 'text'
              ? 'Article'
              : 'Recording'}
        </span>
      </div>
      <div className="feed-card-actions">
        <button className="feed-play" onClick={() => onPlay(s)}>
          <Play size={14} fill="currentColor" />
          {mediaKind(s) === 'audio' ? 'Listen' : 'Open'}
        </button>
        <div>
          <button
            className="icon-button"
            aria-label={'Mark as learned: ' + s.title}
            onClick={() => markComplete(s)}
          >
            <Check size={17} />
          </button>
          {mediaKind(s) === 'audio' && (
            <button
              className="icon-button"
              aria-label={'Add to queue: ' + s.title}
              onClick={() => onQueue(s)}
            >
              <ListPlus size={18} />
            </button>
          )}
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
        </div>
      </div>
    </article>
  );

  return (
    <div className="learning-home">
      <div className="home-heading">
        <div>
          <div className="eyebrow">YOUR DAILY DOSE OF TORAH</div>
          <h1>
            {followingPage
              ? 'Your circle of learning.'
              : 'Make time for what matters.'}
          </h1>
          <p>
            {followingPage
              ? 'Teachers, topics, and series you come back to.'
              : library.history.length
                ? 'Pick up where you left off. Find where to go next.'
                : 'A good shiur can change your day. Find yours.'}
          </p>
        </div>
        <button
          className="outline-button customize-button"
          onClick={() => setPreferences(true)}
        >
          <Settings2 size={16} />
          Customize
        </button>
      </div>
      <Tabs
        value={currentTab}
        onValueChange={(value) => {
          if (value === 'following') {
            setTab('following');
          } else setTab(String(value));
          setLimit(8);
        }}
      >
        {!followingPage && (
          <TabsList variant="line" className="feed-tabs">
            <TabsTrigger value="for-you">
              <Sparkles size={16} />
              For you
            </TabsTrigger>
            <TabsTrigger value="following">
              <Users size={16} />
              Following{' '}
              {library.following.length > 0 && (
                <span className="tab-count">{library.following.length}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="continue">
              <History size={16} />
              Continue learning
            </TabsTrigger>
            <TabsTrigger value="latest">
              <Compass size={16} />
              Fresh discoveries
            </TabsTrigger>
          </TabsList>
        )}
      </Tabs>
      <div className="home-columns">
        <div className="home-main">
          {currentTab === 'following' && library.following.length > 0 && (
            <div className="following-chips">
              {library.following.map((f) => (
                <div key={f.kind + f.id}>
                  <button
                    onClick={() =>
                      onSearch('', { ...noFilters, [f.kind]: String(f.id) })
                    }
                  >
                    {f.kind === 'teacher' ? (
                      <Users size={13} />
                    ) : (
                      <BookOpen size={13} />
                    )}
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
          {continuing.length > 0 && currentTab === 'for-you' && (
            <section className="resume-strip">
              <div className="section-heading">
                <h2>Right where you left off</h2>
                <button
                  className="text-button"
                  onClick={() => {
                    setTab('continue');
                    setLimit(8);
                  }}
                >
                  View all <ArrowRight size={14} />
                </button>
              </div>
              {continuing.slice(0, 2).map((h) => (
                <button
                  className="resume-item"
                  key={h.shiur.id}
                  onClick={() => onPlay(h.shiur, h.seconds)}
                >
                  <Avatar src={h.shiur.image} name={h.shiur.teacher} />
                  <div>
                    <strong dir="auto">{h.shiur.title}</strong>
                    <span>
                      {h.shiur.teacher} ·{' '}
                      {Math.max(1, Math.ceil((h.duration - h.seconds) / 60))}{' '}
                      min left
                    </span>
                    <progress
                      aria-label={'Listening progress for ' + h.shiur.title}
                      value={h.seconds}
                      max={h.duration || 1}
                    />
                  </div>
                  <span className="resume-play">
                    <Play size={16} fill="currentColor" />
                  </span>
                </button>
              ))}
            </section>
          )}
          {pick && (
            <article className="spotlight">
              <div className="spotlight-copy">
                <span className="spotlight-label">
                  <Headphones size={14} /> A GOOD PLACE TO START
                </span>
                <h2 dir="auto">
                  <button onClick={() => onDetails(pick.shiur)}>
                    {pick.shiur.title}
                  </button>
                </h2>
                <div className="spotlight-author">
                  <Avatar src={pick.shiur.image} name={pick.shiur.teacher} />
                  <span>
                    {pick.shiur.teacher}
                    <small>
                      {pick.shiur.duration
                        ? Math.round(pick.shiur.duration / 60) + ' min · '
                        : ''}
                      {pick.shiur.topics[0] || pick.shiur.category || 'YUTorah'}
                    </small>
                  </span>
                </div>
                <div className="spotlight-actions">
                  <button
                    className="light-button"
                    onClick={() => onPlay(pick.shiur)}
                  >
                    <Play size={15} fill="currentColor" />
                    {mediaKind(pick.shiur) === 'audio'
                      ? 'Start listening'
                      : 'Open shiur'}
                  </button>
                  <button
                    className="spotlight-save"
                    aria-label={'Save ' + pick.shiur.title}
                    aria-pressed={library.saved.some(
                      (s) => s.id === pick.shiur.id,
                    )}
                    onClick={() => onSave(pick.shiur)}
                  >
                    <Bookmark
                      size={17}
                      fill={
                        library.saved.some((s) => s.id === pick.shiur.id)
                          ? 'currentColor'
                          : 'none'
                      }
                    />
                  </button>
                  <span>{pick.reason}</span>
                </div>
              </div>
              <div className="spotlight-index" aria-hidden="true">
                <BookOpen size={50} strokeWidth={1} />
                <span>
                  THE YUTORAH
                  <br />
                  LIBRARY
                </span>
              </div>
            </article>
          )}
          {currentTab === 'continue' ? (
            <section>
              <div className="section-heading">
                <div>
                  <h2>Continue learning</h2>
                  <p>Your unfinished shiurim, ready when you are.</p>
                </div>
              </div>
              {continuing.length ? (
                continuing.map((h) => (
                  <article className="continue-learning-card" key={h.shiur.id}>
                    <Avatar src={h.shiur.image} name={h.shiur.teacher} />
                    <div>
                      <h3>
                        <button onClick={() => onDetails(h.shiur)}>
                          {h.shiur.title}
                        </button>
                      </h3>
                      <p>
                        {h.shiur.teacher} ·{' '}
                        {Math.max(1, Math.ceil((h.duration - h.seconds) / 60))}{' '}
                        min left
                      </p>
                      <progress
                        aria-label="Listening progress"
                        value={h.seconds}
                        max={h.duration || 1}
                      />
                      <div className="button-row">
                        <button
                          className="feed-play"
                          onClick={() => onPlay(h.shiur, h.seconds)}
                        >
                          <Play size={14} fill="currentColor" />
                          Resume
                        </button>
                        <button
                          className="text-button"
                          onClick={() => markComplete(h.shiur)}
                        >
                          <Check size={14} />
                          Mark as learned
                        </button>
                      </div>
                    </div>
                  </article>
                ))
              ) : (
                <StatePanel
                  title="Your next chapter starts here"
                  description="Start a recording and we'll remember your place. Unfinished shiurim will appear here."
                >
                  <button
                    className="primary-button"
                    onClick={() => setTab('for-you')}
                  >
                    Find a shiur <ArrowRight size={16} />
                  </button>
                </StatePanel>
              )}
            </section>
          ) : (
            <section className="recommended-section">
              <div className="section-heading">
                <div>
                  <h2>
                    {currentTab === 'following'
                      ? 'From your follows'
                      : currentTab === 'latest'
                        ? 'Fresh discoveries'
                        : 'Picked for your learning'}
                  </h2>
                  <p>
                    {currentTab === 'following'
                      ? 'A selection from the teachers and subjects you follow.'
                      : currentTab === 'latest'
                        ? 'Recent recordings from your discovery feed.'
                        : library.following.length || library.history.length
                          ? 'Shaped by your follows, saves, and listening.'
                          : 'Explore a few picks. Your feed gets personal as you learn.'}
                  </p>
                </div>
              </div>
              <div className="feed-toolbar">
                <div className="time-chips" aria-label="Time available">
                  <Timer size={15} />
                  {[
                    ['all', 'Any length'],
                    ['10', '10 min'],
                    ['20', '20 min'],
                    ['30', '30 min'],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      aria-pressed={minutes === value}
                      onClick={() => {
                        setMinutes(value);
                        setLimit(8);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button
                  className="icon-button"
                  aria-label="Refresh recommendations"
                  onClick={() => {
                    setRefresh((n) => n + 1);
                    onRefresh();
                  }}
                  disabled={feedLoading || refreshing}
                >
                  <RefreshCw
                    size={16}
                    className={feedLoading || refreshing ? 'spin' : ''}
                  />
                </button>
              </div>
              {feedLoading && (
                <output className="feed-loading">
                  <Loader2 className="spin" size={14} />
                  Finding shiurim from your follows…
                </output>
              )}
              {feedError && (
                <div className="feed-notice">
                  Some followed sources could not load.{' '}
                  <button onClick={() => setRefresh((n) => n + 1)}>
                    Try again
                  </button>
                </div>
              )}
              {currentTab === 'following' && !library.following.length ? (
                <div className="follow-empty">
                  <span className="empty-circle">
                    <Users size={28} />
                  </span>
                  <h3>A feed that feels like you.</h3>
                  <p>
                    Follow teachers, topics, or a series. Their shiurim will
                    have a place here.
                  </p>
                  <button
                    className="primary-button"
                    onClick={() => setPreferences(true)}
                  >
                    <Plus size={16} />
                    Find your interests
                  </button>
                  <button
                    className="text-button"
                    onClick={() => onNavigate('teachers')}
                  >
                    Browse all teachers <ArrowRight size={15} />
                  </button>
                </div>
              ) : visibleItems.length ? (
                <>
                  <div className="feed-grid">
                    {visibleItems.slice(0, limit).map(card)}
                  </div>
                  {visibleItems.length > limit && (
                    <button
                      className="outline-button feed-more"
                      onClick={() => setLimit((n) => n + 8)}
                    >
                      More to discover <Plus size={16} />
                    </button>
                  )}
                </>
              ) : (
                !feedLoading && (
                  <StatePanel
                    title={
                      home
                        ? 'Try a little more room to explore'
                        : 'The library is taking a moment'
                    }
                    description={
                      home
                        ? 'Choose a longer duration, follow another topic, or restore hidden suggestions in Customize.'
                        : 'We could not load the live library. Your saved learning is still available.'
                    }
                  >
                    <button
                      className="outline-button"
                      onClick={() => {
                        setMinutes('all');
                        onRefresh();
                      }}
                    >
                      Refresh feed
                    </button>
                  </StatePanel>
                )
              )}
            </section>
          )}
          {followups.length > 0 && currentTab === 'for-you' && (
            <section className="followup-section">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">KEEP THE THREAD GOING</span>
                  <h2>A little further into it</h2>
                  <p>Related to “{anchor.title}”</p>
                </div>
              </div>
              {followups.slice(0, 3).map(({ shiur: s }) => (
                <div className="followup-row" key={s.id}>
                  <span className="followup-icon">
                    <BookOpen size={20} />
                  </span>
                  <button onClick={() => onDetails(s)}>
                    <strong dir="auto">{s.title}</strong>
                    <span>
                      {s.teacher} ·{' '}
                      {s.series || s.topics[0] || 'Related learning'}
                    </span>
                  </button>
                  <button
                    className="icon-button"
                    aria-label={'Play follow-up: ' + s.title}
                    onClick={() => onPlay(s)}
                  >
                    <Play size={17} />
                  </button>
                </div>
              ))}
              {anchor.seriesId > 0 && (
                <button
                  className="text-button"
                  onClick={() =>
                    onSearch('', {
                      ...noFilters,
                      series: String(anchor.seriesId),
                      sort: 'old',
                    })
                  }
                >
                  Explore the full series <ArrowRight size={15} />
                </button>
              )}
            </section>
          )}
          {home && currentTab === 'for-you' && (
            <section className="home-series">
              <div className="section-heading">
                <div>
                  <h2>Find something to come back to</h2>
                  <p>Make a series part of your routine.</p>
                </div>
                <button
                  className="text-button"
                  onClick={() => onNavigate('series')}
                >
                  All series <ArrowRight size={15} />
                </button>
              </div>
              <div className="home-series-grid">
                {home.series.slice(0, 3).map((s) => (
                  <article key={s.id}>
                    <button
                      onClick={() =>
                        onSearch('', { ...noFilters, series: String(s.id) })
                      }
                    >
                      <SeriesCover name={s.name} id={s.id} />
                      <h3>{s.name}</h3>
                      <p>{s.count.toLocaleString()} shiurim</p>
                    </button>
                    <FollowButton
                      follow={{ kind: 'series', id: s.id, name: s.name }}
                      library={library}
                      onFollow={onFollow}
                    />
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>
        <aside className="learning-rail">
          <section className="goal-card">
            <div className="rail-heading">
              <span>
                <Target size={17} />A little, every day
              </span>
              <button
                className="icon-button"
                aria-label="Edit daily learning goal"
                onClick={() => setPreferences(true)}
              >
                <Settings2 size={15} />
              </button>
            </div>
            <div className="goal-display">
              <span className="goal-number">
                {Math.floor(stats.today / 60)}
                <small> / {library.dailyGoal} min</small>
              </span>
              <span className="goal-caption">today</span>
            </div>
            <progress
              aria-label="Daily learning goal"
              value={Math.min(stats.today / 60, library.dailyGoal)}
              max={library.dailyGoal}
            />
            <div className="week-chart">
              {stats.week.map((day) => (
                <div
                  key={day.key}
                  title={`${day.label}: ${Math.floor(day.seconds / 60)} minutes`}
                >
                  <span
                    style={{
                      height: `${Math.max(5, Math.min(100, (day.seconds / 60 / library.dailyGoal) * 100))}%`,
                    }}
                    className={
                      day.seconds >= library.dailyGoal * 60 ? 'goal-met' : ''
                    }
                  />
                  <small>{day.label.charAt(0)}</small>
                </div>
              ))}
            </div>
            <div className="goal-foot">
              <span>
                {stats.streak
                  ? `${stats.streak} day streak`
                  : 'One shiur is a good start'}
              </span>
              <span>{Math.floor(stats.weekSeconds / 60)} min this week</span>
            </div>
          </section>
          {home && (
            <section className="rail-section daily-rail">
              <div className="rail-heading">
                <span>
                  <CalendarDays size={17} />
                  Today&apos;s learning
                </span>
              </div>
              <p className="rail-hebrew" lang="he">
                {home.hebrewDate}
              </p>
              {[
                ['Daf Yomi', home.daf],
                ['Mishna Yomi', home.mishna],
                ['Nach Yomi', home.nach],
              ]
                .filter(([, value]) => value)
                .map(([label, value]) => (
                  <button
                    className="daily-link"
                    key={label}
                    onClick={() => onSearch(value)}
                  >
                    <span>
                      <small>{label}</small>
                      <strong>{value}</strong>
                    </span>
                    <ChevronRight size={16} />
                  </button>
                ))}
            </section>
          )}
          <section className="rail-section">
            <div className="rail-heading">
              <span>Teachers to discover</span>
              <button
                className="text-button"
                onClick={() => onNavigate('teachers')}
              >
                See all
              </button>
            </div>
            {teachers.map((t) => (
              <div className="rail-teacher" key={t.id}>
                <button
                  onClick={() =>
                    onSearch('', { ...noFilters, teacher: String(t.id) })
                  }
                >
                  <Avatar src={t.image} name={t.name} />
                  <span>
                    <strong>{t.name}</strong>
                    <small>{t.count.toLocaleString()} shiurim</small>
                  </span>
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
              </div>
            ))}
            {!teachers.length && (
              <p className="rail-muted">
                Explore the directory to find a teacher to follow.
              </p>
            )}
          </section>
          <section className="rail-section">
            <div className="rail-heading">
              <span>Follow your curiosity</span>
            </div>
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
                    <Check size={13} />
                  ) : (
                    <Plus size={13} />
                  )}
                  {t.name}
                </button>
              ))}
            </div>
            <button
              className="text-button"
              onClick={() => onNavigate('topics')}
            >
              Explore all topics <ArrowRight size={14} />
            </button>
          </section>
          <div className="feed-explainer">
            <Sparkles size={15} />
            <p>
              Your feed learns from what you follow, save, and listen to. Your
              learning stays on this device.
            </p>
          </div>
        </aside>
      </div>
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
