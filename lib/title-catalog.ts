import { normalize, upstream } from './yutorah';
import type { SearchResponse } from './api-types';
import type { SearchDatabase } from './search-storage';
import { indexTitleStatements } from './title-index';

/** Backfill vocabulary from the existing full archive, without downloading media.
 * Commit titles and cursor together; retries are idempotent. Refresh page one
 * on resumed passes so newly published titles are also learned.
 */
export async function refreshTitleCatalog(db: SearchDatabase, maxPages = 4) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000)
    throw new RangeError('Choose between 1 and 1000 archive pages per pass.');
  await db
    .prepare(
      "INSERT INTO search_title_cursors(name,next) VALUES('archive',1) ON CONFLICT(name) DO NOTHING",
    )
    .run();
  const cursor = await db
    .prepare("SELECT next FROM search_title_cursors WHERE name='archive'")
    .first<{ next: number }>();
  let next = cursor?.next ?? 1;
  let expected = next;
  let scanned = 0,
    total = 0,
    complete = false;
  const fetchPage = async (page: number) => {
    const result = await upstream<SearchResponse>(
      `search/get?${new URLSearchParams({ searchTerm: '', getFacets: 'false', start: String(page) })}`,
      0,
    );
    if (
      !Array.isArray(result.response?.docs) ||
      !Number.isSafeInteger(result.response.numFound) ||
      result.response.numFound < 0
    )
      throw new Error('The archive returned an invalid title page.');
    const expected = Math.max(
      0,
      Math.min(30, result.response.numFound - (page - 1) * 30),
    );
    if (result.response.docs.length !== expected)
      throw new Error(
        'The archive returned an incomplete title page. Retry this pass.',
      );
    return result.response;
  };
  if (next > 1) {
    const recent = await fetchPage(1);
    total = recent.numFound;
    await db.batch(
      indexTitleStatements(
        db,
        recent.docs.map((raw) => normalize(raw)),
      ),
    );
    if ((next - 1) * 30 >= total) next = 1;
  }
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(next);
    total = page.numFound;
    const owner = crypto.randomUUID();
    await db.batch([
      db.prepare(
        "UPDATE search_title_cursors SET next=next WHERE name='archive'",
      ),
      db
        .prepare(
          "INSERT INTO search_pass_guards(run,owner,valid) SELECT 'title-refresh',?,CASE WHEN EXISTS(SELECT 1 FROM search_title_cursors WHERE name='archive' AND next=?) THEN 1 ELSE 0 END",
        )
        .bind(owner, expected),
      ...indexTitleStatements(
        db,
        page.docs.map((raw) => normalize(raw)),
      ),
      db
        .prepare(
          "UPDATE search_title_cursors SET next=? WHERE name='archive' AND next=?",
        )
        .bind(next + 1, expected),
      db
        .prepare(
          "UPDATE search_pass_guards SET valid=CASE WHEN EXISTS(SELECT 1 FROM search_title_cursors WHERE name='archive' AND next=?) THEN 1 ELSE 0 END WHERE run='title-refresh' AND owner=?",
        )
        .bind(next + 1, owner),
      db
        .prepare(
          "DELETE FROM search_pass_guards WHERE run='title-refresh' AND owner=?",
        )
        .bind(owner),
    ]);
    scanned += page.docs.length;
    next++;
    expected = next;
    if ((next - 1) * 30 >= total) {
      complete = true;
      break;
    }
  }
  const coverage = await db
    .prepare('SELECT COUNT(*) AS titles FROM search_title_catalog')
    .first<{ titles: number }>();
  return {
    scanned,
    titles: coverage?.titles ?? 0,
    total,
    nextPage: next,
    complete,
  };
}
