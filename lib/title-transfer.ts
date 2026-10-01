import type { SearchDatabase } from './search-storage';
import { indexTitleStatements } from './title-index';

type Checkpoint = {
  minimum: number;
  maximum: number;
  next: number;
  total: number;
  scanned: number;
  started: number;
  completed: number;
};
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

export async function transferStatus(db: SearchDatabase) {
  const [titles, keys] = await Promise.all(
    ['archive', 'archive-keys'].map((name) =>
      db
        .prepare('SELECT * FROM search_title_imports WHERE name=?')
        .bind(name)
        .first<Checkpoint>(),
    ),
  );
  return { titles, keys };
}

/** A bounded operator protocol, never an arbitrary SQL or filesystem interface.
 * Catalog triggers rebuild document frequencies; spelling keys are copied once.
 */
export async function transferTitles(db: SearchDatabase, input: unknown) {
  if (!input || typeof input !== 'object')
    throw new RangeError('Invalid transfer.');
  const body = input as Record<string, unknown>;
  let status = await transferStatus(db);
  if (body.operation === 'start') {
    const { minimum, maximum, total, keys } = body;
    if (
      !integer(minimum) ||
      minimum < 1 ||
      !integer(maximum) ||
      maximum < minimum ||
      !integer(total) ||
      total < 1 ||
      total > maximum - minimum + 1 ||
      !integer(keys)
    )
      throw new RangeError('Invalid archive manifest.');
    if (
      status.titles &&
      (status.titles.minimum !== minimum ||
        status.titles.maximum !== maximum ||
        status.titles.total !== total ||
        status.keys?.total !== keys)
    )
      throw new RangeError('A different archive is already being transferred.');
    if (!status.titles)
      await db.batch([
        db
          .prepare(
            "INSERT INTO search_title_imports (name,minimum,maximum,next,total,scanned,started,completed) VALUES ('archive',?,?,?,?,0,?,0)",
          )
          .bind(minimum, maximum, minimum, total, Date.now()),
        db
          .prepare(
            "INSERT INTO search_title_imports (name,minimum,maximum,next,total,scanned,started,completed) VALUES ('archive-keys',0,?,0,?,0,?,0)",
          )
          .bind(keys, keys, Date.now()),
      ]);
    return transferStatus(db);
  }
  if (!status.titles || !status.keys)
    throw new RangeError('Start the transfer first.');
  if (body.operation === 'finish') {
    const [catalog, keys] = await Promise.all([
      db
        .prepare(
          'SELECT COUNT(*) AS count FROM search_title_catalog WHERE id BETWEEN ? AND ?',
        )
        .bind(status.titles.minimum, status.titles.maximum)
        .first<{ count: number }>(),
      db
        .prepare('SELECT COUNT(*) AS count FROM search_title_keys')
        .first<{ count: number }>(),
    ]);
    if (
      status.titles.scanned !== status.titles.total ||
      catalog?.count !== status.titles.total ||
      status.keys.next !== status.keys.total ||
      (keys?.count ?? 0) < status.keys.total
    )
      throw new RangeError('The archive transfer is incomplete.');
    const completed = status.titles.completed || Date.now();
    await db.batch([
      db
        .prepare(
          "UPDATE search_title_imports SET next=maximum+1,completed=? WHERE name='archive'",
        )
        .bind(completed),
      db
        .prepare(
          "UPDATE search_title_imports SET completed=? WHERE name='archive-keys'",
        )
        .bind(completed),
      ...(!status.titles.completed
        ? [
            db
              .prepare(
                'DELETE FROM search_runs WHERE (next-1)*30 >= total AND lease < ?',
              )
              .bind(completed),
          ]
        : []),
    ]);
    return transferStatus(db);
  }
  if (status.titles.completed)
    throw new RangeError('This archive is already complete.');
  if (!integer(body.next)) throw new RangeError('Invalid transfer checkpoint.');
  if (body.operation === 'titles') {
    if (body.next !== status.titles.next) return status;
    const records = body.records;
    if (!Array.isArray(records) || !records.length || records.length > 1000)
      throw new RangeError('Send 1–1000 titles.');
    let previous = body.next - 1;
    for (const record of records) {
      if (
        !record ||
        !integer(record.id) ||
        record.id <= previous ||
        record.id > status.titles.maximum ||
        typeof record.title !== 'string' ||
        record.title.length > 4096
      )
        throw new RangeError('Invalid title batch.');
      previous = record.id;
    }
    await db.batch([
      ...indexTitleStatements(db, records, false),
      db
        .prepare(
          "UPDATE search_title_imports SET next=?,scanned=scanned+? WHERE name='archive' AND next=?",
        )
        .bind(previous + 1, records.length, body.next),
    ]);
  } else if (body.operation === 'keys') {
    if (status.titles.scanned !== status.titles.total)
      throw new RangeError('Transfer all titles before spelling keys.');
    if (body.next !== status.keys.next) return status;
    const entries = body.entries;
    if (
      !Array.isArray(entries) ||
      !entries.length ||
      entries.length > 5000 ||
      body.next + entries.length > status.keys.total ||
      entries.some(
        (entry) =>
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== 'string' ||
          !/^[djp]:.{1,128}$/u.test(entry[0]) ||
          typeof entry[1] !== 'string' ||
          entry[1].length < 3 ||
          entry[1].length > 64,
      )
    )
      throw new RangeError('Invalid spelling key batch.');
    await db.batch([
      db
        .prepare(
          "INSERT OR IGNORE INTO search_title_keys (key,term) SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?)",
        )
        .bind(JSON.stringify(entries)),
      db
        .prepare(
          "UPDATE search_title_imports SET next=next+?,scanned=scanned+? WHERE name='archive-keys' AND next=?",
        )
        .bind(entries.length, entries.length, body.next),
    ]);
  } else throw new RangeError('Unknown transfer operation.');
  status = await transferStatus(db);
  return status;
}

export async function transferAuthorized(request: Request, token?: string) {
  if (!token) return false;
  const received = request.headers.get('Authorization') || '';
  const digest = async (text: string) =>
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
    );
  const [actual, expected] = await Promise.all([
    digest(received),
    digest(`Bearer ${token}`),
  ]);
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual[i] ^ expected[i];
  return difference === 0;
}
