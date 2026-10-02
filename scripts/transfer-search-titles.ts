import { DatabaseSync } from 'node:sqlite';

// Read an immutable, completed SQLite snapshot. Secrets are environment-only.
const [filename, origin] = process.argv.slice(2);
const url = new URL('/api/search-index', origin);
if (url.protocol !== 'https:')
  throw new Error('Use an HTTPS production origin.');
const token = process.env.SEARCH_INDEX_TRANSFER_TOKEN;
const siteToken = process.env.SITES_API_TOKEN;
if (!token) throw new Error('Set the search-index transfer token.');
const db = new DatabaseSync(filename, { readOnly: true });
const manifest = db
  .prepare("SELECT * FROM search_title_imports WHERE name='archive'")
  .get()!;
if (!manifest?.completed)
  throw new Error('Finish and audit the local archive first.');
const count = db
  .prepare(
    'SELECT COUNT(*) AS count FROM search_title_keys k JOIN search_title_terms t ON t.term=k.term WHERE t.documents>0',
  )
  .get()!.count;
type TransferStatus = {
  titles: { next: number; scanned: number; total: number };
  keys: { next: number; total: number };
};
async function request(body?: unknown): Promise<TransferStatus> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(siteToken
            ? { 'OAI-Sites-Authorization': `Bearer ${siteToken}` }
            : {}),
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) {
        if (response.status < 500 && response.status !== 429)
          throw new RangeError(
            `Transfer rejected (${response.status}): ${(await response.text()).slice(0, 300)}`,
          );
        throw new Error(`Transfer unavailable (${response.status}).`);
      }
      const result = (await response.json()) as TransferStatus;
      if (!result.titles || !result.keys)
        throw new Error('Missing transfer checkpoints.');
      return result;
    } catch (error) {
      if (error instanceof RangeError || attempt >= 5) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1000 * 2 ** attempt, 15000)),
      );
    }
  }
}
try {
  let status = await request({
    operation: 'start',
    minimum: manifest.minimum,
    maximum: manifest.maximum,
    total: manifest.total,
    keys: count,
  });
  while (status.titles.scanned < status.titles.total) {
    const records = db
      .prepare(
        'SELECT id,title FROM search_title_catalog WHERE id BETWEEN ? AND ? ORDER BY id LIMIT 1000',
      )
      .all(status.titles.next, manifest.maximum);
    if (!records.length) throw new Error('The local snapshot is incomplete.');
    status = await request({
      operation: 'titles',
      next: status.titles.next,
      records,
    });
    console.log(
      JSON.stringify({
        titles: status.titles.scanned,
        total: status.titles.total,
      }),
    );
  }
  const keys = db.prepare(
    'SELECT k.key,k.term FROM search_title_keys k JOIN search_title_terms t ON t.term=k.term WHERE t.documents>0 ORDER BY k.key,k.term LIMIT 5000 OFFSET ?',
  );
  const followingKeys = db.prepare(
    'SELECT k.key,k.term FROM search_title_keys k JOIN search_title_terms t ON t.term=k.term WHERE t.documents>0 AND (k.key,k.term)>(?,?) ORDER BY k.key,k.term LIMIT 5000',
  );
  let previous: [string, string] | undefined;
  while (status.keys.next < status.keys.total) {
    const rows = previous
      ? followingKeys.all(...previous)
      : keys.all(status.keys.next);
    const entries = rows.map(
      (row) => [String(row.key), String(row.term)] as [string, string],
    );
    if (!entries.length)
      throw new Error('The local spelling index is incomplete.');
    status = await request({
      operation: 'keys',
      next: status.keys.next,
      entries,
    });
    previous = entries.at(-1);
    console.log(
      JSON.stringify({ keys: status.keys.next, total: status.keys.total }),
    );
  }
  status = await request({ operation: 'finish' });
  console.log(JSON.stringify(status));
} finally {
  db.close();
}
