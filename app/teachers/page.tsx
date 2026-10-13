import { redirect } from 'next/navigation';
import {
  entityLink,
  legacySearchLink,
  type LegacyParams,
} from '@/lib/legacy-links';
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<LegacyParams>;
}) {
  const p = await searchParams;
  const id = p.teacherID;
  redirect(
    typeof id === 'string' &&
      /^[1-9]\d{0,5}$/.test(id) &&
      Object.keys(p).length === 1
      ? entityLink('teacher', Number(id))
      : Object.keys(p).length
        ? legacySearchLink(p)
        : '/?view=browse&kind=teacher',
  );
}
