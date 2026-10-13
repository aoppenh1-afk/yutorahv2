import { redirect } from 'next/navigation';
import { getDirectory } from '@/lib/yutorah';
import { resolveEntitySlug, entityLink } from '@/lib/legacy-links';
export default async function Page({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  const id = resolveEntitySlug('topic', slug, await getDirectory());
  redirect(
    id
      ? entityLink('topic', id)
      : '/?view=browse&kind=topic&q=' +
          encodeURIComponent(slug.at(-1)?.replace(/[-_]/g, ' ') || ''),
  );
}
