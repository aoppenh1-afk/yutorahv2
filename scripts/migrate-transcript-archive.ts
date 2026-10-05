/** Run export, inspect, import, verify in that order. No live-site switch here. */
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import { TranscriptionStore } from '../packages/transcription/src/store.js';
import {
  TranscriptArchive,
  contentHash,
  type ArchiveDatabase,
  type ArchiveStatement,
} from '../packages/transcription/src/archive.js';
import { D1ContentObjects } from '../packages/transcription/src/d1-content.js';
import {
  publicContent,
  type PublicContent,
} from '../packages/transcription/src/public-content.js';
import { d1HttpDatabase } from '../lib/d1-http.js';
import {
  buildSpellingBase,
  seedSpellingBase,
  verifySpellingBase,
} from '../packages/transcription/src/spelling-base.js';

const [command, directoryArg] = process.argv.slice(2);
if (
  !['export', 'inspect', 'import', 'verify'].includes(command) ||
  !directoryArg
)
  throw new Error(
    'Usage: tsx scripts/migrate-transcript-archive.ts export|inspect|import|verify PRIVATE_DIRECTORY',
  );
const directory = resolve(directoryArg);
await mkdir(directory, { recursive: true, mode: 0o700 });
type Item = {
  id: string;
  transcriptId: string;
  hash: string;
  bytes: number;
  generation: number;
};
type Manifest = { version: 1; createdAt: string; items: Item[] };
const save = async (name: string, value: unknown) =>
  writeFile(join(directory, name), JSON.stringify(value), { mode: 0o600 });
const content = async (item: Item) => {
  if (!/^\d{1,12}$/.test(item.id)) throw new Error('Invalid manifest ID');
  const c = publicContent(
    JSON.parse(
      await readFile(join(directory, `${item.id}.json`), 'utf8'),
    ) as PublicContent,
  );
  if (
    c.id !== item.id ||
    c.transcriptId !== item.transcriptId ||
    (await contentHash(JSON.stringify(c))) !== item.hash
  )
    throw new Error('Backup verification failed for ' + item.id);
  return c;
};
if (command === 'export') {
  const exists = await readFile(join(directory, 'manifest.json'), 'utf8').then(
    () => true,
    () => false,
  );
  if (exists)
    throw new Error(
      'A complete backup exists. Export to a new private directory.',
    );
  const manifest: Manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    items: [],
  };
  const accept = async (c: PublicContent, generation = 1) => {
    const value = publicContent(c);
    const text = JSON.stringify(value);
    await save(`${value.id}.json`, value);
    manifest.items.push({
      id: value.id,
      transcriptId: value.transcriptId,
      hash: await contentHash(text),
      bytes: Buffer.byteLength(text),
      generation,
    });
  };
  const url = process.env.TRANSCRIPT_EXPORT_URL;
  if (url) {
    const token = process.env.TRANSCRIPT_EXPORT_TOKEN;
    if (!token || !url.startsWith('https://'))
      throw new Error('HTTPS export URL and token required');
    const get = async (params: URLSearchParams) => {
      const r = await fetch(url + '?' + params, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60000),
      });
      if (!r.ok) throw new Error(`Source export failed (${r.status})`);
      return r.json();
    };
    const initial = (await get(new URLSearchParams({ manifest: 'true' }))) as {
      items: { id: string; transcriptId: string }[];
    };
    for (const item of initial.items) {
      const exported = (await get(new URLSearchParams(item))) as {
        content: PublicContent;
        hash: string;
      };
      if (
        (await contentHash(JSON.stringify(publicContent(exported.content)))) !==
        exported.hash
      )
        throw new Error('Source hash mismatch');
      await accept(exported.content);
    }
    const final = (await get(
      new URLSearchParams({ manifest: 'true' }),
    )) as typeof initial;
    if (JSON.stringify(initial) !== JSON.stringify(final))
      throw new Error('Source changed during export. Repeat export.');
  } else {
    if (!process.env.TRANSCRIPT_SOURCE_DATABASE_URL)
      throw new Error(
        'Source database URL or authenticated export URL required',
      );
    const pool = new Pool({
      connectionString: process.env.TRANSCRIPT_SOURCE_DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 8000,
      query_timeout: 30000,
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const ids = (
        await client.query<{ id: string }>(
          'SELECT id FROM transcription_shiurim WHERE active_transcript_id IS NOT NULL ORDER BY id',
        )
      ).rows;
      const hasQueue = (
        await client.query<{ present: boolean }>(
          "SELECT to_regclass('transcript_publications') IS NOT NULL AS present",
        )
      ).rows[0].present;
      for (const { id } of ids) {
        const c = await new TranscriptionStore(pool).publicContent(id, client);
        if (!c) throw new Error('Source transcript missing');
        const generation = hasQueue
          ? Number(
              (
                await client.query<{ generation: string }>(
                  'SELECT generation FROM transcript_publications WHERE shiur_id=$1',
                  [id],
                )
              ).rows[0]?.generation ?? 1,
            )
          : 1;
        await accept(c, generation);
      }
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      await pool.end();
    }
  }
  // A completed manifest is written last. A partial export is never importable.
  await save('manifest.json', manifest);
  console.log(
    JSON.stringify({
      exported: manifest.items.length,
      bytes: manifest.items.reduce((n, x) => n + x.bytes, 0),
    }),
  );
} else {
  const manifest = JSON.parse(
    await readFile(join(directory, 'manifest.json'), 'utf8'),
  ) as Manifest;
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.items) ||
    !manifest.items.length ||
    new Set(manifest.items.map((i) => i.id)).size !== manifest.items.length
  )
    throw new Error('Invalid or empty export manifest');
  const openLocal = async () => {
    await rm(join(directory, 'archive-preview.sqlite'), { force: true });
    const sqlite = new DatabaseSync(join(directory, 'archive-preview.sqlite'));
    if (
      !sqlite
        .prepare("SELECT name FROM sqlite_master WHERE name='archive_items'")
        .get()
    )
      for (const file of (await readdir('db/transcript-archive')).sort())
        sqlite.exec(await readFile(`db/transcript-archive/${file}`, 'utf8'));
    class Statement implements ArchiveStatement {
      constructor(
        private sql: string,
        private params: unknown[] = [],
      ) {}
      bind(...params: unknown[]) {
        return new Statement(this.sql, params);
      }
      async all<T>() {
        return {
          results: sqlite
            .prepare(this.sql)
            .all(...(this.params as never[])) as T[],
        };
      }
      async first<T>() {
        return (await this.all<T>()).results[0] ?? null;
      }
      async run() {
        return sqlite.prepare(this.sql).run(...(this.params as never[]));
      }
    }
    const db: ArchiveDatabase = {
      prepare: (sql) => new Statement(sql),
      batch: async (statements) => {
        sqlite.exec('BEGIN');
        try {
          const result = [];
          for (const s of statements) result.push(await s.run());
          sqlite.exec('COMMIT');
          return result;
        } catch (e) {
          sqlite.exec('ROLLBACK');
          throw e;
        }
      },
    };
    return { db, sqlite };
  };
  if (command === 'inspect') {
    const { db, sqlite } = await openLocal();
    try {
      const archive = new TranscriptArchive(db, new D1ContentObjects(db));
      const contents = await Promise.all(manifest.items.map(content));
      const base = buildSpellingBase(contents);
      await seedSpellingBase(db, base);
      for (const item of manifest.items)
        await archive.publish(
          {
            generation: item.generation,
            content: await content(item),
          },
          { spellingBaseSeeded: true },
        );
      const page = sqlite.prepare('PRAGMA page_count').get() as {
        page_count: number;
      };
      const size = sqlite.prepare('PRAGMA page_size').get() as {
        page_size: number;
      };
      const bytes = page.page_count * size.page_size;
      const report = {
        manifestHash: await contentHash(JSON.stringify(manifest)),
        transcripts: manifest.items.length,
        databaseBytes: bytes,
        spellingBuckets: base.length,
        freeDatabaseLimitBytes: 500_000_000,
        fits: bytes < 400_000_000,
      };
      await save('inspection.json', report);
      console.log(JSON.stringify(report));
      if (!report.fits)
        throw new Error(
          'Archive exceeds the conservative Free-plan storage budget. Do not import or upgrade.',
        );
    } finally {
      sqlite.close();
    }
  } else {
    const inspection = JSON.parse(
      await readFile(join(directory, 'inspection.json'), 'utf8'),
    ) as { fits: boolean; transcripts: number; manifestHash: string };
    if (
      !inspection.fits ||
      inspection.transcripts !== manifest.items.length ||
      inspection.manifestHash !== (await contentHash(JSON.stringify(manifest)))
    )
      throw new Error('Inspect this complete backup before importing');
    const accountId = process.env.TRANSCRIPT_ARCHIVE_ACCOUNT_ID ?? '';
    const databaseId = process.env.TRANSCRIPT_ARCHIVE_DATABASE_ID ?? '';
    let token = process.env.TRANSCRIPT_ARCHIVE_API_TOKEN ?? '';
    if (!token && process.env.TRANSCRIPT_ARCHIVE_WRANGLER_AUTH_FILE) {
      const auth = await readFile(
        process.env.TRANSCRIPT_ARCHIVE_WRANGLER_AUTH_FILE,
        'utf8',
      );
      token = auth.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1] ?? '';
    }
    const day = new Date().toISOString().slice(0, 10);
    const usageFile = 'import-usage.json';
    const previous = JSON.parse(
      await readFile(join(directory, usageFile), 'utf8').catch(() => '{}'),
    ) as {
      day?: string;
      accountId?: string;
      databaseId?: string;
      written?: number;
      read?: number;
    };
    const sameDay =
      previous.day === day &&
      previous.accountId === accountId &&
      previous.databaseId === databaseId;
    let written = sameDay ? (previous.written ?? 0) : 0,
      read = sameDay ? (previous.read ?? 0) : 0;
    const budget = Number(process.env.TRANSCRIPT_IMPORT_WRITE_BUDGET ?? 70000);
    if (!Number.isSafeInteger(budget) || budget < 100 || budget > 70000)
      throw new Error('Invalid Free-plan write budget');
    const db = d1HttpDatabase({
      accountId,
      databaseId,
      token,
      beforeRequest: () => {
        if (command === 'import' && written >= budget)
          throw new Error(
            'Import paused at the daily write budget. Rerun tomorrow to resume.',
          );
      },
      onResult: (meta) => {
        written += meta.rows_written ?? 0;
        read += meta.rows_read ?? 0;
      },
    });
    const archive = new TranscriptArchive(db, new D1ContentObjects(db));
    try {
      const base = buildSpellingBase(
        await Promise.all(manifest.items.map(content)),
      );
      if (command === 'import') await seedSpellingBase(db, base);
      else await verifySpellingBase(db, base);
      let count = 0;
      for (const item of manifest.items) {
        if (command === 'import')
          await archive.publish(
            {
              generation: item.generation,
              content: await content(item),
            },
            { spellingBaseSeeded: true },
          );
        const c = await archive.content(item.id);
        if (!c || c.version !== item.hash)
          throw new Error('Remote hash verification failed for ' + item.id);
        count++;
      }
      const total = await db
        .prepare('SELECT count(*) AS count FROM archive_items')
        .first<{ count: number }>();
      if (total?.count !== count)
        throw new Error('Remote transcript count differs from backup');
      await save('verification.json', {
        verified: count,
        written,
        read,
        at: new Date().toISOString(),
      });
      console.log(JSON.stringify({ verified: count, written, read }));
    } finally {
      await save(usageFile, { day, accountId, databaseId, written, read });
    }
  }
}
