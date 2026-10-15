import { DatabaseSync } from 'node:sqlite';
import { openSync, writeSync, closeSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Export a completed immutable title snapshot using PostgreSQL COPY's text
// format. The generated import refuses a nonempty destination and commits all
// tables and the restored catalog trigger together. No credentials in files.
const [snapshot, output] = process.argv.slice(2);
if (!snapshot || !output)
  throw new Error(
    'Usage: prepare-search-postgres.ts SNAPSHOT.sqlite OUTPUT.sql',
  );
const source = new DatabaseSync(snapshot, { readOnly: true });
const tables = [
  ['search_title_terms', ['term', 'words', 'documents'], 'term'],
  ['search_title_catalog', ['id', 'title', 'terms'], 'id'],
  ['search_title_keys', ['key', 'term'], 'key,term'],
  ['search_title_cursors', ['name', 'next'], 'name'],
  [
    'search_title_imports',
    [
      'name',
      'minimum',
      'maximum',
      'next',
      'total',
      'scanned',
      'started',
      'completed',
    ],
    'name',
  ],
] as const;
const escaped: Record<string, string> = {
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\v': '\\v',
};
const field = (value: unknown) => {
  if (value === null) return '\\N';
  if (!['string', 'number', 'bigint'].includes(typeof value))
    throw new TypeError('Unsupported snapshot field.');
  return String(value as string | number | bigint).replace(
    /[\\\b\f\n\r\t\v]/g,
    (char) => escaped[char],
  );
};
const file = openSync(output, 'wx', 0o600);
try {
  const manifest = source
    .prepare("SELECT * FROM search_title_imports WHERE name='archive'")
    .get();
  if (!manifest?.completed || manifest.scanned !== manifest.total)
    throw new Error('Finish and audit the source archive first.');
  const count = source
    .prepare(
      'SELECT COUNT(*) AS count FROM search_title_catalog WHERE id BETWEEN ? AND ?',
    )
    .get(manifest.minimum!, manifest.maximum!)?.count;
  if (count !== manifest.total)
    throw new Error('The source archive is incomplete.');
  writeSync(
    file,
    `BEGIN;
SELECT pg_advisory_xact_lock(1790900494);
DO $$ BEGIN
IF EXISTS(SELECT 1 FROM yutorah_search.search_title_catalog)
 OR EXISTS(SELECT 1 FROM yutorah_search.search_title_terms)
 OR EXISTS(SELECT 1 FROM yutorah_search.search_title_keys)
 OR EXISTS(SELECT 1 FROM yutorah_search.search_runs)
 OR EXISTS(SELECT 1 FROM yutorah_search.search_title_imports)
 OR EXISTS(SELECT 1 FROM yutorah_search.search_title_cursors)
THEN RAISE EXCEPTION 'Search import requires an empty destination'; END IF;
END $$;
ALTER TABLE yutorah_search.search_title_catalog DISABLE TRIGGER search_title_changes;
`,
  );
  const audit = [];
  for (const [table, columns, order] of tables) {
    const keyTable = table === 'search_title_keys';
    const destination = keyTable ? 'search_title_word_keys' : table;
    const copyColumns = keyTable ? ['term', 'prefix', 'keys'] : columns;
    const select = keyTable
      ? "SELECT term,MAX(CASE WHEN key LIKE 'p:%' THEN key END) AS prefix,json_group_array(key) FILTER (WHERE key LIKE 'd:%' OR key LIKE 'v:%') AS keys FROM search_title_keys WHERE key LIKE 'd:%' OR key LIKE 'p:%' OR key LIKE 'v:%' GROUP BY term ORDER BY term"
      : `SELECT ${columns.join(',')} FROM ${table} ORDER BY ${order}`;
    writeSync(
      file,
      `COPY yutorah_search.${destination} (${copyColumns.join(',')}) FROM STDIN;
`,
    );
    const hash = createHash('sha256');
    let count = 0,
      buffer = '';
    for (const row of source.prepare(select).iterate()) {
      const line =
        copyColumns
          .map((column) => {
            if (keyTable && column === 'keys') {
              if (typeof row.keys !== 'string')
                throw new TypeError('Invalid word keys.');
              const keys = JSON.parse(row.keys) as string[];
              return field(
                '{' + keys.map((key) => JSON.stringify(key)).join(',') + '}',
              );
            }
            return field(row[column]);
          })
          .join('\t') + '\n';
      if (!keyTable) hash.update(line);
      buffer += line;
      count++;
      if (buffer.length >= 131072) {
        writeSync(file, buffer);
        buffer = '';
      }
    }
    if (buffer) writeSync(file, buffer);
    writeSync(file, '\\.\n');
    if (keyTable) {
      count = 0;
      for (const row of source
        .prepare('SELECT key,term FROM search_title_keys ORDER BY key,term')
        .iterate()) {
        hash.update(
          columns.map((column) => field(row[column])).join('\t') + '\n',
        );
        count++;
      }
    }
    audit.push({ table, columns, order, count, hash: hash.digest('hex') });
    console.log(JSON.stringify({ table, count }));
  }
  writeSync(
    file,
    `ALTER TABLE yutorah_search.search_title_catalog ENABLE TRIGGER search_title_changes;
COMMIT;
ANALYZE yutorah_search.search_title_catalog;
ANALYZE yutorah_search.search_title_terms;
ANALYZE yutorah_search.search_title_word_keys;
`,
  );
  writeFileSync(
    output + '.audit.json',
    JSON.stringify({ manifest, tables: audit }, null, 2),
    { flag: 'wx', mode: 0o600 },
  );
} finally {
  closeSync(file);
  source.close();
}
