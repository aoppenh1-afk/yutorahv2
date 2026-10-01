import { ORIGIN, normalize } from './yutorah';
import type { RawShiur } from './api-types';
import type { SearchDatabase } from './search-storage';
import { indexTitleStatements } from './title-index';

type ImportRun = {
  minimum: number;
  maximum: number;
  next: number;
  total: number;
  scanned: number;
  started: number;
  completed: number;
};
type ArchivePage = { numFound: number; docs: RawShiur[] };
export type ArchiveReader = (
  minimum?: number,
  maximum?: number,
  descending?: boolean,
) => Promise<ArchivePage>;

/** The public site's ID filters bound its otherwise very large facet response.
 * Thirty numeric IDs can contain at most thirty documents, so one response
 * covers the entire range without unstable, date-ordered offset pagination.
 */
const archivePage: ArchiveReader = async (
  minimum,
  maximum,
  descending = false,
) => {
  const params = new URLSearchParams({
    organizationID: '301',
    page: '1',
    search_query: '',
    sort_by: descending ? 'shiurid desc' : 'shiurid asc',
    facet_query:
      'teacherishidden:0' +
      (minimum === undefined ? '' : `,shiurid:[${minimum} TO ${maximum}]`),
  });
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(
        `${ORIGIN}/Search/GetSearchResults?${params}`,
        {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!response.ok) {
        if (response.status !== 429 && response.status < 500)
          throw new RangeError(`The archive returned ${response.status}.`);
        const delay = Number(response.headers.get('Retry-After'));
        if (Number.isFinite(delay) && delay > 0)
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(delay, 60) * 1000),
          );
        throw new Error(`The archive returned ${response.status}.`);
      }
      const body = (await response.json()) as { response?: ArchivePage };
      if (
        !Number.isSafeInteger(body.response?.numFound) ||
        body.response!.numFound < 0 ||
        !Array.isArray(body.response?.docs)
      )
        throw new RangeError('The archive returned an invalid title response.');
      return body.response!;
    } catch (error) {
      if (error instanceof RangeError || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
};

/** A persisted ID snapshot keeps new uploads from moving the scan's finish line.
 * Bounded concurrent reads are committed in order with their cursor and counts.
 */
export async function migrateTitleArchive(
  db: SearchDatabase,
  maxRanges = 20,
  concurrency = 4,
  read: ArchiveReader = archivePage,
) {
  if (
    !Number.isInteger(maxRanges) ||
    maxRanges < 1 ||
    maxRanges > 1000 ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 8
  )
    throw new RangeError('Choose 1–1000 ranges and 1–8 concurrent requests.');
  let run = await db
    .prepare("SELECT * FROM search_title_imports WHERE name='archive'")
    .first<ImportRun>();
  if (!run) {
    const [first, last] = await Promise.all([
      read(),
      read(undefined, undefined, true),
    ]);
    const minimum = Number(
      first.docs[0]?.shiurid ?? first.docs[0]?.shiurID ?? 0,
    );
    const maximum = Number(last.docs[0]?.shiurid ?? last.docs[0]?.shiurID ?? 0);
    if (
      !Number.isSafeInteger(minimum) ||
      !Number.isSafeInteger(maximum) ||
      minimum < 1 ||
      maximum < minimum
    )
      throw new Error('The archive did not supply valid ID boundaries.');
    const snapshot = await read(minimum, maximum);
    run = {
      minimum,
      maximum,
      next: minimum,
      total: snapshot.numFound,
      scanned: 0,
      started: Date.now(),
      completed: 0,
    };
    await db
      .prepare(
        "INSERT INTO search_title_imports (name,minimum,maximum,next,total,scanned,started,completed) VALUES ('archive',?,?,?,?,0,?,0)",
      )
      .bind(minimum, maximum, minimum, run.total, run.started)
      .run();
  }
  if (run.completed) return { ...run, complete: true };
  let processed = 0;
  while (run.next <= run.maximum && processed < maxRanges) {
    const ranges = Array.from(
      {
        length: Math.min(
          concurrency,
          maxRanges - processed,
          Math.ceil((run.maximum - run.next + 1) / 30),
        ),
      },
      (_, i) => ({
        minimum: run!.next + i * 30,
        maximum: Math.min(run!.maximum, run!.next + i * 30 + 29),
      }),
    );
    const pages = await Promise.allSettled(
      ranges.map((range) => read(range.minimum, range.maximum)),
    );
    for (const [index, page] of pages.entries()) {
      if (page.status === 'rejected') throw page.reason;
      const range = ranges[index];
      const records = page.value.docs.map(normalize);
      if (
        records.length !== page.value.numFound ||
        records.length > 30 ||
        records.some(
          (record) =>
            !Number.isSafeInteger(record.id) ||
            record.id < range.minimum ||
            record.id > range.maximum,
        ) ||
        new Set(records.map((record) => record.id)).size !== records.length
      )
        throw new Error(
          `Incomplete or invalid title range ${range.minimum}–${range.maximum}; retry this pass.`,
        );
      await db.batch([
        ...indexTitleStatements(db, records),
        db
          .prepare(
            "UPDATE search_title_imports SET next=?,scanned=scanned+? WHERE name='archive' AND next=?",
          )
          .bind(range.maximum + 1, records.length, range.minimum),
      ]);
      run.next = range.maximum + 1;
      run.scanned += records.length;
      processed++;
    }
  }
  if (run.next > run.maximum) {
    const audit = await read(run.minimum, run.maximum);
    const coverage = await db
      .prepare(
        'SELECT COUNT(*) AS titles FROM search_title_catalog WHERE id BETWEEN ? AND ?',
      )
      .bind(run.minimum, run.maximum)
      .first<{ titles: number }>();
    if (audit.numFound !== run.scanned || coverage?.titles !== run.scanned)
      throw new Error(
        `Title coverage audit failed: archive=${audit.numFound}, scanned=${run.scanned}, stored=${coverage?.titles}.`,
      );
    run.completed = Date.now();
    await db
      .prepare(
        "UPDATE search_title_imports SET completed=?,total=? WHERE name='archive'",
      )
      .bind(run.completed, audit.numFound)
      .run();
    run.total = audit.numFound;
  }
  return { ...run, complete: !!run.completed };
}
