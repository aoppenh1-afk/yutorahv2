import { vmCatalogText } from '../../../deploy/notes-only/catalog-fetch.mjs';
import type { NotesQueue } from './queue.js';
export type PriorityTeacher = { id: number; name: string; count?: number };
export async function inventoryPage(
  queue: NotesQueue,
  signal: AbortSignal,
  page = queue.cursor('catalog'),
  advanceCursor = true,
  teacher?: PriorityTeacher,
) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 100_000)
    throw new Error('Invalid catalog page.');
  const params = new URLSearchParams({
    searchTerm: '',
    getFacets: 'false',
    start: String(page),
  });
  if (teacher) params.set('teacherID', String(teacher.id));
  const data = JSON.parse(
    await vmCatalogText(
      `https://yutorah.org/api/search/get?${params}`,
      signal,
      8 * 1024 * 1024,
    ),
  );
  const result = data.response ?? data;
  const total = Number(result.numFound ?? result.total ?? result.totalRecords);
  const docs = result.docs;
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Array.isArray(docs) ||
    docs.length !== Math.max(0, Math.min(30, total - (page - 1) * 30))
  )
    throw new Error('Incomplete catalog page; cursor was not advanced.');
  const scalar = (v: unknown): string =>
    Array.isArray(v)
      ? scalar(v[0])
      : typeof v === 'string' || typeof v === 'number'
        ? String(v)
        : '';
  const items = docs
    .map((raw: Record<string, unknown>) => ({
      id: scalar(raw.shiurID ?? raw.shiurid),
      title: scalar(raw.shiurTitle ?? raw.shiurtitle).replace(/<[^>]*>/g, ''),
      teacher: scalar(raw.teacherfullname),
      teacherId: Number(scalar(raw.teacherid ?? raw.teacherID)) || 0,
    }))
    .filter(
      (item: { teacherId: number }) =>
        !teacher || item.teacherId === teacher.id,
    );
  queue.transaction(() => {
    const insert = queue.db.prepare(
      "INSERT INTO jobs(id,title,teacher,status,teacher_id,priority) VALUES(?,?,?,'discovered',?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,teacher=excluded.teacher,teacher_id=excluded.teacher_id,priority=MAX(jobs.priority,excluded.priority)",
    );
    for (const item of items) {
      if (!/^[1-9]\d{0,11}$/.test(item.id))
        throw new Error('Invalid catalog ID.');
      insert.run(
        item.id,
        item.title.slice(0, 1000),
        item.teacher.slice(0, 300),
        item.teacherId,
        teacher ? 2 : 0,
      );
    }
    if (teacher && advanceCursor) {
      queue.setCursor('teacher:' + teacher.id, page + 1);
      queue.setCursor('teacherDone:' + teacher.id, page * 30 >= total ? 1 : 0);
    } else if (advanceCursor)
      queue.setCursor('catalog', page * 30 >= total ? 1 : page + 1);
  });
  return {
    page,
    total,
    discovered: items.length,
    skipped: docs.length - items.length,
    ...(teacher ? { teacherId: teacher.id } : {}),
  };
}

/** Round-robin crawl gives all requested teachers early coverage before the general catalog. */
export async function priorityInventoryPage(
  queue: NotesQueue,
  signal: AbortSignal,
  teachers: PriorityTeacher[],
) {
  const offset = queue.cursor('teacherTurn') - 1;
  for (let n = 0; n < teachers.length; n++) {
    const i = (offset + n) % teachers.length;
    const teacher = teachers[i];
    const done = queue.db
      .prepare('SELECT value FROM cursors WHERE name=?')
      .get('teacherDone:' + teacher.id);
    if (done?.value === 1) continue;
    const result = await inventoryPage(
      queue,
      signal,
      queue.cursor('teacher:' + teacher.id),
      true,
      teacher,
    );
    queue.setCursor('teacherTurn', i + 2);
    return result;
  }
  for (const teacher of teachers)
    if (Date.now() - queue.cursor('teacherRecent:' + teacher.id) >= 1800_000) {
      const result = await inventoryPage(queue, signal, 1, false, teacher);
      queue.setCursor('teacherRecent:' + teacher.id, Date.now());
      return result;
    }
  if (Date.now() - queue.cursor('recentCheckedAt') >= 1800_000) {
    const result = await inventoryPage(queue, signal, 1, false);
    queue.setCursor('recentCheckedAt', Date.now());
    return result;
  }
  return inventoryPage(queue, signal);
}
