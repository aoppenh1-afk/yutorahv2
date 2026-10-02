'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import type { Shiur } from './yutorah';
import {
  defaultLearning,
  restoreLearning,
  dayKey,
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
  volume: 1,
  last: null,
};
const key = 'yutorah-learning-v1';
export function readLibrary(): LibraryState {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
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
        ? value.history.filter(
            (v: Progress) =>
              v &&
              valid(v.shiur) &&
              Number.isFinite(v.seconds) &&
              v.seconds >= 0 &&
              Number.isFinite(v.duration) &&
              v.duration >= 0,
          )
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
      speed: [0.75, 1, 1.25, 1.5, 1.75, 2].includes(value.speed)
        ? value.speed
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
export function useLibrary(notify: (text: string) => void) {
  const [library, setLibrary] = useState<LibraryState>(initial);
  const [ready, setReady] = useState(false);
  const libRef = useRef(library);
  const notified = useRef(false);
  useEffect(() => {
    const restored = readLibrary();
    libRef.current = restored;
    setLibrary(restored);
    setReady(true);
  }, []);
  const update = useCallback(
    (fn: (old: LibraryState) => LibraryState) => {
      const next = fn(libRef.current);
      libRef.current = next;
      setLibrary(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        if (!notified.current) {
          notified.current = true;
          notify(
            'Your browser could not save changes. Free some device storage and try again.',
          );
        }
      }
    },
    [notify],
  );
  return { library, update, ready, libRef };
}
export function useAudio(
  library: LibraryState,
  update: (fn: (old: LibraryState) => LibraryState) => void,
  ready: boolean,
  notify: (text: string) => void,
) {
  const audio = useRef<HTMLAudioElement>(null);
  const [active, setActive] = useState<Shiur | null>(null);
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
    if (!playing) return;
    let previous = Date.now();
    const tick = () => {
      const now = Date.now();
      const elapsed = Math.min(10, (now - previous) / 1000);
      previous = now;
      const el = audio.current;
      if (!el || el.readyState < 3 || el.seeking || elapsed < 0.5) return;
      const day = dayKey();
      update((old) => ({
        ...old,
        learningDays: {
          ...old.learningDays,
          [day]: (old.learningDays[day] || 0) + elapsed,
        },
      }));
    };
    const interval = setInterval(tick, 5000);
    return () => {
      clearInterval(interval);
      tick();
    };
  }, [playing, update]);
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
  const persist = useCallback(() => {
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
    update((old) => ({
      ...old,
      last: s,
      history: [p, ...old.history.filter((v) => v.shiur.id !== s.id)].slice(
        0,
        200,
      ),
    }));
  }, [update]);
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
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', save);
    return () => {
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', save);
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
  const handlers = {
    onLoadedMetadata: () => {
      if (!activeRef.current) return;
      const el = audio.current!;
      boundTrack.current = activeRef.current?.id ?? null;
      setDuration(el.duration);
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
      setTime(el.currentTime);
      if (Date.now() - lastSave.current > 5000) {
        lastSave.current = Date.now();
        persist();
      }
    },
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
    onCanPlay: () => setLoading(false),
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
