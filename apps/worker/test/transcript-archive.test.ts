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
  publishableContent,
  publicationLimits,
  PublicationValidationError,
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
  let bodyReads = 0;
  let chunkWrites = 0;
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
      if (/SELECT[^;]*\bbody\b[^;]*FROM archive_content_chunks/i.test(this.sql))
        bodyReads++;
      return {
        results: sqlite.prepare(this.sql).all(...(this.args as never[])) as T[],
      };
    }
    async first<T>() {
      return (await this.all<T>()).results[0] ?? null;
    }
    async run() {
      if (this.sql.includes('INSERT OR IGNORE INTO archive_content_chunks'))
        chunkWrites++;
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
  return {
    db,
    sqlite,
    reads: () => reads,
    bodyReads: () => bodyReads,
    chunkWrites: () => chunkWrites,
  };
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

void test('publication boundaries preserve all text and count multibyte encoded bytes', () => {
  const content = fixture();
  content.segments = Array.from({ length: 5000 }, (_, i) => ({
    startMs: i,
    endMs: i + 1,
    text: 'שלום',
    speaker: null,
  }));
  assert.equal(publishableContent(content).content.segments.length, 5000);
  assert.throws(
    () =>
      publishableContent({
        ...content,
        segments: [...content.segments, content.segments[0]],
      }),
    PublicationValidationError,
  );
  content.segments = [{ ...content.segments[0], text: 'ש'.repeat(64000) }];
  assert.equal(
    publishableContent(content).content.segments[0].text.length,
    64000,
  );
  assert.throws(
    () =>
      publishableContent({
        ...content,
        segments: [{ ...content.segments[0], text: 'ש'.repeat(64001) }],
      }),
    PublicationValidationError,
  );
  const withNotes = {
    ...fixture(),
    notes: { status: 'completed', markdown: '' },
  };
  const remaining =
    publicationLimits.bytes -
    Buffer.byteLength(JSON.stringify(publicContent(withNotes)));
  withNotes.notes.markdown =
    'ש'.repeat(Math.floor(remaining / 2)) + (remaining % 2 ? 'a' : '');
  assert.equal(
    Buffer.byteLength(publishableContent(withNotes).text),
    publicationLimits.bytes,
  );
  withNotes.notes.markdown += 'ש';
  assert.throws(
    () => publishableContent(withNotes),
    PublicationValidationError,
  );
});

void test('bounded index maintenance resumes across corrections and retains immutable historical content', async () => {
  const { db, sqlite } = await database();
  class BudgetedArchive extends TranscriptArchive {
    override cleanupIndex() {
      return super.cleanupIndex(1, 2000);
    }
  }
  try {
    const archive = new BudgetedArchive(db, new D1ContentObjects(db));
    const large = (text: string) => ({
      ...fixture(),
      segments: Array.from({ length: 250 }, (_, i) => ({
        startMs: i * 100,
        endMs: (i + 1) * 100,
        text,
        speaker: null,
      })),
    });
    const first = await archive.publish({
      generation: 1,
      content: large('Original halacha'),
    });
    const second = await archive.publish({
      generation: 2,
      content: large('Corrected halacha'),
    });
    await archive.publish({ generation: 3, content: large('Final halacha') });
    assert.ok(
      Number(
        sqlite.prepare('SELECT COUNT(*) AS n FROM archive_segments').get()!.n,
      ) > 250,
    );
    const restarted = new TranscriptArchive(db, new D1ContentObjects(db));
    let passes = 0;
    while ((await restarted.cleanupIndex(1, 2000)).pending)
      assert.ok(++passes < 10);
    assert.equal(
      sqlite.prepare('SELECT COUNT(*) AS n FROM archive_segments').get()!.n,
      250,
    );
    assert.equal(
      sqlite
        .prepare('SELECT COUNT(DISTINCT version) AS n FROM archive_segments')
        .get()!.n,
      1,
    );
    assert.equal(
      (await restarted.content('42', first.version))!.segments.length,
      250,
    );
    assert.equal(
      (await restarted.content('42', second.version))!.segments[0].text,
      'Corrected halacha',
    );
    assert.equal((await restarted.search('original')).length, 0);
    assert.equal(
      (await restarted.content('42'))!.segments[249].text,
      'Final halacha',
    );
  } finally {
    sqlite.close();
  }
});

void test('cold conditional reads validate versions and authorization without loading body chunks', async () => {
  const { db, sqlite, bodyReads } = await database();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { default: { match: async () => undefined, put: async () => {} } },
  });
  try {
    const archive = new TranscriptArchive(db, new D1ContentObjects(db));
    const first = await archive.publish({ generation: 1, content: fixture() });
    const env = { DB: db, READ_TOKEN: 'r'.repeat(48) };
    const ctx = { waitUntil: (_promise: Promise<unknown>) => {} };
    const request = (etag: string, suffix = '', token = env.READ_TOKEN) =>
      new Request('https://archive.example/v1/transcripts/42' + suffix, {
        headers: {
          Authorization: 'Bearer ' + token,
          'If-None-Match': '"' + etag + '"',
        },
      });
    const before = bodyReads();
    for (const suffix of ['', '?version=' + first.version, '?fresh=true']) {
      const response = await worker.fetch(
        request(first.version, suffix),
        env,
        ctx,
      );
      assert.equal(response.status, 304);
      assert.equal(response.headers.get('ETag'), '"' + first.version + '"');
      if (suffix === '?fresh=true')
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    assert.equal(bodyReads(), before);
    assert.equal(
      (await worker.fetch(request(first.version, '', 'bad'), env, ctx)).status,
      401,
    );
    assert.equal(bodyReads(), before);
    assert.equal(
      (
        await worker.fetch(
          request('a'.repeat(64), '?version=' + 'a'.repeat(64)),
          env,
          ctx,
        )
      ).status,
      404,
    );
    const second = await archive.publish({
      generation: 2,
      content: fixture('Corrected'),
    });
    assert.equal(
      (await worker.fetch(request(first.version), env, ctx)).status,
      200,
    );
    const correctedReads = bodyReads();
    assert.equal(
      (await worker.fetch(request(second.version), env, ctx)).status,
      304,
    );
    assert.equal(
      (
        await worker.fetch(
          request(first.version, '?version=' + first.version),
          env,
          ctx,
        )
      ).status,
      304,
    );
    assert.equal(bodyReads(), correctedReads);
    sqlite
      .prepare('DELETE FROM archive_content_chunks WHERE object_key=?')
      .run(`transcripts/42/${first.version}.json`);
    assert.equal(
      (
        await worker.fetch(
          request(first.version, '?version=' + first.version),
          env,
          ctx,
        )
      ).status,
      404,
    );
  } finally {
    if (original) Object.defineProperty(globalThis, 'caches', original);
    else Reflect.deleteProperty(globalThis, 'caches');
    sqlite.close();
  }
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

void test('notes states reuse timed text and repeated search words use one spelling lookup', async () => {
  const { db, sqlite, reads, chunkWrites } = await database();
  try {
    const archive = new TranscriptArchive(db, new D1ContentObjects(db));
    const first = await archive.publish({ generation: 1, content: fixture() });
    const before = sqlite
      .prepare('SELECT COUNT(*) AS n FROM archive_content_chunks')
      .get()!.n;
    for (const [i, status] of ['cleaning', 'generating'].entries()) {
      await archive.updateStatus({
        id: '42',
        generation: i + 2,
        transcriptId: fixture().transcriptId,
        notes: { status },
      });
    }
    assert.equal(
      sqlite.prepare('SELECT COUNT(*) AS n FROM archive_content_chunks').get()!
        .n,
      before,
    );
    assert.equal((await archive.status('42'))!.version, first.version);
    const previousWrites = chunkWrites();
    await archive.publish({
      generation: 4,
      content: {
        ...fixture(),
        notes: { status: 'completed', markdown: '# Notes' },
      },
    });
    assert.equal(
      chunkWrites() - previousWrites,
      1,
      'only the new notes manifest is uploaded',
    );
    assert.equal(
      sqlite
        .prepare(
          "SELECT COUNT(DISTINCT object_key) AS n FROM archive_content_chunks WHERE object_key LIKE '%/segments/%'",
        )
        .get()!.n,
      1,
    );
    assert.equal(
      sqlite.prepare('SELECT COUNT(*) AS n FROM archive_segments').get()!.n,
      3,
    );
    const initial = reads();
    assert.ok((await archive.search('quantmu quantmu quantmu')).length);
    assert.equal(reads() - initial, 2);
    assert.equal(
      (await archive.content('42', first.version))!.notes!.status,
      'queued',
    );
  } finally {
    sqlite.close();
  }
});

void test('immutable D1 objects reuse stored chunks and repair an interrupted upload', async () => {
  const { db, sqlite, chunkWrites } = await database();
  try {
    const objects = new D1ContentObjects(db);
    const body = 'a'.repeat(99999) + '😀' + 'b'.repeat(150000);
    await objects.put('fixture', body);
    const initialWrites = chunkWrites();
    await objects.put('fixture', body);
    assert.equal(
      chunkWrites(),
      initialWrites,
      'a completed object is not uploaded again',
    );
    sqlite.exec(
      "DELETE FROM archive_content_chunks WHERE object_key='fixture' AND chunk_index=1",
    );
    await objects.put('fixture', body);
    assert.equal(
      chunkWrites(),
      initialWrites + 1,
      'only the missing chunk is uploaded',
    );
    assert.equal(await (await objects.get('fixture'))!.text(), body);
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
      searchVersion: await contentHash(
        JSON.stringify(publicContent(fixture()).segments),
      ),
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
    assert.ok(statusBody.length < 300);
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
