import {
  getDirectory,
  dateBoundary,
  parseSearch,
  matchesPlan,
  upstream,
  SearchReadError,
  normalize,
  enrichShiur,
  mediaKind,
  type SearchPlan,
  type SearchResult,
  type Shiur,
} from './yutorah';
import type { SearchResponse } from './api-types';
import type { SearchDatabase, SearchStatement } from './search-storage';
import { searchText } from './search-discovery';
import { createRelevanceScorer } from '../packages/yutorah-core/src/search-ranking.js';
import {
  interpretSpacing,
  searchRetrieval,
  searchVocabulary,
} from './search-matching';
import {
  changedTitleStatements,
  knownTitleWords,
  titleVocabulary,
} from './title-index';

import { BoundedCache } from './bounded-cache';
import { performanceSample } from './performance-metrics';
import {
  readArchiveSearch,
  emptyFacets,
  catalogVenues,
  type CatalogFacets,
} from './catalog';

type Run = {
  id: string;
  plan: string;
  total: number;
  next: number;
  created: number;
  lease: number;
  owner: string;
  scanned: number;
};
const pageSize = 30;
const sorts: Record<string, string> = {
  relevance: 'rank DESC, id DESC',
  popular: 'views DESC, rank DESC, id DESC',
  new: 'date DESC, id DESC',
  old: 'date ASC, id ASC',
  short: 'CASE WHEN duration = 0 THEN 1 ELSE 0 END, duration ASC, id DESC',
  long: 'duration DESC, id DESC',
  title: 'title ASC, id DESC',
  library: 'position ASC, id DESC',
};
export class SearchChangedError extends Error {}
export class SearchBusyError extends Error {}

function sourceParams(plan: SearchPlan, query: string, page: number) {
  const p = new URLSearchParams({
    searchTerm:
      query ||
      (plan.teacherId ||
      plan.seriesId ||
      plan.topicId ||
      plan.venueId ||
      plan.collectionId
        ? '*'
        : ''),
    getFacets: 'false',
    start: String(page),
  });
  if (plan.teacherId) p.set('teacherID', String(plan.teacherId));
  if (plan.seriesId) p.set('seriesID', String(plan.seriesId));
  if (plan.topicId) p.set('subcategoryID', String(plan.topicId));
  if (plan.venueId) p.set('locationID', String(plan.venueId));
  if (plan.collectionId) p.set('collectionID', String(plan.collectionId));
  return 'search/get?' + p;
}

async function sourcePage(
  plan: SearchPlan,
  query: string,
  page: number,
  ttl = 0,
): Promise<SearchResponse> {
  return plan.publicationId ||
    plan.volumeId ||
    Object.values(plan.entityIds || {}).some((ids) => ids.length > 1)
    ? readArchiveSearch(plan, query, page)
    : upstream<SearchResponse>(sourceParams(plan, query, page), ttl);
}

/** Bounded, resumable passes. A database transaction commits each pass with its cursor. */
async function searchPass(
  db: SearchDatabase,
  query: string,
  options: Partial<SearchPlan>,
  page = 1,
  runId = '',
): Promise<SearchResult> {
  const directory = await getDirectory();
  const venues = await catalogVenues().catch(() => []);
  const venueNames = new Map(venues.map((v) => [v.id, v.name]));
  const venueIds = new Map(venues.map((v) => [searchText(v.name), v.id]));
  let plan = parseSearch(query, options, directory);
  // The expansion is snapshotted on the run. Learning more titles must not
  // change a pending scan's source query, title matching, or candidate counts.
  const criteria = {
    version: 14,
    query,
    literal: !!plan.literal,
    quoted: /"[^"]+"/.test(query),
    teacher: plan.teacherId,
    topic: plan.topicId,
    series: plan.seriesId,
    venue: plan.venueId || 0,
    collection: plan.collectionId || 0,
    publication: plan.publicationId || 0,
    volume: plan.volumeId || 0,
    entityIds: Object.entries(plan.entityIds || {})
      .filter(([, ids]) => ids.length > 1)
      .sort(([a], [b]) => a.localeCompare(b)),
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
    knownWords: string[];
    suggestion?: string;
  };
  let creationOwner = '';
  if (!run) {
    creationOwner = crypto.randomUUID();
    const claim = await db
      .prepare(`INSERT INTO search_creation_leases(fingerprint,owner,expires) VALUES(?,?,?)
      ON CONFLICT(fingerprint) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE search_creation_leases.expires < ?`)
      .bind(fingerprint, creationOwner, Date.now() + 120000, Date.now())
      .run();
    if (!claim.meta.changes)
      return {
        items: [],
        total: 0,
        sourceTotal: 0,
        scanned: 0,
        complete: false,
        run: '',
        retryAfterMs: 1500,
        plan,
        filtered: false,
        nextPage: null,
        facets: { teachers: [], topics: [], series: [] },
      };
    // A previous creator may have committed after our initial lookup.
    run = await db
      .prepare(
        'SELECT * FROM search_runs WHERE fingerprint=? AND (created>? OR (created>? AND (next-1)*30<total)) ORDER BY created DESC LIMIT 1',
      )
      .bind(fingerprint, cutoff, activeCutoff)
      .first<Run>();
  }
  let expansion = run ? (JSON.parse(run.plan) as Expansion) : null;
  let retrieval!: ReturnType<typeof searchRetrieval>;
  try {
    if (!expansion) {
      const knownWords = plan.literal ? [] : await knownTitleWords(db, query);
      plan = parseSearch(query, options, directory, knownWords);
      const learned = plan.literal
        ? { words: [], phrases: [] }
        : await titleVocabulary(db, plan.term);
      const spacing = plan.literal
        ? { term: plan.term, labels: [] }
        : interpretSpacing(plan.term, learned.phrases);
      expansion = {
        sourceQuery: '',
        related: false,
        searchTerm: spacing.term,
        corrections: spacing.labels,
        knownWords,
        vocabulary: [
          ...new Set([
            ...learned.words,
            ...knownWords,
            ...searchVocabulary([
              ...directory.teachers.map((teacher) => teacher.name),
              ...directory.topics.map((topic) => topic.name),
              ...directory.series.map((series) => series.name),
            ]),
          ]),
        ],
      };
    }
    // Resume with the same dictionary protection even if another search has
    // learned new words since this run began.
    plan = parseSearch(query, options, directory, expansion.knownWords);
    if (plan.min && plan.max && plan.min > plan.max)
      throw new RangeError(
        'Minimum duration must not exceed maximum duration.',
      );
    plan.labels.push(...expansion.corrections);
    // The original input stays in the UI. The repaired retrieval term and the
    // dictionary protection live in the run snapshot independently.
    retrieval = searchRetrieval(
      expansion.searchTerm || plan.phrase || '',
      expansion.vocabulary,
      !!plan.literal,
    );
    const relatedQuery = criteria.quoted ? '' : retrieval.relatedQuery;
    if (!run) {
      let sourceQuery = retrieval.strictQuery;
      const fetchFirst = async () => {
        const first = await sourcePage(plan, sourceQuery, 1);
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
        retrieval.spellingTerm
      ) {
        try {
          const suggestion = await sourcePage(plan, retrieval.spellingQuery, 1);
          if (
            Array.isArray(suggestion.response?.docs) &&
            Number.isSafeInteger(suggestion.response.numFound) &&
            suggestion.response.numFound > 0 &&
            suggestion.response.docs.some((raw) =>
              matchesPlan(normalize(raw), {
                ...plan,
                term: retrieval.spellingTerm,
              }),
            )
          )
            expansion.suggestion = retrieval.spellingTerm;
        } catch (error) {
          // An optional spelling check must not replace a valid empty response
          // with an error or change the original result set.
          if (!(error instanceof SearchReadError)) throw error;
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
        owner: '',
        scanned: 0,
      };
      if (run.total > 50000)
        throw new RangeError(
          'This search exceeds the cache budget. Choose a teacher, topic, or narrower search.',
        );
      const committed = await db.batch([
        db
          .prepare(
            "DELETE FROM search_runs WHERE id IN (SELECT id FROM search_runs WHERE fingerprint NOT LIKE 'trending:v1:%' AND created < ? AND ((next - 1) * 30 >= total OR created < ?) LIMIT 64)",
          )
          .bind(cutoff, activeCutoff),
        db
          .prepare(
            `DELETE FROM search_runs WHERE id IN (SELECT id FROM (SELECT id,SUM(total) OVER (ORDER BY created DESC,id DESC) AS reserved,ROW_NUMBER() OVER (ORDER BY created DESC,id DESC) AS ordinal FROM search_runs WHERE (next-1)*30>=total AND fingerprint NOT LIKE 'trending:v1:%') ranked WHERE reserved > ? OR ordinal > 128)`,
          )
          .bind(Math.max(0, 50000 - run.total)),
        db.prepare(
          'DELETE FROM search_documents WHERE key IN (SELECT key FROM search_documents d WHERE NOT EXISTS (SELECT 1 FROM search_hits h WHERE h.document_key=d.key) LIMIT 256)',
        ),
        db
          .prepare('DELETE FROM search_creation_leases WHERE expires < ?')
          .bind(Date.now()),
        db
          .prepare(
            `INSERT INTO search_runs (id,fingerprint,plan,total,next,created,lease) SELECT ?,?,?,?,1,?,0 WHERE (SELECT COALESCE(SUM(total),0) FROM search_runs WHERE fingerprint NOT LIKE 'trending:v1:%') <= ?`,
          )
          .bind(
            run.id,
            fingerprint,
            run.plan,
            run.total,
            run.created,
            50000 - run.total,
          ),
      ]);
      if (!(committed.at(-1) as { meta?: { changes: number } })?.meta?.changes)
        throw new SearchBusyError(
          'The search cache is busy. Retry shortly or choose a narrower search.',
        );
    }
  } finally {
    if (creationOwner)
      await db
        .prepare(
          'DELETE FROM search_creation_leases WHERE fingerprint=? AND owner=?',
        )
        .bind(fingerprint, creationOwner)
        .run();
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
    const owner = crypto.randomUUID();
    const lease = Date.now() + 60000;
    const acquired = await db
      .prepare(
        'UPDATE search_runs SET lease = ?, owner = ? WHERE id = ? AND lease < ? AND next = ?',
      )
      .bind(lease, owner, run.id, Date.now(), run.next)
      .run();
    if (acquired.meta.changes) {
      try {
        const started = performance.now();
        const end = Math.min(pages + 1, run.next + 4);
        const settled = await Promise.allSettled(
          Array.from({ length: end - run.next }, (_, i) =>
            firstPage && run!.next + i === 1
              ? Promise.resolve(firstPage)
              : sourcePage(plan, sourceQuery, run!.next + i),
          ),
        );
        const readMs = performance.now() - started;
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
        const score = createRelevanceScorer(
          expansion!.searchTerm || plan.phrase || '',
        );
        const rawRows = batches.flatMap((b, i) => {
          return b.response.docs.map((raw, j) => {
            const s = enrichShiur(normalize(raw), directory);
            if (!s.venueId && s.venue)
              s.venueId = venueIds.get(searchText(s.venue));
            if (!s.venueId && plan.venueId) s.venueId = plan.venueId;
            if (s.venueId && !s.venue)
              s.venue = venueNames.get(s.venueId) || '';
            if (!s.publicationId && plan.publicationId)
              s.publicationId = plan.publicationId;
            if (!s.volumeId && plan.volumeId) s.volumeId = plan.volumeId;
            if (!s.collections?.length && plan.collectionId)
              s.collections = [{ id: plan.collectionId, name: '' }];
            s.series ||=
              directory.series.find((x) => x.id === s.seriesId)?.name || '';
            s.topicPaths = (s.topicIds || []).map((id) => {
              const topic = directory.topics.find((x) => x.id === id);
              return topic
                ? {
                    id,
                    name: topic.name,
                    group: topic.group,
                    branch: topic.branch,
                  }
                : s.topicPaths?.find((x) => x.id === id) || {
                    id,
                    name: '',
                    group: '',
                  };
            });
            s.facets = [
              ...(s.speakers || []).map((x) => ({
                kind: 'teachers',
                id: x.id,
                name: x.name,
              })),
              ...(s.topicPaths || []).map((x) => ({
                kind: 'topics',
                id: x.id,
                name: [x.group, x.branch, x.name].filter(Boolean).join(' / '),
              })),
              ...(s.seriesId
                ? [{ kind: 'series', id: s.seriesId, name: s.series }]
                : []),
              ...(s.venueId
                ? [{ kind: 'venues', id: s.venueId, name: s.venue || '' }]
                : []),
              ...(s.publicationId
                ? [
                    {
                      kind: 'publications',
                      id: s.publicationId,
                      name: s.publication || '',
                    },
                  ]
                : []),
              ...(s.volumeId
                ? [{ kind: 'volumes', id: s.volumeId, name: s.volume || '' }]
                : []),
              ...(s.collections || []).map((x) => ({
                kind: 'collections',
                id: x.id,
                name: x.name,
              })),
            ].filter((x) => x.id > 0);
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
              score(s),
              Date.parse(s.date) || 0,
              s.duration,
              searchText(s.title),
              (run!.next + i - 1) * pageSize + j,
            ];
          });
        });
        const documents = new Map<string, string>();
        const rows = await Promise.all(
          rawRows.map(async (row) => {
            const payload = row[2] as string;
            const digest = await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(payload),
            );
            const key = Array.from(new Uint8Array(digest), (n) =>
              n.toString(16).padStart(2, '0'),
            ).join('');
            documents.set(key, payload);
            row[2] = '';
            return [...row, key, Number(JSON.parse(payload).views) || 0];
          }),
        );
        // Lock the run before checking ownership on PostgreSQL. D1 serializes
        // the batch. Evaluate expiry on the database clock after pool/lock waits.
        const statements: SearchStatement[] = [
          db
            .prepare('UPDATE search_runs SET lease=lease WHERE id=?')
            .bind(run.id),
          db
            .prepare(`INSERT INTO search_pass_guards(run,owner,valid) VALUES(?,?,CASE WHEN EXISTS(
            SELECT 1 FROM search_runs WHERE id=? AND owner=? AND next=?
            AND lease>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
          ) THEN 1 ELSE 0 END)`)
            .bind(run.id, owner, run.id, owner, run.next),
          ...(await changedTitleStatements(db, learnedTitles)),
        ];
        const entries = [...documents];
        const documentBatch = db.dialect === 'postgres' ? 120 : 30;
        for (let i = 0; i < entries.length; i += documentBatch) {
          const group = entries.slice(i, i + documentBatch);
          statements.push(
            db
              .prepare(
                `INSERT OR IGNORE INTO search_documents(key,payload,created) VALUES ${group.map(() => '(?,?,?)').join(',')}`,
              )
              .bind(
                ...group.flatMap(([key, payload]) => [
                  key,
                  payload,
                  Date.now(),
                ]),
              ),
          );
        }
        const hitBatch = db.dialect === 'postgres' ? 120 : 7;
        for (let i = 0; i < rows.length; i += hitBatch) {
          const group = rows.slice(i, i + hitBatch);
          statements.push(
            db
              .prepare(
                `INSERT OR IGNORE INTO search_hits (run,id,payload,matched,search,language,format,rank,date,duration,title,position,document_key,views) VALUES ${group.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}`,
              )
              .bind(...group.flat()),
          );
        }
        statements.push(
          db
            .prepare(
              'UPDATE search_runs SET next = ?, plan = ?, scanned = ?, lease = 0, created = CASE WHEN ? THEN ? ELSE created END WHERE id = ? AND owner = ? AND next = ?',
            )
            .bind(
              next,
              updatedPlan,
              run.scanned + rows.length,
              next > pages ? 1 : 0,
              Date.now(),
              run.id,
              owner,
              run.next,
            ),
        );
        // Assert the accepted cursor as part of the transaction, not after it.
        statements.push(
          db
            .prepare(`UPDATE search_pass_guards SET valid=CASE WHEN EXISTS(
            SELECT 1 FROM search_runs WHERE id=? AND owner=? AND next=? AND scanned=? AND lease=0
          ) THEN 1 ELSE 0 END WHERE run=? AND owner=?`)
            .bind(
              run.id,
              owner,
              next,
              run.scanned + rows.length,
              run.id,
              owner,
            ),
          db
            .prepare('DELETE FROM search_pass_guards WHERE run=? AND owner=?')
            .bind(run.id, owner),
        );
        const preparedMs = performance.now() - started - readMs;
        const commitStarted = performance.now();
        await db.batch(statements);
        performanceSample('search_pass', {
          upstreamMs: readMs,
          cpuMs: preparedMs,
          commitMs: performance.now() - commitStarted,
          statements: statements.length,
          scanned: rows.length,
        });
        run.next = next;
        if (next > pages) run.created = Date.now();
        run.scanned += rows.length;
        if (next > pages) {
          const count = await db
            .prepare('SELECT COUNT(*) AS scanned FROM search_hits WHERE run=?')
            .bind(run.id)
            .first<{ scanned: number }>();
          if (count!.scanned !== run.total)
            throw new SearchChangedError(
              'The library changed during this search. Please search again.',
            );
        }
        if (failure && stalls >= 3) throw failure.reason;
      } catch (e) {
        await db
          .prepare(
            'UPDATE search_runs SET lease = 0 WHERE id = ? AND owner = ?',
          )
          .bind(run.id, owner)
          .run();
        if (
          e instanceof Error &&
          /search_pass_owned|search_pass_guards|CHECK constraint failed: valid/i.test(
            e.message,
          )
        )
          throw new SearchBusyError(
            'The search pass lost its lease. Retry shortly.',
          );
        if (e instanceof SearchChangedError)
          await db
            .prepare('DELETE FROM search_runs WHERE id = ? AND owner = ?')
            .bind(run.id, owner)
            .run();
        if (
          e instanceof Error &&
          e.message.includes('Search cache capacity reached')
        ) {
          await db
            .prepare(
              'DELETE FROM search_documents WHERE key IN(SELECT key FROM search_documents d WHERE NOT EXISTS(SELECT 1 FROM search_hits h WHERE h.document_key=d.key) LIMIT 1000)',
            )
            .run();
          throw new SearchBusyError(
            'The search cache is busy. Please retry shortly.',
          );
        }
        throw e;
      }
    } else {
      run = (await db
        .prepare('SELECT * FROM search_runs WHERE id = ?')
        .bind(run.id)
        .first<Run>())!;
      if (!run)
        throw new SearchChangedError(
          'The cached search expired. Please search again.',
        );
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
  const payload =
    "COALESCE((SELECT d.payload FROM search_documents d WHERE d.key=search_hits.document_key),NULLIF(payload,''),'{}')";
  const dateField =
    plan.dateBasis === 'uploaded'
      ? `json_extract(${payload},'$.uploadedAt')`
      : 'date';
  if (plan.uploadedAfter)
    add(
      `json_extract(${payload},'$.uploadedAt') >= ?`,
      dateBoundary(plan.uploadedAfter, true),
    );
  if (plan.uploadedBefore)
    add(
      `json_extract(${payload},'$.uploadedAt') < ?`,
      dateBoundary(plan.uploadedBefore, true, true),
    );
  if (plan.group)
    add(
      `EXISTS (SELECT 1 FROM json_each(json_extract(${payload},'$.topicPaths')) AS t WHERE json_extract(t.value,'$.group') = ?)`,
      plan.group,
    );
  if (plan.after)
    add(
      `${dateField} >= ?`,
      plan.dateBasis === 'uploaded'
        ? dateBoundary(plan.after, true)
        : Date.parse(plan.after + 'T00:00:00Z'),
    );
  if (plan.before) {
    const end = Date.parse(plan.before + 'T00:00:00Z') + 86400000;
    predicates.push(
      plan.dateBasis === 'uploaded' ? `${dateField} IS NOT NULL` : 'date > 0',
    );
    add(
      `${dateField} < ?`,
      plan.dateBasis === 'uploaded'
        ? dateBoundary(plan.before, true, true)
        : end,
    );
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
  if (plan.literal && plan.term)
    add(
      `NOT EXISTS (SELECT 1 FROM json_each(?) AS word WHERE instr(' ' || ${field} || ' ', ' ' || word.value || ' ') = 0)`,
      JSON.stringify(searchText(plan.term).split(' ').filter(Boolean)),
    );
  else if (plan.scope === 'title' && plan.term) predicates.push('matched = 1');
  const where = predicates.join(' AND ');
  const counts = { scanned: run.scanned, matches: run.scanned };
  const order =
    plan.dateBasis === 'uploaded' && ['new', 'old'].includes(plan.sort || '')
      ? `CASE WHEN ${dateField} IS NULL THEN 1 ELSE 0 END ASC, ${dateField} ${plan.sort === 'old' ? 'ASC' : 'DESC'}, id ${plan.sort === 'old' ? 'ASC' : 'DESC'}`
      : sorts[plan.sort || 'relevance'] || sorts.relevance;
  const data = await db
    .prepare(
      `SELECT COALESCE((SELECT d.payload FROM search_documents d WHERE d.key=search_hits.document_key),payload) AS payload${predicates.length > 1 ? ', COUNT(*) OVER() AS matches' : ''} FROM search_hits WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
    .bind(...args, pageSize, complete ? (page - 1) * pageSize : 0)
    .all<{ payload: string; matches?: number }>();
  if (predicates.length > 1)
    counts.matches = data.results.length
      ? data.results[0].matches!
      : (await db
          .prepare(`SELECT COUNT(*) AS matches FROM search_hits WHERE ${where}`)
          .bind(...args)
          .first<{ matches: number }>())!.matches;
  const facets: CatalogFacets = emptyFacets();
  const facetRows = await db
    .prepare(`WITH eligible AS (SELECT id, ${payload} AS payload FROM search_hits WHERE ${where})
    SELECT json_extract(f.value,'$.kind') AS kind, CAST(json_extract(f.value,'$.id') AS INTEGER) AS id,
      MAX(json_extract(f.value,'$.name')) AS name, COUNT(DISTINCT eligible.id) AS count
    FROM eligible, json_each(json_extract(eligible.payload,'$.facets')) AS f
    GROUP BY json_extract(f.value,'$.kind'), CAST(json_extract(f.value,'$.id') AS INTEGER)
    ORDER BY count DESC, id ASC`)
    .bind(...args)
    .all<{
      kind: keyof CatalogFacets;
      id: number;
      name: string;
      count: number;
    }>();
  for (const row of facetRows.results) {
    if (!(row.kind in facets) || row.id <= 0) continue;
    let name = row.name;
    if (!name && row.kind === 'teachers')
      name = directory.teachers.find((x) => x.id === row.id)?.name || '';
    if (!name && row.kind === 'series')
      name = directory.series.find((x) => x.id === row.id)?.name || '';
    if (!name && row.kind === 'venues') name = venueNames.get(row.id) || '';
    facets[row.kind].push({
      id: row.id,
      name: name || `Selected ${row.kind.replace(/s$/, '')} ${row.id}`,
      count: row.count,
    });
  }
  return {
    items: data.results.map((r) => JSON.parse(r.payload) as Shiur),
    total: counts!.matches,
    sourceTotal: run.total,
    scanned: counts!.scanned,
    complete,
    retryAfterMs: 1500,
    expiresAt: run.created + 60 * 60_000,
    related,
    suggestion: expansion.suggestion,
    correction:
      !plan.literal && plan.labels.some((label) => label.includes(' → '))
        ? expansion.searchTerm || plan.term
        : undefined,
    run: run.id,
    plan,
    filtered: false,
    nextPage: complete && page * pageSize < counts!.matches ? page + 1 : null,
    facets,
  };
}

const local = new WeakMap<
  SearchDatabase,
  {
    cache: BoundedCache<SearchResult>;
    pending: Map<string, Promise<SearchResult>>;
  }
>();
/** Coalesce identical reads inside a process. The database lease coordinates other hosts. */
export async function completeSearch(
  db: SearchDatabase,
  query: string,
  options: Partial<SearchPlan>,
  page = 1,
  runId = '',
): Promise<SearchResult> {
  let state = local.get(db);
  if (!state) {
    state = {
      cache: new BoundedCache(128, 8 * 1024 * 1024),
      pending: new Map(),
    };
    local.set(db, state);
  }
  const key = JSON.stringify([
    query,
    Object.entries(options).sort(([a], [b]) => a.localeCompare(b)),
    page,
    runId,
  ]);
  const cached = state.cache.get(key);
  if (cached) {
    performanceSample('search_cache', { hit: 1 });
    return structuredClone(cached);
  }
  let promise = state.pending.get(key);
  performanceSample('search_cache', { hit: 0, coalesced: promise ? 1 : 0 });
  if (!promise && state.pending.size >= 32)
    throw new SearchBusyError('Search is busy. Please retry shortly.');
  if (!promise) {
    const current = state;
    promise = searchPass(db, query, options, page, runId)
      .then((result) => {
        current.cache.set(
          key,
          result,
          result.complete && runId
            ? Math.max(
                0,
                Math.min(
                  60000,
                  (result.expiresAt || Date.now() + 60000) - Date.now(),
                ),
              )
            : 0,
        );
        return result;
      })
      .finally(() => current.pending.delete(key));
    current.pending.set(key, promise);
  }
  return structuredClone(await promise);
}
