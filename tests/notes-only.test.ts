import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NotesQueue } from '../packages/notes-only/src/queue';
import { NotesPipeline } from '../packages/notes-only/src/pipeline';
import { packNote, unpackNote, type SavedNote } from '../lib/tidb-notes-store';
const vtt =
  'WEBVTT\n\n00:00.000 --> 00:02.000\nShalom שלום תשובה\n\n00:01.900 --> 00:03.000\nFull second cue\n';
const markdown = '# תשובה\n\n## Teaching\n\n- Shalom שלום\n';
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
