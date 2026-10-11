import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NotesQueue, type NoteJob } from '../packages/notes-only/src/queue';
import {
  NotesPipeline,
  durableWrite,
} from '../packages/notes-only/src/pipeline';
import { packNote, unpackNote, type SavedNote } from '../lib/tidb-notes-store';
import { runNotesPool } from '../deploy/notes-only/pool.mjs';
const vtt =
  'WEBVTT\n\n00:00.000 --> 00:02.000\nShalom שלום תשובה\n\n00:01.900 --> 00:03.000\nFull second cue\n';
const markdown = '# תשובה\n\n## Teaching\n\n- Shalom שלום\n';
void test('a malformed transcript is blocked while the next real pipeline job sorts cues and publishes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notes-resilience-'));
  const queue = new NotesQueue(join(root, 'queue.sqlite'));
  const signal = new AbortController().signal;
  const saved = new Map<string, SavedNote>();
  const pipeline = new NotesPipeline({
    root,
    queue,
    store: {
      get: async (id) => saved.get(id) ?? null,
      publish: async (note) => {
        saved.set(note.shiurId, note);
      },
    },
    generatorVersion: 'pilot',
    language: 'hebrewEnglish',
    signal,
    fetchTranscript: async (id) =>
      id === '1'
        ? 'bad transcript'
        : 'WEBVTT\n\n00:02.000 --> 00:04.000\nLater\n\n00:01.000 --> 00:03.000\nEarlier\n',
    generate: async (source) => {
      assert.equal(source, 'Earlier\n\nLater');
      return markdown;
    },
  });
  try {
    queue.enqueue([{ id: '1' }, { id: '2' }]);
    const result = await runNotesPool({
      queue,
      signal,
      concurrency: 1,
      paceMs: 0,
      log: () => {},
      processJob: (job: NoteJob) => pipeline.process(job),
      sleep: async (ms) => {
        assert.equal(ms, 0, 'Malformed VTT must not delay the next job');
      },
    });
    assert.deepEqual(result, { processed: 2, failed: false });
    assert.deepEqual(
      {
        ...queue.db
          .prepare('SELECT status,error FROM jobs WHERE id=?')
          .get('1'),
      },
      { status: 'blocked', error: 'invalid_transcript' },
    );
    assert.equal(saved.size, 1);
    assert.equal(await unpackNote(saved.get('2')!), markdown);
    assert.equal(
      queue.db.prepare('SELECT status FROM jobs WHERE id=?').get('2')?.status,
      'completed',
    );
  } finally {
    queue.close();
    await rm(root, { recursive: true, force: true });
  }
});
void test('Hebrew bytes survive compression; corrupt hashes and expansion above the cap are rejected', async () => {
  const note = await packNote({
    shiurId: '1190357',
    sourceHash: 'a'.repeat(64),
    generatorVersion: 'pilot',
    language: 'hebrewEnglish',
    markdown,
  });
  assert.equal(await unpackNote(note), markdown);
  await assert.rejects(
    unpackNote({ ...note, notesHash: 'b'.repeat(64) }),
    /checksum/,
  );
  await assert.rejects(
    packNote({
      shiurId: '1190357',
      sourceHash: 'a'.repeat(64),
      generatorVersion: 'pilot',
      language: 'hebrewEnglish',
      markdown: 'a'.repeat(1024 * 1024 + 1),
    }),
    /too large/,
  );
});
void test('failed publication keeps source and durable notes; restart republishes without another AI call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notes-only-'));
  let queue = new NotesQueue(join(root, 'queue.sqlite'));
  let generated = 0,
    downloads = 0,
    saved: SavedNote | null = null,
    fail = true;
  const store = {
    get: async () => saved,
    publish: async (note: SavedNote) => {
      if (fail) throw new Error('Quota reached');
      saved = note;
    },
  };
  const options = {
    root,
    queue,
    store,
    generatorVersion: 'pilot',
    language: 'hebrewEnglish',
    signal: new AbortController().signal,
    fetchTranscript: async () => {
      downloads++;
      return vtt;
    },
    generate: async (source: string) => {
      generated++;
      assert.match(source, /Full second cue/);
      return markdown;
    },
  };
  try {
    queue.enqueue([{ id: '1190357' }]);
    const first = queue.claim()!;
    await assert.rejects(new NotesPipeline(options).process(first), /Quota/);
    assert.equal(
      await readFile(join(root, 'jobs/1190357/source.vtt'), 'utf8'),
      vtt,
    );
    assert.ok((await stat(join(root, 'notes/1190357/notes.md.gz'))).size);
    queue.close();
    queue = new NotesQueue(join(root, 'queue.sqlite'));
    queue.recover();
    fail = false;
    await new NotesPipeline({ ...options, queue }).process(queue.claim()!);
    assert.equal(generated, 1);
    assert.equal(downloads, 1);
    assert.equal(await unpackNote(saved!), markdown);
    await assert.rejects(stat(join(root, 'jobs/1190357/source.vtt')), {
      code: 'ENOENT',
    });
    assert.deepEqual(
      queue.status().map((r) => ({ ...r })),
      [{ status: 'completed', count: 1 }],
    );
    assert.equal(queue.claim(), null);
  } finally {
    queue.close();
    await rm(root, { recursive: true, force: true });
  }
});
void test('already published notes skip source and generation; missing transcripts remain eligible for later recheck', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notes-only-'));
  const queue = new NotesQueue(join(root, 'queue.sqlite'));
  try {
    const note = await packNote({
      shiurId: '1190357',
      sourceHash: 'a'.repeat(64),
      generatorVersion: 'old',
      language: 'hebrewEnglish',
      markdown,
    });
    const pipeline = new NotesPipeline({
      root,
      queue,
      store: {
        get: async (id) => (id === '1190357' ? note : null),
        publish: async () => assert.fail('Unnecessary insert'),
      },
      generatorVersion: 'new',
      language: 'hebrewEnglish',
      signal: new AbortController().signal,
      fetchTranscript: async () => null,
      generate: async () => assert.fail('Unnecessary AI call'),
    });
    queue.enqueue([{ id: '1190357' }, { id: '1190833' }]);
    assert.equal(await pipeline.process(queue.claim()!), 'already_published');
    assert.equal(await pipeline.process(queue.claim()!), 'missing');
    queue.db.prepare("UPDATE jobs SET next_at=0 WHERE status='missing'").run();
    queue.recheckMissing();
    assert.equal(queue.claim()?.id, '1190833');
  } finally {
    queue.close();
    await rm(root, { recursive: true, force: true });
  }
});
for (const alreadyPublished of [false, true])
  void test(`a ${alreadyPublished ? 'preexisting' : 'competing'} published note completes the queue and preserves the generated alternative`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'notes-reconcile-'));
    const queue = new NotesQueue(join(root, 'queue.sqlite'));
    const candidate = await packNote({
      shiurId: '1190357',
      sourceHash: 'a'.repeat(64),
      generatorVersion: 'new',
      language: 'hebrewEnglish',
      markdown,
    });
    const canonical = await packNote({
      shiurId: candidate.shiurId,
      sourceHash: 'b'.repeat(64),
      generatorVersion: 'old',
      language: 'hebrewEnglish',
      markdown: '# Published notes\n\nExisting complete outline.',
    });
    const backup = join(root, 'notes', candidate.shiurId);
    await mkdir(backup, { recursive: true });
    const { gzip, ...metadata } = candidate;
    await durableWrite(join(backup, 'notes.md.gz'), gzip);
    await durableWrite(join(backup, 'metadata.json'), JSON.stringify(metadata));
    try {
      queue.enqueue([{ id: candidate.shiurId }]);
      const pipeline = new NotesPipeline({
        root,
        queue,
        store: {
          get: async () => (alreadyPublished ? canonical : null),
          publish: async () => canonical,
        },
        generatorVersion: 'new',
        language: 'hebrewEnglish',
        signal: new AbortController().signal,
        fetchTranscript: async () => assert.fail('Unnecessary download'),
        generate: async () => assert.fail('Unnecessary AI call'),
      });
      assert.equal(await pipeline.process(queue.claim()!), 'already_published');
      const savedMetadata = JSON.parse(
        await readFile(join(backup, 'metadata.json'), 'utf8'),
      );
      assert.equal(savedMetadata.notesHash, canonical.notesHash);
      assert.equal(
        await unpackNote({
          ...savedMetadata,
          gzip: new Uint8Array(await readFile(join(backup, 'notes.md.gz'))),
        }),
        '# Published notes\n\nExisting complete outline.',
      );
      const archived = join(backup, 'unpublished', candidate.notesHash);
      assert.deepEqual(
        await readFile(join(archived, 'notes.md.gz')),
        Buffer.from(candidate.gzip),
      );
      assert.equal(
        JSON.parse(await readFile(join(archived, 'metadata.json'), 'utf8'))
          .notesHash,
        candidate.notesHash,
      );
      assert.deepEqual(
        {
          ...queue.db
            .prepare('SELECT status,notes_hash,error FROM jobs WHERE id=?')
            .get(candidate.shiurId),
        },
        { status: 'completed', notes_hash: canonical.notesHash, error: null },
      );
      await assert.rejects(stat(join(root, 'jobs', candidate.shiurId)), {
        code: 'ENOENT',
      });
    } finally {
      queue.close();
      await rm(root, { recursive: true, force: true });
    }
  });
