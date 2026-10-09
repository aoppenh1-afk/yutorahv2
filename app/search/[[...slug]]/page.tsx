import { redirect } from 'next/navigation';

export default async function LegacySearch({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const q = [query.q, query.search, query.query, query.term]
    .flat()
    .find((value) => value?.trim());
  redirect(q ? `/?view=search&q=${encodeURIComponent(q)}` : '/?view=search');
}
