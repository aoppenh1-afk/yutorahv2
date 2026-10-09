import { redirect } from 'next/navigation';

export default async function LegacyTeacher({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  const name = decodeURIComponent(slug[0] || '')
    .replace(/[-_]+/g, ' ')
    .replace(/^(rabbi|rav|dr|mrs|rebbetzin)\.?\s+/i, '')
    .trim();
  redirect(
    name
      ? `/?view=search&q=${encodeURIComponent(name)}`
      : '/?view=teachers',
  );
}
