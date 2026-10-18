import { gzipSync, gunzipSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { BoundedCache } from './bounded-cache';
import type { SearchDatabase } from './search-storage';
import { performanceSample } from './performance-metrics';

const retentionMs = 24 * 60 * 60_000;
const storageBudget = 16 * 1024 * 1024;
const rawLimit = 24 * 1024 * 1024;
export type PublicSnapshot<T> = {
  value: T;
  version: string;
  updated: number;
  stale: boolean;
};
type Stored = {
  version: string;
  payload: string;
  updated: number;
  expires: number;
};
export class SnapshotExpiredError extends Error {}
export class SnapshotBusyError extends Error {}
export type DeferPublicWork = (task: () => Promise<unknown>) => void;

/** Public data only. Immutable versions keep pagination stable across refreshes. */
export function createPublicSnapshots({
  database,
  now = Date.now,
}: {
  database?: () => SearchDatabase;
  now?: () => number;
} = {}) {
  const memory = new BoundedCache<Stored>(128, 4 * 1024 * 1024);
  const pending = new Map<string, Promise<Stored>>();
  const retryAt = new Map<string, number>();
  let storageRetryAt = 0;
  const connection = () => (now() < storageRetryAt ? undefined : database?.());
  const unpack = <T>(row: Stored, ttl: number): PublicSnapshot<T> => ({
    value: JSON.parse(
      gunzipSync(Buffer.from(row.payload, 'base64'), {
        maxOutputLength: rawLimit,
      }).toString('utf8'),
    ) as T,
    version: row.version,
    updated: row.updated,
    stale: row.updated + ttl <= now(),
  });
  async function stored(resource: string, version = '') {
    const key = resource + ':' + (version || 'latest');
    const hit = memory.get(key);
    if (hit && hit.expires > now()) return hit;
    const db = connection();
    const row = db
      ? await db
          .prepare(
            'SELECT version,payload,updated,expires FROM catalog_snapshots WHERE resource=? AND expires>?' +
              (version
                ? ' AND version=?'
                : ' ORDER BY updated DESC,version DESC LIMIT 1'),
          )
          .bind(resource, now(), ...(version ? [version] : []))
          .first<Stored>()
          .catch(() => {
            storageRetryAt = now() + 30_000;
            return null;
          })
      : null;
    if (row) memory.set(key, row, Math.min(60_000, row.expires - now()));
    return row ?? undefined;
  }
  async function refresh<T>(resource: string, read: () => Promise<T>) {
    const existing = pending.get(resource);
    if (existing) return existing;
    if (pending.size >= 8)
      throw new SnapshotBusyError('The library is busy. Please retry shortly.');
    const request = (async () => {
      let db = connection();
      const owner = crypto.randomUUID();
      if (db) {
        const claim = await db
          .prepare(`INSERT INTO catalog_refresh_leases(resource,owner,expires) VALUES(?,?,?)
          ON CONFLICT(resource) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE catalog_refresh_leases.expires<?`)
          .bind(resource, owner, now() + 90_000, now())
          .run()
          .catch(() => {
            storageRetryAt = now() + 30_000;
            db = undefined;
            return null;
          });
        if (claim && !claim.meta.changes)
          throw new SnapshotBusyError(
            'This library page is being prepared. Please retry shortly.',
          );
      }
      try {
        const value = await read();
        if (!value || (typeof value === 'object' && 'unavailable' in value))
          throw new Error('The library returned an unavailable response.');
        const text = JSON.stringify(value);
        const raw = Buffer.from(text);
        if (raw.length > rawLimit)
          throw new Error('The library snapshot is too large.');
        const version = Buffer.from(
          await crypto.subtle.digest('SHA-256', raw),
        ).toString('hex');
        const payload = gzipSync(raw).toString('base64');
        const bytes = Buffer.byteLength(payload);
        if (bytes > 1_500_000)
          throw new Error('The library snapshot is too large.');
        const latest = db
          ? await db
              .prepare(
                'SELECT MAX(updated) AS updated FROM catalog_snapshots WHERE resource=?',
              )
              .bind(resource)
              .first<{ updated: number | null }>()
              .catch(() => null)
          : await stored(resource);
        const row: Stored = {
          version,
          payload,
          updated: Math.max(now(), (latest?.updated ?? 0) + 1),
          expires: now() + retentionMs,
        };
        if (db) {
          // Commit only while still owning the lease. Pruning and admission are
          // serialized by the PostgreSQL adapter, or the D1 batch transaction.
          const committed = await db
            .batch([
              db
                .prepare('DELETE FROM catalog_snapshots WHERE expires<=?')
                .bind(now()),
              db
                .prepare(`DELETE FROM catalog_snapshots WHERE (resource,version) IN (
              SELECT resource,version FROM (SELECT resource,version,SUM(bytes) OVER(ORDER BY updated DESC,resource,version) AS reserved,
              ROW_NUMBER() OVER(ORDER BY updated DESC,resource,version) AS ordinal FROM catalog_snapshots
              WHERE NOT(resource=? AND version=?)) ranked WHERE reserved>? OR ordinal>255)`)
                .bind(resource, version, storageBudget - bytes),
              db
                .prepare(`INSERT INTO catalog_snapshots(resource,version,payload,bytes,updated,expires)
              SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM catalog_refresh_leases WHERE resource=? AND owner=? AND expires>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
              ON CONFLICT(resource,version) DO UPDATE SET payload=excluded.payload,bytes=excluded.bytes,updated=excluded.updated,expires=excluded.expires`)
                .bind(
                  resource,
                  version,
                  payload,
                  bytes,
                  row.updated,
                  row.expires,
                  resource,
                  owner,
                ),
            ])
            .catch(() => {
              storageRetryAt = now() + 30_000;
              return null;
            });
          if (
            committed &&
            !(committed.at(-1) as { meta?: { changes?: number } })?.meta
              ?.changes
          )
            throw new SnapshotBusyError(
              'The library refresh expired. Please retry.',
            );
        }
        memory.set(resource + ':' + version, row, retentionMs);
        memory.set(resource + ':latest', row, 60_000);
        retryAt.delete(resource);
        performanceSample('catalog_snapshot', {
          bytes,
          rawBytes: raw.length,
          refreshed: 1,
        });
        return row;
      } finally {
        if (db)
          await db
            .prepare(
              'DELETE FROM catalog_refresh_leases WHERE resource=? AND owner=?',
            )
            .bind(resource, owner)
            .run()
            .catch(() => undefined);
      }
    })()
      .catch((error: unknown) => {
        retryAt.set(resource, now() + 30_000);
        while (retryAt.size > 128) retryAt.delete(retryAt.keys().next().value!);
        throw error;
      })
      .finally(() => pending.delete(resource));
    pending.set(resource, request);
    return request;
  }
  return {
    async peek<T>(resource: string, ttl = 300_000) {
      const row = await stored(resource);
      return row ? unpack<T>(row, ttl) : undefined;
    },
    async save<T>(resource: string, value: T) {
      return unpack<T>(
        await refresh(resource, () => Promise.resolve(value)),
        300_000,
      );
    },
    async read<T>(
      resource: string,
      read: () => Promise<T>,
      {
        ttl = 300_000,
        version = '',
        fresh = false,
        defer,
      }: {
        ttl?: number;
        version?: string;
        fresh?: boolean;
        defer?: DeferPublicWork;
      } = {},
    ): Promise<PublicSnapshot<T>> {
      const hit = await stored(resource, version);
      if (version) {
        if (!hit)
          throw new SnapshotExpiredError(
            'This library page has updated. Reload to continue.',
          );
        return unpack<T>(hit, ttl);
      }
      if (hit && !fresh) {
        const result = unpack<T>(hit, ttl);
        if (!result.stale || (retryAt.get(resource) || 0) > now())
          return result;
        if (defer) {
          defer(() => refresh(resource, read).catch(() => undefined));
          return result;
        }
      }
      try {
        return unpack<T>(await refresh(resource, read), ttl);
      } catch (error) {
        if (hit && !fresh) return unpack<T>(hit, ttl);
        throw error;
      }
    },
    async resources(limit = 100) {
      const db = database?.();
      return db
        ? (
            await db
              .prepare(
                'SELECT resource,MAX(updated) AS updated FROM catalog_snapshots GROUP BY resource ORDER BY updated ASC LIMIT ?',
              )
              .bind(Math.min(100, limit))
              .all<{ resource: string; updated: number }>()
          ).results
        : [];
    },
  };
}
