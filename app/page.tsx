import TorahApp from './torah-app';
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const wantsHome =
    !params.view ||
    ['discover', 'following', 'trending', 'daf'].includes(String(params.view));
  return (
    <>
      {wantsHome && (
        <link
          rel="preload"
          href="/api/home"
          as="fetch"
          crossOrigin="anonymous"
        />
      )}
      <TorahApp initialHome={null} />
    </>
  );
}
