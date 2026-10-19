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
type Cached = { row: Stored; validateAfter: number };
export class SnapshotExpiredError extends Error {}
export class SnapshotBusyError extends Error {}
export type DeferPublicWork = (task: () => Promise<unknown>) => void;
export type SnapshotSource = 'server-memory' | 'snapshot' | 'refresh';
export type SnapshotObservation = { onRead?: (source: SnapshotSource) => void };

/** Public data only. Immutable versions keep pagination stable across refreshes. */
export function createPublicSnapshots({
  database,
  now = Date.now,
}: {
  database?: () => SearchDatabase;
  now?: () => number;
} = {}) {
  const memory = new BoundedCache<Cached>(128, 4 * 1024 * 1024);
  const pending = new Map<string, Promise<Stored>>();
  const reads = new Map<
    string,
    Promise<{ row: Stored; source: 'snapshot' | 'server-memory' } | undefined>
  >();
  const retryAt = new Map<string, number>();
  let storageRetryAt = 0;
  const connection = () => (now() < storageRetryAt ? undefined : database?.());
  const remember = (key: string, row: Stored, validateAfter = now() + 60_000) =>
    memory.set(key, { row, validateAfter }, row.expires - now());
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
    const cached = memory.get(key);
    const hit = cached && cached.row.expires > now() ? cached : undefined;
    // Explicit versions are immutable. Latest reads keep the same sixty-second
    // publication check, retaining payloads within the existing memory budget.
    if (hit && (version || hit.validateAfter > now()))
      return { row: hit.row, source: 'server-memory' as const };
    const existing = reads.get(key);
    if (existing) return existing;
    if (reads.size >= 128)
      throw new SnapshotBusyError('The library is busy. Please retry shortly.');
    const request = loadStored(resource, version, key, hit?.row).finally(() =>
      reads.delete(key),
    );
    reads.set(key, request);
    return request;
  }
  async function loadStored(
    resource: string,
    version: string,
    key: string,
    cached?: Stored,
  ) {
    const db = connection();
    let unavailable = !db;
    const row = db
      ? await db
          .prepare(
            // One query returns only metadata for an unchanged content hash,
            // or includes the replacement payload when another host published.
            'SELECT version,' +
              (cached
                ? 'CASE WHEN version=? THEN NULL ELSE payload END AS payload'
                : 'payload') +
              ',updated,expires FROM catalog_snapshots WHERE resource=? AND expires>?' +
              (version
                ? ' AND version=?'
                : ' ORDER BY updated DESC,version DESC LIMIT 1'),
          )
          .bind(
            ...(cached ? [cached.version] : []),
            resource,
            now(),
            ...(version ? [version] : []),
          )
          .first<Omit<Stored, 'payload'> & { payload: string | null }>()
          .catch(() => {
            storageRetryAt = now() + 30_000;
            unavailable = true;
            return null;
          })
      : null;
    // A local refresh may publish while this validation query is in flight.
    // Do not replace its newer generation with the earlier query result.
    const latest = memory.get(key);
    if (
      latest &&
      latest.row.expires > now() &&
      latest.row.updated > (row?.updated ?? cached?.updated ?? 0)
    )
      return { row: latest.row, source: 'server-memory' as const };
    if (unavailable && cached) {
      remember(key, cached, now() + 30_000);
      return { row: cached, source: 'server-memory' as const };
    }
    const payload =
      row?.payload ??
      (row?.version === cached?.version ? cached?.payload : undefined);
    if (row && typeof payload === 'string') {
      const loaded = { ...row, payload };
      remember(key, loaded);
      return { row: loaded, source: 'snapshot' as const };
    }
    memory.delete(key);
    return undefined;
  }
  async function refresh<T>(resource: string, read: () => Promise<T>) {
    const existing = pending.get(resource);
    if (existing) return existing;
    if (pending.size >= 8)
      throw new SnapshotBusyError('The library is busy. Please retry shortly.');
    const request = (async () => {
      let db = connection();
      const owner = crypto.randomUUID();
      const publisher = owner + ':publish';
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
          : (await stored(resource))?.row;
        const row: Stored = {
          version,
          payload,
          updated: Math.max(now(), (latest?.updated ?? 0) + 1),
          expires: now() + retentionMs,
        };
        if (db) {
          // Claim publication at the database clock before mutating snapshots.
          // The lease row stays locked for this transaction, so expiry cannot
          // split pruning from publication. Every mutation requires this token.
          const committed = await db
            .batch([
              db
                .prepare(`UPDATE catalog_refresh_leases SET owner=? WHERE resource=? AND owner=?
              AND expires>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)`)
                .bind(publisher, resource, owner),
              db
                .prepare(`DELETE FROM catalog_snapshots WHERE expires<=?
              AND EXISTS(SELECT 1 FROM catalog_refresh_leases WHERE resource=? AND owner=?)`)
                .bind(now(), resource, publisher),
              db
                .prepare(`DELETE FROM catalog_snapshots WHERE (resource,version) IN (
              SELECT resource,version FROM (SELECT resource,version,SUM(bytes) OVER(ORDER BY updated DESC,resource,version) AS reserved,
              ROW_NUMBER() OVER(ORDER BY updated DESC,resource,version) AS ordinal FROM catalog_snapshots
              WHERE NOT(resource=? AND version=?)) ranked WHERE reserved>? OR ordinal>255)
              AND EXISTS(SELECT 1 FROM catalog_refresh_leases WHERE resource=? AND owner=?)`)
                .bind(
                  resource,
                  version,
                  storageBudget - bytes,
                  resource,
                  publisher,
                ),
              db
                .prepare(`INSERT INTO catalog_snapshots(resource,version,payload,bytes,updated,expires)
              SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM catalog_refresh_leases WHERE resource=? AND owner=?)
              ON CONFLICT(resource,version) DO UPDATE SET payload=excluded.payload,bytes=excluded.bytes,updated=excluded.updated,expires=excluded.expires`)
                .bind(
                  resource,
                  version,
                  payload,
                  bytes,
                  row.updated,
                  row.expires,
                  resource,
                  publisher,
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
        remember(resource + ':' + version, row);
        remember(resource + ':latest', row);
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
              'DELETE FROM catalog_refresh_leases WHERE resource=? AND owner IN (?,?)',
            )
            .bind(resource, owner, publisher)
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
      const hit = await stored(resource);
      return hit ? unpack<T>(hit.row, ttl) : undefined;
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
        onRead,
      }: {
        ttl?: number;
        version?: string;
        fresh?: boolean;
        defer?: DeferPublicWork;
      } & SnapshotObservation = {},
    ): Promise<PublicSnapshot<T>> {
      const hit =
        fresh && !version ? undefined : await stored(resource, version);
      const result = (row: Stored, source: SnapshotSource) => {
        onRead?.(source);
        return unpack<T>(row, ttl);
      };
      if (version) {
        if (!hit)
          throw new SnapshotExpiredError(
            'This library page has updated. Reload to continue.',
          );
        return result(hit.row, hit.source);
      }
      if (hit && !fresh) {
        if (
          hit.row.updated + ttl > now() ||
          (retryAt.get(resource) || 0) > now()
        )
          return result(hit.row, hit.source);
        if (defer) {
          defer(() => refresh(resource, read).catch(() => undefined));
          return result(hit.row, hit.source);
        }
      }
      try {
        return result(await refresh(resource, read), 'refresh');
      } catch (error) {
        if (hit && !fresh) return result(hit.row, hit.source);
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
