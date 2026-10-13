import { dafTractates } from '@/lib/daf';
import { redirect } from 'next/navigation';
import type { LegacyParams } from '@/lib/legacy-links';
export default async function Page({
  searchParams,
  params,
}: {
  searchParams: Promise<LegacyParams>;
  params: Promise<{ slug?: string[] }>;
}) {
  const p = await searchParams;
  const { slug } = await params;
  const next = new URLSearchParams({ view: 'daf' });
  for (const [key, value] of [
    [
      'tractate',
      p.masechta ||
        p.tractate ||
        dafTractates.find((t) => t.id === Number(slug?.[0]))?.name ||
        slug?.[1],
    ],
    ['page', p.daf || p.page || slug?.[2]],
    ['side', p.amud || p.side || slug?.[3]],
  ] as const)
    if (typeof value === 'string') next.set(key, value);
  redirect('/?' + next);
}
