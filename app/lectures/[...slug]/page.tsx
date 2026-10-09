import { redirect } from 'next/navigation';

export default async function LegacyLecture({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const fromQuery = Object.entries(query).find(
    ([key]) => key.toLowerCase() === 'shiurid',
  )?.[1];
  const id = [fromQuery, ...slug]
    .flat()
    .find((part) => part && /^\d+$/.test(part));
  redirect(id ? `/?shiur=${id}` : '/?view=search');
}
