import { redirect } from 'next/navigation';
import { legacySearchLink } from '@/lib/legacy-links';

export default async function LegacySearch({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  redirect(legacySearchLink(query));
}
