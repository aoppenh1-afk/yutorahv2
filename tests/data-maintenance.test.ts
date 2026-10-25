import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Pool } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import {
  retainPublishedStorage,
  publicationRetentionBacklog,
} from '../packages/transcription/src/retention';
import { runPublisher } from '../packages/transcription/src/publication';

void test(
  'scheduled search cleanup removes expired caches and orphaned documents while retaining active leases, checkpoints and trending',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const name = 'maintenance_search_' + randomUUID().replaceAll('-', '');
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = '/' + name;
    const pool = new Pool({ connectionString: url.href });
    try {
      await pool.query(`CREATE SCHEMA yutorah_search;
        CREATE TABLE yutorah_search.search_runs(id text PRIMARY KEY,created bigint,next int,total int,fingerprint text,lease bigint);
        CREATE TABLE yutorah_search.search_documents(key text PRIMARY KEY,payload text);
        CREATE TABLE yutorah_search.search_hits(run text REFERENCES yutorah_search.search_runs ON DELETE CASCADE,document_key text REFERENCES yutorah_search.search_documents);
        CREATE TABLE yutorah_search.search_creation_leases(expires bigint);
        CREATE TABLE yutorah_search.sources_runs(id text PRIMARY KEY,payload text,lease bigint,expires bigint);`);
      const now = Date.now();
      for (const [id, age, next, lease] of [
        ['expired', 7200000, 3, 0],
        ['active', 7200000, 3, now + 60000],
        ['checkpoint', 7200000, 1, 0],
        ['old-checkpoint', 90000000, 1, 0],
        ['trending:v1:shared', 90000000, 3, 0],
      ] as const) {
        await pool.query(
          'INSERT INTO yutorah_search.search_runs VALUES($1,$2,$3,30,$1,$4)',
          [id, now - age, next, lease],
        );
        await pool.query(
          'INSERT INTO yutorah_search.search_documents VALUES($1,$2)',
          [id, '{}'],
        );
        await pool.query(
          'INSERT INTO yutorah_search.search_hits VALUES($1,$1)',
          [id],
        );
      }
      await pool.query(
        "INSERT INTO yutorah_search.sources_runs VALUES('preparation:runner-lock','{}',$1,$1),('prepared:creator-v5:42','{}',0,$1)",
        [now + 86400000],
      );
      const run = (...args: string[]) =>
        promisify(execFile)(
          process.execPath,
          ['--import', 'tsx', 'scripts/maintain-data.ts', ...args],
          {
            env: {
              ...process.env,
              SEARCH_DATABASE_URL: url.href,
              TRANSCRIPTION_DATABASE_URL: '',
            },
          },
        );
      await run();
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM yutorah_search.search_runs',
          )
        ).rows[0].n,
        5,
      );
      await run('--apply');
      const kept = ['active', 'checkpoint', 'trending:v1:shared'];
      assert.deepEqual(
        (
          await pool.query(
            'SELECT id FROM yutorah_search.search_runs ORDER BY id',
          )
        ).rows.map((r) => r.id),
        kept,
      );
      assert.deepEqual(
        (
          await pool.query(
            'SELECT key FROM yutorah_search.search_documents ORDER BY key',
          )
        ).rows.map((r) => r.key),
        kept,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM yutorah_search.sources_runs',
          )
        ).rows[0].n,
        2,
      );
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
);

void test(
  'retention drains more than 100 eligible jobs across bounded passes and preserves protected data',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = 'retention_' + randomUUID().replaceAll('-', '');
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema},public`,
    });
    try {
      for (const file of (await readdir('db/transcription')).sort())
        await pool.query(await readFile('db/transcription/' + file, 'utf8'));
      await pool.query(
        "INSERT INTO transcription_versions(id,pipeline_version,skill_hash,skill_text,model,runtime,settings) VALUES('fixture','fixture',$1,'fixture','fixture','fixture','{}')",
        ['a'.repeat(64)],
      );
      const rows = Array.from({ length: 106 }, (_, i) => ({
        id: String(i + 1),
        job: randomUUID(),
        transcript: randomUUID(),
        age: i === 103 ? 2 : 8,
        status: i === 105 ? 'queued' : 'completed',
      }));
      const records = JSON.stringify(rows);
      await pool.query(
        "INSERT INTO transcription_shiurim(id,title,teacher) SELECT id,'Fixture','Fixture' FROM jsonb_to_recordset($1) x(id text)",
        [records],
      );
      await pool.query(
        "INSERT INTO transcription_jobs(id,shiur_id,transcription_version,source_revision,skill_hash,model,status,completed_at) SELECT job,id,'fixture','fixture','fixture','fixture',status,now()-age*interval '1 day' FROM jsonb_to_recordset($1) x(id text,job uuid,age int,status text)",
        [records],
      );
      await pool.query(
        "INSERT INTO transcripts(id,job_id,shiur_id,duration_ms,text,fingerprint) SELECT transcript,job,id,1000,'Preserved public text','fixture' FROM jsonb_to_recordset($1) x(id text,job uuid,transcript uuid)",
        [records],
      );
      await pool.query(
        "INSERT INTO transcription_chunks(job_id,fingerprint,chunk_index,payload,digest) SELECT job,'fixture',0,'{}','fixture' FROM jsonb_to_recordset($1) x(job uuid)",
        [records],
      );
      await pool.query(
        'UPDATE transcription_shiurim h SET active_transcript_id=x.transcript,latest_job_id=x.job FROM jsonb_to_recordset($1) x(id text,job uuid,transcript uuid) WHERE h.id=x.id',
        [records],
      );
      await pool.query(
        "UPDATE transcript_publications SET published_generation=generation,content_changed=false WHERE shiur_id<>'105'",
      );
      const before = await publicationRetentionBacklog(pool);
      assert.equal(before.jobs, 103);
      assert.ok(before.oldestMs >= 8 * 86400000);
      assert.equal((await retainPublishedStorage(pool, true)).checkpoints, 100);
      assert.equal((await publicationRetentionBacklog(pool)).jobs, 3);
      assert.equal((await retainPublishedStorage(pool, true)).checkpoints, 3);
      assert.equal((await publicationRetentionBacklog(pool)).jobs, 0);
      assert.deepEqual(
        (
          await pool.query(
            'SELECT shiur_id FROM transcription_jobs j JOIN transcription_chunks c ON c.job_id=j.id ORDER BY shiur_id',
          )
        ).rows.map((row) => row.shiur_id),
        ['104', '105', '106'],
      );
      assert.equal(
        (await pool.query('SELECT COUNT(*)::int AS n FROM transcripts')).rows[0]
          .n,
        106,
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

void test(
  'maintenance preserves active, recent and unpublished versions and verifies backups before pruning',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = 'maintenance_' + randomUUID().replaceAll('-', '');
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const root = await mkdtemp(join(tmpdir(), 'transcript-maintenance-'));
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema},public`,
    });
    try {
      for (const file of (await readdir('db/transcription')).sort())
        await pool.query(await readFile('db/transcription/' + file, 'utf8'));
      await pool.query(
        "INSERT INTO transcription_versions(id,pipeline_version,skill_hash,skill_text,model,runtime,settings) VALUES('fixture','fixture',$1,'fixture','fixture','fixture','{}')",
        ['a'.repeat(64)],
      );
      await pool.query(
        "INSERT INTO transcription_shiurim(id,title,teacher) VALUES('42','Published','Fixture'),('43','Unpublished','Fixture')",
      );
      const versions = [
        'active',
        'old',
        'recent',
        'pendingActive',
        'pendingOld',
      ];
      const transcripts = new Map<string, string>();
      const jobs = new Map<string, string>();
      for (const version of versions) {
        const transcript = randomUUID();
        const job = randomUUID();
        const shiur = version.startsWith('pending') ? '43' : '42';
        transcripts.set(version, transcript);
        jobs.set(version, job);
        await pool.query(
          `INSERT INTO transcription_jobs(id,shiur_id,transcription_version,source_revision,skill_hash,model,status,completed_at)
          VALUES($1,$2,'fixture',$3,'fixture','fixture','completed',now()-($4::int*interval '1 day'))`,
          [job, shiur, version, version === 'recent' ? 2 : 120],
        );
        await pool.query(
          "INSERT INTO transcripts(id,job_id,shiur_id,duration_ms,text,fingerprint) VALUES($1,$2,$3,1000,$4,'fixture')",
          [transcript, job, shiur, version],
        );
        await pool.query(
          'INSERT INTO transcript_segments(transcript_id,shiur_id,segment_index,start_ms,end_ms,text,search_text,search_window) VALUES($1,$2,0,0,1000,$3,$3,$3)',
          [transcript, shiur, version],
        );
        await pool.query(
          "INSERT INTO transcription_chunks(job_id,fingerprint,chunk_index,payload,digest) VALUES($1,'fixture',0,'{}','fixture')",
          [job],
        );
      }
      for (const [shiur, version] of [
        ['42', 'active'],
        ['43', 'pendingActive'],
      ])
        await pool.query(
          'UPDATE transcription_shiurim SET active_transcript_id=$2,latest_job_id=$3 WHERE id=$1',
          [shiur, transcripts.get(version), jobs.get(version)],
        );
      await pool.query(
        "UPDATE transcript_publications SET published_generation=generation,content_changed=false WHERE shiur_id='42'",
      );
      await pool.query(
        "INSERT INTO notes_versions VALUES('fixture','fixture','english','fixture','fixture','fixture')",
      );
      const notesId = randomUUID();
      await pool.query(
        "INSERT INTO notes_jobs(id,transcript_id,version_id,status) VALUES($1,$2,'fixture','completed')",
        [notesId, transcripts.get('old')],
      );
      await pool.query(
        'INSERT INTO transcript_notes(id,transcript_id,markdown) VALUES($1,$2,$3)',
        [notesId, transcripts.get('old'), '# Archived notes'],
      );
      const activeNotes = randomUUID();
      await pool.query(
        "INSERT INTO notes_jobs(id,transcript_id,version_id,status,cleaned_text,completed_at) VALUES($1,$2,'fixture','completed','Intermediate text',now()-interval '8 days')",
        [activeNotes, transcripts.get('active')],
      );
      await pool.query(
        "INSERT INTO transcript_notes(id,transcript_id,markdown) VALUES($1,$2,'# Final notes')",
        [activeNotes, transcripts.get('active')],
      );
      await pool.query(
        "INSERT INTO notes_versions VALUES('missing-final','fixture','english','fixture','fixture','fixture')",
      );
      const missingFinal = randomUUID();
      await pool.query(
        "INSERT INTO notes_jobs(id,transcript_id,version_id,status,cleaned_text,completed_at) VALUES($1,$2,'missing-final','completed','Keep without final notes',now()-interval '8 days')",
        [missingFinal, transcripts.get('active')],
      );
      await pool.query(
        "UPDATE transcript_publications SET published_generation=generation,content_changed=false WHERE shiur_id='42'",
      );
      assert.deepEqual(await retainPublishedStorage(pool), {
        jobs: 1,
        checkpoints: 1,
        cleanedNotes: 1,
        applied: false,
      });
      await pool.query(
        "UPDATE transcription_jobs SET completed_at=now()-interval '2 days' WHERE id=$1",
        [jobs.get('active')],
      );
      assert.equal((await retainPublishedStorage(pool, true)).checkpoints, 0);
      await pool.query(
        "UPDATE transcription_jobs SET completed_at=now()-interval '120 days' WHERE id=$1",
        [jobs.get('active')],
      );
      // Automatic cleanup must also run while no new publication is due.
      await pool.query(
        "UPDATE transcript_publications SET available_at=now()+interval '1 day'",
      );
      const abort = new AbortController();
      const publisher = runPublisher(
        pool,
        {
          publish: async () => {
            throw new Error('No publication is due');
          },
        },
        abort.signal,
      );
      try {
        const deadline = Date.now() + 5000;
        while (
          (
            await pool.query(
              'SELECT 1 FROM transcription_chunks WHERE job_id=$1',
              [jobs.get('active')],
            )
          ).rowCount
        ) {
          assert.ok(
            Date.now() < deadline,
            'idle publisher runs eligible retention',
          );
          await delay(10);
        }
      } finally {
        abort.abort();
        await publisher;
      }
      assert.equal(
        (await pool.query('SELECT count(*) FROM transcription_chunks')).rows[0]
          .count,
        '4',
      );
      const cleaned = (
        await pool.query('SELECT cleaned_text FROM notes_jobs WHERE id=$1', [
          activeNotes,
        ])
      ).rows[0];
      assert.equal(cleaned.cleaned_text, null);
      assert.equal(
        (
          await pool.query(
            'SELECT markdown FROM transcript_notes WHERE id=$1',
            [activeNotes],
          )
        ).rows[0].markdown,
        '# Final notes',
      );
      assert.equal(
        (
          await pool.query('SELECT cleaned_text FROM notes_jobs WHERE id=$1', [
            missingFinal,
          ])
        ).rows[0].cleaned_text,
        'Keep without final notes',
      );
      assert.equal(
        (await retainPublishedStorage(pool)).jobs,
        0,
        'inputs without final notes do not block later cleanup batches',
      );
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.searchParams.set('options', `-c search_path=${schema},public`);
      const run = (...args: string[]) =>
        promisify(execFile)(
          process.execPath,
          ['--import', 'tsx', 'scripts/maintain-data.ts', ...args],
          {
            env: {
              ...process.env,
              SEARCH_DATABASE_URL: '',
              TRANSCRIPTION_DATABASE_URL: url.href,
            },
          },
        );
      await run('--prune-inactive', '--backup-dir', root);
      assert.equal(
        (await pool.query('SELECT count(*) FROM transcripts')).rows[0].count,
        '5',
      );
      assert.deepEqual(await readdir(root), [], 'dry runs write no backups');
      const file = join(root, transcripts.get('old')! + '.json.gz');
      await writeFile(file, gzipSync('wrong backup'));
      await assert.rejects(
        run('--apply', '--prune-inactive', '--backup-dir', root),
        /Backup verification failed/,
      );
      assert.equal(
        (await pool.query('SELECT count(*) FROM transcripts')).rows[0].count,
        '5',
      );
      await rm(file);
      await run('--apply', '--prune-inactive', '--backup-dir', root);
      assert.equal(
        (await pool.query('SELECT count(*) FROM transcripts')).rows[0].count,
        '4',
      );
      assert.equal(
        (
          await pool.query('SELECT id FROM transcripts WHERE id=$1', [
            transcripts.get('old'),
          ])
        ).rowCount,
        0,
      );
      const backup = JSON.parse(gunzipSync(await readFile(file)).toString());
      assert.equal(backup.transcript.text, 'old');
      assert.equal(backup.segments[0].text, 'old');
      assert.equal(backup.notes[0].markdown, '# Archived notes');
      assert.equal(backup.jobs[0].id, notesId);
      await assert.rejects(
        run('--apply', '--prune-inactive', '--backup-dir'),
        /requires --backup-dir/,
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
