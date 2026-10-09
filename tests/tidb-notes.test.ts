import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  TiDBNotesStore,
  hex,
  packNote,
  type SavedNote,
} from '../lib/tidb-notes-store';
import { hostedNotes } from '../lib/tidb-notes';

const credential = {
  host: 'gateway01.us-east-1.prod.aws.tidbcloud.com',
  username: 'synthetic-reader',
  password: 'synthetic',
  database: 'test_notes',
};
async function note(id: string) {
  return packNote({
    shiurId: id,
    sourceHash: 'a'.repeat(64),
    generatorVersion: 'test',
    language: 'hebrewEnglish',
    markdown: '# תשובה\n\n## Teaching\n\n- Full stored notes.',
  });
}
function wire(saved: SavedNote | null) {
  const fields = [
    ['shiur_id', 'BIGINT'],
    ['source_sha256', 'BINARY'],
    ['notes_sha256', 'BINARY'],
    ['generator_version', 'VARCHAR'],
    ['language', 'VARCHAR'],
    ['raw_bytes', 'INT'],
    ['created_at_ms', 'BIGINT'],
    ['notes_gzip', 'MEDIUMBLOB'],
  ];
  return Response.json(
    {
      types: fields.map(([name, type]) => ({ name, type })),
      rows: saved
        ? [
            [
              saved.shiurId,
              saved.sourceHash,
              saved.notesHash,
              saved.generatorVersion,
              saved.language,
              saved.rawBytes,
              saved.createdAtMs,
              hex(saved.gzip),
            ],
          ]
        : [],
    },
    { headers: { 'TiDB-Session': 'synthetic' } },
  );
}
function environment(t: TestContext) {
  for (const [field, value] of Object.entries(credential)) {
    const key = 'TIDB_NOTES_' + field.toUpperCase();
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}
function sqlQuery(init: RequestInit) {
  assert.ok(typeof init.body === 'string');
  return JSON.parse(init.body).query as string;
}
void test('normal publication writes one row and verifies it with one primary-key read', async (t) => {
  const saved = await note('2170001');
  const queries: string[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init: RequestInit) => {
      const query = sqlQuery(init);
      queries.push(query);
      if (query.startsWith('INSERT'))
        return Response.json(
          { types: [], rows: [], rowsAffected: 1 },
          { headers: { 'TiDB-Session': 'synthetic' } },
        );
      assert.match(query, /WHERE shiur_id = /);
      return wire(saved);
    },
  );
  await new TiDBNotesStore(credential).publish(saved);
  assert.equal(queries.length, 2);
  assert.ok(queries[0].startsWith('INSERT'));
  assert.ok(queries[1].startsWith('SELECT'));
});
void test('a lost upload acknowledgement verifies the saved row without reading its blob twice', async (t) => {
  const saved = await note('2170002');
  let reads = 0,
    writes = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init: RequestInit) => {
      const query = sqlQuery(init);
      if (query.startsWith('INSERT')) {
        writes++;
        throw new Error('Acknowledgement lost');
      }
      reads++;
      return wire(saved);
    },
  );
  await new TiDBNotesStore(credential).publish(saved);
  assert.equal(writes, 1);
  assert.equal(reads, 1);
});
void test('simultaneous and repeated website reads share one TiDB lookup, including ETags', async (t) => {
  environment(t);
  const saved = await note('2170003');
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    reads++;
    return wire(saved);
  });
  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      hostedNotes(saved.shiurId, i % 2 ? `"${saved.notesHash}"` : undefined),
    ),
  );
  assert.equal(reads, 1);
  assert.deepEqual(
    responses.map((r) => r.status),
    Array.from({ length: 20 }, (_, i) => (i % 2 ? 304 : 200)),
  );
  assert.match(responses[0].headers.get('Cache-Control')!, /s-maxage=3600/);
  await hostedNotes(saved.shiurId);
  assert.equal(reads, 1);
});
void test('missing notes are cached briefly and a database outage creates a shared cooldown', async (t) => {
  environment(t);
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  let reads = 0,
    unavailable = false;
  t.mock.method(globalThis, 'fetch', async () => {
    reads++;
    return unavailable
      ? Response.json({ message: 'Quota unavailable' }, { status: 503 })
      : wire(null);
  });
  assert.equal((await hostedNotes('2170004')).status, 200);
  await hostedNotes('2170004');
  assert.equal(reads, 1);
  clock += 61_000;
  await hostedNotes('2170004');
  assert.equal(reads, 2);
  unavailable = true;
  assert.equal((await hostedNotes('2170005')).status, 503);
  assert.equal((await hostedNotes('2170006')).status, 503);
  assert.equal(
    reads,
    3,
    'different shiur IDs share the database failure cooldown',
  );
  clock += 61_000;
  unavailable = false;
  assert.equal((await hostedNotes('2170006')).status, 200);
  assert.equal(reads, 4, 'lookups resume after the cooldown expires');
});
