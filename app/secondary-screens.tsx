/* oxlint-disable next/no-img-element -- Verified YUTorah portraits. */
'use client';
import {
  ArrowRight,
  ArrowUpRight,
  ArrowLeft,
  Plus,
  Search,
  HardDrive,
  Play,
  X,
  Loader2,
  ListMusic,
} from 'lucide-react';
import {
  Avatar,
  SeriesCover,
  StatePanel,
  ShiurRow,
  tone,
} from './ui';
import { FollowButton } from './follow-button';
import { PagedItems } from './paged-items';
import { noFilters, type Filters } from '@/lib/search-filters';
import {
  mediaKind,
  type Directory,
  type Shiur,
  type SearchResult,
} from '@/lib/yutorah';
import type { LibraryState, LibraryUpdate, Playlist } from '@/lib/library';
import type { Follow } from '@/lib/learning';
import type { usePlaybackState } from './playback';
type View =
  | 'discover'
  | 'following'
  | 'trending'
  | 'search'
  | 'teachers'
  | 'series'
  | 'topics'
  | 'saved'
  | 'history'
  | 'playlists';
type Setter<T> = React.Dispatch<React.SetStateAction<T>>;
function TopicCard({
  topic,
  tone,
  max,
  heading: Heading,
  runSearch,
  library,
  follow,
}: {
  topic: Directory['topics'][number];
  tone: number;
  max: number;
  heading: 'h2' | 'h3';
  runSearch: SecondaryScreenProps['runSearch'];
  library: LibraryState;
  follow: (follow: Follow) => void;
}) {
  return (
    <article className="topic-follow-wrap">
      <button
        className={'topic-card group-' + tone}
        style={
          {
            '--share': Math.max(0.06, topic.count / (max || 1)),
          } as React.CSSProperties
        }
        onClick={() =>
          void runSearch('', { ...noFilters, topic: String(topic.id) })
        }
      >
        <span>{topic.group}</span>
        <Heading>{topic.name}</Heading>
        <p>
          {topic.count.toLocaleString()} shiurim <ArrowUpRight size={17} />
        </p>
        <i className="topic-meter" aria-hidden="true" />
      </button>
      <FollowButton
        follow={{ kind: 'topic', id: topic.id, name: topic.name }}
        library={library}
        onFollow={follow}
      />
    </article>
  );
}
export type SecondaryScreenProps = {
  view: View;
  directory: Directory | null;
  directoryQuery: string;
  setDirectoryQuery: Setter<string>;
  topicGroup: string;
  setTopicGroup: Setter<string>;
  directoryError: string;
  loadDirectory: () => void;
  listedTeachers: Directory['teachers'];
  listedSeries: Directory['series'];
  listedTopics: Directory['topics'];
  directoryLimit: number;
  setDirectoryLimit: Setter<number>;
  runSearch: (
    query: string,
    filters?: Filters,
    page?: number,
    push?: boolean,
  ) => Promise<SearchResult | undefined>;
  library: LibraryState;
  follow: (follow: Follow) => void;
  ready: boolean;
  playlist: Playlist | undefined;
  libraryQuery: string;
  setLibraryQuery: Setter<string>;
  rows: (items: Shiur[], history?: boolean) => React.ReactNode;
  matchLibrary: (shiur: Shiur) => boolean;
  player: ReturnType<typeof usePlaybackState>;
  update: LibraryUpdate;
  notify: (text: string) => void;
  navigate: (view: View) => void;
  setSelectedPlaylist: Setter<string>;
  setEditingPlaylist: Setter<string>;
  setPlaylistName: Setter<string>;
  setPlaylistTarget: Setter<Shiur | null>;
  setPlaylistDialog: Setter<boolean>;
  setUndoAction: Setter<(() => void) | null>;
  play: (shiur: Shiur) => void;
  showDetail: (shiur: Shiur) => Promise<void>;
  save: (shiur: Shiur) => void;
  enqueue: (shiur: Shiur) => void;
  savedIds: Set<number>;
};
export function SecondaryScreens({
  view,
  directory,
  directoryQuery,
  setDirectoryQuery,
  topicGroup,
  setTopicGroup,
  directoryError,
  loadDirectory,
  listedTeachers,
  listedSeries,
  listedTopics,
  directoryLimit,
  setDirectoryLimit,
  runSearch,
  library,
  follow,
  ready,
  playlist,
  libraryQuery,
  setLibraryQuery,
  rows,
  matchLibrary,
  player,
  update,
  notify,
  navigate,
  setSelectedPlaylist,
  setEditingPlaylist,
  setPlaylistName,
  setPlaylistTarget,
  setPlaylistDialog,
  setUndoAction,
  play,
  showDetail,
  save,
  enqueue,
  savedIds,
}: SecondaryScreenProps) {
  return (
    <>
      {' '}
      {(['teachers', 'series', 'topics'] as View[]).includes(view) && (
        <section className="directory-view">
          <div className="view-heading">
            <div className="eyebrow">Explore the library</div>
            <h1>
              {view === 'teachers'
                ? 'Teachers'
                : view === 'series'
                  ? 'Series'
                  : 'Topics'}
            </h1>
            <p>
              {view === 'teachers'
                ? 'Browse Torah educators and their recorded shiurim.'
                : view === 'series'
                  ? 'Explore ongoing courses and shiur series.'
                  : 'Browse Torah subjects, texts and areas of study.'}
            </p>
          </div>
          <div className="directory-toolbar">
            <div className="directory-search">
              <Search size={19} />
              <input
                aria-label={`Find ${view}`}
                placeholder={`Find ${view === 'teachers' ? 'a teacher' : view === 'series' ? 'a series' : 'a topic'}…`}
                value={directoryQuery}
                onChange={(e) => {
                  setDirectoryQuery(e.target.value);
                  setDirectoryLimit(36);
                }}
              />
            </div>
            <span>
              {view === 'teachers'
                ? listedTeachers.length.toLocaleString()
                : view === 'series'
                  ? listedSeries.length.toLocaleString()
                  : listedTopics.length.toLocaleString()}{' '}
              {view}
            </span>
          </div>
          {directoryError ? (
            <StatePanel
              title="The directory couldn't load."
              description={directoryError}
            >
              <button className="primary-button" onClick={loadDirectory}>
                Try again
              </button>
            </StatePanel>
          ) : !directory ? (
            <output className="loading-panel">
              <Loader2 className="spin" />
              Loading the directory…
            </output>
          ) : (
            <>
              {view === 'teachers' && (
                <div className="teacher-grid">
                  {listedTeachers.slice(0, directoryLimit).map((t) => (
                    <article className="teacher-card-wrap" key={t.id}>
                      <button
                        className="teacher-card"
                        onClick={() =>
                          void runSearch('', {
                            ...noFilters,
                            teacher: String(t.id),
                          })
                        }
                      >
                        <span className={'teacher-portrait ' + tone(t.id)}>
                          <Avatar src={t.image} name={t.name} />
                        </span>
                        <h2>{t.name}</h2>
                        <p>{t.count.toLocaleString()} shiurim</p>
                        <span>
                          Explore shiurim <ArrowRight size={14} />
                        </span>
                      </button>
                      <FollowButton
                        follow={{
                          kind: 'teacher',
                          id: t.id,
                          name: t.name,
                          image: t.image,
                        }}
                        library={library}
                        onFollow={follow}
                      />
                    </article>
                  ))}
                </div>
              )}
              {view === 'series' && (
                <div className="series-directory">
                  {listedSeries.slice(0, directoryLimit).map((s) => (
                    <article className="series-follow-wrap" key={s.id}>
                      <button
                        className="series-directory-card"
                        onClick={() =>
                          void runSearch('', {
                            ...noFilters,
                            series: String(s.id),
                          })
                        }
                      >
                        <SeriesCover name={s.name} id={s.id} image={s.image} />
                        <div>
                          <h2>{s.name}</h2>
                          <p>{s.count.toLocaleString()} shiurim</p>
                          {s.description && (
                            <p className="series-description">
                              {s.description}
                            </p>
                          )}
                        </div>
                        <ArrowUpRight size={19} />
                      </button>
                      <FollowButton
                        follow={{ kind: 'series', id: s.id, name: s.name }}
                        library={library}
                        onFollow={follow}
                      />
                    </article>
                  ))}
                </div>
              )}
              {view === 'topics' && (
                <div className="topic-groups" aria-label="Subjects">
                  {['all', ...directory.groups].map((g) => (
                    <button
                      key={g}
                      aria-pressed={topicGroup === g}
                      className={
                        g === 'all'
                          ? ''
                          : 'group-' + (directory.groups.indexOf(g) % 6)
                      }
                      onClick={() => {
                        setTopicGroup(g);
                        setDirectoryLimit(36);
                      }}
                    >
                      {g === 'all' ? 'All subjects' : g}
                    </button>
                  ))}
                </div>
              )}
              {view === 'topics' &&
                (topicGroup === 'all' && !directoryQuery.trim() ? (
                  directory.groups.map((g) => {
                    const inGroup = listedTopics
                      .filter((t) => t.group === g)
                      .sort((a, b) => b.count - a.count);
                    if (!inGroup.length) return null;
                    return (
                      <section className="topic-section" key={g}>
                        <header>
                          <h2>{g}</h2>
                          <span>
                            {inGroup.length.toLocaleString()}{' '}
                            {inGroup.length === 1 ? 'topic' : 'topics'}
                          </span>
                          {inGroup.length > 8 && (
                            <button
                              className="section-link"
                              onClick={() => {
                                setTopicGroup(g);
                                setDirectoryLimit(36);
                              }}
                            >
                              See all <ArrowRight size={14} />
                            </button>
                          )}
                        </header>
                        <div className="topic-grid">
                          {inGroup.slice(0, 8).map((t) => (
                            <TopicCard
                              key={t.id + '-' + t.group}
                              topic={t}
                              tone={directory.groups.indexOf(t.group) % 6}
                              max={inGroup[0].count}
                              heading="h3"
                              runSearch={runSearch}
                              library={library}
                              follow={follow}
                            />
                          ))}
                        </div>
                      </section>
                    );
                  })
                ) : (
                  <div className="topic-grid">
                    {listedTopics.slice(0, directoryLimit).map((t) => (
                      <TopicCard
                        key={t.id + '-' + t.group}
                        topic={t}
                        tone={directory.groups.indexOf(t.group) % 6}
                        max={Math.max(...listedTopics.map((x) => x.count))}
                        heading="h2"
                        runSearch={runSearch}
                        library={library}
                        follow={follow}
                      />
                    ))}
                  </div>
                ))}
              {!(
                view === 'topics' &&
                topicGroup === 'all' &&
                !directoryQuery.trim()
              ) &&
                (view === 'teachers'
                  ? listedTeachers.length
                  : view === 'series'
                    ? listedSeries.length
                    : listedTopics.length) > directoryLimit && (
                <div className="load-more">
                  <button
                    className="outline-button"
                    onClick={() => setDirectoryLimit((v) => v + 36)}
                  >
                    Show more {view}
                    <ArrowRight size={16} />
                  </button>
                </div>
              )}
              {(view === 'teachers'
                ? listedTeachers.length
                : view === 'series'
                  ? listedSeries.length
                  : listedTopics.length) === 0 && (
                <StatePanel
                  title="Nothing found."
                  description="Try a different spelling or a broader search."
                />
              )}
            </>
          )}
        </section>
      )}
      {(['saved', 'history', 'playlists'] as View[]).includes(view) && (
        <section className="library-view">
          <div className="view-heading">
            <div className="eyebrow">Your learning</div>
            <h1>
              {view === 'saved'
                ? 'Saved shiurim'
                : view === 'history'
                  ? 'Learning history'
                  : playlist
                    ? playlist.name
                    : 'My playlists'}
            </h1>
            <p>
              <HardDrive size={14} /> Saved in this browser, on this device.
            </p>
          </div>
          {!ready ? (
            <output className="loading-panel">
              <Loader2 className="spin" />
              Loading your library…
            </output>
          ) : (
            <>
              {(view === 'saved' || view === 'history') && (
                <div className="library-search-toolbar">
                  <div className="directory-search">
                    <Search size={17} />
                    <input
                      aria-label="Search your learning"
                      placeholder="Find a saved shiur"
                      value={libraryQuery}
                      onChange={(e) => setLibraryQuery(e.target.value)}
                    />
                  </div>
                  <span>
                    {view === 'saved'
                      ? library.saved.length
                      : library.history.length}{' '}
                    {(view === 'saved'
                      ? library.saved.length
                      : library.history.length) === 1
                      ? 'shiur'
                      : 'shiurim'}
                  </span>
                </div>
              )}
              {view === 'saved' &&
                (library.saved.length ? (
                  <>
                    <div className="library-summary">
                      <h2>
                        {library.saved.length} saved{' '}
                        {library.saved.length === 1 ? 'shiur' : 'shiurim'}
                      </h2>
                      <button
                        className="outline-button"
                        onClick={() => {
                          const audio = library.saved.filter(
                            (s) => mediaKind(s) === 'audio',
                          );
                          if (audio.length) {
                            player.start(audio[0]);
                            update((old) => ({
                              ...old,
                              queue: audio.slice(1),
                            }));
                          } else
                            notify(
                              'Your saved items are articles or videos. Open one to read or watch.',
                            );
                        }}
                      >
                        <Play size={15} />
                        Play saved shiurim
                      </button>
                    </div>
                    {rows(library.saved.filter(matchLibrary))}
                  </>
                ) : (
                  <StatePanel
                    title="Your next great shiur belongs here."
                    description="Save a shiur with the bookmark button. It will be waiting here whenever you return."
                  >
                    <button
                      className="primary-button"
                      onClick={() => navigate('discover')}
                    >
                      Find something to learn <ArrowRight size={16} />
                    </button>
                  </StatePanel>
                ))}
              {view === 'history' &&
                (library.history.length ? (
                  rows(
                    library.history.map((h) => h.shiur).filter(matchLibrary),
                    true,
                  )
                ) : (
                  <StatePanel
                    title="Your learning starts with a play."
                    description="Your listening history and progress will appear here as you listen."
                  >
                    <button
                      className="primary-button"
                      onClick={() => navigate('discover')}
                    >
                      Explore shiurim <ArrowRight size={16} />
                    </button>
                  </StatePanel>
                ))}
              {view === 'playlists' && (
                <>
                  {playlist ? (
                    <>
                      <div className="library-summary">
                        <button
                          className="text-button"
                          onClick={() => setSelectedPlaylist('')}
                        >
                          <ArrowLeft size={16} />
                          All playlists
                        </button>
                        <div className="button-row">
                          <button
                            className="text-button"
                            onClick={() => {
                              setEditingPlaylist(playlist.id);
                              setPlaylistName(playlist.name);
                              setPlaylistTarget(null);
                              setPlaylistDialog(true);
                            }}
                          >
                            Rename
                          </button>
                          <button
                            className="text-button"
                            onClick={() => {
                              const removed = playlist;
                              update((old) => ({
                                ...old,
                                playlists: old.playlists.filter(
                                  (p) => p.id !== removed.id,
                                ),
                              }));
                              setSelectedPlaylist('');
                              notify('Playlist removed.');
                              setUndoAction(() => () => {
                                update((old) => ({
                                  ...old,
                                  playlists: [...old.playlists, removed],
                                }));
                                notify('Playlist restored.');
                              });
                            }}
                          >
                            Remove
                          </button>
                          <span>
                            {playlist.items.length}{' '}
                            {playlist.items.length === 1 ? 'shiur' : 'shiurim'}
                          </span>
                          {playlist.items.length > 0 && (
                            <button
                              className="primary-button"
                              onClick={() => {
                                const audio = playlist.items.filter(
                                  (s) => mediaKind(s) === 'audio',
                                );
                                if (audio.length) {
                                  player.start(audio[0]);
                                  update((old) => ({
                                    ...old,
                                    queue: audio.slice(1),
                                  }));
                                } else
                                  notify(
                                    'Open an article or video to read or watch.',
                                  );
                              }}
                            >
                              <Play size={15} />
                              Play playlist
                            </button>
                          )}
                        </div>
                      </div>
                      {playlist.items.length ? (
                        <PagedItems key={playlist.id} items={playlist.items}>
                          {(visible) =>
                            visible.map((s) => (
                              <ShiurRow
                                key={s.id}
                                shiur={s}
                                onPlay={play}
                                onDetails={showDetail}
                                onTeacher={(s) =>
                                  void runSearch('', { ...noFilters, teacher: String(s.teacherId) })
                                }
                                onSave={save}
                                onQueue={enqueue}
                                saved={savedIds.has(s.id)}
                                extra={
                                  <button
                                    className="icon-button"
                                    aria-label={
                                      'Remove from playlist: ' + s.title
                                    }
                                    onClick={() => {
                                      update((old) => ({
                                        ...old,
                                        playlists: old.playlists.map((p) =>
                                          p.id === playlist.id
                                            ? {
                                                ...p,
                                                items: p.items.filter(
                                                  (v) => v.id !== s.id,
                                                ),
                                              }
                                            : p,
                                        ),
                                      }));
                                      notify('Removed from playlist.');
                                    }}
                                  >
                                    <X size={17} />
                                  </button>
                                }
                              />
                            ))
                          }
                        </PagedItems>
                      ) : (
                        <StatePanel
                          title="Give this playlist its first shiur."
                          description="Open a shiur and choose Add to playlist."
                        >
                          <button
                            className="primary-button"
                            onClick={() => navigate('search')}
                          >
                            Find a shiur <Search size={15} />
                          </button>
                        </StatePanel>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="library-summary">
                        <h2>
                          {library.playlists.length}{' '}
                          {library.playlists.length === 1
                            ? 'playlist'
                            : 'playlists'}
                        </h2>
                        <button
                          className="primary-button"
                          onClick={() => {
                            setEditingPlaylist('');
                            setPlaylistTarget(null);
                            setPlaylistName('');
                            setPlaylistDialog(true);
                          }}
                        >
                          <Plus size={16} />
                          Create playlist
                        </button>
                      </div>
                      {library.playlists.length ? (
                        <div className="playlist-grid">
                          {library.playlists.map((p) => (
                            <button
                              className="playlist-card"
                              key={p.id}
                              onClick={() => setSelectedPlaylist(p.id)}
                            >
                              <span className="playlist-icon">
                                <ListMusic size={26} />
                              </span>
                              <h2>{p.name}</h2>
                              <p>
                                {p.items.length}{' '}
                                {p.items.length === 1 ? 'shiur' : 'shiurim'}
                              </p>
                              <ArrowRight size={18} />
                            </button>
                          ))}
                        </div>
                      ) : (
                        <StatePanel
                          title="A playlist for the way you learn."
                          description="Collect shiurim for your commute, a subject you're studying, or a few quiet minutes each day."
                        />
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </section>
      )}
    </>
  );
}
