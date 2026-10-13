/* oxlint-disable next/no-img-element -- Subject art is pre-sized, lazy-loaded local WebP. */
'use client';

import { useMemo, useState } from 'react';
import { usePlayerDialog } from '@/hooks/use-player-dialog';
import { ShiurViews } from './shiur-views';
import { TeacherLink } from './teacher-link';
import {
  ArrowRight,
  Bookmark,
  ChevronRight,
  Pause,
  Play,
  RefreshCw,
  Search,
  Settings2,
  type LucideIcon,
} from 'lucide-react';
import {
  Avatar,
  MobileRecordingCard,
  SeriesCover,
  StatePanel,
  tone,
  useSeriesWithArt,
} from './ui';
import { noFilters, type Filters } from '@/lib/search-filters';
import {
  mediaKind,
  type Directory,
  type HomeData,
  type Shiur,
} from '@/lib/yutorah';
import type { LibraryState } from '@/lib/library';
import { learningStats } from '@/lib/learning';

type Subject = {
  key: string;
  label: string;
  title: string;
  hebrew: string;
  note: string;
  icon: LucideIcon;
  go: () => void;
};

type Props = {
  onTrending: () => void;
  subjects: Subject[];
  home: HomeData | null;
  directory: Directory | null;
  library: LibraryState;
  pick?: Shiur;
  items: Shiur[];
  trending: Shiur[];
  trendingLoading: boolean;
  trendingError: boolean;
  continuing: LibraryState['history'];
  activeId?: number;
  playing: boolean;
  refreshing: boolean;
  onPlay: (shiur: Shiur, seconds?: number) => void;
  onDetails: (shiur: Shiur) => void;
  onSave: (shiur: Shiur) => void;
  onSearch: (query: string, filters?: Filters) => void;
  onNavigate: (
    view:
      | 'search'
      | 'topics'
      | 'teachers'
      | 'series'
      | 'history'
      | 'trending'
      | 'saved',
  ) => void;
  onPreferences: () => void;
  onRefresh: () => void;
};

export function MobileDiscover({
  subjects,
  home,
  directory,
  library,
  pick,
  items,
  trending,
  trendingLoading,
  trendingError,
  continuing,
  activeId,
  playing,
  refreshing,
  onTrending,
  onPlay,
  onDetails,
  onSave,
  onSearch,
  onNavigate,
  onPreferences,
  onRefresh,
}: Props) {
  const { setExpanded } = usePlayerDialog();
  const [query, setQuery] = useState('');
  const [feed, setFeed] = useState('recommended');
  const [shown, setShown] = useState(5);
  const stats = learningStats(library.learningDays);
  const shelfSeries = useSeriesWithArt(
    [...(home?.series || []), ...(directory?.series || [])],
    8,
  );
  const entries = useMemo(() => {
    if (feed === 'trending') return trending;
    if (feed === 'recommended') return items;
    return (home?.featured || []).filter(
      (s) => s.id !== pick?.id && !library.hidden.includes(s.id),
    );
  }, [feed, home, items, trending, pick, library.hidden]);
  const browseAll = () =>
    feed === 'trending' ? onNavigate('trending') : onNavigate('search');
  const loading = refreshing || (feed === 'trending' && trendingLoading);
  const open = (s: Shiur) =>
    mediaKind(s) === 'audio' ? onPlay(s) : onDetails(s);
  const sectionTitle = (
    title: string,
    action: () => void,
    label = 'See all',
    extra?: React.ReactNode,
  ) => (
    <div className="m-section-heading">
      <h2>{title}</h2>
      <div className="m-section-actions">
        {extra}
        <button onClick={action}>
          {label}
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
  const recordings = (records: Shiur[]) => (
    <div className="m-recordings">
      {records.map((s) => (
        <MobileRecordingCard
          key={s.id}
          shiur={s}
          onPlay={onPlay}
          onDetails={onDetails}
          onTeacher={(s) =>
            onSearch('', { ...noFilters, teacher: String(s.teacherId) })
          }
          onSave={onSave}
          saved={library.saved.some((v) => v.id === s.id)}
          active={activeId === s.id && playing}
        />
      ))}
    </div>
  );
  const savedPick = !!pick && library.saved.some((s) => s.id === pick.id);
  const goal = Math.min(1, stats.today / 60 / (library.dailyGoal || 1));
  const daily = home
    ? [
        ['This week’s parsha', home.parsha || ''],
        ['Daf Yomi', home.daf],
        ['Mishna Yomi', home.mishna],
        ['Nach Yomi', home.nach],
      ].filter(([, value]) => value)
    : [];

  return (
    <div className="mobile-discover">
      <section className="m-intro" aria-label="The Torah library">
        {home?.hebrewDate && (
          <span className="m-date" lang="he" dir="rtl">
            {home.hebrewDate}
          </span>
        )}
        <h1>The Torah library.</h1>
        <search aria-label="Torah library">
          <form
            className="m-search"
            onSubmit={(e) => {
              e.preventDefault();
              onSearch(query.trim());
            }}
          >
            <Search size={19} aria-hidden="true" />
            <input
              type="search"
              aria-label="Search the Torah library"
              placeholder="Shiurim, teachers, topics…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="submit" aria-label="Submit library search">
              <ArrowRight size={19} />
            </button>
          </form>
        </search>
      </section>

      {pick && (
        <section className="m-hero" aria-label="Featured shiur">
          <div className="m-hero-top">
            <span className="m-hero-eyebrow">
              Featured{pick.category ? ' · ' + pick.category : ''}
            </span>
            <button
              className={'m-hero-portrait ' + tone(pick.teacherId)}
              aria-label={'View ' + pick.teacher + ' shiur details'}
              onClick={() => onDetails(pick)}
            >
              <Avatar src={pick.image} name={pick.teacher} />
            </button>
          </div>
          <h2>
            <button dir="auto" onClick={() => onDetails(pick)}>
              {pick.title}
            </button>
          </h2>
          <p>
            <TeacherLink
              shiur={pick}
              onTeacher={(s) =>
                onSearch('', { ...noFilters, teacher: String(s.teacherId) })
              }
            />
            {pick.duration > 0 && (
              <span> · {Math.round(pick.duration / 60)} min</span>
            )}
            <ShiurViews shiur={pick} />
          </p>
          <div className="m-hero-actions">
            <button
              className="m-hero-play"
              onClick={() => {
                open(pick);
                if (
                  mediaKind(pick) === 'audio' &&
                  !(activeId === pick.id && playing)
                )
                  setExpanded(true);
              }}
              aria-label={
                (activeId === pick.id && playing ? 'Pause ' : 'Play ') +
                pick.title
              }
            >
              {activeId === pick.id && playing ? (
                <Pause size={17} fill="currentColor" />
              ) : (
                <Play size={17} fill="currentColor" />
              )}
              {activeId === pick.id && playing ? 'Pause' : 'Listen now'}
            </button>
            <button
              className="m-hero-save"
              aria-label={(savedPick ? 'Unsave ' : 'Save ') + pick.title}
              aria-pressed={savedPick}
              onClick={() => onSave(pick)}
            >
              <Bookmark size={19} fill={savedPick ? 'currentColor' : 'none'} />
            </button>
          </div>
        </section>
      )}

      {!!continuing.length && (
        <section className="m-section m-resume">
          {sectionTitle(
            'Continue learning',
            () => onNavigate('history'),
            'History',
          )}
          {continuing.slice(0, 2).map((h) => (
            <article key={h.shiur.id}>
              <span className={'m-resume-art ' + tone(h.shiur.teacherId)}>
                <Avatar src={h.shiur.image} name={h.shiur.teacher} />
              </span>
              <div>
                <h3>
                  <button dir="auto" onClick={() => onDetails(h.shiur)}>
                    {h.shiur.title}
                  </button>
                </h3>
                <progress
                  value={h.seconds}
                  max={h.duration || 1}
                  aria-label={'Listening progress for ' + h.shiur.title}
                />
                <small>
                  {h.duration > 0
                    ? Math.max(1, Math.ceil((h.duration - h.seconds) / 60)) +
                      ' min left'
                    : 'Resume listening'}
                </small>
              </div>
              <button
                className="m-resume-play"
                aria-label={'Resume ' + h.shiur.title}
                onClick={() => onPlay(h.shiur, h.seconds)}
              >
                <Play size={17} fill="currentColor" />
              </button>
            </article>
          ))}
        </section>
      )}

      <section className="m-section" aria-label="Shiurim from the library">
        {sectionTitle(
          'Discover',
          browseAll,
          'See all',
          <button
            className="m-icon-action"
            aria-label="Refresh library selections"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
          </button>,
        )}
        <div className="m-feed-tabs" aria-label="Library selections">
          {[
            ['recommended', 'For you'],
            ['trending', 'Trending'],
            ['featured', 'Featured'],
          ].map(([value, label]) => (
            <button
              key={value}
              aria-pressed={feed === value}
              onClick={() => {
                setFeed(value);
                setShown(5);
                if (value === 'trending') onTrending();
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {feed === 'featured' && (
          <p className="m-feed-note">Selected by the YUTorah editors.</p>
        )}
        {entries.length ? (
          <>
            {recordings(entries.slice(0, shown))}
            <button
              className="m-browse-more"
              onClick={() =>
                entries.length > shown ? setShown((n) => n + 5) : browseAll()
              }
            >
              {entries.length > shown
                ? 'Browse more shiurim'
                : feed === 'trending'
                  ? 'See the full chart'
                  : 'Search the full library'}
              <ArrowRight size={16} />
            </button>
          </>
        ) : (
          <StatePanel
            title={
              feed === 'trending'
                ? trendingError
                  ? 'Saved rankings are unavailable'
                  : 'No saved trending chart yet'
                : loading
                  ? 'Loading shiurim…'
                  : 'Explore the library'
            }
            description={
              feed === 'trending'
                ? 'Rankings appear here as charts update in the background.'
                : 'Reload the selections or search the full library.'
            }
          >
            <button
              className="outline-button"
              disabled={loading}
              onClick={onRefresh}
            >
              {feed === 'trending'
                ? 'Refresh chart'
                : loading
                  ? 'Loading…'
                  : 'Reload selections'}
            </button>
          </StatePanel>
        )}
      </section>

      {daily.length > 0 && (
        <section className="m-section m-today" aria-label="Today in Torah">
          <div className="m-section-heading">
            <h2>Today in Torah</h2>
          </div>
          <div className="m-today-grid">
            {daily.map(([label, value]) => (
              <button key={label} onClick={() => onSearch(value)}>
                <small>{label}</small>
                <strong dir="auto">{value}</strong>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="m-section">
        {sectionTitle(
          'Explore by subject',
          () => onNavigate('topics'),
          'All topics',
        )}
        <div className="m-subjects">
          {subjects.map(
            ({ key, label, title, hebrew, note, icon: Icon, go }) => (
              <button key={key} onClick={go}>
                <span className="m-subject-top">
                  <span className="m-subject-icon">
                    <Icon size={15} aria-hidden="true" />
                  </span>
                  <span>{label}</span>
                </span>
                <span
                  className="m-subject-hebrew"
                  data-he={hebrew}
                  aria-hidden="true"
                />
                <strong>{title}</strong>
                <small>{note}</small>
              </button>
            ),
          )}
        </div>
      </section>

      {!!directory?.teachers.length && (
        <section className="m-section">
          {sectionTitle('Teachers', () => onNavigate('teachers'))}
          <div className="m-teachers">
            {directory.teachers.slice(0, 10).map((t) => (
              <button
                key={t.id}
                onClick={() =>
                  onSearch('', { ...noFilters, teacher: String(t.id) })
                }
              >
                <span className={'m-teacher-portrait ' + tone(t.id)}>
                  <Avatar src={t.image} name={t.name} />
                </span>
                <strong>{t.name.replace(/^Rabbi\s+/, 'R. ')}</strong>
                <small>{t.count.toLocaleString()}</small>
              </button>
            ))}
          </div>
        </section>
      )}

      {!!shelfSeries?.length && (
        <section className="m-section">
          {sectionTitle('Series', () => onNavigate('series'))}
          <div className="m-series">
            {shelfSeries.map((s) => (
              <button
                key={s.id}
                onClick={() =>
                  onSearch('', { ...noFilters, series: String(s.id) })
                }
              >
                <SeriesCover name={s.name} id={s.id} image={s.image} />
                <strong dir="auto">{s.name}</strong>
                <small>
                  {(
                    directory?.series.find((series) => series.id === s.id)
                      ?.count ?? s.count
                  ).toLocaleString()}{' '}
                  shiurim
                </small>
              </button>
            ))}
          </div>
        </section>
      )}

      {!!library.saved.length && (
        <section className="m-section">
          {sectionTitle('Saved for later', () => onNavigate('saved'))}
          {recordings(library.saved.slice(0, 3))}
        </section>
      )}

      <section className="m-goal">
        <span
          className="goal-ring"
          style={{ '--goal': goal } as React.CSSProperties}
          aria-hidden="true"
        >
          <strong>{Math.floor(stats.today / 60)}</strong>
        </span>
        <div>
          <h2>
            {Math.floor(stats.today / 60)} of {library.dailyGoal} minutes today
          </h2>
          <p>
            {stats.streak
              ? `${stats.streak} day streak. Keep it going.`
              : 'A little learning, every day.'}
          </p>
        </div>
        <button onClick={onPreferences} aria-label="Learning preferences">
          <Settings2 size={18} />
        </button>
      </section>
      <p className="m-local-note">
        Your saved shiurim, progress, and follows stay on this device.
      </p>
    </div>
  );
}
