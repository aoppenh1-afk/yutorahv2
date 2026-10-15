'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import type { Shiur } from './yutorah';
import { performanceCount } from './client-performance';
import { PLAYBACK_SPEEDS } from './playback-speed';
import { useRecordingSource } from './use-recording-source';
import {
  defaultLearning,
  restoreLearning,
  type LearningPreferences,
} from './learning';
export type Progress = {
  shiur: Shiur;
  seconds: number;
  duration: number;
  updatedAt: string;
};
export type Note = {
  shiur?: Shiur;
  id: string;
  shiurId: number;
  seconds: number;
  text: string;
  date: string;
};
export type Playlist = { id: string; name: string; items: Shiur[] };
export type LibraryState = LearningPreferences & {
  saved: Shiur[];
  history: Progress[];
  playlists: Playlist[];
  notes: Note[];
  queue: Shiur[];
  speed: number;
  defaultSpeed: number;
  volume: number;
  last: Shiur | null;
};
const initial: LibraryState = {
  ...defaultLearning,
  saved: [],
  history: [],
  playlists: [],
  notes: [],
  queue: [],
  speed: 1,
  defaultSpeed: 1,
  volume: 1,
  last: null,
};
const key = 'yutorah-learning-v1';
export function readLibrary(): LibraryState {
  try {
    return restoreLibrary(JSON.parse(localStorage.getItem(key) || 'null'));
  } catch {
    return initial;
  }
}
export function restoreLibrary(input: unknown): LibraryState {
  try {
    let value: ReturnType<typeof JSON.parse> = input;
    if (value?.version === 2 && value.recordings) {
      const recordings = value.recordings;
      value = {
        ...value,
        saved: (value.saved || []).map((id: number) => recordings[id]),
        queue: (value.queue || []).map((id: number) => recordings[id]),
        last: recordings[value.last] ?? null,
        history: (value.history || []).map(
          ({
            shiurId,
            ...progress
          }: Omit<Progress, 'shiur'> & { shiurId: number }) => ({
            ...progress,
            shiur: recordings[shiurId],
          }),
        ),
        playlists: (value.playlists || []).map(
          ({
            itemIds,
            ...playlist
          }: Omit<Playlist, 'items'> & { itemIds: number[] }) => ({
            ...playlist,
            items: (itemIds || []).map((id) => recordings[id]),
          }),
        ),
      };
    }
    if (!value || typeof value !== 'object') return initial;
    const valid = (s: Shiur) =>
      s &&
      Number.isFinite(s.id) &&
      typeof s.title === 'string' &&
      Array.isArray(s.topics);
    return {
      ...initial,
      ...restoreLearning(value),
      saved: Array.isArray(value.saved) ? value.saved.filter(valid) : [],
      history: Array.isArray(value.history)
        ? value.history
            .filter(
              (v: Progress) =>
                v &&
                valid(v.shiur) &&
                Number.isFinite(v.seconds) &&
                v.seconds >= 0 &&
                Number.isFinite(v.duration) &&
                v.duration >= 0,
            )
            .slice(0, 200)
        : [],
      playlists: Array.isArray(value.playlists)
        ? value.playlists
            .filter(
              (v: Playlist) =>
                v &&
                typeof v.id === 'string' &&
                typeof v.name === 'string' &&
                Array.isArray(v.items),
            )
            .map((v: Playlist) => ({ ...v, items: v.items.filter(valid) }))
        : [],
      notes: Array.isArray(value.notes)
        ? value.notes.filter(
            (n: Note) =>
              n &&
              typeof n.text === 'string' &&
              Number.isFinite(n.seconds) &&
              Number.isFinite(n.shiurId),
          )
        : [],
      queue: Array.isArray(value.queue) ? value.queue.filter(valid) : [],
      last: valid(value.last) ? value.last : null,
      speed: PLAYBACK_SPEEDS.includes(value.speed) ? value.speed : 1,
      defaultSpeed: PLAYBACK_SPEEDS.includes(value.defaultSpeed ?? value.speed)
        ? (value.defaultSpeed ?? value.speed)
        : 1,
      volume:
        typeof value.volume === 'number' &&
        value.volume >= 0 &&
        value.volume <= 1
          ? value.volume
          : 1,
    };
  } catch {
    return initial;
  }
}
/** Store each recording once; v1 collections migrate on the next successful write. */
export function serializeLibrary(library: LibraryState) {
  const recordings = Object.fromEntries(
    [
      ...library.saved,
      ...library.queue,
      ...library.history.map((h) => h.shiur),
      ...library.playlists.flatMap((p) => p.items),
      ...(library.last ? [library.last] : []),
    ].map((s) => [s.id, s]),
  );
  return JSON.stringify({
    ...library,
    version: 2,
    recordings,
    saved: library.saved.map((s) => s.id),
    queue: library.queue.map((s) => s.id),
    last: library.last?.id ?? null,
    history: library.history.map(({ shiur, ...progress }) => ({
      ...progress,
      shiurId: shiur.id,
    })),
    playlists: library.playlists.map(({ items, ...playlist }) => ({
      ...playlist,
      itemIds: items.map((s) => s.id),
    })),
  });
}
export type LibraryUpdate = (
  fn: (old: LibraryState) => LibraryState,
  mode?: 'progress' | 'immediate' | 'remote' | 'remote-memory',
) => void;
export type LibraryListener = (
  library: LibraryState,
  mode: 'progress' | 'immediate',
) => void;
export type LibrarySubscribe = (listener: LibraryListener) => () => void;
function mergeProgress(
  remote: LibraryState,
  local: LibraryState,
): LibraryState {
  const history = new Map(remote.history.map((h) => [h.shiur.id, h]));
  for (const h of local.history)
    if (
      !history.has(h.shiur.id) ||
      (h.updatedAt || '') > (history.get(h.shiur.id)!.updatedAt || '')
    )
      history.set(h.shiur.id, h);
  const learningDays = { ...remote.learningDays };
  for (const [day, seconds] of Object.entries(local.learningDays))
    learningDays[day] = Math.max(seconds, learningDays[day] ?? 0);
  return {
    ...remote,
    history: [...history.values()]
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      .slice(0, 200),
    learningDays,
  };
}
export function useLibrary(notify: (text: string) => void) {
  const [library, setLibrary] = useState<LibraryState>(initial);
  const [ready, setReady] = useState(false);
  const libRef = useRef(library);
  const notified = useRef(false);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dirty = useRef(false);
  const persistenceBlocked = useRef(false);
  const lastWritten = useRef<string | null>(null);
  const listeners = useRef(new Set<LibraryListener>());
  const subscribe: LibrarySubscribe = useCallback((listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (!dirty.current) return;
    setLibrary(libRef.current);
    if (persistenceBlocked.current) return;
    try {
      const stored = localStorage.getItem(key);
      if (stored !== lastWritten.current)
        libRef.current = mergeProgress(readLibrary(), libRef.current);
      const started = performance.now();
      const serialized = serializeLibrary(libRef.current);
      localStorage.setItem(key, serialized);
      performanceCount('libraryWrites', 1);
      performanceCount('libraryWriteMs', performance.now() - started);
      lastWritten.current = serialized;
      dirty.current = false;
      notified.current = false;
      setLibrary(libRef.current);
    } catch {
      if (!notified.current) {
        notified.current = true;
        // Let the edit's normal success toast finish before surfacing the failure.
        queueMicrotask(() =>
          notifyRef.current(
            'Your browser could not save changes. Free some device storage and try again.',
          ),
        );
      }
    }
  }, []);
  useEffect(() => {
    libRef.current = readLibrary();
    try {
      lastWritten.current = localStorage.getItem(key);
    } catch {
      /* Storage may be disabled. */
    }
    setLibrary(libRef.current);
    setReady(true);
    const storage = (event: StorageEvent) => {
      if (event.key !== key) return;
      const restored = readLibrary();
      libRef.current = dirty.current
        ? mergeProgress(restored, libRef.current)
        : restored;
      lastWritten.current = event.newValue;
      setLibrary(libRef.current);
    };
    const hidden = () => {
      if (document.hidden) flush();
    };
    window.addEventListener('storage', storage);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      flush();
      window.removeEventListener('storage', storage);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [flush]);
  const update: LibraryUpdate = useCallback(
    (fn, mode = 'immediate') => {
      // Read before interactive edits so another tab's saved/following changes
      // cannot be replaced by an older snapshot. Progress stays in memory.
      if (mode === 'immediate') {
        try {
          const stored = localStorage.getItem(key);
          if (stored !== lastWritten.current) {
            libRef.current = mergeProgress(readLibrary(), libRef.current);
            lastWritten.current = stored;
          }
        } catch {
          /* In-memory editing remains usable. */
        }
      }
      const next = fn(libRef.current);
      const old = libRef.current;
      const growsOver = (count: number, previous: number, limit: number) =>
        count > limit && count > previous;
      if (
        mode !== 'remote' &&
        mode !== 'remote-memory' &&
        (growsOver(next.saved.length, old.saved.length, 5000) ||
          growsOver(next.queue.length, old.queue.length, 1000) ||
          growsOver(next.playlists.length, old.playlists.length, 100) ||
          next.playlists.some((p) =>
            growsOver(
              p.items.length,
              old.playlists.find((previous) => previous.id === p.id)?.items
                .length ?? 0,
              5000,
            ),
          ))
      ) {
        notifyRef.current(
          'Library limit reached: 5,000 saved items, 1,000 queued items, and 100 playlists with 5,000 items each.',
        );
        return;
      }
      libRef.current = next;
      dirty.current = true;
      if (mode === 'remote' || mode === 'remote-memory') {
        if (mode === 'remote-memory') persistenceBlocked.current = true;
        // Account replacement must not merge the previous account's progress.
        try {
          lastWritten.current = localStorage.getItem(key);
        } catch {
          /* In memory remains usable. */
        }
      } else {
        for (const listener of listeners.current) listener(next, mode);
      }
      if (mode === 'progress') timer.current ??= setTimeout(flush, 25000);
      else {
        // An interactive retry must report its own failure even after an earlier
        // background flush failed; otherwise its success toast would be misleading.
        notified.current = false;
        flush();
      }
    },
    [flush],
  );
  return { library, update, ready, libRef, flush, subscribe };
}
export function useAudio(
  library: LibraryState,
  update: LibraryUpdate,
  ready: boolean,
  notify: (text: string) => void,
) {
  const audio = useRef<HTMLAudioElement>(null);
  const [active, setActive] = useState<Shiur | null>(null);
  const source = useRecordingSource(active);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState('');
  const [sleepMinutes, setSleepMinutes] = useState(0);
  const boundTrack = useRef<number | null>(null);
  const [sleepAt, setSleepAt] = useState(0);
  const [sleepRemaining, setSleepRemaining] = useState(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const lib = useRef(library);
  lib.current = library;
  const resume = useRef<number | null>(null);
  const wantsPlay = useRef(false);
  const loaded = useRef(false);
  const lastSave = useRef(0);
  useEffect(() => {
    if (ready && !loaded.current) {
      loaded.current = true;
      if (library.last) {
        setActive(library.last);
        resume.current =
          library.history.find((h) => h.shiur.id === library.last?.id)
            ?.seconds || 0;
      }
    }
  }, [ready, library]);
  const persist = useCallback(
    (defer = false) => {
      const el = audio.current,
        s = activeRef.current;
      if (
        !el ||
        !s ||
        boundTrack.current !== s.id ||
        !Number.isFinite(el.duration)
      )
        return;
      const p: Progress = {
        shiur: s,
        seconds: el.currentTime,
        duration: el.duration,
        updatedAt: new Date().toISOString(),
      };
      update(
        (old) => ({
          ...old,
          last: s,
          history: [p, ...old.history.filter((v) => v.shiur.id !== s.id)].slice(
            0,
            200,
          ),
        }),
        defer ? 'progress' : 'immediate',
      );
    },
    [update],
  );
  const start = useCallback(
    (s: Shiur, seconds?: number) => {
      persist();
      setError('');
      resume.current =
        seconds ??
        lib.current.history.find((h) => h.shiur.id === s.id)?.seconds ??
        0;
      resume.current = Number.isFinite(resume.current)
        ? Math.max(0, resume.current)
        : 0;
      const old = lib.current.history.find((h) => h.shiur.id === s.id);
      const restart =
        seconds === undefined &&
        old &&
        old.duration > 0 &&
        old.duration - old.seconds < 15;
      if (restart) resume.current = 0;
      wantsPlay.current = true;
      setLoading(true);
      if (activeRef.current?.id === s.id && audio.current) {
        if (seconds !== undefined || audio.current.ended || restart)
          audio.current.currentTime = Math.min(
            resume.current || 0,
            Number.isFinite(audio.current.duration)
              ? audio.current.duration
              : resume.current || 0,
          );
        resume.current = null;
        wantsPlay.current = false;
        audio.current.play().catch(() => {
          setLoading(false);
          setError('Press play to start listening.');
        });
        return;
      }
      boundTrack.current = null;
      setTime(resume.current || 0);
      setDuration(s.duration);
      setActive(s);
      update((old) => ({
        ...old,
        last: s,
        speed: old.defaultSpeed,
        history: [
          {
            shiur: s,
            seconds: resume.current || 0,
            duration: s.duration,
            updatedAt: new Date().toISOString(),
          },
          ...old.history.filter((h) => h.shiur.id !== s.id),
        ].slice(0, 200),
      }));
    },
    [persist, update],
  );
  const play = useCallback(() => {
    if (!audio.current) return;
    if (audio.current.paused) {
      setError('');
      audio.current
        .play()
        .catch(() =>
          setError(
            'Audio could not start. Try again or open this shiur on YUTorah.',
          ),
        );
    } else {
      audio.current.pause();
      persist();
    }
  }, [persist]);
  const stop = useCallback(() => {
    persist();
    wantsPlay.current = false;
    resume.current = null;
    boundTrack.current = null;
    activeRef.current = null;
    const el = audio.current;
    if (el) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
    setActive(null);
    setPlaying(false);
    setLoading(false);
    setTime(0);
    setDuration(0);
    setError('');
    setSleepAt(0);
    setSleepMinutes(0);
    setSleepRemaining(0);
    update((old) => ({ ...old, last: null }));
  }, [persist, update]);
  const seek = useCallback(
    (seconds: number) => {
      const el = audio.current;
      if (el && Number.isFinite(el.duration)) {
        el.currentTime = Math.max(0, Math.min(el.duration, seconds));
        setTime(el.currentTime);
        persist();
      }
    },
    [persist],
  );
  const next = useCallback(() => {
    const q = lib.current.queue;
    if (q.length) {
      update((old) => ({ ...old, queue: old.queue.slice(1) }));
      start(q[0], 0);
    }
  }, [start, update]);
  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    el.playbackRate = library.speed;
    el.volume = library.volume;
  }, [library.speed, library.volume, active]);
  useEffect(() => {
    if (!sleepAt) return;
    const tick = () => {
      const left = Math.max(0, sleepAt - Date.now());
      setSleepRemaining(Math.ceil(left / 60000));
      if (!left) {
        audio.current?.pause();
        persist();
        setSleepAt(0);
        notify('Sleep timer finished. Playback paused.');
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [sleepAt, persist, notify]);
  useEffect(() => {
    const save = () => persist();
    const hidden = () => {
      if (document.hidden) save();
    };
    // Capture the current position before the library's final dirty-state flush.
    window.addEventListener('pagehide', save, true);
    document.addEventListener('visibilitychange', hidden, true);
    return () => {
      window.removeEventListener('pagehide', save, true);
      document.removeEventListener('visibilitychange', hidden, true);
    };
  }, [persist]);
  useEffect(() => {
    if (!active || !('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: active.title,
      artist: active.teacher,
      album: 'YUTorah',
      artwork: active.image ? [{ src: active.image }] : [],
    });
    const actions: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => audio.current?.play().catch(() => {})],
      [
        'pause',
        () => {
          audio.current?.pause();
          persist();
        },
      ],
      ['seekbackward', () => seek((audio.current?.currentTime || 0) - 15)],
      ['seekforward', () => seek((audio.current?.currentTime || 0) + 15)],
      ['seekto', (e) => seek(e.seekTime || 0)],
      ['nexttrack', next],
      ['stop', stop],
    ];
    actions.forEach(([name, handler]) => {
      try {
        navigator.mediaSession.setActionHandler(name, handler);
      } catch {}
    });
    return () => {
      actions.forEach(([name]) => {
        try {
          navigator.mediaSession.setActionHandler(name, null);
        } catch {}
      });
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    };
  }, [active, next, persist, seek, stop]);
  const finishBuffering = () => {
    const el = audio.current;
    if (!activeRef.current || !el || el.seeking || el.readyState < 3) return;
    setPlaying(!el.paused);
    setLoading(false);
  };
  const handlers = {
    onLoadedMetadata: () => {
      if (!activeRef.current) return;
      const el = audio.current!;
      boundTrack.current = activeRef.current?.id ?? null;
      setDuration(el.duration);
      // Loading an asynchronously resolved source can reset the rate after
      // the track-change effect has already applied the selected speed.
      el.playbackRate = lib.current.speed;
      if (resume.current !== null && Number.isFinite(el.duration)) {
        el.currentTime = Math.min(resume.current, el.duration);
        setTime(el.currentTime);
        resume.current = null;
      }
      if (wantsPlay.current) {
        wantsPlay.current = false;
        el.play().catch(() => {
          setLoading(false);
          setError('Press play to start listening.');
        });
      }
    },
    onTimeUpdate: () => {
      if (!activeRef.current) return;
      const el = audio.current!;
      // WebKit can resume a seek without another canplay or playing event.
      finishBuffering();
      setTime(el.currentTime);
      if (Date.now() - lastSave.current >= 5000) {
        lastSave.current = Date.now();
        persist(true);
      }
    },
    onSeeked: finishBuffering,
    onPlaying: () => {
      if (!activeRef.current) {
        audio.current?.pause();
        return;
      }
      setPlaying(true);
      setLoading(false);
      setError('');
      persist();
    },
    onPause: () => {
      setPlaying(false);
      setLoading(false);
      persist();
    },
    onWaiting: () => {
      if (!activeRef.current) return;
      setLoading(true);
      setPlaying(false);
    },
    onCanPlay: () => {
      setLoading(false);
      // A seek may finish buffering without another playing event in WebKit.
      setPlaying(!audio.current!.paused);
    },
    onError: () => {
      if (!activeRef.current) return;
      setPlaying(false);
      setLoading(false);
      setError(
        'This recording could not be loaded. Retry playback or open the original on YUTorah.',
      );
    },
    onEnded: () => {
      if (!activeRef.current) return;
      setPlaying(false);
      persist();
      const id = activeRef.current?.id;
      if (id)
        update((old) => ({
          ...old,
          completed: [...new Set([...old.completed, id])],
        }));
      next();
    },
  };
  return {
    audio,
    source,
    active,
    playing,
    loading,
    time,
    duration,
    error,
    play,
    stop,
    start,
    seek,
    next,
    handlers,
    sleepAt,
    sleepMinutes,
    sleepRemaining,
    setSleep: (minutes: number) => {
      setSleepMinutes(minutes);
      setSleepAt(minutes ? Date.now() + minutes * 60000 : 0);
    },
  };
}
export function timeLabel(seconds: number) {
  const n = Math.max(0, Math.floor(seconds || 0));
  return n >= 3600
    ? `${Math.floor(n / 3600)}:${String(Math.floor((n % 3600) / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
    : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}
