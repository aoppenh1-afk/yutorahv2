import {
  getDirectory,
  parseSearch,
  upstream,
  SearchReadError,
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
  interpretSpacing,
  searchRetrieval,
  searchVocabulary,
} from './search-matching';
import {
  indexTitleStatements,
  seedCachedTitles,
  titleVocabulary,
} from './title-index';

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
  popular:
    "COALESCE(json_extract(payload, '$.views'), 0) DESC, rank DESC, id DESC",
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
  // The expansion is snapshotted on the run. Learning more titles must not
  // change a pending scan's source query, title matching, or candidate counts.
  const criteria = {
    version: 9,
    term: plan.term || plan.phrase || '',
    quoted: /"[^"]+"/.test(query),
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
  let firstPage: SearchResponse | undefined;
  type Expansion = {
    sourceQuery: string;
    related: boolean;
    searchTerm: string;
    vocabulary: string[];
    corrections: string[];
  };
  let expansion = run ? (JSON.parse(run.plan) as Expansion) : null;
  if (!expansion) {
    await seedCachedTitles(db);
    const learned = await titleVocabulary(db, plan.term);
    const spacing = interpretSpacing(plan.term, learned.phrases);
    expansion = {
      sourceQuery: '',
      related: false,
      searchTerm: spacing.term,
      corrections: spacing.labels,
      vocabulary: [
        ...new Set([
          ...learned.words,
          ...searchVocabulary([
            ...directory.teachers.map((teacher) => teacher.name),
            ...directory.topics.map((topic) => topic.name),
            ...directory.series.map((series) => series.name),
          ]),
        ]),
      ],
    };
  }
  plan.labels.push(...expansion.corrections);
  // Keep the parsed request in the public plan: the UI resumes with plan.term.
  // The repaired retrieval term lives in the run snapshot independently.
  const retrieval = searchRetrieval(
    expansion.searchTerm || plan.phrase || '',
    expansion.vocabulary,
  );
  const relatedQuery = criteria.quoted ? '' : retrieval.relatedQuery;
  if (!run) {
    let sourceQuery = retrieval.strictQuery;
    const fetchFirst = async () => {
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
      return first;
    };
    firstPage = await fetchFirst();
    if (
      firstPage.response.numFound === 0 &&
      !criteria.quoted &&
      !plan.phrase &&
      retrieval.spellingQuery
    ) {
      sourceQuery = retrieval.spellingQuery;
      firstPage = await fetchFirst();
      if (firstPage.response.numFound > 0) {
        const label =
          'Spelling alternatives: no original match; showing close indexed spellings.';
        expansion.corrections.push(label);
        plan.labels.push(label);
      }
    }
    let related = false;
    if (firstPage.response.numFound === 0 && relatedQuery) {
      sourceQuery = relatedQuery;
      firstPage = await fetchFirst();
      related = firstPage.response.numFound > 0;
    }
    run = {
      id: crypto.randomUUID(),
      plan: JSON.stringify({ ...plan, ...expansion, sourceQuery, related }),
      total: firstPage.response.numFound,
      next: 1,
      created: Date.now(),
      lease: 0,
    };
    await db.batch([
      db
        .prepare(
          "DELETE FROM search_runs WHERE id IN (SELECT id FROM search_runs WHERE fingerprint NOT LIKE 'trending:v1:%' AND created < ? AND ((next - 1) * 30 >= total OR created < ?) LIMIT 5)",
        )
        .bind(cutoff, activeCutoff),
      db
        .prepare(
          'INSERT INTO search_runs (id,fingerprint,plan,total,next,created,lease) VALUES (?,?,?,?,1,?,0)',
        )
        .bind(run.id, fingerprint, run.plan, run.total, run.created),
    ]);
  }
  const storedPlan = JSON.parse(run.plan) as {
    sourceQuery: string;
    related: boolean;
    stalls?: number;
  };
  const { sourceQuery, related } = storedPlan;
  if (related)
    plan.labels.push(
      'Broadened search: no full match; showing related shiurim while keeping recognized subjects.',
    );
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
        const settled = await Promise.allSettled(
          Array.from({ length: end - run.next }, (_, i) =>
            firstPage && run!.next + i === 1
              ? Promise.resolve(firstPage)
              : upstream<SearchResponse>(
                  sourceParams(plan, sourceQuery, run!.next + i),
                  0,
                ),
          ),
        );
        // Wait for every read before releasing the lease. Permanent errors and
        // changed/incomplete pages still invalidate the whole pass.
        const failure = settled.find((result) => result.status === 'rejected');
        for (const [i, result] of settled.entries()) {
          if (result.status === 'rejected') {
            if (!(result.reason instanceof SearchReadError))
              throw result.reason;
            continue;
          }
          const b = result.value;
          if (
            !Array.isArray(b.response?.docs) ||
            b.response.numFound !== run.total
          )
            throw new SearchChangedError(
              'The library changed during this search. Start the search again for a fresh count.',
            );
          const expected = Math.min(
            pageSize,
            run.total - (run.next + i - 1) * pageSize,
          );
          if (b.response.docs.length !== expected)
            throw new Error(
              'An incomplete search page was received. Please retry.',
            );
        }
        // Only a contiguous verified prefix can advance the cursor. A transient
        // gap remains pending and the existing client resumes it on the next pass.
        const prefix = failure ? settled.indexOf(failure) : settled.length;
        const batches = settled
          .slice(0, prefix)
          .map(
            (result) =>
              (result as PromiseFulfilledResult<SearchResponse>).value,
          );
        const next = run.next + prefix;
        const stalls = prefix ? 0 : (storedPlan.stalls || 0) + 1;
        const updatedPlan = JSON.stringify({ ...JSON.parse(run.plan), stalls });
        const learnedTitles: { id: number; title: string }[] = [];
        const rows = batches.flatMap((b, i) => {
          return b.response.docs.map((raw, j) => {
            const s = normalize(raw);
            learnedTitles.push({ id: s.id, title: s.title });
            return [
              run!.id,
              s.id,
              JSON.stringify(s),
              retrieval.matches(s.title, related) ? 1 : 0,
              searchText(
                [s.title, s.teacher, s.series, ...s.topics, s.description].join(
                  ' ',
                ),
              ),
              s.language,
              mediaKind(s),
              relevanceScore(s, expansion!.searchTerm || plan.phrase || ''),
              Date.parse(s.date) || 0,
              s.duration,
              searchText(s.title),
              (run!.next + i - 1) * pageSize + j,
            ];
          });
        });
        const statements: SearchStatement[] = indexTitleStatements(
          db,
          learnedTitles,
        );
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
              'UPDATE search_runs SET next = ?, plan = ?, lease = 0, created = CASE WHEN ? THEN ? ELSE created END WHERE id = ? AND lease = ?',
            )
            .bind(
              next,
              updatedPlan,
              next > pages ? 1 : 0,
              Date.now(),
              run.id,
              lease,
            ),
        );
        await db.batch(statements);
        run.next = next;
        if (failure && stalls >= 3) throw failure.reason;
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
  const refinements = predicates.slice(1).join(' AND ') || '1 = 1';
  // Count candidates and refined matches in one pass and one database read.
  const counts = await db
    .prepare(
      `SELECT COUNT(*) AS scanned, COUNT(CASE WHEN ${refinements} THEN 1 END) AS matches FROM search_hits WHERE run = ?`,
    )
    .bind(...args.slice(1), run.id)
    .first<{ scanned: number; matches: number }>();
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
    total: counts!.matches,
    sourceTotal: run.total,
    scanned: counts!.scanned,
    complete,
    related,
    run: run.id,
    plan,
    filtered: false,
    nextPage: complete && page * pageSize < counts!.matches ? page + 1 : null,
    facets: { teachers: [], topics: [], series: [] },
  };
}
