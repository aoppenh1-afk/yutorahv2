import {
  getDirectory,
  parseSearch,
  upstream,
  normalize,
  mediaKind,
  type SearchPlan,
  type SearchResult,
  type Shiur,
} from './yutorah';
import type { SearchResponse } from './api-types';
import type { SearchDatabase, SearchStatement } from './search-storage';
import { relevanceScore, searchText } from './search-discovery';
import {
  librarySearchQuery,
  matchQuery,
  searchVocabulary,
} from './search-matching';

type Run = {
  id: string;
  plan: string;
  total: number;
  next: number;
  created: number;
  lease: number;
};
const pageSize = 30;
const sorts: Record<string, string> = {
  relevance: 'rank DESC, id DESC',
  new: 'date DESC, id DESC',
  old: 'date ASC, id ASC',
  short: 'CASE WHEN duration = 0 THEN 1 ELSE 0 END, duration ASC, id DESC',
  long: 'duration DESC, id DESC',
  title: 'title ASC, id DESC',
  library: 'position ASC, id DESC',
};
export class SearchChangedError extends Error {}

function sourceParams(plan: SearchPlan, query: string, page: number) {
  const p = new URLSearchParams({
    searchTerm: query,
    getFacets: 'false',
    start: String(page),
  });
  if (plan.teacherId) p.set('teacherID', String(plan.teacherId));
  if (plan.seriesId) p.set('seriesID', String(plan.seriesId));
  if (plan.topicId) p.set('subcategoryID', String(plan.topicId));
  return 'search/get?' + p;
}

/** Bounded, resumable passes. A database transaction commits each pass with its cursor. */
export async function completeSearch(
  db: SearchDatabase,
  query: string,
  options: Partial<SearchPlan>,
  page = 1,
  runId = '',
): Promise<SearchResult> {
  const directory = await getDirectory();
  const plan = parseSearch(query, options, directory);
  if (plan.min && plan.max && plan.min > plan.max)
    throw new RangeError('Minimum duration must not exceed maximum duration.');
  const sourceQuery = librarySearchQuery(
    plan.term || plan.phrase || '',
    searchVocabulary([
      ...directory.teachers.map((teacher) => teacher.name),
      ...directory.topics.map((topic) => topic.name),
      ...directory.series.map((series) => series.name),
    ]),
  );
  // Cache the actual expansion independently of refinements and sorting. A
  // vocabulary change must never resume a pass using different candidates.
  const criteria = {
    version: 3,
    term: sourceQuery,
    teacher: plan.teacherId,
    topic: plan.topicId,
    series: plan.seriesId,
  };
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(criteria)),
  );
  const fingerprint = Array.from(new Uint8Array(digest), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
  const cutoff = Date.now() - 60 * 60 * 1000;
  const activeCutoff = Date.now() - 24 * 60 * 60 * 1000;
  let run = runId
    ? await db
        .prepare(
          'SELECT * FROM search_runs WHERE id = ? AND fingerprint = ? AND (created > ? OR (created > ? AND (next - 1) * 30 < total))',
        )
        .bind(runId, fingerprint, cutoff, activeCutoff)
        .first<Run>()
    : null;
  if (!run)
    run = await db
      .prepare(
        'SELECT * FROM search_runs WHERE fingerprint = ? AND (created > ? OR (created > ? AND (next - 1) * 30 < total)) ORDER BY created DESC LIMIT 1',
      )
      .bind(fingerprint, cutoff, activeCutoff)
      .first<Run>();
  if (!run) {
    const first = await upstream<SearchResponse>(
      sourceParams(plan, sourceQuery, 1),
      0,
    );
    if (
      !Array.isArray(first.response?.docs) ||
      !Number.isSafeInteger(first.response.numFound) ||
      first.response.numFound < 0
    )
      throw new Error('Search is unavailable.');
    run = {
      id: crypto.randomUUID(),
      plan: JSON.stringify(plan),
      total: first.response.numFound,
      next: 1,
      created: Date.now(),
      lease: 0,
    };
    await db.batch([
      db
        .prepare(
          'DELETE FROM search_runs WHERE id IN (SELECT id FROM search_runs WHERE created < ? AND ((next - 1) * 30 >= total OR created < ?) LIMIT 5)',
        )
        .bind(cutoff, activeCutoff),
      db
        .prepare(
          'INSERT INTO search_runs (id,fingerprint,plan,total,next,created,lease) VALUES (?,?,?,?,1,?,0)',
        )
        .bind(run.id, fingerprint, run.plan, run.total, run.created),
    ]);
  }
  const pages = Math.ceil(run.total / pageSize);
  if (run.next <= pages) {
    const lease = Date.now() + 30000;
    const acquired = await db
      .prepare(
        'UPDATE search_runs SET lease = ? WHERE id = ? AND lease < ? AND next = ?',
      )
      .bind(lease, run.id, Date.now(), run.next)
      .run();
    if (acquired.meta.changes) {
      try {
        const end = Math.min(pages + 1, run.next + 4);
        const batches = await Promise.all(
          Array.from({ length: end - run.next }, (_, i) =>
            upstream<SearchResponse>(
              sourceParams(plan, sourceQuery, run!.next + i),
              0,
            ),
          ),
        );
        if (
          batches.some(
            (b) =>
              !Array.isArray(b.response?.docs) ||
              b.response.numFound !== run!.total,
          )
        )
          throw new SearchChangedError(
            'The library changed during this search. Start the search again for a fresh count.',
          );
        const rows = batches.flatMap((b, i) => {
          const expected = Math.min(
            pageSize,
            run!.total - (run!.next + i - 1) * pageSize,
          );
          if (b.response.docs.length !== expected)
            throw new Error(
              'An incomplete search page was received. Please retry.',
            );
          return b.response.docs.map((raw, j) => {
            const s = normalize(raw);
            return [
              run!.id,
              s.id,
              JSON.stringify(s),
              matchQuery(s.title, plan.term) ? 1 : 0,
              searchText(
                [s.title, s.teacher, s.series, ...s.topics, s.description].join(
                  ' ',
                ),
              ),
              s.language,
              mediaKind(s),
              relevanceScore(s, plan.term || plan.phrase || ''),
              Date.parse(s.date) || 0,
              s.duration,
              searchText(s.title),
              (run!.next + i - 1) * pageSize + j,
            ];
          });
        });
        const statements: SearchStatement[] = [];
        for (let i = 0; i < rows.length; i += 8) {
          const group = rows.slice(i, i + 8);
          statements.push(
            db
              .prepare(
                `INSERT OR IGNORE INTO search_hits (run,id,payload,matched,search,language,format,rank,date,duration,title,position) VALUES ${group.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}`,
              )
              .bind(...group.flat()),
          );
        }
        statements.push(
          db
            .prepare(
              'UPDATE search_runs SET next = ?, lease = 0, created = CASE WHEN ? THEN ? ELSE created END WHERE id = ? AND lease = ?',
            )
            .bind(end, end > pages ? 1 : 0, Date.now(), run.id, lease),
        );
        await db.batch(statements);
        run.next = end;
      } catch (e) {
        await db
          .prepare(
            'UPDATE search_runs SET lease = 0 WHERE id = ? AND lease = ?',
          )
          .bind(run.id, lease)
          .run();
        if (e instanceof SearchChangedError)
          await db
            .prepare('DELETE FROM search_runs WHERE id = ?')
            .bind(run.id)
            .run();
        throw e;
      }
    } else {
      run = (await db
        .prepare('SELECT * FROM search_runs WHERE id = ?')
        .bind(run.id)
        .first<Run>())!;
    }
  }
  const complete = run.next > pages;
  const predicates = ['run = ?'];
  const args: (string | number)[] = [run.id];
  const add = (sql: string, value: string | number) => {
    predicates.push(sql);
    args.push(value);
  };
  if (plan.min) add('duration >= ?', plan.min * 60);
  if (plan.max) {
    predicates.push('duration > 0');
    add('duration <= ?', plan.max * 60);
  }
  if (plan.after) add('date >= ?', Date.parse(plan.after + 'T00:00:00Z'));
  if (plan.before) {
    predicates.push('date > 0');
    add('date < ?', Date.parse(plan.before + 'T00:00:00Z') + 86400000);
  }
  if (plan.language) add('language = ?', plan.language);
  if (plan.format) add('format = ?', plan.format);
  const field = plan.scope === 'title' ? 'title' : 'search';
  if (plan.phrase)
    add(`instr(' ' || ${field} || ' ', ?) > 0`, ` ${searchText(plan.phrase)} `);
  const excluded = searchText(plan.exclude || '')
    .split(' ')
    .filter(Boolean);
  if (excluded.length)
    add(
      `NOT EXISTS (SELECT 1 FROM json_each(?) AS word WHERE instr(' ' || ${field} || ' ', ' ' || word.value || ' ') > 0)`,
      JSON.stringify(excluded),
    );
  if (plan.scope === 'title' && plan.term) predicates.push('matched = 1');
  const where = predicates.join(' AND ');
  const counts = await db
    .prepare('SELECT COUNT(*) AS scanned FROM search_hits WHERE run = ?')
    .bind(run.id)
    .first<{ scanned: number }>();
  const matched = await db
    .prepare(`SELECT COUNT(*) AS matches FROM search_hits WHERE ${where}`)
    .bind(...args)
    .first<{ matches: number }>();
  if (complete && counts!.scanned !== run.total) {
    await db.prepare('DELETE FROM search_runs WHERE id = ?').bind(run.id).run();
    throw new SearchChangedError(
      'The library changed during this search. Please search again.',
    );
  }
  const order = sorts[plan.sort || 'relevance'] || sorts.relevance;
  const data = await db
    .prepare(
      `SELECT payload FROM search_hits WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
    .bind(...args, pageSize, complete ? (page - 1) * pageSize : 0)
    .all<{ payload: string }>();
  return {
    items: data.results.map((r) => JSON.parse(r.payload) as Shiur),
    total: matched!.matches,
    sourceTotal: run.total,
    scanned: counts!.scanned,
    complete,
    run: run.id,
    plan,
    filtered: false,
    nextPage: complete && page * pageSize < matched!.matches ? page + 1 : null,
    facets: { teachers: [], topics: [], series: [] },
  };
}
