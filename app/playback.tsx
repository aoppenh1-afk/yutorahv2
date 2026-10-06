'use client';
import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { useAudio } from '@/lib/library';
import { Player } from './ui';

type Audio = ReturnType<typeof useAudio>;
type State = Pick<
  Audio,
  | 'active'
  | 'playing'
  | 'loading'
  | 'error'
  | 'sleepAt'
  | 'sleepMinutes'
  | 'play'
  | 'start'
  | 'stop'
  | 'seek'
  | 'next'
  | 'setSleep'
>;
type Clock = Pick<Audio, 'time' | 'duration' | 'sleepRemaining'>;
function createPlayback() {
  const empty = () => {};
  let state: State = {
    active: null,
    playing: false,
    loading: false,
    error: '',
    sleepAt: 0,
    sleepMinutes: 0,
    play: empty,
    start: empty,
    stop: empty,
    seek: empty,
    next: empty,
    setSleep: empty,
  };
  let clock: Clock = { time: 0, duration: 0, sleepRemaining: 0 };
  const serverState = state,
    serverClock = clock;
  const listeners = new Set<() => void>(),
    ticks = new Set<() => void>();
  let audio: Audio | undefined;
  // Stable commands always call the mounted owner's latest hook callbacks.
  const controls = {
    play: () => audio?.play(),
    start: (...args: Parameters<Audio['start']>) => audio?.start(...args),
    stop: () => audio?.stop(),
    seek: (seconds: number) => audio?.seek(seconds),
    next: () => audio?.next(),
    setSleep: (minutes: number) => audio?.setSleep(minutes),
  };
  state = { ...state, ...controls };
  return {
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    subscribeClock: (fn: () => void) => {
      ticks.add(fn);
      return () => {
        ticks.delete(fn);
      };
    },
    getState: () => state,
    getClock: () => clock,
    serverState: () => serverState,
    serverClock: () => serverClock,
    publish(value: Audio) {
      audio = value;
      const next = {
        active: value.active,
        playing: value.playing,
        loading: value.loading,
        error: value.error,
        sleepAt: value.sleepAt,
        sleepMinutes: value.sleepMinutes,
        ...controls,
      };
      if (
        Object.keys(next).some(
          (key) => next[key as keyof State] !== state[key as keyof State],
        )
      ) {
        state = next;
        listeners.forEach((fn) => fn());
      }
      if (
        clock.time !== value.time ||
        clock.duration !== value.duration ||
        clock.sleepRemaining !== value.sleepRemaining
      ) {
        clock = {
          time: value.time,
          duration: value.duration,
          sleepRemaining: value.sleepRemaining,
        };
        ticks.forEach((fn) => fn());
      }
    },
  };
}
const PlaybackContext = createContext<ReturnType<typeof createPlayback> | null>(
  null,
);
export function PlaybackProvider({ children }: { children: React.ReactNode }) {
  const [store] = useState(createPlayback);
  return (
    <PlaybackContext.Provider value={store}>
      {children}
    </PlaybackContext.Provider>
  );
}
function usePlaybackStore() {
  const store = useContext(PlaybackContext);
  if (!store) throw new Error('Playback provider is missing.');
  return store;
}
export function useActiveSegment(
  shiurId: number,
  segments: { startMs: number }[],
) {
  const store = useContext(PlaybackContext);
  // Standalone reader previews can render without a player.
  return useSyncExternalStore(
    store
      ? (notify) => {
          const a = store.subscribeClock(notify),
            b = store.subscribe(notify);
          return () => {
            a();
            b();
          };
        }
      : () => () => {},
    () => {
      if (!store || store.getState().active?.id !== shiurId) return -1;
      const time = store.getClock().time * 1000;
      let low = 0,
        high = segments.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (segments[mid].startMs <= time) low = mid + 1;
        else high = mid;
      }
      return low - 1;
    },
    () => -1,
  );
}
export function usePlaybackState() {
  const store = usePlaybackStore();
  return useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.serverState,
  );
}
export function usePlaybackClock() {
  const store = usePlaybackStore();
  return useSyncExternalStore(
    store.subscribeClock,
    store.getClock,
    store.serverClock,
  );
}
export function PlaybackPosition({
  children,
}: {
  children: (clock: Clock) => React.ReactNode;
}) {
  return <>{children(usePlaybackClock())}</>;
}
export function PersistentPlayer({
  library,
  update,
  ready,
  notify,
  ...props
}: Omit<React.ComponentProps<typeof Player>, 'player'> & {
  ready: boolean;
  notify: (text: string) => void;
}) {
  const store = usePlaybackStore();
  const player = useAudio(library, update, ready, notify);
  useLayoutEffect(() => {
    store.publish(player);
  });
  return (
    <Player player={player} library={library} update={update} {...props} />
  );
}
