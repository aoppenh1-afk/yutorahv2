/* oxlint-disable next/no-img-element -- Teacher photos and series covers stream from YUTorah’s CDN. */
/* oxlint-disable jsx-a11y/media-has-caption -- YUTorah provides no caption tracks for these recordings; never invent captions. */
'use client';
import Link from 'next/link';
import { AdvancedSearch, type Filters, noFilters } from './advanced-search';
import { SearchBox } from './search-box';
import { SearchTools } from './search-tools';
import { TranscriptSearch, type TranscriptHit } from './transcript-search';
import { TranscriptReader } from './transcript-reader';
import { Notebook } from './notebook';
import { LearningHome, FollowButton } from './learning-home';
import { isLearned, relatedShiurim, type Follow } from '@/lib/learning';
import { relevanceScore } from '@/lib/search-discovery';
import { matchQuery } from '@/lib/search-matching';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Search,
  Compass,
  BookOpen,
  Users,
  Library,
  Bookmark,
  History,
  ArrowUpRight,
  ArrowRight,
  Play,
  Pause,
  ChevronRight,
  Plus,
  ListMusic,
  ListPlus,
  X,
  Download,
  Share2,
  ExternalLink,
  FileText,
  SlidersHorizontal,
  Loader2,
  ArrowLeft,
  ChevronUp,
  ChevronDown,
  Check,
  HardDrive,
  Timer,
  LayoutGrid,
  List,
  NotebookPen,
  Flame,
  Info,
} from 'lucide-react';
import {
  Sidebar,
  SidebarProvider,
  SidebarContent,
  SidebarHeader,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Avatar,
  FilterSelect,
  Player,
  ShiurCard,
  SeriesCover,
  ShiurRow,
  StatePanel,
} from './ui';
import { useLibrary, useAudio, timeLabel } from '@/lib/library';
import type { HomeData, Shiur, Directory, SearchResult } from '@/lib/yutorah';
import { mediaKind } from '@/lib/yutorah';
type View =
  | 'discover'
  | 'following'
  | 'trending'
  | 'notes'
  | 'search'
  | 'teachers'
  | 'series'
  | 'topics'
  | 'saved'
  | 'history'
  | 'playlists';
const labels: Record<View, string> = {
  discover: 'Discover',
  trending: 'Trending',
  following: 'Following',
  notes: 'My notebook',
  search: 'Search',
  teachers: 'Teachers',
  series: 'Series',
  topics: 'Topics',
  saved: 'Saved shiurim',
  history: 'Learning history',
  playlists: 'My playlists',
};
async function requestJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal });
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok)
    throw new Error(j.error || 'Something went wrong. Please try again.');
  return j;
}
function NavItem({
  icon: Icon,
  label,
  active,
  onClick,
  shortcut,
  count,
}: {
  icon: typeof Search;
  label: string;
  active: boolean;
  onClick: () => void;
  shortcut?: boolean;
  count?: number;
}) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className="nav-button"
        isActive={active}
        onClick={() => {
          setOpenMobile(false);
          onClick();
        }}
      >
        <Icon />
        <span>{label}</span>
        {shortcut && <kbd>⌘ K</kbd>}
        {!!count && <span className="nav-count">{count}</span>}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
export default function TorahApp({
  initialHome,
}: {
  initialHome: HomeData | null;
}) {
  const [home, setHome] = useState(initialHome);
  const [homeLoading, setHomeLoading] = useState(false);
  const [view, setView] = useState<View>('discover');
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [filters, setFilters] = useState<Filters>(noFilters);
  const [results, setResults] = useState<SearchResult | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [directoryError, setDirectoryError] = useState('');
  const [directoryQuery, setDirectoryQuery] = useState('');
  const [directoryLimit, setDirectoryLimit] = useState(36);
  const [topicGroup, setTopicGroup] = useState('all');
  const [grid, setGrid] = useState(false);
  const [advancedFilters, setAdvancedFilters] = useState(false);
  const [withinResults, setWithinResults] = useState('');
  const [learningFilter, setLearningFilter] = useState('all');
  const [libraryQuery, setLibraryQuery] = useState('');
  const [resultOrder, setResultOrder] = useState('library');
  const [detail, setDetail] = useState<
    (Shiur & { text?: string; video?: string }) | null
  >(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [relatedCandidates, setRelatedCandidates] = useState<Shiur[]>([]);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [relatedError, setRelatedError] = useState(false);
  const [relatedRetry, setRelatedRetry] = useState(0);
  const [queueOpen, setQueueOpen] = useState(false);
  const [playlistDialog, setPlaylistDialog] = useState(false);
  const [playlistName, setPlaylistName] = useState('');
  const [editingPlaylist, setEditingPlaylist] = useState('');
  const [undoAction, setUndoAction] = useState<(() => void) | null>(null);
  const [playlistTarget, setPlaylistTarget] = useState<Shiur | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState('');
  const [noteText, setNoteText] = useState('');
  const [toast, setToast] = useState('');
  const [help, setHelp] = useState(false);

  const searchAbort = useRef<AbortController | null>(null);
  const detailAbort = useRef<AbortController | null>(null);
  const initialized = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((text: string) => {
    setToast(text);
    setUndoAction(null);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => {
      setToast('');
      setUndoAction(null);
    }, 6500);
  }, []);
  const { library, update, ready } = useLibrary(notify);
  const player = useAudio(library, update, ready, notify);
  const detailId = detail?.id;
  useEffect(() => {
    setRelatedCandidates([]);
    setRelatedError(false);
    if (!detailId) return;
    const controller = new AbortController();
    setRelatedLoading(true);
    requestJson<{ items: Shiur[]; partial: boolean }>(
      '/api/related?id=' + detailId,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) {
          setRelatedCandidates(data.items);
          setRelatedError(data.partial);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setRelatedError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setRelatedLoading(false);
      });
    return () => controller.abort();
  }, [detailId, relatedRetry]);
  const savedIds = useMemo(
    () => new Set(library.saved.map((s) => s.id)),
    [library.saved],
  );
  const loadDirectory = useCallback(() => {
    setDirectoryError('');
    requestJson<Directory>('/api/directory')
      .then(setDirectory)
      .catch((e) => setDirectoryError(e.message));
  }, []);
  useEffect(() => {
    loadDirectory();
  }, [loadDirectory]);
  const refreshHome = () => {
    setHomeLoading(true);
    requestJson<HomeData>('/api/home')
      .then(setHome)
      .catch((e) => notify(e.message))
      .finally(() => setHomeLoading(false));
  };
  const changeURL = useCallback(
    (nextView: View, query = '', nextFilters: Filters = noFilters) => {
      const url = new URL(window.location.href);
      url.search = '';
      if (nextView !== 'discover') url.searchParams.set('view', nextView);
      if (query) url.searchParams.set('q', query);
      Object.entries(nextFilters).forEach(([k, v]) => {
        if (v) url.searchParams.set(k, v);
      });
      window.history.pushState({}, '', url);
    },
    [],
  );
  const runSearch = useCallback(
    async (
      query: string,
      nextFilters: Filters = noFilters,
      page = 1,
      push = true,
    ) => {
      searchAbort.current?.abort();
      const controller = new AbortController();
      searchAbort.current = controller;
      setView('search');
      setSearchError('');
      setSearchLoading(true);
      setQ(query);
      setSubmitted(query);
      setFilters(nextFilters);
      if (page === 1) {
        setResults(null);
        setWithinResults('');
        setResultOrder('library');
      }
      if (push && page === 1) changeURL('search', query, nextFilters);
      const p = new URLSearchParams({ q: query, page: String(page) });
      Object.entries(nextFilters).forEach(([k, v]) => {
        if (v) p.set(k, v);
      });
      try {
        let result = await requestJson<SearchResult>(
          '/api/search?' + p,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setResultOrder(result.plan.sort || 'relevance');
        while (result.complete === false && !controller.signal.aborted) {
          setResults(result);
          setAdvancedFilters(false);
          p.set('run', result.run!);
          await new Promise<void>((resolve, reject) => {
            const stop = () => {
              clearTimeout(timer);
              reject(new DOMException('Aborted', 'AbortError'));
            };
            const timer = setTimeout(() => {
              controller.signal.removeEventListener('abort', stop);
              resolve();
            }, 400);
            controller.signal.addEventListener('abort', stop, { once: true });
          });
          result = await requestJson<SearchResult>(
            '/api/search?' + p,
            controller.signal,
          );
        }
        if (!controller.signal.aborted) {
          setResults((old) =>
            page > 1 && old
              ? {
                  ...result,
                  items: [
                    ...new Map(
                      [...old.items, ...result.items].map((s) => [s.id, s]),
                    ).values(),
                  ],
                }
              : result,
          );
          if (page === 1) {
            setResultOrder(result.plan.sort || 'relevance');
            setAdvancedFilters(false);
            const resolved: Filters = {
              teacher: result.plan.teacherId
                ? String(result.plan.teacherId)
                : '',
              series: result.plan.seriesId ? String(result.plan.seriesId) : '',
              topic: result.plan.topicId ? String(result.plan.topicId) : '',
              max: result.plan.max ? String(result.plan.max) : '',
              language: result.plan.language,
              format: result.plan.format,
              min: result.plan.min ? String(result.plan.min) : '',
              after: result.plan.after || '',
              before: result.plan.before || '',
              phrase: result.plan.phrase || '',
              exclude: result.plan.exclude || '',
              scope: result.plan.scope || '',
              sort: result.plan.sort || '',
            };
            setFilters(resolved);
            setSubmitted(result.plan.term);
            setQ(result.plan.term);
          }
        }
        return result;
      } catch (e) {
        if (!controller.signal.aborted)
          setSearchError(
            e instanceof Error ? e.message : 'Search failed. Please try again.',
          );
      } finally {
        if (!controller.signal.aborted) setSearchLoading(false);
      }
    },
    [changeURL],
  );
  const navigate = useCallback(
    (next: View) => {
      searchAbort.current?.abort();
      setSearchLoading(false);
      setView(next);
      setDirectoryQuery('');
      setLibraryQuery('');
      setDirectoryLimit(36);
      setSelectedPlaylist('');
      changeURL(next);
      if (next === 'search') {
        setTimeout(() => document.getElementById('main-search')?.focus(), 0);
      }
      window.scrollTo({ top: 0, behavior: 'instant' });
    },
    [changeURL],
  );
  const showDetail = useCallback(async (s: Shiur) => {
    detailAbort.current?.abort();
    const controller = new AbortController();
    detailAbort.current = controller;
    setDetail(s);
    setDetailError('');
    setDetailLoading(true);
    setNoteText('');
    try {
      const fresh = await requestJson<
        Shiur & { text?: string; video?: string }
      >('/api/shiur?id=' + s.id, controller.signal);
      if (!controller.signal.aborted)
        setDetail({
          ...fresh,
          topics: fresh.topics.length ? fresh.topics : s.topics,
          category: fresh.category || s.category,
          series: fresh.series || s.series,
          seriesId: fresh.seriesId || s.seriesId,
        });
    } catch (e) {
      if (!controller.signal.aborted)
        setDetailError(
          e instanceof Error ? e.message : 'Details could not load.',
        );
    } finally {
      if (!controller.signal.aborted) setDetailLoading(false);
    }
  }, []);
  const openById = useCallback(
    async (id: string, seconds?: number) => {
      try {
        const s = await requestJson<Shiur>('/api/shiur?id=' + id);
        await showDetail(s);
        if (seconds !== undefined)
          notify(
            `Shared position: ${timeLabel(seconds)}. Press play to listen.`,
          );
      } catch (e) {
        notify(e instanceof Error ? e.message : 'Shiur not found.');
      }
    },
    [showDetail, notify],
  );
  useEffect(() => {
    const restore = () => {
      const params = new URLSearchParams(window.location.search);
      const v = params.get('view') as View;
      const query = params.get('q') || '';
      const fs = { ...noFilters };
      Object.keys(fs).forEach((k) => {
        fs[k as keyof Filters] = params.get(k) || '';
      });
      searchAbort.current?.abort();
      setSearchLoading(false);
      if (query || (v === 'search' && Object.values(fs).some(Boolean)))
        void runSearch(query, fs, 1, false);
      else if (v && v in labels) setView(v);
      else setView('discover');
      if (params.get('shiur'))
        void openById(
          params.get('shiur')!,
          params.has('t') ? Number(params.get('t')) : undefined,
        );
    };
    if (!initialized.current) {
      initialized.current = true;
      restore();
    }
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [runSearch, openById]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const editing = target.closest(
        'input,textarea,select,[contenteditable=true],[role=dialog],[role=combobox]',
      );
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setView('search');
        setTimeout(() => document.getElementById('main-search')?.focus(), 0);
      } else if (!editing && !e.metaKey && !e.ctrlKey && e.key === '/') {
        e.preventDefault();
        navigate('search');
      } else if (
        !editing &&
        e.code === 'Space' &&
        player.active &&
        target.tagName !== 'BUTTON'
      ) {
        e.preventDefault();
        player.play();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate, player]);
  useEffect(() => {
    const context = (
      document as Document & {
        modelContext?: {
          registerTool: (
            tool: {
              name: string;
              title: string;
              description: string;
              inputSchema: object;
              annotations: object;
              execute: (input: unknown) => Promise<unknown>;
            },
            options: { signal: AbortSignal },
          ) => void | Promise<void>;
        };
      }
    ).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    Promise.resolve(
      context.registerTool(
        {
          name: 'search_yutorah',
          title: 'Search YUTorah',
          description:
            'Search the live YUTorah library and show matching shiurim. Supports topics, full teacher names, and durations such as under 20 minutes.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string', maxLength: 300 } },
            required: ['query'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input: unknown) => {
            if (
              !input ||
              typeof input !== 'object' ||
              !('query' in input) ||
              typeof input.query !== 'string' ||
              input.query.length > 300
            )
              throw new Error(
                'query must be a string of 300 characters or fewer',
              );
            const result = await runSearch(input.query);
            if (!result) throw new Error('Search did not complete.');
            return {
              view: 'search',
              query: input.query,
              total: result.total,
              loaded: result.items.length,
            };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => {});
    return () => lifecycle.abort();
  }, [runSearch]);
  const save = (s: Shiur) => {
    const exists = savedIds.has(s.id);
    update((old) => ({
      ...old,
      saved: exists
        ? old.saved.filter((v) => v.id !== s.id)
        : [s, ...old.saved],
    }));
    notify(exists ? 'Removed from saved shiurim.' : 'Saved on this device.');
  };
  const follow = (item: Follow) => {
    const exists = library.following.some(
      (f) => f.kind === item.kind && f.id === item.id,
    );
    if (!exists && library.following.length >= 100) {
      notify('You can follow up to 100 teachers, topics, and series.');
      return;
    }
    update((old) => ({
      ...old,
      following: exists
        ? old.following.filter(
            (f) => !(f.kind === item.kind && f.id === item.id),
          )
        : [...old.following, item],
    }));
    notify(
      exists
        ? `Unfollowed ${item.name}.`
        : `Following ${item.name}. Your feed is updated.`,
    );
  };
  const enqueue = (s: Shiur) => {
    if (library.queue.some((v) => v.id === s.id)) {
      notify('Already in your queue.');
      return;
    }
    update((old) => ({ ...old, queue: [...old.queue, s] }));
    notify('Added to your queue.');
  };
  const play = (s: Shiur) => {
    if (mediaKind(s) !== 'audio') {
      void showDetail(s);
      return;
    }
    if (player.active?.id === s.id) player.play();
    else player.start(s);
  };
  const addToPlaylist = (s: Shiur) => {
    setEditingPlaylist('');
    setPlaylistTarget(s);
    setPlaylistName('');
    setPlaylistDialog(true);
  };
  const createPlaylist = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = playlistName.trim();
    if (!name) return;
    if (editingPlaylist) {
      update((old) => ({
        ...old,
        playlists: old.playlists.map((p) =>
          p.id === editingPlaylist ? { ...p, name } : p,
        ),
      }));
      setPlaylistDialog(false);
      setEditingPlaylist('');
      notify('Playlist renamed.');
      return;
    }
    const id = crypto.randomUUID();
    update((old) => ({
      ...old,
      playlists: [
        ...old.playlists,
        { id, name, items: playlistTarget ? [playlistTarget] : [] },
      ],
    }));
    setPlaylistDialog(false);
    setPlaylistName('');
    notify(`Created “${name}” on this device.`);
  };
  const share = async (s: Shiur, seconds = 0) => {
    const url = new URL(window.location.origin);
    url.searchParams.set('shiur', String(s.id));
    if (seconds > 0) url.searchParams.set('t', String(Math.floor(seconds)));
    try {
      await navigator.clipboard.writeText(url.href);
      notify('Link copied.');
    } catch {
      notify('Copy the link from the address bar.');
      window.history.replaceState({}, '', url);
    }
  };
  const openTranscriptHit = (hit: TranscriptHit) => {
    const seconds = Math.max(0, hit.startMs / 1000);
    const url = new URL(window.location.href);
    url.searchParams.set('shiur', hit.shiurId);
    url.searchParams.set('t', String(Math.floor(seconds)));
    window.history.pushState({}, '', url);
    if (hit.mediaUrl) {
      const shiur: Shiur = {
        id: Number(hit.shiurId),
        title: hit.title,
        teacher: hit.teacher,
        teacherId: 0,
        image: '',
        audio: hit.mediaUrl,
        url: `https://yutorah.org/lectures/details?shiurID=${hit.shiurId}`,
        duration: 0,
        date: '',
        topics: [],
        category: '',
        language: '',
        series: '',
        seriesId: 0,
        description: '',
        format: 'mp3',
        materials: [],
      };
      player.start(shiur, seconds);
      void showDetail(shiur);
    } else {
      void requestJson<Shiur>(`/api/shiur?id=${hit.shiurId}`)
        .then((shiur) => {
          player.start(shiur, seconds);
          void showDetail(shiur);
        })
        .catch((error) =>
          notify(
            error instanceof Error
              ? error.message
              : 'Shiur audio is unavailable.',
          ),
        );
    }
  };
  const filterChange = (key: keyof Filters, value: string) =>
    void runSearch(submitted, {
      ...filters,
      [key]: value === 'all' ? '' : value,
    });
  const rows = (items: Shiur[], history = false) =>
    items.map((s) => (
      <ShiurRow
        key={s.id}
        shiur={s}
        query={view === 'search' ? results?.plan.term : undefined}
        onPlay={play}
        onDetails={showDetail}
        onSave={save}
        onQueue={enqueue}
        saved={savedIds.has(s.id)}
        learned={isLearned(s, library)}
        progress={
          history ? library.history.find((h) => h.shiur.id === s.id) : undefined
        }
        extra={
          <>
            <button
              className="icon-button learned-action"
              aria-label={
                (isLearned(s, library)
                  ? 'Mark as not learned: '
                  : 'Mark as learned: ') + s.title
              }
              aria-pressed={isLearned(s, library)}
              onClick={() => {
                const learned = isLearned(s, library);
                update((old) => ({
                  ...old,
                  completed: learned
                    ? old.completed.filter((id) => id !== s.id)
                    : [...new Set([...old.completed, s.id])],
                  history: learned
                    ? old.history.map((h) =>
                        h.shiur.id === s.id ? { ...h, seconds: 0 } : h,
                      )
                    : old.history.some((h) => h.shiur.id === s.id)
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
                notify(
                  learned ? 'Marked as not learned.' : 'Marked as learned.',
                );
              }}
            >
              <Check size={17} />
            </button>
            <button
              className="icon-button add-playlist-action"
              aria-label={'Add to playlist: ' + s.title}
              onClick={() => addToPlaylist(s)}
            >
              <Plus size={17} />
            </button>
          </>
        }
      />
    ));
  const cards = (items: Shiur[]) =>
    items.map((s, i) => (
      <ShiurCard
        key={s.id}
        shiur={s}
        index={i}
        query={view === 'search' ? results?.plan.term : undefined}
        onPlay={play}
        onDetails={showDetail}
        onSave={save}
        saved={savedIds.has(s.id)}
        active={player.active?.id === s.id && player.playing}
      />
    ));
  const searchBar = (
    <SearchBox
      value={q}
      onChange={setQ}
      directory={directory}
      onSearch={(query) =>
        void runSearch(query, view === 'search' ? filters : noFilters)
      }
      onSelect={(suggestion) =>
        void runSearch('', {
          ...noFilters,
          [suggestion.kind]: String(suggestion.id),
        })
      }
    />
  );
  const orderedResults = useMemo(() => {
    const items = [...(results?.items || [])];
    if (results?.complete !== undefined) return items;
    if (resultOrder === 'relevance')
      items.sort(
        (a, b) =>
          relevanceScore(b, results?.plan.term || '') -
          relevanceScore(a, results?.plan.term || ''),
      );
    if (resultOrder === 'short')
      items.sort((a, b) => (a.duration || Infinity) - (b.duration || Infinity));
    if (resultOrder === 'popular')
      items.sort((a, b) => (b.views || 0) - (a.views || 0));
    if (resultOrder === 'new')
      items.sort(
        (a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0),
      );
    if (resultOrder === 'title')
      items.sort((a, b) => a.title.localeCompare(b.title));
    return items;
  }, [results, resultOrder]);
  const visibleResults = orderedResults.filter((s) => {
    if (learningFilter === 'unlearned' && isLearned(s, library)) return false;
    if (learningFilter === 'saved' && !savedIds.has(s.id)) return false;
    return matchQuery(
      [s.title, s.teacher, s.description, s.series, ...s.topics].join(' '),
      withinResults,
    );
  });
  const loadedItems = [
    ...new Map(
      [
        ...(home?.featured || []),
        ...(home?.recent || []),
        ...(home?.daily || []),
        ...(results?.items || []),
        ...library.saved,
        ...library.history.map((h) => h.shiur),
      ].map((s) => [s.id, s]),
    ).values(),
  ];
  const detailRelated = detail
    ? relatedShiurim(detail, [...relatedCandidates, ...loadedItems], library)
    : [];
  const matchLibrary = (s: Shiur) =>
    matchQuery(s.title + ' ' + s.teacher + ' ' + s.series, libraryQuery);
  const listedTeachers =
    directory?.teachers.filter((t) => matchQuery(t.name, directoryQuery, 2)) ||
    [];
  const listedSeries =
    directory?.series.filter((s) =>
      matchQuery(s.name + ' ' + s.description, directoryQuery, 2),
    ) || [];
  const listedTopics =
    directory?.topics.filter(
      (t) =>
        (topicGroup === 'all' || t.group === topicGroup) &&
        matchQuery(t.name + ' ' + t.group, directoryQuery, 2),
    ) || [];
  const videoSource =
    detail?.video ||
    (['youtube', 'video', 'mp4'].includes(detail?.format || '')
      ? detail?.audio
      : '');
  const youtubeId = videoSource?.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([\w-]{11})/,
  )?.[1];
  const playlist = library.playlists.find((p) => p.id === selectedPlaylist);
  return (
    <SidebarProvider
      style={{ '--sidebar-width': '232px' } as React.CSSProperties}
    >
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <Sidebar className="torah-sidebar">
        <SidebarHeader>
          <Link
            prefetch={false}
            className="brand"
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate('discover');
            }}
          >
            <span className="brand-mark">YU</span>
            <span>
              Torah
              <span className="brand-caption">TORAH. EVERY DAY.</span>
            </span>
          </Link>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <div className="nav-label">EXPLORE</div>
            <SidebarMenu>
              {(
                [
                  { icon: Compass, view: 'discover' },
                  { icon: Flame, view: 'trending' },
                  { icon: Users, view: 'following' },
                  { icon: Search, view: 'search' },
                  { icon: Users, view: 'teachers' },
                  { icon: BookOpen, view: 'series' },
                  { icon: LayoutGrid, view: 'topics' },
                ] as const
              ).map((item) => (
                <NavItem
                  key={item.view}
                  icon={item.icon}
                  label={labels[item.view]}
                  active={view === item.view}
                  shortcut={item.view === 'search'}
                  onClick={() => navigate(item.view)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroup>
          <SidebarGroup>
            <div className="nav-label">YOUR LEARNING</div>
            <SidebarMenu>
              {(
                [
                  { icon: Bookmark, view: 'saved' },
                  { icon: History, view: 'history' },
                  { icon: NotebookPen, view: 'notes' },
                  { icon: Library, view: 'playlists' },
                ] as const
              ).map((item) => (
                <NavItem
                  key={item.view}
                  icon={item.icon}
                  label={labels[item.view]}
                  active={view === item.view}
                  count={
                    item.view === 'saved' ? library.saved.length : undefined
                  }
                  onClick={() => navigate(item.view)}
                />
              ))}
              <NavItem
                icon={ListMusic}
                label="Listening queue"
                active={false}
                count={library.queue.length}
                onClick={() => setQueueOpen(true)}
              />
            </SidebarMenu>
            <button
              className="new-playlist-button"
              onClick={() => {
                setEditingPlaylist('');
                setPlaylistTarget(null);
                setPlaylistName('');
                setPlaylistDialog(true);
              }}
            >
              <Plus size={15} /> Create playlist
            </button>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <div className="yu-affiliate">
            YESHIVA UNIVERSITY
            <br />
            <span>The Marcos and Adina Katz YUTorah</span>
          </div>
          <a
            href="https://yutorah.org"
            target="_blank"
            rel="noreferrer"
            className="original-link"
          >
            YUTorah.org <ArrowUpRight size={14} />
          </a>
        </SidebarFooter>
      </Sidebar>
      <nav className="mobile-nav" aria-label="Main navigation">
        {(
          [
            { icon: Compass, view: 'discover' },
            { icon: Search, view: 'search' },
            { icon: Users, view: 'teachers' },
            { icon: Bookmark, view: 'saved' },
          ] as const
        ).map((item) => (
          <button
            key={item.view}
            aria-current={view === item.view ? 'page' : undefined}
            onClick={() => navigate(item.view)}
          >
            <item.icon size={20} />
            <span>{item.view === 'saved' ? 'Saved' : labels[item.view]}</span>
          </button>
        ))}
      </nav>
      <div className={'app-body ' + (player.active ? 'has-player' : '')}>
        <header className="topbar">
          <div className="breadcrumb">
            <SidebarTrigger className="mobile-toggle" />
            <button
              className="header-home"
              onClick={() => navigate('discover')}
            >
              <span className="desktop-home-label">Your learning</span>
              <span className="mobile-home-label">
                YU<span>Torah</span>
              </span>
            </button>
            <ChevronRight size={14} />
            <b>{labels[view]}</b>
          </div>
          {view !== 'search' && (
            <div className="header-search">{searchBar}</div>
          )}
          <div className="header-right">
            <span className="hebrew" lang="he">
              {home?.hebrewDate}
            </span>
            <button
              className="header-library-button"
              aria-label="Open saved shiurim"
              onClick={() => navigate('saved')}
            >
              <Bookmark size={19} />
            </button>
            <button
              className="header-about-button"
              aria-label="About your learning library"
              onClick={() => setHelp(true)}
            >
              <Info size={19} />
            </button>
          </div>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          {(view === 'discover' ||
            view === 'following' ||
            view === 'trending') && (
            <LearningHome
              key={view}
              home={home}
              directory={directory}
              library={library}
              update={update}
              onPlay={(s, seconds) =>
                seconds !== undefined ? player.start(s, seconds) : play(s)
              }
              onDetails={showDetail}
              onSave={save}
              onQueue={enqueue}
              onFollow={follow}
              onSearch={(query, fs) => void runSearch(query, fs)}
              onNavigate={navigate}
              notify={notify}
              onRefresh={refreshHome}
              refreshing={homeLoading}
              followingPage={view === 'following'}
              trendingPage={view === 'trending'}
              activeId={player.active?.id}
              playing={player.playing}
            />
          )}
          {view === 'search' && (
            <section
              className={'search-view ' + (results ? 'has-results' : '')}
            >
              <div className="view-heading">
                <div className="eyebrow">THE YUTORAH LIBRARY</div>
                <h1>What will you learn next?</h1>
                <p>
                  Find shiurim by topic, teacher, source, or the time you have.
                </p>
              </div>
              {searchBar}
              <SearchTools
                query={q}
                filters={filters}
                directory={directory}
                library={library}
                update={update}
                onSearch={(query, fs) => void runSearch(query, fs)}
                notify={notify}
                hasResults={!!results}
              />
              <TranscriptSearch
                query={results?.plan.term ?? submitted}
                onSelect={openTranscriptHit}
              />
              <div className="filter-bar">
                <button
                  className="filter-toggle"
                  aria-expanded={advancedFilters}
                  aria-controls="advanced-search-filters"
                  onClick={() => setAdvancedFilters(!advancedFilters)}
                >
                  <SlidersHorizontal size={16} /> Advanced search{' '}
                  <ChevronDown size={14} />
                </button>
                <FilterSelect
                  label="Duration"
                  value={filters.max || 'all'}
                  onChange={(v) => filterChange('max', v)}
                  options={[
                    { value: 'all', label: 'Any length' },
                    ...Array.from(
                      new Set([
                        '10',
                        '20',
                        '30',
                        '60',
                        ...(filters.max ? [filters.max] : []),
                      ]),
                    )
                      .sort((a, b) => Number(a) - Number(b))
                      .map((v) => ({
                        value: v,
                        label: `Under ${v} min`,
                      })),
                  ]}
                />
                <FilterSelect
                  label="Language"
                  value={filters.language || 'all'}
                  onChange={(v) => filterChange('language', v)}
                  options={[
                    { value: 'all', label: 'Any language' },
                    { value: 'EN', label: 'English' },
                    { value: 'HE', label: 'Hebrew' },
                  ]}
                />
                <FilterSelect
                  label="Format"
                  value={filters.format || 'all'}
                  onChange={(v) => filterChange('format', v)}
                  options={[
                    { value: 'all', label: 'All formats' },
                    { value: 'audio', label: 'Audio' },
                    { value: 'video', label: 'Video' },
                    { value: 'text', label: 'Articles' },
                  ]}
                />
                {Object.entries(filters).some(
                  ([key, value]) => key !== 'sort' && value,
                ) && (
                  <button
                    className="text-button"
                    onClick={() => void runSearch(submitted, noFilters)}
                  >
                    Clear filters <X size={13} />
                  </button>
                )}
              </div>
              {advancedFilters && (
                <AdvancedSearch
                  key={JSON.stringify(filters)}
                  filters={filters}
                  directory={directory}
                  loading={searchLoading}
                  onApply={(next) => void runSearch(q, next)}
                />
              )}
              {Object.entries(filters).some(
                ([key, value]) => key !== 'sort' && value,
              ) && (
                <div className="applied-filters" aria-label="Active filters">
                  {(Object.entries(filters) as [keyof Filters, string][])
                    .filter(([key, v]) => v && key !== 'sort')
                    .map(([key, value]) => {
                      const extraLabels: Partial<
                        Record<keyof Filters, string>
                      > = {
                        min: `At least ${value} minutes`,
                        after: `From ${value}`,
                        before: `Through ${value}`,
                        phrase: `Exact phrase: ${value}`,
                        exclude: `Exclude: ${value}`,
                        scope: 'Title only',
                      };
                      const label =
                        extraLabels[key] ||
                        (key === 'teacher'
                          ? directory?.teachers.find(
                              (t) => String(t.id) === value,
                            )?.name || 'Selected teacher'
                          : key === 'series'
                            ? directory?.series.find(
                                (t) => String(t.id) === value,
                              )?.name || 'Selected series'
                            : key === 'topic'
                              ? directory?.topics.find(
                                  (t) => String(t.id) === value,
                                )?.name || 'Selected topic'
                              : key === 'max'
                                ? `Under ${value} minutes`
                                : key === 'language'
                                  ? value === 'HE'
                                    ? 'Hebrew'
                                    : 'English'
                                  : value === 'text'
                                    ? 'Articles'
                                    : value === 'audio'
                                      ? 'Audio'
                                      : 'Video');
                      return (
                        <button
                          key={key}
                          onClick={() => filterChange(key, 'all')}
                          aria-label={`Remove filter: ${label}`}
                        >
                          {label}
                          <X size={13} />
                        </button>
                      );
                    })}
                </div>
              )}
              {!!results?.plan.labels.filter((l) =>
                /→|^Topic:|^Keywords:|^Related topics:|^Broadened search:/.test(
                  l,
                ),
              ).length && (
                <p className="search-interpretation">
                  <Search size={14} />{' '}
                  {results.plan.labels
                    .filter((l) =>
                      /→|^Topic:|^Keywords:|^Related topics:|^Broadened search:/.test(
                        l,
                      ),
                    )
                    .join(' · ')}
                </p>
              )}
              {searchError && (
                <StatePanel
                  title="Search could not be reached."
                  description={searchError}
                >
                  <button
                    className="primary-button"
                    onClick={() => void runSearch(submitted, filters)}
                  >
                    Try again
                  </button>
                </StatePanel>
              )}
              {searchLoading && !results && (
                <output className="loading-panel">
                  <Loader2 className="spin" size={25} />
                  <p>Searching YUTorah…</p>
                </output>
              )}
              {results && (
                <>
                  <div className="results-heading" aria-live="polite">
                    <div>
                      <h2>
                        {results.complete === false
                          ? `${results.total.toLocaleString()} matches found so far`
                          : results.filtered
                            ? `${results.items.length} matching shiurim loaded`
                            : `${results.total.toLocaleString()} shiurim`}
                      </h2>
                      {results.complete !== undefined && (
                        <p>
                          {results.complete
                            ? `All ${results.sourceTotal?.toLocaleString()} library candidates checked. ${results.total.toLocaleString()} matches.`
                            : `Checking the full result set: ${results.scanned?.toLocaleString()} of ${results.sourceTotal?.toLocaleString()} shiurim. Counts and order are provisional until complete.`}
                        </p>
                      )}
                      {results.complete === false && (
                        <div className="full-search-progress">
                          <progress
                            aria-label="Search progress"
                            value={results.scanned || 0}
                            max={results.sourceTotal || 1}
                          />
                          <button
                            className="text-button"
                            onClick={() => {
                              if (searchLoading) {
                                searchAbort.current?.abort();
                                setSearchLoading(false);
                              } else void runSearch(submitted, filters);
                            }}
                          >
                            {searchLoading ? 'Pause search' : 'Continue search'}
                          </button>
                        </div>
                      )}
                      {results.filtered && (
                        <p>
                          Filtered from {results.total.toLocaleString()} library
                          matches.{' '}
                          {results.nextPage
                            ? 'Load more to continue.'
                            : 'All matches checked.'}
                        </p>
                      )}
                    </div>
                    <div className="result-view-controls">
                      <FilterSelect
                        label="Sort all results"
                        value={resultOrder}
                        onChange={(sort) =>
                          void runSearch(submitted, { ...filters, sort })
                        }
                        options={[
                          { value: 'relevance', label: 'Best matches' },
                          { value: 'popular', label: 'Most popular' },
                          { value: 'library', label: 'Library order' },
                          { value: 'new', label: 'Newest first' },
                          { value: 'old', label: 'Oldest first' },
                          { value: 'long', label: 'Longest first' },
                          { value: 'short', label: 'Shortest first' },
                          { value: 'title', label: 'Title A–Z' },
                        ]}
                      />
                      <div className="view-switch">
                        <button
                          aria-label="List view"
                          aria-pressed={!grid}
                          onClick={() => setGrid(false)}
                        >
                          <List size={17} />
                        </button>
                        <button
                          aria-label="Grid view"
                          aria-pressed={grid}
                          onClick={() => setGrid(true)}
                        >
                          <LayoutGrid size={17} />
                        </button>
                      </div>
                    </div>
                  </div>
                  {results.items.length > 0 && (
                    <div className="results-workspace-tools">
                      <label className="within-search">
                        <Search size={16} />
                        <input
                          aria-label="Find within loaded results"
                          placeholder="Find within these results…"
                          value={withinResults}
                          onChange={(e) => setWithinResults(e.target.value)}
                        />
                      </label>
                      <FilterSelect
                        label="Learning status"
                        value={learningFilter}
                        onChange={setLearningFilter}
                        options={[
                          { value: 'all', label: 'All learning' },
                          { value: 'unlearned', label: 'Not learned yet' },
                          { value: 'saved', label: 'Saved only' },
                        ]}
                      />
                      <button
                        className="text-button"
                        onClick={() => {
                          const audio = visibleResults.filter(
                            (s) => mediaKind(s) === 'audio',
                          );
                          update((old) => ({
                            ...old,
                            queue: [
                              ...new Map(
                                [...old.queue, ...audio].map((s) => [s.id, s]),
                              ).values(),
                            ],
                          }));
                          notify(
                            `Added ${audio.length} audio shiurim to your queue.`,
                          );
                        }}
                      >
                        <ListPlus size={16} />
                        Queue results
                      </button>
                      {(withinResults || learningFilter !== 'all') && (
                        <p>
                          {visibleResults.length} of {results.items.length}{' '}
                          loaded shiurim match these local refinements.{' '}
                          <button
                            onClick={() => {
                              setWithinResults('');
                              setLearningFilter('all');
                            }}
                          >
                            Reset
                          </button>
                        </p>
                      )}
                    </div>
                  )}
                  {results.plan.teacherId > 0 && (
                    <div className="search-follow-banner">
                      <span>
                        <Users size={17} />
                        {results.plan.teacherName ||
                          directory?.teachers.find(
                            (t) => t.id === results.plan.teacherId,
                          )?.name ||
                          'This teacher'}
                      </span>
                      <FollowButton
                        follow={{
                          kind: 'teacher',
                          id: results.plan.teacherId,
                          name:
                            results.plan.teacherName ||
                            directory?.teachers.find(
                              (t) => t.id === results.plan.teacherId,
                            )?.name ||
                            'Selected teacher',
                        }}
                        library={library}
                        onFollow={follow}
                      />
                    </div>
                  )}
                  {results.items.length > 0 && visibleResults.length === 0 && (
                    <StatePanel
                      title="No matches in these loaded results"
                      description="Clear the local refinement or load more shiurim to keep looking."
                    >
                      <button
                        className="outline-button"
                        onClick={() => {
                          setWithinResults('');
                          setLearningFilter('all');
                        }}
                      >
                        Clear refinement
                      </button>
                    </StatePanel>
                  )}
                  {results.items.length ? (
                    grid ? (
                      <div className="shiur-grid">{cards(visibleResults)}</div>
                    ) : (
                      <div className="results-list">{rows(visibleResults)}</div>
                    )
                  ) : (
                    <StatePanel
                      title={
                        results.complete === false
                          ? 'Still checking for matches…'
                          : 'No matching shiurim.'
                      }
                      description={
                        results.complete === false
                          ? 'The search continues automatically. You can narrow the filters while it runs.'
                          : 'Try a broader topic, a teacher’s full name, or fewer filters.'
                      }
                    />
                  )}{' '}
                  {results.nextPage && (
                    <div className="load-more">
                      <button
                        className="outline-button"
                        disabled={searchLoading}
                        onClick={() =>
                          void runSearch(
                            submitted,
                            filters,
                            results.nextPage!,
                            false,
                          )
                        }
                      >
                        {searchLoading ? (
                          <>
                            <Loader2 size={15} className="spin" />
                            Searching…
                          </>
                        ) : (
                          'Load more shiurim'
                        )}
                        <ArrowRight size={15} />
                      </button>
                    </div>
                  )}
                </>
              )}
              {!results && !searchLoading && !searchError && (
                <div className="search-start">
                  <BookOpen size={28} />
                  <h2>What would you like to learn?</h2>
                  <p>
                    Search a subject, a teacher’s full name, or a source. Add
                    “under 20 minutes” to fit your time.
                  </p>
                  <div className="search-prompts">
                    {[
                      'How can I improve my prayer?',
                      'Rosh Hashana',
                      'Rabbi Aryeh Lebowitz',
                      'Chullin 130',
                    ].map((t) => (
                      <button key={t} onClick={() => void runSearch(t)}>
                        {t}
                        <ArrowUpRight size={15} />
                      </button>
                    ))}
                  </div>
                  <button
                    className="text-button"
                    onClick={() => void runSearch('')}
                  >
                    Browse all shiurim <ArrowRight size={15} />
                  </button>
                </div>
              )}
            </section>
          )}
          {(['teachers', 'series', 'topics'] as View[]).includes(view) && (
            <section className="directory-view">
              <div className="view-heading">
                <div className="eyebrow">EXPLORE THE LIBRARY</div>
                <h1>
                  {view === 'teachers'
                    ? 'Teachers'
                    : view === 'series'
                      ? 'Series'
                      : 'Topics'}
                </h1>
                <p>
                  {view === 'teachers'
                    ? 'Voices and perspectives from across the YUTorah community.'
                    : view === 'series'
                      ? 'Follow a subject, one shiur at a time.'
                      : 'Browse the subjects that make up a lifetime of Torah.'}
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
                {view === 'topics' && directory && (
                  <FilterSelect
                    label="Subject"
                    value={topicGroup}
                    onChange={setTopicGroup}
                    options={[
                      { value: 'all', label: 'All subjects' },
                      ...directory.groups.map((g) => ({ value: g, label: g })),
                    ]}
                  />
                )}
                <span>
                  {view === 'teachers'
                    ? listedTeachers.length
                    : view === 'series'
                      ? listedSeries.length
                      : listedTopics.length}{' '}
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
                            <Avatar src={t.image} name={t.name} />
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
                            <SeriesCover name={s.name} id={s.id} />
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
                    <div className="topic-grid">
                      {listedTopics.slice(0, directoryLimit).map((t) => (
                        <article
                          className="topic-follow-wrap"
                          key={t.id + '-' + t.group}
                        >
                          <button
                            className="topic-card"
                            onClick={() =>
                              void runSearch('', {
                                ...noFilters,
                                topic: String(t.id),
                              })
                            }
                          >
                            <span>{t.group}</span>
                            <h2>{t.name}</h2>
                            <p>
                              {t.count.toLocaleString()} shiurim{' '}
                              <ArrowUpRight size={17} />
                            </p>
                          </button>
                          <FollowButton
                            follow={{ kind: 'topic', id: t.id, name: t.name }}
                            library={library}
                            onFollow={follow}
                          />
                        </article>
                      ))}
                    </div>
                  )}
                  {(view === 'teachers'
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
                <div className="eyebrow">YOUR LEARNING</div>
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
                          placeholder="Find a shiur or teacher in your learning…"
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
                        library.history
                          .map((h) => h.shiur)
                          .filter(matchLibrary),
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
                                {playlist.items.length === 1
                                  ? 'shiur'
                                  : 'shiurim'}
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
                            playlist.items.map((s) => (
                              <ShiurRow
                                key={s.id}
                                shiur={s}
                                onPlay={play}
                                onDetails={showDetail}
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
          {view === 'notes' && (
            <Notebook
              library={library}
              items={loadedItems}
              onOpen={(id) => void openById(String(id))}
              onExplore={() => navigate('discover')}
              onPlay={(id, seconds) => {
                const s =
                  loadedItems.find((item) => item.id === id) ||
                  library.notes.find((n) => n.shiurId === id)?.shiur;
                if (s) {
                  if (mediaKind(s) === 'audio') player.start(s, seconds);
                  else void showDetail(s);
                } else
                  requestJson<Shiur>('/api/shiur?id=' + id)
                    .then((fresh) => {
                      if (mediaKind(fresh) === 'audio')
                        player.start(fresh, seconds);
                      else void showDetail(fresh);
                    })
                    .catch(() =>
                      notify('This shiur could not load. Please try again.'),
                    );
              }}
              onRemove={(note) => {
                update((old) => ({
                  ...old,
                  notes: old.notes.filter((n) => n.id !== note.id),
                }));
                notify('Note removed.');
                setUndoAction(() => () => {
                  update((old) => ({ ...old, notes: [...old.notes, note] }));
                  notify('Note restored.');
                });
              }}
            />
          )}
          <footer className="page-footer">
            <span>
              {home ? `${home.total.toLocaleString()} shiurim. ` : ''}One shared
              tradition.
            </span>
            <div>
              <button onClick={() => setHelp(true)}>
                About this experience
              </button>
              <span>Audio and teaching © YUTorah</span>
            </div>
          </footer>
        </main>
        <Player
          player={player}
          library={library}
          update={update}
          onDetails={showDetail}
          onQueue={() => setQueueOpen(true)}
          onSave={save}
        />
      </div>
      <Sheet
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) {
            detailAbort.current?.abort();
            setDetail(null);
          }
        }}
      >
        <SheetContent className="detail-sheet">
          <SheetHeader>
            <SheetTitle>Shiur details</SheetTitle>
            <SheetDescription>From the YUTorah library</SheetDescription>
          </SheetHeader>
          {detail && (
            <div className="detail-body">
              <div className="detail-topic">
                {detail.topics.slice(0, 3).join(' · ') || detail.category}
              </div>
              <h2 dir="auto">{detail.title}</h2>
              <button
                className="detail-teacher"
                onClick={() => {
                  setDetail(null);
                  void runSearch('', {
                    ...noFilters,
                    teacher: String(detail.teacherId),
                  });
                }}
              >
                <Avatar src={detail.image} name={detail.teacher} />
                <div>
                  <strong>{detail.teacher}</strong>
                  <span>
                    More from this teacher <ArrowRight size={13} />
                  </span>
                </div>
              </button>
              <div className="detail-follow-controls">
                <FollowButton
                  follow={{
                    kind: 'teacher',
                    id: detail.teacherId,
                    name: detail.teacher,
                    image: detail.image,
                  }}
                  library={library}
                  onFollow={follow}
                />
                <button
                  className="text-button"
                  aria-pressed={isLearned(detail, library)}
                  onClick={() => {
                    const learned = isLearned(detail, library);
                    update((old) => ({
                      ...old,
                      completed: learned
                        ? old.completed.filter((id) => id !== detail.id)
                        : [...new Set([...old.completed, detail.id])],
                      history: learned
                        ? old.history.map((h) =>
                            h.shiur.id === detail.id ? { ...h, seconds: 0 } : h,
                          )
                        : old.history.some((h) => h.shiur.id === detail.id)
                          ? old.history
                          : [
                              {
                                shiur: detail,
                                seconds: 0,
                                duration: detail.duration,
                                updatedAt: new Date().toISOString(),
                              },
                              ...old.history,
                            ].slice(0, 200),
                    }));
                    notify(
                      learned ? 'Marked as not learned.' : 'Marked as learned.',
                    );
                  }}
                >
                  <Check size={15} />
                  {isLearned(detail, library) ? 'Learned' : 'Mark as learned'}
                </button>
              </div>
              <div className="detail-meta">
                <span>
                  {detail.duration
                    ? `${Math.round(detail.duration / 60)} minutes`
                    : detail.format.toUpperCase()}
                </span>
                <span>
                  {detail.language === 'HE'
                    ? 'Hebrew'
                    : detail.language === 'EN'
                      ? 'English'
                      : detail.language}
                </span>
                <span>
                  {detail.date
                    ? new Date(detail.date).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                        timeZone: 'UTC',
                      })
                    : ''}
                </span>
              </div>
              <div className="detail-actions">
                {mediaKind(detail) === 'audio' ? (
                  <button
                    className="primary-button"
                    onClick={() => {
                      const params = new URLSearchParams(
                        window.location.search,
                      );
                      const shared =
                        params.get('shiur') === String(detail.id) &&
                        params.has('t')
                          ? Math.max(0, Number(params.get('t')) || 0)
                          : undefined;
                      player.start(detail, shared);
                    }}
                  >
                    <Play size={16} fill="currentColor" />
                    Listen
                    {library.history.some((h) => h.shiur.id === detail.id)
                      ? ' / resume'
                      : ' now'}
                  </button>
                ) : (
                  <a
                    className="primary-button"
                    href={detail.audio || detail.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {mediaKind(detail) === 'text' ? (
                      <FileText size={16} />
                    ) : (
                      <Play size={16} />
                    )}{' '}
                    {mediaKind(detail) === 'text'
                      ? 'Read article'
                      : 'Open video'}{' '}
                    <ExternalLink size={14} />
                  </a>
                )}
                <button className="outline-button" onClick={() => save(detail)}>
                  <Bookmark
                    size={16}
                    fill={savedIds.has(detail.id) ? 'currentColor' : 'none'}
                  />
                  {savedIds.has(detail.id) ? 'Saved' : 'Save'}
                </button>
              </div>
              <div className="detail-tools">
                {mediaKind(detail) === 'audio' && (
                  <button onClick={() => enqueue(detail)}>
                    <ListPlus size={17} />
                    Queue
                  </button>
                )}
                <button onClick={() => addToPlaylist(detail)}>
                  <Plus size={17} />
                  Playlist
                </button>
                <button onClick={() => void share(detail)}>
                  <Share2 size={16} />
                  Share
                </button>
                {detail.audio && (
                  <a
                    href={detail.audio}
                    target="_blank"
                    rel="noreferrer"
                    download
                  >
                    <Download size={17} />
                    Download
                  </a>
                )}
              </div>
              {detailLoading && (
                <output className="inline-loading">
                  <Loader2 size={14} className="spin" />
                  Loading notes and sources…
                </output>
              )}
              {detailError && (
                <div className="inline-error" role="alert">
                  {detailError}
                  <button onClick={() => void showDetail(detail)}>Retry</button>
                </div>
              )}
              {youtubeId && (
                <iframe
                  className="video-embed"
                  src={'https://www.youtube-nocookie.com/embed/' + youtubeId}
                  title="YUTorah shiur video"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              )}
              {videoSource &&
                !youtubeId &&
                /\.mp4(?:\?|$)/i.test(videoSource) && (
                  <video
                    className="video-embed"
                    src={videoSource}
                    controls
                    playsInline
                  />
                )}
              {detail.description && (
                <section className="detail-section">
                  <h3>About this shiur</h3>
                  <p>{detail.description}</p>
                </section>
              )}
              {detail.series && (
                <section className="detail-section">
                  <h3>Part of a series</h3>
                  <button
                    className="series-detail-link"
                    onClick={() => {
                      setDetail(null);
                      void runSearch('', {
                        ...noFilters,
                        series: String(detail.seriesId),
                      });
                    }}
                  >
                    <BookOpen size={20} />
                    {detail.series}
                    <ArrowRight size={16} />
                  </button>
                </section>
              )}
              {detail.text && (
                <section className="detail-section">
                  <h3>Text from YUTorah</h3>
                  <p className="source-text" dir="auto">
                    {detail.text}
                  </p>
                </section>
              )}
              {detail.materials.length > 0 && (
                <section className="detail-section">
                  <h3>Source sheets</h3>
                  {detail.materials.map((m, i) => (
                    <a
                      className="source-link"
                      key={m.url + i}
                      href={m.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <FileText size={16} />
                      {m.name || `Source sheet ${i + 1}`}
                      <ExternalLink size={14} />
                    </a>
                  ))}
                </section>
              )}
              <TranscriptReader
                shiurId={detail.id}
                onSeek={(seconds) => player.start(detail, seconds)}
              />
              <section className="detail-section">
                <div className="note-heading">
                  <h3>
                    <NotebookPen size={17} />
                    Your notes
                  </h3>
                  <span>On this device</span>
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const text = noteText.trim();
                    if (!text) return;
                    const seconds =
                      player.active?.id === detail.id
                        ? Math.floor(player.time)
                        : 0;
                    update((old) => ({
                      ...old,
                      notes: [
                        ...old.notes,
                        {
                          id: crypto.randomUUID(),
                          shiurId: detail.id,
                          shiur: detail,
                          text,
                          seconds,
                          date: new Date().toISOString(),
                        },
                      ],
                    }));
                    setNoteText('');
                    notify('Note saved.');
                  }}
                >
                  <textarea
                    aria-label="Write a note"
                    placeholder="A question, a source, a thought to return to…"
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    maxLength={5000}
                  />
                  <div className="note-form-footer">
                    <span>
                      {player.active?.id === detail.id
                        ? `At ${timeLabel(player.time)}`
                        : 'Add a note to this shiur'}
                    </span>
                    <button
                      className="outline-button"
                      type="submit"
                      disabled={!noteText.trim()}
                    >
                      Save note
                    </button>
                  </div>
                </form>
                <div className="notes-list">
                  {library.notes
                    .filter((n) => n.shiurId === detail.id)
                    .map((n) => (
                      <article key={n.id}>
                        <button
                          className="note-time"
                          onClick={() => player.start(detail, n.seconds)}
                        >
                          {timeLabel(n.seconds)}
                        </button>
                        <p>{n.text}</p>
                        <button
                          className="icon-button"
                          aria-label="Delete note"
                          onClick={() => {
                            update((old) => ({
                              ...old,
                              notes: old.notes.filter((v) => v.id !== n.id),
                            }));
                            notify('Note deleted.');
                            setUndoAction(() => () => {
                              update((old) => ({
                                ...old,
                                notes: [...old.notes, n],
                              }));
                              notify('Note restored.');
                            });
                          }}
                        >
                          <X size={14} />
                        </button>
                      </article>
                    ))}
                </div>
              </section>
              {player.active?.id === detail.id && (
                <button
                  className="outline-button timestamp-share"
                  onClick={() => void share(detail, player.time)}
                >
                  <Share2 size={16} />
                  Copy link at {timeLabel(player.time)}
                </button>
              )}
              {(detailRelated.length > 0 || relatedLoading || relatedError) && (
                <section className="detail-section detail-related">
                  <h3>Based on this shiur</h3>
                  {relatedLoading && (
                    <p className="feed-loading">
                      <Loader2 className="spin" size={14} />
                      Finding related learning…
                    </p>
                  )}
                  {relatedError && (
                    <p className="feed-notice">
                      Some recommendations could not load.{' '}
                      <button onClick={() => setRelatedRetry((n) => n + 1)}>
                        Try again
                      </button>
                    </p>
                  )}
                  {detailRelated.slice(0, 5).map(({ shiur: s, reason }) => (
                    <button key={s.id} onClick={() => void showDetail(s)}>
                      <span>
                        <strong>{s.title}</strong>
                        <small>
                          {s.teacher} ·{' '}
                          {s.duration
                            ? Math.round(s.duration / 60) + ' min'
                            : s.format}
                        </small>
                        <small className="related-reason">{reason}</small>
                      </span>
                      <ArrowRight size={16} />
                    </button>
                  ))}
                </section>
              )}
              <a
                className="original-shiur-link"
                href={detail.url}
                target="_blank"
                rel="noreferrer"
              >
                View original on YUTorah <ExternalLink size={14} />
              </a>
            </div>
          )}
        </SheetContent>
      </Sheet>
      <Sheet open={queueOpen} onOpenChange={setQueueOpen}>
        <SheetContent className="queue-sheet">
          <SheetHeader>
            <SheetTitle>Your listening queue</SheetTitle>
            <SheetDescription>
              {library.queue.length}{' '}
              {library.queue.length === 1 ? 'shiur' : 'shiurim'} up next
            </SheetDescription>
          </SheetHeader>
          <div className="queue-body">
            {player.active && (
              <div className="now-playing">
                <span className="eyebrow">
                  {player.playing ? 'NOW PLAYING' : 'READY TO PLAY'}
                </span>
                <h3 dir="auto">{player.active.title}</h3>
                <p>{player.active.teacher}</p>
                <button className="text-button" onClick={player.play}>
                  {player.playing ? <Pause size={16} /> : <Play size={16} />}{' '}
                  {player.playing ? 'Pause' : 'Play'}
                </button>
              </div>
            )}
            <div className="queue-speed">
              <span>Playback speed</span>
              <FilterSelect
                label="Queue playback speed"
                value={String(library.speed)}
                onChange={(v) =>
                  update((old) => ({ ...old, speed: Number(v) }))
                }
                options={[0.75, 1, 1.25, 1.5, 1.75, 2].map((v) => ({
                  value: String(v),
                  label: `${v}×`,
                }))}
              />
            </div>
            <div className="sleep-control">
              <Timer size={18} />
              <div>
                <h3>Sleep timer</h3>
                <p>
                  {player.sleepAt
                    ? `Pauses in ${player.sleepRemaining} minutes`
                    : 'Pause playback after a set time'}
                </p>
              </div>
              <FilterSelect
                label="Sleep timer"
                value={player.sleepAt ? String(player.sleepMinutes) : 'all'}
                onChange={(v) => player.setSleep(v === 'all' ? 0 : Number(v))}
                options={[
                  { value: 'all', label: 'Off' },
                  ...[15, 30, 45, 60].map((n) => ({
                    value: String(n),
                    label: `${n} min`,
                  })),
                ]}
              />
            </div>
            {library.queue.length ? (
              <div className="queue-list">
                {library.queue.map((s, index) => (
                  <article key={s.id + '-' + index}>
                    <span>{index + 1}</span>
                    <button
                      className="queue-item-title"
                      onClick={() => {
                        player.start(s);
                        update((old) => ({
                          ...old,
                          queue: old.queue.filter((_, i) => i !== index),
                        }));
                      }}
                    >
                      <strong dir="auto">{s.title}</strong>
                      <small>{s.teacher}</small>
                    </button>
                    <div className="queue-item-actions">
                      <button
                        disabled={index === 0}
                        aria-label="Move earlier"
                        onClick={() =>
                          update((old) => {
                            const queue = [...old.queue];
                            [queue[index - 1], queue[index]] = [
                              queue[index],
                              queue[index - 1],
                            ];
                            return { ...old, queue };
                          })
                        }
                      >
                        <ChevronUp size={16} />
                      </button>
                      <button
                        disabled={index === library.queue.length - 1}
                        aria-label="Move later"
                        onClick={() =>
                          update((old) => {
                            const queue = [...old.queue];
                            [queue[index + 1], queue[index]] = [
                              queue[index],
                              queue[index + 1],
                            ];
                            return { ...old, queue };
                          })
                        }
                      >
                        <ChevronDown size={16} />
                      </button>
                      <button
                        aria-label={'Remove from queue: ' + s.title}
                        onClick={() =>
                          update((old) => ({
                            ...old,
                            queue: old.queue.filter((_, i) => i !== index),
                          }))
                        }
                      >
                        <X size={16} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <StatePanel
                title="What would you like to hear next?"
                description="Use Add to queue on a shiur. Your next recording will play automatically."
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
      <Dialog open={playlistDialog} onOpenChange={setPlaylistDialog}>
        <DialogContent className="playlist-dialog">
          <DialogHeader>
            <DialogTitle>
              {editingPlaylist
                ? 'Rename playlist'
                : playlistTarget
                  ? 'Add to a playlist'
                  : 'Create a playlist'}
            </DialogTitle>
            <DialogDescription>
              {playlistTarget
                ? playlistTarget.title
                : 'Give your collection a name. Playlists are saved on this device.'}
            </DialogDescription>
          </DialogHeader>
          {playlistTarget && library.playlists.length > 0 && (
            <div className="playlist-choices">
              {library.playlists.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    if (p.items.some((s) => s.id === playlistTarget.id)) {
                      notify('This shiur is already in the playlist.');
                      return;
                    }
                    update((old) => ({
                      ...old,
                      playlists: old.playlists.map((v) =>
                        v.id === p.id
                          ? { ...v, items: [...v.items, playlistTarget] }
                          : v,
                      ),
                    }));
                    setPlaylistDialog(false);
                    notify(`Added to ${p.name}.`);
                  }}
                >
                  <ListMusic size={19} />
                  {p.name}
                  <span>
                    {p.items.some((s) => s.id === playlistTarget.id) ? (
                      <Check size={17} />
                    ) : (
                      <Plus size={17} />
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
          <form className="playlist-form" onSubmit={createPlaylist}>
            <label htmlFor="playlist-name">
              {playlistTarget ? 'Or create a new playlist' : 'Playlist name'}
            </label>
            <input
              id="playlist-name"
              placeholder="e.g. On the way to work"
              value={playlistName}
              onChange={(e) => setPlaylistName(e.target.value)}
              maxLength={80}
              required
            />
            <button className="primary-button" disabled={!playlistName.trim()}>
              <Plus size={16} />
              {editingPlaylist ? 'Save name' : 'Create'}
              {playlistTarget ? ' and add shiur' : ''}
            </button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent className="about-dialog">
          <DialogHeader>
            <DialogTitle>About this experience</DialogTitle>
            <DialogDescription>
              A new way to learn from YUTorah.
            </DialogDescription>
          </DialogHeader>
          <p>
            This independent interface connects to YUTorah’s live public
            library. Shiurim, teachers, series, audio, and available source
            sheets come from YUTorah.
          </p>
          <h3>Your learning stays on this device</h3>
          <p>
            Saved shiurim, playlists, notes, and listening progress are stored
            in this browser, along with follows, saved searches, and learning
            goals. They do not sync to your YUTorah account. Clearing your
            browser’s site data removes them.
          </p>
          <button
            className="outline-button"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob(
                  [
                    JSON.stringify(
                      { ...library, exportedAt: new Date().toISOString() },
                      null,
                      2,
                    ),
                  ],
                  { type: 'application/json' },
                ),
              );
              const link = document.createElement('a');
              link.href = url;
              link.download = 'yutorah-learning-backup.json';
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              notify('Your learning backup is ready.');
            }}
          >
            <Download size={16} />
            Export my learning
          </button>
          <h3>A search that goes further</h3>
          <p>
            Search covers YUTorah’s indexed titles, descriptions, keywords,
            topics, teachers, and series. Use a full teacher name or add “under
            20 minutes” and “in Hebrew.” Questions are matched to topics,
            without generated answers or invented transcripts.
          </p>
          <h3>Keyboard shortcuts</h3>
          <div className="keyboard-help">
            <span>Search</span>
            <kbd>⌘ / Ctrl K</kbd>
            <span>Search from anywhere</span>
            <kbd>/</kbd>
            <span>Play or pause</span>
            <kbd>Space</kbd>
          </div>
          <a
            className="text-button"
            href="https://yutorah.org"
            target="_blank"
            rel="noreferrer"
          >
            Visit YUTorah <ExternalLink size={15} />
          </a>
        </DialogContent>
      </Dialog>
      <output
        className={'toast ' + (toast ? 'visible' : '')}
        aria-live="polite"
      >
        {toast && (
          <>
            <Check size={17} />
            {toast}
            {undoAction && (
              <button className="undo-button" onClick={undoAction}>
                Undo
              </button>
            )}
            <button
              aria-label="Dismiss notification"
              onClick={() => setToast('')}
            >
              <X size={15} />
            </button>
          </>
        )}
      </output>
    </SidebarProvider>
  );
}
