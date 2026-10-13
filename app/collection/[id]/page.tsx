import { redirect, notFound } from 'next/navigation';
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^[1-9]\d{0,8}$/.test(id)) notFound();
  redirect('/?view=collection&kind=collection&id=' + id);
}
