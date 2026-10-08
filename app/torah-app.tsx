/* oxlint-disable next/no-img-element -- Teacher photos and series covers stream from YUTorah’s CDN. */
/* oxlint-disable jsx-a11y/media-has-caption -- YUTorah provides no caption tracks for these recordings; never invent captions. */
'use client';
import { pollDelay } from '@/lib/poll-delay';
import Link from 'next/link';
import { type Filters, noFilters } from '@/lib/search-filters';
import { SearchBox } from './search-box';
import { SearchTools } from './search-tools';
import { MobileSearchSummary } from './mobile-search-summary';
import type { TranscriptHit } from './transcript-search';
import { ScreenBoundary } from './screen-boundary';
import {
  PlaybackProvider,
  PersistentPlayer,
  PlaybackPosition,
  usePlaybackState,
} from './playback';
import { PagedItems } from './paged-items';
import { useViewPerformance } from './performance-monitor';
import { FollowButton } from './follow-button';
import { ThemeToggle } from './theme-toggle';
import { isLearned, relatedShiurim, type Follow } from '@/lib/learning';
import { createRelevanceScorer } from '@/lib/search-discovery';
import { prepareSearchText, createQueryMatcher } from '@/lib/search-matching';
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  useDeferredValue,
  lazy,
} from 'react';
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
  ChevronUp,
  ChevronDown,
  Check,
  Timer,
  LayoutGrid,
  List,
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
import { Avatar, FilterSelect, ShiurCard, ShiurRow, StatePanel } from './ui';
import { useLibrary, timeLabel } from '@/lib/library';
import { useIsMobile } from '@/hooks/use-mobile';
import type { HomeData, Shiur, Directory, SearchResult } from '@/lib/yutorah';
import { mediaKind, normalize } from '@/lib/yutorah';
const AdvancedSearch = lazy(() =>
  import('./advanced-search').then((m) => ({ default: m.AdvancedSearch })),
);
const TranscriptSearch = lazy(() =>
  import('./transcript-search').then((m) => ({ default: m.TranscriptSearch })),
);
const TranscriptReader = lazy(() =>
  import('./transcript-reader').then((m) => ({ default: m.TranscriptReader })),
);
const loadSecondaryScreens = () => import('./secondary-screens');
const SecondaryScreens = lazy(() =>
  loadSecondaryScreens().then((m) => ({ default: m.SecondaryScreens })),
);
const LearningHome = lazy(() =>
  import('./learning-home').then((m) => ({ default: m.LearningHome })),
);

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
const labels: Record<View, string> = {
  discover: 'Discover',
  trending: 'Trending',
  following: 'Following',
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
function SearchOptions({
  collapsed,
  label,
  children,
}: {
  collapsed: boolean;
  label: string;
  children: React.ReactNode;
}) {
  if (!collapsed) return <>{children}</>;
  return (
    <details className="mobile-search-options">
      <summary>
        <SlidersHorizontal size={18} />
        <span>{label}</span>
        <ChevronDown size={16} />
      </summary>
      <div className="mobile-search-options-body">{children}</div>
    </details>
  );
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
        onPointerEnter={() => {
          if (
            [
              labels.teachers,
              labels.series,
              labels.topics,
              labels.saved,
              labels.history,
              labels.playlists,
            ].includes(label)
          )
            void loadSecondaryScreens().catch(() => {});
        }}
        onFocus={() => {
          if (
            [
              labels.teachers,
              labels.series,
              labels.topics,
              labels.saved,
              labels.history,
              labels.playlists,
            ].includes(label)
          )
            void loadSecondaryScreens().catch(() => {});
        }}
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
export default function TorahApp(props: { initialHome: HomeData | null }) {
  return (
    <PlaybackProvider>
      <TorahAppBody {...props} />
    </PlaybackProvider>
  );
}
function TorahAppBody({ initialHome }: { initialHome: HomeData | null }) {
  useViewPerformance();
  const isMobile = useIsMobile();
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
  const [toast, setToast] = useState('');
  const [help, setHelp] = useState(false);

  const searchAbort = useRef<AbortController | null>(null);
  const detailAbort = useRef<AbortController | null>(null);
  const initialized = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback(
    (text: string) => {
      setToast(text);
      setUndoAction(null);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(
        () => {
          setToast('');
          setUndoAction(null);
        },
        isMobile && text.length < 120 ? 4000 : 6500,
      );
    },
    [isMobile],
  );
  const { library, update, ready } = useLibrary(notify);
  const player = usePlaybackState();
  const {
    active: activeShiur,
    play: togglePlayback,
    start: startPlayback,
  } = player;
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
  const hasHome = !!home;
  const homeNotify = useRef(notify);
  homeNotify.current = notify;
  useEffect(() => {
    if (hasHome || !['discover', 'following', 'trending'].includes(view))
      return;
    const controller = new AbortController();
    setHomeLoading(true);
    requestJson<HomeData>('/api/home', controller.signal)
      .then(setHome)
      .catch(() => {
        if (!controller.signal.aborted)
          homeNotify.current(
            'The homepage could not load. Search and your library are available.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setHomeLoading(false);
      });
    return () => controller.abort();
  }, [hasHome, view]);
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
          await pollDelay(result.retryAfterMs || 1500, controller.signal);
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
  const showDetail = useCallback(
    async (s: Shiur, loaded = false, pending?: AbortController) => {
      if (!pending || detailAbort.current !== pending)
        detailAbort.current?.abort();
      const controller = pending ?? new AbortController();
      if (controller.signal.aborted) return;
      detailAbort.current = controller;
      setDetail(s);
      setDetailError('');
      setDetailLoading(!loaded);
      if (loaded) return;
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
    },
    [],
  );
  const openById = useCallback(
    async (id: string, seconds?: number, autoplay = false) => {
      detailAbort.current?.abort();
      const controller = new AbortController();
      detailAbort.current = controller;
      try {
        const s = await requestJson<Shiur>(
          '/api/shiur?id=' + id,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        await showDetail(s, true, controller);
        if (autoplay) startPlayback(s, seconds);
        if (seconds !== undefined)
          notify(
            `Shared position: ${timeLabel(seconds)}. Press play to listen.`,
          );
      } catch (e) {
        if (!controller.signal.aborted)
          notify(e instanceof Error ? e.message : 'Shiur not found.');
      }
    },
    [showDetail, notify, startPlayback],
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
        activeShiur &&
        target.tagName !== 'BUTTON'
      ) {
        e.preventDefault();
        togglePlayback();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate, activeShiur, togglePlayback]);
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
      void openById(hit.shiurId, seconds, true);
    }
  };
  const filterChange = (key: keyof Filters, value: string) =>
    void runSearch(submitted, {
      ...filters,
      [key]: value === 'all' ? '' : value,
    });
  const toggleLearned = (s: Shiur) => {
    const learned = learnedIds.has(s.id);
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
    notify(learned ? 'Marked as not learned.' : 'Marked as learned.');
  };
  const rows = (items: Shiur[], history = false) => (
    <PagedItems key={view + withinResults + libraryQuery} items={items}>
      {(visible) =>
        visible.map((s) => (
          <ShiurRow
            key={s.id}
            shiur={s}
            query={view === 'search' ? results?.plan.term : undefined}
            onPlay={play}
            onDetails={showDetail}
            onSave={save}
            onQueue={enqueue}
            onPlaylist={() => addToPlaylist(s)}
            onLearned={() => toggleLearned(s)}
            active={player.active?.id === s.id && player.playing}
            saved={savedIds.has(s.id)}
            learned={learnedIds.has(s.id)}
            progress={history ? historyById.get(s.id) : undefined}
            extra={
              <>
                <button
                  className="icon-button learned-action"
                  aria-label={
                    (learnedIds.has(s.id)
                      ? 'Mark as not learned: '
                      : 'Mark as learned: ') + s.title
                  }
                  aria-pressed={learnedIds.has(s.id)}
                  onClick={() => toggleLearned(s)}
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
        ))
      }
    </PagedItems>
  );
  const cards = (items: Shiur[]) => (
    <PagedItems key={view + withinResults + libraryQuery} items={items}>
      {(visible) =>
        visible.map((s, i) => (
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
        ))
      }
    </PagedItems>
  );
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
      onSelectShiur={(suggestion) =>
        void showDetail(
          normalize({ shiurID: suggestion.id, shiurTitle: suggestion.name }),
        )
      }
    />
  );
  const deferredWithin = useDeferredValue(withinResults);
  const deferredDirectory = useDeferredValue(directoryQuery);
  const deferredLibrary = useDeferredValue(libraryQuery);
  const resultMatcher = useMemo(
    () => createQueryMatcher(deferredWithin),
    [deferredWithin],
  );
  const directoryMatcher = useMemo(
    () => createQueryMatcher(deferredDirectory, 2),
    [deferredDirectory],
  );
  const libraryMatcher = useMemo(
    () => createQueryMatcher(deferredLibrary),
    [deferredLibrary],
  );
  const preparedResults = useMemo(
    () =>
      new Map(
        (results?.items ?? []).map((s) => [
          s.id,
          prepareSearchText(
            [s.title, s.teacher, s.description, s.series, ...s.topics].join(
              ' ',
            ),
          ),
        ]),
      ),
    [results?.items],
  );
  const preparedDirectory = useMemo(
    () => ({
      teachers: new Map(
        (directory?.teachers ?? []).map((t) => [
          t.id,
          prepareSearchText(t.name),
        ]),
      ),
      series: new Map(
        (directory?.series ?? []).map((t) => [
          t.id,
          prepareSearchText(t.name + ' ' + t.description),
        ]),
      ),
      topics: new Map(
        (directory?.topics ?? []).map((t) => [
          t.id,
          prepareSearchText(t.name + ' ' + t.group),
        ]),
      ),
    }),
    [directory],
  );
  const preparedLibrary = useMemo(
    () =>
      new Map(
        [
          ...library.saved,
          ...library.history.map((h) => h.shiur),
          ...library.playlists.flatMap((p) => p.items),
        ].map((s) => [
          s.id,
          prepareSearchText(s.title + ' ' + s.teacher + ' ' + s.series),
        ]),
      ),
    [library.saved, library.history, library.playlists],
  );
  const historyById = useMemo(
    () => new Map(library.history.map((h) => [h.shiur.id, h])),
    [library.history],
  );
  const learnedIds = useMemo(
    () =>
      new Set([
        ...library.completed,
        ...library.history
          .filter((h) => h.duration > 0 && h.seconds / h.duration >= 0.95)
          .map((h) => h.shiur.id),
      ]),
    [library.completed, library.history],
  );
  const orderedResults = useMemo(() => {
    const items = [...(results?.items || [])];
    if (results?.complete !== undefined) return items;
    if (resultOrder === 'relevance') {
      const score = createRelevanceScorer(results?.plan.term || '');
      const scores = new Map(items.map((item) => [item.id, score(item)]));
      items.sort((a, b) => scores.get(b.id)! - scores.get(a.id)!);
    }
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
  const visibleResults = useMemo(
    () =>
      orderedResults.filter((s) => {
        if (learningFilter === 'unlearned' && learnedIds.has(s.id))
          return false;
        if (learningFilter === 'saved' && !savedIds.has(s.id)) return false;
        return resultMatcher(preparedResults.get(s.id)!);
      }),
    [
      orderedResults,
      learningFilter,
      learnedIds,
      savedIds,
      resultMatcher,
      preparedResults,
    ],
  );
  const loadedItems = useMemo(
    () => [
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
    ],
    [home, results, library.saved, library.history],
  );
  const detailRelated = useMemo(
    () =>
      detail
        ? relatedShiurim(
            detail,
            [...relatedCandidates, ...loadedItems],
            library,
          )
        : [],
    [detail, relatedCandidates, loadedItems, library],
  );
  const matchLibrary = (s: Shiur) =>
    libraryMatcher(
      preparedLibrary.get(s.id) ??
        prepareSearchText(s.title + ' ' + s.teacher + ' ' + s.series),
    );
  const listedTeachers = useMemo(
    () =>
      view === 'teachers'
        ? directory?.teachers.filter((t) =>
            directoryMatcher(preparedDirectory.teachers.get(t.id)!),
          ) || []
        : [],
    [directory, directoryMatcher, preparedDirectory, view],
  );
  const listedSeries = useMemo(
    () =>
      view === 'series'
        ? directory?.series.filter((s) =>
            directoryMatcher(preparedDirectory.series.get(s.id)!),
          ) || []
        : [],
    [directory, directoryMatcher, preparedDirectory, view],
  );
  const listedTopics = useMemo(
    () =>
      view === 'topics'
        ? directory?.topics.filter(
            (t) =>
              (topicGroup === 'all' || t.group === topicGroup) &&
              directoryMatcher(preparedDirectory.topics.get(t.id)!),
          ) || []
        : [],
    [directory, directoryMatcher, preparedDirectory, topicGroup, view],
  );
  const videoSource =
    detail?.video ||
    (['youtube', 'video', 'mp4'].includes(detail?.format || '')
      ? detail?.audio
      : '');
  const youtubeId = videoSource?.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([\w-]{11})/,
  )?.[1];
  const playlist = library.playlists.find((p) => p.id === selectedPlaylist);
  const resultViewControls = (
    <div className="result-view-controls">
      <FilterSelect
        label="Sort all results"
        value={resultOrder}
        onChange={(sort) => void runSearch(submitted, { ...filters, sort })}
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
  );
  return (
    <SidebarProvider
      style={{ '--sidebar-width': '256px' } as React.CSSProperties}
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
            <img
              src="/images/yutorah-wordmark.png"
              width={298}
              height={69}
              alt="The Marcos and Adina Katz YUTorah Online. A project of Yeshiva University–RIETS."
            />
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
            {
              icon: Compass,
              view: 'discover',
              label: 'Home',
              active: view === 'discover' || view === 'trending',
            },
            {
              icon: Search,
              view: 'search',
              label: 'Search',
              active: view === 'search',
            },
            {
              icon: LayoutGrid,
              view: 'topics',
              label: 'Browse',
              active: ['topics', 'teachers', 'series'].includes(view),
            },
            {
              icon: Users,
              view: 'following',
              label: 'Following',
              active: view === 'following',
            },
            {
              icon: Library,
              view: 'saved',
              label: 'Library',
              active: ['saved', 'history', 'playlists'].includes(view),
            },
          ] as const
        ).map((item) => (
          <button
            key={item.view}
            aria-current={item.active ? 'page' : undefined}
            onClick={() => navigate(item.view)}
          >
            <span className="mobile-nav-icon">
              <item.icon size={21} />
            </span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className={'app-body ' + (player.active ? 'has-player' : '')}>
        <header className="topbar">
          <div className="breadcrumb">
            <SidebarTrigger
              className="mobile-toggle"
              aria-label="Open all navigation"
            />
            <button
              className="header-home"
              onClick={() => navigate('discover')}
            >
              <span className="desktop-home-label">Your learning</span>
              <span className="mobile-home-label">
                <img
                  src="/images/yutorah-wordmark.png"
                  width={298}
                  height={69}
                  alt="The Marcos and Adina Katz YUTorah Online. A project of Yeshiva University–RIETS."
                />
              </span>
            </button>
            <ChevronRight size={14} />
            <b>{labels[view]}</b>
          </div>
          {view !== 'search' && !isMobile && (
            <div className="header-search">{searchBar}</div>
          )}
          <div className="header-right">
            <ThemeToggle />
            <button
              className="mobile-header-search"
              aria-label="Search the library"
              onClick={() => navigate('search')}
            >
              <Search size={21} />
            </button>
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
          {['saved', 'history', 'playlists'].includes(view) && (
            <div className="mobile-library-heading">
              <h1>Your library</h1>
              <p>
                {library.saved.length} saved · {library.playlists.length}{' '}
                playlists · On this device
              </p>
            </div>
          )}
          {['topics', 'teachers', 'series'].includes(view) && (
            <nav className="mobile-view-tabs" aria-label="Browse the library">
              {(['topics', 'teachers', 'series'] as const).map(
                (destination) => (
                  <button
                    key={destination}
                    aria-current={view === destination ? 'page' : undefined}
                    onClick={() => navigate(destination)}
                  >
                    {labels[destination]}
                  </button>
                ),
              )}
            </nav>
          )}
          {['saved', 'history', 'playlists'].includes(view) && (
            <nav className="mobile-view-tabs" aria-label="Your library">
              {(['saved', 'history', 'playlists'] as const).map(
                (destination) => (
                  <button
                    key={destination}
                    aria-current={view === destination ? 'page' : undefined}
                    onClick={() => navigate(destination)}
                  >
                    {destination === 'saved'
                      ? 'Saved'
                      : destination === 'history'
                        ? 'History'
                        : 'Playlists'}
                  </button>
                ),
              )}
            </nav>
          )}
          {(view === 'discover' ||
            view === 'following' ||
            view === 'trending') && (
            <ScreenBoundary>
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
            </ScreenBoundary>
          )}
          {view === 'search' && (
            <section
              className={'search-view ' + (results ? 'has-results' : '')}
            >
              <div className="view-heading">
                <div className="eyebrow">THE YUTORAH LIBRARY</div>
                <h1>Search the library</h1>
                <p>Find shiurim by topic, teacher, title or source.</p>
              </div>
              {searchBar}
              <SearchOptions
                collapsed={isMobile}
                label="Filters & search tools"
              >
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
                {isMobile ? (
                  <details className="mobile-transcript-disclosure">
                    <summary>
                      <FileText size={18} />
                      <span>Search inside the audio</span>
                      <ChevronDown size={16} />
                    </summary>
                    <ScreenBoundary>
                      <TranscriptSearch
                        query={results?.plan.term ?? submitted}
                        onSelect={openTranscriptHit}
                      />
                    </ScreenBoundary>
                  </details>
                ) : (
                  <ScreenBoundary>
                    <TranscriptSearch
                      query={results?.plan.term ?? submitted}
                      onSelect={openTranscriptHit}
                    />
                  </ScreenBoundary>
                )}
                <div className="filter-bar">
                  <button
                    className="filter-toggle"
                    aria-expanded={advancedFilters}
                    aria-controls="advanced-search-filters"
                    onPointerEnter={() => {
                      void import('./advanced-search').catch(() => {});
                    }}
                    onFocus={() => {
                      void import('./advanced-search').catch(() => {});
                    }}
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
                  <ScreenBoundary>
                    <AdvancedSearch
                      key={JSON.stringify(filters)}
                      filters={filters}
                      directory={directory}
                      loading={searchLoading}
                      onApply={(next) => void runSearch(q, next)}
                    />
                  </ScreenBoundary>
                )}
              </SearchOptions>
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
                    {isMobile ? (
                      <MobileSearchSummary
                        result={results}
                        searching={searchLoading}
                        onToggle={() => {
                          if (searchLoading) {
                            searchAbort.current?.abort();
                            setSearchLoading(false);
                          } else void runSearch(submitted, filters);
                        }}
                      />
                    ) : (
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
                              {searchLoading
                                ? 'Pause search'
                                : 'Continue search'}
                            </button>
                          </div>
                        )}
                        {results.filtered && (
                          <p>
                            Filtered from {results.total.toLocaleString()}{' '}
                            library matches.{' '}
                            {results.nextPage
                              ? 'Load more to continue.'
                              : 'All matches checked.'}
                          </p>
                        )}
                      </div>
                    )}
                    {!isMobile && resultViewControls}
                  </div>
                  <SearchOptions
                    collapsed={isMobile}
                    label={
                      'Sort & refine results' +
                      (withinResults || learningFilter !== 'all'
                        ? ` · ${visibleResults.length} shown`
                        : '')
                    }
                  >
                    {isMobile && resultViewControls}
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
                                  [...old.queue, ...audio].map((s) => [
                                    s.id,
                                    s,
                                  ]),
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
                  </SearchOptions>
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
              {!results &&
                !searchLoading &&
                !searchError &&
                (isMobile ? (
                  <section
                    className="mobile-search-browse"
                    aria-label="Browse the library"
                  >
                    <h2>Browse the library</h2>
                    {[
                      {
                        view: 'topics' as const,
                        icon: LayoutGrid,
                        label: 'Topics',
                        detail: 'Torah texts and areas of study',
                      },
                      {
                        view: 'teachers' as const,
                        icon: Users,
                        label: 'Teachers',
                        detail: 'Torah educators and their shiurim',
                      },
                      {
                        view: 'series' as const,
                        icon: BookOpen,
                        label: 'Series',
                        detail: 'Courses and ongoing learning',
                      },
                    ].map(
                      ({ view: destination, icon: Icon, label, detail }) => (
                        <button
                          key={destination}
                          onClick={() => navigate(destination)}
                        >
                          <Icon size={21} />
                          <span>
                            <strong>{label}</strong>
                            <small>{detail}</small>
                          </span>
                          <ChevronRight size={17} />
                        </button>
                      ),
                    )}
                  </section>
                ) : (
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
                ))}
            </section>
          )}
          {[
            'teachers',
            'series',
            'topics',
            'saved',
            'history',
            'playlists',
          ].includes(view) && (
            <ScreenBoundary>
              <SecondaryScreens
                view={view}
                directory={directory}
                directoryQuery={directoryQuery}
                setDirectoryQuery={setDirectoryQuery}
                topicGroup={topicGroup}
                setTopicGroup={setTopicGroup}
                directoryError={directoryError}
                loadDirectory={loadDirectory}
                listedTeachers={listedTeachers}
                listedSeries={listedSeries}
                listedTopics={listedTopics}
                directoryLimit={directoryLimit}
                setDirectoryLimit={setDirectoryLimit}
                runSearch={runSearch}
                library={library}
                follow={follow}
                ready={ready}
                playlist={playlist}
                libraryQuery={libraryQuery}
                setLibraryQuery={setLibraryQuery}
                rows={rows}
                matchLibrary={matchLibrary}
                player={player}
                update={update}
                notify={notify}
                navigate={navigate}
                setSelectedPlaylist={setSelectedPlaylist}
                setEditingPlaylist={setEditingPlaylist}
                setPlaylistName={setPlaylistName}
                setPlaylistTarget={setPlaylistTarget}
                setPlaylistDialog={setPlaylistDialog}
                setUndoAction={setUndoAction}
                play={play}
                showDetail={showDetail}
                save={save}
                enqueue={enqueue}
                savedIds={savedIds}
              />
            </ScreenBoundary>
          )}
          <footer className="page-footer">
            <span>
              {home ? `${home.total.toLocaleString()} shiurim. ` : ''}One shared
              tradition.
            </span>
            <div>
              <button onClick={() => setHelp(true)}>About the library</button>
              <span>Audio and teaching © YUTorah</span>
            </div>
          </footer>
        </main>
        <PersistentPlayer
          ready={ready}
          notify={notify}
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
        <SheetContent
          className="detail-sheet"
          side={isMobile ? 'bottom' : 'right'}
        >
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
              <ScreenBoundary>
                <TranscriptReader
                  shiurId={detail.id}
                  onSeek={(seconds) => player.start(detail, seconds)}
                />
              </ScreenBoundary>
              {player.active?.id === detail.id && (
                <PlaybackPosition>
                  {(clock) => (
                    <button
                      className="outline-button timestamp-share"
                      onClick={() => void share(detail, clock.time)}
                    >
                      <Share2 size={16} />
                      Copy link at {timeLabel(clock.time)}
                    </button>
                  )}
                </PlaybackPosition>
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
        <SheetContent
          className="queue-sheet"
          side={isMobile ? 'bottom' : 'right'}
        >
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
                  {player.sleepAt ? (
                    <PlaybackPosition>
                      {(clock) => `Pauses in ${clock.sleepRemaining} minutes`}
                    </PlaybackPosition>
                  ) : (
                    'Pause playback after a set time'
                  )}
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
            <DialogTitle>About the library</DialogTitle>
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
            Saved shiurim, playlists, and listening progress are stored in this
            browser, along with follows, saved searches, and learning goals.
            They do not sync to your YUTorah account. Clearing your browser’s
            site data removes them.
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
