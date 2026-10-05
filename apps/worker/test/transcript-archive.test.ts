import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import {
  TranscriptArchive,
  contentHash,
  type ArchiveDatabase,
  type ArchiveStatement,
} from '../../../packages/transcription/src/archive.js';
import { D1ContentObjects } from '../../../packages/transcription/src/d1-content.js';
import {
  publicContent,
  type PublicContent,
} from '../../../packages/transcription/src/public-content.js';
import worker from '../../transcript-archive/src/index.js';
import {
  buildSpellingBase,
  seedSpellingBase,
} from '../../../packages/transcription/src/spelling-base.js';

async function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of (await readdir('db/transcript-archive')).sort())
    sqlite.exec(await readFile(`db/transcript-archive/${file}`, 'utf8'));
  let reads = 0;
  class Statement implements ArchiveStatement {
    constructor(
      private sql: string,
      private args: unknown[] = [],
    ) {}
    bind(...args: unknown[]) {
      return new Statement(this.sql, args);
    }
    async all<T>() {
      reads++;
      return {
        results: sqlite.prepare(this.sql).all(...(this.args as never[])) as T[],
      };
    }
    async first<T>() {
      return (await this.all<T>()).results[0] ?? null;
    }
    async run() {
      return sqlite.prepare(this.sql).run(...(this.args as never[]));
    }
  }
  const db: ArchiveDatabase = {
    prepare: (sql) => new Statement(sql),
    batch: async (statements) => {
      sqlite.exec('BEGIN');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        sqlite.exec('COMMIT');
        return result;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return { db, sqlite, reads: () => reads };
}
const fixture = (
  text = 'Quantum halacha includes חזרה.',
  id = '42',
): PublicContent => ({
  id,
  title: 'Fixture Shiur',
  teacher: 'Rabbi Fixture',
  mediaUrl: 'https://example.test/audio.mp3',
  transcriptId: '00000000-0000-4000-8000-000000000001',
  durationMs: 30000,
  createdAt: '2026-10-05T00:00:00Z',
  segments: [
    { startMs: 1000, endMs: 10000, text, speaker: null, language: null },
    { startMs: 10000, endMs: 20000, text: 'Coffee on', speaker: null },
    {
      startMs: 20000,
      endMs: 30000,
      text: 'Shabbos requires care.',
      speaker: null,
    },
  ],
  notes: { status: 'queued', markdown: null },
});

void test('packed initial spelling index preserves typo search and later publications', async () => {
  const { db, sqlite } = await database();
  try {
    const content = fixture();
    const base = buildSpellingBase([content]);
    await seedSpellingBase(db, base);
    await seedSpellingBase(db, base);
    const archive = new TranscriptArchive(db, new D1ContentObjects(db));
    await archive.publish(
      { generation: 1, content },
      { spellingBaseSeeded: true },
    );
    assert.equal(
      sqlite.prepare('SELECT count(*) AS n FROM archive_spelling_keys').get()!
        .n,
      0,
    );
    assert.equal((await archive.search('quantmu'))[0].startMs, 1000);
    assert.equal((await archive.search('chazara'))[0].startMs, 1000);
    await archive.publish({
      generation: 1,
      content: fixture('Astronomy discusses stars.', '43'),
    });
    assert.equal((await archive.search('astronmo'))[0].shiurId, '43');
    assert.equal((await archive.search('quantmu'))[0].shiurId, '42');
    sqlite.exec('DELETE FROM archive_spelling_base');
    await seedSpellingBase(db, base);
    assert.equal((await archive.search('quantmu'))[0].shiurId, '42');
  } finally {
    sqlite.close();
  }
});

void test('D1 publication preserves hashes, timestamps, Hebrew, and immutable previous versions', async () => {
  const { db, sqlite } = await database();
  try {
    const archive = new TranscriptArchive(db, new D1ContentObjects(db));
    const first = await archive.publish({ generation: 1, content: fixture() });
    assert.equal(first.applied, true);
    const content = await archive.content('42');
    assert.deepEqual(content, {
      ...publicContent(fixture()),
      version: first.version,
    });
    assert.equal(
      first.version,
      await contentHash(JSON.stringify(publicContent(fixture()))),
    );
    assert.deepEqual(await archive.status('42'), {
      transcriptId: fixture().transcriptId,
      version: first.version,
      notes: { status: 'queued' },
    });
    const revised = {
      ...fixture('Corrected halacha.'),
      notes: { status: 'completed', markdown: '# Notes' },
    };
    const second = await archive.publish({ generation: 2, content: revised });
    assert.notEqual(first.version, second.version);
    assert.equal((await archive.content('42'))?.notes?.markdown, '# Notes');
    assert.deepEqual(await archive.content('42', first.version), content);
    assert.equal(
      (await archive.publish({ generation: 1, content: fixture() })).applied,
      false,
    );
    await assert.rejects(
      archive.publish({ generation: 2, content: fixture() }),
      /conflict/,
    );
    assert.equal(await archive.content('99'), null);
    assert.equal(await archive.content('42', 'a'.repeat(64)), null);
  } finally {
    sqlite.close();
  }
});

void test('D1 transcript search matches Hebrew aliases, typos, and phrases crossing timed segments', async () => {
  const { db, sqlite } = await database();
  try {
    const archive = new TranscriptArchive(db, new D1ContentObjects(db));
    await archive.publish({ generation: 1, content: fixture() });
    for (const [query, mode, start] of [
      ['quantmu', 'smart', 1000],
      ['chazara', 'smart', 1000],
      ['coffee on shabbos', 'phrase', 10000],
      ['shabbos', 'smart', 20000],
      ['coffee on', 'terms', 10000],
    ] as const) {
      const results = await archive.search(query, true, 20, mode);
      assert.equal(results.length, 1, query);
      assert.equal(results[0].startMs, start, query);
      assert.equal(results[0].href, `/?shiur=42&t=${start / 1000}`);
    }
    assert.equal((await archive.search('chazara', false)).length, 0);
    await archive.publish({
      generation: 2,
      content: fixture('Replaced text.'),
    });
    assert.equal(
      (await archive.search('quantum')).length,
      0,
      'obsolete index rows are not live',
    );
    await assert.rejects(archive.search('...'), /Invalid/);
  } finally {
    sqlite.close();
  }
});

void test('failed staging cannot replace a valid transcript; repeating a partial upload repairs it', async () => {
  const { db, sqlite } = await database();
  try {
    const objects = new D1ContentObjects(db);
    const archive = new TranscriptArchive(db, objects);
    const initial = await archive.publish({
      generation: 1,
      content: fixture(),
    });
    const broken = new TranscriptArchive(
      {
        ...db,
        batch: async () => {
          throw new Error('quota limit');
        },
      },
      objects,
    );
    await assert.rejects(
      broken.publish({ generation: 2, content: fixture('Replacement') }),
      /quota/,
    );
    assert.equal((await archive.status('42'))?.version, initial.version);
    assert.equal((await archive.search('quantum')).length, 1);
    await archive.publish({ generation: 2, content: fixture('Replacement') });
    assert.equal(
      (await archive.content('42'))?.segments[0].text,
      'Replacement',
    );
    const body = 'x'.repeat(99_999) + '😀' + 'שלום'.repeat(100_000);
    await objects.put('large', body);
    assert.equal(await (await objects.get('large'))?.text(), body);
    sqlite.exec(
      "DELETE FROM archive_content_chunks WHERE object_key='large' AND chunk_index=1",
    );
    await assert.rejects(objects.get('large'), /incomplete/);
    await objects.put('large', body);
    assert.equal(await (await objects.get('large'))?.text(), body);
  } finally {
    sqlite.close();
  }
});

void test('Free Worker serves D1, authenticates before edge cache, and bypasses cache on refresh', async () => {
  const { db, sqlite, reads } = await database();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const cached = new Map<string, Response>();
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      default: {
        match: async (r: Request) => cached.get(r.url)?.clone(),
        put: async (r: Request, s: Response) => {
          cached.set(r.url, s.clone());
        },
      },
    },
  });
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waits.push(p);
    },
  };
  const env = { DB: db, READ_TOKEN: 'r'.repeat(48) };
  const request = (path: string, token = env.READ_TOKEN, method = 'GET') =>
    new Request(`https://archive.example${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    });
  try {
    const archive = new TranscriptArchive(db, new D1ContentObjects(db));
    await archive.publish({ generation: 1, content: fixture() });
    const first = await worker.fetch(request('/v1/transcripts/42'), env, ctx);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), await archive.content('42'));
    await Promise.all(waits);
    const before = reads();
    assert.equal(
      (await worker.fetch(request('/v1/transcripts/42'), env, ctx)).status,
      200,
    );
    assert.equal(reads(), before, 'warm edge cache performs no D1 reads');
    assert.equal(
      (await worker.fetch(request('/v1/transcripts/42', 'bad'), env, ctx))
        .status,
      401,
    );
    assert.equal(reads(), before);
    const fresh = await worker.fetch(
      request('/v1/transcripts/42?fresh=true'),
      env,
      ctx,
    );
    assert.equal(fresh.headers.get('Cache-Control'), 'no-store');
    assert.ok(reads() > before);
    const status = await worker.fetch(
      request('/v1/transcripts/42/status'),
      env,
      ctx,
    );
    const statusBody = await status.text();
    assert.ok(statusBody.length < 200);
    assert.ok(!statusBody.includes('segments'));
    assert.equal(
      (
        await worker.fetch(
          request('/v1/publications', env.READ_TOKEN, 'POST'),
          env,
          ctx,
        )
      ).status,
      405,
    );
    assert.equal(
      (await worker.fetch(request('/v1/transcripts/search?q=...'), env, ctx))
        .status,
      400,
    );
  } finally {
    if (original) Object.defineProperty(globalThis, 'caches', original);
    else Reflect.deleteProperty(globalThis, 'caches');
    sqlite.close();
  }
});
