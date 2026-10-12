'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import type { Follow } from './learning';
import type { LibraryState, LibraryUpdate, LibrarySubscribe } from './library';
import { useLibraryAccount } from './use-library-account';
import { libraryOwnerKey } from './account-library';
import { getAccountClient } from './account-client';
import {
  followsToImport,
  mergeTeacherFollows,
  type FollowIntents,
  type RemoteFollow,
} from './account-follows';
import { accountConfig } from './account-config';

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  localStorage.setItem(key, value);
}
const pendingKey = (id: string) => 'yutorah-follow-changes-' + id;
function readPending(id: string): FollowIntents {
  try {
    const value = JSON.parse(read(pendingKey(id)) ?? '{}');
    return Object.fromEntries(
      Object.entries(value).filter(([, v]) => {
        const intent = v as FollowIntents[string];
        return (
          intent?.follow?.kind === 'teacher' &&
          Number.isSafeInteger(intent.follow.id) &&
          intent.follow.id > 0 &&
          typeof intent.follow.name === 'string' &&
          (intent.follow.notificationsEnabled === undefined ||
            typeof intent.follow.notificationsEnabled === 'boolean') &&
          typeof intent.following === 'boolean' &&
          typeof intent.operation === 'string'
        );
      }),
    ) as FollowIntents;
  } catch {
    return {};
  }
}
export function notificationSupport() {
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (ios && !standalone) return 'iphone-install';
  if (
    !window.isSecureContext ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window)
  )
    return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  return 'supported';
}
function applicationKey(value: string) {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
async function registration() {
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

export function useAccount(
  library: LibraryState,
  update: LibraryUpdate,
  ready: boolean,
  subscribe: LibrarySubscribe,
) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [notificationError, setNotificationError] = useState('');
  const [support, setSupport] = useState('unsupported');
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const cloudLibrary = useLibraryAccount(
    user?.id,
    library,
    update,
    ready,
    subscribe,
  );
  const current = useRef({ library, update });
  current.current = { library, update };
  const userRef = useRef<User | null>(null);
  const intents = useRef<FollowIntents>({});
  const generation = useRef(0);
  const running = useRef<Promise<void> | null>(null);
  const refreshAgain = useRef(false);
  const savePending = useCallback((id: string) => {
    write(pendingKey(id), JSON.stringify(intents.current));
    setPendingCount(Object.keys(intents.current).length);
  }, []);
  const refresh = useCallback(async (): Promise<void> => {
    const active = userRef.current;
    if (!active) return;
    if (running.current) return running.current;
    const gen = generation.current;
    refreshAgain.current = false;
    const isCurrent = () =>
      generation.current === gen && userRef.current?.id === active.id;
    const work = (async () => {
      setSyncing(true);
      try {
        const db = (await getAccountClient()).forUser(active.id);
        const load = async () => {
          const { data, error } = await db
            .from('teacher_follows')
            .select(
              'teacher_id,teacher_name,image,following,notifications_enabled',
            )
            .eq('user_id', active.id);
          if (error) throw error;
          return data as RemoteFollow[];
        };
        let remote = await load();
        if (!isCurrent()) return;
        const migrationKey = 'yutorah-follows-imported-' + active.id;
        if (!read(migrationKey)) {
          for (const follow of followsToImport(
            current.current.library.following,
            remote,
            read('yutorah-account-owner'),
            active.id,
          )) {
            intents.current[follow.id] ??= {
              follow,
              following: true,
              operation: crypto.randomUUID(),
            };
          }
          // Save the outbox before marking the import complete.
          savePending(active.id);
          write(migrationKey, 'true');
        }
        write('yutorah-account-owner', active.id);
        current.current.update(
          (old) => ({
            ...old,
            following: mergeTeacherFollows(
              old.following,
              remote,
              intents.current,
            ),
          }),
          'remote',
        );
        while (isCurrent() && Object.keys(intents.current).length) {
          const [id, intent] = Object.entries(intents.current)[0];
          const { error } = await db.rpc('set_teacher_follow', {
            p_teacher_id: intent.follow.id,
            p_teacher_name: intent.follow.name.slice(0, 200),
            p_image: intent.follow.image ?? null,
            p_following: intent.following,
            p_notifications_enabled: intent.follow.notificationsEnabled ?? null,
          });
          if (error) throw error;
          if (!isCurrent()) return;
          if (intents.current[id]?.operation === intent.operation)
            delete intents.current[id];
          savePending(active.id);
        }
        remote = await load();
        if (!isCurrent()) return;
        current.current.update(
          (old) => ({
            ...old,
            following: mergeTeacherFollows(
              old.following,
              remote,
              intents.current,
            ),
          }),
          'remote',
        );
        setError('');
        if (notificationSupport() === 'supported') {
          const reg = await registration();
          const sub = await reg.pushManager.getSubscription();
          if (sub) {
            const { data, error: deviceError } = await db
              .from('push_subscriptions')
              .select('id')
              .eq('user_id', active.id)
              .eq('endpoint', sub.endpoint)
              .maybeSingle();
            if (deviceError) throw deviceError;
            if (isCurrent()) setSubscriptionId(data?.id ?? null);
          } else if (isCurrent()) setSubscriptionId(null);
        }
      } catch (e) {
        if (isCurrent())
          setError(
            e instanceof Error
              ? e.message
              : 'Your teacher follows could not sync. Please retry.',
          );
      } finally {
        if (isCurrent()) setSyncing(false);
      }
    })();
    running.current = work;
    try {
      await work;
    } finally {
      if (running.current === work) {
        running.current = null;
        // A follow can change while the final cloud read is in flight.
        if (isCurrent() && refreshAgain.current) void refresh();
      }
    }
  }, [savePending]);

  useEffect(() => {
    if (!ready) return;
    let mounted = true;
    let unsubscribe: (() => void) | undefined;
    setSupport(notificationSupport());
    const applyUser = (next: User | null) => {
      if (!mounted) return;
      if (userRef.current?.id === next?.id) return;
      // Preserve legacy ownership before the teacher sync changes its marker.
      if (!read(libraryOwnerKey) && read('yutorah-account-owner'))
        try {
          write(libraryOwnerKey, read('yutorah-account-owner')!);
        } catch {
          /* Library sync reports storage failures. */
        }
      generation.current++;
      running.current = null;
      refreshAgain.current = false;
      userRef.current = next;
      intents.current = next ? readPending(next.id) : {};
      setUser(next);
      setSubscriptionId(null);
      setError('');
      setSyncing(false);
      setPendingCount(Object.keys(intents.current).length);
      if (
        next &&
        read('yutorah-account-owner') &&
        read('yutorah-account-owner') !== next.id
      )
        current.current.update(
          (old) => ({
            ...old,
            following: old.following.filter((f) => f.kind !== 'teacher'),
          }),
          'remote',
        );
      if (next) void refresh();
    };
    let started = false;
    const initialize = () => {
      if (started) return;
      started = true;
      void getAccountClient()
        .then(async (db) => {
          if (!mounted) return;
          const { data } = db.auth.onAuthStateChange((_event, session) =>
            queueMicrotask(() => applyUser(session?.user ?? null)),
          );
          unsubscribe = () => data.subscription.unsubscribe();
          const { data: session, error } = await db.auth.getSession();
          if (!mounted) return;
          if (error) setError(error.message);
          applyUser(session.session?.user ?? null);
          setLoading(false);
        })
        .catch(() => {
          if (mounted) {
            setLoading(false);
            setError('Sign-in could not load. Please reload.');
          }
        });
    };
    const authStorageKey =
      'sb-' + new URL(accountConfig.url).hostname.split('.')[0] + '-auth-token';
    if (read(authStorageKey)) initialize();
    else setLoading(false);
    const visible = () => {
      if (!document.hidden) {
        setSupport(notificationSupport());
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', visible);
    window.addEventListener('focus', visible);
    const storage = (event: StorageEvent) => {
      if (event.key === authStorageKey && event.newValue) initialize();
      if (event.key === pendingKey(userRef.current?.id ?? '')) {
        // The durable outbox includes acknowledgements from other tabs.
        intents.current = readPending(userRef.current!.id);
        setPendingCount(Object.keys(intents.current).length);
        if (running.current) refreshAgain.current = true;
        void refresh();
      }
    };
    window.addEventListener('storage', storage);
    return () => {
      mounted = false;
      // Controller refs invalidate asynchronous work on unmount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      userRef.current = null;
      unsubscribe?.();
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('online', visible);
      window.removeEventListener('focus', visible);
      window.removeEventListener('storage', storage);
    };
  }, [ready, refresh]);

  const changedFollow = useCallback(
    (follow: Follow, following: boolean) => {
      const active = userRef.current;
      if (!active || follow.kind !== 'teacher') return;
      intents.current = { ...intents.current, ...readPending(active.id) };
      intents.current[follow.id] = {
        follow,
        following,
        operation: crypto.randomUUID(),
      };
      try {
        savePending(active.id);
      } catch {
        setError(
          'Your browser could not save the pending follow change. Keep this page open and retry.',
        );
      }
      if (running.current) refreshAgain.current = true;
      void refresh();
    },
    [refresh, savePending],
  );
  const signIn = async () => {
    setError('');
    setLoading(true);
    try {
      const db = await getAccountClient();
      const { error } = await db.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin + '/auth/callback',
          scopes: 'openid email profile',
        },
      });
      if (error) throw error;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed.');
      setLoading(false);
    }
  };
  const disableNotifications = async (signingOut = false) => {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      if (!(await sub.unsubscribe()))
        throw new Error(
          'This device could not turn off notifications. Try again.',
        );
      setSubscriptionId(null);
      const db = await getAccountClient();
      const { error } = await db.rpc('remove_push_subscription', {
        p_endpoint: endpoint,
      });
      // An unsubscribed endpoint cannot deliver even if remote cleanup is offline.
      if (error && !signingOut) throw error;
    }
  };
  const enableNotifications = async () => {
    setNotificationError('');
    if (!userRef.current) return;
    const available = notificationSupport();
    setSupport(available);
    if (available !== 'supported') return;
    // iOS requires this request directly inside the user's button gesture.
    const permission = Notification.requestPermission();
    setNotificationBusy(true);
    try {
      if ((await permission) !== 'granted') {
        setSupport(notificationSupport());
        throw new Error(
          'Notifications were not allowed. You can enable them in your device settings.',
        );
      }
      const activeId = userRef.current.id;
      const reg = await registration();
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationKey(accountConfig.vapidPublicKey),
        }));
      const keys = sub.toJSON().keys;
      if (!keys?.p256dh || !keys?.auth)
        throw new Error(
          'Your browser could not create a notification subscription.',
        );
      const db = await getAccountClient();
      if (userRef.current?.id !== activeId)
        throw new Error(
          'Your account changed. Please enable notifications again.',
        );
      const { data, error } = await db.rpc('register_push_subscription', {
        p_endpoint: sub.endpoint,
        p_p256dh: keys.p256dh,
        p_auth: keys.auth,
        p_device_name: /iPhone|iPad/.test(navigator.userAgent)
          ? 'iPhone or iPad'
          : /Android/.test(navigator.userAgent)
            ? 'Android'
            : 'Browser',
      });
      if (error) throw error;
      setSubscriptionId(data);
    } catch (e) {
      setNotificationError(
        e instanceof Error ? e.message : 'Notifications could not be enabled.',
      );
    } finally {
      setNotificationBusy(false);
    }
  };
  const turnOff = async () => {
    setNotificationBusy(true);
    setNotificationError('');
    try {
      await disableNotifications();
    } catch (e) {
      setNotificationError(
        e instanceof Error
          ? e.message
          : 'Notifications could not be turned off.',
      );
    } finally {
      setNotificationBusy(false);
    }
  };
  const testNotification = async () => {
    setNotificationBusy(true);
    setNotificationError('');
    try {
      const db = await getAccountClient();
      const { data, error } = await db.functions.invoke('notify-shiurim', {
        body: { subscriptionId },
      });
      if (error || !data?.sent)
        throw new Error(
          data?.error ??
            'The test could not be delivered. Try again in a minute.',
        );
    } catch (e) {
      setNotificationError(
        e instanceof Error ? e.message : 'The test could not be delivered.',
      );
    } finally {
      setNotificationBusy(false);
    }
  };
  const signOut = async () => {
    setLoading(true);
    setError('');
    try {
      // Unsubscribe before clearing the session so an old account cannot keep
      // notifying a shared device after sign-out.
      await disableNotifications(true);
      const db = await getAccountClient();
      const { error } = await db.auth.signOut({ scope: 'local' });
      if (error) throw error;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-out failed.');
    } finally {
      setLoading(false);
    }
  };
  return {
    user,
    loading,
    syncing: syncing || cloudLibrary.syncing,
    error: error || cloudLibrary.error,
    pendingCount: pendingCount + cloudLibrary.pending,
    refresh: async () => {
      await Promise.all([refresh(), cloudLibrary.refresh()]);
    },
    changedFollow,
    signIn,
    signOut,
    support,
    subscriptionId,
    notificationBusy,
    notificationError,
    enableNotifications,
    turnOff,
    testNotification,
  };
}
