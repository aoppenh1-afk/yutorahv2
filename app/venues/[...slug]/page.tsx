import { redirect } from 'next/navigation';
import { catalogDictionary } from '@/lib/catalog';
export default async function Page({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  const name = (slug.at(-1) || '').replace(/[-_]/g, ' ').toLowerCase();
  const entry = (await catalogDictionary()).venues.find(
    (x) => String(x.id) === name || x.name.toLowerCase() === name,
  );
  redirect(
    entry
      ? '/?view=entity&kind=venue&id=' + entry.id
      : '/?view=browse&kind=venue&q=' + encodeURIComponent(name),
  );
}
