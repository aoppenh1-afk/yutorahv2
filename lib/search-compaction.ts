import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';

export function searchSchemaName(schema: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(schema))
    throw new TypeError('Invalid search schema.');
  return schema;
}

/** No vocabulary is pruned. Only lists equal to their regenerated value are
 * removed, with title writers serialized under their existing transaction lock.
 * Unicode exceptions keep their original lists. The numeric cursor is resumable.
 */
export async function compactSearchTitleBatch(
  client: PoolClient,
  schema = 'yutorah_search',
  after = 0,
  limit = 500,
) {
  searchSchemaName(schema);
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 2000
  )
    throw new RangeError('Invalid compaction cursor or batch size.');
  await client.query('BEGIN');
  try {
    await client.query(
      'SELECT pg_advisory_xact_lock(1790900494,hashtext($1))',
      [schema],
    );
    const { rows } = await client.query<{
      id: number;
      title: string;
      terms: string;
      regenerated: string;
    }>(
      `SELECT id,title,terms,${schema}.title_terms(title) AS regenerated FROM ${schema}.search_title_catalog
       WHERE id>$1 AND terms IS NOT NULL ORDER BY id LIMIT $2 FOR UPDATE`,
      [after, limit],
    );
    const canonical = (terms: string) => JSON.stringify(JSON.parse(terms));
    const candidates = rows.filter(
      (row) => canonical(row.terms) === canonical(row.regenerated),
    );
    const hash = (records: { id: number; title: string; terms: string }[]) => {
      const digest = createHash('sha256');
      for (const row of records)
        digest.update(
          JSON.stringify([row.id, row.title, JSON.parse(row.terms)]) + '\n',
        );
      return digest.digest('hex');
    };
    if (candidates.length) {
      await client.query(
        `UPDATE ${schema}.search_title_catalog SET terms=NULL WHERE id=ANY($1::int[])`,
        [candidates.map((row) => row.id)],
      );
      const verified = await client.query<{
        id: number;
        title: string;
        terms: string;
      }>(
        `SELECT id,title,COALESCE(terms,${schema}.title_terms(title)) AS terms FROM ${schema}.search_title_catalog WHERE id=ANY($1::int[]) ORDER BY id`,
        [rows.map((row) => row.id)],
      );
      if (hash(rows) !== hash(verified.rows))
        throw new Error(
          'Compaction changed logical title data; batch rolled back.',
        );
    }
    await client.query('COMMIT');
    return {
      scanned: rows.length,
      compacted: candidates.length,
      exceptions: rows.length - candidates.length,
      logicalBytesRemoved: candidates.reduce(
        (bytes, row) => bytes + Buffer.byteLength(row.terms, 'utf8'),
        0,
      ),
      after: rows.at(-1)?.id ?? after,
      complete: rows.length < limit,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
