import { redirect } from 'next/navigation';
import { getDirectory } from '@/lib/yutorah';
import { entityLink, resolveEntitySlug } from '@/lib/legacy-links';

export default async function LegacyTeacher({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  const directory = await getDirectory();
  const id = resolveEntitySlug('teacher', slug, directory);
  if (id) redirect(entityLink('teacher', id));
  const name = decodeURIComponent(slug[0] || '')
    .replace(/[-_]+/g, ' ')
    .replace(/^(rabbi|rav|dr|mrs|rebbetzin)\.?\s+/i, '')
    .trim();
  redirect(
    name ? `/?view=search&q=${encodeURIComponent(name)}` : '/?view=teachers',
  );
}
