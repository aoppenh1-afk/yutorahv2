'use client';

import { useMemo, useState } from 'react';
import {
  ArrowRight,
  Bookmark,
  BookOpen,
  ChevronRight,
  Headphones,
  Pause,
  Play,
  RefreshCw,
  Search,
  Settings2,
} from 'lucide-react';
import { Avatar, MobileRecordingCard, StatePanel } from './ui';
import { noFilters, type Filters } from './advanced-search';
import {
  mediaKind,
  type Directory,
  type HomeData,
  type Shiur,
} from '@/lib/yutorah';
import type { LibraryState } from '@/lib/library';
import { learningStats } from '@/lib/learning';

type Props = {
  home: HomeData | null;
  directory: Directory | null;
  library: LibraryState;
  pick?: Shiur;
  items: Shiur[];
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
  home,
  directory,
  library,
  pick,
  items,
  continuing,
  activeId,
  playing,
  refreshing,
  onPlay,
  onDetails,
  onSave,
  onSearch,
  onNavigate,
  onPreferences,
  onRefresh,
}: Props) {
  const [query, setQuery] = useState('');
  const [feed, setFeed] = useState('latest');
  const stats = learningStats(library.learningDays);
  const entries = useMemo(() => {
    if (feed === 'short')
      return items.filter((s) => s.duration > 0 && s.duration <= 1200);
    if (feed === 'recommended') return items;
    return home?.recent.length
      ? home.recent
      : [...items].sort(
          (a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0),
        );
  }, [feed, home, items]);
  const open = (s: Shiur) =>
    mediaKind(s) === 'audio' ? onPlay(s) : onDetails(s);
  const sectionTitle = (
    title: string,
    action: () => void,
    label = 'View all',
  ) => (
    <div className="archive-section-heading">
      <h2>{title}</h2>
      <button onClick={action}>
        {label}
        <ChevronRight size={16} />
      </button>
    </div>
  );
  const recordings = (records: Shiur[]) => (
    <div className="archive-recordings">
      {records.map((s) => (
        <MobileRecordingCard
          key={s.id}
          shiur={s}
          onPlay={onPlay}
          onDetails={onDetails}
          onSave={onSave}
          saved={library.saved.some((v) => v.id === s.id)}
          active={activeId === s.id && playing}
        />
      ))}
    </div>
  );
  const savedPick = !!pick && library.saved.some((s) => s.id === pick.id);

  return (
    <div className="mobile-discover archive-home">
      <section className="archive-intro" aria-label="The Torah library">
        <h1>The Torah library.</h1>
        <p className="archive-intro-copy">
          Learn from Yeshiva University’s roshei yeshiva and Torah educators
          around the world.
        </p>
        <search aria-label="Torah library">
          <form
            className="archive-search"
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
              <ArrowRight size={20} />
            </button>
          </form>
        </search>
        <div className="archive-scope">
          <span>
            {home ? (
              <>
                <strong>{home.total.toLocaleString()}</strong> shiurim
              </>
            ) : (
              'Audio, video & articles'
            )}
          </span>
          {directory && (
            <span>
              <strong>{directory.teachers.length.toLocaleString()}</strong>{' '}
              teachers
            </span>
          )}
          <span>Free access</span>
        </div>
      </section>

      {pick && (
        <section className="archive-feature" aria-label="Featured shiur">
          <div className="archive-feature-eyebrow">
            <span>FEATURED SHIUR</span>
            <span>{pick.category || 'FROM THE LIBRARY'}</span>
          </div>
          <div className="archive-feature-main">
            <div>
              <h2>
                <button dir="auto" onClick={() => onDetails(pick)}>
                  {pick.title}
                </button>
              </h2>
              <p>{pick.teacher}</p>
            </div>
            <button
              className="archive-feature-portrait"
              aria-label={'View ' + pick.teacher + ' shiur details'}
              onClick={() => onDetails(pick)}
            >
              <Avatar src={pick.image} name={pick.teacher} />
            </button>
          </div>
          <div className="archive-feature-actions">
            <button
              className="archive-feature-play"
              onClick={() => open(pick)}
              aria-label={
                (activeId === pick.id && playing ? 'Pause ' : 'Play ') +
                pick.title
              }
            >
              {activeId === pick.id && playing ? (
                <Pause size={15} fill="currentColor" />
              ) : (
                <Play size={15} fill="currentColor" />
              )}
              {activeId === pick.id && playing ? 'Pause' : 'Listen'}
              {pick.duration > 0 && (
                <span>{Math.round(pick.duration / 60)} min</span>
              )}
            </button>
            <button
              className="archive-feature-save"
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
        <section className="archive-section archive-resume">
          {sectionTitle(
            'Continue learning',
            () => onNavigate('history'),
            'History',
          )}
          {continuing.slice(0, 2).map((h) => (
            <article key={h.shiur.id}>
              <Avatar src={h.shiur.image} name={h.shiur.teacher} />
              <div>
                <h3>
                  <button dir="auto" onClick={() => onDetails(h.shiur)}>
                    {h.shiur.title}
                  </button>
                </h3>
                <p>{h.shiur.teacher}</p>
                <progress
                  value={h.seconds}
                  max={h.duration || 1}
                  aria-label={'Listening progress for ' + h.shiur.title}
                />
                <small>
                  {h.duration > 0
                    ? Math.max(1, Math.ceil((h.duration - h.seconds) / 60)) +
                      ' min remaining'
                    : 'Resume listening'}
                </small>
              </div>
              <button
                className="archive-resume-play"
                aria-label={'Resume ' + h.shiur.title}
                onClick={() => onPlay(h.shiur, h.seconds)}
              >
                <Play size={18} fill="currentColor" />
              </button>
            </article>
          ))}
        </section>
      )}

      <section
        className="archive-section archive-latest"
        aria-label="Shiurim from the library"
      >
        {sectionTitle('From the library', () =>
          feed === 'short'
            ? onSearch('', { ...noFilters, max: '20' })
            : feed === 'recommended'
              ? onNavigate('trending')
              : onSearch('', { ...noFilters, sort: 'new' }),
        )}
        <div className="archive-feed-tabs" aria-label="Library selections">
          {[
            ['latest', 'Recently added'],
            ['recommended', 'Recommended'],
            ['short', 'Under 20 min'],
          ].map(([value, label]) => (
            <button
              key={value}
              aria-pressed={feed === value}
              onClick={() => setFeed(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {entries.length ? (
          recordings(entries.slice(0, 4))
        ) : (
          <StatePanel
            title={
              refreshing
                ? 'Loading shiurim…'
                : feed === 'short'
                  ? 'Explore short shiurim'
                  : 'Explore the library'
            }
            description={
              feed === 'short'
                ? 'Search the full library for shiurim under 20 minutes.'
                : 'Reload the selections or search the full library.'
            }
          >
            <button
              className="outline-button"
              disabled={refreshing}
              onClick={() =>
                feed === 'short'
                  ? onSearch('', { ...noFilters, max: '20' })
                  : onRefresh()
              }
            >
              {feed === 'short'
                ? 'Find short shiurim'
                : refreshing
                  ? 'Loading…'
                  : 'Reload selections'}
            </button>
          </StatePanel>
        )}
      </section>

      {home?.daf && (
        <button className="archive-today" onClick={() => onSearch(home.daf)}>
          <BookOpen size={19} aria-hidden="true" />
          <span>
            Today’s daf <strong dir="auto">{home.daf}</strong>
          </span>
          <ChevronRight size={17} />
        </button>
      )}

      <section className="archive-section">
        {sectionTitle('Browse by subject', () => onNavigate('topics'))}
        <div className="archive-subjects">
          {[
            ['Halacha', 'Jewish law'],
            ['Gemara', 'Talmud study'],
            ['Parsha', 'Weekly Torah portion'],
            ['Machshava', 'Jewish thought'],
          ].map(([name, description]) => {
            const topic = directory?.topics.find(
              (t) => t.name.toLowerCase() === name.toLowerCase(),
            );
            return (
              <button
                key={name}
                onClick={() =>
                  topic
                    ? onSearch('', { ...noFilters, topic: String(topic.id) })
                    : onSearch(name)
                }
              >
                <span>
                  <strong>{name}</strong>
                  <small>{description}</small>
                  {topic && <span>{topic.count.toLocaleString()} shiurim</span>}
                </span>
                <ArrowRight size={16} />
              </button>
            );
          })}
        </div>
      </section>

      {!!directory?.teachers.length && (
        <section className="archive-section">
          {sectionTitle('Learn from our teachers', () =>
            onNavigate('teachers'),
          )}
          <div className="archive-teachers">
            {directory.teachers.slice(0, 4).map((t) => (
              <button
                key={t.id}
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
            ))}
          </div>
        </section>
      )}

      {!!home?.series.length && (
        <section className="archive-section archive-series">
          {sectionTitle('Featured series', () => onNavigate('series'))}
          {home.series.slice(0, 3).map((s) => (
            <button
              key={s.id}
              onClick={() =>
                onSearch('', { ...noFilters, series: String(s.id) })
              }
            >
              <span className="archive-series-icon">
                <BookOpen size={22} />
              </span>
              <span>
                <strong>{s.name}</strong>
                <small>
                  {(
                    directory?.series.find((series) => series.id === s.id)
                      ?.count ?? s.count
                  ).toLocaleString()}{' '}
                  shiurim
                </small>
              </span>
              <ChevronRight size={17} />
            </button>
          ))}
        </section>
      )}

      {home && (
        <section className="archive-section archive-daily">
          <div className="archive-section-heading">
            <h2>Daily learning</h2>
            <span lang="he" dir="rtl">
              {home.hebrewDate}
            </span>
          </div>
          {[
            ['Daf Yomi', home.daf],
            ['Mishna Yomi', home.mishna],
            ['Nach Yomi', home.nach],
          ]
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <button key={label} onClick={() => onSearch(value)}>
                <span>{label}</span>
                <strong dir="auto">{value}</strong>
                <ChevronRight size={16} />
              </button>
            ))}
        </section>
      )}

      {!!library.saved.length && (
        <section className="archive-section">
          {sectionTitle('Saved shiurim', () => onNavigate('saved'))}
          {recordings(library.saved.slice(0, 3))}
        </section>
      )}

      <div className="archive-personal">
        <div>
          <Headphones size={18} />
          <span>
            {Math.floor(stats.today / 60)} of {library.dailyGoal} minutes
            learned today
          </span>
        </div>
        <button onClick={onPreferences}>
          <Settings2 size={17} /> Learning preferences
        </button>
      </div>
      <button
        className="archive-refresh"
        onClick={onRefresh}
        disabled={refreshing}
      >
        <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
        {refreshing ? 'Refreshing…' : 'Refresh library selections'}
      </button>
      <div className="archive-colophon">
        <strong>
          The Marcos and Adina Katz
          <br />
          YUTorah Online
        </strong>
        <span>A project of Yeshiva University–RIETS</span>
      </div>
    </div>
  );
}
